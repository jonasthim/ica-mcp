import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, openDb, schema, type Db } from '../db/index.js';
import { createCipher } from '../crypto.js';
import { APP_SESSION_UNREADABLE, type AppState } from '../ica/app-session.js';
import type { IcaEndpoints } from '../ica/endpoints.js';
import { bearerFetcher, icaRequest } from '../ica/gateway.js';
import { FAKE_PROBE_ROUTES, FAKE_SECRETS, FAKE_WEB_ROUTES, fakeAppState, fakeHouseholdLists, fakeLoggedInSession, startFakeIca, type FakeIca } from '../ica/test-fakes.js';
import { seedUser } from '../test-helpers.js';
import { storeWebSession } from './web-store.js';
import { loadAppSession, storeAppSession } from './app-store.js';
import { createSessionKeeper } from './keeper.js';
import { NotLinked, RateLimited } from './errors.js';
import { createTokenBucket, type TokenBucket } from './rate-limit.js';
import { WEB_SESSION_LOGGED_OUT } from '../ica/web-session.js';
import { createPurchaseApi } from '../ica/web-api.js';
import { IcaUnauthorized } from '../ica/errors.js';

const cipher = createCipher(Buffer.alloc(32, 7));
const NOW = new Date('2026-09-29T12:00:00.000Z');
const BONUS = '/sverige/digx/mobile/bonusservice/v1/bonus/current';
let db: Db; let fake: FakeIca; let clock: Date; let logs: object[];

async function link(userId: string, app: AppState | null): Promise<string> {
  seedUser(db, userId);
  const { icaAccountId } = await storeWebSession({ session: await fakeLoggedInSession(fake), endpoints: fake.endpoints, db, cipher, user: { id: userId, name: userId }, now: () => NOW });
  if (app) storeAppSession({ db, cipher, userId, state: app, now: () => NOW });
  fake.seen.userInfoCalls = 0;
  return icaAccountId;
}
const keeper = (endpoints: IcaEndpoints = fake.endpoints) =>
  createSessionKeeper({ db, cipher, endpoints, now: () => clock, log: { info: (o) => { logs.push(o); }, warn: (o) => { logs.push(o); } } });
const appRow = (accountId: string) => db.select().from(schema.icaSession).all().find((r) => r.icaAccountId === accountId && r.kind === 'app')!;
/** One mobile call with the bearer the keeper hands out; resolves to that bearer. */
const bonus = (bearer: string) => icaRequest(bearerFetcher(bearer), `${fake.endpoints.gateway}${BONUS}`).then(() => bearer);
const refreshes = () => fake.seen.tokenGrants.filter((g) => g === 'refresh_token').length;
const at = (ms: number) => { clock = new Date(NOW.getTime() + ms); };

beforeEach(async () => { db = openDb(':memory:'); fake = await startFakeIca({ pendingPolls: 0, routes: FAKE_PROBE_ROUTES, mobileAcceptsWebBearer: false }); clock = NOW; logs = []; });
afterEach(async () => { closeDb(db); await fake.close(); });

