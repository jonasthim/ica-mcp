import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, openDb, schema, type Db } from '../db/index.js';
import { createCipher } from '../crypto.js';
import { BankidRelay } from '../ica/bankid-relay.js';
import { AppSessionExpired, type AppState } from '../ica/app-session.js';
import { loadAppSession, refreshAppSession, storeAppSession } from './app-store.js';
import { IcaLoginRejected } from '../ica/web-session.js';
import { linkedIcaAccount, storeWebSession } from './web-store.js';
import { FAKE_APP_CLIENT, FAKE_SECRETS, fakeAppState, fakeLoggedInSession, startFakeIca, type FakeIca } from '../ica/test-fakes.js';
import { newSession, type IcaSession } from '../ica/http.js';
import { seedUser } from '../test-helpers.js';

const cipher = createCipher(Buffer.alloc(32, 7));
let db: Db; let fake: FakeIca;
const user = { id: 'user-1', name: 'Hub User' };
const NOW = new Date('2026-09-29T12:00:00.000Z');
const APP_SECRETS = [FAKE_SECRETS.appAccessToken, FAKE_SECRETS.appRefreshToken, FAKE_SECRETS.appClientSecret, FAKE_SECRETS.appCode, FAKE_SECRETS.dcrToken];

/** Run the fake app login to the point where the relay holds the app tokens. */
async function appLogin(): Promise<AppState> {
  let t = 1_000_000;
  const relay = new BankidRelay({ endpoints: fake.endpoints, now: () => (t += 1000) });
  await relay.start('app');
  while ((await relay.poll()).state === 'pending') { /* scan */ }
  return relay.takeAppState()!;
}
const rowOf = (accountId: string) => db.select().from(schema.icaSession).all().find((r) => r.icaAccountId === accountId && r.kind === 'app')!;

beforeEach(async () => {
  db = openDb(':memory:'); fake = await startFakeIca({ pendingPolls: 0 });
  seedUser(db, user.id, { name: user.name });
  await storeWebSession({ session: await fakeLoggedInSession(fake), endpoints: fake.endpoints, db, cipher, user, now: () => NOW });
});
afterEach(async () => { closeDb(db); await fake.close(); });

describe('storeAppSession', () => {
  it('stores the app client and tokens encrypted on the linked account, with expiry from expires_in', async () => {
    const { icaAccountId } = storeAppSession({ db, cipher, userId: user.id, state: await appLogin(), now: () => NOW });
    const row = rowOf(icaAccountId);
    expect(row).toMatchObject({ kind: 'app', expiresAt: '2026-09-29T12:30:00.000Z', lastOkAt: NOW.toISOString(), lastError: null });
    const raw = JSON.stringify(db.$client.prepare('select * from ica_session').all());
    for (const s of APP_SECRETS) expect(raw).not.toContain(s);
    expect(loadAppSession({ db, cipher, icaAccountId })!.state).toMatchObject({ client: FAKE_APP_CLIENT, token: { access_token: FAKE_SECRETS.appAccessToken, refresh_token: FAKE_SECRETS.appRefreshToken } });
    expect(linkedIcaAccount(db, user.id)?.app?.id).toBe(row.id);
    // reconnecting replaces the row
    storeAppSession({ db, cipher, userId: user.id, state: await appLogin(), now: () => NOW });
    expect(db.select().from(schema.icaSession).all().filter((r) => r.kind === 'app')).toHaveLength(1);
  });

  it('needs an ICA account linked first', async () => {
    expect(() => storeAppSession({ db, cipher, userId: 'someone-else', state: {} as AppState })).toThrow(IcaLoginRejected);
  });
});

