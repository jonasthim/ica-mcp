import { Writable } from 'node:stream';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../db/index.js';
import { createCipher } from '../crypto.js';
import { writeSetting } from '../settings/store.js';
import type { Logger } from '../logger.js';
import { startFakeOidc, type FakeOidc } from '../auth/test-fakes.js';
import { SETTINGS_FETCH_LIMIT } from './settings-routes.js';
import { adminClient as client, startTestApp, TEST_PASSWORD, type AdminClient, type TestCtx } from '../test-helpers.js';

const SECRET = 'fake-secret';
let t: TestCtx; let idp: FakeOidc; let adminId: string;
/** One session for the owner: the sign-in rate limit is per email too. */
let owner: AdminClient;
const lines: string[] = [];
// Every log line the app writes, at every level: the secret must be in none of them.
const log = pino({ level: 'trace' }, new Writable({ write(chunk: Buffer, _enc, cb) { lines.push(chunk.toString()); cb(); } })) as unknown as Logger;
let ip = 0;
/** Each client gets its own IP: the sign-in rate limit is per IP. */
const adminClient = (ctx: TestCtx): AdminClient => client(ctx, { forwardedFor: `198.51.100.${++ip}` });
const signedIn = async (ctx: TestCtx = t, email = 'owner@example.com'): Promise<AdminClient> => { const c = adminClient(ctx); await c.signIn(email); return c; };
const ssoFields = (o: Record<string, string> = {}): Record<string, string> => ({
  issuer_url: idp.issuer, client_id: 'ica-hub', client_secret: SECRET, label: 'Authentik', link_by_email: 'on', ...o,
});
/** The page a 303 leads to (its flash included). */
const landing = async (c: AdminClient, r: Response): Promise<string> => {
  expect(r.status).toBe(303);
  return (await c.get(r.headers.get('location')!.replace(/#.*$/, ''))).text();
};
const link = (id = 'l1') => t.db.insert(schema.account).values({ id, accountId: 'sub-owner', providerId: 'upstream', userId: adminId, createdAt: new Date(), updatedAt: new Date() }).run();
const settingRows = () => t.db.select().from(schema.appSetting).all();

beforeAll(async () => {
  idp = await startFakeOidc();
  // A high fetch limit: this suite tests and saves many times as one admin (the limit has its own app below).
  t = await startTestApp({ TRUST_PROXY: '1', OIDC_LABEL: '' }, { log, settingsFetchLimit: 1000 });
  adminId = (await t.auth.api.createUser({ body: { email: 'owner@example.com', password: TEST_PASSWORD, name: 'Owner', role: 'admin' } })).user.id;
  await t.auth.api.createUser({ body: { email: 'member@example.com', password: TEST_PASSWORD, name: 'Member', role: 'member' } });
  owner = await signedIn();
});
afterAll(async () => { await t.close(); await idp.close(); });
beforeEach(async () => {
  t.db.delete(schema.appSetting).run(); t.db.delete(schema.account).where(eq(schema.account.providerId, 'upstream')).run();
  idp.patch = {}; await t.holder.reload();
});

describe('Settings: access', () => {
  it('members get 403 on every GET and POST (admin-only is the SSRF boundary for Test connection)', async () => {
    const m = await signedIn(t, 'member@example.com');
    const g = await m.get('/admin/settings');
    expect(g.status).toBe(403);
    expect(await g.text()).toContain('You do not have access to this page.');
    for (const path of ['/admin/settings/oidc/test', '/admin/settings/oidc', '/admin/settings/oidc/remove', '/admin/settings/sign-in', '/admin/settings/reload']) {
      expect((await m.post(path, ssoFields({ confirm: 'yes', local_login: 'on' }))).status, path).toBe(403);
    }
    expect(settingRows()).toEqual([]);
    expect(idp.seen.authorize).toBeUndefined();
  });
  it('anonymous: to the sign-in page; a POST without a CSRF token or without Origin changes nothing', async () => {
    const anon = adminClient(t);
    const r = await anon.get('/admin/settings');
    expect(r.status).toBe(302); expect(r.headers.get('location')).toBe('/admin/login?next=%2Fadmin%2Fsettings');
    const c = owner;
    const noCsrf = await c.post('/admin/settings/oidc', ssoFields(), { csrf: null, referer: `${t.url}/admin/settings` });
    expect(noCsrf.status).toBe(303);
    expect(await landing(c, noCsrf)).toContain('The form expired. Please try again.');
    expect((await c.post('/admin/settings/oidc', ssoFields(), { origin: null })).status).toBe(403);
    expect(settingRows()).toEqual([]);
  });
  it('admins see Settings in the nav and in the top bar; the Home warning card links here', async () => {
    const c = owner;
    const home = await (await c.get('/admin')).text();
    expect(home).toContain('class="nav-item nav-item--settings" href="/admin/settings"');
    expect(home).toContain('class="topbar-settings" href="/admin/settings"');
    const page = await c.get('/admin/settings');
    expect(page.status).toBe(200); expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain(`${t.url}/auth/callback/upstream`);
  });
});

describe('Settings: single sign-on', () => {
  it('Test connection shows the nine checks inline, and never the posted secret', async () => {
    const c = owner;
    const r = await c.post('/admin/settings/oidc/test', ssoFields({ admin_group: 'ica-admins' }));
    expect(r.headers.get('location')).toBe('/admin/settings#sso');
    const html = await landing(c, r);
    expect(html.match(/<li><span class="badge badge--ok">Pass<\/span>/g)).toHaveLength(9);
    expect(html).toContain('Sign-in page on the issuer’s host');
    expect(html).toContain(`value="${idp.issuer}"`); // the form as typed comes back…
    expect(html).not.toContain(SECRET); // …without the secret
    expect(settingRows()).toEqual([]); // a test saves nothing
  });
  it('Save: applied at once (button, CSP form-action, a real sign-in), audited with key names only', async () => {
    const c = owner;
    const r = await c.post('/admin/settings/oidc', ssoFields());
    expect(r.headers.get('location')).toBe('/admin/settings');
    expect(await landing(c, r)).toContain('Single sign-on saved and active.');
    const login = await adminClient(t).get('/admin/login');
    expect(login.headers.get('content-security-policy')).toContain(`form-action 'self' ${idp.origin};`);
    expect(await login.text()).toContain('Continue with Authentik');
    const ev = t.db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, 'settings.changed')).all().at(-1)!;
    expect(JSON.parse(ev.detailsJson)).toEqual({ setting: 'oidc', changes: ['issuer_url', 'client_id', 'client_secret', 'label', 'link_by_email'] });
    expect(ev.actorUserId).toBe(adminId);
    // The owner signs in with the provider: linked by email, lands on Home.
    idp.next = { sub: 'sub-owner', email: 'owner@example.com' };
    const o = adminClient(t);
    expect((await o.follow(await o.post('/admin/login/oidc', { oauth_query: '' }))).url).toBe(`${t.url}/admin`);
  });
  it('the stored secret never appears in any response, log line or audit row', async () => {
    lines.length = 0;
    const c = owner;
    const bodies: string[] = [];
    const keep = async (r: Response): Promise<Response> => { bodies.push(await r.clone().text(), JSON.stringify([...r.headers])); return r; };
    await keep(await c.post('/admin/settings/oidc/test', ssoFields()));
    const saved = await keep(await c.post('/admin/settings/oidc', ssoFields()));
    bodies.push(await landing(c, saved));
    await keep(await c.post('/admin/settings/oidc', ssoFields({ client_secret: '', label: 'SSO' })));
    await keep(await c.post('/admin/settings/oidc', ssoFields({ client_id: 'has space' })));
    idp.patch = { issuer: 'https://evil.example/' };
    await keep(await c.post('/admin/settings/oidc', ssoFields()));
    idp.patch = {};
    for (const p of ['/admin/settings', '/admin/login', '/admin/activity', '/admin']) bodies.push(await (await keep(await c.get(p))).text());
    for (const b of bodies) expect(b).not.toContain(SECRET);
    for (const row of t.db.select({ d: schema.auditEvent.detailsJson }).from(schema.auditEvent).all()) expect(row.d).not.toContain(SECRET);
    for (const row of settingRows()) expect(row.valueJson).not.toContain(SECRET);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toContain(SECRET);
    expect(t.holder.snapshot().config.oidc?.clientSecret).toBe(SECRET); // it is in use, just never shown
  });
  it('a blank secret keeps the stored one; blank with none stored is refused', async () => {
    const c = owner;
    expect(await landing(c, await c.post('/admin/settings/oidc', ssoFields({ client_secret: '' })))).toContain('Enter the client secret');
    await c.post('/admin/settings/oidc', ssoFields());
    expect(await landing(c, await c.post('/admin/settings/oidc', ssoFields({ client_secret: '', label: 'SSO' })))).toContain('Single sign-on saved and active.');
    expect(t.holder.snapshot().config.oidc).toMatchObject({ label: 'SSO', clientSecret: SECRET });
    expect(await (await c.get('/admin/settings')).text()).toContain('Stored. Leave blank to keep it.');
  });
  it('oidc_checks_failed: nothing saved, the results shown', async () => {
    const c = owner;
    idp.patch = { issuer: 'https://evil.example/application/o/ica-hub/' };
    const html = await landing(c, await c.post('/admin/settings/oidc', ssoFields()));
    expect(html).toContain('Not saved: the connection test failed. See the results below.');
    expect(html).toContain('The issuer named in the discovery document is not the URL you entered.');
    expect(settingRows()).toEqual([]);
    const ev = t.db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, 'settings.changed')).all().at(-1)!;
    expect(ev.outcome).toBe('failure'); expect(JSON.parse(ev.detailsJson)).toEqual({ setting: 'oidc', changes: ['oidc_checks_failed'] });
  });
  it('issuer_change_ack: a new issuer with links needs the box ticked, then unlinks', async () => {
    const c = owner;
    await c.post('/admin/settings/oidc', ssoFields());
    link();
    const other = await startFakeOidc();
    try {
      expect(await (await c.get('/admin/settings')).text()).toContain('name="unlink_ack"');
      expect(await landing(c, await c.post('/admin/settings/oidc', ssoFields({ issuer_url: other.issuer })))).toContain('A new issuer unlinks everyone’s single sign-on. Tick the box to confirm.');
      expect(await landing(c, await c.post('/admin/settings/oidc', ssoFields({ issuer_url: other.issuer, unlink_ack: 'on' })))).toContain('Single sign-on saved and active.');
      expect(t.db.select().from(schema.account).where(eq(schema.account.providerId, 'upstream')).all()).toEqual([]);
    } finally { await other.close(); }
  });
  it('no_password_admin: removing single sign-on when no admin has a password is refused', async () => {
    const c = owner;
    await c.post('/admin/settings/oidc', ssoFields());
    const cred = t.db.select().from(schema.account).where(eq(schema.account.providerId, 'credential')).all();
    t.db.delete(schema.account).where(eq(schema.account.providerId, 'credential')).run();
    try {
      expect(await landing(c, await c.post('/admin/settings/oidc/remove', { confirm: 'yes' }))).toContain('Not removed: no admin has a password, so nobody could sign in as admin.');
      expect(settingRows()).toHaveLength(1);
    } finally { for (const row of cred) t.db.insert(schema.account).values(row).run(); }
  });
  it('Remove: without JS a confirmation page first; confirmed, single sign-on is gone', async () => {
    const c = owner;
    await c.post('/admin/settings/oidc', ssoFields());
    const ask = await c.post('/admin/settings/oidc/remove');
    expect(ask.status).toBe(200);
    expect(await ask.text()).toContain('Remove single sign-on?');
    expect(settingRows()).toHaveLength(1);
    expect(await landing(c, await c.post('/admin/settings/oidc/remove', { confirm: 'yes' }))).toContain('Single sign-on removed.');
    expect(settingRows()).toEqual([]);
    expect(await (await adminClient(t).get('/admin/login')).text()).not.toContain('Continue with');
  });
  it('Test with a new secret, then the page: asks for the secret again (it is never kept), and never shows it', async () => {
    const c = owner;
    await c.post('/admin/settings/oidc', ssoFields());
    const html = await landing(c, await c.post('/admin/settings/oidc/test', ssoFields({ client_secret: 'a-new-secret' })));
    expect(html).toContain('Type the secret again before saving (it is never kept).');
    expect(html).not.toContain('Stored. Leave blank to keep it.');
    expect(html).not.toContain('a-new-secret');
    // A test without a typed secret keeps the ordinary hint.
    expect(await landing(c, await c.post('/admin/settings/oidc/test', ssoFields({ client_secret: '' })))).toContain('Stored. Leave blank to keep it.');
  });
  it('a stored secret that cannot be decrypted is shown as unreadable, and required', async () => {
    const other = createCipher(Buffer.alloc(32, 7));
    writeSetting(t.db, 'oidc', { issuerUrl: idp.issuer, clientId: 'ica-hub', clientSecretEnc: other.encrypt(SECRET), label: 'Authentik', linkByEmail: true }, null);
    const html = await (await owner.get('/admin/settings')).text();
    expect(html).toContain('The stored secret cannot be decrypted (was ICA_HUB_MASTER_KEY changed?). Enter it again.');
    expect(/<input [^>]*name="client_secret"[^>]*>/.exec(html)![0]).toContain(' required');
    expect(html).not.toContain('Stored. Leave blank to keep it.');
  });
  it('over-long input to Test connection is refused with a form error, never cut short', async () => {
    const c = owner;
    const long = `${idp.issuer}${'x'.repeat(500)}/`;
    const html = await landing(c, await c.post('/admin/settings/oidc/test', ssoFields({ issuer_url: long })));
    expect(html).toContain('Enter the issuer as an https:// URL');
    expect(html).not.toContain('Connection test');
    expect(await landing(c, await c.post('/admin/settings/oidc/test', ssoFields({ client_id: 'c'.repeat(201) })))).toContain('Enter the client ID');
  });
  it('a draft older than the stored settings is dropped (another admin saved since)', async () => {
    const c = owner;
    await landing(c, await c.post('/admin/settings/oidc/test', ssoFields({ label: 'Draft label' })));
    expect(await (await c.get('/admin/settings')).text()).toContain('value="Draft label"');
    writeSetting(t.db, 'oidc', { issuerUrl: idp.issuer, clientId: 'ica-hub', clientSecretEnc: t.cipher.encrypt(SECRET), label: 'Newer', linkByEmail: true }, null, new Date(Date.now() + 5_000));
    const html = await (await c.get('/admin/settings')).text();
    expect(html).not.toContain('Draft label');
    expect(html).toContain('value="Newer"');
  });
  it('unlink_locks_out over HTTP: the reviewer probe (no admin password, linking off, new issuer, box ticked)', async () => {
    const c = owner;
    const noLinking = ssoFields(); delete noLinking.link_by_email;
    await c.post('/admin/settings/oidc', noLinking);
    link();
    const cred = t.db.select().from(schema.account).where(eq(schema.account.providerId, 'credential')).all();
    t.db.delete(schema.account).where(eq(schema.account.providerId, 'credential')).run();
    const other = await startFakeOidc();
    try {
      expect(await landing(c, await c.post('/admin/settings/oidc', { ...noLinking, issuer_url: other.issuer, unlink_ack: 'on' }))).toContain('nobody could sign in as admin');
      expect(t.db.select().from(schema.account).where(eq(schema.account.providerId, 'upstream')).all()).toHaveLength(1);
    } finally { await other.close(); for (const row of cred) t.db.insert(schema.account).values(row).run(); }
  });
  it('an invalid form is refused with its own message, before anything is fetched', async () => {
    const c = owner;
    expect(await landing(c, await c.post('/admin/settings/oidc', ssoFields({ issuer_url: 'http://auth.example.com/o/' })))).toContain('Enter the issuer as an https:// URL');
    expect(await landing(c, await c.post('/admin/settings/oidc', ssoFields({ label: 'x'.repeat(41) })))).toContain('Keep the button label to 40 characters.');
    expect(settingRows()).toEqual([]);
  });
});