describe('SessionKeeper: app bearer', () => {
  it('uses the stored token while it has more than 60 s left, and marks the session OK', async () => {
    const acc = await link('u1', fakeAppState());
    at(839_000);
    expect(await keeper().withAppBearer(acc, bonus)).toBe(FAKE_SECRETS.appAccessToken);
    expect(refreshes()).toBe(0);
    expect(appRow(acc).lastOkAt).toBe(clock.toISOString());
  });

  it('a late outcome of a call on a replaced app row never marks the freshly reconnected row', async () => {
    const acc = await link('u1', fakeAppState());
    const k = keeper();
    for (const outcome of ['refused', 'ok'] as const) {
      const oldRow = appRow(acc).id;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let calls = 0;
      const use = k.withAppBearer(acc, async () => {
        calls += 1;
        if (outcome === 'refused' && calls === 1) throw new IcaUnauthorized(401);
        await gate; // ICA is slow; meanwhile the user reconnects app access
        if (outcome === 'refused') throw new IcaUnauthorized(401);
        return 'late';
      });
      await vi.waitFor(() => expect(calls).toBe(outcome === 'refused' ? 2 : 1));
      storeAppSession({ db, cipher, userId: 'u1', state: fakeAppState(), now: () => NOW });
      const fresh = appRow(acc);
      expect(fresh.id).not.toBe(oldRow);
      db.update(schema.icaSession).set({ lastOkAt: null, lastError: 'MARKER' }).where(eq(schema.icaSession.id, fresh.id)).run();
      release();
      await (outcome === 'refused' ? expect(use).rejects.toMatchObject({ name: 'NeedsAppReconnect' }) : expect(use).resolves.toBe('late'));
      expect(appRow(acc), outcome).toMatchObject({ id: fresh.id, lastOkAt: null, lastError: 'MARKER' });
    }
  });

  it('two concurrent calls near expiry share one refresh', async () => {
    const acc = await link('u1', fakeAppState());
    at(850_000);
    const k = keeper();
    expect(await Promise.all([k.withAppBearer(acc, bonus), k.withAppBearer(acc, bonus)])).toEqual([`${FAKE_SECRETS.appAccessToken}-r1`, `${FAKE_SECRETS.appAccessToken}-r1`]);
    expect(refreshes()).toBe(1);
  });

  it('two accounts in parallel: one refresh for A, none for B, bearers never cross', async () => {
    fake.opts.extraAppBearers = [FAKE_SECRETS.appAccessTokenB];
    const a = await link('alice', fakeAppState());
    const b = await link('bob', fakeAppState({ accessToken: FAKE_SECRETS.appAccessTokenB, refreshToken: FAKE_SECRETS.appRefreshTokenB, expiresIn: 3600 }));
    at(850_000);
    const k = keeper();
    const got = await Promise.all([k.withAppBearer(a, bonus), k.withAppBearer(b, bonus), k.withAppBearer(a, bonus), k.withAppBearer(b, bonus)]);
    expect(got).toEqual([`${FAKE_SECRETS.appAccessToken}-r1`, FAKE_SECRETS.appAccessTokenB, `${FAKE_SECRETS.appAccessToken}-r1`, FAKE_SECRETS.appAccessTokenB]);
    expect(refreshes()).toBe(1);
    expect(appRow(b).lastError).toBeNull();
  });

  it('a 401 from ICA → one refresh and one retry', async () => {
    const acc = await link('u1', fakeAppState());
    fake.opts.gatewayFailures = [{ pathPrefix: BONUS, status: 401, times: 1 }];
    expect(await keeper().withAppBearer(acc, bonus)).toBe(`${FAKE_SECRETS.appAccessToken}-r1`);
    expect(refreshes()).toBe(1);
    expect(fake.seen.gatewayCalls.filter((c) => c.startsWith(BONUS))).toHaveLength(2);
  });

  it('two concurrent 401s share one refresh', async () => {
    const acc = await link('u1', fakeAppState());
    fake.opts.gatewayFailures = [{ pathPrefix: BONUS, status: 401, times: 2 }];
    const k = keeper();
    await Promise.all([k.withAppBearer(acc, bonus), k.withAppBearer(acc, bonus)]);
    expect(refreshes()).toBe(1);
  });

  it('a second 401 after the refresh → NeedsAppReconnect(rejected), recorded on the row', async () => {
    const acc = await link('u1', fakeAppState());
    fake.opts.gatewayFailures = [{ pathPrefix: BONUS, status: 401, times: 2 }];
    await expect(keeper().withAppBearer(acc, bonus)).rejects.toMatchObject({ name: 'NeedsAppReconnect', why: 'rejected' });
    expect(appRow(acc).lastError).toBe('ICA refused the app token (HTTP 401)');
  });

  it('invalid_grant on refresh → NeedsAppReconnect(expired); the call is never made', async () => {
    const acc = await link('u1', fakeAppState());
    fake.opts.refreshInvalid = true;
    at(900_000);
    let called = false;
    await expect(keeper().withAppBearer(acc, async (b) => { called = true; return b; })).rejects.toMatchObject({ name: 'NeedsAppReconnect', why: 'expired' });
    expect(called).toBe(false);
    expect(appRow(acc).lastError).toBe('app session expired — reconnect');
  });

  it("past the 4-hour window a refresh stores ICA's 30-day token", async () => {
    const acc = await link('u1', fakeAppState());
    at(900_000);
    fake.opts.appExpiresIn = 120; // inside the window ICA caps the new token at connect + 4 h
    expect(await keeper().withAppBearer(acc, bonus)).toBe(`${FAKE_SECRETS.appAccessToken}-r1`);
    expect(appRow(acc).expiresAt).toBe(new Date(clock.getTime() + 120_000).toISOString());
    at(4 * 3_600_000 + 60_000);
    fake.opts.appExpiresIn = 30 * 86_400; // the first refresh after the window
    expect(await keeper().withAppBearer(acc, bonus)).toBe(`${FAKE_SECRETS.appAccessToken}-r2`);
    expect(appRow(acc)).toMatchObject({ expiresAt: new Date(clock.getTime() + 30 * 86_400_000).toISOString(), refreshedAt: clock.toISOString(), connectedAt: NOW.toISOString(), lastError: null });
    at(4 * 3_600_000 + 120_000);
    await keeper().withAppBearer(acc, bonus);
    expect(refreshes()).toBe(2); // the 30-day token is used as is
  });

  it('a network failure during refresh is transient: IcaUnavailable, not a reconnect', async () => {
    const acc = await link('u1', fakeAppState());
    at(900_000);
    await expect(keeper({ ...fake.endpoints, ims: 'http://127.0.0.1:9' }).withAppBearer(acc, bonus)).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'network' });
    expect(appRow(acc).lastError).toBe('app token refresh failed (network)');
  });

  it('not linked, not connected, unreadable (recorded, so the admin pages ask for a reconnect)', async () => {
    seedUser(db, 'nobody');
    await expect(keeper().forUser('nobody').app(async () => 'never')).rejects.toBeInstanceOf(NotLinked);
    const acc = await link('u1', null);
    await expect(keeper().withAppBearer(acc, bonus)).rejects.toMatchObject({ name: 'NeedsAppReconnect', why: 'not-connected' });
    storeAppSession({ db, cipher, userId: 'u1', state: fakeAppState(), now: () => NOW });
    db.update(schema.icaSession).set({ stateEnc: 'v1.AAAA.AAAA.AAAA' }).where(eq(schema.icaSession.id, appRow(acc).id)).run();
    await expect(keeper().withAppBearer(acc, bonus)).rejects.toMatchObject({ name: 'NeedsAppReconnect', why: 'unreadable' });
    expect(appRow(acc).lastError).toBe(APP_SESSION_UNREADABLE);
  });

  it('refreshAppNow refreshes even a fresh token; concurrent calls share one refresh', async () => {
    const acc = await link('u1', fakeAppState());
    const k = keeper();
    expect(await Promise.all([k.refreshAppNow(acc), k.refreshAppNow(acc)])).toEqual([`${FAKE_SECRETS.appAccessToken}-r1`, `${FAKE_SECRETS.appAccessToken}-r1`]);
    expect(refreshes()).toBe(1);
    await expect(k.refreshAppNow('no-such-account')).rejects.toMatchObject({ name: 'NeedsAppReconnect', why: 'not-connected' });
  });

  it('logs refresh events at info, without secrets', async () => {
    const acc = await link('u1', fakeAppState());
    at(900_000);
    await keeper().withAppBearer(acc, bonus);
    expect(logs).toContainEqual(expect.objectContaining({ account: acc, kind: 'app', event: 'refresh', ok: true }));
    const all = JSON.stringify(logs);
    for (const s of [FAKE_SECRETS.appAccessToken, FAKE_SECRETS.appRefreshToken, FAKE_SECRETS.appClientSecret]) expect(all).not.toContain(s);
  });

  it('a disconnect while a refresh is in flight → NeedsAppReconnect(not-connected), not rejected', async () => {
    const acc = await link('u1', fakeAppState());
    at(900_000);
    const call = keeper().withAppBearer(acc, bonus); // the refresh has read the row and is waiting on ICA
    db.delete(schema.icaSession).where(eq(schema.icaSession.id, appRow(acc).id)).run();
    await expect(call).rejects.toMatchObject({ name: 'NeedsAppReconnect', why: 'not-connected' });
  });

  it('refreshAppNow, a concurrent appToken near expiry and a 401 retry share one refresh', async () => {
    const acc = await link('u1', fakeAppState());
    fake.opts.gatewayFailures = [{ pathPrefix: BONUS, status: 401, times: 1 }];
    const k = keeper();
    const upkeep = k.refreshAppNow(acc); // in flight from here on
    const tool = k.withAppBearer(acc, bonus); // the stored token is still fresh: used, refused with 401, retried
    at(850_000);
    const other = k.appToken(acc); // < 60 s left: joins the running refresh
    const r1 = `${FAKE_SECRETS.appAccessToken}-r1`;
    expect(await Promise.all([upkeep, tool, other])).toEqual([r1, r1, r1]);
    expect(refreshes()).toBe(1);
    expect(fake.seen.gatewayCalls.filter((c) => c.startsWith(BONUS))).toHaveLength(2);
  });

  it('a 429 from the token endpoint surfaces as IcaUnavailable(rate-limited), not a reconnect', async () => {
    const acc = await link('u1', fakeAppState());
    at(900_000);
    const ims = createServer((_req, res) => { res.writeHead(429, { 'content-type': 'application/json' }).end('{}'); });
    await new Promise<void>((r) => ims.listen(0, '127.0.0.1', r));
    try {
      const k = keeper({ ...fake.endpoints, ims: `http://127.0.0.1:${(ims.address() as AddressInfo).port}` });
      await expect(k.withAppBearer(acc, bonus)).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'rate-limited', status: 429 });
      expect(appRow(acc).lastError).toBe('app token refresh failed (HTTP 429)');
    } finally { await new Promise<void>((r) => { ims.closeAllConnections(); ims.close(() => r()); }); }
  });
});

