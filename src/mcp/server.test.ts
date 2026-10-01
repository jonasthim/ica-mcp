import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/index.js';
import { mcpErrorLogger, userIdOf } from './server.js';
import { adminClient, captureLogs, connectClaude, mcpPing, rawFetch, rpcJson, seedUser, startTestApp, TEST_PASSWORD as PASSWORD, type TestCtx } from '../test-helpers.js';

let t: TestCtx;
const EMAIL = 'owner@example.com';
beforeAll(async () => {
  t = await startTestApp();
  const u = await t.auth.api.createUser({ body: { email: EMAIL, password: PASSWORD, name: 'Owner', role: 'admin' } });
  t.db.insert(schema.userProfile).values({ userId: u.user.id, createdAt: new Date().toISOString() }).run();
});
afterAll(async () => { await t.close(); });

const q = (loc: string) => loc.split('?')[1] ?? '';

/** Steps 1–3 of the OAuth flow: DCR, authorize, sign in; returns the signed-in browser at the consent page. */
async function toConsent(): Promise<{ browser: ReturnType<typeof adminClient>; consentLoc: string; client_id: string; verifier: string }> {
  // 1. DCR
  const reg = await fetch(`${t.url}/auth/oauth2/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'test', application_type: 'native', redirect_uris: ['http://127.0.0.1/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  const { client_id } = (await reg.json()) as { client_id: string };
  // 2. authorize (no session) → 302 to /admin/login?<signed query>
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authz = await rawFetch(`${t.url}/auth/oauth2/authorize?${new URLSearchParams({ client_id, redirect_uri: 'http://127.0.0.1/cb', response_type: 'code', scope: 'mcp offline_access', code_challenge: challenge, code_challenge_method: 'S256', state: 'st', resource: `${t.url}/mcp` })}`, { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
  expect(authz.status).toBe(302);
  const loginLoc = authz.headers.get('location')!;
  expect(loginLoc.startsWith(`${t.url}/admin/login?`) || loginLoc.startsWith('/admin/login?')).toBe(true);
  // 3. login form POST with oauth_query (a browser: cookies, Origin, CSRF token) → 302 to consent
  const browser = adminClient(t);
  const login = await browser.post('/admin/login', { email: EMAIL, password: PASSWORD, oauth_query: q(loginLoc) });
  expect(login.status).toBe(302);
  const consentLoc = login.headers.get('location')!;
  expect(consentLoc).toMatch(/\/admin\/consent\?/);
  return { browser, consentLoc, client_id, verifier };
}

const auditEvents = (action: string) => t.db.select().from(schema.auditEvent).all()
  .filter((e) => e.action === action).map((e) => ({ ...e, details: JSON.parse(e.detailsJson) as Record<string, unknown> }));

/** The full OAuth flow (DCR, authorize, sign-in, consent, token) through `connectClaude`, checking the consent audit. */
async function obtainAccessToken(): Promise<string> {
  const { clientId, accessToken, refreshToken } = await connectClaude(t, adminClient(t), { email: EMAIL });
  expect(refreshToken).toBeTruthy();
  // the grant is audited against the client, with the granted scopes
  const granted = auditEvents('oauth.consent_granted').filter((e) => e.targetId === clientId);
  expect(granted).toHaveLength(1);
  expect(granted[0]).toMatchObject({ targetType: 'oauth_client', outcome: 'success', details: { clientName: 'test' } });
  expect(granted[0]!.actorUserId).toBeTruthy();
  expect(granted[0]!.details.scopes).toContain('mcp');
  return accessToken;
}

const rpc = (token: string | null, body: unknown) => fetch(`${t.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

describe('/mcp', () => {
  it('returns 401 with resource metadata when unauthenticated', async () => {
    const r = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${t.url}/.well-known/oauth-protected-resource/mcp"`);
  });
  it('rejects a garbage token with 401', async () => {
    const r = await rpc('nope', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    expect(r.status).toBe(401);
  });
  it('rejects a wrong Host header with 421', async () => {
    const r = await rawFetch(`${t.url}/mcp`, { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(421);
  });
  it('lists and calls ping with a real token from the full OAuth flow', async () => {
    const token = await obtainAccessToken();
    expect((await mcpPing(t, token)).status).toBe(200);
    const init = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    expect(init.status).toBe(200);
    await rpcJson(init);
    const list = await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const lj = await rpcJson<{ result: { tools: { name: string }[] } }>(list);
    expect(lj.result.tools.map((x) => x.name)).toContain('ping');
    const call = await rpc(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping', arguments: {} } });
    const cj = await rpcJson<{ result: { content: { type: string; text: string }[] } }>(call);
    const payload = JSON.parse(cj.result.content[0]!.text) as { ok: boolean; userId: string };
    expect(payload.ok).toBe(true);
    expect(payload.userId).not.toBe('unknown');
  });
  it('audits a denied consent, and nothing for a tampered consent query', async () => {
    const { browser, consentLoc, client_id } = await toConsent();
    const tampered = q(consentLoc).replace(/scope=[^&]*/, 'scope=mcp+openid');
    expect((await browser.post('/admin/consent', { accept: 'yes', oauth_query: tampered })).status).not.toBe(302);
    expect(auditEvents('oauth.consent_granted').filter((e) => e.targetId === client_id)).toHaveLength(0);
    const deny = await browser.post('/admin/consent', { accept: 'no', oauth_query: q(consentLoc) });
    expect(deny.status).toBe(302);
    const denied = auditEvents('oauth.consent_denied').filter((e) => e.targetId === client_id);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ targetType: 'oauth_client', details: { clientName: 'test' } });
  });
});

/** A server-signed JWS from the same key set as real access tokens; claims default to a valid /mcp token. */
const signToken = async (claims: Record<string, unknown> = {}): Promise<string> =>
  (await t.auth.api.signJWT({ body: { payload: { sub: 'signed-user', azp: 'test-client', scope: 'mcp', iat: Math.floor(Date.now() / 1000), iss: `${t.url}/auth`, aud: `${t.url}/mcp`, ...claims } } })).token;
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };
/** First JSON-RPC message of a response that may be JSON or SSE (legacy 2025-era responses are SSE). */
const firstMessage = async (r: Response): Promise<{ result?: { content?: { text: string }[] } }> => {
  const text = await r.text();
  const data = text.trimStart().startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? '';
  return JSON.parse(data) as { result?: { content?: { text: string }[] } };
};

describe('/mcp token verification and body handling', () => {
  // A signed token is only accepted while a live grant backs it: the user exists, is not disabled, and allowed the client.
  beforeAll(() => {
    const now = new Date();
    seedUser(t.db, 'signed-user');
    t.db.insert(schema.oauthClient).values({ id: 'test-client', clientId: 'test-client', name: 'test', redirectUris: ['http://127.0.0.1/cb'] }).run();
    // Allowed a minute ago, so tokens signed now (iat = now) postdate the grant.
    const since = new Date(now.getTime() - 60_000);
    t.db.insert(schema.oauthConsent).values({ id: 'signed-consent', clientId: 'test-client', userId: 'signed-user', scopes: ['mcp'], createdAt: since, updatedAt: since }).run();
  });
  it('rejects a correctly signed token without a grant behind it with 401 invalid_token', async () => {
    for (const claims of [{ sub: 'nobody' }, { azp: 'other-client' }, { azp: undefined }]) {
      const r = await rpc(await signToken(claims), INIT);
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toContain('invalid_token');
    }
  });
  it('accepts a correctly signed token and ping reports its subject (control for the negative cases)', async () => {
    const token = await signToken();
    expect((await rpc(token, INIT)).status).toBe(200);
    const call = await rpc(token, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping', arguments: {} } });
    expect(call.status).toBe(200);
    const msg = await firstMessage(call);
    expect(JSON.parse(msg.result!.content![0]!.text)).toMatchObject({ ok: true, userId: 'signed-user' });
  });
  it('rejects a token with the wrong audience with 401 invalid_token', async () => {
    const r = await rpc(await signToken({ aud: `${t.url}/auth` }), INIT);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('invalid_token');
  });
  it('rejects a token with the wrong issuer with 401 invalid_token', async () => {
    const r = await rpc(await signToken({ iss: 'https://evil.example/auth' }), INIT);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('invalid_token');
  });
  it('rejects an expired token with 401 invalid_token', async () => {
    const r = await rpc(await signToken({ iat: Math.floor(Date.now() / 1000) - 3600, exp: Math.floor(Date.now() / 1000) - 60 }), INIT);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('invalid_token');
  });
  it('answers an unauthenticated malformed JSON body with 401 and the resource metadata challenge', async () => {
    const r = await fetch(`${t.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{bad' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain(`resource_metadata="${t.url}/.well-known/oauth-protected-resource/mcp"`);
  });
  it('answers an authenticated malformed JSON body with 400, not 500', async () => {
    const r = await fetch(`${t.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${await signToken()}` }, body: '{bad' });
    expect(r.status).toBe(400);
  });
  it('rejects a token without the mcp scope with 403 insufficient_scope', async () => {
    const r = await rpc(await signToken({ scope: 'openid profile' }), INIT);
    expect(r.status).toBe(403);
    expect(r.headers.get('www-authenticate')).toContain('insufficient_scope');
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata="');
  });
  it('rejects a scope that merely contains "mcp" as a substring with 403 insufficient_scope (exact match, not substring)', async () => {
    for (const scope of ['mcp_admin', 'notmcp']) {
      const r = await rpc(await signToken({ scope }), INIT);
      expect(r.status).toBe(403);
      expect(r.headers.get('www-authenticate')).toContain('insufficient_scope');
    }
  });
  it('accepts a Better Auth-issued token from the real OAuth flow, including after a refresh', async () => {
    const { accessToken, refreshToken, clientId } = await connectClaude(t, adminClient(t), { email: EMAIL });
    expect((await rpc(accessToken, INIT)).status).toBe(200);
    const refreshed = await fetch(`${t.url}/auth/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
    });
    expect(refreshed.status).toBe(200);
    const { access_token: refreshedAccessToken } = (await refreshed.json()) as { access_token: string };
    expect((await rpc(refreshedAccessToken, INIT)).status).toBe(200);
  });
});

describe('userIdOf', () => {
  it('returns the verified user id', () => {
    expect(userIdOf({ http: { authInfo: { extra: { userId: 'u1' } } } })).toBe('u1');
  });
  it('fails closed when there is no authenticated user', () => {
    expect(() => userIdOf({})).toThrow('no authenticated user in MCP context');
    expect(() => userIdOf({ http: { authInfo: { extra: {} } } })).toThrow('no authenticated user in MCP context');
  });
});

describe('mcpErrorLogger', () => {
  it('logs the error name and message, never the stack', () => {
    const lines: unknown[] = [];
    mcpErrorLogger({ warn: (o: unknown) => { lines.push(o); } })(Object.assign(new Error('boom'), { stack: 'STACK-DETAIL' }));
    expect(lines).toEqual([{ err: { name: 'Error', message: 'boom' } }]);
  });

  it('never logs a SyntaxError\'s own message: V8 embeds a snippet of the parsed text, i.e. the request body', () => {
    const lines: unknown[] = [];
    let caught: Error | undefined;
    try { JSON.parse('not json SECRET_XYZ'); } catch (e) { caught = e as Error; }
    expect(caught?.message).toContain('SECRET_XYZ'); // sanity: this is exactly the leak the fix closes
    mcpErrorLogger({ warn: (o: unknown) => { lines.push(o); } })(caught!);
    expect(lines).toEqual([{ err: { name: 'SyntaxError', message: 'invalid JSON body' } }]);
    expect(JSON.stringify(lines)).not.toContain('SECRET_XYZ');
    expect(JSON.stringify(lines)).not.toContain('not json');
  });

  it('caps a long message instead of trusting it to be short', () => {
    const lines: { err: { message: string } }[] = [];
    mcpErrorLogger({ warn: (o: unknown) => { lines.push(o as { err: { message: string } }); } })(new Error('x'.repeat(500)));
    expect(lines[0]!.err.message).toHaveLength(200);
    expect(lines[0]!.err.message).toBe('x'.repeat(200));
  });

  it('is wired: a request the MCP handler rejects (valid JSON, not a JSON-RPC envelope) is logged, through the real app with a valid mcp-scoped token', async () => {
    const lines: string[] = [];
    const o = await startTestApp({}, { log: captureLogs(lines) });
    try {
      seedUser(o.db, 'u');
      o.db.insert(schema.oauthClient).values({ id: 'c', clientId: 'c', name: 'c', redirectUris: ['http://127.0.0.1/cb'] }).run();
      const since = new Date(Date.now() - 60_000);
      o.db.insert(schema.oauthConsent).values({ id: 'cc', clientId: 'c', userId: 'u', scopes: ['mcp'], createdAt: since, updatedAt: since }).run();
      const token = (await o.auth.api.signJWT({ body: { payload: { sub: 'u', azp: 'c', scope: 'mcp', iat: Math.floor(Date.now() / 1000), iss: `${o.url}/auth`, aud: `${o.url}/mcp` } } })).token;
      // A well-formed JSON body that is not a JSON-RPC envelope: express.json() parses it fine (so this never reaches
      // the app's own generic error handler), and the MCP handler's top-level request classification rejects it and
      // calls its wired onerror — unlike a syntactically malformed body, which express.json() itself rejects before
      // the request ever reaches the MCP handler (verified: that case logs "client error" from server.ts, not
      // mcpErrorLogger, so it would not exercise this wiring).
      const r = await fetch(`${o.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ not: 'a jsonrpc message' }) });
      expect(r.status).toBe(400);
      const warnLines = lines.filter((l) => l.includes('"msg":"mcp error"'));
      expect(warnLines).toHaveLength(1);
      const parsed = JSON.parse(warnLines[0]!) as { err: { name: string; message: string } };
      expect(parsed.err.name).toBe('Error');
      expect(parsed.err.message).not.toContain('jsonrpc message');
    } finally { await o.close(); }
  });
});
