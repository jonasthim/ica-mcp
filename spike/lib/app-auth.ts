import { createHash, randomBytes } from 'node:crypto';
import { FORM, JSONH, expectJson, form, now, type Session } from './http.js';
import { IMS } from './bankid.js';

export const API = 'https://apimgw-pub.ica.se';
export const WEB = 'https://www.ica.se';
const DCR_CLIENT_ID = 'ica-app-dcr-registration';
const DCR_CLIENT_SECRET = process.env.ICA_APP_DCR_CLIENT_SECRET ?? 'uxLHTBvZ-Z2fV-SbrHl1E-tz7vB3jQFrwAdSLlbVMMu1rxDdvJU0s8KGu9d1wLS4';
const DCR_SOFTWARE_ID = 'dcr-ica-app-template';
export const APP_REDIRECT_URI = 'icacurity://app';

export type AppClient = { client_id: string; client_secret: string; scope: string };
export type AppToken = { access_token: string; refresh_token?: string; expires_in: number; token_type: string; scope?: string };
export type AppState = { client: AppClient; token: AppToken; issuedAt: string };

export async function appRegisterClient(s: Session): Promise<AppClient> {
  const boot = await expectJson<{ access_token: string }>(await s.fetch(`${IMS}/oauth/v2/token`, { method: 'POST', headers: FORM,
    body: form({ client_id: DCR_CLIENT_ID, client_secret: DCR_CLIENT_SECRET, grant_type: 'client_credentials', scope: 'dcr', response_type: 'token' }) }), 'dcr bootstrap');
  return expectJson<AppClient>(await s.fetch(`${IMS}/register`, { method: 'POST', headers: { ...JSONH, Authorization: `Bearer ${boot.access_token}` }, body: JSON.stringify({ software_id: DCR_SOFTWARE_ID }) }), 'dcr register');
}

/** Start PKCE authorize for the app client. `acr` undefined → ims shows its login chooser (needed for BankID). */
export async function appAuthorizeStart(s: Session, client: AppClient, acr?: string): Promise<{ verifier: string; status: number; location: string | null }> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params: Record<string, string> = { client_id: client.client_id, scope: client.scope, redirect_uri: APP_REDIRECT_URI, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', prompt: 'login' };
  if (acr) params.acr = acr;
  const r = await s.fetch(`${IMS}/oauth/v2/authorize?${form(params)}`, { redirect: 'manual' });
  return { verifier, status: r.status, location: r.headers.get('location') };
}

export async function appExchangeCode(s: Session, client: AppClient, code: string, verifier: string): Promise<AppState> {
  const token = await expectJson<AppToken>(await s.fetch(`${IMS}/oauth/v2/token`, { method: 'POST', headers: FORM,
    body: form({ code, client_id: client.client_id, client_secret: client.client_secret, grant_type: 'authorization_code', scope: client.scope, response_type: 'token', code_verifier: verifier, redirect_uri: APP_REDIRECT_URI }) }), 'token exchange');
  return { client, token, issuedAt: now() };
}

export async function appRefresh(s: Session, state: AppState): Promise<AppState> {
  if (!state.token.refresh_token) throw new Error('no refresh_token in state');
  const basic = Buffer.from(`${state.client.client_id}:${state.client.client_secret}`).toString('base64');
  const token = await expectJson<AppToken>(await s.fetch(`${IMS}/oauth/v2/token`, { method: 'POST', headers: { ...FORM, Authorization: `Basic ${basic}` },
    body: form({ grant_type: 'refresh_token', refresh_token: state.token.refresh_token }) }), 'refresh');
  return { client: state.client, token: { ...state.token, ...token }, issuedAt: now() };
}

export class IcaGeoBlocked extends Error {}

/** Bearer call to the gateway; `bearer` is an app access token or a web accessToken. */
export async function gatewayApi<T = unknown>(s: Session, bearer: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: T | null; text: string }> {
  const res = await s.fetch(`${API}/${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, ...(body !== undefined ? JSONH : { Accept: 'application/json' }) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 451) throw new IcaGeoBlocked('HTTP 451 from apimgw-pub.ica.se — run from a Swedish IP');
  const text = await res.text();
  let json: T | null = null;
  try { json = text ? (JSON.parse(text) as T) : null; } catch { /* keep text */ }
  return { status: res.status, json, text };
}
export const appApi = <T = unknown>(s: Session, state: AppState, method: string, path: string, body?: unknown) => gatewayApi<T>(s, state.token.access_token, method, path, body);
