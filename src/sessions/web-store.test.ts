import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { CookieJar } from 'tough-cookie';
import { closeDb, openDb, schema, type Db } from '../db/index.js';
import { createCipher } from '../crypto.js';
import { BankidRelay } from '../ica/bankid-relay.js';
import { IcaLoginRejected } from '../ica/web-session.js';
import { cookieFingerprint, linkedIcaAccount, purchaseHistoryOf, loadWebSession, recordLoginState, saveWebJarIfChanged, storeWebSession } from './web-store.js';
import { FAKE_SECRETS, startFakeIca, type FakeIca } from '../ica/test-fakes.js';
import { newSession } from '../ica/http.js';
import { seedUser } from '../test-helpers.js';

const cipher = createCipher(Buffer.alloc(32, 7));
let db: Db; let fake: FakeIca;
const user = { id: 'user-1', name: 'Hub User' };
const NOW = new Date('2026-09-29T12:00:00.000Z');

/** A jar that has been through the whole fake BankID login. */
async function loggedInSession() {
  const relay = new BankidRelay({ endpoints: fake.endpoints });
  await relay.start('web');
  while ((await relay.poll()).state === 'pending') { /* scan */ }
  return relay.session;
}

beforeEach(async () => { db = openDb(':memory:'); seedUser(db, user.id, { name: user.name }); fake = await startFakeIca({ pendingPolls: 0 }); });
afterEach(async () => { closeDb(db); await fake.close(); });

describe('storeWebSession', () => {
  it('creates the account, links the profile and stores the jar encrypted (never the cookie in clear)', async () => {
    const r = await storeWebSession({ session: await loggedInSession(), endpoints: fake.endpoints, db, cipher, user, now: () => NOW });
    const account = db.select().from(schema.icaAccount).where(eq(schema.icaAccount.id, r.icaAccountId)).get()!;
    expect(account.displayName).toBe(FAKE_SECRETS.firstName);
    expect(db.select().from(schema.userProfile).where(eq(schema.userProfile.userId, user.id)).get()).toMatchObject({ icaAccountId: r.icaAccountId });
    const rows = db.select().from(schema.icaSession).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ icaAccountId: r.icaAccountId, kind: 'web', lastOkAt: NOW.toISOString(), lastError: null, connectedAt: NOW.toISOString(), loginState: 2, loginStateAt: NOW.toISOString() });
    expect(row.expiresAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(row.stateEnc.startsWith('v1.')).toBe(true);
    const dump = JSON.stringify(db.$client.prepare('select * from ica_session').all());
    for (const s of [FAKE_SECRETS.thSessionId, FAKE_SECRETS.accessToken, 'thSessionId']) expect(dump).not.toContain(s);
    // decrypts back into a working jar
    const jar = CookieJar.deserializeSync(JSON.parse(cipher.decrypt(row.stateEnc)) as Parameters<typeof CookieJar.deserializeSync>[0]);
    expect((await jar.getCookies(`${fake.endpoints.web}/`)).find((c) => c.key === 'thSessionId')?.value).toBe(FAKE_SECRETS.thSessionId);
    const loaded = loadWebSession({ db, cipher, icaAccountId: r.icaAccountId });
    expect((await loaded!.session.jar.getCookies(`${fake.endpoints.web}/`)).map((c) => c.key)).toContain('thSessionId');
    expect(linkedIcaAccount(db, user.id)).toMatchObject({ account: { id: r.icaAccountId }, web: { lastOkAt: NOW.toISOString() } });
  });

  it('keeps an existing profile row and replaces the stored session on re-enrolment', async () => {
    db.insert(schema.userProfile).values({ userId: user.id, createdAt: NOW.toISOString() }).run();
    const a = await storeWebSession({ session: await loggedInSession(), endpoints: fake.endpoints, db, cipher, user, now: () => NOW });
    const first = db.select().from(schema.icaSession).get()!;
    const later = new Date(NOW.getTime() + 60_000);
    const b = await storeWebSession({ session: await loggedInSession(), endpoints: fake.endpoints, db, cipher, user, now: () => later });
    expect(b.icaAccountId).toBe(a.icaAccountId);
    expect(db.select().from(schema.icaAccount).all()).toHaveLength(1);
    const rows = db.select().from(schema.icaSession).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(first.id);
    expect(rows[0]!.lastOkAt).toBe(later.toISOString());
    expect(db.select().from(schema.userProfile).get()).toMatchObject({ icaAccountId: a.icaAccountId });
  });

  it('refreshes displayName on re-enrolment, keeping the old one when ICA gives none', async () => {
    const a = await storeWebSession({ session: await loggedInSession(), endpoints: fake.endpoints, db, cipher, user, now: () => NOW });
    fake.opts.firstName = 'Renamed';
    await storeWebSession({ session: await loggedInSession(), endpoints: fake.endpoints, db, cipher, user, now: () => NOW });
    expect(db.select().from(schema.icaAccount).where(eq(schema.icaAccount.id, a.icaAccountId)).get()?.displayName).toBe('Renamed');
    fake.opts.firstName = undefined;
    await storeWebSession({ session: await loggedInSession(), endpoints: fake.endpoints, db, cipher, user, now: () => NOW });
    expect(db.select().from(schema.icaAccount).where(eq(schema.icaAccount.id, a.icaAccountId)).get()?.displayName).toBe('Renamed');
  });

  it("falls back to the hub user's name when ICA gives no first name", async () => {
    fake.opts.firstName = undefined;
    const r = await storeWebSession({ session: await loggedInSession(), endpoints: fake.endpoints, db, cipher, user, now: () => NOW });
    expect(db.select().from(schema.icaAccount).where(eq(schema.icaAccount.id, r.icaAccountId)).get()?.displayName).toBe('Hub User');
  });

  it('rejects loginState 0 and stores nothing', async () => {
    fake.opts.loginState = 0;
    await expect(storeWebSession({ session: await loggedInSession(), endpoints: fake.endpoints, db, cipher, user })).rejects.toThrow(IcaLoginRejected);
    expect(db.select().from(schema.icaSession).all()).toEqual([]);
    expect(db.select().from(schema.icaAccount).all()).toEqual([]);
  });

  it('rejects a jar without thSessionId', async () => {
    await expect(storeWebSession({ session: newSession(), endpoints: fake.endpoints, db, cipher, user })).rejects.toThrow(/no ica\.se session cookie/);
  });
});

