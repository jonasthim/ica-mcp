import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/index.js';
import { writeSetting } from '../settings/store.js';
import { startFakeOidc, type FakeOidc } from '../auth/test-fakes.js';
import { adminClient, startTestApp, TEST_PASSWORD, type TestCtx } from '../test-helpers.js';

const CODE = 'ABCD-EFGH-2345';
let idp: FakeOidc;
beforeAll(async () => { idp = await startFakeOidc(); });
afterAll(async () => { await idp.close(); });
let t: TestCtx | undefined;
afterEach(async () => { await t?.close(); t = undefined; idp.patch = {}; idp.seen = {}; });
const sso = { issuer_url: '', client_id: 'ica-hub', client_secret: 'fake-secret', label: 'Authentik', link_by_email: 'on', admin_group: '' };
const fresh = async (env: Record<string, string> = {}) => (t = await startTestApp({ ICA_HUB_SETUP_CODE: CODE, ...env }, { firstRun: true }));
const withSession = async (ctx: TestCtx) => {
  const c = adminClient(ctx, { csrfFrom: '/admin/setup' });
  await c.post('/admin/setup/code', { code: CODE });
  return c;
};

describe('OIDC-first setup', () => {
  it('save → Continue with Authentik → the first sign-in is the admin; then setup is gone', async () => {
    const ctx = await fresh();
    const c = await withSession(ctx);
    const saved = await c.post('/admin/setup/sso', { ...sso, issuer_url: idp.issuer });
    expect(saved.headers.get('location')).toBe('/admin/setup/sso');
    const page = await c.get('/admin/setup/sso');
    const html = await page.text();
    expect(html).toContain('Continue with Authentik');
    expect(html).toContain('Single sign-on saved and active.');
    expect(html).toContain(`${ctx.url}/auth/callback/upstream`);
    expect(page.headers.get('content-security-policy')).toContain(`form-action 'self' ${idp.origin}`);
    idp.next = { sub: 'sub-owner', email: 'owner.new@example.com', name: 'Owner' };
    const { url, res } = await c.follow(await c.post('/admin/setup/sso/start'));
    expect(url).toBe(`${ctx.url}/admin`); expect(res.status).toBe(200);
    const u = ctx.db.select().from(schema.user).get()!;
    expect(u).toMatchObject({ email: 'owner.new@example.com', role: 'admin' });
    expect(ctx.db.select({ p: schema.account.providerId }).from(schema.account).where(eq(schema.account.userId, u.id)).all()).toEqual([{ p: 'upstream' }]);
    expect(ctx.db.select().from(schema.appSetting).get()).toMatchObject({ key: 'oidc', updatedBy: null });
    const acts = ctx.db.select().from(schema.auditEvent).all().map((e) => [e.action, JSON.parse(e.detailsJson)]);
    expect(acts).toEqual(expect.arrayContaining([
      ['settings.changed', expect.objectContaining({ setting: 'oidc' })],
      ['settings.changed', { setting: 'setup', changes: ['first_admin', 'oidc'] }],
      ['auth.login', { method: 'oidc' }],
    ]));
    // The client secret is write-only: never in the audit log.
    expect(JSON.stringify(ctx.db.select().from(schema.auditEvent).all())).not.toContain('fake-secret');
    // The first page after the callback (followed above) expired the leftover setup cookie.
    expect(c.cookie()).not.toContain('ica-hub.setup=');
    expect((await c.get('/admin/setup')).status).toBe(404);
    expect((await c.get('/admin/setup/sso')).status).toBe(404);
  });

  it('with OIDC in env, setup offers only Continue', async () => {
    const ctx = await fresh({ OIDC_ISSUER_URL: idp.issuer, OIDC_CLIENT_ID: 'ica-hub', OIDC_CLIENT_SECRET: 'fake-secret', OIDC_LABEL: 'Authentik' });
    const c = await withSession(ctx);
    expect(await (await c.get('/admin/setup')).text()).toContain('Single sign-on is set in the environment');
    const html = await (await c.get('/admin/setup/sso')).text();
    expect(html).toContain('Continue with Authentik'); expect(html).not.toContain('name="client_secret"');
    expect(html).not.toContain('fake-secret');
    // Nothing to save from the page when the environment decides.
    await c.post('/admin/setup/sso', { ...sso, issuer_url: idp.issuer });
    expect(await (await c.get('/admin/setup/sso')).text()).toContain('managed by the environment');
    expect(ctx.db.select().from(schema.appSetting).all()).toEqual([]);
    idp.next = { sub: 'sub-env', email: 'env@example.com' };
    expect((await c.follow(await c.post('/admin/setup/sso/start'))).url).toBe(`${ctx.url}/admin`);
    expect(ctx.db.select().from(schema.user).get()).toMatchObject({ email: 'env@example.com', role: 'admin' });
  });

  it('without a setup session nothing is shown, tested, saved or started', async () => {
    const ctx = await fresh();
    const c = adminClient(ctx, { csrfFrom: '/admin/setup' });
    expect((await c.get('/admin/setup/sso')).headers.get('location')).toBe('/admin/setup');
    for (const p of ['/admin/setup/sso', '/admin/setup/sso/test']) expect((await c.post(p, { ...sso, issuer_url: idp.issuer })).headers.get('location'), p).toBe('/admin/setup');
    expect((await c.post('/admin/setup/sso/start')).headers.get('location')).toBe('/admin/setup');
    expect(await (await c.get('/admin/setup')).text()).toContain('The setup session expired');
    expect(idp.seen.authorize).toBeUndefined();
    expect(ctx.db.select().from(schema.appSetting).all()).toEqual([]);
    expect(ctx.db.select().from(schema.user).all()).toEqual([]);
  });

  it('the new POSTs need the same origin and the CSRF token', async () => {
    const ctx = await fresh();
    const c = await withSession(ctx);
    for (const p of ['/admin/setup/sso', '/admin/setup/sso/test', '/admin/setup/sso/start']) {
      expect((await c.post(p, { ...sso, issuer_url: idp.issuer }, { origin: 'https://evil.example' })).status, p).toBe(403);
      expect((await c.post(p, { ...sso, issuer_url: idp.issuer }, { csrf: 'forged' })).headers.get('location'), p).not.toMatch(/^\/admin\/setup\/sso$|127\.0\.0\.1/);
    }
    expect(ctx.db.select().from(schema.appSetting).all()).toEqual([]);
    expect(idp.seen.authorize).toBeUndefined();
  });

  it('Test connection shows the checks and the form as typed, never the secret', async () => {
    const ctx = await fresh();
    const c = await withSession(ctx);
    const r = await c.post('/admin/setup/sso/test', { ...sso, issuer_url: idp.issuer });
    expect(r.headers.get('location')).toBe('/admin/setup/sso');
    const html = await (await c.get('/admin/setup/sso')).text();
    expect(html).toContain('Connection test'); expect(html).toContain(`value="${idp.issuer}"`);
    expect(html).not.toContain('fake-secret');
    expect(html).toContain('formaction="/admin/setup/sso/test"'); expect(html).toContain('action="/admin/setup/sso"');
    expect(ctx.db.select().from(schema.appSetting).all()).toEqual([]);
  });

  it('a failing check or an over-long secret saves nothing and says why', async () => {
    const ctx = await fresh();
    const c = await withSession(ctx);
    const long = await c.post('/admin/setup/sso', { ...sso, issuer_url: idp.issuer, client_secret: 's'.repeat(501) });
    expect(long.headers.get('location')).toBe('/admin/setup/sso');
    expect(await (await c.get('/admin/setup/sso')).text()).toContain('The client secret is too long');
    idp.patch = { issuer: 'https://evil.example/' };
    await c.post('/admin/setup/sso', { ...sso, issuer_url: idp.issuer });
    const html = await (await c.get('/admin/setup/sso')).text();
    expect(html).toContain('the connection test failed'); expect(html).not.toContain('Continue with Authentik');
    expect(ctx.db.select().from(schema.appSetting).all()).toEqual([]);
    const fails = ctx.db.select().from(schema.auditEvent).all().filter((e) => e.action === 'settings.changed');
    expect(fails.map((e) => [e.outcome, JSON.parse(e.detailsJson)])).toEqual([['failure', { setting: 'oidc', changes: ['oidc_checks_failed'] }]]);
  });

  it('an IdP identity without a verified email does not become admin, and setup stays open', async () => {
    const ctx = await fresh();
    const c = await withSession(ctx);
    await c.post('/admin/setup/sso', { ...sso, issuer_url: idp.issuer });
    idp.next = { sub: 'sub-x', email: 'x@example.com', email_verified: false };
    const { url } = await c.follow(await c.post('/admin/setup/sso/start'));
    expect(url).toMatch(/\/admin\/setup\/sso\?error=oidc&error=email_not_verified/);
    expect(await (await c.get(url.replace(ctx.url, ''))).text()).toContain('has no verified email address');
    expect(ctx.db.select().from(schema.user).all()).toEqual([]);
    expect(ctx.setup.isOpen()).toBe(true);
    // The claim is only taken once the checks passed: a verified identity can still finish setup right away.
    idp.next = { sub: 'sub-owner', email: 'owner.new@example.com' };
    expect((await c.follow(await c.post('/admin/setup/sso/start'))).url).toBe(`${ctx.url}/admin`);
    expect(ctx.db.select().from(schema.user).get()).toMatchObject({ email: 'owner.new@example.com', role: 'admin' });
  });

  it('a callback without the setup cookie never creates the first admin', async () => {
    const ctx = await fresh();
    const c = await withSession(ctx);
    await c.post('/admin/setup/sso', { ...sso, issuer_url: idp.issuer });
    const start = await c.post('/admin/setup/sso/start');
    // Another browser (no setup cookie) completes the IdP round trip with this start's state: Better Auth refuses the
    // state (its cookie is missing), and even with it the policy would find no setup session.
    const other = adminClient(ctx);
    idp.next = { sub: 'sub-evil', email: 'evil@example.com' };
    const { url } = await other.follow(start);
    expect(url).not.toBe(`${ctx.url}/admin`);
    expect(ctx.db.select().from(schema.user).all()).toEqual([]);
    expect(ctx.setup.isOpen()).toBe(true);
  });

  it('the password path finishing while the save loads the provider: 404, nothing saved or swapped, no success audited', async () => {
    const ctx = await fresh();
    const c = await withSession(ctx);
    const before = ctx.holder.snapshot();
    const discovery = '/application/o/ica-hub/.well-known/openid-configuration';
    const check = idp.pause(discovery); // the save's connection check
    const saving = c.post('/admin/setup/sso', { ...sso, issuer_url: idp.issuer });
    await check.reached;
    const build = idp.pause(discovery); // the candidate build, after the plan's guard passed
    check.release();
    await build.reached;
    ctx.db.insert(schema.user).values({ id: 'pw', name: 'pw', email: 'pw@example.com', role: 'admin' }).run();
    build.release();
    expect((await saving).status).toBe(404);
    expect(ctx.db.select().from(schema.appSetting).all()).toEqual([]);
    expect(ctx.holder.snapshot()).toBe(before);
    expect(ctx.db.select().from(schema.auditEvent).all().filter((e) => e.action === 'settings.changed' && e.outcome !== 'failure')).toEqual([]);
  });

  it('the password path finishing first closes the SSO path', async () => {
    const ctx = await fresh();
    const c = await withSession(ctx);
    await c.post('/admin/setup/sso', { ...sso, issuer_url: idp.issuer });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await c.get('/admin/setup/sso')).text())![1]!;
    const other = await withSession(ctx);
    await other.post('/admin/setup/admin', { email: 'pw@example.com', name: 'Pw', password: TEST_PASSWORD, confirm: TEST_PASSWORD });
    expect((await c.post('/admin/setup/sso/start', {}, { csrf })).status).toBe(404);
    expect(idp.seen.authorize).toBeUndefined();
    expect(ctx.db.select({ email: schema.user.email }).from(schema.user).all()).toEqual([{ email: 'pw@example.com' }]);
  });
});

