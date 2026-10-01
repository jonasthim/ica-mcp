import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_AUTH_ROUTES, PUBLIC_WELL_KNOWN } from './public-surface.js';
import { adminClient, rawFetch, startTestApp, TEST_PASSWORD, type TestCtx } from '../test-helpers.js';

let t: TestCtx; let adminCookie = '';
beforeAll(async () => {
  t = await startTestApp({ OIDC_ISSUER_URL: 'http://127.0.0.1:9/app/', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's' });
  await t.auth.api.createUser({ body: { email: 'root@example.com', password: TEST_PASSWORD, name: 'Root', role: 'admin' } });
  const c = adminClient(t);
  await c.signIn('root@example.com');
  adminCookie = c.cookie();
});

/**
 * A request with a RAW request target: node:http sends `path` byte for byte, whereas a URL string (fetch, rawFetch)
 * is normalised on the client first (`..` resolved), which would hide exactly the traversal under test.
 */
const rawTarget = (method: string, path: string, o: { cookie?: string; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; setCookie: string[]; body: string }> =>
  new Promise((resolve, reject) => {
    const u = new URL(t.url);
    const headers: Record<string, string> = { origin: t.url, 'content-type': 'application/json', ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers };
    if (o.body !== undefined) headers['content-length'] = String(Buffer.byteLength(o.body));
    const req = request({ host: u.hostname, port: u.port, method, path, headers, setHost: !o.headers?.host }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, setCookie: ([] as string[]).concat(res.headers['set-cookie'] ?? []), body: Buffer.concat(chunks).toString('utf8') }); });
    });
    req.on('error', reject);
    req.end(o.body);
  });
afterAll(async () => { await t.close(); });

