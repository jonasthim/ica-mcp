import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { errors, exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import { AUTH_INIT_TIMEOUT_MS } from './holder.js';
import { loadConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '../db/index.js';
import { revokeOAuthGrants } from '../users/grants.js';
import { adminClient, connectClaude, seedUser, startTestApp, TEST_PASSWORD, type TestCtx } from '../test-helpers.js';
import { checkJwksReachable, createMcpKeySet, createVerifier, holderJwksSource, KEY_SET_MAX_AGE_MS, KEY_SET_RELOAD_COOLDOWN_MS, type JwksSource } from './verifier.js';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const env = { ICA_HUB_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'), ICA_HUB_AUTH_SECRET: 's'.repeat(32) };
const configFor = (url: string) => loadConfig({ ...env, ICA_HUB_URL: url });
const fakeLog = () => ({ error: vi.fn(), warn: vi.fn() }) as unknown as Logger & { error: ReturnType<typeof vi.fn> };

async function listen(handler?: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  const server = handler ? createServer(handler) : createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

let unavailable: { server: Server; url: string };
let noKeys: { server: Server; url: string };
let refusedUrl: string;
let app: TestCtx;
beforeAll(async () => {
  unavailable = await listen((_req, res) => { res.statusCode = 503; res.end('down'); });
  noKeys = await listen((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"nope":[]}'); });
  const closed = await listen();
  refusedUrl = closed.url;
  await close(closed.server);
  app = await startTestApp();
  await app.auth.api.createUser({ body: { email: 'owner@example.com', password: TEST_PASSWORD, name: 'Owner', role: 'member' } });
});
afterAll(async () => { await close(unavailable.server); await close(noKeys.server); await app.close(); });

async function codeOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(OAuthError);
  return (err as OAuthError).code;
}

/** The running app's key set, read in process (as the /mcp route does), with every load counted. */
const countingKeys = (log: Logger = fakeLog()) => {
  const loads = { n: 0 };
  const source: JwksSource = { load: () => { loads.n++; return holderJwksSource(app.holder).load(); }, generation: () => app.holder.snapshot().generation };
  return { loads, keys: createMcpKeySet(source, log) };
};
const verifierFor = (log: Logger = fakeLog(), db: Db = app.db) => createVerifier(app.config, log, db, countingKeys(log).keys);
const nowSec = () => Math.floor(Date.now() / 1000);
/** A token signed by the app's own key for a user with a live grant (see the beforeAll below). */
const signFor = async (claims: Record<string, unknown> = {}): Promise<string> =>
  (await app.auth.api.signJWT({ body: { payload: { scope: 'mcp', iss: `${app.url}/auth`, aud: `${app.url}/mcp`, sub: 'kv-u', azp: 'kv-client', iat: nowSec(), exp: nowSec() + 600, ...claims } } })).token;

describe('createVerifier: in-process key set', () => {
  beforeAll(() => {
    seedUser(app.db, 'kv-u');
    app.db.insert(schema.oauthClient).values({ id: 'kv-c', clientId: 'kv-client', name: 'KV', redirectUris: ['https://kv.example/cb'] }).run();
    const at = new Date((nowSec() - 60) * 1000);
    app.db.insert(schema.oauthConsent).values({ id: 'kv-consent', clientId: 'kv-client', userId: 'kv-u', scopes: ['mcp'], createdAt: at, updatedAt: at }).run();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('verifies a valid token while our public JWKS URL is unreachable (no HTTP request to ourselves)', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    const token = await signFor();
    vi.stubGlobal('fetch', fetchSpy);
    const info = await verifierFor().verifyAccessToken(token);
    expect(info).toMatchObject({ clientId: 'kv-client', scopes: ['mcp'], extra: { userId: 'kv-u' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('loads the key set once and reuses it', async () => {
    const { loads, keys } = countingKeys();
    const v = createVerifier(app.config, fakeLog(), app.db, keys);
    await v.verifyAccessToken(await signFor());
    await v.verifyAccessToken(await signFor());
    expect(loads.n).toBe(1);
  });

  it('an unknown kid reloads the key set exactly once (then waits out the cooldown)', async () => {
    const { loads, keys } = countingKeys();
    const v = createVerifier(app.config, fakeLog(), app.db, keys);
    await keys.warm(1000);
    expect(loads.n).toBe(1);
    const { privateKey } = await generateKeyPair('EdDSA');
    const ghost = await new SignJWT({ scope: 'mcp', sub: 'kv-u', azp: 'kv-client' }).setProtectedHeader({ alg: 'EdDSA', kid: 'ghost' })
      .setIssuer(`${app.url}/auth`).setAudience(`${app.url}/mcp`).setIssuedAt().setExpirationTime('5m').sign(privateKey);
    expect(await codeOf(v.verifyAccessToken(ghost))).toBe(OAuthErrorCode.InvalidToken);
    expect(loads.n).toBe(2);
    expect(await codeOf(v.verifyAccessToken(ghost))).toBe(OAuthErrorCode.InvalidToken);
    expect(loads.n).toBe(2);
  });

  it('reloads the key set when the holder swaps instances', async () => {
    let generation = 1;
    let n = 0;
    const keys = createMcpKeySet({ load: () => { n++; return holderJwksSource(app.holder).load(); }, generation: () => generation }, fakeLog());
    const v = createVerifier(app.config, fakeLog(), app.db, keys);
    await v.verifyAccessToken(await signFor());
    generation = 2;
    await v.verifyAccessToken(await signFor());
    expect(n).toBe(2);
  });

  it('a tampered token is invalid_token', async () => {
    const [h, p, s] = (await signFor()).split('.');
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString()) as Record<string, unknown>;
    const tampered = `${h}.${b64({ ...claims, sub: 'someone-else' })}.${s}`;
    expect(await codeOf(verifierFor().verifyAccessToken(tampered))).toBe(OAuthErrorCode.InvalidToken);
  });

  it('keeps the JWT claim checks: issuer, audience, expiry, not-before, scope claim and DPoP binding', async () => {
    const v = verifierFor();
    for (const bad of [
      { iss: 'https://evil.example/auth' },
      { aud: 'https://evil.example/mcp' },
      { exp: nowSec() - 120 },
      { nbf: nowSec() + 600 },
      { scope: 'mcp  bad"scope' },
      { cnf: { jkt: 'thumbprint' } },
    ]) expect(await codeOf(v.verifyAccessToken(await signFor(bad))), JSON.stringify(bad)).toBe(OAuthErrorCode.InvalidToken);
  });

  it('a failing key-set load is server_error and logs an error (without the token), never a silent 401', async () => {
    const log = fakeLog();
    const keys = createMcpKeySet({ load: () => Promise.reject(new Error('SQLITE_BUSY')), generation: () => 1 }, log);
    const token = await signFor();
    expect(await codeOf(createVerifier(app.config, log, app.db, keys).verifyAccessToken(token))).toBe(OAuthErrorCode.ServerError);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(token);
  });

  it('warm() loads the key set once, and a failing warm-up is logged and never throws', async () => {
    const { loads, keys } = countingKeys();
    expect(await keys.warm(1000)).toBe(true);
    expect(loads.n).toBe(1);
    const log = fakeLog();
    const broken = createMcpKeySet({ load: () => Promise.reject(new Error('boom')), generation: () => 1 }, log);
    expect(await broken.warm(1000)).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
    const hanging = createMcpKeySet({ load: () => new Promise(() => undefined), generation: () => 1 }, log);
    expect(await hanging.warm(20)).toBe(false);
  });

  it('reports a garbage token as invalid_token without logging an error', async () => {
    const log = fakeLog();
    expect(await codeOf(verifierFor(log).verifyAccessToken('nope'))).toBe(OAuthErrorCode.InvalidToken);
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('createVerifier: hardening', () => {
  afterEach(() => { vi.useRealTimers(); });
  /** A locally generated EdDSA key pair published under `kid`, and tokens it signs for the kv-u grant. */
  const localKey = async (kid: string) => {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA' };
    const sign = (header: { kid?: string } = { kid }) => new SignJWT({ scope: 'mcp', sub: 'kv-u', azp: 'kv-client' })
      .setProtectedHeader({ alg: 'EdDSA', ...header }).setIssuer(`${app.url}/auth`).setAudience(`${app.url}/mcp`).setIssuedAt().setExpirationTime('5m').sign(privateKey);
    return { jwk, sign };
  };
  const clockedKeys = (load: () => Promise<JSONWebKeySet>, o: { loadTimeoutMs?: number } = {}) => {
    const clock = { t: 1_000_000 };
    const loads = { n: 0 };
    const log = fakeLog();
    const keys = createMcpKeySet({ load: () => { loads.n++; return load(); }, generation: () => 1 }, log, { now: () => clock.t, ...o });
    return { clock, loads, log, keys, v: createVerifier(app.config, log, app.db, keys) };
  };

  it('a key-set load that never settles times out: server_error, an error line, nothing cached', async () => {
    let hang = true;
    const { log, v, loads } = clockedKeys(() => (hang ? new Promise<JSONWebKeySet>(() => undefined) : holderJwksSource(app.holder).load()), { loadTimeoutMs: 30 });
    const token = await signFor();
    expect(await codeOf(v.verifyAccessToken(token))).toBe(OAuthErrorCode.ServerError);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.error.mock.calls)).toContain('timed out');
    hang = false;
    expect((await v.verifyAccessToken(token)).extra?.userId).toBe('kv-u');
    expect(loads.n).toBe(2);
  });

  it('defaults the load timeout to AUTH_INIT_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const keys = createMcpKeySet({ load: () => new Promise<JSONWebKeySet>(() => undefined), generation: () => 1 }, fakeLog());
    const p = keys.forKid('k').then(() => 'ok', (e: unknown) => (e as Error).message);
    await vi.advanceTimersByTimeAsync(AUTH_INIT_TIMEOUT_MS - 1);
    let settled = false;
    void p.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toContain('timed out');
  });

  it('refuses a token without a kid as invalid_token before any key lookup, also with two keys published', async () => {
    const a = await localKey('a');
    const b = await localKey('b');
    const { v, loads } = clockedKeys(() => Promise.resolve({ keys: [a.jwk, b.jwk] }));
    expect((await v.verifyAccessToken(await a.sign())).extra?.userId).toBe('kv-u'); // control: with its kid it passes
    expect(loads.n).toBe(1);
    expect(await codeOf(v.verifyAccessToken(await a.sign({})))).toBe(OAuthErrorCode.InvalidToken);
    expect(await codeOf(v.verifyAccessToken(await b.sign({})))).toBe(OAuthErrorCode.InvalidToken);
    expect(loads.n).toBe(1);
    const fresh = clockedKeys(() => Promise.resolve({ keys: [a.jwk, b.jwk] }));
    expect(await codeOf(fresh.v.verifyAccessToken(await a.sign({})))).toBe(OAuthErrorCode.InvalidToken);
    expect(fresh.loads.n).toBe(0);
  });

  it('refuses alg none and HS256 (even keyed with our public key) as invalid_token', async () => {
    const a = await localKey('a');
    const { v } = clockedKeys(() => Promise.resolve({ keys: [a.jwk] }));
    const claims = { scope: 'mcp', sub: 'kv-u', azp: 'kv-client', iss: `${app.url}/auth`, aud: `${app.url}/mcp`, iat: nowSec(), exp: nowSec() + 300 };
    expect(await codeOf(v.verifyAccessToken(`${b64({ alg: 'none', kid: 'a', typ: 'JWT' })}.${b64(claims)}.`))).toBe(OAuthErrorCode.InvalidToken);
    for (const secret of [new TextEncoder().encode('x'.repeat(32)), new TextEncoder().encode(JSON.stringify(a.jwk)), Buffer.from(a.jwk.x!, 'base64url')]) {
      const hs = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: 'a' }).sign(secret);
      expect(await codeOf(v.verifyAccessToken(hs))).toBe(OAuthErrorCode.InvalidToken);
    }
  });

  it('maps each jose key-set (infrastructure) error to server_error with an error line; other jose errors stay invalid_token', async () => {
    const token = await signFor();
    for (const E of [errors.JWKSTimeout, errors.JWKSInvalid, errors.JWKSMultipleMatchingKeys]) {
      const log = fakeLog();
      const v = createVerifier(app.config, log, app.db, countingKeys().keys, { jwtVerify: () => Promise.reject(new E()) });
      expect(await codeOf(v.verifyAccessToken(token)), E.name).toBe(OAuthErrorCode.ServerError);
      expect(log.error, E.name).toHaveBeenCalledTimes(1);
    }
    const log = fakeLog();
    const v = createVerifier(app.config, log, app.db, countingKeys().keys, { jwtVerify: () => Promise.reject(new errors.JWKSNoMatchingKey()) });
    expect(await codeOf(v.verifyAccessToken(token))).toBe(OAuthErrorCode.InvalidToken);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('a malformed published key set is server_error, not invalid_token', async () => {
    const { v, log } = clockedKeys(() => Promise.resolve({ keys: [42] } as unknown as JSONWebKeySet));
    expect(await codeOf(v.verifyAccessToken(await signFor()))).toBe(OAuthErrorCode.ServerError);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('after the 30 s cooldown an unknown kid reloads again', async () => {
    const a = await localKey('a');
    const ghost = await localKey('ghost');
    const { v, loads, clock } = clockedKeys(() => Promise.resolve({ keys: [a.jwk] }));
    const t = await ghost.sign();
    expect(await codeOf(v.verifyAccessToken(t))).toBe(OAuthErrorCode.InvalidToken);
    expect(loads.n).toBe(1); // the first load was fresh: no reload on top of it
    expect(await codeOf(v.verifyAccessToken(t))).toBe(OAuthErrorCode.InvalidToken);
    expect(loads.n).toBe(2); // one kid-triggered reload
    clock.t += KEY_SET_RELOAD_COOLDOWN_MS - 1;
    expect(await codeOf(v.verifyAccessToken(t))).toBe(OAuthErrorCode.InvalidToken);
    expect(loads.n).toBe(2);
    clock.t += 1;
    expect(await codeOf(v.verifyAccessToken(t))).toBe(OAuthErrorCode.InvalidToken);
    expect(loads.n).toBe(3);
  });

  it('a stale set whose reload fails is server_error; the next lookup retries and succeeds', async () => {
    const a = await localKey('a');
    let fail = false;
    const { v, loads, clock, log } = clockedKeys(() => (fail ? Promise.reject(new Error('SQLITE_BUSY')) : Promise.resolve({ keys: [a.jwk] })));
    const t = await a.sign();
    await v.verifyAccessToken(t);
    clock.t += KEY_SET_MAX_AGE_MS;
    fail = true;
    expect(await codeOf(v.verifyAccessToken(t))).toBe(OAuthErrorCode.ServerError);
    expect(log.error).toHaveBeenCalledTimes(1);
    fail = false;
    expect((await v.verifyAccessToken(t)).extra?.userId).toBe('kv-u');
    expect(loads.n).toBe(3);
  });

  it('50 concurrent first verifications share exactly one load', async () => {
    const a = await localKey('a');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { v, loads } = clockedKeys(async () => { await gate; return { keys: [a.jwk] }; });
    const t = await a.sign();
    const all = Promise.all(Array.from({ length: 50 }, () => v.verifyAccessToken(t)));
    release();
    expect((await all).every((i) => i.extra?.userId === 'kv-u')).toBe(true);
    expect(loads.n).toBe(1);
  });

  it('a key deleted from the published set stops verifying once the set is older than the 5-minute max age', async () => {
    const a = await localKey('a');
    const b = await localKey('b');
    let published = [a.jwk, b.jwk];
    const { v, clock } = clockedKeys(() => Promise.resolve({ keys: published }));
    const t = await b.sign();
    await v.verifyAccessToken(t);
    published = [a.jwk];
    clock.t += KEY_SET_MAX_AGE_MS - 1;
    expect((await v.verifyAccessToken(t)).extra?.userId).toBe('kv-u');
    clock.t += 1;
    expect(await codeOf(v.verifyAccessToken(t))).toBe(OAuthErrorCode.InvalidToken);
  });
});

describe('createVerifier: the grant behind a valid token', () => {
  it('accepts a valid token while its (user, client) consent exists, and refuses it as invalid_token once it is gone', async () => {
    const g = await connectClaude(app, adminClient(app), { email: 'owner@example.com' });
    const verifier = verifierFor();
    const info = await verifier.verifyAccessToken(g.accessToken);
    expect(info.clientId).toBe(g.clientId);
    expect(info.extra?.userId).toEqual(expect.any(String));
    app.db.delete(schema.oauthConsent).where(eq(schema.oauthConsent.clientId, g.clientId)).run();
    const err = await verifier.verifyAccessToken(g.accessToken).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).code).toBe(OAuthErrorCode.InvalidToken);
    expect((err as OAuthError).message).toBe('Access to ica-hub was revoked');
  });
});

describe('createVerifier: tokens older than the current grant', () => {
  /** A signed token for (sub, azp); `iat: undefined` leaves the claim out (signJWT only sets it when given). */
  const sign = async (claims: Record<string, unknown>): Promise<string> =>
    (await app.auth.api.signJWT({ body: { payload: { scope: 'mcp', iss: `${app.url}/auth`, aud: `${app.url}/mcp`, ...claims } } })).token;
  const grant = (userId: string, clientId: string, createdAt: Date) => {
    app.db.insert(schema.oauthConsent).values({ id: `con-${userId}-${clientId}-${createdAt.getTime()}`, clientId, userId, scopes: ['mcp'], createdAt, updatedAt: createdAt }).run();
  };
  beforeAll(() => {
    for (const u of ['iat-u1', 'iat-u2', 'iat-u3']) seedUser(app.db, u);
    app.db.insert(schema.oauthClient).values({ id: 'iat-c', clientId: 'https://claude.example/oauth/client.json', name: 'Claude', redirectUris: ['https://claude.example/cb'] }).run();
  });

  it('a token issued in the same second as the consent passes; one from the second before does not', async () => {
    const t = nowSec();
    grant('iat-u1', 'https://claude.example/oauth/client.json', new Date(t * 1000 + 700));
    const v = verifierFor();
    expect((await v.verifyAccessToken(await sign({ sub: 'iat-u1', azp: 'https://claude.example/oauth/client.json', iat: t }))).extra?.userId).toBe('iat-u1');
    expect(await codeOf(v.verifyAccessToken(await sign({ sub: 'iat-u1', azp: 'https://claude.example/oauth/client.json', iat: t - 1 })))).toBe(OAuthErrorCode.InvalidToken);
  });

  it('refuses a token with no iat', async () => {
    grant('iat-u2', 'https://claude.example/oauth/client.json', new Date((nowSec() - 60) * 1000));
    const v = verifierFor();
    expect((await v.verifyAccessToken(await sign({ sub: 'iat-u2', azp: 'https://claude.example/oauth/client.json', iat: nowSec() }))).clientId).toBe('https://claude.example/oauth/client.json');
    expect(await codeOf(v.verifyAccessToken(await sign({ sub: 'iat-u2', azp: 'https://claude.example/oauth/client.json' })))).toBe(OAuthErrorCode.InvalidToken);
  });

  it('a revoked token stays refused after the user allows the same client id again', async () => {
    const cid = 'https://claude.example/oauth/client.json';
    const v = verifierFor();
    grant('iat-u3', cid, new Date((nowSec() - 120) * 1000));
    const old = await sign({ sub: 'iat-u3', azp: cid, iat: nowSec() - 60 });
    await v.verifyAccessToken(old);
    revokeOAuthGrants(app.db, 'iat-u3', cid);
    expect(await codeOf(v.verifyAccessToken(old))).toBe(OAuthErrorCode.InvalidToken);
    grant('iat-u3', cid, new Date(nowSec() * 1000));
    expect(await codeOf(v.verifyAccessToken(old))).toBe(OAuthErrorCode.InvalidToken);
    expect((await v.verifyAccessToken(await sign({ sub: 'iat-u3', azp: cid, iat: nowSec() }))).extra?.userId).toBe('iat-u3');
  });

  it('reports a failing grant lookup as server_error and logs it (without the token)', async () => {
    const token = await sign({ sub: 'iat-u1', azp: 'https://claude.example/oauth/client.json', iat: nowSec() });
    const broken = { select: () => { throw new Error('SQLITE_BUSY: database is locked'); } } as unknown as Db;
    const log = fakeLog();
    expect(await codeOf(verifierFor(log, broken).verifyAccessToken(token))).toBe(OAuthErrorCode.ServerError);
    expect(log.error).toHaveBeenCalledWith({ err: { name: 'Error' } }, 'grant lookup failed');
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(token);
  });
});

describe('checkJwksReachable', () => {
  it('is ok when our own JWKS is served', async () => {
    expect(await checkJwksReachable(app.config)).toEqual({ ok: true });
  });
  it('reports an error status', async () => {
    const r = await checkJwksReachable(configFor(unavailable.url));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('HTTP 503');
  });
  it('reports a refused connection', async () => {
    const r = await checkJwksReachable(configFor(refusedUrl));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain(`${refusedUrl}/auth/jwks`);
  });
  it('reports a body without a keys array', async () => {
    const r = await checkJwksReachable(configFor(noKeys.url));
    expect(r).toEqual({ ok: false, error: `GET ${noKeys.url}/auth/jwks returned no "keys" array` });
  });
});