describe('SessionKeeper: forUser', () => {
  /** The bucket of the last `limited` keeper: `take` spends from it directly, as the keeper does per ICA call. */
  let bucket: TokenBucket;
  const limited = (capacity: number) => {
    bucket = createTokenBucket({ capacity, refillPerSecond: 1, now: () => 0 });
    return createSessionKeeper({ db, cipher, endpoints: fake.endpoints, now: () => clock, limiter: bucket });
  };
  const take = (userId: string): void => { const r = bucket.take(userId); if (!r.ok) throw new RateLimited(r.retryAfterSeconds); };

  it("app() runs the callback with the user's own app bearer and one ICA call from their budget", async () => {
    fake.opts.appLists = fakeHouseholdLists();
    await link('u1', fakeAppState());
    const s = limited(2).forUser('u1');
    expect(s.userId).toBe('u1');
    expect((await s.app((api) => api.shoppingLists())).map((l) => l.title)).toEqual(fakeHouseholdLists().map((l) => l.title));
    await s.app((api) => api.shoppingLists());
    await expect(s.app((api) => api.shoppingLists())).rejects.toBeInstanceOf(RateLimited);
    expect(fake.seen.gatewayCalls.filter((c) => c.endsWith(' app'))).toHaveLength(2);
    expect(fake.seen.gatewayCalls.some((c) => !c.endsWith(' app'))).toBe(false);
  });

  it("web() runs the callback with the user's own web bearer and one ICA call from their budget", async () => {
    await link('u1', null);
    fake.opts.routes = { ...fake.opts.routes, ...FAKE_WEB_ROUTES };
    const s = limited(2).forUser('u1');
    expect((await s.web((api) => api.searchArticles('mjölk'))).documents.map((d) => d.name)).toEqual(['Mellanmjölk 1,5%', 'Standardmjölk 3%', 'Havredryck']);
    await s.web((api) => api.searchArticles('mjölk'));
    await expect(s.web((api) => api.searchArticles('mjölk'))).rejects.toBeInstanceOf(RateLimited);
    expect(fake.seen.gatewayCalls.filter((c) => c.includes('shoppinglistarticlesearch'))).toHaveLength(2);
    expect(fake.seen.gatewayCalls.every((c) => c.endsWith(' web'))).toBe(true);
  });

  it('budgets are per hub user', async () => {
    fake.opts.appLists = fakeHouseholdLists();
    fake.opts.extraAppBearers = [FAKE_SECRETS.appAccessTokenB];
    await link('u1', fakeAppState());
    await link('u2', fakeAppState({ accessToken: FAKE_SECRETS.appAccessTokenB, refreshToken: FAKE_SECRETS.appRefreshTokenB }));
    const k = limited(1);
    await k.forUser('u1').app((api) => api.shoppingLists());
    await expect(k.forUser('u1').app((api) => api.shoppingLists())).rejects.toBeInstanceOf(RateLimited);
    await expect(k.forUser('u2').app((api) => api.shoppingLists())).resolves.toBeDefined();
    expect(() => take('u2')).toThrow(RateLimited);
  });

  it('a member without an ICA account gets NotLinked and spends nothing', async () => {
    seedUser(db, 'u3');
    const k = limited(1);
    await expect(k.forUser('u3').app(async () => 'never')).rejects.toBeInstanceOf(NotLinked);
    expect(() => take('u3')).not.toThrow();
  });

  it('web() for a member without an ICA account also gets NotLinked and spends nothing', async () => {
    seedUser(db, 'u5');
    const k = limited(1);
    await expect(k.forUser('u5').web(async () => 'never')).rejects.toBeInstanceOf(NotLinked);
    expect(() => take('u5')).not.toThrow();
  });

  it('a rate-limited call never reaches ICA and says when to retry', async () => {
    await link('u1', fakeAppState());
    const k = limited(1);
    take('u1');
    let ran = false;
    const e = await k.forUser('u1').app(async () => { ran = true; }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(RateLimited);
    expect((e as RateLimited).retryAfterSeconds).toBe(1);
    expect(ran).toBe(false);
  });
});

const LISTS = '/sverige/digx/shopping-list/v1/api/list/all';
const webList = (bearer: string) => icaRequest(bearerFetcher(bearer), `${fake.endpoints.gateway}${LISTS}`).then(() => bearer);
const webRow = (accountId: string) => db.select().from(schema.icaSession).all().find((r) => r.icaAccountId === accountId && r.kind === 'web')!;

describe('SessionKeeper: web session', () => {
  it('mints the web bearer once and reuses it until tokenExpires − 60 s', async () => {
    const acc = await link('u1', null);
    fake.opts.webTokenExpires = new Date(NOW.getTime() + 5 * 60_000).toISOString();
    const k = keeper();
    expect(await k.withWebBearer(acc, webList)).toBe(FAKE_SECRETS.accessToken);
    await k.withWebBearer(acc, webList);
    expect(fake.seen.userInfoCalls).toBe(1);
    at(4 * 60_000 + 1000);
    await k.withWebBearer(acc, webList);
    expect(fake.seen.userInfoCalls).toBe(2);
  });

  it('falls back to 4 minutes (minus the margin) when ICA gives no tokenExpires', async () => {
    const acc = await link('u1', null);
    fake.opts.webTokenExpires = undefined;
    const k = keeper();
    await k.withWebBearer(acc, webList);
    at(3 * 60_000 - 1000);
    await k.withWebBearer(acc, webList);
    expect(fake.seen.userInfoCalls).toBe(1);
    at(3 * 60_000 + 1000);
    await k.withWebBearer(acc, webList);
    expect(fake.seen.userInfoCalls).toBe(2);
  });

  it('concurrent first uses share one user-information call', async () => {
    const acc = await link('u1', null);
    const k = keeper();
    await Promise.all([k.withWebBearer(acc, webList), k.withWebBearer(acc, webList), k.webLoginState(acc)]);
    expect(fake.seen.userInfoCalls).toBe(1);
  });

  it('a 401 from the gateway → one fresh bearer and one retry', async () => {
    const acc = await link('u1', null);
    const k = keeper();
    fake.opts.gatewayFailures = [{ pathPrefix: LISTS, status: 401, times: 1 }];
    await k.withWebBearer(acc, webList);
    expect(fake.seen.userInfoCalls).toBe(2);
  });

  it('refused again right after a successful fresh check: IcaRejected, not a reconnect (the session itself works)', async () => {
    const acc = await link('u1', null);
    const k = keeper();
    for (const status of [401, 403]) {
      fake.opts.gatewayFailures = [{ pathPrefix: LISTS, status, times: 2 }];
      await expect(k.withWebBearer(acc, webList)).rejects.toMatchObject({ name: 'IcaRejected', status });
      expect(webRow(acc).lastError).toBeNull();
    }
  });

  it('refused, and the fresh check finds the session logged out: NeedsWebReconnect', async () => {
    const acc = await link('u1', null);
    const k = keeper();
    await k.withWebBearer(acc, webList);
    fake.opts.gatewayFailures = [{ pathPrefix: LISTS, status: 401, times: 2 }];
    fake.opts.userInfo = { status: 401, body: {} };
    try {
      await expect(k.withWebBearer(acc, webList)).rejects.toMatchObject({ name: 'NeedsWebReconnect' });
    } finally { fake.opts.userInfo = undefined; }
  });

  it('records the loginState ICA reports, with the time of the check', async () => {
    const acc = await link('u1', null);
    fake.opts.loginState = 1;
    at(60_000);
    expect(await keeper().webLoginState(acc)).toEqual({ loginState: 1, checkedAt: clock.toISOString() });
    expect(webRow(acc)).toMatchObject({ loginState: 1, loginStateAt: clock.toISOString(), lastError: null });
  });

  it('loginState 0 → NeedsWebReconnect, recorded on the row', async () => {
    const acc = await link('u1', null);
    fake.opts.loginState = 0;
    await expect(keeper().webLoginState(acc)).rejects.toMatchObject({ name: 'NeedsWebReconnect' });
    expect(webRow(acc)).toMatchObject({ lastError: WEB_SESSION_LOGGED_OUT, loginState: 0 });
  });

  it('writes rotated cookies back, encrypted, and leaves an unchanged jar alone', async () => {
    const acc = await link('u1', null);
    const before = webRow(acc).stateEnc;
    expect((await keeper().webLoginState(acc)).loginState).toBe(2);
    expect(webRow(acc).stateEnc).toBe(before);
    fake.opts.rotateCookie = true;
    await keeper().webLoginState(acc);
    const after = webRow(acc).stateEnc;
    expect(after).not.toBe(before);
    expect(cipher.decrypt(after)).toContain('icaRotated');
    expect(JSON.stringify(db.$client.prepare('select * from ica_session').all())).not.toContain(FAKE_SECRETS.rotatedCookie);
  });

  it('an unreachable ICA is transient', async () => {
    const acc = await link('u1', null);
    await expect(keeper({ ...fake.endpoints, web: 'http://127.0.0.1:9' }).webLoginState(acc)).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'network' });
  });

  it('logs web checks with the account, event, ok and loginState only: no cookie, bearer or personnummer', async () => {
    const acc = await link('u1', null);
    fake.opts.rotateCookie = true;
    await keeper().withWebBearer(acc, webList);
    expect(logs).toContainEqual({ account: acc, kind: 'web', event: 'check', ok: true, loginState: 2 });
    const all = JSON.stringify(logs);
    for (const s of [FAKE_SECRETS.accessToken, FAKE_SECRETS.thSessionId, FAKE_SECRETS.rotatedCookie, FAKE_SECRETS.personnummer]) expect(all).not.toContain(s);
  });

  it('a reconnect (new web row, maybe another person) is never served the old cached bearer', async () => {
    const acc = await link('u1', null);
    const k = keeper();
    expect(await k.withWebBearer(acc, async (b) => b)).toBe(FAKE_SECRETS.accessToken);
    fake.opts.userInfo = { status: 200, body: { accessToken: 'WEB-ACCESS-TOKEN-NEW', loginState: 2, tokenExpires: new Date(NOW.getTime() + 3_600_000).toISOString() } };
    await storeWebSession({ session: await fakeLoggedInSession(fake), endpoints: fake.endpoints, db, cipher, user: { id: 'u1', name: 'u1' }, now: () => NOW });
    expect(await k.withWebBearer(acc, async (b) => b)).toBe('WEB-ACCESS-TOKEN-NEW');
  });

  it('a check that raced a reconnect is redone against the new session', async () => {
    const acc = await link('u1', null);
    const old = webRow(acc);
    let swapped = false;
    // Right after the first user-information answer, before the check records it, a reconnect replaces the row.
    const k = createSessionKeeper({ db, cipher, endpoints: fake.endpoints, now: () => {
      if (!swapped && fake.seen.userInfoCalls === 1) {
        swapped = true;
        db.delete(schema.icaSession).where(eq(schema.icaSession.id, old.id)).run();
        db.insert(schema.icaSession).values({ ...old, id: 'reconnected', loginState: null, loginStateAt: null }).run();
      }
      return clock;
    } });
    expect(await k.withWebBearer(acc, async (b) => b)).toBe(FAKE_SECRETS.accessToken);
    expect(fake.seen.userInfoCalls).toBe(2);
    expect(webRow(acc)).toMatchObject({ id: 'reconnected', loginState: 2, loginStateAt: clock.toISOString() });
  });

  describe('a jar save that fails never changes the outcome', () => {
    const failing = { ...cipher, encrypt: (): string => { throw new Error('disk full'); } };
    const failingKeeper = () => createSessionKeeper({ db, cipher: failing, endpoints: fake.endpoints, now: () => clock, log: { info: (o) => { logs.push(o); }, warn: (o) => { logs.push(o); } } });

    it('on a successful check: the bearer, lastOkAt and loginState are still there', async () => {
      const acc = await link('u1', null);
      fake.opts.rotateCookie = true; fake.opts.loginState = 1;
      at(60_000);
      expect(await failingKeeper().webLoginState(acc)).toEqual({ loginState: 1, checkedAt: clock.toISOString() });
      expect(webRow(acc)).toMatchObject({ lastOkAt: clock.toISOString(), loginState: 1, loginStateAt: clock.toISOString() });
      expect(logs).toContainEqual({ account: acc, err: { name: 'Error' } });
    });

    it('on an ICA 500: still IcaUnavailable', async () => {
      const acc = await link('u1', null);
      fake.opts.rotateCookie = true; fake.opts.userInfo = { status: 500, body: {} };
      await expect(failingKeeper().webLoginState(acc)).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'server-error', status: 500 });
      expect(logs).toContainEqual({ account: acc, err: { name: 'Error' } });
    });
  });

  it('withWebJar runs the jar uses of an account one after the other', async () => {
    const acc = await link('u1', null);
    const k = keeper();
    const order: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const a = k.withWebJar(acc, async () => { order.push('a-start'); await gate; order.push('a-end'); });
    const b = k.withWebJar(acc, async () => { order.push('b-start'); order.push('b-end'); });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['a-start']);
    open();
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('withWebJar re-entered for the same account throws instead of hanging; another account may nest', async () => {
    const a = await link('alice', null);
    const b = await link('bob', null);
    const k = keeper();
    await expect(k.withWebJar(a, () => k.withWebJar(a, async () => 1))).rejects.toThrow('withWebJar re-entered for the same account');
    await expect(k.withWebJar(a, () => k.webLoginState(a))).rejects.toThrow('withWebJar re-entered for the same account');
    expect(await k.withWebJar(a, () => k.withWebJar(b, async () => 'nested'))).toBe('nested');
    expect(await k.withWebJar(a, async () => 'after')).toBe('after');
    expect(k.webJarUsesQueued()).toBe(0);
  });

  it('recheck() runs the user-information check on the held session, inside the lock', async () => {
    const acc = await link('u1', null);
    const k = keeper();
    fake.opts.loginState = 1;
    at(60_000);
    const got = await k.withWebJar(acc, async (_session, _row, use) => {
      const c = await use.recheck();
      expect(k.webJarUsesQueued()).toBe(1); // still held
      return c;
    });
    expect(got).toMatchObject({ accessToken: FAKE_SECRETS.accessToken, loginState: 1, checkedAt: clock.toISOString(), rowId: webRow(acc).id });
    expect(webRow(acc)).toMatchObject({ loginState: 1, loginStateAt: clock.toISOString() });
    expect(fake.seen.userInfoCalls).toBe(1);
    await k.withWebBearer(acc, webList); // the recheck cached the bearer
    expect(fake.seen.userInfoCalls).toBe(1);
  });

  it('after a use or the jar load fails, a later use still runs and nothing stays queued', async () => {
    const acc = await link('u1', null);
    const k = keeper();
    await expect(k.withWebJar(acc, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const good = webRow(acc).stateEnc;
    db.update(schema.icaSession).set({ stateEnc: 'v1.garbage' }).where(eq(schema.icaSession.id, webRow(acc).id)).run();
    await expect(k.withWebJar(acc, async () => 1)).rejects.toMatchObject({ name: 'NeedsWebReconnect' });
    db.update(schema.icaSession).set({ stateEnc: good, lastError: null }).where(eq(schema.icaSession.id, webRow(acc).id)).run();
    expect(await k.withWebJar(acc, async () => 'ran')).toBe('ran');
    expect(k.webJarUsesQueued()).toBe(0);
  });

  it('withWebJar saves the jar even when its use fails', async () => {
    const acc = await link('u1', null);
    const before = webRow(acc).stateEnc;
    await expect(keeper().withWebJar(acc, async (session) => {
      await session.jar.setCookie('icaRotated=X; Path=/', `${fake.endpoints.web}/`);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(webRow(acc).stateEnc).not.toBe(before);
  });

  it('a 401 on user information → NeedsWebReconnect with loginState recorded as unknown (null), not 0', async () => {
    const acc = await link('u1', null);
    fake.opts.userInfo = { status: 401, body: {} };
    at(60_000);
    await expect(keeper().webLoginState(acc)).rejects.toMatchObject({ name: 'NeedsWebReconnect' });
    expect(webRow(acc)).toMatchObject({ lastError: WEB_SESSION_LOGGED_OUT, loginState: null, loginStateAt: clock.toISOString() });
  });

  it('a 429 on user information → IcaUnavailable(rate-limited)', async () => {
    const acc = await link('u1', null);
    fake.opts.userInfo = { status: 429, body: {} };
    await expect(keeper().webLoginState(acc)).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'rate-limited', status: 429 });
  });

  it('an answer without accessToken is unexpected, but its loginState is still recorded', async () => {
    const acc = await link('u1', null);
    fake.opts.userInfo = { status: 200, body: { loginState: 1 } };
    at(60_000);
    await expect(keeper().webLoginState(acc)).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'unexpected-response' });
    expect(webRow(acc)).toMatchObject({ loginState: 1, loginStateAt: clock.toISOString() });
  });

  it('keeps a cached bearer at least 30 s even when tokenExpires is nearly due', async () => {
    const acc = await link('u1', null);
    fake.opts.webTokenExpires = new Date(NOW.getTime() + 10_000).toISOString();
    const k = keeper();
    await k.withWebBearer(acc, webList);
    at(29_000);
    await k.withWebBearer(acc, webList);
    expect(fake.seen.userInfoCalls).toBe(1);
    at(31_000);
    await k.withWebBearer(acc, webList);
    expect(fake.seen.userInfoCalls).toBe(2);
  });

  it('no web session → NeedsWebReconnect', async () => {
    await expect(keeper().withWebBearer('no-such-account', webList)).rejects.toMatchObject({ name: 'NeedsWebReconnect' });
  });
});