describe('public Better Auth HTTP surface', () => {
  it('404s every Better Auth endpoint (under /auth, including its /.well-known documents) that is not on the allow-list', async () => {
    const allowed = new Set<string>(PUBLIC_AUTH_ROUTES.map((r) => r.path));
    const endpoints = Object.values(t.auth.api as Record<string, { path?: string; options?: { method?: string | string[] } }>)
      .filter((e) => e.path && !allowed.has(e.path));
    expect(endpoints.length).toBeGreaterThan(40);
    for (const e of endpoints) {
      const methods = ([] as string[]).concat(e.options?.method ?? 'GET');
      for (const m of methods) {
        const path = `/auth${e.path!.replace(/:(\w+)/g, 'x')}`;
        const r = await rawFetch(`${t.url}${path}`, { method: m, headers: { 'content-type': 'application/json', origin: t.url }, body: m === 'GET' ? undefined : '{}' });
        expect(r.status, `${m} ${path}`).toBe(404);
      }
    }
  });

  it.each(['/auth/sign-in/email', '/auth/sign-in/social', '/auth/sign-up/email', '/auth/SIGN-IN/email', '/auth//sign-in/email', '/auth/sign-in/email/', '/auth/JWKS', '/auth//jwks', '/auth/jwks/'])('has no POST/GET %s (sign-in is server-side only; path variants never match)', async (path) => {
    for (const method of ['GET', 'POST']) {
      const r = await rawFetch(`${t.url}${path}`, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' }, body: method === 'GET' ? undefined : JSON.stringify({ email: 'a@example.com', password: TEST_PASSWORD, name: 'x', provider: 'upstream' }) });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.headers.getSetCookie()).toEqual([]);
    }
  });

  it('404s every /.well-known document that is not on the allow-list', async () => {
    for (const p of ['/.well-known/openid-configuration', '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration/auth', '/.well-known/x']) {
      expect((await rawTarget('GET', p)).status, p).toBe(404);
    }
  });

  it.each([
    ['POST', '/.well-known/../auth/sign-in/email'],
    ['POST', '/.well-known/%2e%2e/auth/sign-in/email'],
    ['POST', '/.well-known/%2E%2E/auth/sign-in/email'],
    ['POST', '/auth/callback/..\\sign-in\\email'],
    ['POST', '/auth/callback/%2e%2e/sign-in/email'],
    ['POST', '/auth/callback/x%2f..%2f..%2fsign-in%2femail'],
    ['POST', '/auth/callback/x%5c..%5csign-in%5cemail'],
    ['POST', '/auth/./sign-in/email'],
    ['POST', '/auth/oauth2/../sign-in/email'],
    ['GET', '/auth/callback/..\\admin\\list-users'],
    ['GET', '/.well-known/../auth/admin/list-users'],
    ['GET', '/auth/callback/..\\list-sessions'],
    ['POST', '/auth/callback/..\\update-user'],
    ['GET', '/auth/./jwks'],
    ['GET', '/auth/%6Awks'],
  ])('refuses the path-normalisation bypass %s %s (404, no cookie)', async (method, path) => {
    const body = method === 'POST' ? JSON.stringify({ email: 'root@example.com', password: TEST_PASSWORD, name: 'x' }) : undefined;
    for (const cookie of [undefined, adminCookie]) {
      const r = await rawTarget(method, path, { cookie, body });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.setCookie).toEqual([]);
    }
  });

  describe('URL-building headers (better-call routes on X-Forwarded-Proto/Host + path)', () => {
    const host = () => new URL(t.url).host;
    const signInBody = () => JSON.stringify({ email: 'root@example.com', password: TEST_PASSWORD });
    it.each([
      ['POST', '/auth/callback/x', (h: string) => `${h}/auth/sign-in/email#`],
      ['POST', '/auth/callback/x', (h: string) => `${h}/auth/sign-in/email?`],
      ['POST', '/auth/oauth2/token', (h: string) => `${h}/auth/sign-in/email#`],
      ['GET', '/auth/jwks', (h: string) => `${h}/auth/admin/list-users#`],
      ['GET', '/.well-known/oauth-protected-resource', (h: string) => `${h}/auth/admin/list-users#`],
      ['GET', '/auth/jwks', (h: string) => `evil@${h}`],
      ['GET', '/auth/jwks', (h: string) => `${h}:1`],
      ['GET', '/auth/jwks', (h: string) => `${h}/`],
      ['GET', '/auth/jwks', () => 'evil.example'],
    ])('answers %s %s with a forged Host with 421 and no cookie', async (method, path, forge) => {
      for (const cookie of [undefined, adminCookie]) {
        const r = await rawTarget(method, path, { cookie, headers: { host: forge(host()) }, body: method === 'POST' ? signInBody() : undefined });
        expect(r.status, `${method} ${path}`).toBe(421);
        expect(r.setCookie).toEqual([]);
      }
    });

    it('ignores X-Forwarded-Proto and X-Forwarded-Host carrying a URL/path: Better Auth routes on the public URL', async () => {
      const forged: Record<string, string>[] = [
        { 'x-forwarded-proto': `http://${host()}/auth/admin/list-users#` },
        { 'x-forwarded-proto': 'https' },
        { 'x-forwarded-host': `${host()}/auth/admin/list-users#` },
        { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': `http://${host()}/auth/sign-in/email?` },
      ];
      for (const headers of forged) {
        // JWKS stays JWKS (never the admin user list), even with an admin cookie.
        const jwks = await rawTarget('GET', '/auth/jwks', { cookie: adminCookie, headers });
        expect(jwks.status, JSON.stringify(headers)).toBe(200);
        expect(JSON.parse(jwks.body)).toHaveProperty('keys');
        expect(jwks.body).not.toContain('root@example.com');
        // The token endpoint and the OIDC callback answer as themselves, never with a session.
        const tok = await rawTarget('POST', '/auth/oauth2/token', { headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=x' });
        expect(tok.status).toBe(400);
        expect(tok.setCookie).toEqual([]);
        const cb = await rawTarget('POST', '/auth/callback/upstream', { headers, body: signInBody() });
        expect(cb.status).toBe(302);
        expect(cb.setCookie.filter((c) => c.includes('session_token'))).toEqual([]);
      }
    });
  });

  it('lets every allow-listed endpoint through to Better Auth', async () => {
    const targets = [
      ...PUBLIC_AUTH_ROUTES.map((r) => ({ method: r.method as string, path: `/auth${r.path.replace(':id', 'upstream')}` })),
      ...PUBLIC_WELL_KNOWN.map((path) => ({ method: 'GET', path })),
    ];
    for (const { method, path } of targets) {
      const r = await rawFetch(`${t.url}${path}`, { method, headers: { origin: t.url, 'content-type': 'application/x-www-form-urlencoded' }, body: method === 'POST' ? '' : undefined });
      expect(r.status, `${method} ${path}`).not.toBe(404);
    }
    for (const path of ['/auth/.well-known/oauth-authorization-server', '/auth/.well-known/openid-configuration', ...PUBLIC_WELL_KNOWN]) {
      expect((await rawTarget('GET', path)).status, path).toBe(200);
    }
  });

  it('keeps discovery, JWKS, DCR, authorize, token and the OIDC callback', async () => {
    expect((await fetch(`${t.url}/.well-known/oauth-authorization-server/auth`)).status).toBe(200);
    expect((await fetch(`${t.url}/auth/jwks`)).status).toBe(200);
    expect((await fetch(`${t.url}/auth/oauth2/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'X', application_type: 'native', redirect_uris: ['http://127.0.0.1/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }) })).status).toBe(201);
    expect((await rawFetch(`${t.url}/auth/callback/upstream?state=x&code=y`)).status).toBe(302); // reaches Better Auth (state_not_found redirect)
    expect((await rawFetch(`${t.url}/auth/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=x' })).status).toBe(400);
    expect((await rawFetch(`${t.url}/auth/oauth2/authorize?client_id=nope&response_type=code`)).status).not.toBe(404);
  });

  it('keeps Better Auth\'s own origin check on: a cookie-bearing POST to an allow-listed endpoint without Origin is refused', async () => {
    await t.auth.api.createUser({ body: { email: 'o@example.com', password: TEST_PASSWORD, name: 'O', role: 'member' } });
    const c = adminClient(t);
    await c.signIn('o@example.com');
    const r = await rawFetch(`${t.url}/auth/oauth2/end-session`, { method: 'POST', headers: { cookie: c.cookie(), 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain('MISSING_OR_NULL_ORIGIN');
  });
});
