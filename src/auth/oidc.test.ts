import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/index.js';
import { adminClient as client, mcpPing, rawFetch, startTestApp, TEST_PASSWORD, type AdminClient, type TestCtx } from '../test-helpers.js';
import { startFakeOidc, type FakeOidc, type FakeOidcUser } from './test-fakes.js';

let t: TestCtx; let idp: FakeOidc; let owner: AdminClient;
// Every sign-in start spends the per-IP sign-in budget: each client gets its own address (TRUST_PROXY is on).
let ip = 0;
const adminClient = (ctx: TestCtx): AdminClient => client(ctx, { forwardedFor: `198.51.100.${++ip}` });
const env = (idp: FakeOidc, extra: Record<string, string> = {}) => ({
  OIDC_ISSUER_URL: idp.issuer, OIDC_CLIENT_ID: 'ica-hub', OIDC_CLIENT_SECRET: 'fake-secret', OIDC_LABEL: 'Authentik', OIDC_ADMIN_GROUP: 'ica-admins', TRUST_PROXY: '1', ...extra,
});
const userBy = (email: string) => t.db.select().from(schema.user).where(eq(schema.user.email, email)).get();
const accountsOf = (userId: string) => t.db.select({ p: schema.account.providerId, a: schema.account.accountId }).from(schema.account).where(eq(schema.account.userId, userId)).all();
const auditRows = () => t.db.select().from(schema.auditEvent).all();

beforeAll(async () => {
  idp = await startFakeOidc();
  t = await startTestApp(env(idp));
  await t.auth.api.createUser({ body: { email: 'owner@example.com', password: TEST_PASSWORD, name: 'Owner', role: 'admin' } });
  await t.auth.api.createUser({ body: { email: 'mixed@example.com', password: TEST_PASSWORD, name: 'Mixed', role: 'member' } });
  owner = adminClient(t); await owner.signIn('owner@example.com');
});
afterAll(async () => { await t.close(); await idp.close(); });

/** Posts an OIDC start form as `c`, lets the fake IdP answer as `user`, and follows the redirects back into the app. */
async function oidc(c: AdminClient, user: FakeOidcUser, path = '/admin/login/oidc', fields: Record<string, string> = { oauth_query: '' }) {
  idp.next = user;
  return c.follow(await c.post(path, fields));
}
const inviteToken = async (email: string, role = 'member'): Promise<string> => {
  const r = await owner.post('/admin/users/invites', { email, role });
  return /\/admin\/invite\/([A-Za-z0-9_-]{43})/.exec(await (await owner.get(r.headers.get('location')!)).text())![1]!;
};