describe('Settings: sign-in methods (the lockout guard)', () => {
  it('no_sign_in_method: password off without single sign-on', async () => {
    const c = owner;
    expect(await landing(c, await c.post('/admin/settings/sign-in', {}))).toContain('Not saved: nobody could sign in. Keep password sign-in on until single sign-on works.');
    expect(t.holder.snapshot().config.localLogin).toBe(true);
  });
  it('no_oidc_admin, then allowed once an admin is linked; removing single sign-on is then refused', async () => {
    const c = owner;
    await c.post('/admin/settings/oidc', ssoFields());
    expect(await landing(c, await c.post('/admin/settings/sign-in', {}))).toContain('Not saved: no admin has signed in with single sign-on yet. Sign in with it once first.');
    link();
    expect(await landing(c, await c.post('/admin/settings/sign-in', {}))).toContain('Sign-in methods saved.');
    expect(t.holder.snapshot().config.localLogin).toBe(false);
    expect(await landing(c, await c.post('/admin/settings/oidc/remove', { confirm: 'yes' }))).toContain('Not saved: nobody could sign in.');
    expect(await landing(c, await c.post('/admin/settings/sign-in', { local_login: 'on' }))).toContain('Sign-in methods saved.');
  });
  it('password_login_required: with password sign-in off, the connection is frozen; the label can still change', async () => {
    const c = owner;
    await c.post('/admin/settings/oidc', ssoFields());
    link();
    expect(await landing(c, await c.post('/admin/settings/sign-in', {}))).toContain('Sign-in methods saved.');
    try {
      const refused = await landing(c, await c.post('/admin/settings/oidc', ssoFields({ client_id: 'other', client_secret: '' })));
      expect(refused).toContain('Turn password sign-in on before changing the SSO connection, so you can get back in if the new values are wrong.');
      expect(await landing(c, await c.post('/admin/settings/oidc', ssoFields({ client_secret: 'new' })))).toContain('Turn password sign-in on before changing');
      expect(await landing(c, await c.post('/admin/settings/oidc', ssoFields({ client_secret: '', label: 'SSO' })))).toContain('Single sign-on saved and active.');
      expect(t.holder.snapshot().config.oidc).toMatchObject({ clientId: 'ica-hub', clientSecret: SECRET, label: 'SSO' });
    } finally { await c.post('/admin/settings/sign-in', { local_login: 'on' }); }
  });
  it('link_by_email_needed: password and linking off while an admin is unlinked', async () => {
    const second = (await t.auth.api.createUser({ body: { email: 'second@example.com', password: TEST_PASSWORD, name: 'Second', role: 'admin' } })).user.id;
    try {
      const c = owner;
      const noLinking = ssoFields(); delete noLinking.link_by_email;
      await c.post('/admin/settings/oidc', noLinking);
      link();
      expect(await landing(c, await c.post('/admin/settings/sign-in', {}))).toContain('Not saved: some admins have not linked single sign-on yet.');
      expect(t.holder.snapshot().config.localLogin).toBe(true);
    } finally { t.db.update(schema.user).set({ role: 'member' }).where(eq(schema.user.id, second)).run(); }
  });
});