describe('saveWebJarIfChanged / recordLoginState', () => {
  const LATER = new Date('2026-09-29T12:05:00.000Z');
  async function stored(): Promise<string> {
    return (await storeWebSession({ session: await loggedInSession(), endpoints: fake.endpoints, db, cipher, user, now: () => NOW })).icaAccountId;
  }
  const rowOf = () => db.select().from(schema.icaSession).all()[0]!;
  const load = (acc: string) => { const l = loadWebSession({ db, cipher, icaAccountId: acc })!; return { ...l, before: cookieFingerprint(l.session.jar) }; };
  const rotate = (l: ReturnType<typeof load>, v: string) => l.session.jar.setCookie(`icaRotated=${v}; Path=/`, `${fake.endpoints.web}/`);

  it('the fingerprint ignores access times, so a used but unrotated jar is not written', async () => {
    const acc = await stored();
    const l = load(acc);
    await l.session.jar.getCookies(`${fake.endpoints.web}/`); // touches lastAccessed
    const before = rowOf();
    expect(await saveWebJarIfChanged({ db, cipher, row: l.row, session: l.session, before: l.before, web: fake.endpoints.web, now: LATER })).toBe(false);
    expect(rowOf()).toEqual(before);
  });

  it('writes a rotated jar back encrypted, never in clear', async () => {
    const acc = await stored();
    const l = load(acc);
    await rotate(l, FAKE_SECRETS.rotatedCookie);
    expect(await saveWebJarIfChanged({ db, cipher, row: l.row, session: l.session, before: l.before, web: fake.endpoints.web, now: LATER })).toBe(true);
    expect(rowOf().updatedAt).toBe(LATER.toISOString());
    expect(cipher.decrypt(rowOf().stateEnc)).toContain(FAKE_SECRETS.rotatedCookie);
    expect(JSON.stringify(db.$client.prepare('select * from ica_session').all())).not.toContain(FAKE_SECRETS.rotatedCookie);
  });

  const save = (l: ReturnType<typeof load>, o: { log?: { warn: (obj: object, msg: string) => void }; cipher?: typeof cipher } = {}) =>
    saveWebJarIfChanged({ db, cipher: o.cipher ?? cipher, row: l.row, session: l.session, before: l.before, web: fake.endpoints.web, now: LATER, ...(o.log ? { log: o.log } : {}) });
  const cookieOf = async (key: string) => {
    const jar = CookieJar.deserializeSync(JSON.parse(cipher.decrypt(rowOf().stateEnc)) as Parameters<typeof CookieJar.deserializeSync>[0]);
    return (await jar.getCookies(`${fake.endpoints.web}/`)).find((c) => c.key === key)?.value;
  };

  it('overlapping uses that rotate different cookies: both rotations are stored (merge on a CAS miss), logged with counts only', async () => {
    const acc = await stored();
    const a = load(acc); const b = load(acc);
    await a.session.jar.setCookie('rotA=A1; Path=/', `${fake.endpoints.web}/`);
    await b.session.jar.setCookie('rotB=B1; Path=/', `${fake.endpoints.web}/`);
    const warns: object[] = [];
    const log = { warn: (obj: object) => { warns.push(obj); } };
    expect(await save(a, { log })).toBe(true);
    expect(warns).toEqual([]);
    expect(await save(b, { log })).toBe(true);
    expect([await cookieOf('rotA'), await cookieOf('rotB'), await cookieOf('thSessionId')]).toEqual(['A1', 'B1', FAKE_SECRETS.thSessionId]);
    expect(warns).toEqual([
      { account: acc, changed: 1, removed: 0, event: 'jar-cas-miss' },
      { account: acc, changed: 1, removed: 0, event: 'jar-merged' },
    ]);
  });

  it('overlapping uses that rotate the same cookie: the later writer wins', async () => {
    const acc = await stored();
    const a = load(acc); const b = load(acc);
    await rotate(a, 'EARLIER'); await rotate(b, 'LATER');
    expect(await save(a)).toBe(true);
    expect(await save(b)).toBe(true);
    expect(await cookieOf('icaRotated')).toBe('LATER');
  });

  it('gives up (and warns) when the row is gone or changes again during the merge', async () => {
    const acc = await stored();
    const a = load(acc); const b = load(acc); const c = load(acc);
    await rotate(a, 'A'); await rotate(b, 'B'); await rotate(c, 'C');
    expect(await save(a)).toBe(true);
    const warns: object[] = [];
    const log = { warn: (obj: object) => { warns.push(obj); } };
    // Another writer lands between the merge's reload and its swap.
    let armed = true;
    const racing = { ...cipher, decrypt: (v: string) => { const out = cipher.decrypt(v); if (armed) { armed = false; db.update(schema.icaSession).set({ stateEnc: cipher.encrypt(out) }).run(); } return out; } };
    expect(await save(b, { log, cipher: racing })).toBe(false);
    expect(warns.map((w) => (w as { event: string }).event)).toEqual(['jar-cas-miss', 'jar-merge-gave-up']);
    db.delete(schema.icaSession).run();
    expect(await save(c, { log })).toBe(false);
    expect(warns.map((w) => (w as { event: string }).event).slice(2)).toEqual(['jar-cas-miss', 'jar-merge-gave-up']);
  });

  it('stores Max-Age as an absolute expiry, so a sliding Max-Age is persisted and a stored one still expires', async () => {
    const acc = await stored();
    const web = `${fake.endpoints.web}/`;
    const stored1 = () => (JSON.parse(cipher.decrypt(rowOf().stateEnc)) as { cookies: { key: string; expires?: string; maxAge?: unknown }[] }).cookies.find((c) => c.key === 'slide')!;
    const a = load(acc);
    await a.session.jar.setCookie('slide=V; Max-Age=60; Path=/', web);
    expect(await save(a)).toBe(true);
    expect(stored1().maxAge).toBeUndefined();
    const first = Date.parse(stored1().expires!);
    expect(first).toBeGreaterThan(Date.now() + 50_000);
    expect(first).toBeLessThan(Date.now() + 70_000);
    // Only sending the stored cookie changes nothing.
    const b = load(acc);
    await b.session.jar.getCookies(web);
    expect(await save(b)).toBe(false);
    // ICA sliding the same value's Max-Age is a change.
    const c = load(acc);
    await c.session.jar.setCookie('slide=V; Max-Age=3600; Path=/', web);
    expect(await save(c)).toBe(true);
    expect(Date.parse(stored1().expires!)).toBeGreaterThan(Date.now() + 3_500_000);
  });

  it('merge: a cookie this use lost is dropped only if the other writer left it unchanged', async () => {
    const acc = await stored();
    const web = `${fake.endpoints.web}/`;
    const gone = 'Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
    // The other writer rotated thSessionId: this use losing it must not delete theirs.
    const a = load(acc); const b = load(acc);
    await a.session.jar.setCookie(`thSessionId=ROTATED-BY-A; Path=/`, web);
    await b.session.jar.setCookie(`thSessionId=; ${gone}`, web);
    await b.session.jar.setCookie('rotB=B1; Path=/', web);
    expect(await save(a)).toBe(true);
    expect(await save(b)).toBe(true);
    expect([await cookieOf('thSessionId'), await cookieOf('rotB')]).toEqual(['ROTATED-BY-A', 'B1']);
    // The other writer left rotB alone: this use losing it deletes it.
    const c = load(acc); const d = load(acc);
    await c.session.jar.setCookie('rotC=C1; Path=/', web);
    await d.session.jar.setCookie(`rotB=; ${gone}`, web);
    expect(await save(c)).toBe(true);
    expect(await save(d)).toBe(true);
    expect([await cookieOf('rotB'), await cookieOf('rotC'), await cookieOf('thSessionId')]).toEqual([undefined, 'C1', 'ROTATED-BY-A']);
  });

  it('records the loginState and when it was checked', async () => {
    const acc = await stored();
    recordLoginState(db, load(acc).row.id, 1, LATER);
    expect(rowOf()).toMatchObject({ loginState: 1, loginStateAt: LATER.toISOString() });
    const later2 = new Date(LATER.getTime() + 1000);
    expect(recordLoginState(db, rowOf().id, null, later2)).toBe(true);
    expect(rowOf()).toMatchObject({ loginState: null, loginStateAt: later2.toISOString() });
  });

  it('never overwrites a state recorded after the observation started (compare-and-swap on loginStateAt)', async () => {
    const acc = await stored();
    const id = load(acc).row.id;
    recordLoginState(db, id, 1, LATER); // e.g. an app connect while a check was in flight
    const started = new Date(LATER.getTime() - 5000);
    expect(recordLoginState(db, id, 2, new Date(LATER.getTime() + 5000), started)).toBe(false);
    expect(rowOf()).toMatchObject({ loginState: 1, loginStateAt: LATER.toISOString() });
    expect(recordLoginState(db, id, 2, new Date(LATER.getTime() + 5000), LATER)).toBe(true); // started at (or after) it: written
    expect(rowOf()).toMatchObject({ loginState: 2 });
  });
});

describe('purchaseHistoryOf (the recorded flag, never inferred from elapsed time)', () => {
  const at = '2026-09-29T07:12:00.000Z';
  it('available only for a recorded loginState 2, with the time it was checked', () => {
    expect(purchaseHistoryOf({ loginState: 2, loginStateAt: at })).toEqual({ available: true, loginState: 2, checkedAt: at });
    expect(purchaseHistoryOf({ loginState: 1, loginStateAt: at })).toEqual({ available: false, loginState: 1, checkedAt: at });
    expect(purchaseHistoryOf({ loginState: 0, loginStateAt: at })).toEqual({ available: false, loginState: 0, checkedAt: at });
  });
  it('unknown (null) when never checked, the check was refused, or there is no web row', () => {
    expect(purchaseHistoryOf({ loginState: null, loginStateAt: at })).toEqual({ available: null, loginState: null, checkedAt: at });
    expect(purchaseHistoryOf({ loginState: null, loginStateAt: null })).toEqual({ available: null, loginState: null, checkedAt: null });
    expect(purchaseHistoryOf(undefined)).toEqual({ available: null, loginState: null, checkedAt: null });
  });
});
