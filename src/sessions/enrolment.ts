import { randomBytes } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { Cipher } from '../crypto.js';
import type { Logger } from '../logger.js';
import type { IcaEndpoints } from '../ica/endpoints.js';
import { BankidRelay, RELAY_TIMEOUT_MS, type RelayFlow, type RelayPoll } from '../ica/bankid-relay.js';
import { IcaLoginRejected } from '../ica/web-session.js';
import type { AppClient } from '../ica/app-session.js';
import { linkedIcaAccount, storeWebSession } from './web-store.js';
import { loadAppSession, storeAppSession } from './app-store.js';
import { DifferentIcaPerson } from './identity.js';

export const ENROLMENT_TTL_MS = 5 * 60_000;
/** A relay status; a failure refused as another ICA person carries its kind (for the audit, never shown or sent). */
export type EnrolmentStatus = RelayPoll | { state: 'failed'; reason: string; identityRefused: 'web' | 'app' };

/** A BankID login for this user is already being started. */
export class EnrolmentBusy extends Error { constructor() { super('a BankID login is already starting'); this.name = 'EnrolmentBusy'; } }

export type Enrolment = { readonly id: string; readonly userId: string; readonly flow: RelayFlow; readonly createdAt: number; poll: () => Promise<EnrolmentStatus> };

/**
 * In-memory registry of BankID enrolments (connecting a hub user's ICA account). Each is owned by the hub user who
 * started it, expires after 5 minutes, and a user has at most one: starting again drops the previous one. Nothing
 * here survives a restart, which is fine: a BankID QR is only valid for a few minutes anyway. The `web` flow stores
 * the ICA web session (and links the account); the experimental `app` flow adds an app session to a linked account.
 * Only one start per user runs at a time (a second one throws EnrolmentBusy). An app reconnect reuses the DCR client
 * of the stored app session, so ICA does not get a new client registered on every reconnect; the stored session
 * itself is only replaced once the new login has stored its tokens. Any failed app login that reused the client
 * (except a BankID timeout) marks it refused for the ICA account, and the next start registers a new one: how ICA
 * refuses a dead client is unknown, and one extra registration is cheap. A login refused as another ICA person
 * (DifferentIcaPerson) does not: ICA accepted the client, only the person was wrong.
 */
