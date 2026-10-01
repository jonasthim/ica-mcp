import { createHash, randomBytes } from 'node:crypto';
import { ICA_APP_DCR_CLIENT_ID, ICA_APP_REDIRECT_URI, ICA_APP_SOFTWARE_ID, type IcaEndpoints } from './endpoints.js';
import { FORM, form, readBody, type IcaSession } from './http.js';
import { isRecord, str } from './json.js';

/**
 * Experimental: the ICA app's own OAuth login (ported from spike/lib/app-auth.ts). The web bearer is refused by every
 * `sverige/digx/mobile/*` API (403, WSO2 900908), so the hub tries to get the app's tokens instead:
 *   DCR bootstrap (client_credentials) → POST /register → PKCE authorize with `redirect_uri=icacurity://app` and no
 *   `acr` (so ims shows the chooser, where BankID lives) → the BankID relay → code exchange.
 * The resulting client and tokens are stored encrypted as the account's `app` session and refreshed with the
 * registered client's Basic auth. Nothing here is ever logged or rendered; error messages carry HTTP statuses only.
 */
export type AppClient = { client_id: string; client_secret: string; scope: string };
export type AppToken = { access_token: string; refresh_token?: string; expires_in: number; token_type: string; scope?: string };
export type AppState = { client: AppClient; token: AppToken; issuedAt: string };

/** ICA refused a step of the app login or refresh. The message holds our own words and an HTTP status only. */
export class AppAuthError extends Error {}
/** The refresh token is no longer accepted (`invalid_grant`): only a new BankID login helps. */
export class AppSessionExpired extends Error {}

export const APP_SESSION_EXPIRED = 'app session expired — reconnect';
/** The app-session problem when its stored row cannot be decrypted (wrong or changed master key). */
export const APP_SESSION_UNREADABLE = 'the stored app session cannot be decrypted — reconnect';
/** An access token with less than this left is refreshed before use. */
export const APP_MIN_VALIDITY_MS = 60_000;

/**
 * The `sub` claim of a JWT access token, or undefined for an opaque token. The hub never verifies ICA's tokens.
 * // shape: from the 2026-09-30 live capture — ICA's app access token is opaque (45 chars, not a JWT), so this is
 * undefined in production today and the app side of the same-person check checks nothing. Kept for a JWT token.
 */
export function appSubject(accessToken: string): string | undefined {
  const parts = accessToken.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try { const j: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); return isRecord(j) ? str(j.sub) : undefined; } catch { return undefined; }
}

function asToken(j: unknown): AppToken | undefined {
  if (!isRecord(j)) return undefined;
  const access = str(j.access_token); const type = str(j.token_type);
  if (!access || !type || typeof j.expires_in !== 'number') return undefined;
  const refresh = str(j.refresh_token); const scope = str(j.scope);
  return { access_token: access, expires_in: j.expires_in, token_type: type, ...(refresh ? { refresh_token: refresh } : {}), ...(scope ? { scope } : {}) };
}

/** DCR: bootstrap token with the app's registration client, then register a fresh app client. */
export async function registerAppClient(s: IcaSession, e: IcaEndpoints, dcrSecret: string): Promise<AppClient> {
  const boot = await s.fetch(`${e.ims}/oauth/v2/token`, { method: 'POST', headers: { ...FORM, Accept: 'application/json' },
    body: form({ client_id: ICA_APP_DCR_CLIENT_ID, client_secret: dcrSecret, grant_type: 'client_credentials', scope: 'dcr', response_type: 'token' }) });
  const bootJson = (await readBody(boot)).json;
  const bootToken = isRecord(bootJson) ? str(bootJson.access_token) : undefined;
  if (!boot.ok || !bootToken) throw new AppAuthError(`app client registration: HTTP ${boot.status} from token`);
  const reg = await s.fetch(`${e.ims}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${bootToken}` },
    body: JSON.stringify({ software_id: ICA_APP_SOFTWARE_ID }) });
  const c = (await readBody(reg)).json;
  const client = isRecord(c) ? { client_id: str(c.client_id), client_secret: str(c.client_secret), scope: str(c.scope) } : undefined;
  if (!reg.ok || !client?.client_id || !client.client_secret || !client.scope) throw new AppAuthError(`app client registration: HTTP ${reg.status} from register`);
  return { client_id: client.client_id, client_secret: client.client_secret, scope: client.scope };
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** PKCE authorize for the app client. No `acr`: ims then shows its login chooser, where the BankID QR lives. */
export function appAuthorizeUrl(e: IcaEndpoints, client: AppClient, challenge: string, state: string): string {
  return `${e.ims}/oauth/v2/authorize?${form({
    client_id: client.client_id, scope: client.scope, redirect_uri: ICA_APP_REDIRECT_URI, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256', prompt: 'login', state,
  })}`;
}

async function tokenRequest(s: IcaSession, e: IcaEndpoints, body: Record<string, string>, headers: Record<string, string> = {}): Promise<{ status: number; token: AppToken | undefined; error: string | undefined }> {
  const r = await s.fetch(`${e.ims}/oauth/v2/token`, { method: 'POST', headers: { ...FORM, Accept: 'application/json', ...headers }, body: form(body) });
  const { json } = await readBody(r);
  return { status: r.status, token: r.ok ? asToken(json) : undefined, error: isRecord(json) ? str(json.error) : undefined };
}

export async function exchangeAppCode(s: IcaSession, e: IcaEndpoints, client: AppClient, code: string, verifier: string, now: () => Date = () => new Date()): Promise<AppState> {
  const r = await tokenRequest(s, e, {
    code, client_id: client.client_id, client_secret: client.client_secret, grant_type: 'authorization_code', scope: client.scope,
    response_type: 'token', code_verifier: verifier, redirect_uri: ICA_APP_REDIRECT_URI,
  });
  if (!r.token) throw new AppAuthError(`app token exchange: HTTP ${r.status}`);
  return { client, token: r.token, issuedAt: now().toISOString() };
}

/** One refresh grant with the registered client's Basic auth. HTTP only: storage lives in src/sessions/app-store.ts. */
export type RefreshOutcome = { kind: 'ok'; token: AppToken } | { kind: 'invalid-grant' } | { kind: 'failed'; status: number | null; errorName: string };

export async function refreshAppToken(s: IcaSession, e: IcaEndpoints, state: AppState): Promise<RefreshOutcome> {
  if (!state.token.refresh_token) return { kind: 'invalid-grant' };
  const basic = Buffer.from(`${state.client.client_id}:${state.client.client_secret}`).toString('base64');
  try {
    const r = await tokenRequest(s, e, { grant_type: 'refresh_token', refresh_token: state.token.refresh_token }, { Authorization: `Basic ${basic}` });
    if (r.error === 'invalid_grant') return { kind: 'invalid-grant' };
    return r.token ? { kind: 'ok', token: r.token } : { kind: 'failed', status: r.status, errorName: 'HttpError' };
  } catch (err) {
    return { kind: 'failed', status: null, errorName: err instanceof Error ? err.name : 'unknown' };
  }
}