describe('Settings: rate limit', () => {
  let r: TestCtx;
  beforeAll(async () => {
    r = await startTestApp({ TRUST_PROXY: '1' });
    await r.auth.api.createUser({ body: { email: 'owner@example.com', password: TEST_PASSWORD, name: 'Owner', role: 'admin' } });
  });
  afterAll(async () => { await r.close(); });
  it('Test connection, Save and Reload share one limit per admin, across sessions, with neutral wording', async () => {
    const a = await signedIn(r); const b = await signedIn(r);
    const limited = 'Too many attempts. Wait a few minutes and try again.';
    for (let i = 0; i < SETTINGS_FETCH_LIMIT; i++) {
      expect(await landing(a, await (i % 2 ? a : b).post('/admin/settings/oidc/test', ssoFields({ issuer_url: 'http://example.invalid/' })))).not.toContain(limited);
    }
    expect(await landing(b, await b.post('/admin/settings/oidc/test', ssoFields()))).toContain(limited);
    expect(await landing(a, await a.post('/admin/settings/oidc', ssoFields()))).toContain(limited);
    expect(await landing(a, await a.post('/admin/settings/reload', {}))).toContain(limited);
    expect(r.db.select().from(schema.appSetting).all()).toEqual([]);
  });
});

describe('Settings managed by the environment', () => {
  let e: TestCtx;
  beforeAll(async () => {
    e = await startTestApp({ TRUST_PROXY: '1', OIDC_ISSUER_URL: idp.issuer, OIDC_CLIENT_ID: 'ica-hub', OIDC_CLIENT_SECRET: SECRET, OIDC_LABEL: 'Authentik', AUTH_LOCAL_LOGIN: 'true' });
    await e.auth.api.createUser({ body: { email: 'owner@example.com', password: TEST_PASSWORD, name: 'Owner', role: 'admin' } });
  });
  afterAll(async () => { await e.close(); });
  it('shows the values read-only with a fixed mask; crafted POSTs are refused', async () => {
    const c = await signedIn(e);
    const html = await (await c.get('/admin/settings')).text();
    expect(html).toContain('Managed by the environment.');
    expect(html).toContain('••••••••');
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain('name="client_secret"');
    expect(html).not.toContain('name="local_login"');
    expect(await landing(c, await c.post('/admin/settings/oidc', ssoFields()))).toContain('Not saved: this setting is managed by the environment.');
    expect(await landing(c, await c.post('/admin/settings/sign-in', {}))).toContain('Not saved: this setting is managed by the environment.');
    expect(await landing(c, await c.post('/admin/settings/oidc/remove', { confirm: 'yes' }))).toContain('Not saved: this setting is managed by the environment.');
    expect(e.db.select().from(schema.appSetting).all()).toEqual([]);
  });
});

