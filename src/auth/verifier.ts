import { AsyncLocalStorage } from 'node:async_hooks';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/express';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Db } from '../db/index.js';
import { activeGrantSince } from '../users/grants.js';
import { AUTH_INIT_TIMEOUT_MS, type AuthHolder } from './holder.js';

/** Why /mcp refused a request, as logged by the /mcp request log (never the token itself). */
export type BearerRejectReason = 'missing_token' | 'invalid_token' | 'revoked' | 'insufficient_scope' | 'jwks_unavailable';
/** What the verifier learned about one request, read by the /mcp request log once the response is finished. */
export type BearerOutcome = { reason?: BearerRejectReason; clientId?: string; userId?: string };
const outcomeStore = new AsyncLocalStorage<BearerOutcome>();
/** Runs `fn` (the rest of the /mcp middleware chain) with `outcome` as the record the verifier fills in. */
export const withBearerOutcome = <T>(outcome: BearerOutcome, fn: () => T): T => outcomeStore.run(outcome, fn);
const note = (o: BearerOutcome): void => { const cur = outcomeStore.getStore(); if (cur) Object.assign(cur, o); };

/** Where the /mcp key set comes from: the public keys Better Auth signs access tokens with, read in process. */
export type JwksSource = { load(): Promise<JSONWebKeySet>; generation(): number };

/**
 * The running Better Auth instance's own key set, via the jwt plugin's `getJwks` endpoint called in process: the same
 * document `/auth/jwks` serves (keys past their expiry plus grace dropped), without an HTTP request to our own public
 * URL. The keys live in the `jwks` table, so they survive instance swaps; `generation` still lets the cache reload on
 * a swap.
 */
export function holderJwksSource(holder: AuthHolder): JwksSource {
  return {
    load: async () => (await holder.snapshot().auth.api.getJwks()) as JSONWebKeySet,
    generation: () => holder.snapshot().generation,
  };
}

/** Longest a loaded key set is trusted before the next verification reloads it (a key removed from the DB stops). */
export const KEY_SET_MAX_AGE_MS = 5 * 60_000;
/** Unknown `kid`s reload the key set at most this often (a flood of forged kids never becomes a DB read each). */
export const KEY_SET_RELOAD_COOLDOWN_MS = 30_000;

export type McpKeySet = {
  /** The key set to verify a token with header `kid` against; throws when it cannot be loaded. */
  forKid(kid: string | undefined): Promise<JSONWebKeySet>;
  /** Loads the key set once (startup); false (logged) when it failed or took longer than `timeoutMs`. Never throws. */
  warm(timeoutMs: number): Promise<boolean>;
};

/**
 * The in-memory /mcp key set. Loaded on first use (or `warm`), then reloaded when the holder's generation changed,
 * when it is older than {@link KEY_SET_MAX_AGE_MS}, or — at most once per {@link KEY_SET_RELOAD_COOLDOWN_MS} — when a
 * token names a `kid` it does not contain. Concurrent loads share one in-flight promise. A load that fails or does not
 * settle within `loadTimeoutMs` (default {@link AUTH_INIT_TIMEOUT_MS}) is a failed load: nothing is cached, and the next
 * lookup tries again — /mcp never waits on a hung load forever.
 */
