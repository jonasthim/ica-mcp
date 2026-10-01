import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/index.js';
import { adminClient, rawFetch, startTestApp, TEST_PASSWORD as PASSWORD, type TestCtx } from '../test-helpers.js';

let t: TestCtx;
const EMAIL = 'admin@example.com';
beforeAll(async () => {
  t = await startTestApp();
  const u = await t.auth.api.createUser({ body: { email: EMAIL, password: PASSWORD, name: 'Admin', role: 'admin' } });
  t.db.insert(schema.userProfile).values({ userId: u.user.id, createdAt: new Date().toISOString() }).run();
});
afterAll(async () => { await t.close(); });

/** A fresh browser posting one same-origin form (with its CSRF token). */
const form = (path: string, body: Record<string, string>, o: { origin?: string } = {}) => adminClient(t).post(path, body, o);

/** Registers a DCR client for `redirectUri` and starts an authorize; returns the signed query the login page gets. */
async function authorizeQuery(redirectUri: string, applicationType: 'native' | 'web'): Promise<string> {
  const reg = await fetch(`${t.url}/auth/oauth2/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', application_type: applicationType, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }) });
  const { client_id } = (await reg.json()) as { client_id: string };
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const authz = await rawFetch(`${t.url}/auth/oauth2/authorize?${new URLSearchParams({ client_id, redirect_uri: redirectUri, response_type: 'code', scope: 'mcp', code_challenge: challenge, code_challenge_method: 'S256', state: 'st', resource: `${t.url}/mcp` })}`, { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
  return authz.headers.get('location')!.split('?')[1]!;
}

describe('/admin', () => {
  it('redirects to the login page without a session, remembering the target', async () => {
    const r = await fetch(`${t.url}/admin`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/admin/login?next=%2Fadmin');
    const page = await (await fetch(`${t.url}/admin/login?next=%2Fadmin`)).text();
    expect(page).toContain('name="next" value="/admin"');
    expect(page).toContain('name="oauth_query" value=""');
  });

  it('signs in without an OAuth flow, shows the home page, and signs out', async () => {
    const c = adminClient(t);
    const login = await c.signIn(EMAIL);
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('/admin');
    expect(c.cookie()).toContain('session_token');
    const home = await c.get('/admin');
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain(EMAIL);
    expect(html).toContain('Tomt i hyllorna! Ska vi fylla på?'); // no ICA account linked yet: the empty-shelves state
    const logout = await c.post('/admin/logout');
    expect(logout.status).toBe(302);
    expect(logout.headers.get('location')).toBe('/admin/login');
    expect(await (await c.get('/admin/login')).text()).toContain('You are signed out.');
    const after = await c.get('/admin');
    expect(after.status).toBe(302);
  });

  it('stores the theme in a cookie, renders it on <html>, and rejects unknown themes', async () => {
    const r = await form('/admin/theme', { theme: 'dark', next: 'https://evil.example/' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/admin');
    const set = r.headers.getSetCookie().find((c) => c.startsWith('ica-hub.theme='))!;
    expect(set).toMatch(/^ica-hub\.theme=dark; Max-Age=31536000; Path=\/admin; Expires=[^;]+; HttpOnly; SameSite=Lax$/);
    expect(await (await fetch(`${t.url}/admin/login`, { headers: { cookie: 'ica-hub.theme=dark' } })).text()).toContain('<html lang="en" data-theme="dark">');
    expect(await (await fetch(`${t.url}/admin/login`, { headers: { cookie: 'ica-hub.theme=evil' } })).text()).toContain('<html lang="en">');
    expect((await form('/admin/theme', { theme: 'sepia' })).status).toBe(400);
    expect((await form('/admin/theme', { theme: 'light' }, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('never redirects off-site after login', async () => {
    const login = await form('/admin/login', { email: EMAIL, password: PASSWORD, oauth_query: '', next: 'https://evil.example/' });
    expect(login.headers.get('location')).toBe('/admin');
  });

  it('sends a wrong password back to the login page with an error', async () => {
    const r = await form('/admin/login', { email: EMAIL, password: 'wrong-password-123', oauth_query: '', next: '/admin' });
    expect(r.status).toBe(302);
    expect(r.headers.getSetCookie()).toEqual([]);
    const loc = r.headers.get('location')!;
    expect(loc).toBe('/admin/login?next=%2Fadmin&error=credentials');
    expect(await (await fetch(`${t.url}${loc}`)).text()).toContain('<div class="toast toast--error" role="alert">Wrong email or password</div>');
  });

  it('keeps the oauth query intact across a failed sign-in, without our error param', async () => {
    const r = await form('/admin/login', { email: EMAIL, password: PASSWORD, oauth_query: 'a=1&sig=abc' });
    expect(r.status).toBe(302); // forged signature: Better Auth rejects it with invalid_signature
    const loc = r.headers.get('location')!;
    expect(loc).toBe('/admin/login?a=1&sig=abc&error=failed');
    const page = await (await fetch(`${t.url}${loc}`)).text();
    expect(page).toContain('<div class="toast toast--error" role="alert">Sign-in failed</div>');
    expect(page).toContain('name="oauth_query" value="a=1&amp;sig=abc"');
  });

  it('shows only fixed messages for known error codes, never the query text', async () => {
    const page = async (q: string) => (await fetch(`${t.url}/admin/login?${q}`)).text();
    expect(await page('error=rate')).toContain('<div class="toast toast--error" role="alert">Too many sign-in attempts. Try again later.</div>');
    for (const q of ['error=Call+0701234567+to+unlock+your+account', 'error=constructor', 'error=toString', 'error=']) {
      const html = await page(q);
      expect(html).not.toContain('toast--error');
      expect(html).not.toContain('0701234567');
    }
  });

  it('does not treat a query without a signature as an OAuth query', async () => {
    const page = await (await fetch(`${t.url}/admin/login?foo=bar`)).text();
    expect(page).toContain('name="oauth_query" value=""');
  });

  it('rejects cross-site form posts', async () => {
    const r = await form('/admin/login', { email: EMAIL, password: PASSWORD }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
  });

  it('requires a session for the consent page', async () => {
    const r = await rawFetch(`${t.url}/admin/consent?client_id=x&scope=mcp`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^\/admin\/login\?next=/);
  });

  it('accepts a same-origin form post', async () => {
    const r = await form('/admin/login', { email: EMAIL, password: PASSWORD, oauth_query: '' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/admin');
  });

  it('shows where the code goes and flags a self-registered client on the consent page', async () => {
    const loginQuery = await authorizeQuery('http://127.0.0.1/cb', 'native');
    const c = adminClient(t);
    const login = await c.post('/admin/login', { email: EMAIL, password: PASSWORD, oauth_query: loginQuery });
    const consentLoc = login.headers.get('location')!;
    expect(consentLoc).toMatch(/^\/admin\/consent\?/);
    const consent = await c.get(consentLoc);
    expect(consent.headers.get('content-security-policy')).toContain("form-action 'self' http://127.0.0.1;");
    const html = await consent.text();
    expect(html).toContain('<h2 class="consent-client wrap-anywhere">Claude</h2>');
    expect(html).toContain('The access code will be sent to: <strong>127.0.0.1</strong>');
    expect(html).toContain('This app registered itself and has not been verified');
    expect(html).toContain('Use your ICA data through ICA-MCP&#39;s tools');
    expect(await (await c.get('/admin')).text()).toContain('<span class="badge badge--neutral">Not connected</span>');
    const allow = await c.post('/admin/consent', { accept: 'yes', oauth_query: consentLoc.split('?')[1]! });
    expect(allow.headers.get('location')).toMatch(/^http:\/\/127\.0\.0\.1\/cb\?code=/);
    const home = await (await c.get('/admin')).text();
    expect(home).toContain('<span class="badge badge--ok">Connected · 1 app</span>');
    expect(home).not.toContain('Tomt i hyllorna'); // something is connected now
  });

  it('never adds an unregistered redirect_uri from a forged query to form-action', async () => {
    const clientId = new URLSearchParams(await authorizeQuery('http://127.0.0.1/cb', 'native')).get('client_id')!;
    const forged = (redirect: string, client = clientId) => new URLSearchParams({ client_id: client, redirect_uri: redirect, scope: 'mcp', sig: 'x' }).toString();
    const csp = (r: Response) => /form-action [^;]*;/.exec(r.headers.get('content-security-policy')!)![0];
    const anon = adminClient(t);
    for (const q of [forged('https://evil.example/cb'), forged('https://evil.example/cb', 'no-such-client'), forged('http://127.0.0.1;script-src/cb'), forged('http://127.0.0.1,evil/cb')]) {
      expect(csp(await anon.get(`/admin/login?${q}`)), q).toBe("form-action 'self';");
    }
    const unknown = await (await anon.get(`/admin/login?${forged('https://evil.example/cb', 'no-such-client')}`)).text();
    expect(unknown).not.toContain('finish connecting'); // no "continuing for an app" hint without a known client
    expect(await (await anon.get(`/admin/login?${forged('https://evil.example/cb')}`)).text()).toContain('Sign in to finish connecting the app that sent you here.');
    const c = adminClient(t); await c.signIn(EMAIL);
    for (const q of [forged('https://evil.example/cb'), forged('https://evil.example/cb', 'no-such-client'), forged('http://127.0.0.1;script-src/cb')]) {
      expect(csp(await c.get(`/admin/consent?${q}`)), q).toBe("form-action 'self';");
    }
    expect(csp(await c.get(`/admin/consent?${forged('http://127.0.0.1/cb')}`))).toBe("form-action 'self' http://127.0.0.1;"); // registered
  });

  it('lets the OAuth-continuing login page post on to the client\'s redirect origin', async () => {
    const loginQuery = await authorizeQuery('https://claude.ai/api/mcp/auth_callback', 'web');
    const r = await adminClient(t).get(`/admin/login?${loginQuery}`);
    expect(r.headers.get('content-security-policy')).toContain("form-action 'self' https://claude.ai;");
    expect((await adminClient(t).get('/admin/login')).headers.get('content-security-policy')).toContain("form-action 'self';");
  });

  it('redirects / to /admin', async () => {
    const r = await fetch(`${t.url}/`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/admin');
  });
});

describe('sign-in with Better Auth\'s origin check enabled (as in production)', () => {
  // Own app: the shared one's per-IP login limiter is already partly used up by the tests above.
  let o: TestCtx;
  beforeAll(async () => {
    o = await startTestApp();
    await o.auth.api.createUser({ body: { email: EMAIL, password: PASSWORD, name: 'Admin', role: 'admin' } });
  });
  afterAll(async () => { await o.close(); });

  it('is really on in tests (Better Auth would skip it under vitest by default)', async () => {
    expect((await o.auth.$context).skipOriginCheck).toBe(false);
  });

  it('signs in again while already holding a session cookie', async () => {
    const c = adminClient(o);
    const first = await c.signIn(EMAIL);
    expect(first.headers.get('location')).toBe('/admin');
    const second = await c.signIn(EMAIL);
    expect(second.status).toBe(302);
    expect(second.headers.get('location')).toBe('/admin');
    expect((await c.get('/admin')).status).toBe(200);
  });

  it('signs in with a stale session cookie', async () => {
    const c = adminClient(o);
    await c.signIn(EMAIL);
    o.db.delete(schema.session).run(); // the browser's session cookie now points at nothing
    expect((await c.get('/admin')).status).toBe(302);
    const r = await c.signIn(EMAIL);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/admin');
    expect((await c.get('/admin')).status).toBe(200);
  });

  it('records Express\'s req.ip on the session, never a client-sent forwarding header', async () => {
    // A hand-built POST: adminClient cannot send the spoofed forwarding headers this test is about.
    const c = adminClient(o);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await c.get('/admin/login')).text())![1]!;
    const r = await rawFetch(`${o.url}/admin/login`, {
      method: 'POST',
      headers: { cookie: c.cookie(), origin: o.url, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.9', 'x-ica-hub-client-ip': '198.51.100.9' },
      body: new URLSearchParams({ email: EMAIL, password: PASSWORD, oauth_query: '', _csrf: csrf }).toString(),
    });
    const token = /session_token=([^.;]+)/.exec(r.headers.getSetCookie().join(';'))![1]!;
    const row = o.db.select().from(schema.session).all().find((s) => s.token === token)!;
    expect(row.ipAddress).toBe('127.0.0.1');
  });
});

describe('/admin/login rate limit', () => {
  it('answers the 11th attempt from the same IP with 429 and Retry-After', async () => {
    const app = await startTestApp();
    try {
      const c = adminClient(app);
      const post = (i: number) => c.post('/admin/login', { email: `nobody${i}@example.com`, password: 'wrong-password-123', oauth_query: '' });
      for (let i = 0; i < 10; i++) expect((await post(i)).status).toBe(302);
      const r = await post(10);
      expect(r.status).toBe(429);
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await r.text()).toContain('Too many sign-in attempts');
    } finally { await app.close(); }
  });
});
