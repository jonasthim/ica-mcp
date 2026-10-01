import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import type { Logger } from '../logger.js';
import { adminClient, startTestApp, TEST_PASSWORD as PASSWORD, type AdminClient, type TestCtx } from '../test-helpers.js';
import { FAKE_PROBE_ROUTES, FAKE_SECRETS, fakeLoggedInSession, startFakeIca, type FakeIca } from '../ica/test-fakes.js';
import { APP_SESSION_UNREADABLE } from '../ica/app-session.js';
import { WEB_SESSION_UNREADABLE } from '../ica/web-session.js';
import { storeAppSession } from '../sessions/app-store.js';
import { linkedIcaAccount, storeWebSession } from '../sessions/web-store.js';
import { NeedsAppReconnect } from '../sessions/errors.js';
import { appKeeper } from '../server.js';
import { s } from './i18n.js';

let t: TestCtx; let fake: FakeIca;
let alice: AdminClient; let bob: AdminClient;

const signIn = async (email: string): Promise<AdminClient> => {
  const c = adminClient(t);
  expect((await c.signIn(email)).status).toBe(302);
  return c;
};
const get = (path: string, c: AdminClient) => c.get(path);
const post = (path: string, c: AdminClient, origin = t.url) => c.post(path, {}, { origin });
type Status = { state: string; qrSvg?: string; autoStartUrl?: string; reason?: string };
const status = async (path: string, c: AdminClient): Promise<Status> => (await (await get(`${path}/status`, c)).json()) as Status;
const audited = (action: string) => t.db.select().from(schema.auditEvent).all().filter((e) => e.action === action);

beforeAll(async () => {
  fake = await startFakeIca({ pendingPolls: 1, routes: FAKE_PROBE_ROUTES, autoStart: { where: 'message', key: 'autoStartToken', value: 'auto&tok' } });
  t = await startTestApp({}, { icaEndpoints: fake.endpoints });
  for (const [email, name] of [['alice@example.com', 'Alice'], ['bob@example.com', 'Bob']] as const) {
    await t.auth.api.createUser({ body: { email, password: PASSWORD, name, role: 'member' } });
  }
  alice = await signIn('alice@example.com'); bob = await signIn('bob@example.com');
});
afterAll(async () => { await t.close(); await fake.close(); });

