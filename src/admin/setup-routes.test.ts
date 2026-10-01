import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '../db/index.js';
import { startFakeOidc, type FakeOidc } from '../auth/test-fakes.js';
import { adminClient, seedUser, startTestApp, TEST_PASSWORD, type TestCtx } from '../test-helpers.js';

const CODE = 'ABCD-EFGH-2345';
let t: TestCtx | undefined;
afterEach(async () => { await t?.close(); t = undefined; });
const fresh = async () => (t = await startTestApp({ ICA_HUB_SETUP_CODE: CODE, TRUST_PROXY: '1' }, { firstRun: true }));
let ip = 0;
const client = (ctx: TestCtx) => adminClient(ctx, { csrfFrom: '/admin/setup', forwardedFor: `203.0.113.${++ip}` });
const admin = (email: string) => ({ email, name: 'Owner', password: TEST_PASSWORD, confirm: TEST_PASSWORD });

describe('first-run setup', () => {
  it('sends every admin page to /admin/setup and refuses other POSTs while no user exists', async () => {
    const ctx = await fresh(); const c = client(ctx);
    for (const p of ['/admin', '/admin/login', '/admin/users', '/admin/settings']) expect((await c.get(p)).headers.get('location'), p).toBe('/admin/setup');
    expect((await c.post('/admin/login', { email: 'x@example.com', password: 'y' })).status).toBe(404);
    expect(await (await c.get('/admin/setup')).text()).toContain('Välkommen till butiken! Vi öppnar kassan.');
  });

  it('a wrong code is refused and audited; the right one opens the choice', async () => {
    const ctx = await fresh(); const c = client(ctx);
    const wrong = await c.post('/admin/setup/code', { code: 'AAAA-AAAA-AAAA' });
    expect(wrong.status).toBe(303);
    expect(await (await c.get('/admin/setup')).text()).toContain('That setup code is not right');
    expect(ctx.db.select().from(schema.auditEvent).all()).toEqual([expect.objectContaining({ action: 'auth.login_failed', outcome: 'failure' })]);
    // The typed code is never recorded.
    expect(JSON.stringify(ctx.db.select().from(schema.auditEvent).all())).not.toMatch(/AAAA/i);
    const ok = await c.post('/admin/setup/code', { code: CODE.toLowerCase() });
    expect(ok.headers.getSetCookie().join()).toMatch(/ica-hub\.setup=[^;]+; Max-Age=1800; Path=\/; HttpOnly; SameSite=Lax/);
    expect(await (await c.get('/admin/setup')).text()).toContain('Create admin with password');
  });

  it('rate-limits code attempts per IP, even for the right code', async () => {
    const ctx = await fresh(); const c = client(ctx);
    for (let i = 0; i < 10; i++) await c.post('/admin/setup/code', { code: 'AAAA-AAAA-AAAA' });
    await c.post('/admin/setup/code', { code: CODE });
    expect(await (await c.get('/admin/setup')).text()).toContain('Too many attempts');
  });

  it('password path: creates the admin, signs in, lands on Home; then setup is 404', async () => {
    const ctx = await fresh(); const c = client(ctx);
    await c.post('/admin/setup/code', { code: CODE });
    const r = await c.post('/admin/setup/admin', admin('owner.new@example.com'));
    expect(r.headers.get('location')).toBe('/admin');
    expect((await c.get('/admin')).status).toBe(200);
    expect(ctx.db.select().from(schema.user).all()).toEqual([expect.objectContaining({ email: 'owner.new@example.com', role: 'admin' })]);
    const acts = ctx.db.select().from(schema.auditEvent).all().map((e) => [e.action, JSON.parse(e.detailsJson)]);
    expect(acts).toEqual(expect.arrayContaining([['settings.changed', { setting: 'setup', changes: ['first_admin', 'password'] }], ['auth.login', { method: 'local' }]]));
    expect((await c.get('/admin/setup')).status).toBe(404);
    // Closed: the CSRF token now comes from /admin/login (the default), and the setup router itself answers 404.
    expect((await adminClient(ctx).post('/admin/setup/code', { code: CODE })).status).toBe(404);
  });

  it('two simultaneous setup submissions create exactly one admin; the loser gets 404', async () => {
    const ctx = await fresh(); const a = client(ctx); const b = client(ctx);
    await a.post('/admin/setup/code', { code: CODE }); await b.post('/admin/setup/code', { code: CODE });
    const [ra, rb] = await Promise.all([a.post('/admin/setup/admin', admin('a@example.com')), b.post('/admin/setup/admin', admin('b@example.com'))]);
    expect([ra.status, rb.status].sort()).toEqual([303, 404]);
    expect(ctx.db.select().from(schema.user).all()).toHaveLength(1);
  });

  it('refuses without a setup session and refuses a lookalike email', async () => {
    const ctx = await fresh(); const c = client(ctx);
    await c.post('/admin/setup/admin', admin('owner.new@example.com'));
    expect(ctx.db.select().from(schema.user).all()).toEqual([]);
    await c.post('/admin/setup/code', { code: CODE });
    await c.post('/admin/setup/admin', admin('owner\u212A@example.com')); // KELVIN SIGN folds to k
    expect(ctx.db.select().from(schema.user).all()).toEqual([]);
  });

  it('a user appearing mid-run closes setup for a live session: every setup GET and POST is 404, nothing is created', async () => {
    const ctx = await fresh(); const c = client(ctx);
    await c.post('/admin/setup/code', { code: CODE });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await c.get('/admin/setup')).text())![1]!;
    seedUser(ctx.db, 'other', { email: 'other@example.com', role: 'admin' });
    for (const p of ['/admin/setup', '/admin/setup/sso']) expect((await c.get(p)).status, p).toBe(404);
    const sso = { issuer_url: 'https://idp.example.com/o/', client_id: 'c', client_secret: 's', label: 'SSO' };
    for (const [p, body] of [['/admin/setup/code', { code: CODE }], ['/admin/setup/admin', admin('owner.new@example.com')], ['/admin/setup/sso', sso], ['/admin/setup/sso/test', sso], ['/admin/setup/sso/start', {}]] as const) {
      expect((await c.post(p, body, { csrf })).status, p).toBe(404);
    }
    expect(ctx.db.select({ id: schema.user.id }).from(schema.user).all()).toEqual([{ id: 'other' }]);
    expect(ctx.db.select().from(schema.appSetting).all()).toEqual([]);
  });

  it('the insert finds a user already there (someone finished setup while the password hashed): 404, nothing created', async () => {
    const ctx = await fresh(); const c = client(ctx);
    await c.post('/admin/setup/code', { code: CODE });
    const pw = (await ctx.auth.$context).password;
    const hash = pw.hash;
    // Deterministic: the other admin appears exactly between the session check and the atomic insert.
    pw.hash = async (p: string) => { seedUser(ctx.db, 'raced', { email: 'raced@example.com', role: 'admin' }); return hash(p); };
    try {
      const r = await c.post('/admin/setup/admin', admin('owner.new@example.com'));
      expect(r.status).toBe(404);
      expect(r.headers.getSetCookie().join()).not.toMatch(/session_token=[^;]/);
    } finally { pw.hash = hash; }
    expect(ctx.db.select({ id: schema.user.id }).from(schema.user).all()).toEqual([{ id: 'raced' }]);
    expect(ctx.db.select().from(schema.auditEvent).all().filter((e) => e.action === 'settings.changed')).toEqual([]);
    expect(ctx.setup.isOpen()).toBe(false);
  });

  it('matches setup paths case-insensitively, like Express routing', async () => {
    const ctx = await fresh(); const c = client(ctx);
    expect((await c.get('/admin/SETUP')).status).toBe(200);
    const r = await c.post('/admin/Setup/code', { code: CODE });
    expect(r.status).toBe(303);
    expect(r.headers.getSetCookie().join()).toMatch(/ica-hub\.setup=[A-Za-z0-9_-]{43};/);
  });

  it('is 404 from the start when a user exists (e.g. env bootstrap)', async () => {
    const ctx = await startTestApp({}, { firstRun: true });
    t = ctx;
    await ctx.auth.api.createUser({ body: { email: 'boot@example.com', password: TEST_PASSWORD, name: 'Boot', role: 'admin' } });
    expect((await adminClient(ctx).get('/admin/setup')).status).toBe(404);
  });
});

