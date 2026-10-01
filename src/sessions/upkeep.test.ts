import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, openDb, schema, type Db } from '../db/index.js';
import { createCipher } from '../crypto.js';
import { APP_SESSION_EXPIRED } from '../ica/app-session.js';
import type { IcaEndpoints } from '../ica/endpoints.js';
import { IcaUnavailable } from '../ica/errors.js';
import { FAKE_SECRETS, fakeAppState, fakeLoggedInSession, startFakeIca, type FakeIca } from '../ica/test-fakes.js';
import { seedUser } from '../test-helpers.js';
import { storeWebSession } from './web-store.js';
import { storeAppSession } from './app-store.js';
import { createSessionKeeper } from './keeper.js';
import type { TokenBucket } from './rate-limit.js';
import {
  UPKEEP_BACKOFF_MAX_MS, UPKEEP_JITTER_MS, UPKEEP_REFRESH_EVERY_MS, appSessionsDue, backoffMs, runAppUpkeep, startAppUpkeep, upkeepJitterMs, type UpkeepBackoff,
} from './upkeep.js';

const cipher = createCipher(Buffer.alloc(32, 7));
const NOW = new Date('2026-09-30T12:00:00.000Z');
const M = 60_000;
const H = 3_600_000;
const silent = { info: () => {}, warn: () => {} };

