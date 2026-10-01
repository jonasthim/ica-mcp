import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { request as httpRequest, type Server } from 'node:http';
import type { Express } from 'express';
import { loadConfig, type Config } from './config.js';
import { closeDb, openDb, schema, type Db } from './db/index.js';
import type { Auth } from './auth/index.js';
import { createAuthHolder, type AuthHolder } from './auth/holder.js';
import { createCipher, type Cipher } from './crypto.js';
import { createLogger, type Logger } from './logger.js';
import { createOidcRejections } from './auth/oidc-policy.js';
import { createApp } from './server.js';
import type { IcaEndpoints } from './ica/endpoints.js';
import type { Role } from './auth/roles.js';
import { createAudit, type Audit } from './audit.js';
import { createSetup, type Setup } from './setup/state.js';
import type { AppState } from './ica/app-session.js';
import { FAKE_ALL_ROUTES, FAKE_SECRETS, fakeAppState, fakeHouseholdLists, fakeLoggedInSession, startFakeIca, type FakeIca, type FakeIcaOptions } from './ica/test-fakes.js';
import { storeWebSession } from './sessions/web-store.js';
import { storeAppSession } from './sessions/app-store.js';

/** Inserts a Better Auth `user` row directly (no session, no password) for tests that only need a valid FK target. */
export function seedUser(db: Db, id: string, o: { role?: Role; email?: string; name?: string } = {}): void {
  db.insert(schema.user).values({ id, name: o.name ?? id, email: o.email ?? `${id}@example.test`, ...(o.role ? { role: o.role } : {}) }).run();
}

/** `auth` is the holder's current instance (read on each access, so it follows a swap). */
export type TestCtx = {
  config: Config; db: Db; holder: AuthHolder; cipher: Cipher; readonly auth: Auth; audit: Audit; setup: Setup; server: Server; url: string;
  /** The Express app (e.g. `appKeeper(t.app)`). */
  app: Express;
  close: () => Promise<void>;
};

/**
 * Boots the full app on 127.0.0.1:<random>, with ICA_HUB_URL pointing at itself so JWKS/discovery work over real HTTP.
 * `seed` writes to the database before the auth instance is built (e.g. settings rows). `firstRun` opens first-run
 * setup (the gate sends every admin page to /admin/setup while no user exists); without it setup starts closed.
 * `log` replaces the silent logger for the holder, the setup state and the app (a test that inspects log lines).
 * `settingsFetchLimit` raises Settings' per-admin fetch limit for suites that test and save many times.
 * `icaRateLimit` tightens the per-user ICA call budget.
 */