describe('an env-managed switch with UI-managed single sign-on', () => {
  let e: TestCtx;
  beforeAll(async () => {
    e = await startTestApp({ TRUST_PROXY: '1', OIDC_LINK_BY_EMAIL: 'false' });
    await e.auth.api.createUser({ body: { email: 'owner@example.com', password: TEST_PASSWORD, name: 'Owner', role: 'admin' } });
  });
  afterAll(async () => { await e.close(); });
  it('is shown read-only; a POST that carries it is refused; without it the env value applies', async () => {
    const c = await signedIn(e);
    const page = await (await c.get('/admin/settings')).text();
    expect(page).not.toContain('name="link_by_email"');
    expect(page).toContain('name="admin_group"');
    expect(await landing(c, await c.post('/admin/settings/oidc', ssoFields()))).toContain('Not saved: this setting is managed by the environment.');
    expect(e.db.select().from(schema.appSetting).all()).toEqual([]);
    const rest = ssoFields(); delete rest.link_by_email;
    expect(await landing(c, await c.post('/admin/settings/oidc', rest))).toContain('Single sign-on saved and active.');
    expect(e.holder.snapshot().config.oidc?.linkByEmail).toBe(false);
  });
});

describe('the member group', () => {
  it('Settings shows both group fields with the Authentik hint; saving stores both', async () => {
    const html = await (await owner.get('/admin/settings')).text();
    expect(html).toContain('name="admin_group"');
    expect(html).toContain('name="member_group"');
    expect(html).toContain('Member group');
    expect(html).toContain('Admins must be in the admin group, or they lose admin at their next sign-in.');
    expect(html).toMatch(/The provider must let admin-group members sign in too \(bind both groups to the application in [^)<]+\)\./);
    expect(html).toContain('groups');
    const saved = await landing(owner, await owner.post('/admin/settings/oidc', ssoFields({ admin_group: 'ica-hub-admins', member_group: 'ica-hub-users' })));
    expect(saved).toContain('Single sign-on saved and active.');
    expect(saved).toContain('value="ica-hub-users"');
    expect(t.holder.snapshot().config.oidc).toMatchObject({ adminGroup: 'ica-hub-admins', memberGroup: 'ica-hub-users' });
    const audited = t.db.select().from(schema.auditEvent).all().filter((a) => a.action === 'settings.changed').map((a) => JSON.parse(a.detailsJson)).pop();
    expect(audited.changes).toEqual(expect.arrayContaining(['admin_group', 'member_group']));
  });
});