describe('/admin/ica', () => {
  it('requires a session', async () => {
    for (const path of ['/admin/ica', '/admin/ica/connect/x', '/admin/ica/connect/x/status', '/admin/ica/diagnostics']) {
      const r = await fetch(`${t.url}${path}`, { redirect: 'manual' });
      expect(r.status, path).toBe(302);
      expect(r.headers.get('location'), path).toMatch(/^\/admin\/login\?next=/);
    }
    const anonymous = adminClient(t); // a valid CSRF token, but no session
    for (const path of ['/admin/ica/connect', '/admin/ica/connect-app']) {
      const p = await anonymous.post(path);
      expect(p.status, path).toBe(302);
      expect(p.headers.get('location'), path).toMatch(/^\/admin\/login\?next=/);
    }
  });

  it('is linked from the home page and offers Connect with BankID before an account is linked', async () => {
    expect(await (await get('/admin', alice)).text()).toContain('href="/admin/ica"');
    const html = await (await get('/admin/ica', alice)).text();
    expect(html).toContain('No ICA account connected yet');
    expect(html).toMatch(/<form method="post" action="\/admin\/ica\/connect"><input type="hidden" name="_csrf" value="[^"]*"><button class="btn btn-primary" type="submit">Connect with BankID<\/button>/);
    expect(html).toContain('href="/admin/ica/diagnostics"');
  });

  it('rejects a cross-origin connect', async () => {
    const r = await post('/admin/ica/connect', alice, 'https://evil.example');
    expect(r.status).toBe(403);
    expect(fake.seen.authorizeQuery).toBeUndefined();
  });

  it('answers 404 for an unknown enrolment', async () => {
    expect((await get('/admin/ica/connect/nope', alice)).status).toBe(404);
    const r = await get('/admin/ica/connect/nope/status', alice);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ state: 'failed', reason: 'This BankID login has expired. Start again.' });
  });

  it('connects: QR page, pending with an SVG QR and autostart link, then complete and a stored, encrypted session', async () => {
    const start = await post('/admin/ica/connect', alice);
    expect(start.status).toBe(303);
    const page = start.headers.get('location')!;
    expect(page).toMatch(/^\/admin\/ica\/connect\/[\w-]{22,}$/);

    const qrPage = await get(page, alice);
    const html = await qrPage.text();
    expect(html).toContain(`data-status="${page}/status"`);
    expect(html).toMatch(/<img id="qr"[^>]*>/);
    expect(html).toContain('Open BankID on this device');
    // the poller is the hashed qr.js module carrying this response's CSP nonce, never an inline script
    const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(qrPage.headers.get('content-security-policy') ?? '')?.[1];
    const qrModule = /<script type="module" src="\/admin\/assets\/qr\.[0-9a-f]{10}\.js" nonce="([^"]+)"><\/script>/.exec(html);
    expect(nonce).toBeTruthy();
    expect(qrModule?.[1]).toBe(nonce);
    expect(html).not.toMatch(/<script\b[^>]*>[^<]+<\/script>/);

    // someone else's enrolment does not exist for Bob
    expect((await get(page, bob)).status).toBe(404);
    expect((await get(`${page}/status`, bob)).status).toBe(404);

    const s1 = await status(page, alice);
    expect(s1.state).toBe('pending');
    expect(s1.qrSvg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    expect(s1.autoStartUrl).toBe('bankid:///?autostarttoken=auto%26tok&redirect=null');
    // polled again at once: answered from the last /wait, ICA is not asked again
    const calls = fake.seen.waitCalls;
    const r2 = await get(`${page}/status`, alice);
    expect(r2.headers.get('cache-control')).toBe('no-store');
    expect(((await r2.json()) as Status).state).toBe('pending');
    expect(fake.seen.waitCalls).toBe(calls);
    await new Promise((r) => setTimeout(r, 950));
    expect(await status(page, alice)).toEqual({ state: 'complete' });
    expect(await status(page, alice)).toEqual({ state: 'complete' });
    // audited once, by the first poll that saw it complete; further polls add nothing
    expect(audited('ica.web_connected')).toHaveLength(1);
    await status(page, alice); await status(page, alice);
    expect(audited('ica.web_connected')).toHaveLength(1);
    expect(audited('ica.web_connected')[0]).toMatchObject({ outcome: 'success', ip: '127.0.0.1', detailsJson: '{}' });
    expect(audited('ica.web_connected')[0]!.actorUserId).toBe(t.db.select().from(schema.user).all().find((u) => u.email === 'alice@example.com')!.id);

    const after = await (await get('/admin/ica', alice)).text();
    expect(after).toContain('Reconnect with BankID');
    expect(after).toContain('Session expires');
    const home = await (await get('/admin', alice)).text();
    expect(home).toMatch(/ICA web session<\/h2><span class="badge badge--(ok|warn)"/);
    expect(home).not.toContain('Tomt i hyllorna');
    for (const s of Object.values(FAKE_SECRETS).filter((v) => v !== FAKE_SECRETS.firstName)) expect(after).not.toContain(s);

    const rows = t.db.select().from(schema.icaSession).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stateEnc).not.toContain(FAKE_SECRETS.thSessionId);
    expect(JSON.stringify(t.db.$client.prepare('select * from ica_session').all())).not.toContain(FAKE_SECRETS.thSessionId);
    // Bob is still unlinked
    expect(await (await get('/admin/ica', bob)).text()).toContain('No ICA account connected yet');
  });

  it('shows purchase history as available after the web login, with the time it was checked', async () => {
    const html = await (await get('/admin/ica', alice)).text();
    const at = t.db.select().from(schema.icaSession).all().find((r) => r.kind === 'web')!.loginStateAt!;
    expect(html).toContain(`<dt>Purchase history</dt><dd>Available when checked · <time datetime="${at}"`);
  });

  it('shows purchase history as not checked yet when the recorded state is unknown', async () => {
    const web = t.db.select().from(schema.icaSession).all().find((r) => r.kind === 'web')!;
    t.db.update(schema.icaSession).set({ loginState: null, loginStateAt: null }).where(eq(schema.icaSession.id, web.id)).run();
    try {
      expect(await (await get('/admin/ica', alice)).text()).toContain('<dt>Purchase history</dt><dd>Not checked yet</dd>');
    } finally {
      t.db.update(schema.icaSession).set({ loginState: web.loginState, loginStateAt: web.loginStateAt }).where(eq(schema.icaSession.id, web.id)).run();
    }
  });

  it('shows an error page when ICA will not start a BankID login', async () => {
    const saved = { ...fake.endpoints };
    try {
      fake.endpoints.ims = `${saved.ims}/down`;
      const r = await post('/admin/ica/connect', bob);
      expect(r.status).toBe(502);
      expect(await r.text()).toContain('Could not start a BankID login with ICA');
    } finally { Object.assign(fake.endpoints, saved); }
  });

  it('diagnostics asks to connect first when no account is linked', async () => {
    const r = await get('/admin/ica/diagnostics', bob);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Connect your ICA account first');
  });

  it('diagnostics probes the stored session and renders statuses, response shapes (never values) and list ids', async () => {
    const before = t.db.select().from(schema.icaSession).get()!;
    await new Promise((r) => setTimeout(r, 5));
    const html = await (await get('/admin/ica/diagnostics', alice)).text();
    for (const name of ['user-information', 'web-list-all', 'web-article-search', 'mobile-shoppinglists', 'mobile-store-favorites', 'mobile-store-detail', 'mobile-store-offers', 'mobile-bonus', 'mobile-product-ean', 'purchase-month-summaries', 'purchase-latest-month']) {
      expect(html).toContain(`<td data-label="Probe">${name}</td>`);
    }
    expect(html).toContain('<td data-label="HTTP">451</td>');
    expect(html).toContain('list-shared-1');
    expect(html).toContain('off-1');
    expect(html).toContain('{&quot;loginState&quot;:2}');
    expect(html).toContain('object{monthSummaries: array[3] of object{year: number, month: number, total: number}}');
    for (const s of [...Object.values(FAKE_SECRETS), '6035000011112222', 'partner@example.se']) expect(html).not.toContain(s);
    // store names, amounts, dates, list names and row text are not rendered — only keys and types
    for (const v of ['Veckohandling', 'Mjölk', 'Fest', 'ICA Fake', 'Kaffe', '2026-08', '1000', '12.5', '12345']) expect(html).not.toContain(v);
    const after = t.db.select().from(schema.icaSession).get()!;
    expect(after.stateEnc).toBe(before.stateEnc);
    expect(after.lastOkAt! > before.lastOkAt!).toBe(true);
    const runs = audited('ica.diagnostics_run');
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0]!.detailsJson)).toEqual({ live: true });
  });

  it('diagnostics reports a session ICA no longer accepts and records the error', async () => {
    fake.opts.loginState = 0;
    try {
      const html = await (await get('/admin/ica/diagnostics', alice)).text();
      expect(html).toContain('The stored ICA session is no longer logged in');
      expect(t.db.select().from(schema.icaSession).get()!.lastError).toBe('ICA session is no longer logged in');
      expect(await (await get('/admin/ica', alice)).text()).toMatch(/<dt>Last error<\/dt><dd[^>]*>ICA session is no longer logged in<\/dd>/);
    } finally { fake.opts.loginState = 2; }
  });

  it('diagnostics explains a stored session that cannot be decrypted', async () => {
    const row = t.db.select().from(schema.icaSession).get()!;
    t.db.$client.prepare('update ica_session set state_enc = ? where id = ?').run('v1.AAAA.AAAA.AAAA', row.id);
    try {
      expect(await (await get('/admin/ica/diagnostics', alice)).text()).toContain('cannot be decrypted');
      expect(t.db.select().from(schema.icaSession).get()!.lastError).toBe(WEB_SESSION_UNREADABLE);
      expect(await (await get('/admin', alice)).text()).toContain('ICA web session</h2><span class="badge badge--bad">Needs reconnect</span>');
      expect(await (await get('/admin/ica', alice)).text()).toContain('ICA web session</h2><span class="badge badge--bad">Needs reconnect</span>');
    } finally { t.db.$client.prepare('update ica_session set state_enc = ?, last_error = null where id = ?').run(row.stateEnc, row.id); }
  });

  it('diagnostics renders the element shapes table, keys and types only', async () => {
    const html = await (await get('/admin/ica/diagnostics', alice)).text();
    expect(html).toContain('<caption>Element shapes</caption>');
    expect(html).toContain('<code>(whole answer)</code>');
    expect(html).toContain('object{year: number, month: number, total: number}');
    for (const v of [...Object.values(FAKE_SECRETS), 'Veckohandling', 'Mjölk', 'ICA Fake']) expect(html).not.toContain(v);
  });

  it('diagnostics records a geo-block as such, not as a logout', async () => {
    fake.opts.userInfo = { status: 451, body: {} };
    try {
      const html = await (await get('/admin/ica/diagnostics', alice)).text();
      expect(html).toContain('Could not check the ICA session (geo-blocked (451))');
      expect(html).not.toContain('no longer logged in');
      expect(t.db.select().from(schema.icaSession).get()!.lastError).toBe('geo-blocked (451)');
    } finally { fake.opts.userInfo = undefined; }
  });

  it('diagnostics records the loginState user information reported: nothing on a 500, unknown (null) on a 401', async () => {
    const web = () => t.db.select().from(schema.icaSession).all().find((r) => r.kind === 'web')!;
    fake.opts.loginState = 1;
    try {
      await get('/admin/ica/diagnostics', alice);
      expect(web()).toMatchObject({ loginState: 1 });
      expect(web().loginStateAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      fake.opts.userInfo = { status: 500, body: {} };
      await get('/admin/ica/diagnostics', alice);
      expect(web()).toMatchObject({ loginState: 1 });
      const checkedAt = web().loginStateAt;
      fake.opts.userInfo = { status: 401, body: {} };
      await new Promise((r) => setTimeout(r, 5));
      await get('/admin/ica/diagnostics', alice);
      expect(web()).toMatchObject({ loginState: null, lastError: 'ICA session is no longer logged in' });
      expect(web().loginStateAt).not.toBe(checkedAt);
    } finally { fake.opts.loginState = 2; fake.opts.userInfo = undefined; }
  });

  it('diagnostics writes rotated ICA cookies back to the stored session', async () => {
    const before = t.db.select().from(schema.icaSession).all().find((r) => r.kind === 'web')!.stateEnc;
    fake.opts.rotateCookie = true;
    try {
      await get('/admin/ica/diagnostics', alice);
      expect(t.db.select().from(schema.icaSession).all().find((r) => r.kind === 'web')!.stateEnc).not.toBe(before);
    } finally { fake.opts.rotateCookie = false; }
  });

  it('limits BankID starts per user: the 11th within 15 minutes answers 429', async () => {
    await t.auth.api.createUser({ body: { email: 'dave@example.com', password: PASSWORD, name: 'Dave', role: 'member' } });
    const dave = await signIn('dave@example.com');
    for (let i = 0; i < 10; i++) expect((await post('/admin/ica/connect', dave)).status).toBe(303);
    const r = await post('/admin/ica/connect', dave);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await r.text()).toContain('Too many BankID logins started');
    expect((await post('/admin/ica/connect', bob)).status).toBe(303); // other users are not affected
  });

  it('a second start while one is starting goes back to the ICA page with a message, and is not counted by the limit', async () => {
    await t.auth.api.createUser({ body: { email: 'erin@example.com', password: PASSWORD, name: 'Erin', role: 'member' } });
    const erin = await signIn('erin@example.com');
    let release!: () => void;
    fake.opts.holdAuthorize = new Promise<void>((r) => { release = r; });
    const authorizes = () => fake.seen.paths.filter((p) => p === '/oauth/v2/authorize').length;
    const before = authorizes();
    try {
      const first = post('/admin/ica/connect', erin);
      while (authorizes() === before) await new Promise((r) => setTimeout(r, 5)); // the first start is at ICA now
      for (let i = 0; i < 12; i++) {
        const again = await post('/admin/ica/connect', erin);
        expect(again.status).toBe(303);
        expect(again.headers.get('location')).toBe('/admin/ica');
      }
      const html = await (await get('/admin/ica', erin)).text();
      expect(html).toContain('A BankID login is already starting');
      release();
      expect((await first).headers.get('location')).toMatch(/^\/admin\/ica\/connect\//);
    } finally { release(); fake.opts.holdAuthorize = undefined; }
    for (let i = 0; i < 9; i++) expect((await post('/admin/ica/connect', erin)).status).toBe(303); // 1 + 9 = 10 counted
    expect((await post('/admin/ica/connect', erin)).status).toBe(429);
  });

  it('says "1 minute" and "N minutes" in the limit message', () => {
    expect(s.ica.errors.tooMany(1)).toBe('Too many BankID logins started. Try again in 1 minute.');
    expect(s.ica.errors.tooMany(15)).toBe('Too many BankID logins started. Try again in 15 minutes.');
  });
});

