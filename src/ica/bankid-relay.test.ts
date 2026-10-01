import { afterEach, describe, expect, it } from 'vitest';
import { BankidRelay, findAutoStartToken, RELAY_TIMEOUT_MS } from './bankid-relay.js';
import { FAKE_APP_CLIENT, FAKE_SECRETS, startFakeIca, startForeignHost, type FakeIca } from './test-fakes.js';

let fake: FakeIca | undefined;
let foreign: Awaited<ReturnType<typeof startForeignHost>> | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; await foreign?.close(); foreign = undefined; });

/** A clock that moves one second per poll, so the 900 ms /wait throttle never answers from cache. */
const ticking = () => { let t = 1_000_000; return () => (t += 1000); };

describe('BankidRelay (web flow)', () => {
  it('starts the ica.se authorize flow, relays QR codes, then launches, posts form1 and follows the redirect to thSessionId', async () => {
    fake = await startFakeIca({ pendingPolls: 2 });
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: ticking() });
    await relay.start('web');
    const q = fake.seen.authorizeQuery!;
    expect(Object.fromEntries(q)).toEqual({ client_id: 'ica.se', response_type: 'code', scope: 'openid ica-se-scope ica-se-scope-hard', prompt: 'login', redirect_uri: 'https://www.ica.se/logga-in/sso/callback' });
    expect(fake.seen.paths).toContain('/authn/authenticate/icase-bankid-qr');

    expect(await relay.poll()).toEqual({ state: 'pending', qr: 'bankid.fakeqr.1' });
    expect(await relay.poll()).toEqual({ state: 'pending', qr: 'bankid.fakeqr.2' });
    expect(await relay.poll()).toEqual({ state: 'complete' });
    expect(fake.seen.launchBody).toBe('_pollingDone=true');
    expect(new URLSearchParams(fake.seen.form1Body)).toEqual(new URLSearchParams({ token: FAKE_SECRETS.imsToken, state: FAKE_SECRETS.imsState }));
    const cookies = await relay.session.jar.getCookies(`${fake.endpoints.web}/`);
    expect(cookies.find((c) => c.key === 'thSessionId')?.value).toBe(FAKE_SECRETS.thSessionId);
    // terminal: no further ims calls
    const calls = fake.seen.waitCalls;
    expect(await relay.poll()).toEqual({ state: 'complete' });
    expect(fake.seen.waitCalls).toBe(calls);
  });

  it('records an autostart token under any of the candidate key names', async () => {
    fake = await startFakeIca({ autoStart: { where: 'message', key: 'autostarttoken', value: 'auto-1' } });
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: ticking() });
    await relay.start('web');
    expect(await relay.poll()).toEqual({ state: 'pending', qr: 'bankid.fakeqr.1', autoStartToken: 'auto-1' });
    expect(findAutoStartToken({ autoStartToken: 'a' })).toBe('a');
    expect(findAutoStartToken({ autostartToken: 'b' })).toBe('b');
    expect(findAutoStartToken({ message: { autoStartToken: 'c' } })).toBe('c');
    expect(findAutoStartToken({ message: { qrCode: 'x' } })).toBeUndefined();
    expect(findAutoStartToken({ autoStartToken: 42 })).toBeUndefined();
  });

  it('fails after 3 minutes without a scan', async () => {
    fake = await startFakeIca({ pendingPolls: 1000 });
    let t = 1_000_000;
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: () => t });
    await relay.start('web');
    expect((await relay.poll()).state).toBe('pending');
    t += RELAY_TIMEOUT_MS + 1;
    const r = await relay.poll();
    expect(r).toEqual({ state: 'failed', reason: 'BankID was not completed within 3 minutes' });
    const calls = fake.seen.waitCalls;
    expect(await relay.poll()).toEqual(r);
    expect(fake.seen.waitCalls).toBe(calls);
  });

  it('fails when ims stops sending QR codes', async () => {
    fake = await startFakeIca({ waitBroken: true });
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: ticking() });
    await relay.start('web');
    expect(await relay.poll()).toEqual({ state: 'failed', reason: 'ICA sent no QR code (HTTP 200)' });
  });

  it('fails to start when ims rejects the BankID start', async () => {
    fake = await startFakeIca();
    const relay = new BankidRelay({ endpoints: { ...fake.endpoints, ims: `${fake.endpoints.ims}/nope` } });
    await expect(relay.start('web')).rejects.toThrow(/BankID start: HTTP 404/);
  });

  it('refuses to poll before start', async () => {
    fake = await startFakeIca();
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: ticking() });
    expect(await relay.poll()).toEqual({ state: 'failed', reason: 'not started' });
  });

  it('answers from the last pending result when polled again within 900 ms', async () => {
    fake = await startFakeIca({ pendingPolls: 10 });
    let t = 1_000_000;
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: () => t });
    await relay.start('web');
    expect(await relay.poll()).toEqual({ state: 'pending', qr: 'bankid.fakeqr.1' });
    t += 899;
    expect(await relay.poll()).toEqual({ state: 'pending', qr: 'bankid.fakeqr.1' });
    expect(fake.seen.waitCalls).toBe(1);
    t += 1;
    expect(await relay.poll()).toEqual({ state: 'pending', qr: 'bankid.fakeqr.2' });
    expect(fake.seen.waitCalls).toBe(2);
  });
});