describe('SessionKeeper: the only way in', () => {
  const SRC = fileURLToPath(new URL('..', import.meta.url));
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? sources(join(dir, d.name)) : d.name.endsWith('.ts') && !d.name.endsWith('.test.ts') ? [join(dir, d.name)] : []);
  const callers = (fn: string) => sources(SRC).filter((f) => readFileSync(f, 'utf8').includes(`${fn}(`)).map((f) => relative(SRC, f)).sort();

  it('refreshAppSession is called only by the keeper (its single-flight is what makes it race-safe)', () => {
    expect(callers('refreshAppSession')).toEqual(['sessions/app-store.ts', 'sessions/keeper.ts']);
  });

  it('saveWebJarIfChanged is called only by the keeper (withWebJar serialises the jar uses it writes back)', () => {
    expect(callers('saveWebJarIfChanged')).toEqual(['sessions/keeper.ts', 'sessions/web-store.ts']);
  });

  it('createPurchaseApi is called only by the keeper (the loginState check and the jar lock come with it)', () => {
    expect(callers('createPurchaseApi')).toEqual(['ica/web-api.ts', 'sessions/keeper.ts']);
  });

  it('createSessionKeeper is called only by createApp: one keeper per process, shared via appKeeper(app)', () => {
    expect(callers('createSessionKeeper')).toEqual(['server.ts', 'sessions/keeper.ts']);
  });
});