describe('OIDC sign-in rules', () => {
  it('invited email → user created with the invite role and linked (from the invite page)', async () => {
    const token = await inviteToken('partner@example.com');
    const p = adminClient(t);
    const page = await p.get(`/admin/invite/${token}`);
    const html = await page.text();
    expect(html).toContain('Continue with Authentik');
    expect(html).toContain(`action="/admin/invite/${token}/oidc"`);
    expect(page.headers.get('content-security-policy')).toContain(`form-action 'self' ${idp.origin}`);
    const { res, url } = await oidc(p, { sub: 'sub-partner', email: 'partner@example.com', name: 'Partner' }, `/admin/invite/${token}/oidc`, {});
    expect(url).toBe(`${t.url}/admin`); expect(res.status).toBe(200);
    const u = userBy('partner@example.com')!;
    expect(u.role).toBe('member');
    expect(u.name).toBe('Partner');
    expect(accountsOf(u.id)).toEqual([{ p: 'upstream', a: 'sub-partner' }]);
    expect(t.db.select().from(schema.userProfile).where(eq(schema.userProfile.userId, u.id)).get()).toBeDefined();
    expect(idp.seen.authorize?.get('login_hint')).toBe('partner@example.com');
    expect((await adminClient(t).get(`/admin/invite/${token}`)).status).toBe(410);
    const acts = auditRows().filter((e) => e.actorUserId === u.id).map((e) => [e.action, JSON.parse(e.detailsJson).method]);
    expect(acts).toEqual(expect.arrayContaining([['user.invite_accepted', 'oidc'], ['auth.login', 'oidc']]));
  });

  it('asks for groups only when OIDC_ADMIN_GROUP is set, and uses PKCE', () => {
    expect(idp.seen.authorize?.get('scope')?.split(' ').sort()).toEqual(['email', 'groups', 'openid', 'profile']);
    expect(idp.seen.authorize?.get('code_challenge_method')).toBe('S256');
  });

  it('invited email → also works from the ordinary sign-in button', async () => {
    await inviteToken('late@example.com', 'admin');
    const { url } = await oidc(adminClient(t), { sub: 'sub-late', email: 'late@example.com' });
    expect(url).toBe(`${t.url}/admin`);
    expect(userBy('late@example.com')?.role).toBe('admin');
  });

  it('existing email + OIDC_LINK_BY_EMAIL → linked to the existing account, role kept', async () => {
    const { url } = await oidc(adminClient(t), { sub: 'sub-owner', email: 'owner@example.com' });
    expect(url).toBe(`${t.url}/admin`);
    const u = userBy('owner@example.com')!;
    expect(accountsOf(u.id).map((a) => a.p).sort()).toEqual(['credential', 'upstream']);
    expect(u.role).toBe('admin');
    const again = await oidc(adminClient(t), { sub: 'sub-owner', email: 'owner@example.com' }); // (a) linked subject
    expect(again.url).toBe(`${t.url}/admin`);
  });

  it('matches invite and existing account case-insensitively', async () => {
    const token = await inviteToken('Kid@Example.com');
    const k = await oidc(adminClient(t), { sub: 'sub-kid', email: 'kid@EXAMPLE.com' }, `/admin/invite/${token}/oidc`, {});
    expect(k.url).toBe(`${t.url}/admin`);
    expect(t.db.select().from(schema.user).all().filter((u) => u.email === 'kid@example.com')).toHaveLength(1);
    const before = t.db.select().from(schema.user).all().length;
    const m = await oidc(adminClient(t), { sub: 'sub-mixed', email: 'Mixed@Example.COM' });
    expect(m.url).toBe(`${t.url}/admin`);
    expect(t.db.select().from(schema.user).all()).toHaveLength(before);
    expect(accountsOf(userBy('mixed@example.com')!.id).map((a) => a.p)).toContain('upstream');
  });

  it('links only the first OIDC identity: a second subject with the same email is refused and audited', async () => {
    const ownerId = userBy('owner@example.com')!.id;
    const before = accountsOf(ownerId);
    expect(before.filter((a) => a.p === 'upstream')).toEqual([{ p: 'upstream', a: 'sub-owner' }]);
    const r = await oidc(adminClient(t), { sub: 'sub-owner-2', email: 'owner@example.com', groups: ['ica-admins'] });
    expect(r.url).toMatch(/\/admin\/login\?/);
    expect(await r.res.text()).toContain('An ICA-MCP account with this email exists but is not linked to Authentik.');
    expect(accountsOf(ownerId)).toEqual(before);
    expect(t.db.select().from(schema.account).where(eq(schema.account.accountId, 'sub-owner-2')).get()).toBeUndefined();
    const failed = auditRows().filter((e) => e.action === 'auth.login_failed').map((e) => JSON.parse(e.detailsJson));
    expect(failed).toContainEqual({ method: 'oidc', reason: 'account_not_linked', email: 'owner@example.com' });
    expect((await oidc(adminClient(t), { sub: 'sub-owner', email: 'owner@example.com' })).url).toBe(`${t.url}/admin`);
  });

  it('refuses a lookalike email that only matches after case folding (KELVIN SIGN)', async () => {
    const kid = userBy('kid@example.com')!;
    const before = accountsOf(kid.id);
    const r = await oidc(adminClient(t), { sub: 'sub-kelvin', email: '\u212Aid@example.com' });
    expect(await r.res.text()).toContain('The email address of your Authentik account cannot be used here.');
    expect(accountsOf(kid.id)).toEqual(before);
    expect(t.db.select().from(schema.account).where(eq(schema.account.accountId, 'sub-kelvin')).get()).toBeUndefined();
    const failed = auditRows().filter((e) => e.action === 'auth.login_failed').map((e) => JSON.parse(e.detailsJson));
    expect(failed).toContainEqual({ method: 'oidc', reason: 'email_invalid', email: 'kid@example.com' });
  });

  it('unknown email → friendly page naming the email once; nothing created; failure audited without claims', async () => {
    const c = adminClient(t);
    const { res, url } = await oidc(c, { sub: 'sub-x', email: 'stranger@example.com', groups: ['household'] });
    expect(url).toMatch(/\/admin\/login\?/);
    const html = await res.text();
    expect(html).toContain('No ICA-MCP account for stranger@example.com — ask an admin for an invite.');
    expect(html).toContain('role="alert"');
    expect(userBy('stranger@example.com')).toBeUndefined();
    const reload = await (await c.get(new URL(url).pathname + new URL(url).search)).text();
    expect(reload).toContain('No ICA-MCP account for this sign-in');
    expect(reload).not.toContain('stranger@example.com');
    const crafted = await (await c.get('/admin/login?error=oidc&error=not_invited&error_description=Call%20070')).text();
    expect(crafted).not.toContain('070');
    const failed = auditRows().filter((e) => e.action === 'auth.login_failed' && JSON.parse(e.detailsJson).email === 'stranger@example.com');
    expect(failed.map((e) => JSON.parse(e.detailsJson))).toEqual([{ method: 'oidc', reason: 'not_invited', email: 'stranger@example.com' }]);
  });

  it('shows a fixed message for Better Auth errors and never echoes the query', async () => {
    const c = adminClient(t);
    const page = async (q: string) => (await (await c.get(`/admin/login?${q}`)).text());
    expect(await page('error=oidc&error=STATE_MISMATCH&error_description=%3Cb%3Eevil%3C%2Fb%3E')).toContain('The sign-in took too long or was started in another browser.');
    expect(await page('error=oidc&error=state_not_found')).toContain('The sign-in took too long or was started in another browser.');
    const odd = await page('error=oidc&error=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(odd).toContain('Sign-in with Authentik failed. Please try again.');
    expect(odd).not.toContain('alert(1)');
    expect(await page('error=oidc&error=access_denied')).toContain('Sign-in was cancelled.');
  });

  it('email_verified false → rejected, even for an invited or existing email', async () => {
    const token = await inviteToken('unverified@example.com');
    const a = await oidc(adminClient(t), { sub: 'sub-u', email: 'unverified@example.com', email_verified: false });
    expect(await a.res.text()).toContain('no verified email address');
    expect(userBy('unverified@example.com')).toBeUndefined();
    expect((await adminClient(t).get(`/admin/invite/${token}`)).status).toBe(200); // the invite is still usable
    const b = await oidc(adminClient(t), { sub: 'sub-evil', email: 'owner@example.com', email_verified: false });
    expect(await b.res.text()).toContain('no verified email address');
    expect(accountsOf(userBy('owner@example.com')!.id).filter((x) => x.a === 'sub-evil')).toEqual([]);
    const c = await oidc(adminClient(t), { sub: 'sub-owner', email: 'owner@example.com', email_verified: false }); // linked subject too
    expect(await c.res.text()).toContain('no verified email address');
  });

  it('with only an admin group, Users shows no groups hint (roles are still managed here)', async () => {
    expect(await (await owner.get('/admin/users')).text()).not.toContain('Roles are managed by');
  });

  it('OIDC_ADMIN_GROUP → admin at sign-in; absence never demotes', async () => {
    await oidc(adminClient(t), { sub: 'sub-partner', email: 'partner@example.com', groups: ['household', 'ica-admins'] });
    expect(userBy('partner@example.com')?.role).toBe('admin');
    await oidc(adminClient(t), { sub: 'sub-partner', email: 'partner@example.com', groups: ['household'] });
    expect(userBy('partner@example.com')?.role).toBe('admin');
    const changed = auditRows().filter((e) => e.action === 'user.role_changed' && JSON.parse(e.detailsJson).via === 'oidc_group');
    expect(changed.map((e) => JSON.parse(e.detailsJson))).toEqual([{ from: 'member', to: 'admin', via: 'oidc_group' }]);
  });

  it('an invite with the admin group creates an admin', async () => {
    const token = await inviteToken('grouped@example.com', 'member');
    await oidc(adminClient(t), { sub: 'sub-grouped', email: 'grouped@example.com', groups: ['ica-admins'] }, `/admin/invite/${token}/oidc`, {});
    expect(userBy('grouped@example.com')?.role).toBe('admin');
    const id = userBy('grouped@example.com')!.id;
    expect(auditRows().filter((e) => e.action === 'user.role_changed' && e.targetId === id).map((e) => JSON.parse(e.detailsJson)))
      .toEqual([{ from: 'member', to: 'admin', via: 'oidc_group' }]);
  });

  it('a disabled user cannot sign in with OIDC', async () => {
    const id = userBy('late@example.com')!.id;
    expect((await owner.post(`/admin/users/${id}/disable`, { confirm: 'yes' })).status).toBe(303);
    expect(userBy('late@example.com')?.banned).toBe(true);
    const r = await oidc(adminClient(t), { sub: 'sub-late', email: 'late@example.com' });
    expect(await r.res.text()).toContain('This account is disabled');
    const failed = auditRows().filter((e) => e.action === 'auth.login_failed').map((e) => JSON.parse(e.detailsJson));
    expect(failed).toContainEqual({ method: 'oidc', reason: 'banned_user', email: 'late@example.com' });
  });

  it('refuses the invite OIDC start for a gone invite or a signed-in browser', async () => {
    const token = await inviteToken('busy@example.com');
    const r = await owner.post(`/admin/invite/${token}/oidc`, {});
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`/admin/invite/${token}`);
    expect((await adminClient(t).post(`/admin/invite/${'x'.repeat(43)}/oidc`, {})).status).toBe(410);
  });

  it('completes the Claude authorize → OIDC login → consent flow', async () => {
    const c = adminClient(t);
    const reg = await fetch(`${t.url}/auth/oauth2/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', application_type: 'native', redirect_uris: ['http://127.0.0.1/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const verifier = randomBytes(32).toString('base64url');
    const r0 = await rawFetch(`${t.url}/auth/oauth2/authorize?${new URLSearchParams({
      client_id, redirect_uri: 'http://127.0.0.1/cb', response_type: 'code', scope: 'mcp offline_access',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'st', resource: `${t.url}/mcp`,
    })}`, { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
    const oauthQuery = r0.headers.get('location')!.split('?')[1]!;
    const loginPage = await c.get(`/admin/login?${oauthQuery}`);
    expect(loginPage.headers.get('content-security-policy')).toContain(`form-action 'self' http://127.0.0.1 ${idp.origin}`);
    const toConsent = await oidc(c, { sub: 'sub-owner', email: 'owner@example.com' }, '/admin/login/oidc', { oauth_query: oauthQuery });
    expect(toConsent.url).toMatch(/\/admin\/consent\?/);
    const consentQuery = toConsent.url.split('?')[1]!;
    const done = await c.follow(await c.post('/admin/consent', { accept: 'yes', oauth_query: consentQuery }));
    const cb = new URL(done.url);
    expect(cb.origin + cb.pathname).toBe('http://127.0.0.1/cb');
    expect(cb.searchParams.get('state')).toBe('st');
    const tok = await fetch(`${t.url}/auth/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: cb.searchParams.get('code')!, redirect_uri: 'http://127.0.0.1/cb', client_id, code_verifier: verifier, resource: `${t.url}/mcp` }),
    });
    const { access_token } = (await tok.json()) as { access_token: string };
    expect((await mcpPing(t, access_token)).status).toBe(200);
  });

  it('an OIDC error during an OAuth flow keeps the signed query on the sign-in page', async () => {
    const c = adminClient(t);
    const reg = await fetch(`${t.url}/auth/oauth2/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', application_type: 'native', redirect_uris: ['http://127.0.0.1/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
    });
    const { client_id } = (await reg.json()) as { client_id: string };
    const r0 = await rawFetch(`${t.url}/auth/oauth2/authorize?${new URLSearchParams({
      client_id, redirect_uri: 'http://127.0.0.1/cb', response_type: 'code', scope: 'mcp', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 'st',
    })}`, { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
    const oauthQuery = r0.headers.get('location')!.split('?')[1]!;
    const { res } = await oidc(c, { sub: 'sub-y', email: 'nobody@example.com' }, '/admin/login/oidc', { oauth_query: oauthQuery });
    const html = await res.text();
    expect(html).toContain('No ICA-MCP account for nobody@example.com');
    const kept = /name="oauth_query" value="([^"]*)"/.exec(html)![1]!.replaceAll('&amp;', '&');
    expect(new URLSearchParams(kept).get('client_id')).toBe(client_id);
    expect(new URLSearchParams(kept).has('sig')).toBe(true);
    expect(new URLSearchParams(kept).has('error')).toBe(false);
  });
});