describe('app upkeep (keeper-backed)', () => {
  let db: Db; let fake: FakeIca;
  /** A hub user with web and app sessions; storeAppSession stamps connected_at and refreshed_at with `at`. */
  async function link(userId: string, at: Date, app: ReturnType<typeof fakeAppState>): Promise<string> {
    seedUser(db, userId);
    const { icaAccountId } = await storeWebSession({ session: await fakeLoggedInSession(fake), endpoints: fake.endpoints, db, cipher, user: { id: userId, name: userId }, now: () => at });
    storeAppSession({ db, cipher, userId, state: app, now: () => at });
    return icaAccountId;
  }
  const keeper = () => createSessionKeeper({ db, cipher, endpoints: fake.endpoints, now: () => NOW });
  const refreshes = () => fake.seen.tokenGrants.filter((g) => g === 'refresh_token').length;
  const appRow = (acc: string) => db.select().from(schema.icaSession).all().find((r) => r.icaAccountId === acc && r.kind === 'app')!;
  const setApp = (acc: string, v: Partial<typeof schema.icaSession.$inferInsert>) => db.update(schema.icaSession).set(v).where(eq(schema.icaSession.id, appRow(acc).id)).run();

  beforeEach(async () => { db = openDb(':memory:'); fake = await startFakeIca({ pendingPolls: 0 }); });
  afterEach(async () => { closeDb(db); await fake.close(); });

  it('refreshes every connected app session about every 10 minutes, inside and past the 4-hour window', async () => {
    const recent = await link('recent', new Date(NOW.getTime() - 5 * M), fakeAppState({ refreshToken: 'R-RECENT' }));
    const inside = await link('inside', new Date(NOW.getTime() - 11 * M), fakeAppState());
    const past = await link('past', new Date(NOW.getTime() - 5 * H), fakeAppState({ refreshToken: 'R-PAST', expiresIn: 30 * 86_400 }));
    setApp(past, { refreshedAt: new Date(NOW.getTime() - 11 * M).toISOString() });
    const dead = await link('dead', new Date(NOW.getTime() - 11 * M), fakeAppState({ refreshToken: 'R-DEAD' }));
    setApp(dead, { lastError: APP_SESSION_EXPIRED });
    // A 30-day token is refreshed too (like the ICA app); a fresh one and a dead one are not.
    expect(appSessionsDue(db, NOW).sort()).toEqual([inside, past].sort());
    setApp(past, { refreshedAt: new Date(NOW.getTime() - M).toISOString() }); // only `inside` holds the fake's live refresh token
    expect(await runAppUpkeep({ db, keeper: keeper(), log: silent, now: () => NOW })).toEqual({ refreshed: 1, failed: 0 });
    expect(appRow(inside)).toMatchObject({ refreshedAt: NOW.toISOString(), lastError: null });
    expect(refreshes()).toBe(1);
    expect(appSessionsDue(db, NOW)).toEqual([]);
    expect(appSessionsDue(db, new Date(NOW.getTime() + 10 * M))).toContain(inside);
    expect(appRow(recent).refreshedAt).not.toBe(NOW.toISOString());
  });

  it('a session without refreshed_at (connected before Phase 2) is due at once', async () => {
    const acc = await link('old', new Date(NOW.getTime() - M), fakeAppState());
    expect(appSessionsDue(db, NOW)).toEqual([]);
    setApp(acc, { refreshedAt: null, connectedAt: null });
    expect(appSessionsDue(db, NOW)).toEqual([acc]);
  });

  it('a failed refresh backs off 2, 4, 8 … minutes (at most an hour), is logged without secrets, and a success resets it', async () => {
    const acc = await link('due', new Date(NOW.getTime() - 11 * M), fakeAppState());
    let now = NOW;
    const lines: object[] = [];
    const backoff: UpkeepBackoff = new Map();
    const run = (endpoints: IcaEndpoints) => runAppUpkeep({
      db, keeper: createSessionKeeper({ db, cipher, endpoints, now: () => now }), backoff, now: () => now,
      log: { info: () => {}, warn: (o: object) => { lines.push(o); } },
    });
    const down = { ...fake.endpoints, ims: 'http://127.0.0.1:9' };
    expect(await run(down)).toEqual({ refreshed: 0, failed: 1 });
    expect(lines).toEqual([{ account: acc, failures: 1, err: { name: 'IcaUnavailable' } }]);
    expect(JSON.stringify(lines)).not.toContain(FAKE_SECRETS.appRefreshToken);
    now = new Date(NOW.getTime() + M);
    expect(appSessionsDue(db, now, backoff)).toEqual([]);
    now = new Date(NOW.getTime() + 2 * M);
    expect(await run(down)).toEqual({ refreshed: 0, failed: 1 }); // the second failure waits 4 minutes
    now = new Date(NOW.getTime() + 5 * M);
    expect(appSessionsDue(db, now, backoff)).toEqual([]);
    now = new Date(NOW.getTime() + 6 * M);
    expect(await run(fake.endpoints)).toEqual({ refreshed: 1, failed: 0 });
    expect(backoff.get(acc)?.failures ?? 0).toBe(0);
    expect([backoffMs(1), backoffMs(2), backoffMs(3), backoffMs(10)]).toEqual([2 * M, 4 * M, 8 * M, UPKEEP_BACKOFF_MAX_MS]);
  });

  it('an upkeep refresh and a tool call at the same moment share one refresh', async () => {
    const acc = await link('due', new Date(NOW.getTime() - (14 * M + 30_000)), fakeAppState()); // 30 s left on the 900 s token
    const k = keeper();
    const [bearer] = await Promise.all([k.appToken(acc), runAppUpkeep({ db, keeper: k, log: silent, now: () => NOW })]);
    expect(bearer).toBe(`${FAKE_SECRETS.appAccessToken}-r1`);
    expect(refreshes()).toBe(1);
    expect(appRow(acc).lastError).toBeNull();
  });

  it("never spends a user's ICA rate-limit budget", async () => {
    await link('due', new Date(NOW.getTime() - 11 * M), fakeAppState());
    const take = vi.fn(() => ({ ok: true as const }));
    const k = createSessionKeeper({ db, cipher, endpoints: fake.endpoints, now: () => NOW, limiter: { take } as unknown as TokenBucket });
    expect(await runAppUpkeep({ db, keeper: k, log: silent, now: () => NOW })).toEqual({ refreshed: 1, failed: 0 });
    expect(take).not.toHaveBeenCalled();
  });

  it('startAppUpkeep runs at once with the real keeper, then stops', async () => {
    await link('due', new Date(NOW.getTime() - 11 * M), fakeAppState());
    const stop = startAppUpkeep({ db, keeper: keeper(), log: silent, now: () => NOW, everyMs: 60_000 });
    await vi.waitFor(() => expect(refreshes()).toBe(1));
    stop();
  });
});

describe('app upkeep jitter', () => {
  it('spreads the schedule: each session is due 8 to 10 minutes after its last refresh, stable per refresh', () => {
    const at = '2026-09-30T11:50:00.000Z';
    const js = ['a', 'b', 'c', 'd', 'e', 'f'].map((acc) => upkeepJitterMs(acc, at));
    for (const j of js) { expect(j).toBeGreaterThanOrEqual(0); expect(j).toBeLessThan(UPKEEP_JITTER_MS); }
    expect(new Set(js).size).toBeGreaterThan(1);
    expect(upkeepJitterMs('a', at)).toBe(js[0]);
    expect(UPKEEP_REFRESH_EVERY_MS - UPKEEP_JITTER_MS).toBe(8 * M);
  });
});

