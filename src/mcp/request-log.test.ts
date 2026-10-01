import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { logSafeName } from './request-log.js';
import { adminClient, captureLogs, connectClaude, mcpPing, rpcJson, startTestApp, TEST_PASSWORD, type TestCtx } from '../test-helpers.js';

type Line = Record<string, unknown> & { msg?: string; level?: number };
const parse = (lines: string[]): Line[] => lines.map((l) => JSON.parse(l) as Line);
const WARN = 40;

let t: TestCtx;
const logs: string[] = [];
let accessToken: string;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  // A fresh app: the very first /mcp request below is a tools/call, with no warm-up call before it.
  t = await startTestApp({}, { log: captureLogs(logs) });
  await t.auth.api.createUser({ body: { email: 'owner@example.com', password: TEST_PASSWORD, name: 'Owner', role: 'member' } });
  ({ accessToken } = await connectClaude(t, adminClient(t), { email: 'owner@example.com' }));
});
afterAll(async () => { await t.close(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('/mcp token verification without the public-URL JWKS hairpin', () => {
  it('the first tools/call after app start succeeds while our public JWKS URL is unreachable', async () => {
    const jwksFetches: string[] = [];
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/jwks')) { jwksFetches.push(url); return Promise.reject(new TypeError('fetch failed')); }
      return realFetch(input, init);
    });
    const r = await mcpPing(t, accessToken);
    expect(r.status).toBe(200);
    const msg = await rpcJson<{ result?: { isError?: boolean } }>(r);
    expect(msg.result?.isError).not.toBe(true);
    expect(jwksFetches).toEqual([]);
  });
});

describe('/mcp request logging', () => {
  it('logs start and finish of a tools/call with the JSON-RPC method and tool name', async () => {
    logs.length = 0;
    expect((await mcpPing(t, accessToken)).status).toBe(200);
    const mcp = parse(logs).filter((l) => l.mcp === 'request');
    expect(mcp).toHaveLength(2);
    expect(mcp[0]).toMatchObject({ method: 'tools/call', tool: 'ping', msg: 'mcp request start' });
    expect(mcp[1]).toMatchObject({ method: 'tools/call', tool: 'ping', status: 200, msg: 'mcp request finish' });
    expect(mcp[1]!.ms).toEqual(expect.any(Number));
    expect(logs.join('\n')).not.toContain(accessToken);
  });

  it('a bad token logs a finish line and a warn with reason invalid_token, and never the token', async () => {
    logs.length = 0;
    const bad = `${accessToken.slice(0, -4)}AAAA`;
    expect((await mcpPing(t, bad)).status).toBe(401);
    const lines = parse(logs);
    expect(lines.find((l) => l.mcp === 'request')).toMatchObject({ status: 401 });
    const warn = lines.find((l) => l.mcp === 'rejected');
    expect(warn).toMatchObject({ level: WARN, reason: 'invalid_token', status: 401 });
    expect(logs.join('\n')).not.toContain(bad);
    expect(logs.join('\n')).not.toContain(accessToken);
  });

  it('a request without a token logs a warn with reason missing_token', async () => {
    logs.length = 0;
    const r = await fetch(`${t.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(parse(logs).find((l) => l.mcp === 'rejected')).toMatchObject({ level: WARN, reason: 'missing_token', status: 401 });
  });

  it('a revoked grant logs reason revoked with the client id and user id', async () => {
    const c = adminClient(t);
    await t.auth.api.createUser({ body: { email: 'rev@example.com', password: TEST_PASSWORD, name: 'Rev', role: 'member' } });
    const g = await connectClaude(t, c, { email: 'rev@example.com' });
    const { revokeOAuthGrants } = await import('../users/grants.js');
    const userId = (t.db.$client.prepare('select id from user where email = ?').get('rev@example.com') as { id: string }).id;
    revokeOAuthGrants(t.db, userId, g.clientId);
    logs.length = 0;
    expect((await mcpPing(t, g.accessToken)).status).toBe(401);
    expect(parse(logs).find((l) => l.mcp === 'rejected')).toMatchObject({ reason: 'revoked', clientId: g.clientId, userId, status: 401 });
  });

  it('a token without the mcp scope logs reason insufficient_scope (403)', async () => {
    await t.auth.api.createUser({ body: { email: 'noscope@example.com', password: TEST_PASSWORD, name: 'NoScope', role: 'member' } });
    const g = await connectClaude(t, adminClient(t), { email: 'noscope@example.com', scope: 'offline_access' });
    logs.length = 0;
    expect((await mcpPing(t, g.accessToken)).status).toBe(403);
    expect(parse(logs).find((l) => l.mcp === 'rejected')).toMatchObject({ level: WARN, reason: 'insufficient_scope', clientId: g.clientId, status: 403 });
  });

  it('logs method and tool names with anything outside [\\w./:-] replaced (newline, ESC, U+2028) and capped at 100', async () => {
    logs.length = 0;
    const tool = 'ping\n{"level":50}\u001b[31m\u2028x';
    const r = await fetch(`${t.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} } }),
    });
    await r.text();
    const finish = parse(logs).find((l) => l.msg === 'mcp request finish');
    expect(finish?.tool).toBe('ping___level_:50___31m_x');
    expect(logs.join('')).not.toContain('\u001b');
    expect(logSafeName('tools/call')).toBe('tools/call');
    expect(logSafeName('a\nb\u001bc\u2028d é')).toBe('a_b_c_d__');
    expect(logSafeName('https://claude.ai/x.y-z_1')).toBe('https://claude.ai/x.y-z_1');
    expect(logSafeName('x'.repeat(150))).toHaveLength(100);
  });

  it('writes exactly one finish line (aborted: true) when the client aborts mid-request', async () => {
    logs.length = 0;
    const req = httpRequest(`${t.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}`, 'content-length': '1000' },
    });
    req.on('error', () => undefined);
    req.write('{"jsonrpc":"2.0",');
    await new Promise((r) => setTimeout(r, 150)); // past the bearer check, the body parser waits for the rest
    req.destroy();
    const finishes = () => parse(logs).filter((l) => l.msg === 'mcp request finish');
    for (let i = 0; i < 100 && finishes().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    expect(finishes()).toHaveLength(1);
    expect(finishes()[0]).toMatchObject({ aborted: true, http: 'POST' });
    expect(parse(logs).filter((l) => l.mcp === 'rejected')).toEqual([]);
    expect(logs.join('\n')).not.toContain(accessToken);
  });

  it('a normal request, which emits both finish and close, still writes one finish line', async () => {
    logs.length = 0;
    await (await mcpPing(t, accessToken)).text();
    await new Promise((r) => setTimeout(r, 50));
    expect(parse(logs).filter((l) => l.msg === 'mcp request finish')).toHaveLength(1);
  });
});
