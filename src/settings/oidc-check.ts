export type CheckId = 'scheme' | 'discovery' | 'issuer' | 'endpoints' | 'authorize_origin' | 'jwks' | 'scopes' | 'email_verified' | 'groups';
export type CheckStatus = 'pass' | 'warn' | 'fail';
export type OidcCheck = { id: CheckId; status: CheckStatus; code?: string };
export type OidcReport = { ok: boolean; checks: OidcCheck[] };
export const REQUIRED_CHECKS: readonly CheckId[] = ['scheme', 'discovery', 'issuer', 'endpoints', 'jwks', 'scopes'];
/** The whole check's deadline. Callers never pass another `timeoutMs` (tests aside): the page's "within N seconds" text is built from this. */
export const OIDC_CHECK_TIMEOUT_MS = 5_000;
/** `groups`: a group mapping (admin or member group) is configured, so the groups scope is checked too. */
type Opts = { groups?: boolean; timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch };
type GetOpts = { fetchImpl?: typeof fetch; maxBytes?: number; signal: AbortSignal };
type Got = { ok: true; json: unknown } | { ok: false; code: string };

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;
export const normaliseIssuer = (u: string): string => u.replace(/\/+$/, '');
/** The discovery URL for an issuer; the check and the runtime (src/auth/index.ts) both build it here, so they agree. */
export const discoveryUrlFor = (issuer: string): string => `${normaliseIssuer(issuer)}/.well-known/openid-configuration`;
/** HTTPS, or HTTP on a loopback host (tests and a local IdP): the rule for the issuer and for every endpoint. */
const secure = (u: URL): boolean => u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.test(u.hostname));
const urlOf = (v: unknown): URL | undefined => { if (typeof v !== 'string') return undefined; try { return new URL(v); } catch { return undefined; } };

async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const reader = res.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return undefined; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * GET JSON from the issuer's origin only: manual redirects (≤ 3, same origin), the check's shared deadline as the abort
 * signal of every request (and its body), a size cap. Only fixed codes come back, never text from the remote side.
 */
async function getJson(start: URL, origin: string, o: GetOpts): Promise<Got> {
  const f = o.fetchImpl ?? fetch;
  let url = start;
  for (let hop = 0; hop <= 3; hop++) {
    if (url.origin !== origin) return { ok: false, code: 'redirect_other_host' };
    try {
      const res = await f(url, { redirect: 'manual', credentials: 'omit', headers: { accept: 'application/json' }, signal: o.signal });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        const loc = res.headers.get('location'); if (!loc) return { ok: false, code: `http_${res.status}` };
        try { url = new URL(loc, url); } catch { return { ok: false, code: 'bad_redirect' }; }
        continue;
      }
      if (res.status !== 200) { await res.body?.cancel(); return { ok: false, code: `http_${res.status}` }; }
      const text = await readCapped(res, o.maxBytes ?? 262_144);
      if (text === undefined) return { ok: false, code: 'too_large' };
      try { return { ok: true, json: JSON.parse(text) }; } catch { return { ok: false, code: 'not_json' }; }
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      return { ok: false, code: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable' };
    }
  }
  return { ok: false, code: 'too_many_redirects' };
}

/**
 * The spec's "Test connection", server-side. Only the issuer's origin is ever contacted (HTTPS, or HTTP on loopback);
 * no private-IP filter, because household IdPs are private. The client secret cannot be verified generically: skipped.
 */
export async function checkOidcIssuer(issuerUrl: string, o: Opts = {}): Promise<OidcReport> {
  const checks: OidcCheck[] = [];
  const add = (id: CheckId, status: CheckStatus, code?: string): void => { checks.push(code && status !== 'pass' ? { id, status, code } : { id, status }); };
  const report = (): OidcReport => ({ ok: REQUIRED_CHECKS.every((id) => checks.some((c) => c.id === id && c.status !== 'fail')), checks });

  const issuer = urlOf(issuerUrl?.trim());
  // Credentials, a query or a fragment in the issuer cannot be part of a discovery URL (and credentials must never be sent).
  if (!issuer || issuer.username || issuer.password || issuer.search || issuer.hash) { add('scheme', 'fail', 'invalid_url'); return report(); }
  if (!secure(issuer)) { add('scheme', 'fail', 'https_required'); return report(); }
  add('scheme', 'pass');
  // One deadline for the whole check (discovery, redirects and JWKS): the admin waits at most `timeoutMs`.
  const g: GetOpts = { fetchImpl: o.fetchImpl, maxBytes: o.maxBytes, signal: AbortSignal.timeout(o.timeoutMs ?? OIDC_CHECK_TIMEOUT_MS) };

  const disc = await getJson(new URL(discoveryUrlFor(issuer.href)), issuer.origin, g);
  if (!disc.ok) { add('discovery', 'fail', disc.code); return report(); }
  const d = (disc.json && typeof disc.json === 'object' ? disc.json : {}) as Record<string, unknown>;
  add('discovery', 'pass');
  add('issuer', typeof d.issuer === 'string' && normaliseIssuer(d.issuer) === normaliseIssuer(issuer.href) ? 'pass' : 'fail', 'issuer_mismatch');
  const authz = urlOf(d.authorization_endpoint); const token = urlOf(d.token_endpoint); const jwksUrl = urlOf(d.jwks_uri);
  // The client secret goes to the token endpoint: never over cleartext (outside loopback), and a warning when it leaves the issuer's origin.
  if (!authz || !token || !jwksUrl) add('endpoints', 'fail', 'missing_endpoints');
  else if (![authz, token, jwksUrl].every(secure)) add('endpoints', 'fail', 'endpoints_insecure');
  else if (token.origin !== issuer.origin) add('endpoints', 'warn', 'token_other_origin');
  else add('endpoints', 'pass');
  if (authz) add('authorize_origin', authz.origin === issuer.origin ? 'pass' : 'warn', 'other_origin');
  if (!jwksUrl) add('jwks', 'fail', 'missing');
  else if (jwksUrl.origin !== issuer.origin) add('jwks', 'warn', 'other_host');
  else {
    const j = await getJson(jwksUrl, issuer.origin, g);
    const keys = j.ok && j.json && typeof j.json === 'object' ? (j.json as { keys?: unknown }).keys : undefined;
    add('jwks', Array.isArray(keys) && keys.length > 0 ? 'pass' : 'fail', j.ok ? 'no_keys' : j.code);
  }
  const scopes = Array.isArray(d.scopes_supported) ? d.scopes_supported : undefined;
  if (!scopes) add('scopes', 'warn', 'not_listed');
  else add('scopes', ['openid', 'email', 'profile'].every((x) => scopes.includes(x)) ? 'pass' : 'fail', 'missing_scopes');
  const claims = Array.isArray(d.claims_supported) ? d.claims_supported : undefined;
  add('email_verified', claims?.includes('email_verified') ? 'pass' : 'warn', claims ? 'missing_claim' : 'not_listed');
  // Only a warning, and only a hint: a provider may list the groups scope and claim without sending them (Authentik does
  // when no groups scope mapping is bound). Sign-in logs `groups_missing` when a profile arrives without them.
  if (o.groups) add('groups', scopes?.includes('groups') ? 'pass' : 'warn', 'missing_scope');
  return report();
}
