import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, schema, type Db } from '../db/index.js';
import { createCipher } from '../crypto.js';
import { createEnrolments, EnrolmentBusy, ENROLMENT_TTL_MS } from './enrolment.js';
import { RELAY_TIMEOUT_MS } from '../ica/bankid-relay.js';
import { FAKE_SECRETS, fakeAppState, fakeJwt, fakeLoggedInSession, startFakeIca, type FakeIca } from '../ica/test-fakes.js';
import { storeWebSession } from './web-store.js';
import { loadAppSession, storeAppSession } from './app-store.js';
import { seedUser } from '../test-helpers.js';

const cipher = createCipher(Buffer.alloc(32, 7));
let db: Db; let fake: FakeIca; let t: number;
const alice = { id: 'alice', name: 'Alice' }; const bob = { id: 'bob', name: 'Bob' };
const make = () => createEnrolments({ db, cipher, endpoints: fake.endpoints, now: () => t });

beforeEach(async () => {
  db = openDb(':memory:'); fake = await startFakeIca({ pendingPolls: 1 }); t = 1_000_000;
  seedUser(db, alice.id, { name: alice.name }); seedUser(db, bob.id, { name: bob.name });
});
afterEach(async () => { closeDb(db); await fake.close(); });

describe('enrolments', () => {
  it('runs one BankID login to a stored web session and stays complete', async () => {
    const e = make();
    const en = await e.start(alice);
    expect(en.id).toMatch(/^[\w-]{22,}$/);
    expect(await en.poll()).toMatchObject({ state: 'pending', qr: 'bankid.fakeqr.1' });
    t += 1000;
    expect(await en.poll()).toEqual({ state: 'complete' });
    expect(await en.poll()).toEqual({ state: 'complete' });
    expect(db.select().from(schema.icaSession).all()).toHaveLength(1);
  });

  it('is owned by the user who started it', async () => {
    const e = make();
    const en = await e.start(alice);
    expect(e.get(en.id, alice.id)).toBe(en);
    expect(e.get(en.id, bob.id)).toBeUndefined();
    expect(e.get('no-such-id', alice.id)).toBeUndefined();
  });

  it('keeps at most one active enrolment per user: starting again replaces the old one', async () => {
    const e = make();
    const first = await e.start(alice);
    const other = await e.start(bob);
    const second = await e.start(alice);
    expect(second.id).not.toBe(first.id);
    expect(e.get(first.id, alice.id)).toBeUndefined();
    expect(e.get(second.id, alice.id)).toBe(second);
    expect(e.get(other.id, bob.id)).toBe(other);
    expect(e.size()).toBe(2);
  });

  it('expires enrolments after 5 minutes', async () => {
    const e = make();
    const en = await e.start(alice);
    t += ENROLMENT_TTL_MS - 1;
    expect(e.get(en.id, alice.id)).toBe(en);
    t += 2;
    expect(e.get(en.id, alice.id)).toBeUndefined();
    expect(e.size()).toBe(0);
  });

  it('fails (and stores nothing) when ICA rejects the login', async () => {
    fake.opts.loginState = 0;
    const en = await make().start(alice);
    await en.poll();
    t += 1000;
    expect(await en.poll()).toEqual({ state: 'failed', reason: 'ICA did not accept the login (HTTP 200, loginState 0)' });
    expect(db.select().from(schema.icaSession).all()).toEqual([]);
  });

  it('shares one in-flight poll between concurrent status requests', async () => {
    fake.opts.pendingPolls = 5;
    const en = await make().start(alice);
    const [a, b] = await Promise.all([en.poll(), en.poll()]);
    expect(a).toEqual(b);
    expect(fake.seen.waitCalls).toBe(1);
  });

  it('does not register an enrolment whose start failed', async () => {
    const e = createEnrolments({ db, cipher, endpoints: { ...fake.endpoints, ims: `${fake.endpoints.ims}/nope` }, now: () => t });
    await expect(e.start(alice)).rejects.toThrow(/BankID start/);
    expect(e.size()).toBe(0);
  });

  it('app flow: stores an encrypted app session on the already linked account', async () => {
    const e = make();
    const web = await e.start(alice);
    await web.poll(); t += 1000;
    expect(await web.poll()).toEqual({ state: 'complete' });
    const app = await e.start(alice, 'app');
    expect(app.flow).toBe('app');
    expect(e.get(web.id, alice.id)).toBeUndefined(); // still one enrolment per user
    await app.poll(); t += 1000;
    expect(await app.poll()).toEqual({ state: 'complete' });
    const rows = db.select().from(schema.icaSession).all();
    expect(rows.map((r) => r.kind).sort()).toEqual(['app', 'web']);
    const raw = JSON.stringify(db.$client.prepare('select * from ica_session').all());
    for (const s of [FAKE_SECRETS.appAccessToken, FAKE_SECRETS.appRefreshToken, FAKE_SECRETS.appClientSecret]) expect(raw).not.toContain(s);
  });

  it('app flow: fails (and stores nothing) when no ICA account is linked yet', async () => {
    const app = await make().start(alice, 'app');
    await app.poll(); t += 1000;
    expect(await app.poll()).toEqual({ state: 'failed', reason: 'Connect your ICA account with BankID first; app access is added to it' });
    expect(db.select().from(schema.icaSession).all()).toEqual([]);
  });

  it('fails with a clear reason when a re-enrolment is another ICA person', async () => {
    const e = make();
    fake.opts.webSubject = 'CUST-1001';
    const first = await e.start(alice);
    t += 1000; await first.poll(); t += 1000;
    expect(await first.poll()).toEqual({ state: 'complete' });
    fake.opts.webSubject = 'CUST-2002';
    const second = await e.start(alice);
    t += 1000; await second.poll(); t += 1000;
    expect(await second.poll()).toMatchObject({ state: 'failed', reason: expect.stringContaining('different ICA account') });
  });
});