describe('OIDC_MEMBER_GROUP in env with UI-managed single sign-on', () => {
  let e: TestCtx;
  beforeAll(async () => {
    e = await startTestApp({ TRUST_PROXY: '1', OIDC_MEMBER_GROUP: 'ica-hub-users' });
    await e.auth.api.createUser({ body: { email: 'owner@example.com', password: TEST_PASSWORD, name: 'Owner', role: 'admin' } });
  });
  afterAll(async () => { await e.close(); });
  it('is read-only on the page; a crafted POST carrying it is refused with env_managed; without it the env value applies', async () => {
    const c = await signedIn(e);
    const page = await (await c.get('/admin/settings')).text();
    expect(page).not.toContain('name="member_group"');
    expect(page).toContain('name="admin_group"');
    expect(page).toContain('ica-hub-users');
    expect(await landing(c, await c.post('/admin/settings/oidc', ssoFields({ member_group: 'other' })))).toContain('Not saved: this setting is managed by the environment.');
    expect(e.db.select().from(schema.appSetting).all()).toEqual([]);
    const failed = e.db.select().from(schema.auditEvent).all().filter((a) => a.action === 'settings.changed' && a.outcome === 'failure').map((a) => JSON.parse(a.detailsJson));
    expect(failed).toContainEqual({ setting: 'oidc', changes: ['env_managed'] });
    expect(await landing(c, await c.post('/admin/settings/oidc', ssoFields()))).toContain('Single sign-on saved and active.');
    expect(e.holder.snapshot().config.oidc?.memberGroup).toBe('ica-hub-users');
    expect(JSON.parse(e.db.select().from(schema.appSetting).get()!.valueJson).memberGroup).toBeUndefined();
  });
});

