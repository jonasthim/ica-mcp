import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, connectClaude, startTestApp, TEST_PASSWORD, type AdminClient, type TestCtx } from '../test-helpers.js';
import { startFakeIca, FAKE_PROBE_ROUTES, type FakeIca } from '../ica/test-fakes.js';
import { createInvite } from '../users/invites.js';
import { startFakeOidc, type FakeOidc } from '../auth/test-fakes.js';

let t: TestCtx; let fake: FakeIca; let idp: FakeOidc; let inviteToken: string; let inviteId: string;
beforeAll(async () => {
  fake = await startFakeIca({ pendingPolls: 1, routes: FAKE_PROBE_ROUTES });
  // A reachable (fake) IdP: the OIDC button shows only when Better Auth loaded the provider.
  idp = await startFakeOidc();
  t = await startTestApp({ OIDC_ISSUER_URL: idp.issuer, OIDC_CLIENT_ID: 'ica-hub', OIDC_CLIENT_SECRET: 'fake-secret', OIDC_LABEL: 'Authentik' }, { icaEndpoints: fake.endpoints });
  const { user } = await t.auth.api.createUser({ body: { email: 'admin@example.com', password: TEST_PASSWORD, name: 'Admin', role: 'admin' } });
  ({ token: inviteToken, invite: { id: inviteId } } = createInvite(t.db, { email: 'partner@example.com', role: 'member', createdByUserId: user.id }));
});
afterAll(async () => { await t.close(); await fake.close(); await idp.close(); });

const check = async (r: Response, path: string) => {
  const csp = r.headers.get('content-security-policy')!;
  const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
  const html = await r.text();
  expect(html, path).not.toMatch(/\sstyle\s*=|<style[\s>]|\son[a-z]+\s*=/i);
  for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) expect(tag, path).toContain(`nonce="${nonce}"`);
  return { csp, html };
};

describe('every rendered page', () => {
  let signedIn: Promise<AdminClient> | undefined;
  it.each(['/admin/login', '/admin/login?error=credentials', '/admin/does-not-exist'])('anonymous %s', async (path) => {
    const c = adminClient(t);
    await check(await c.get(path), path);
  });
  it.each(['/admin', '/admin/ica', '/admin/ica/diagnostics', '/admin/activity', '/admin/users', '/admin/profile', '/admin/apps', '/admin/settings', '/admin/does-not-exist'])('signed in %s', async (path) => {
    // One session for the whole list: the sign-in rate limit counts per email (10 per 15 minutes).
    signedIn ??= (async () => { const c = adminClient(t); await c.signIn('admin@example.com'); return c; })();
    const c = await signedIn;
    await check(await c.get(path), path);
  });
  it('the invite pages: accept (anonymous), gone, signed in as someone else, and the admin share pages', async () => {
    const anon = adminClient(t);
    const accept = await anon.get(`/admin/invite/${inviteToken}`);
    expect(accept.status).toBe(200);
    expect((await check(accept, 'invite accept')).html).toContain(`action="/admin/invite/${inviteToken}/accept"`);
    const gone = await anon.get(`/admin/invite/${'x'.repeat(43)}`);
    expect(gone.status).toBe(410);
    await check(gone, 'invite gone');
    const c = adminClient(t); await c.signIn('admin@example.com');
    expect((await check(await c.get(`/admin/invite/${inviteToken}`), 'invite other-user')).html).toContain('/switch"');
    // no link in memory for this invite (created outside the router): the share page offers Renew only…
    expect((await check(await c.get(`/admin/users/invites/${inviteId}`), 'share expired')).html).not.toContain('<figure');
    // …and after a renewal the link and its QR are shown
    const renewed = await c.post(`/admin/users/invites/${inviteId}/renew`, {});
    const share = await check(await c.get(renewed.headers.get('location')!), 'share fresh');
    expect(share.html).toMatch(/<figure class="qr"[^>]*><svg/);
    expect(share.csp).toContain("img-src 'self' data:");
  });
  it('the Users confirmation page (a POST answered with HTML)', async () => {
    const { user } = await t.auth.api.createUser({ body: { email: 'member@example.com', password: TEST_PASSWORD, name: 'Member', role: 'member' } });
    const c = adminClient(t); await c.signIn('admin@example.com');
    const r = await c.post(`/admin/users/${user.id}/remove`, {});
    expect(r.status).toBe(200);
    await check(r, 'users confirm');
  });
  it('the login page allows the IdP origin as a form target, the home page does not', async () => {
    const c = adminClient(t);
    expect((await check(await c.get('/admin/login'), 'login')).csp).toContain(`form-action 'self' ${idp.origin};`);
    await c.signIn('admin@example.com');
    expect((await check(await c.get('/admin'), 'home')).csp).toContain("form-action 'self';");
  });
});

// Its own app: the sign-ins above use up the per-IP login rate limit.
describe('body-parser errors', () => {
  it('a >16 kB form POST to /admin/login gets the styled 413 page, not JSON', async () => {
    const r = await fetch(`${t.url}/admin/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: t.url },
      body: new URLSearchParams({ email: 'a@b.se', password: 'x'.repeat(17 * 1024) }).toString(),
    });
    expect(r.status).toBe(413);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    const { html } = await check(r, 'login 413');
    expect(html).toContain('That form was too large to send.');
    expect(html).not.toContain('request entity too large');
  });
});

describe('Connected apps pages', () => {
  let a: TestCtx;
  beforeAll(async () => {
    a = await startTestApp();
    await a.auth.api.createUser({ body: { email: 'apps@example.com', password: TEST_PASSWORD, name: 'Apps', role: 'member' } });
  });
  afterAll(async () => { await a.close(); });
  it('Connected apps with an app, and its Revoke confirmation page (a POST answered with HTML)', async () => {
    const c = adminClient(a);
    const g = await connectClaude(a, c, { email: 'apps@example.com' });
    const list = await check(await c.get('/admin/apps'), 'apps list');
    expect(list.html).toContain(`name="client_id" value="${g.clientId}"`);
    const r = await c.post('/admin/apps/revoke', { client_id: g.clientId });
    expect(r.status).toBe(200);
    await check(r, 'apps confirm');
  });
  it('a malformed body outside /admin still gets the JSON 400 (an authorized /mcp call reaches its body parser)', async () => {
    const g = await connectClaude(a, adminClient(a), { email: 'apps@example.com' });
    const r = await fetch(`${a.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${g.accessToken}` }, body: '{' });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'bad_request' });
  });
});