describe('AUTH_LOCAL_LOGIN=false and OIDC_LINK_BY_EMAIL=false', () => {
  let o: TestCtx; let idp2: FakeOidc;
  beforeAll(async () => {
    idp2 = await startFakeOidc();
    o = await startTestApp(env(idp2, { AUTH_LOCAL_LOGIN: 'false', OIDC_LINK_BY_EMAIL: 'false' }));
    await o.auth.api.createUser({ body: { email: 'admin@example.com', password: TEST_PASSWORD, name: 'Admin', role: 'admin' } });
  });
  afterAll(async () => { await o.close(); await idp2.close(); });

  it('hides the password form and rejects password POSTs', async () => {
    const c = adminClient(o);
    const html = await (await c.get('/admin/login')).text();
    expect(html).not.toContain('type="password"');
    expect(html).toContain('Continue with Authentik');
    const r = await c.signIn('admin@example.com');
    expect(r.status).toBe(403);
    expect(r.headers.getSetCookie().some((x) => x.includes('session_token='))).toBe(false);
    const failed = o.db.select().from(schema.auditEvent).all().filter((e) => e.action === 'auth.login_failed').map((e) => JSON.parse(e.detailsJson));
    expect(failed).toContainEqual(expect.objectContaining({ method: 'local', reason: 'local_disabled' }));
  });

  it('does not link an existing email when linking by email is off', async () => {
    const c = adminClient(o); idp2.next = { sub: 'sub-a', email: 'admin@example.com' };
    const { res } = await c.follow(await c.post('/admin/login/oidc', { oauth_query: '' }));
    expect(await res.text()).toContain('is not linked to Authentik');
    expect(o.db.select().from(schema.account).where(eq(schema.account.accountId, 'sub-a')).get()).toBeUndefined();
  });

  it('invites offer OIDC only and refuse a password acceptance', async () => {
    const a = adminClient(o);
    const admin = o.db.select().from(schema.user).where(eq(schema.user.email, 'admin@example.com')).get()!;
    // No password sign-in here: give the admin a session through OIDC by linking the subject first.
    o.db.insert(schema.account).values({ id: 'acc-seed', accountId: 'sub-admin', providerId: 'upstream', userId: admin.id, updatedAt: new Date() }).run();
    idp2.next = { sub: 'sub-admin', email: 'admin@example.com' };
    expect((await a.follow(await a.post('/admin/login/oidc', { oauth_query: '' }))).url).toBe(`${o.url}/admin`);
    const r = await a.post('/admin/users/invites', { email: 'guest@example.com', role: 'member' });
    const token = /\/admin\/invite\/([A-Za-z0-9_-]{43})/.exec(await (await a.get(r.headers.get('location')!)).text())![1]!;
    const g = adminClient(o);
    const page = await (await g.get(`/admin/invite/${token}`)).text();
    expect(page).toContain('Continue with Authentik');
    expect(page).not.toContain('type="password"');
    const pw = 'a-long-household-passphrase';
    expect((await g.post(`/admin/invite/${token}/accept`, { name: 'Guest', password: pw, confirm: pw })).status).toBe(403);
    expect(o.db.select().from(schema.user).where(eq(schema.user.email, 'guest@example.com')).get()).toBeUndefined();
    // Profile: no password card, and the password change is refused.
    const profile = await (await a.get('/admin/profile')).text();
    expect(profile).not.toContain('action="/admin/profile/password"');
    expect((await a.post('/admin/profile/password', { current: TEST_PASSWORD, password: pw, confirm: pw })).status).toBe(403);
  });
});