export async function startTestApp(
  extraEnv: Record<string, string> = {},
  opts: { icaEndpoints?: IcaEndpoints; firstRun?: boolean; seed?: (db: Db, cipher: Cipher) => void; log?: Logger; settingsFetchLimit?: number;
    icaRateLimit?: { capacity: number; refillPerSecond: number };
    /** Handla's plain-202 retry waits; defaults to real timers (src/server.ts's default) when omitted. */
    handlaSleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<TestCtx> {
  const db = openDb(':memory:');
  const { createServer } = await import('node:http');
  // Listen first to learn the port, then build config/app with that URL and attach the app to the SAME server.
  // (Closing and re-listening on the port raced with parallel test files grabbing it.)
  const server: Server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const config = loadConfig({ ICA_HUB_URL: url, ICA_HUB_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'), ICA_HUB_AUTH_SECRET: 's'.repeat(32), DATABASE_PATH: ':memory:', PORT: String(port), LOG_LEVEL: 'silent', ...extraEnv });
  const cipher = createCipher(config.masterKey);
  opts.seed?.(db, cipher);
  const audit = createAudit(db, { warn: () => undefined });
  const oidcRejections = createOidcRejections();
  const log = opts.log ?? createLogger('silent');
  const setup = createSetup({ db, config, log, closed: !(opts.firstRun ?? false) });
  const holder = await createAuthHolder({ config, db, cipher, audit, oidcRejections, log, setup });
  const app = createApp({ config, db, auth: holder, cipher, audit, icaEndpoints: opts.icaEndpoints, oidcRejections, setup, log, settingsFetchLimit: opts.settingsFetchLimit,
    ...(opts.icaRateLimit ? { icaRateLimit: opts.icaRateLimit } : {}),
    ...(opts.handlaSleep ? { handlaSleep: opts.handlaSleep } : {}),
  });
  server.on('request', app);
  return {
    config, db, holder, cipher, audit, setup, server, url, app, get auth() { return holder.current; },
    close: async () => { await new Promise<void>((r) => server.close(() => r())); closeDb(db); },
  };
}

/**
 * Minimal fetch-alike over node:http for requests Node's fetch (undici) cannot express: it silently drops a
 * caller-set `Host` header and always sends `sec-fetch-mode: cors`, which Better Auth treats as a browser XHR
 * (JSON `{ redirect, url }` instead of a 302). Never follows redirects.
 */
export function rawFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    // node:http sends a GET/DELETE/OPTIONS body with neither Content-Length nor chunked framing, so the server would
    // read it as the next request on the socket: always frame a body explicitly.
    const headers = init.body === undefined ? init.headers : { 'content-length': String(Buffer.byteLength(init.body)), ...init.headers };
    const req = httpRequest(url, { method: init.method ?? 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
        }
        const status = res.statusCode ?? 0;
        const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
        resolve(new Response(body, { status, headers }));
      });
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

export const TEST_PASSWORD = 'correct-horse-battery';

/** A logger at `info` that appends every line (JSON text) to `lines`, for tests that assert on logging. */
export const captureLogs = (lines: string[]): Logger => createLogger('info', { write: (s: string) => { lines.push(s); } });

export type AdminClient = {
  cookie(): string;
  get(path: string): Promise<Response>;
  post(path: string, fields?: Record<string, string>, o?: { origin?: string | null; referer?: string; csrf?: string | null }): Promise<Response>;
  signIn(email: string, password?: string, extra?: Record<string, string>): Promise<Response>;
  follow(r: Response, maxHops?: number): Promise<{ res: Response; url: string }>;
};

/**
 * A browser-like client for /admin: keeps the app's cookies, sends Origin (unless `origin: null`), and posts the CSRF
 * token scraped from `csrfFrom` (default /admin/login; /admin/setup while first-run setup is open) for the current
 * cookies/session (unless `csrf` is given; `null` sends none).
 * `forwardedFor` sends that X-Forwarded-For on every app request: with TRUST_PROXY set it is the client's IP, so
 * tests with many sign-ins can give each client its own per-IP rate-limit budget.
 */
export function adminClient(t: TestCtx, o: { forwardedFor?: string; csrfFrom?: string } = {}): AdminClient {
  const xff: Record<string, string> = o.forwardedFor ? { 'x-forwarded-for': o.forwardedFor } : {};
  const jar = new Map<string, string>();
  const store = (r: Response): Response => {
    for (const c of r.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair!.indexOf('='); const name = pair!.slice(0, i).trim(); const value = pair!.slice(i + 1);
      if (attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === '') jar.delete(name); else jar.set(name, value);
    }
    return r;
  };
  const cookie = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const get = async (path: string): Promise<Response> => store(await fetch(`${t.url}${path}`, { redirect: 'manual', headers: { cookie: cookie(), accept: 'text/html', ...xff } }));
  const token = async (): Promise<string> => /name="_csrf" value="([^"]+)"/.exec(await (await get(o.csrfFrom ?? '/admin/login')).text())![1]!;
  const post: AdminClient['post'] = async (path, fields = {}, o = {}) => {
    const csrf = o.csrf === undefined ? await token() : o.csrf;
    const headers: Record<string, string> = { cookie: cookie(), accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded', ...xff };
    if (o.origin !== null) headers.origin = o.origin ?? t.url;
    if (o.referer) headers.referer = o.referer;
    const body = new URLSearchParams({ ...fields, ...(csrf === null ? {} : { _csrf: csrf }) });
    return store(await rawFetch(`${t.url}${path}`, { method: 'POST', headers, body: body.toString() }));
  };
  /**
   * Follows redirects through the app (with its cookies) and any other 127.0.0.1:<port> test server such as a fake IdP
   * (without them); stops at a non-redirect or at a URL outside both (a client's redirect_uri), returning that URL.
   */
  const follow = async (r: Response, maxHops = 10): Promise<{ res: Response; url: string }> => {
    let cur = r; let url = '';
    for (let i = 0; i < maxHops && cur.status >= 300 && cur.status < 400; i++) {
      const loc = new URL(cur.headers.get('location')!, url || t.url);
      url = loc.href;
      if (loc.origin === t.url) cur = store(await rawFetch(loc.href, { headers: { cookie: cookie(), accept: 'text/html', 'sec-fetch-mode': 'navigate', ...xff } }));
      else if (loc.hostname === '127.0.0.1' && loc.port !== '') cur = await rawFetch(loc.href, { headers: { accept: 'text/html' } });
      else break; // e.g. http://127.0.0.1/cb (no port) or https://claude.ai/…: the caller reads code/state from `url`
    }
    return { res: cur, url };
  };
  return {
    cookie, get, post, follow,
    signIn: (email, password = TEST_PASSWORD, extra = {}) => post('/admin/login', { email, password, oauth_query: '', next: '/admin', ...extra }),
  };
}

/**
 * The whole Claude connection, as Claude does it: DCR (a public native client), authorize with PKCE, sign in through
 * `c` with the signed `oauth_query`, allow on the consent page (skipped when consent was already given), and the
 * code-for-token exchange. Throws on any unexpected step, so callers can assert on the result only.
 */
export async function connectClaude(
  t: TestCtx, c: AdminClient, o: { email: string; password?: string; redirectUri?: string; scope?: string },
): Promise<{ clientId: string; accessToken: string; refreshToken: string; redirectUri: string }> {
  const redirectUri = o.redirectUri ?? 'http://127.0.0.1/cb';
  const fail = (step: string, r: Response): never => { throw new Error(`connectClaude: ${step} answered ${r.status}`); };
  const reg = await fetch(`${t.url}/auth/oauth2/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'test', application_type: 'native', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    }),
  });
  if (!reg.ok) fail('register', reg);
  const { client_id: clientId } = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authz = await rawFetch(`${t.url}/auth/oauth2/authorize?${new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: o.scope ?? 'mcp offline_access',
    code_challenge: challenge, code_challenge_method: 'S256', state: 'st', resource: `${t.url}/mcp`,
  })}`, { headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
  if (authz.status !== 302) fail('authorize', authz);
  const query = (loc: string): string => loc.split('?')[1] ?? '';
  let step = await c.post('/admin/login', { email: o.email, password: o.password ?? TEST_PASSWORD, oauth_query: query(authz.headers.get('location')!) });
  const loc = step.headers.get('location') ?? '';
  if (/\/admin\/consent\?/.test(loc)) {
    const page = await c.get(loc.replace(t.url, ''));
    if (page.status !== 200) fail('consent page', page);
    step = await c.post('/admin/consent', { accept: 'yes', oauth_query: query(loc) });
  }
  const { url } = await c.follow(step);
  const code = url.startsWith(redirectUri) ? new URL(url).searchParams.get('code') : null;
  if (!code) throw new Error(`connectClaude: no code at ${url || '(no redirect)'}`);
  const tok = await fetch(`${t.url}/auth/oauth2/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: `${t.url}/mcp` }),
  });
  if (!tok.ok) fail('token', tok);
  const tj = (await tok.json()) as { access_token: string; refresh_token?: string };
  if (!tj.refresh_token) throw new Error('connectClaude: no refresh token');
  return { clientId, accessToken: tj.access_token, refreshToken: tj.refresh_token, redirectUri };
}

