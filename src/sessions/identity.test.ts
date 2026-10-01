import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, openDb, schema, type Db } from '../db/index.js';
import { createCipher } from '../crypto.js';
import { fakeAppState, fakeJwt, fakeLoggedInSession, startFakeIca, type FakeIca } from '../ica/test-fakes.js';
import { seedUser } from '../test-helpers.js';
import { disconnectIcaAccount, linkedIcaAccount, recordLoginState, storeWebSession } from './web-store.js';
import { storeAppSession } from './app-store.js';
import { DifferentIcaPerson, assertSameIcaPerson } from './identity.js';

const cipher = createCipher(Buffer.alloc(32, 7));
const user = { id: 'u1', name: 'U' };
let db: Db; let fake: FakeIca;
beforeEach(async () => { db = openDb(':memory:'); fake = await startFakeIca({ pendingPolls: 0 }); seedUser(db, user.id); });
afterEach(async () => { closeDb(db); await fake.close(); });

const enrolWeb = async () => storeWebSession({ session: await fakeLoggedInSession(fake), endpoints: fake.endpoints, db, cipher, user });
const account = (id: string) => db.select().from(schema.icaAccount).where(eq(schema.icaAccount.id, id)).get()!;
const sessions = () => db.select().from(schema.icaSession).all();
const webState = () => sessions().find((r) => r.kind === 'web')!.stateEnc;

describe('assertSameIcaPerson', () => {
  const none = { webSubjectHash: null, appSubjectHash: null };
  it('accepts a first subject, the same subject, or no subject at all', () => {
    expect(() => assertSameIcaPerson('web', 'h1', none)).not.toThrow();
    expect(() => assertSameIcaPerson('web', 'h1', { ...none, webSubjectHash: 'h1' })).not.toThrow();
    expect(() => assertSameIcaPerson('web', undefined, { ...none, webSubjectHash: 'h1' })).not.toThrow();
  });
  it('refuses a different subject of the same kind', () => {
    expect(() => assertSameIcaPerson('web', 'h2', { ...none, webSubjectHash: 'h1' })).toThrow(DifferentIcaPerson);
    expect(() => assertSameIcaPerson('app', 'h2', { ...none, appSubjectHash: 'h1' })).toThrow(DifferentIcaPerson);
  });
  it('compares web against app only when the cross-check is on', () => {
    expect(() => assertSameIcaPerson('app', 'h2', { webSubjectHash: 'h1', appSubjectHash: null }, false)).not.toThrow();
    expect(() => assertSameIcaPerson('app', 'h2', { webSubjectHash: 'h1', appSubjectHash: null }, true)).toThrow(DifferentIcaPerson);
    expect(() => assertSameIcaPerson('app', 'h1', { webSubjectHash: 'h1', appSubjectHash: null }, true)).not.toThrow();
  });
  it('is off by default: the live web customerId and an app sub were never shown to be the same id', () => {
    expect(() => assertSameIcaPerson('app', 'h2', { webSubjectHash: 'h1', appSubjectHash: null })).not.toThrow();
  });
  it('says what happened without the subject or its hash', () => {
    const e = new DifferentIcaPerson('web');
    expect(e.kind).toBe('web');
    expect(e.message).toMatch(/different ICA account/);
    expect(e.message).toMatch(/Disconnect ICA account/);
  });
});