describe('/admin/ica: experimental app access', () => {
  const APP_SECRETS = [FAKE_SECRETS.appAccessToken, FAKE_SECRETS.appRefreshToken, FAKE_SECRETS.appClientSecret, FAKE_SECRETS.appCode, FAKE_SECRETS.dcrToken];
  const appRow = () => t.db.select().from(schema.icaSession).all().find((r) => r.kind === 'app');

  it('needs a linked ICA account first', async () => {
    const html = await (await get('/admin/ica', bob)).text();
    expect(html).toContain('<h2>ICA app access</h2>');
    expect(html).not.toContain('action="/admin/ica/connect-app"');
    const r = await post('/admin/ica/connect-app', bob);
    expect(r.status).toBe(409);
    expect(await r.text()).toContain('Connect your ICA account with BankID first');
  });

  it('offers app access on the account page while not connected', async () => {
    const html = await (await get('/admin/ica', alice)).text();
    expect(html).toContain('<h2>ICA app access</h2>');
    expect(html).toMatch(/<h2>ICA app access<\/h2><span class="badge badge--neutral">Not connected<\/span>/);
    expect(html).toMatch(/<form method="post" action="\/admin\/ica\/connect-app"><input type="hidden" name="_csrf" value="[^"]*"><button class="btn btn-secondary" type="submit">Connect app access with BankID<\/button><\/form>/);
  });

  it('rejects a cross-origin connect-app', async () => {
    expect((await post('/admin/ica/connect-app', alice, 'https://evil.example')).status).toBe(403);
  });

  it('connects app access through the same QR page and status polling, storing the tokens encrypted', async () => {
    const start = await post('/admin/ica/connect-app', alice);
    expect(start.status).toBe(303);
    const page = start.headers.get('location')!;
    expect(page).toMatch(/^\/admin\/ica\/connect\/[\w-]{22,}$/);
    const html = await (await get(page, alice)).text();
    expect(html).toContain('Connect ICA app access');
    expect(html).toContain(`data-status="${page}/status"`);
    expect((await status(page, alice)).state).toBe('pending');
    await new Promise((r) => setTimeout(r, 950));
    expect(await status(page, alice)).toEqual({ state: 'complete' });
    await status(page, alice);
    expect(audited('ica.app_connected')).toHaveLength(1);

    const row = appRow()!;
    expect(row.expiresAt).not.toBeNull();
    const raw = JSON.stringify(t.db.$client.prepare('select * from ica_session').all());
    for (const s of APP_SECRETS) expect(raw).not.toContain(s);
    const after = await (await get('/admin/ica', alice)).text();
    expect(after).toContain(`<dt>Current token expires</dt><dd><time datetime="${row.expiresAt}"`);
    expect(after).toContain('Reconnect app access with BankID');
    for (const s of APP_SECRETS) expect(after).not.toContain(s);
  });

  it('connecting app access marks purchase history as needing a fresh BankID login', async () => {
    const html = await (await get('/admin/ica', alice)).text();
    expect(html).toMatch(/<dt>Purchase history<\/dt><dd>Needs a fresh BankID login · <time datetime=/);
    expect(html).toContain('Connecting app access ends purchase-history access');
  });

  it('diagnostics sends the app bearer to mobile/* and labels each row with the credential used', async () => {
    fake.opts.mobileAcceptsWebBearer = false;
    fake.seen.gatewayCalls.length = 0;
    try {
      const html = await (await get('/admin/ica/diagnostics', alice)).text();
      expect(html).toMatch(/<td data-label="Probe">mobile-bonus<\/td><td data-label="HTTP">200<\/td><td data-label="Auth">app bearer<\/td>/);
      expect(html).toMatch(/<td data-label="Probe">mobile-shoppinglists<\/td><td data-label="HTTP">200<\/td><td data-label="Auth">app bearer<\/td>/);
      expect(html).toMatch(/<td data-label="Probe">web-list-all<\/td><td data-label="HTTP">200<\/td><td data-label="Auth">web bearer<\/td>/);
      expect(html).toMatch(/<td data-label="Probe">purchase-month-summaries<\/td><td data-label="HTTP">200<\/td><td data-label="Auth">web cookie<\/td>/);
      expect(html).toContain('App access: mobile probes use the app token.');
      expect(fake.seen.gatewayCalls.filter((c) => c.includes('/mobile/')).every((c) => c.endsWith(' app'))).toBe(true);
      expect(fake.seen.gatewayCalls.filter((c) => !c.includes('/mobile/')).every((c) => c.endsWith(' web'))).toBe(true);
      for (const s of APP_SECRETS) expect(html).not.toContain(s);
    } finally { fake.opts.mobileAcceptsWebBearer = true; }
  });

  it('diagnostics marks app access as working after a successful mobile probe', async () => {
    const row = appRow()!;
    t.db.$client.prepare('update ica_session set last_ok_at = ? where id = ?').run('2000-01-01T00:00:00.000Z', row.id);
    await get('/admin/ica/diagnostics', alice);
    expect(appRow()!.lastOkAt! > '2000-01-01T00:00:00.000Z').toBe(true);
  });

  it("diagnostics gets the app token from the app's one keeper (appKeeper)", async () => {
    const spy = vi.spyOn(appKeeper(t.app), 'appToken');
    try {
      await get('/admin/ica/diagnostics', alice);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  it('diagnostics says app access is not connected when the app session vanished meanwhile', async () => {
    const spy = vi.spyOn(appKeeper(t.app), 'appToken').mockRejectedValueOnce(new NeedsAppReconnect('not-connected'));
    try {
      const html = await (await get('/admin/ica/diagnostics', alice)).text();
      expect(html).toContain('app access is not connected');
      expect(html).not.toContain('refused');
    } finally { spy.mockRestore(); }
  });

  it('diagnostics refreshes the app token first when it expires within 60 s', async () => {
    const row = appRow()!;
    t.db.$client.prepare('update ica_session set expires_at = ? where id = ?').run(new Date(Date.now() + 30_000).toISOString(), row.id);
    const rotations = fake.app.rotations;
    fake.seen.gatewayCalls.length = 0;
    await get('/admin/ica/diagnostics', alice);
    expect(fake.app.rotations).toBe(rotations + 1);
    expect(appRow()!.expiresAt! > new Date(Date.now() + 60_000).toISOString()).toBe(true);
    // 'app' means the bearer was the freshly rotated app access token (the fake compares against its current one).
    const mobile = fake.seen.gatewayCalls.filter((c) => c.includes('/mobile/'));
    expect(mobile.length).toBeGreaterThan(0);
    expect(mobile.filter((c) => !c.endsWith(' app'))).toEqual([]);
  });

  it('records an app session that cannot be decrypted, so Home and ICA ask for a reconnect', async () => {
    const row = appRow()!;
    t.db.$client.prepare('update ica_session set state_enc = ? where id = ?').run('v1.AAAA.AAAA.AAAA', row.id);
    try {
      expect(await (await get('/admin/ica/diagnostics', alice)).text()).toContain(APP_SESSION_UNREADABLE);
      expect(appRow()!.lastError).toBe(APP_SESSION_UNREADABLE);
      expect(await (await get('/admin', alice)).text()).toContain('ICA app access</h2><span class="badge badge--bad">Needs reconnect</span>');
      expect(await (await get('/admin/ica', alice)).text()).toContain('ICA app access</h2><span class="badge badge--bad">Needs reconnect</span>');
    } finally { t.db.$client.prepare('update ica_session set state_enc = ?, last_error = null where id = ?').run(row.stateEnc, row.id); }
  });

  it('diagnostics reports an expired app session, falls back to the web bearer and records the error', async () => {
    const row = appRow()!;
    t.db.$client.prepare('update ica_session set expires_at = ? where id = ?').run(new Date(Date.now() - 1000).toISOString(), row.id);
    fake.opts.refreshInvalid = true;
    try {
      const html = await (await get('/admin/ica/diagnostics', alice)).text();
      expect(html).toContain('App access: app session expired — reconnect');
      expect(html).toMatch(/<td data-label="Probe">mobile-bonus<\/td><td data-label="HTTP">200<\/td><td data-label="Auth">web bearer<\/td>/);
      expect(appRow()!.lastError).toBe('app session expired — reconnect');
      expect(await (await get('/admin/ica', alice)).text()).toMatch(/ICA app access<\/h2><span class="badge badge--bad">Needs reconnect<\/span>[\s\S]*<dt>Last error<\/dt><dd class="err">app session expired — reconnect<\/dd>/);
    } finally { fake.opts.refreshInvalid = false; }
  });
});

describe('/admin/ica: diagnostics logging', () => {
  // External monitoring cannot see the admin page: it reads this journal line instead. A separate app instance with its own
  // fake logger, so the shared `t` app (used by every other test in this file) is left untouched.
  /** A fresh app instance with a hub user whose ICA web + app sessions are already stored (bypassing the BankID UI). */
  const connectedUser = async (log: Logger, email: string): Promise<{ t2: TestCtx; client: AdminClient }> => {
    const t2 = await startTestApp({}, { icaEndpoints: fake.endpoints, log });
    const { user } = await t2.auth.api.createUser({ body: { email, password: PASSWORD, name: email, role: 'member' } });
    await storeWebSession({ session: await fakeLoggedInSession(fake), endpoints: fake.endpoints, db: t2.db, cipher: t2.cipher, user: { id: user.id, name: email } });
    // Uses the fake's *current* app tokens (an earlier test in this file may already have rotated them), so the
    // gateway recognises the bearer as `app` and the mobile-* probes actually run.
    storeAppSession({
      db: t2.db, cipher: t2.cipher, userId: user.id,
      state: {
        client: { client_id: 'fake-app-client-1', client_secret: 'unused', scope: 'openid ica-app-scope' },
        token: { access_token: fake.app.accessToken, refresh_token: fake.app.refreshToken, expires_in: 1800, token_type: 'Bearer' },
        issuedAt: '',
      },
    });
    const client = adminClient(t2);
    expect((await client.signIn(email)).status).toBe(302);
    return { t2, client };
  };

  it('logs element, user-information and app-token shapes only, capped, with no seeded value ever appearing', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    // An answer wide enough (40 keys, as shape.ts's own MAX_KEYS test does) that its uncapped shape string would run
    // well past the 500-char cap, so the test proves the cap actually bites.
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`someRatherLongKeyName${i}`, { a: 1, b: 'x', c: [true] }]));
    const savedRoutes = fake.opts.routes;
    fake.opts.routes = { ...FAKE_PROBE_ROUTES, '/sverige/digx/mobile/bonusservice/v1/bonus/current': { status: 200, body: { vouchers: { used: [wide], active: [] } } } };
    let t2: TestCtx | undefined;
    try {
      const connected = await connectedUser(log, 'carol@example.com');
      t2 = connected.t2;
      expect((await connected.client.get('/admin/ica/diagnostics')).status).toBe(200);

      expect(log.info).toHaveBeenCalledTimes(1);
      const [payload, msg] = (log.info as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>, string];
      expect(msg).toBe('ica diagnostics');

      // the three fields are present
      expect(Array.isArray(payload.elements)).toBe(true);
      expect(typeof payload.userInfoShape).toBe('string');
      expect(typeof payload.appTokenShape).toBe('string');

      // no seeded sentinel value (a personnummer, a token string, a list item name) ever appears
      const line = JSON.stringify(payload);
      for (const v of [...Object.values(FAKE_SECRETS), 'Veckohandling', 'Mjölk', 'ICA Fake', 'Kaffe']) expect(line).not.toContain(v);

      // user-information and app-token are not duplicated inside `elements`: they only carry userInfoShape/appTokenShape
      const elements = payload.elements as { probe: string; label: string; shape: string }[];
      expect(elements.some((el) => el.probe === 'user-information' || el.probe === 'app-token')).toBe(false);

      // every shape string is capped at 500 chars: the wide 40-key answer proves it (its shape is 2000+ uncapped)
      const wideShape = elements.find((el) => el.label === 'vouchers.used[0]')!.shape;
      expect(wideShape.length).toBeLessThanOrEqual(501);
      expect(wideShape.endsWith('…')).toBe(true);
      for (const el of elements) expect(el.shape.length).toBeLessThanOrEqual(501);
      expect((payload.userInfoShape as string).length).toBeLessThanOrEqual(501);
      expect((payload.appTokenShape as string).length).toBeLessThanOrEqual(501);
      // the whole logged line stays a bounded, single readable journal entry
      expect(line.length).toBeLessThan(20_000);
    } finally { fake.opts.routes = savedRoutes; if (t2) await t2.close(); }
  });

  it('redacts a key that is itself a personnummer or a date, from both the log line and the page', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const savedRoutes = fake.opts.routes;
    // A map keyed by identifier-shaped values that are themselves data — a personnummer with a letter prefix and a
    // compact (no separator) date — at a captured path (accountBalance.groupedBalances[0]).
    fake.opts.routes = {
      ...FAKE_PROBE_ROUTES,
      '/sverige/digx/mobile/bonusservice/v1/bonus/current': { status: 200, body: { accountBalance: { groupedBalances: [{ p199001011234: 5, d20260930: 3 }] } } },
    };
    let t2: TestCtx | undefined;
    try {
      const connected = await connectedUser(log, 'dave@example.com');
      t2 = connected.t2;
      const html = await (await connected.client.get('/admin/ica/diagnostics')).text();
      expect(log.info).toHaveBeenCalledTimes(1);
      const [payload] = (log.info as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>, string];
      const line = JSON.stringify(payload);
      for (const key of ['p199001011234', 'd20260930']) { expect(html).not.toContain(key); expect(line).not.toContain(key); }
      const elements = payload.elements as { probe: string; label: string; shape: string }[];
      expect(elements.find((el) => el.label === 'accountBalance.groupedBalances[0]')?.shape).toBe('object{<key>: number, <key>: number}');
      expect(html).toContain('object{&lt;key&gt;: number, &lt;key&gt;: number}');
    } finally { fake.opts.routes = savedRoutes; if (t2) await t2.close(); }
  });
});