/** Calls the MCP `ping` tool with a bearer token; the Response is 200 for a token /mcp accepts. */
export function mcpPing(t: TestCtx, accessToken: string): Promise<Response> {
  return fetch(`${t.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} } }),
  });
}

/** The JSON-RPC message in a /mcp response: 2025-era (legacy) responses are SSE, so parse the first `data:` line; otherwise plain JSON. */
export async function rpcJson<T>(r: Response): Promise<T> {
  if (!(r.headers.get('content-type') ?? '').includes('text/event-stream')) return (await r.json()) as T;
  const line = (await r.text()).split('\n').find((l) => l.startsWith('data:'));
  if (!line) throw new Error('SSE response without a data: line');
  return JSON.parse(line.slice(5).trim()) as T;
}

/** A hub user created through Better Auth like an accepted invite (role on `user.role`), with a profile row. */
export async function createHubUser(t: TestCtx, o: { email: string; name: string; role?: Role }): Promise<{ id: string; email: string; name: string }> {
  const u = await t.auth.api.createUser({ body: { email: o.email, password: TEST_PASSWORD, name: o.name, role: o.role ?? 'member' } });
  t.db.insert(schema.userProfile).values({ userId: u.user.id, createdAt: new Date().toISOString() }).onConflictDoNothing().run();
  return { id: u.user.id, email: o.email, name: o.name };
}

/** Link a hub user to a fake ICA account: the fake BankID web login, then (unless `app: false`) a stored app session. */
export async function linkFakeIca(t: TestCtx, fake: FakeIca, user: { id: string; name: string }, o: { app?: AppState | false } = {}): Promise<string> {
  const cipher = createCipher(t.config.masterKey);
  const { icaAccountId } = await storeWebSession({ session: await fakeLoggedInSession(fake), endpoints: fake.endpoints, db: t.db, cipher, user });
  if (o.app !== false) storeAppSession({ db: t.db, cipher, userId: user.id, state: o.app ?? fakeAppState() });
  return icaAccountId;
}

export type ToolResult = { isError: boolean; text: string; json: unknown };
export type ListedTool = { name: string; description?: string; annotations?: Record<string, unknown> };
export type McpTestClient = { call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>; tools: () => Promise<ListedTool[]> };

/** Drives the real /mcp endpoint with a bearer token, like claude.ai does (initialize once, then calls). */
export function mcpClient(t: TestCtx, token: string): McpTestClient {
  let id = 0;
  let ready: Promise<void> | undefined;
  const send = (method: string, params: unknown): Promise<Response> => fetch(`${t.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const init = (): Promise<void> => (ready ??= (async () => {
    const r = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    if (r.status !== 200) throw new Error(`initialize: HTTP ${r.status}`);
    await rpcJson(r);
  })());
  return {
    async call(name, args = {}) {
      await init();
      const r = await send('tools/call', { name, arguments: args });
      if (r.status !== 200) throw new Error(`tools/call ${name}: HTTP ${r.status}`);
      const msg = await rpcJson<{ result?: { isError?: boolean; content: { type: string; text?: string }[] }; error?: { message: string } }>(r);
      if (!msg.result) return { isError: true, text: msg.error?.message ?? 'no result', json: null };
      const text = msg.result.content.map((c) => c.text ?? '').join('\n');
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* an error text */ }
      return { isError: msg.result.isError === true, text, json };
    },
    async tools() {
      await init();
      return (await rpcJson<{ result: { tools: ListedTool[] } }>(await send('tools/list', {}))).result.tools;
    },
  };
}

export type ToolTestUser = { id: string; email: string; name: string; client: McpTestClient };
export type ToolTest = { t: TestCtx; fake: FakeIca; logs: string[]; alice: ToolTestUser; bob: ToolTestUser; carol: ToolTestUser; close: () => Promise<void> };

/**
 * A fake ICA (lists, plus `FAKE_ALL_ROUTES` (merged under `o.fake.routes`) — `FAKE_APP_ROUTES` for stores, offers, bonus and products, `FAKE_WEB_ROUTES` for article search — and whatever `o.fake` adds; the web bearer is refused on mobile/* like the real gateway), the
 * full app, and three hub users with real OAuth tokens from the whole Claude connection: alice and bob each linked to
 * their own ICA account (web + app; bob's app token lives an hour, so it never needs a refresh the fake could not
 * serve), carol not linked. All log lines are collected in `logs`. Handla's plain-202 retry waits are instant and its
 * pacing gap is 0 (ICA_HUB_HANDLA_MIN_GAP_MS unless `env` sets it); its cache is on as in production.
 */
export async function startToolTest(o: { fake?: Partial<FakeIcaOptions>; icaRateLimit?: { capacity: number; refillPerSecond: number }; env?: Record<string, string> } = {}): Promise<ToolTest> {
  const fake = await startFakeIca({ pendingPolls: 0, mobileAcceptsWebBearer: false, appLists: fakeHouseholdLists(), extraAppBearers: [FAKE_SECRETS.appAccessTokenB], ...o.fake, routes: { ...FAKE_ALL_ROUTES, ...o.fake?.routes } });
  const logs: string[] = [];
  // No Handla pacing in tool tests (2.5 s between requests would make suites slow); a test that wants it sets the env.
  const t = await startTestApp({ ICA_HUB_HANDLA_MIN_GAP_MS: '0', ...o.env }, { icaEndpoints: fake.endpoints, log: captureLogs(logs), ...(o.icaRateLimit ? { icaRateLimit: o.icaRateLimit } : {}), handlaSleep: () => Promise.resolve() });
  const make = async (email: string, name: string, app: AppState | null): Promise<ToolTestUser> => {
    const u = await createHubUser(t, { email, name });
    if (app) await linkFakeIca(t, fake, u, { app });
    return { ...u, client: mcpClient(t, (await connectClaude(t, adminClient(t), { email })).accessToken) };
  };
  const alice = await make('alice@example.com', 'Alice', fakeAppState());
  const bob = await make('bob@example.com', 'Bob', fakeAppState({ accessToken: FAKE_SECRETS.appAccessTokenB, refreshToken: FAKE_SECRETS.appRefreshTokenB, expiresIn: 3600 }));
  const carol = await make('carol@example.com', 'Carol', null);
  return { t, fake, logs, alice, bob, carol, close: async () => { await t.close(); await fake.close(); } };
}