describe('OIDC group mapping end to end (admin group + member group)', () => {
  let g: TestCtx; let gIdp: FakeOidc;
  const groups = { OIDC_ADMIN_GROUP: 'ica-hub-admins', OIDC_MEMBER_GROUP: 'ica-hub-users' };
  const by = (email: string) => g.db.select().from(schema.user).where(eq(schema.user.email, email)).get();
  const signIn = async (user: FakeOidcUser) => {
    const c = adminClient(g); gIdp.next = user;
    return c.follow(await c.post('/admin/login/oidc', { oauth_query: '' }));
  };
  beforeAll(async () => {
    gIdp = await startFakeOidc();
    g = await startTestApp(env(gIdp, groups));
    await g.auth.api.createUser({ body: { email: 'chief@example.com', password: TEST_PASSWORD, name: 'Chief', role: 'admin' } });
  });
  afterAll(async () => { await g.close(); await gIdp.close(); });

  it('asks for the groups scope', async () => {
    await signIn({ sub: 'sub-scope', email: 'scope@example.com', groups: [] });
    expect(gIdp.seen.authorize?.get('scope')?.split(' ')).toContain('groups');
  });

  it('provisions an admin-group user as admin (no invite, no local account), linked, audited, signed in', async () => {
    const { url } = await signIn({ sub: 'sub-boss', email: 'boss@example.com', groups: ['ica-hub-admins', 'ica-hub-users'] });
    expect(url).toBe(`${g.url}/admin`);
    const u = by('boss@example.com')!;
    expect(u.role).toBe('admin');
    expect(g.db.select({ p: schema.account.providerId, a: schema.account.accountId }).from(schema.account).where(eq(schema.account.userId, u.id)).all()).toEqual([{ p: 'upstream', a: 'sub-boss' }]);
    const acts = g.db.select().from(schema.auditEvent).all().filter((e) => e.targetId === u.id).map((e) => [e.action, JSON.parse(e.detailsJson)]);
    expect(acts).toEqual([['user.provisioned', { role: 'admin' }], ['auth.login', { method: 'oidc' }]]);
  });

  it('provisions a member-group user as member', async () => {
    const { url } = await signIn({ sub: 'sub-partner', email: 'partner@example.com', groups: ['ica-hub-users'] });
    expect(url).toBe(`${g.url}/admin`);
    expect(by('partner@example.com')?.role).toBe('member');
  });

  it('refuses a user in neither group: not_in_group, nobody created', async () => {
    const { res, url } = await signIn({ sub: 'sub-out', email: 'out@example.com', groups: ['household'] });
    expect(url).toMatch(/\/admin\/login\?/);
    expect(await res.text()).toContain('Your Authentik account is not in a group that may use ICA-MCP. Ask an admin.');
    expect(by('out@example.com')).toBeUndefined();
  });

  it('refuses a sign-in without any groups claim with its own message: groups_missing', async () => {
    const { res } = await signIn({ sub: 'sub-nogroups', email: 'nogroups@example.com' });
    expect(await res.text()).toContain('Authentik did not send any groups. The provider needs a groups scope mapping.');
    expect(by('nogroups@example.com')).toBeUndefined();
    const failed = g.db.select().from(schema.auditEvent).all().filter((e) => e.action === 'auth.login_failed').map((e) => JSON.parse(e.detailsJson));
    expect(failed).toContainEqual({ method: 'oidc', reason: 'groups_missing', email: 'nogroups@example.com' });
  });

  it('an existing user that cannot be linked is refused, never duplicated', async () => {
    // Chief's account gets its first OIDC identity; a second identity with the same email and the admin group is refused.
    expect((await signIn({ sub: 'sub-chief', email: 'chief@example.com', groups: ['ica-hub-admins'] })).url).toBe(`${g.url}/admin`);
    const before = g.db.select().from(schema.user).all().length;
    const { res } = await signIn({ sub: 'sub-chief-2', email: 'chief@example.com', groups: ['ica-hub-admins'] });
    expect(await res.text()).toContain('An ICA-MCP account with this email exists but is not linked to Authentik.');
    expect(g.db.select().from(schema.user).all()).toHaveLength(before);
  });

  it('syncs roles both ways at sign-in: out of the admin group → member; back in → admin', async () => {
    expect((await signIn({ sub: 'sub-boss', email: 'boss@example.com', groups: ['ica-hub-users'] })).url).toBe(`${g.url}/admin`);
    expect(by('boss@example.com')?.role).toBe('member');
    await signIn({ sub: 'sub-boss', email: 'boss@example.com', groups: ['ica-hub-admins'] });
    expect(by('boss@example.com')?.role).toBe('admin');
    const id = by('boss@example.com')!.id;
    const changes = g.db.select().from(schema.auditEvent).all().filter((e) => e.action === 'user.role_changed' && e.targetId === id);
    expect(changes.map((e) => [e.actorUserId, JSON.parse(e.detailsJson)])).toEqual([
      [null, { from: 'admin', to: 'member', via: 'oidc_group' }], [null, { from: 'member', to: 'admin', via: 'oidc_group' }],
    ]);
  });

  it('not_in_group for an existing user: refused, not disabled; their password sign-in still works', async () => {
    const { res } = await signIn({ sub: 'sub-chief', email: 'chief@example.com', groups: [] });
    expect(await res.text()).toContain('is not in a group that may use ICA-MCP');
    expect(by('chief@example.com')).toMatchObject({ role: 'admin', banned: false });
    const pw = await adminClient(g).signIn('chief@example.com');
    expect(pw.headers.getSetCookie().some((x) => x.includes('session_token='))).toBe(true);
  });

  it('with a member group set, Users shows that roles come from the groups (role control and invite form)', async () => {
    const c = adminClient(g); await c.signIn('chief@example.com');
    const html = await (await c.get('/admin/users')).text();
    expect(html).toContain('Roles are managed by Authentik groups and reset at the next sign-in.');
    expect(html).toContain('Roles come from Authentik groups; the invite role only applies if groups allow it.');
  });

  it('the last two admins signing in at once, both only in the member group: one admin is left', async () => {
    // Only Chief and Boss are admins now.
    const admins = () => g.db.select().from(schema.user).all().filter((u) => u.role === 'admin' && !u.banned).map((u) => u.email).sort();
    expect(admins()).toEqual(['boss@example.com', 'chief@example.com']);
    const toCallback = async (user: FakeOidcUser) => {
      const c = adminClient(g); gIdp.next = user;
      const atIdp = await c.follow(await c.post('/admin/login/oidc', { oauth_query: '' }), 1); // the IdP's redirect back
      return { c, back: atIdp.res };
    };
    const a = await toCallback({ sub: 'sub-chief', email: 'chief@example.com', groups: ['ica-hub-users'] });
    const b = await toCallback({ sub: 'sub-boss', email: 'boss@example.com', groups: ['ica-hub-users'] });
    const done = await Promise.all([a.c.follow(a.back), b.c.follow(b.back)]);
    expect(done.map((d) => d.url)).toEqual([`${g.url}/admin`, `${g.url}/admin`]);
    expect(admins()).toHaveLength(1);
  });
});