describe('BankidRelay: the ims token/state never leave ICA', () => {
  const runToEnd = async (relay: BankidRelay) => { let r; do r = await relay.poll(); while (r.state === 'pending'); return r; };

  it('refuses a form1 action on a foreign origin, without contacting it', async () => {
    foreign = await startForeignHost();
    fake = await startFakeIca({ pendingPolls: 0, form1Action: `${foreign.url}/x` });
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: ticking() });
    await relay.start('web');
    expect(await runToEnd(relay)).toEqual({ state: 'failed', reason: 'BankID launch: the login form posts to an unexpected host' });
    expect(foreign.hits).toEqual([]);
    expect(fake.seen.form1Body).toBeUndefined();
  });

  it('refuses an unresolvable form1 host the same way (checked before any request)', async () => {
    fake = await startFakeIca({ pendingPolls: 0, form1Action: 'http://evil.invalid/x' });
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: ticking() });
    await relay.start('web');
    expect(await runToEnd(relay)).toEqual({ state: 'failed', reason: 'BankID launch: the login form posts to an unexpected host' });
  });

  it('refuses a form1 redirect to a foreign origin', async () => {
    foreign = await startForeignHost();
    fake = await startFakeIca({ pendingPolls: 0, doneLocation: `${foreign.url}/steal?code=1` });
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: ticking() });
    await relay.start('web');
    expect(await runToEnd(relay)).toEqual({ state: 'failed', reason: 'BankID login: redirected to an unexpected host' });
    expect(foreign.hits).toEqual([]);
  });

  it('refuses a later redirect hop to a foreign origin', async () => {
    foreign = await startForeignHost();
    fake = await startFakeIca({ pendingPolls: 0, callbackLocation: `${foreign.url}/later` });
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: ticking() });
    await relay.start('web');
    expect(await runToEnd(relay)).toEqual({ state: 'failed', reason: 'BankID login: redirected to an unexpected host' });
    expect(foreign.hits).toEqual([]);
  });

  it('requires the chain to end on the web host', async () => {
    fake = await startFakeIca({ pendingPolls: 0 });
    // ims and web are distinct origins here: localhost vs 127.0.0.1 on the same fake server
    const ims = fake.endpoints.ims.replace('127.0.0.1', 'localhost');
    const relay = new BankidRelay({ endpoints: { ...fake.endpoints, ims, web: fake.endpoints.web }, now: ticking() });
    fake.opts.doneLocation = `${ims}/landing-on-ims`;
    fake.opts.form1Action = `${ims}/authn/authenticate/icase-bankid-qr/done%3Fsid=1`;
    await relay.start('web');
    expect(await runToEnd(relay)).toEqual({ state: 'failed', reason: 'BankID login: did not end on www.ica.se' });
  });

  it('gives up after 10 redirect hops', async () => {
    fake = await startFakeIca({ pendingPolls: 0, callbackLocation: '/logga-in/sso/callback' });
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: ticking() });
    await relay.start('web');
    expect(await runToEnd(relay)).toEqual({ state: 'failed', reason: 'BankID login: too many redirects' });
  });
});