describe('Settings: the groups the saving admin\'s last sign-in sent', () => {
  it('unknown (password sign-in): a warning that the name could not be checked; the save goes through', async () => {
    const saved = await landing(owner, await owner.post('/admin/settings/oidc', ssoFields({ admin_group: 'ica-hub-admins', member_group: 'ica-hub-users' })));
    expect(saved).toContain('Single sign-on saved and active.');
    expect(saved).toContain('The group names could not be checked');
  });
  it('known: marks each configured group (and nothing else), and refuses an admin group the admin is not in', async () => {
    t.holder.seenGroups.set(adminId, ['ica-hub-admins', 'ica-hub-users', 'other-admins']);
    try {
      await owner.post('/admin/settings/oidc', ssoFields({ admin_group: 'ica-hub-admins', member_group: 'ica-hub-kids' }));
      const html = await (await owner.get('/admin/settings')).text();
      expect(html).toContain('Whether your last Authentik sign-in sent each configured group:');
      // Only the configured names are shown, never the other groups the admin is in.
      expect(html).not.toContain('other-admins');
      expect(html).not.toContain('ica-hub-users');
      expect(html).toMatch(/ica-hub-admins[^<]*<\/code>\s*<span class="badge badge--ok">Sent<\/span>/);
      expect(html).toMatch(/ica-hub-kids[^<]*<\/code>\s*<span class="badge badge--bad">Not sent<\/span>/);
      const refused = await landing(owner, await owner.post('/admin/settings/oidc', ssoFields({ admin_group: 'ica-hub-admin' })));
      expect(refused).toContain('You are not in that admin group, so you would lose admin at your next sign-in. Check the group name.');
      expect(JSON.parse(settingRows()[0]!.valueJson).adminGroup).toBe('ica-hub-admins');
      const failed = t.db.select().from(schema.auditEvent).all().filter((a) => a.action === 'settings.changed' && a.outcome === 'failure').map((a) => JSON.parse(a.detailsJson));
      expect(failed).toContainEqual({ setting: 'oidc', changes: ['admin_group_not_yours'] });
    } finally { t.holder.seenGroups.set(adminId, undefined); }
  });
});