/** The timer behaviour, with fake timers and a stub keeper over plain rows (no ICA). */
describe('startAppUpkeep (fake timers)', () => {
  let db: Db;
  const T0 = NOW.getTime();
  const addApp = (acc: string, refreshedAt: Date | null, connectedAt: Date | null = refreshedAt) => {
    const t = NOW.toISOString();
    db.insert(schema.icaAccount).values({ id: acc, displayName: acc, createdAt: t, updatedAt: t }).run();
    db.insert(schema.icaSession).values({
      id: `app-${acc}`, icaAccountId: acc, kind: 'app', stateEnc: 'v1.x', expiresAt: t, connectedAt: connectedAt?.toISOString() ?? null, refreshedAt: refreshedAt?.toISOString() ?? null, updatedAt: t,
    }).run();
  };
  /** A keeper whose refresh stamps refreshed_at (and a window-capped expiry) like the real one, at fake-clock time. */
  const stampingKeeper = (calls: { account: string; at: number }[]) => ({
    refreshAppNow: vi.fn((account: string) => {
      const t = Date.now();
      calls.push({ account, at: t });
      const row = db.select().from(schema.icaSession).where(eq(schema.icaSession.id, `app-${account}`)).get()!;
      const windowEnd = row.connectedAt ? Date.parse(row.connectedAt) + 4 * H : 0;
      const exp = t < windowEnd ? Math.min(t + 15 * M, windowEnd) : t + 30 * 86_400_000;
      db.update(schema.icaSession).set({ refreshedAt: new Date(t).toISOString(), expiresAt: new Date(exp).toISOString() }).where(eq(schema.icaSession.id, row.id)).run();
      return Promise.resolve('token');
    }),
  });

  beforeEach(() => { vi.useFakeTimers({ now: NOW }); db = openDb(':memory:'); });
  afterEach(() => { closeDb(db); vi.useRealTimers(); });

  it('ticks every minute and refreshes each session every 8 to 10 minutes, never faster, also across the end of the 4-hour window', async () => {
    addApp('a', new Date(T0 - 11 * M), new Date(T0 - 3 * H - 50 * M)); // the window ends 10 minutes from now
    addApp('b', null); // connected before Phase 2: due at once
    const calls: { account: string; at: number }[] = [];
    const stop = startAppUpkeep({ db, keeper: stampingKeeper(calls), log: silent });
    await vi.advanceTimersByTimeAsync(2 * H);
    stop();
    for (const acc of ['a', 'b']) {
      const at = calls.filter((c) => c.account === acc).map((c) => c.at);
      expect(at[0]).toBe(T0);
      expect(at.length).toBeGreaterThanOrEqual(12);
      expect(at.length).toBeLessThanOrEqual(16);
      for (let i = 1; i < at.length; i++) {
        expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(8 * M);
        expect(at[i]! - at[i - 1]!).toBeLessThanOrEqual(11 * M); // due within 10 min, picked up by the next 1-minute tick
      }
    }
  });

  it('a session that keeps failing is tried again after 2, 4, 8, 16, 32, 60 minutes: never a fast loop', async () => {
    addApp('a', new Date(T0 - 11 * M));
    const at: number[] = [];
    const keeper = { refreshAppNow: vi.fn(() => { at.push(Date.now() - T0); return Promise.reject(new IcaUnavailable('rate-limited', 429)); }) };
    const stop = startAppUpkeep({ db, keeper, log: silent });
    await vi.advanceTimersByTimeAsync(3 * H);
    stop();
    expect(at.map((ms) => ms / M)).toEqual([0, 2, 6, 14, 30, 62, 122]);
  });

  it('a successful refresh is not repeated within 8 minutes even when the stored refresh time does not move', async () => {
    addApp('a', new Date(T0 - 11 * M));
    const keeper = { refreshAppNow: vi.fn(() => Promise.resolve('token')) }; // e.g. a CAS miss: another writer kept its row
    const stop = startAppUpkeep({ db, keeper, log: silent });
    await vi.advanceTimersByTimeAsync(30 * M);
    stop();
    expect(keeper.refreshAppNow.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('forgets the backoff of a disconnected or reconnected session: a new app session starts afresh', async () => {
    addApp('a', new Date(T0 - 11 * M));
    addApp('b', new Date(T0 - 11 * M));
    const far = T0 + H;
    const backoff: UpkeepBackoff = new Map([
      ['a', { failures: 5, retryAt: far, row: 'app-a' }], // still backing off
      ['b', { failures: 5, retryAt: far, row: 'app-b-before-reconnect' }], // BankID reconnect stored a new row
      ['gone', { failures: 1, retryAt: far, row: 'app-gone' }], // disconnected
    ]);
    const keeper = { refreshAppNow: vi.fn(() => Promise.resolve('t')) };
    expect(await runAppUpkeep({ db, keeper, log: silent, backoff })).toEqual({ refreshed: 1, failed: 0 });
    expect(keeper.refreshAppNow.mock.calls).toEqual([['b']]);
    expect([...backoff.keys()].sort()).toEqual(['a', 'b']);
    expect(backoff.get('b')).toEqual({ failures: 0, retryAt: T0 + 8 * M, row: 'app-b' });
  });

  it('skips an account disconnected or reconnected while the pass ran (the snapshot row is gone or replaced)', async () => {
    addApp('a', new Date(T0 - 11 * M));
    addApp('b', new Date(T0 - 11 * M));
    addApp('c', new Date(T0 - 11 * M));
    const keeper = {
      refreshAppNow: vi.fn((account: string) => {
        if (account === 'a') {
          // While a's refresh runs: b reconnects with BankID (a new row), c is disconnected.
          db.update(schema.icaSession).set({ id: 'app-b-new' }).where(eq(schema.icaSession.id, 'app-b')).run();
          db.delete(schema.icaSession).where(eq(schema.icaSession.id, 'app-c')).run();
        }
        return Promise.resolve('t');
      }),
    };
    expect(await runAppUpkeep({ db, keeper, log: silent })).toEqual({ refreshed: 1, failed: 0 });
    expect(keeper.refreshAppNow.mock.calls).toEqual([['a']]);
  });

  it('a clock stepping back a day does not stall the upkeep', async () => {
    addApp('a', new Date(T0 - 11 * M));
    const calls: { account: string; at: number }[] = [];
    const stop = startAppUpkeep({ db, keeper: stampingKeeper(calls), log: silent });
    await vi.advanceTimersByTimeAsync(30 * M);
    const before = calls.length;
    expect(before).toBeGreaterThanOrEqual(3);
    vi.setSystemTime(Date.now() - 86_400_000); // refreshed_at and the in-memory hold are now a day in the future
    await vi.advanceTimersByTimeAsync(30 * M);
    stop();
    const after = calls.slice(before).map((c) => c.at);
    expect(after.length).toBeGreaterThanOrEqual(3);
    expect(after[0]! - (Date.now() - 30 * M)).toBeLessThanOrEqual(9 * M); // the hold is cut back to 8 minutes
    for (let i = 1; i < after.length; i++) expect(after[i]! - after[i - 1]!).toBeGreaterThanOrEqual(8 * M);
  });

  it('a clock step back does not shorten a backoff below its own length', async () => {
    addApp('a', new Date(T0 - 11 * M));
    const backoff: UpkeepBackoff = new Map([['a', { failures: 2, retryAt: T0 + 86_400_000, row: 'app-a' }]]);
    const keeper = { refreshAppNow: vi.fn(() => Promise.resolve('t')) };
    expect(await runAppUpkeep({ db, keeper, log: silent, backoff })).toEqual({ refreshed: 0, failed: 0 });
    expect(backoff.get('a')!.retryAt).toBe(T0 + 4 * M);
    vi.setSystemTime(T0 + 4 * M);
    expect(await runAppUpkeep({ db, keeper, log: silent, backoff })).toEqual({ refreshed: 1, failed: 0 });
  });

  it('passes never overlap: a slow refresh holds back the next tick', async () => {
    addApp('a', new Date(T0 - 11 * M));
    addApp('b', new Date(T0 - 11 * M));
    let release!: () => void;
    const keeper = { refreshAppNow: vi.fn((account: string) => (account === keeper.refreshAppNow.mock.calls[0]![0] ? new Promise<string>((r) => { release = () => r('t'); }) : Promise.resolve('t'))) };
    const stop = startAppUpkeep({ db, keeper, log: silent });
    await vi.advanceTimersByTimeAsync(5 * M);
    expect(keeper.refreshAppNow).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(keeper.refreshAppNow.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b']);
    stop();
  });

  it('stop() clears the timer and ends a running pass before its next session', async () => {
    addApp('a', new Date(T0 - 11 * M));
    addApp('b', new Date(T0 - 11 * M));
    let release!: () => void;
    const keeper = { refreshAppNow: vi.fn(() => new Promise<string>((r) => { release = () => r('t'); })) };
    const stop = startAppUpkeep({ db, keeper, log: silent });
    await vi.advanceTimersByTimeAsync(0);
    expect(keeper.refreshAppNow).toHaveBeenCalledTimes(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    release();
    await vi.advanceTimersByTimeAsync(30 * M);
    expect(keeper.refreshAppNow).toHaveBeenCalledTimes(1);
    stop(); // idempotent
  });

  it('stop() resolves only after the running pass has ended (a refresh is never cut mid-rotation)', async () => {
    addApp('a', new Date(T0 - 11 * M));
    addApp('b', new Date(T0 - 11 * M));
    let release!: () => void;
    const keeper = { refreshAppNow: vi.fn(() => new Promise<string>((r) => { release = () => r('t'); })) };
    const stop = startAppUpkeep({ db, keeper, log: silent });
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const first = stop().then(() => { stopped = true; });
    const again = stop().then(() => 'again'); // idempotent: the second call waits for the same pass
    await vi.advanceTimersByTimeAsync(10);
    expect(stopped).toBe(false);
    release();
    await first;
    expect(await again).toBe('again');
    expect(keeper.refreshAppNow).toHaveBeenCalledTimes(1); // aborted before 'b'
    await expect(stop()).resolves.toBeUndefined(); // after the pass: at once
  });

  it('stop() with no pass running resolves at once', async () => {
    const stop = startAppUpkeep({ db, keeper: { refreshAppNow: vi.fn(() => Promise.resolve('t')) }, log: silent });
    await vi.advanceTimersByTimeAsync(0);
    await expect(stop()).resolves.toBeUndefined();
    const off = startAppUpkeep({ db, keeper: { refreshAppNow: vi.fn(() => Promise.resolve('t')) }, log: silent, mode: 'on-demand' });
    await expect(off()).resolves.toBeUndefined();
  });

  it("the timer is unref'd: it never keeps the process alive", () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const stop = startAppUpkeep({ db, keeper: { refreshAppNow: vi.fn(() => Promise.resolve('t')) }, log: silent });
    const handle = spy.mock.results[0]!.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    stop();
    spy.mockRestore();
  });

  it('a pass that throws (e.g. the database is gone) is logged and the next tick still runs', async () => {
    addApp('a', new Date(T0 - 11 * M));
    const warns: string[] = [];
    const keeper = { refreshAppNow: vi.fn(() => Promise.resolve('t')) };
    const realDb = db;
    let broken = true;
    const flaky = new Proxy(realDb, { get: (t, p, r) => (p === 'select' && broken ? () => { throw new TypeError('The database connection is not open'); } : Reflect.get(t, p, r) as unknown) });
    const stop = startAppUpkeep({ db: flaky, keeper, log: { info: () => {}, warn: (_o: object, msg: string) => { warns.push(msg); } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(warns).toEqual(['app upkeep failed']);
    broken = false;
    await vi.advanceTimersByTimeAsync(M);
    expect(keeper.refreshAppNow).toHaveBeenCalledTimes(1);
    stop();
  });

  it('ICA_HUB_APP_UPKEEP=on-demand: no timer, no refresh, one info line; stop() is a no-op', async () => {
    addApp('a', new Date(T0 - 11 * M));
    const infos: string[] = [];
    const keeper = { refreshAppNow: vi.fn(() => Promise.resolve('t')) };
    const stop = startAppUpkeep({ db, keeper, log: { info: (_o: object, msg: string) => { infos.push(msg); }, warn: () => {} }, mode: 'on-demand' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(H);
    expect(keeper.refreshAppNow).not.toHaveBeenCalled();
    expect(infos).toEqual(['app upkeep off (ICA_HUB_APP_UPKEEP=on-demand): app tokens refresh only when a tool uses them']);
    stop();
  });
});