describe('refreshAppSession', () => {
  it('refreshes with Basic client auth and stores the rotated tokens', async () => {
    const { icaAccountId } = storeAppSession({ db, cipher, userId: user.id, state: await appLogin(), now: () => NOW });
    const later = new Date(NOW.getTime() + 60_000);
    const st = await refreshAppSession({ db, cipher, endpoints: fake.endpoints, icaAccountId, now: () => later });
    expect(st.token).toMatchObject({ access_token: `${FAKE_SECRETS.appAccessToken}-r1`, refresh_token: `${FAKE_SECRETS.appRefreshToken}-r1` });
    expect(loadAppSession({ db, cipher, icaAccountId })!.state.token.refresh_token).toBe(`${FAKE_SECRETS.appRefreshToken}-r1`);
    expect(rowOf(icaAccountId)).toMatchObject({ expiresAt: '2026-09-29T12:31:00.000Z', lastOkAt: later.toISOString(), lastError: null });
    // the rotated refresh token is the one used next time
    await refreshAppSession({ db, cipher, endpoints: fake.endpoints, icaAccountId });
    expect(fake.app.rotations).toBe(2);
    expect(JSON.stringify(db.$client.prepare('select * from ica_session').all())).not.toContain(FAKE_SECRETS.appRefreshToken);
  });

  it('marks the session expired on invalid_grant', async () => {
    const { icaAccountId } = storeAppSession({ db, cipher, userId: user.id, state: await appLogin(), now: () => NOW });
    fake.opts.refreshInvalid = true;
    await expect(refreshAppSession({ db, cipher, endpoints: fake.endpoints, icaAccountId })).rejects.toThrow(AppSessionExpired);
    expect(rowOf(icaAccountId).lastError).toBe('app session expired — reconnect');
  });
});

describe('refreshAppSession: concurrency safety and session times', () => {
  /** A session whose requests wait for `gate`: lets a test order two refreshes deterministically. */
  const held = (gate: Promise<void>): IcaSession => { const s = newSession(); return { jar: s.jar, fetch: async (url, init) => { await gate; return s.fetch(url, init); } }; };

  it('a stale invalid_grant does not expire a session another refresh already rotated', async () => {
    const { icaAccountId } = storeAppSession({ db, cipher, userId: user.id, state: fakeAppState(), now: () => NOW });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const second = refreshAppSession({ db, cipher, endpoints: fake.endpoints, icaAccountId, session: held(gate) });
    const first = await refreshAppSession({ db, cipher, endpoints: fake.endpoints, icaAccountId });
    release();
    expect((await second).token.access_token).toBe(first.token.access_token);
    expect(rowOf(icaAccountId).lastError).toBeNull();
    expect(fake.seen.tokenGrants.filter((g) => g === 'refresh_token')).toHaveLength(2);
    expect(fake.app.rotations).toBe(1);
  });

  it('never writes over tokens stored meanwhile (compare-and-swap)', async () => {
    const { icaAccountId } = storeAppSession({ db, cipher, userId: user.id, state: fakeAppState(), now: () => NOW });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const refresh = refreshAppSession({ db, cipher, endpoints: fake.endpoints, icaAccountId, session: held(gate) });
    storeAppSession({ db, cipher, userId: user.id, state: fakeAppState({ accessToken: 'RECONNECTED-ACCESS' }), now: () => NOW });
    release();
    expect((await refresh).token.access_token).toBe('RECONNECTED-ACCESS');
    expect(loadAppSession({ db, cipher, icaAccountId })!.state.token.access_token).toBe('RECONNECTED-ACCESS');
    expect(fake.app.rotations).toBe(1);
  });

  it('never writes over tokens stored meanwhile on the same row (compare-and-swap on stateEnc, not only the row id)', async () => {
    const { icaAccountId } = storeAppSession({ db, cipher, userId: user.id, state: fakeAppState(), now: () => NOW });
    const rowId = rowOf(icaAccountId).id;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const refresh = refreshAppSession({ db, cipher, endpoints: fake.endpoints, icaAccountId, session: held(gate) });
    // Another writer updates the tokens of the very same row (same id) while the refresh waits on ICA.
    const newer: AppState = { ...fakeAppState({ accessToken: 'SAME-ROW-NEWER' }), issuedAt: NOW.toISOString() };
    db.update(schema.icaSession).set({ stateEnc: cipher.encrypt(JSON.stringify(newer)) }).where(eq(schema.icaSession.id, rowId)).run();
    release();
    expect((await refresh).token.access_token).toBe('SAME-ROW-NEWER');
    expect(rowOf(icaAccountId).id).toBe(rowId);
    expect(loadAppSession({ db, cipher, icaAccountId })!.state.token.access_token).toBe('SAME-ROW-NEWER');
    expect(fake.app.rotations).toBe(1);
  });

  it('records when app access was connected and last refreshed', async () => {
    const { icaAccountId } = storeAppSession({ db, cipher, userId: user.id, state: fakeAppState(), now: () => NOW });
    expect(rowOf(icaAccountId)).toMatchObject({ connectedAt: NOW.toISOString(), refreshedAt: NOW.toISOString() });
    const later = new Date(NOW.getTime() + 60_000);
    await refreshAppSession({ db, cipher, endpoints: fake.endpoints, icaAccountId, now: () => later });
    expect(rowOf(icaAccountId)).toMatchObject({ connectedAt: NOW.toISOString(), refreshedAt: later.toISOString() });
  });

  it('a network failure is transient: IcaUnavailable, recorded, no reconnect', async () => {
    const { icaAccountId } = storeAppSession({ db, cipher, userId: user.id, state: fakeAppState(), now: () => NOW });
    await expect(refreshAppSession({ db, cipher, endpoints: { ...fake.endpoints, ims: 'http://127.0.0.1:9' }, icaAccountId })).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'network' });
    expect(rowOf(icaAccountId).lastError).toBe('app token refresh failed (network)');
  });

  it('a 5xx or 429 from the token endpoint is transient too: IcaUnavailable, recorded', async () => {
    const { icaAccountId } = storeAppSession({ db, cipher, userId: user.id, state: fakeAppState(), now: () => NOW });
    for (const [status, reason] of [[503, 'server-error'], [429, 'rate-limited']] as const) {
      const ims = createServer((_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }).end('{}'); });
      await new Promise<void>((r) => ims.listen(0, '127.0.0.1', r));
      const endpoints = { ...fake.endpoints, ims: `http://127.0.0.1:${(ims.address() as AddressInfo).port}` };
      await expect(refreshAppSession({ db, cipher, endpoints, icaAccountId })).rejects.toMatchObject({ name: 'IcaUnavailable', reason, status });
      expect(rowOf(icaAccountId).lastError).toBe(`app token refresh failed (HTTP ${status})`);
      await new Promise<void>((r) => { ims.closeAllConnections(); ims.close(() => r()); });
    }
  });
});