export function createMcpKeySet(
  source: JwksSource, log: Pick<Logger, 'error'>, o: { now?: () => number; loadTimeoutMs?: number } = {},
): McpKeySet {
  const now = o.now ?? Date.now;
  const loadTimeoutMs = o.loadTimeoutMs ?? AUTH_INIT_TIMEOUT_MS;
  let cached: { jwks: JSONWebKeySet; at: number; generation: number } | undefined;
  let lastKidReloadAt = -Infinity;
  let inflight: Promise<JSONWebKeySet> | undefined;
  const load = (): Promise<JSONWebKeySet> => (inflight ??= (async () => {
    const generation = source.generation();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_r, reject) => {
      timer = setTimeout(() => reject(new Error(`key set load timed out after ${loadTimeoutMs} ms`)), loadTimeoutMs);
    });
    try {
      const jwks = await Promise.race([source.load(), timedOut]);
      if (!jwks || !Array.isArray(jwks.keys)) throw new Error('key set has no keys array');
      cached = { jwks, at: now(), generation };
      return jwks;
    } finally {
      clearTimeout(timer);
      inflight = undefined;
    }
  })());
  return {
    async forKid(kid) {
      if (!cached || cached.generation !== source.generation() || now() - cached.at >= KEY_SET_MAX_AGE_MS) return load();
      if (kid !== undefined && !cached.jwks.keys.some((k) => k.kid === kid) && now() - lastKidReloadAt >= KEY_SET_RELOAD_COOLDOWN_MS) {
        lastKidReloadAt = now();
        return load();
      }
      return cached.jwks;
    },
    async warm(timeoutMs) {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); });
      try {
        const r = await Promise.race([load().then(() => 'ok' as const), timedOut]);
        if (r === 'timeout') log.error({ timeoutMs }, 'mcp key set warm-up timed out');
        return r === 'ok';
      } catch (err) {
        log.error({ err: { name: err instanceof Error ? err.name : typeof err, message: err instanceof Error ? err.message : undefined } }, 'mcp key set warm-up failed');
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** jose failures that are ours (a bad key set), not the token's: better-auth's verifyBearerToken treats them the same. */
const JOSE_INFRA = new Set<string>([errors.JWKSTimeout.code, errors.JWKSInvalid.code, errors.JWKSMultipleMatchingKeys.code]);
/** RFC 6749 scope-token characters, as better-auth checks the `scope` claim. */
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const scopeClaimValid = (scope: unknown): boolean =>
  scope === undefined || (typeof scope === 'string' && scope.length > 0 && scope.split(' ').every((s) => SCOPE_TOKEN.test(s)));
const hasDpopBinding = (cnf: unknown): boolean =>
  typeof cnf === 'object' && cnf !== null && !Array.isArray(cnf) && typeof (cnf as { jkt?: unknown }).jkt === 'string' && (cnf as { jkt: string }).jkt.length > 0;

/**
 * Verifies Better Auth JWS access tokens for /mcp, in process: the signature against {@link McpKeySet} (Better Auth's
 * own keys, never fetched over our public URL — that request hairpinned through the edge on the live install, and
 * better-auth's verifyBearerToken turned its failure into a silent 401), then the checks verifyBearerToken made: `iss`
 * (our issuer), `aud` (the /mcp resource), `exp`/`nbf` in range and `iat` a number when present (jose checks only its
 * type; the grant check below requires it), a well-formed `scope` claim, and no DPoP binding (`cnf.jkt`; /mcp takes
 * bearer tokens only). A token without a `kid` header is refused before any key lookup: our own tokens always carry
 * one, and without it jose would try every published key.
 * A rejected token becomes `invalid_token` (401 + WWW-Authenticate); a key set that cannot be loaded, or a key set jose
 * refuses, is logged and becomes `server_error` (500) — never a silent 401.
 *
 * A token that passes the JWT checks must also still be backed by a live grant ({@link activeGrantSince}: the user
 * exists, is not disabled, and still has a consent for the token's client `azp`) that already existed when the token
 * was issued (`iat` at or after the consent's `created_at`, both to the second; a token without `iat` is refused), else
 * it is `invalid_token` too. The `iat` check keeps a revoked token dead when the user reconnects the same client id
 * (a CIMD client id is a stable URL) within the token's lifetime; a refreshed token is issued after the consent and
 * passes. A failing lookup is `server_error`, never a pass. This one
 * indexed lookup per request, uncached, is what makes revoking an app (Connected apps), signing out everywhere,
 * disabling or removing a user stop `/mcp` immediately instead of when the access token expires. It also means a
 * client that skipped consent (`skip_consent`) would be refused: none is registered that way, and
 * `ICA_HUB_TRUSTED_CLIENT_IDS` only changes the consent page's wording, never skips the consent row.
 *
 * Each branch records its outcome (reason, client id, user id) for the /mcp request log ({@link withBearerOutcome}).
 */
export function createVerifier(
  config: Config, log: Logger, db: Db, keys: McpKeySet,
  /** Test seam: the jose verification step (default `jwtVerify`). */
  o: { jwtVerify?: typeof jwtVerify } = {},
): OAuthTokenVerifier {
  const verifyJws = o.jwtVerify ?? jwtVerify;
  const invalid = (message: string): OAuthError => { note({ reason: 'invalid_token' }); return new OAuthError(OAuthErrorCode.InvalidToken, message); };
  const unavailable = (): OAuthError => new OAuthError(OAuthErrorCode.ServerError, 'Access token verification is temporarily unavailable');
  return {
    async verifyAccessToken(token) {
      let kid: string | undefined;
      try {
        kid = decodeProtectedHeader(token).kid;
      } catch {
        throw invalid('Invalid or expired access token');
      }
      if (typeof kid !== 'string' || kid.length === 0) throw invalid('Access token has no key id');
      let jwks: JSONWebKeySet;
      try {
        jwks = await keys.forKid(kid);
      } catch (err) {
        note({ reason: 'jwks_unavailable' });
        log.error({ err: { name: err instanceof Error ? err.name : typeof err, message: err instanceof Error ? err.message : undefined } }, 'mcp key set could not be loaded');
        throw unavailable();
      }
      let claims: JWTPayload;
      try {
        ({ payload: claims } = await verifyJws(token, createLocalJWKSet(jwks), { issuer: config.authIssuer, audience: config.mcpResource }));
      } catch (err) {
        if (err instanceof errors.JOSEError && !JOSE_INFRA.has(err.code)) throw invalid('Invalid or expired access token');
        note({ reason: 'jwks_unavailable' });
        log.error({ err: { name: err instanceof Error ? err.name : typeof err, code: err instanceof errors.JOSEError ? err.code : undefined } }, 'access token verification failed (infrastructure)');
        throw unavailable();
      }
      if (!scopeClaimValid(claims.scope)) throw invalid('access token scope claim is invalid');
      if (hasDpopBinding(claims.cnf)) throw invalid('DPoP-bound access tokens are not accepted');
      const userId = typeof claims.sub === 'string' ? claims.sub : undefined;
      const clientId = typeof claims.azp === 'string' ? claims.azp : undefined;
      note({ ...(clientId ? { clientId } : {}), ...(userId ? { userId } : {}) });
      if (!userId) throw invalid('Access token has no subject');
      const iat = typeof claims.iat === 'number' ? claims.iat : undefined;
      const revoked = () => { note({ reason: 'revoked' }); return new OAuthError(OAuthErrorCode.InvalidToken, 'Access to ica-hub was revoked'); };
      if (clientId === undefined || iat === undefined) throw revoked();
      let since: Date | undefined;
      try {
        since = activeGrantSince(db, userId, clientId);
      } catch (err) {
        log.error({ err: { name: err instanceof Error ? err.name : typeof err } }, 'grant lookup failed');
        throw unavailable();
      }
      if (!since || iat < Math.floor(since.getTime() / 1000)) throw revoked();
      return {
        token,
        clientId,
        scopes: typeof claims.scope === 'string' ? claims.scope.split(' ') : [],
        expiresAt: typeof claims.exp === 'number' ? claims.exp : undefined,
        resource: new URL(config.mcpResource),
        extra: { userId },
      };
    },
  };
}

/**
 * Whether our own JWKS is reachable over the public URL and well-formed, as external clients fetch it. /mcp no longer
 * depends on it (it verifies in process); intended for health checks; never called on the request path.
 */
export async function checkJwksReachable(config: Config): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = `${config.authIssuer}/jwks`;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (res.status !== 200) return { ok: false, error: `GET ${url} answered HTTP ${res.status}` };
    const body = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) return { ok: false, error: `GET ${url} returned no "keys" array` };
    return { ok: true };
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
    return { ok: false, error: `GET ${url} failed: ${err instanceof Error ? err.message : String(err)}${cause}` };
  }
}