export function createEnrolments(deps: { db: Db; cipher: Cipher; endpoints: IcaEndpoints; appDcrSecret?: string; log?: Logger; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const byId = new Map<string, Enrolment>();

  /** Users whose start is running right now. */
  const starting = new Set<string>();
  /** Per ICA account, a stored client_id whose app login failed: not reused again (until another client is stored). */
  const refusedClients = new Map<string, string>();

  /** The DCR client of the user's stored app session, reused on reconnect so ICA does not get a new client each time. */
  function storedAppClient(userId: string): { icaAccountId: string; client: AppClient } | undefined {
    const linked = linkedIcaAccount(deps.db, userId);
    if (!linked?.app) return undefined;
    const icaAccountId = linked.account.id;
    let client: AppClient | undefined;
    try { client = loadAppSession({ db: deps.db, cipher: deps.cipher, icaAccountId })?.state.client; } catch { return undefined; }
    if (!client?.client_id || !client.client_secret || !client.scope) return undefined;
    return refusedClients.get(icaAccountId) === client.client_id ? undefined : { icaAccountId, client };
  }
  /** Stop reusing this stored client for the account. */
  const refuse = (reused: { icaAccountId: string; client: AppClient }, flow: RelayFlow) => {
    refusedClients.set(reused.icaAccountId, reused.client.client_id);
    deps.log?.info({ flow }, 'app login with the stored ICA app client failed; the next reconnect registers a new one');
  };
  const newRelay = (appClient?: AppClient) => new BankidRelay({ endpoints: deps.endpoints, now, timeoutMs: RELAY_TIMEOUT_MS, ...(deps.appDcrSecret ? { appDcrSecret: deps.appDcrSecret } : {}), ...(appClient ? { appClient } : {}) });

  const sweep = () => { for (const [id, e] of byId) if (now() - e.createdAt >= ENROLMENT_TTL_MS) byId.delete(id); };

  async function save(flow: RelayFlow, user: { id: string; name: string }, relay: BankidRelay): Promise<void> {
    if (flow === 'web') { await storeWebSession({ session: relay.session, endpoints: deps.endpoints, db: deps.db, cipher: deps.cipher, user }); return; }
    const state = relay.takeAppState();
    if (!state) throw new Error('app login completed without tokens');
    storeAppSession({ db: deps.db, cipher: deps.cipher, userId: user.id, state });
  }

  function create(user: { id: string; name: string }, flow: RelayFlow, relay: BankidRelay, reused: { icaAccountId: string; client: AppClient } | undefined): Enrolment {
    let terminal: EnrolmentStatus | undefined;
    let inflight: Promise<EnrolmentStatus> | undefined;
    const step = async (): Promise<EnrolmentStatus> => {
      const r = await relay.poll();
      if (r.state === 'pending') return r;
      if (r.state === 'failed') {
        if (reused && !relay.timedOut) refuse(reused, flow);
        deps.log?.warn({ flow, reason: r.reason }, 'ica enrolment failed');
        return (terminal = r);
      }
      try {
        await save(flow, user, relay);
        deps.log?.info({ userId: user.id, flow }, flow === 'web' ? 'ica account connected' : 'ica app access connected');
        return (terminal = { state: 'complete' });
      } catch (e) {
        if (reused && !(e instanceof DifferentIcaPerson)) refuse(reused, flow);
        const reason = e instanceof IcaLoginRejected ? e.message : 'Could not save the ICA session';
        deps.log?.warn({ flow, reason, err: e instanceof IcaLoginRejected ? undefined : { name: (e as Error).name } }, 'ica enrolment failed');
        return (terminal = e instanceof DifferentIcaPerson ? { state: 'failed', reason, identityRefused: e.kind } : { state: 'failed', reason });
      }
    };
    return {
      id: randomBytes(18).toString('base64url'), userId: user.id, flow, createdAt: now(),
      poll: () => {
        if (terminal) return Promise.resolve(terminal);
        inflight ??= step().finally(() => { inflight = undefined; });
        return inflight;
      },
    };
  }

  return {
    /** Start a BankID login for `user`, replacing any enrolment they already have. Throws if ICA refuses to start. */
    async start(user: { id: string; name: string }, flow: RelayFlow = 'web'): Promise<Enrolment> {
      // Checked and set before the first await, so two concurrent starts cannot both get past it.
      if (starting.has(user.id)) throw new EnrolmentBusy();
      starting.add(user.id);
      try {
        sweep();
        for (const [id, e] of byId) if (e.userId === user.id) byId.delete(id);
        const stored = flow === 'app' ? storedAppClient(user.id) : undefined;
        let relay = newRelay(stored?.client);
        try { await relay.start(flow); } catch (e) {
          if (!relay.reusesClient) throw e;
          // ICA may no longer know the stored client: register a new one, once.
          if (stored) refusedClients.set(stored.icaAccountId, stored.client.client_id);
          deps.log?.info({ flow }, 'stored ICA app client refused; registering a new one');
          relay = newRelay();
          await relay.start(flow);
        }
        const enrolment = create(user, flow, relay, relay.reusesClient ? stored : undefined);
        byId.set(enrolment.id, enrolment);
        return enrolment;
      } finally { starting.delete(user.id); }
    },
    /** Whether a start for this user is running right now (a new one would throw EnrolmentBusy). */
    isStarting: (userId: string): boolean => starting.has(userId),
    /** The enrolment, only if it exists, has not expired and belongs to `userId`. */
    get(id: string, userId: string): Enrolment | undefined {
      sweep();
      const e = byId.get(id);
      return e && e.userId === userId ? e : undefined;
    },
    size: (): number => { sweep(); return byId.size; },
  };
}
export type Enrolments = ReturnType<typeof createEnrolments>;