describe('first run with OIDC and an admin group in env (no setup code)', () => {
  const envOidc = { OIDC_ISSUER_URL: '', OIDC_CLIENT_ID: 'ica-hub', OIDC_CLIENT_SECRET: 'fake-secret', OIDC_LABEL: 'Authentik' };
  const groups = { OIDC_ADMIN_GROUP: 'ica-hub-admins', OIDC_MEMBER_GROUP: 'ica-hub-users' };
  const start = async (ctx: TestCtx) => {
    const c = adminClient(ctx, { csrfFrom: '/admin/setup' });
    return { c, r: await c.post('/admin/setup/group') };
  };

  it('the setup page offers Continue without the code; the first admin-group sign-in creates the admin and closes setup', async () => {
    const ctx = await fresh({ ...envOidc, OIDC_ISSUER_URL: idp.issuer, ...groups });
    const c = adminClient(ctx, { csrfFrom: '/admin/setup' });
    const page = await c.get('/admin/setup');
    const html = await page.text();
    expect(html).toContain('Continue with Authentik');
    expect(html).toContain('action="/admin/setup/group"');
    expect(html).toContain('name="code"'); // the code stays available
    expect(page.headers.get('content-security-policy')).toContain(`form-action 'self' ${idp.origin}`);
    idp.next = { sub: 'sub-boss', email: 'boss@example.com', groups: ['ica-hub-admins', 'ica-hub-users'] };
    const { url, res } = await c.follow(await c.post('/admin/setup/group'));
    expect(url).toBe(`${ctx.url}/admin`); expect(res.status).toBe(200);
    expect(ctx.db.select({ email: schema.user.email, role: schema.user.role }).from(schema.user).all()).toEqual([{ email: 'boss@example.com', role: 'admin' }]);
    expect(ctx.setup.isOpen()).toBe(false);
    expect((await c.get('/admin/setup')).status).toBe(404);
    const acts = ctx.db.select().from(schema.auditEvent).all().map((e) => [e.action, JSON.parse(e.detailsJson)]);
    expect(acts).toEqual(expect.arrayContaining([
      ['settings.changed', { setting: 'setup', changes: ['first_admin', 'oidc_group'] }], ['user.provisioned', { role: 'admin' }], ['auth.login', { method: 'oidc' }],
    ]));
  });

  it('a member-group sign-in on the empty table creates nobody, says why, and leaves setup open', async () => {
    const ctx = await fresh({ ...envOidc, OIDC_ISSUER_URL: idp.issuer, ...groups });
    const { c, r } = await start(ctx);
    idp.next = { sub: 'sub-partner', email: 'partner@example.com', groups: ['ica-hub-users'] };
    const { url, res } = await c.follow(r);
    expect(new URL(url).pathname).toBe('/admin/setup');
    expect(await res.text()).toContain('ICA-MCP is not set up yet. The first sign-in must be by a member of the admin group.');
    expect(ctx.db.select().from(schema.user).all()).toEqual([]);
    expect(ctx.setup.isOpen()).toBe(true);
  });

  it('not offered, and refused, with env OIDC but no admin group, or with only OIDC_ADMIN_GROUP and no OIDC at all', async () => {
    const envs: Record<string, string>[] = [{ ...envOidc, OIDC_ISSUER_URL: idp.issuer, OIDC_MEMBER_GROUP: 'ica-hub-users' }, { OIDC_ADMIN_GROUP: 'ica-hub-admins' }];
    for (const env of envs) {
      const ctx = await fresh(env);
      const c = adminClient(ctx, { csrfFrom: '/admin/setup' });
      expect(await (await c.get('/admin/setup')).text()).not.toContain('action="/admin/setup/group"');
      const r = await c.post('/admin/setup/group');
      expect(r.status).toBe(404);
      expect(idp.seen.authorize).toBeUndefined();
      await ctx.close(); t = undefined;
    }
  });

  it('not offered, and refused (404), with UI-managed single sign-on that has an admin group', async () => {
    const ctx = t = await startTestApp({ ICA_HUB_SETUP_CODE: CODE }, {
      firstRun: true,
      seed: (db, cipher) => writeSetting(db, 'oidc', {
        issuerUrl: idp.issuer, clientId: 'ica-hub', clientSecretEnc: cipher.encrypt('fake-secret'), label: 'Authentik', linkByEmail: true, adminGroup: 'ica-hub-admins',
      }, null),
    });
    expect(ctx.holder.snapshot().config.oidc).toMatchObject({ adminGroup: 'ica-hub-admins' }); // loaded, so only the source differs
    const c = adminClient(ctx, { csrfFrom: '/admin/setup' });
    expect(await (await c.get('/admin/setup')).text()).not.toContain('action="/admin/setup/group"');
    expect((await c.post('/admin/setup/group')).status).toBe(404);
    expect(idp.seen.authorize).toBeUndefined();
    expect(ctx.db.select().from(schema.user).all()).toEqual([]);
  });

  it('needs the same origin and the CSRF token', async () => {
    const ctx = await fresh({ ...envOidc, OIDC_ISSUER_URL: idp.issuer, ...groups });
    const c = adminClient(ctx, { csrfFrom: '/admin/setup' });
    expect((await c.post('/admin/setup/group', {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await c.post('/admin/setup/group', {}, { csrf: 'forged' })).headers.get('location')).not.toMatch(/127\.0\.0\.1/);
    expect(idp.seen.authorize).toBeUndefined();
  });
});