describe('BankidRelay (app flow: the ICA app OAuth client via BankID)', () => {
  const runToEnd = async (relay: BankidRelay) => { let r; do r = await relay.poll(); while (r.state === 'pending'); return r; };

  it('registers a DCR client, authorizes with PKCE and no acr, relays BankID and exchanges the icacurity://app code', async () => {
    fake = await startFakeIca({ pendingPolls: 1 });
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: ticking() });
    await relay.start('app');
    const q = Object.fromEntries(fake.seen.authorizeQuery!);
    expect(q).toMatchObject({ client_id: FAKE_APP_CLIENT.client_id, scope: FAKE_APP_CLIENT.scope, redirect_uri: 'icacurity://app', response_type: 'code', code_challenge_method: 'S256', prompt: 'login' });
    expect(q).not.toHaveProperty('acr');
    expect(q.code_challenge).toMatch(/^[\w-]{43}$/);
    expect(fake.seen.paths).toContain('/authn/authenticate'); // the chooser, where BankID QR lives
    expect(await relay.poll()).toEqual({ state: 'pending', qr: 'bankid.fakeqr.1' });
    expect(await relay.poll()).toEqual({ state: 'complete' });
    expect(fake.seen.tokenGrants).toEqual(['client_credentials', 'authorization_code']);
    expect(fake.seen.paths).not.toContain('/logga-in/sso/callback');
    const app = relay.takeAppState()!;
    expect(app.client).toEqual(FAKE_APP_CLIENT);
    expect(app.token).toMatchObject({ access_token: FAKE_SECRETS.appAccessToken, refresh_token: FAKE_SECRETS.appRefreshToken, expires_in: 1800, token_type: 'Bearer' });
    expect(relay.takeAppState()).toBeUndefined(); // handed over once
  });

  it('fails with a clear reason when the chain ends on www.ica.se instead of icacurity://app (without fetching it)', async () => {
    fake = await startFakeIca({ pendingPolls: 0 });
    const ims = fake.endpoints.ims.replace('127.0.0.1', 'localhost');
    fake.opts.form1Action = `${ims}/authn/authenticate/icase-bankid-qr/done%3Fsid=1`;
    fake.opts.doneLocation = `${ims}/oauth/v2/authorize/continue`;
    fake.opts.appFinalLocation = `${fake.endpoints.web}/logga-in/sso/callback?code=c1`;
    const relay = new BankidRelay({ endpoints: { ...fake.endpoints, ims }, now: ticking() });
    await relay.start('app');
    expect(await runToEnd(relay)).toEqual({ state: 'failed', reason: 'app login did not return an app code (ICA may not allow BankID for the app client)' });
    expect(fake.seen.paths).not.toContain('/logga-in/sso/callback');
    expect(fake.seen.tokenGrants).toEqual(['client_credentials']);
    expect(relay.takeAppState()).toBeUndefined();
  });

  it('fails the same way when the chain just stops on ims', async () => {
    fake = await startFakeIca({ pendingPolls: 0, appFinalLocation: '/' });
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: ticking() });
    await relay.start('app');
    expect(await runToEnd(relay)).toEqual({ state: 'failed', reason: 'app login did not return an app code (ICA may not allow BankID for the app client)' });
  });

  it('refuses a hop to a foreign origin, without contacting it', async () => {
    foreign = await startForeignHost();
    fake = await startFakeIca({ pendingPolls: 0 });
    fake.opts.appFinalLocation = `${foreign.url}/steal?code=${FAKE_SECRETS.appCode}`;
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: ticking() });
    await relay.start('app');
    expect(await runToEnd(relay)).toEqual({ state: 'failed', reason: 'BankID login: redirected to an unexpected host' });
    expect(foreign.hits).toEqual([]);
    expect(fake.seen.tokenGrants).toEqual(['client_credentials']);
  });

  it('refuses an app code whose state does not match', async () => {
    fake = await startFakeIca({ pendingPolls: 0, appFinalLocation: `icacurity://app?code=${FAKE_SECRETS.appCode}&state=forged` });
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: ticking() });
    await relay.start('app');
    expect(await runToEnd(relay)).toEqual({ state: 'failed', reason: 'app login: state mismatch' });
    expect(fake.seen.tokenGrants).toEqual(['client_credentials']);
  });

  it('fails to start when the DCR bootstrap is refused', async () => {
    fake = await startFakeIca();
    const relay = new BankidRelay({ endpoints: fake.endpoints, now: ticking(), appDcrSecret: 'wrong' });
    await expect(relay.start('app')).rejects.toThrow(/app client registration: HTTP 401 from token/);
    expect(fake.seen.paths).not.toContain('/authn/authenticate/icase-bankid-qr');
  });
});