describe('only a member group configured', () => {
  let m: TestCtx; let mIdp: FakeOidc;
  beforeAll(async () => {
    mIdp = await startFakeOidc(); m = await startTestApp(env(mIdp, { OIDC_ADMIN_GROUP: '', OIDC_MEMBER_GROUP: 'ica-hub-users' }));
    await m.auth.api.createUser({ body: { email: 'admin@example.com', password: TEST_PASSWORD, name: 'Admin', role: 'admin' } });
  });
  afterAll(async () => { await m.close(); await mIdp.close(); });
  it('Users shows the roles hint here too (a member group is set)', async () => {
    const c = adminClient(m); await c.signIn('admin@example.com');
    expect(await (await c.get('/admin/users')).text()).toContain('Roles are managed by Authentik groups');
  });
  it('still asks for the groups scope, and provisions members', async () => {
    const c = adminClient(m); mIdp.next = { sub: 'sub-k', email: 'k@example.com', groups: ['ica-hub-users'] };
    expect((await c.follow(await c.post('/admin/login/oidc', { oauth_query: '' }))).url).toBe(`${m.url}/admin`);
    expect(mIdp.seen.authorize?.get('scope')?.split(' ')).toContain('groups');
    expect(m.db.select().from(schema.user).where(eq(schema.user.email, 'k@example.com')).get()?.role).toBe('member');
  });
});