describe('web enrolment', () => {
  it('stores a keyed hash of the ICA subject, never the subject, and accepts the same person again', async () => {
    fake.opts.webSubject = 'CUST-1001';
    const { icaAccountId } = await enrolWeb();
    expect(account(icaAccountId).webSubjectHash).toBe(cipher.mac('ica-subject:CUST-1001'));
    expect(JSON.stringify(db.$client.prepare('select * from ica_account').all())).not.toContain('CUST-1001');
    await expect(enrolWeb()).resolves.toMatchObject({ icaAccountId });
  });

  it('hashes the numeric customerId of the live shape', async () => {
    fake.opts.webSubject = 98765432;
    const { icaAccountId } = await enrolWeb();
    expect(account(icaAccountId).webSubjectHash).toBe(cipher.mac('ica-subject:98765432'));
    fake.opts.webSubject = 98765433;
    await expect(enrolWeb()).rejects.toThrow(DifferentIcaPerson);
  });

  it('refuses a different ICA person and keeps the stored session', async () => {
    fake.opts.webSubject = 'CUST-1001';
    const { icaAccountId } = await enrolWeb();
    const before = webState();
    const hash = account(icaAccountId).webSubjectHash;
    fake.opts.webSubject = 'CUST-2002';
    await expect(enrolWeb()).rejects.toThrow(DifferentIcaPerson);
    await expect(enrolWeb()).rejects.toThrow(/different ICA account/);
    expect(webState()).toBe(before);
    expect(account(icaAccountId).webSubjectHash).toBe(hash);
  });

  it('cannot check when ICA gives no subject, and then allows re-enrolment', async () => {
    const { icaAccountId } = await enrolWeb();
    expect(account(icaAccountId).webSubjectHash).toBeNull();
    fake.opts.webSubject = 'CUST-2002';
    await expect(enrolWeb()).resolves.toMatchObject({ icaAccountId });
    expect(account(icaAccountId).webSubjectHash).toBe(cipher.mac('ica-subject:CUST-2002'));
  });

  it('keeps the stored hash when a later login gives no subject', async () => {
    fake.opts.webSubject = 'CUST-1001';
    const { icaAccountId } = await enrolWeb();
    fake.opts.webSubject = undefined;
    await enrolWeb();
    expect(account(icaAccountId).webSubjectHash).toBe(cipher.mac('ica-subject:CUST-1001'));
  });
});

describe('app access', () => {
  it('hashes the JWT sub of the app token and refuses another person; opaque tokens cannot be checked', async () => {
    const { icaAccountId } = await enrolWeb();
    storeAppSession({ db, cipher, userId: user.id, state: fakeAppState({ accessToken: fakeJwt({ sub: 'SUB-1' }) }) });
    expect(account(icaAccountId).appSubjectHash).toBe(cipher.mac('ica-subject:SUB-1'));
    expect(() => storeAppSession({ db, cipher, userId: user.id, state: fakeAppState({ accessToken: fakeJwt({ sub: 'SUB-2' }) }) })).toThrow(DifferentIcaPerson);
    expect(() => storeAppSession({ db, cipher, userId: user.id, state: fakeAppState({ accessToken: 'OPAQUE-TOKEN' }) })).not.toThrow();
    expect(account(icaAccountId).appSubjectHash).toBe(cipher.mac('ica-subject:SUB-1'));
  });

  it('a refused app login writes nothing: the app session and the web loginState stay', async () => {
    const { icaAccountId } = await enrolWeb();
    storeAppSession({ db, cipher, userId: user.id, state: fakeAppState({ accessToken: fakeJwt({ sub: 'SUB-1' }) }) });
    const web = sessions().find((r) => r.kind === 'web')!;
    recordLoginState(db, web.id, 2, new Date(Date.now() + 60_000));
    const before = sessions();
    const acc = account(icaAccountId);
    expect(() => storeAppSession({ db, cipher, userId: user.id, state: fakeAppState({ accessToken: fakeJwt({ sub: 'SUB-2' }) }), now: () => new Date(Date.now() + 120_000) })).toThrow(DifferentIcaPerson);
    expect(sessions()).toEqual(before);
    expect(account(icaAccountId)).toEqual(acc);
  });

  it('the web subject does not block app access while the cross-check is off', async () => {
    fake.opts.webSubject = 'CUST-1001';
    await enrolWeb();
    expect(() => storeAppSession({ db, cipher, userId: user.id, state: fakeAppState({ accessToken: fakeJwt({ sub: 'SUB-9' }) }) })).not.toThrow();
  });
});

describe('disconnect, then another person', () => {
  it('after a disconnect another ICA person can connect', async () => {
    fake.opts.webSubject = 'CUST-1001';
    await enrolWeb();
    expect(disconnectIcaAccount(db, user.id)).toEqual({ mode: 'deleted' });
    expect(linkedIcaAccount(db, user.id)).toBeUndefined();
    fake.opts.webSubject = 'CUST-2002';
    await expect(enrolWeb()).resolves.toBeTruthy();
  });
});