describe('SessionKeeper: purchase history', () => {
  const months = (k: ReturnType<typeof keeper>, acc: string) =>
    k.withWebCookies(acc, (session) => createPurchaseApi({ endpoints: fake.endpoints, session }).monthSummaries(), { minLoginState: 2 });
  const cpaCalls = () => fake.seen.paths.filter((p) => p.startsWith('/api/cpa/')).length;
  beforeEach(() => { fake.opts.routes = { ...FAKE_PROBE_ROUTES, ...FAKE_WEB_ROUTES }; });

  it('at loginState 2 the stored jar reaches /api/cpa, and the flag says available', async () => {
    const acc = await link('u1', null);
    expect(await months(keeper(), acc)).toHaveLength(3);
    expect(fake.seen.userInfoCalls).toBe(1);
    expect(await keeper().forUser('u1').status('https://hub.example/admin/ica')).toMatchObject({ purchaseHistory: { available: true, loginState: 2, checkedAt: clock.toISOString() } });
  });

  it('loginState 1 → NeedsFreshBankId without a CPA call, recorded; never a reconnect', async () => {
    const acc = await link('u1', null);
    fake.opts.loginState = 1;
    at(60_000);
    await expect(months(keeper(), acc)).rejects.toMatchObject({ name: 'NeedsFreshBankId', loginState: 1 });
    expect(cpaCalls()).toBe(0);
    expect(webRow(acc)).toMatchObject({ loginState: 1, loginStateAt: clock.toISOString(), lastError: null });
    expect(await keeper().forUser('u1').status('https://hub.example/admin/ica')).toMatchObject({ purchaseHistory: { available: false, loginState: 1, checkedAt: clock.toISOString() } });
  });

  it('a 403 at loginState 2 re-checks, and is NeedsFreshBankId(refused-at-level), not a reconnect; one warn, no upgrade', async () => {
    const acc = await link('u1', null);
    fake.opts.cpaForbidden = true;
    at(60_000);
    await expect(months(keeper(), acc)).rejects.toMatchObject({ name: 'NeedsFreshBankId', loginState: 2, reason: 'refused-at-level' });
    expect(fake.seen.userInfoCalls).toBe(2);
    expect(cpaCalls()).toBe(1);
    // The flag is not left at "available": ICA refused although it reports 2, so the state is unknown.
    expect(webRow(acc)).toMatchObject({ lastError: null, loginState: null, loginStateAt: clock.toISOString() });
    const warns = logs.filter((l) => (l as { event?: string }).event === 'cpa-forbidden-at-level');
    expect(warns).toEqual([{ account: acc, event: 'cpa-forbidden-at-level', status: 403, loginState: 2 }]);
  });

  it('a 403 that came with a drop to loginState 1 reports level 1 and records it, without the at-level warning', async () => {
    const acc = await link('u1', null);
    const k = keeper();
    await expect(k.withWebCookies(acc, async () => { fake.opts.loginState = 1; throw new IcaUnauthorized(403); }, { minLoginState: 2 }))
      .rejects.toMatchObject({ name: 'NeedsFreshBankId', loginState: 1, reason: 'level' });
    expect(webRow(acc)).toMatchObject({ loginState: 1, lastError: null });
    expect(logs.some((l) => (l as { event?: string }).event === 'cpa-forbidden-at-level')).toBe(false);
  });

  it('a check that raced an app connect never overwrites the newer recorded state (compare-and-swap on loginStateAt)', async () => {
    const acc = await link('u1', null);
    const k = keeper();
    let release!: () => void;
    fake.opts.holdUserInfo = new Promise<void>((r) => { release = r; });
    at(60_000);
    const check = k.webLoginState(acc);
    while (fake.seen.userInfoCalls === 0) await new Promise((r) => setTimeout(r, 2));
    const connectedAt = new Date(NOW.getTime() + 90_000);
    storeAppSession({ db, cipher, userId: 'u1', state: fakeAppState(), now: () => connectedAt });
    release();
    expect(await check).toMatchObject({ loginState: 2 }); // what ICA answered, before the connect
    expect(webRow(acc)).toMatchObject({ loginState: 1, loginStateAt: connectedAt.toISOString() });
    // a later check writes again
    fake.opts.holdUserInfo = undefined;
    at(120_000);
    await k.webLoginState(acc);
    expect(webRow(acc)).toMatchObject({ loginState: 2, loginStateAt: clock.toISOString() });
  });

  it('a user-information answer without a loginState key is logged as loginState "absent"', async () => {
    const acc = await link('u1', null);
    fake.opts.userInfo = { status: 200, body: { accessToken: FAKE_SECRETS.accessToken } };
    expect(await keeper().webLoginState(acc)).toMatchObject({ loginState: undefined });
    expect(logs).toContainEqual({ account: acc, kind: 'web', event: 'check', ok: true, loginState: 'absent' });
  });

  it('a 403 whose re-check finds the session logged out is NeedsWebReconnect (the session really ended)', async () => {
    const acc = await link('u1', null);
    const k = keeper();
    await expect(k.withWebCookies(acc, async () => { fake.opts.loginState = 0; throw new IcaUnauthorized(403); }, { minLoginState: 2 }))
      .rejects.toMatchObject({ name: 'NeedsWebReconnect' });
  });

  it('a logged-out session is NeedsWebReconnect before any CPA call', async () => {
    const acc = await link('u1', null);
    fake.opts.loginState = 0;
    await expect(months(keeper(), acc)).rejects.toMatchObject({ name: 'NeedsWebReconnect' });
    expect(cpaCalls()).toBe(0);
  });

  it('runs inside the account\'s jar lock, saves rotated cookies, and leaves nothing queued', async () => {
    const acc = await link('u1', null);
    const k = keeper();
    fake.opts.rotateCookie = true;
    const before = webRow(acc).stateEnc;
    const queued = await k.withWebCookies(acc, async () => k.webJarUsesQueued(), { minLoginState: 2 });
    expect(queued).toBe(1);
    expect(webRow(acc).stateEnc).not.toBe(before);
    expect(k.webJarUsesQueued()).toBe(0);
    await expect(k.withWebCookies(acc, () => k.webLoginState(acc))).rejects.toThrow('withWebJar re-entered for the same account');
  });

  it('forUser().purchases charges one ICA call from the budget and needs a linked account', async () => {
    await link('u1', null);
    seedUser(db, 'u9');
    const k = createSessionKeeper({ db, cipher, endpoints: fake.endpoints, now: () => clock, limiter: createTokenBucket({ capacity: 1, refillPerSecond: 1, now: () => 0 }) });
    expect(await k.forUser('u1').purchases((api) => api.monthSummaries())).toHaveLength(3);
    await expect(k.forUser('u1').purchases((api) => api.monthSummaries())).rejects.toBeInstanceOf(RateLimited);
    await expect(k.forUser('u9').purchases(async () => 'never')).rejects.toBeInstanceOf(NotLinked);
    expect(cpaCalls()).toBe(1);
  });

  it('a web login-state check with no web session is NeedsWebReconnect', async () => {
    await expect(keeper().webLoginState('no-such-account')).rejects.toMatchObject({ name: 'NeedsWebReconnect' });
  });
});