describe('/admin/ica: disconnect', () => {
  const idOf = (email: string) => t.db.select().from(schema.user).where(eq(schema.user.email, email)).get()!.id;
  const linkWeb = async (id: string, name: string) => storeWebSession({ session: await fakeLoggedInSession(fake), endpoints: fake.endpoints, db: t.db, cipher: t.cipher, user: { id, name } });

  it('requires a session', async () => {
    const p = await adminClient(t).post('/admin/ica/disconnect', { confirm: 'yes' });
    expect(p.status).toBe(302);
    expect(p.headers.get('location')).toMatch(/^\/admin\/login\?next=/);
  });

  it('asks first, then removes the linked ICA account and its sessions, audited as self', async () => {
    const bobId = idOf('bob@example.com');
    await linkWeb(bobId, 'Bob');
    const page = await (await get('/admin/ica', bob)).text();
    expect(page).toContain('Disconnect ICA account');
    expect(page).toMatch(/<form method="post" action="\/admin\/ica\/disconnect"><input type="hidden" name="_csrf" value="[^"]*"><button class="btn btn-secondary" type="submit">Disconnect ICA account<\/button><\/form>/);
    const ask = await bob.post('/admin/ica/disconnect', {});
    expect(ask.status).toBe(200);
    const askHtml = await ask.text();
    expect(askHtml).toContain('name="confirm" value="yes"');
    expect(askHtml).toContain(s.ica.disconnectConfirm);
    expect(linkedIcaAccount(t.db, bobId)).toBeDefined();
    expect((await bob.post('/admin/ica/disconnect', { confirm: 'yes' }, { origin: 'https://evil.example' })).status).toBe(403);
    await bob.post('/admin/ica/disconnect', { confirm: 'yes' }, { csrf: null }); // bounced back with a "form expired" flash
    expect(linkedIcaAccount(t.db, bobId)).toBeDefined();
    const r = await bob.post('/admin/ica/disconnect', { confirm: 'yes' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/admin/ica');
    expect(linkedIcaAccount(t.db, bobId)).toBeUndefined();
    const ev = audited('ica.disconnected').at(-1)!;
    expect([ev.actorUserId, ev.targetId, JSON.parse(ev.detailsJson)]).toEqual([bobId, bobId, { by: 'self', mode: 'deleted' }]);
    const after = await (await get('/admin/ica', bob)).text();
    expect(after).toContain(s.flash.ica_self_disconnected);
    expect(after).toContain('No ICA account connected yet');
    expect(after).not.toContain('action="/admin/ica/disconnect"');
  });

  it('with nothing linked it just goes back to the ICA page, unaudited', async () => {
    const bobId = idOf('bob@example.com');
    expect(linkedIcaAccount(t.db, bobId)).toBeUndefined();
    const before = audited('ica.disconnected').length;
    for (const fields of [{}, { confirm: 'yes' }] as Record<string, string>[]) {
      const r = await bob.post('/admin/ica/disconnect', fields);
      expect(r.status).toBe(303);
      expect(r.headers.get('location')).toBe('/admin/ica');
    }
    expect(audited('ica.disconnected')).toHaveLength(before);
  });

  it('a household member sharing the ICA account is only unlinked; the account stays for the others', async () => {
    await t.auth.api.createUser({ body: { email: 'carol@example.com', password: PASSWORD, name: 'Carol', role: 'member' } });
    const carol = await signIn('carol@example.com');
    const bobId = idOf('bob@example.com'); const carolId = idOf('carol@example.com');
    const { icaAccountId } = await linkWeb(bobId, 'Bob');
    t.db.insert(schema.userProfile).values({ userId: carolId, icaAccountId, createdAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: schema.userProfile.userId, set: { icaAccountId } }).run();
    const ask = await (await carol.post('/admin/ica/disconnect', {})).text();
    expect(ask).toContain(s.ica.disconnectConfirmShared);
    expect((await carol.post('/admin/ica/disconnect', { confirm: 'yes' })).status).toBe(303);
    expect(linkedIcaAccount(t.db, carolId)).toBeUndefined();
    expect(linkedIcaAccount(t.db, bobId)?.account.id).toBe(icaAccountId);
    expect(JSON.parse(audited('ica.disconnected').at(-1)!.detailsJson)).toEqual({ by: 'self', mode: 'unlinked' });
    expect(await (await get('/admin/ica', carol)).text()).toContain(s.flash.ica_self_unlinked);
  });
});

describe('/admin/ica: a refused login of another ICA person', () => {
  it('fails with the reason and is audited once as ica.identity_refused with only the kind', async () => {
    await t.auth.api.createUser({ body: { email: 'refused@example.com', password: PASSWORD, name: 'Dave', role: 'member' } });
    const dave = await signIn('refused@example.com');
    const daveId = t.db.select().from(schema.user).where(eq(schema.user.email, 'refused@example.com')).get()!.id;
    try {
      fake.opts.webSubject = 'CUST-DAVE';
      await storeWebSession({ session: await fakeLoggedInSession(fake), endpoints: fake.endpoints, db: t.db, cipher: t.cipher, user: { id: daveId, name: 'Dave' } });
      fake.opts.webSubject = 'CUST-OTHER';
      const before = audited('ica.identity_refused').length;
      const start = await post('/admin/ica/connect', dave);
      expect(start.status).toBe(303);
      const page = start.headers.get('location')!;
      expect((await status(page, dave)).state).toBe('pending');
      await new Promise((r) => setTimeout(r, 950));
      const done = await status(page, dave);
      expect(done.state).toBe('failed');
      expect(done.reason).toContain('different ICA account');
      await status(page, dave);
      const events = audited('ica.identity_refused');
      expect(events).toHaveLength(before + 1);
      const ev = events.at(-1)!;
      expect([ev.actorUserId, ev.outcome, JSON.parse(ev.detailsJson)]).toEqual([daveId, 'failure', { kind: 'web' }]);
      const row = JSON.stringify(ev);
      for (const leak of ['CUST-', t.cipher.mac('ica-subject:CUST-OTHER'), t.cipher.mac('ica-subject:CUST-DAVE')]) expect(row).not.toContain(leak);
      expect(audited('ica.web_connected').filter((e) => e.actorUserId === daveId)).toHaveLength(0);
    } finally { fake.opts.webSubject = undefined; }
  });
});