describe('storeAppSession and purchase history', () => {
  const web = () => db.select().from(schema.icaSession).all().find((r) => r.kind === 'web')!;

  it('an app BankID connect marks purchase history unavailable at once (loginState 1 on the web row), jar untouched', async () => {
    expect(web().loginState).toBe(2);
    const jar = web().stateEnc;
    const later = new Date(NOW.getTime() + 60_000);
    storeAppSession({ db, cipher, userId: user.id, state: fakeAppState(), now: () => later });
    expect(web()).toMatchObject({ loginState: 1, loginStateAt: later.toISOString(), stateEnc: jar, lastError: null });
  });

  it('a web row recorded logged out (0) stays 0', async () => {
    db.update(schema.icaSession).set({ loginState: 0 }).where(eq(schema.icaSession.id, web().id)).run();
    storeAppSession({ db, cipher, userId: user.id, state: fakeAppState(), now: () => NOW });
    expect(web().loginState).toBe(0);
  });

  it('a web row never checked (null) is recorded as 1: ICA has just dropped it', async () => {
    db.update(schema.icaSession).set({ loginState: null, loginStateAt: null }).where(eq(schema.icaSession.id, web().id)).run();
    storeAppSession({ db, cipher, userId: user.id, state: fakeAppState(), now: () => NOW });
    expect(web()).toMatchObject({ loginState: 1, loginStateAt: NOW.toISOString() });
  });
});