describe('SessionKeeper: same-person backfill', () => {
  const hashOf = (acc: string) => db.select().from(schema.icaAccount).where(eq(schema.icaAccount.id, acc)).get()!.webSubjectHash;

  it('fills a missing subject hash from a successful check of the stored (trusted) session', async () => {
    const acc = await link('u1', null);
    expect(hashOf(acc)).toBeNull();
    fake.opts.webSubject = 123456;
    await keeper().withWebBearer(acc, webList);
    expect(hashOf(acc)).toBe(cipher.mac('ica-subject:123456'));
    expect(JSON.stringify(logs)).not.toContain('123456');
    expect(JSON.stringify(logs)).not.toContain(hashOf(acc));
  });

  it('never overwrites a stored hash: a different subject in the check is not written', async () => {
    fake.opts.webSubject = 111;
    const acc = await link('u1', null);
    expect(hashOf(acc)).toBe(cipher.mac('ica-subject:111'));
    fake.opts.webSubject = 222;
    await keeper().withWebBearer(acc, webList);
    expect(hashOf(acc)).toBe(cipher.mac('ica-subject:111'));
  });

  it('writes nothing from a check that failed', async () => {
    const acc = await link('u1', null);
    fake.opts.webSubject = 123456;
    fake.opts.loginState = 0;
    await expect(keeper().withWebBearer(acc, webList)).rejects.toThrow();
    expect(hashOf(acc)).toBeNull();
  });

  it('with no subject from ICA the hash stays null', async () => {
    const acc = await link('u1', null);
    await keeper().withWebBearer(acc, webList);
    expect(hashOf(acc)).toBeNull();
  });
});