describe('enrolments: hardening', () => {
  const registrations = () => fake.seen.paths.filter((p) => p === '/register').length;
  const linkWithApp = async (state = fakeAppState()) => {
    await storeWebSession({ session: await fakeLoggedInSession(fake), endpoints: fake.endpoints, db, cipher, user: alice });
    storeAppSession({ db, cipher, userId: alice.id, state });
  };
  const storedApp = () => {
    const accountId = db.select().from(schema.userProfile).all().find((p) => p.userId === alice.id)!.icaAccountId!;
    return loadAppSession({ db, cipher, icaAccountId: accountId });
  };

  it('refuses a second start for the same user while one is starting', async () => {
    const e = make();
    const [a, b] = await Promise.allSettled([e.start(alice), e.start(alice)]);
    const rejected = [a, b].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(EnrolmentBusy);
    await expect(e.start(alice)).resolves.toBeTruthy(); // free again once the first start finished
    await expect(Promise.all([e.start(bob), e.start(alice)])).resolves.toHaveLength(2); // other users are not blocked
  });

  it('frees the user again when a start fails', async () => {
    const e = createEnrolments({ db, cipher, endpoints: { ...fake.endpoints, ims: `${fake.endpoints.ims}/nope` }, now: () => t });
    await expect(e.start(alice)).rejects.toThrow(/BankID start/);
    await expect(e.start(alice)).rejects.toThrow(/BankID start/); // not EnrolmentBusy
  });

  it('reuses the stored app client on reconnect instead of registering a new one', async () => {
    await linkWithApp();
    const before = registrations();
    await make().start(alice, 'app');
    expect(registrations()).toBe(before);
    expect(fake.seen.authorizeQuery?.get('client_id')).toBe(fakeAppState().client.client_id);
  });

  it('a reconnect with the reused client completes and stores the new tokens', async () => {
    await linkWithApp(fakeAppState({ accessToken: 'old-access', refreshToken: 'old-refresh' }));
    const app = await make().start(alice, 'app');
    await app.poll(); t += 1000;
    expect(await app.poll()).toEqual({ state: 'complete' });
    expect(storedApp()!.state.token.access_token).toBe(FAKE_SECRETS.appAccessToken);
    expect(storedApp()!.state.client.client_id).toBe(fakeAppState().client.client_id);
  });

  it('registers a new client when ICA no longer knows the stored one', async () => {
    const stale = fakeAppState();
    await linkWithApp({ ...stale, client: { ...stale.client, client_id: 'stale-client' } });
    fake.opts.rejectClientIds = ['stale-client'];
    const before = registrations();
    await make().start(alice, 'app');
    expect(registrations()).toBe(before + 1);
  });

  it('a stored client refused at the token exchange fails that login, keeps the old session, and is not reused again', async () => {
    const stale = fakeAppState({ accessToken: 'old-access' });
    await linkWithApp({ ...stale, client: { ...stale.client, client_secret: 'rotated-at-ica' } });
    const e = make();
    const before = registrations();
    const first = await e.start(alice, 'app');
    expect(registrations()).toBe(before); // authorize accepted the stored client_id
    await first.poll(); t += 1000;
    expect(await first.poll()).toMatchObject({ state: 'failed' });
    expect(storedApp()!.state.token.access_token).toBe('old-access'); // the working session is untouched
    const second = await e.start(alice, 'app');
    expect(registrations()).toBe(before + 1); // a fresh client this time
    await second.poll(); t += 1000;
    expect(await second.poll()).toEqual({ state: 'complete' });
    expect(storedApp()!.state.client.client_secret).toBe(FAKE_SECRETS.appClientSecret);
  });

  it('a failed app reconnect keeps the stored app session', async () => {
    await linkWithApp(fakeAppState({ accessToken: 'old-access' }));
    fake.opts.appFinalLocation = 'icacurity://app?error=access_denied';
    const app = await make().start(alice, 'app');
    await app.poll(); t += 1000;
    expect(await app.poll()).toMatchObject({ state: 'failed' });
    expect(storedApp()!.state.token.access_token).toBe('old-access');
  });

  /** Runs one app login for `user` to its end (the fake's one pending /wait, then the rest). */
  const finish = async (en: { poll: () => Promise<{ state: string }> }) => { await en.poll(); t += 1000; return en.poll(); };
  const failures: [string, () => void][] = [
    ['an icacurity://app?error=invalid_client callback', () => { fake.opts.appFinalLocation = 'icacurity://app?error=invalid_client'; }],
    ['a start whose /wait yields no QR', () => { fake.opts.waitBroken = true; }],
    ['a 400 invalid_grant at the code exchange', () => { fake.opts.appFinalLocation = 'icacurity://app?code=not-the-code'; }],
  ];
  for (const [what, breakIt] of failures) {
    it(`${what} with the reused client makes the next start register a new client`, async () => {
      await linkWithApp(fakeAppState({ accessToken: 'old-access' }));
      const e = make();
      const before = registrations();
      breakIt();
      expect(await finish(await e.start(alice, 'app'))).toMatchObject({ state: 'failed' });
      expect(registrations()).toBe(before); // that attempt reused the stored client
      expect(storedApp()!.state.token.access_token).toBe('old-access');
      fake.opts.appFinalLocation = undefined; fake.opts.waitBroken = false;
      expect(await finish(await e.start(alice, 'app'))).toEqual({ state: 'complete' });
      expect(registrations()).toBe(before + 1);
    });
  }

  it('a BankID timeout keeps reusing the stored client', async () => {
    await linkWithApp();
    const e = make();
    const before = registrations();
    const first = await e.start(alice, 'app');
    t += RELAY_TIMEOUT_MS + 1;
    expect(await first.poll()).toEqual({ state: 'failed', reason: 'BankID was not completed within 3 minutes' });
    await e.start(alice, 'app');
    expect(registrations()).toBe(before);
  });

  it('a cancelled (abandoned) login keeps reusing the stored client', async () => {
    await linkWithApp();
    const e = make();
    const before = registrations();
    await (await e.start(alice, 'app')).poll(); // the QR was shown, then the user left the page
    await e.start(alice, 'app');
    expect(registrations()).toBe(before);
  });

  it('a refused client is remembered per ICA account: another member of the household does not retry it', async () => {
    await linkWithApp();
    const accountOf = (id: string) => db.select().from(schema.userProfile).all().find((p) => p.userId === id)?.icaAccountId;
    db.insert(schema.userProfile).values({ userId: bob.id, icaAccountId: accountOf(alice.id)!, createdAt: new Date().toISOString() }).run(); // the household shares one ICA account
    expect(accountOf(bob.id)).toBe(accountOf(alice.id));
    const e = make();
    const before = registrations();
    fake.opts.appFinalLocation = 'icacurity://app?error=invalid_client';
    expect(await finish(await e.start(alice, 'app'))).toMatchObject({ state: 'failed' });
    fake.opts.appFinalLocation = undefined;
    await e.start(bob, 'app');
    expect(registrations()).toBe(before + 1);
  });

  it('an app login of another ICA person fails clearly but keeps reusing the stored client (the client was fine)', async () => {
    await linkWithApp(fakeAppState({ accessToken: fakeJwt({ sub: 'SUB-1' }) }));
    fake.app.accessToken = fakeJwt({ sub: 'SUB-2' }); // ICA issues a token of another person
    const e = make();
    const before = registrations();
    expect(await finish(await e.start(alice, 'app'))).toMatchObject({ state: 'failed', reason: expect.stringContaining('different ICA account') });
    expect(storedApp()!.state.token.access_token).toBe(fakeJwt({ sub: 'SUB-1' })); // nothing was written
    fake.app.accessToken = fakeJwt({ sub: 'SUB-1' });
    expect(await finish(await e.start(alice, 'app'))).toEqual({ state: 'complete' });
    expect(registrations()).toBe(before); // both attempts reused the stored client
  });

  it('isStarting reports a running start only', async () => {
    const e = make();
    const p = e.start(alice);
    expect(e.isStarting(alice.id)).toBe(true);
    expect(e.isStarting(bob.id)).toBe(false);
    await p;
    expect(e.isStarting(alice.id)).toBe(false);
  });
});