// AUTH_LOCAL_LOGIN=false plus env OIDC: the password path must not be reachable, or the admin it creates can never
// sign in again (password sign-in is off, and — with OIDC_LINK_BY_EMAIL=false — OIDC would refuse to link them
// either). See the whole-branch review: this used to be a permanent lockout.
describe('first-run setup with password sign-in off', () => {
  let idp: FakeOidc;
  afterEach(async () => { await idp?.close(); });
  const freshSsoOnly = async (env: Record<string, string> = {}) => {
    idp = await startFakeOidc();
    return (t = await startTestApp({
      ICA_HUB_SETUP_CODE: CODE, TRUST_PROXY: '1', AUTH_LOCAL_LOGIN: 'false',
      OIDC_ISSUER_URL: idp.issuer, OIDC_CLIENT_ID: 'ica-hub', OIDC_CLIENT_SECRET: 'fake-secret', OIDC_LABEL: 'Authentik', OIDC_LINK_BY_EMAIL: 'false',
      ...env,
    }, { firstRun: true }));
  };

  it('the choose step hides "Create admin with password"', async () => {
    const ctx = await freshSsoOnly(); const c = client(ctx);
    await c.post('/admin/setup/code', { code: CODE });
    const html = await (await c.get('/admin/setup')).text();
    expect(html).not.toContain('Create admin with password');
    expect(html).not.toContain('type="password"');
    expect(html).toContain('Set up single sign-on first');
  });

  it('POST /admin/setup/admin is refused, points at single sign-on, and creates nobody', async () => {
    const ctx = await freshSsoOnly(); const c = client(ctx);
    await c.post('/admin/setup/code', { code: CODE });
    // No password form left to scrape a CSRF token from: it comes from the SSO step's own form (same session, any page).
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await c.get('/admin/setup/sso')).text())![1]!;
    const r = await c.post('/admin/setup/admin', admin('owner.new@example.com'), { csrf });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/admin/setup');
    expect(await (await c.get('/admin/setup')).text()).toContain('Set up single sign-on first.');
    expect(ctx.db.select().from(schema.user).all()).toEqual([]);
    // Setup is still open: the SSO path is unaffected by the refused password attempt.
    expect(ctx.setup.isOpen()).toBe(true);
  });

  it('the SSO-first path still works in this config: Continue with Authentik becomes the admin', async () => {
    const ctx = await freshSsoOnly(); const c = client(ctx);
    await c.post('/admin/setup/code', { code: CODE });
    idp.next = { sub: 'sub-owner', email: 'owner.new@example.com', name: 'Owner' };
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await c.get('/admin/setup/sso')).text())![1]!;
    const { url, res } = await c.follow(await c.post('/admin/setup/sso/start', {}, { csrf }));
    expect(url).toBe(`${ctx.url}/admin`); expect(res.status).toBe(200);
    expect(ctx.db.select().from(schema.user).get()).toMatchObject({ email: 'owner.new@example.com', role: 'admin' });
    expect((await c.get('/admin/setup')).status).toBe(404);
  });
});