describe('SessionKeeper: idle (graceful shutdown drain)', () => {
  const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
  /** Resolves to 'idle' when `p` settles within a few event-loop turns, else 'pending'. */
  const settledSoon = (p: Promise<void>) => Promise.race([p.then(() => 'idle' as const), tick().then(() => 'pending' as const)]);

  it('resolves at once with nothing in flight', async () => {
    await link('u1', fakeAppState());
    const k = keeper();
    expect(await Promise.race([k.idle().then(() => 'idle'), new Promise((r) => setImmediate(() => r('late')))])).toBe('idle');
  });

  it('waits for an in-flight app refresh held at the token endpoint; the rotated token is stored before it resolves', async () => {
    const acc = await link('u1', fakeAppState());
    let release!: () => void;
    fake.opts.holdRefresh = new Promise<void>((r) => { release = r; });
    const k = keeper();
    const refresh = k.refreshAppNow(acc);
    while (refreshes() === 0) await tick(2);
    const idle = k.idle();
    expect(await settledSoon(idle)).toBe('pending');
    let storedAtIdle: string | undefined;
    const done = idle.then(() => { storedAtIdle = loadAppSession({ db, cipher, icaAccountId: acc })!.state.token.refresh_token; });
    release();
    await done;
    expect(storedAtIdle).toBe(`${FAKE_SECRETS.appRefreshToken}-r1`);
    expect(await refresh).toBe(`${FAKE_SECRETS.appAccessToken}-r1`);
  });

  it('a failed refresh still lets idle() resolve (it waits, it does not rethrow)', async () => {
    const acc = await link('u1', fakeAppState());
    fake.opts.refreshInvalid = true;
    const k = keeper();
    const refresh = k.refreshAppNow(acc).catch((e: unknown) => e);
    await k.idle();
    expect(await refresh).toMatchObject({ name: 'NeedsAppReconnect' });
  });

  it('waits for an in-flight web check', async () => {
    const acc = await link('u1', null);
    let release!: () => void;
    fake.opts.holdUserInfo = new Promise<void>((r) => { release = r; });
    const k = keeper();
    const check = k.webLoginState(acc);
    while (fake.seen.userInfoCalls === 0) await tick(2);
    const idle = k.idle();
    expect(await settledSoon(idle)).toBe('pending');
    release();
    await idle;
    await check;
  });

  it('after beginClosing a new app refresh is refused (IcaUnavailable shutting-down); the stored token and ICA are untouched', async () => {
    const acc = await link('u1', fakeAppState());
    const k = keeper();
    k.beginClosing();
    await expect(k.refreshAppNow(acc)).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'shutting-down' });
    at(900_000); // < 60 s left: a tool call would refresh
    await expect(k.withAppBearer(acc, bonus)).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'shutting-down' });
    expect(refreshes()).toBe(0);
    expect(loadAppSession({ db, cipher, icaAccountId: acc })!.state.token.refresh_token).toBe(FAKE_SECRETS.appRefreshToken);
    at(0); // a token with time left is still handed out
    expect(await k.withAppBearer(acc, bonus)).toBe(FAKE_SECRETS.appAccessToken);
    await k.idle();
  });

  it('after beginClosing an in-flight refresh is still joined, and written before idle() resolves', async () => {
    const acc = await link('u1', fakeAppState());
    let release!: () => void;
    fake.opts.holdRefresh = new Promise<void>((r) => { release = r; });
    const k = keeper();
    const upkeep = k.refreshAppNow(acc);
    while (refreshes() === 0) await tick(2);
    k.beginClosing();
    const joined = k.refreshAppNow(acc);
    const idle = k.idle();
    release();
    await idle;
    expect(loadAppSession({ db, cipher, icaAccountId: acc })!.state.token.refresh_token).toBe(`${FAKE_SECRETS.appRefreshToken}-r1`);
    expect(await Promise.all([upkeep, joined])).toEqual([`${FAKE_SECRETS.appAccessToken}-r1`, `${FAKE_SECRETS.appAccessToken}-r1`]);
    expect(refreshes()).toBe(1);
  });

  it('idle() also waits for work that started after its first snapshot (just before beginClosing)', async () => {
    const acc = await link('u1', fakeAppState());
    const web = await link('u2', null);
    let releaseJar!: () => void;
    const gate = new Promise<void>((r) => { releaseJar = r; });
    let releaseRefresh!: () => void;
    fake.opts.holdRefresh = new Promise<void>((r) => { releaseRefresh = r; });
    const k = keeper();
    const jar = k.withWebJar(web, () => gate);
    const idle = k.idle(); // snapshot: only the jar use
    const refresh = k.refreshAppNow(acc); // starts after the snapshot
    k.beginClosing();
    while (refreshes() === 0) await tick(2);
    releaseJar();
    await jar;
    expect(await settledSoon(idle)).toBe('pending');
    releaseRefresh();
    await idle;
    expect(loadAppSession({ db, cipher, icaAccountId: acc })!.state.token.refresh_token).toBe(`${FAKE_SECRETS.appRefreshToken}-r1`);
    await refresh;
  });

  it('after beginClosing a new web check or jar use is refused; one already queued still runs', async () => {
    const acc = await link('u1', null);
    const k = keeper();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = k.withWebJar(acc, () => gate);
    const queued = k.withWebJar(acc, async () => 'queued');
    k.beginClosing();
    await expect(k.webLoginState(acc)).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'shutting-down' });
    await expect(k.withWebJar(acc, async () => 'new')).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'shutting-down' });
    expect(fake.seen.userInfoCalls).toBe(0);
    release();
    await first;
    expect(await queued).toBe('queued');
    await k.idle();
  });

  it('waits for a held web jar use and the ones queued behind it (their jar saves included)', async () => {
    const acc = await link('u1', null);
    const k = keeper();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const first = k.withWebJar(acc, async () => { await gate; order.push('first'); });
    const second = k.withWebJar(acc, async () => { order.push('second'); });
    const idle = k.idle().then(() => { order.push('idle'); });
    expect(await settledSoon(idle)).toBe('pending');
    release();
    await Promise.all([first, second, idle]);
    expect(order).toEqual(['first', 'second', 'idle']);
  });
});
