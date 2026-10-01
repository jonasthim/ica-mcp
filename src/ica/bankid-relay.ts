import { randomBytes } from 'node:crypto';
import { DEFAULT_ICA_APP_DCR_CLIENT_SECRET, ICA_APP_REDIRECT_URI, type IcaEndpoints } from './endpoints.js';
import { FORM, form, hidden, newSession, readBody, type IcaSession } from './http.js';
import { redactUrl } from './redact.js';
import { AppAuthError, appAuthorizeUrl, exchangeAppCode, newPkce, registerAppClient, type AppClient, type AppState } from './app-session.js';
import { isRecord } from './json.js';

/**
 * Server-side relay for ICA's `icase-bankid-qr` authenticator (ported from spike/lib/bankid.ts, itself from
 * cheif/ica-caldav). One relay = one cookie jar = one login attempt:
 *   start(flow)  GET ims /oauth/v2/authorize (so ims holds the authorization request), then GET the QR authenticator;
 *   poll()       POST /wait → the current animated-QR payload, until ims says `stopPolling`; then POST /launch,
 *                POST its form1 (token/state) with `redirect: 'manual'` and follow the Location chain back to the
 *                client (for the web flow: www.ica.se, which sets `thSessionId`).
 * The `app` flow (experimental) first registers an ICA app client (DCR) and starts its PKCE authorize instead; after
 * form1 it follows hops on ims only and stops at the `icacurity://app?code=…` Location, which is never fetched: the
 * code is exchanged for app tokens, handed over once through takeAppState().
 * The browser drives poll() once per second through the admin status endpoint.
 */
export type RelayFlow = 'web' | 'app';
export const APP_NO_CODE = 'app login did not return an app code (ICA may not allow BankID for the app client)';
export type RelayPoll = { state: 'pending'; qr: string; autoStartToken?: string } | { state: 'complete' } | { state: 'failed'; reason: string };

export const RELAY_TIMEOUT_MS = 3 * 60_000;
/** A /wait call younger than this is not repeated: the last pending answer is reused (browsers may poll faster). */
export const MIN_WAIT_INTERVAL_MS = 900;
const MAX_REDIRECTS = 10;
const QR_PATH = '/authn/authenticate/icase-bankid-qr';
const AUTOSTART_KEYS = ['autoStartToken', 'autostartToken', 'autostarttoken'] as const;

function webAuthorizeUrl(e: IcaEndpoints): string {
  return `${e.ims}/oauth/v2/authorize?${new URLSearchParams({
    client_id: 'ica.se', response_type: 'code', scope: 'openid ica-se-scope ica-se-scope-hard', prompt: 'login',
    // The real ica.se callback, whatever host the tests use: ims validates it against the ica.se client.
    redirect_uri: 'https://www.ica.se/logga-in/sso/callback',
  })}`;
}

const isAppRedirect = (location: string): boolean => location === ICA_APP_REDIRECT_URI || /^icacurity:\/\/app[/?#]/.test(location);

/** The autostart token in a /wait response, top level or under `message`. The real key name is unverified. */
export function findAutoStartToken(j: unknown): string | undefined {
  for (const obj of [j, isRecord(j) ? j.message : undefined]) {
    if (!isRecord(obj)) continue;
    for (const k of AUTOSTART_KEYS) { const v = obj[k]; if (typeof v === 'string' && v) return v; }
  }
  return undefined;
}

class RelayError extends Error {}

export class BankidRelay {
  readonly session: IcaSession;
  private readonly endpoints: IcaEndpoints;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private startedAt: number | undefined;
  private terminal: RelayPoll | undefined;
  private lastPending: { at: number; result: RelayPoll } | undefined;
  private readonly appDcrSecret: string;
  private flow: RelayFlow = 'web';
  /** App flow: the registered client and PKCE/state of this login. Never logged. */
  private app: { client: AppClient; verifier: string; state: string } | undefined;
  private appState: AppState | undefined;
  /** App flow: a stored client to reuse instead of registering a new one (its secret is never logged). */
  private readonly presetClient: AppClient | undefined;
  private expired = false;

  constructor(o: { endpoints: IcaEndpoints; session?: IcaSession; now?: () => number; timeoutMs?: number; appDcrSecret?: string; appClient?: AppClient }) {
    this.endpoints = o.endpoints;
    this.session = o.session ?? newSession();
    this.now = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs ?? RELAY_TIMEOUT_MS;
    this.appDcrSecret = o.appDcrSecret ?? DEFAULT_ICA_APP_DCR_CLIENT_SECRET;
    this.presetClient = o.appClient;
  }

  /** Whether this relay reuses a stored app client instead of registering a new one at ICA. */
  get reusesClient(): boolean { return this.presetClient !== undefined; }

  /** The login failed only because BankID was not completed in time (nothing ICA refused). */
  get timedOut(): boolean { return this.expired; }

  /** App flow only: the tokens of a completed login, handed over once. */
  takeAppState(): AppState | undefined {
    const s = this.appState; this.appState = undefined; return s;
  }

  async start(flow: RelayFlow): Promise<void> {
    this.flow = flow;
    if (flow === 'web') {
      const authorize = await this.session.fetch(webAuthorizeUrl(this.endpoints));
      if (authorize.status >= 400) throw new RelayError(`BankID start: HTTP ${authorize.status} from authorize`);
      await authorize.body?.cancel();
    } else await this.startApp();
    const start = await this.session.fetch(`${this.endpoints.ims}${QR_PATH}`);
    await start.body?.cancel();
    if (!start.ok) throw new RelayError(`BankID start: HTTP ${start.status}`);
    this.startedAt = this.now();
  }

  async poll(): Promise<RelayPoll> {
    if (this.terminal) return this.terminal;
    if (this.startedAt === undefined) return { state: 'failed', reason: 'not started' };
    const now = this.now();
    if (now - this.startedAt > this.timeoutMs) { this.expired = true; return this.end({ state: 'failed', reason: 'BankID was not completed within 3 minutes' }); }
    if (this.lastPending && now - this.lastPending.at < MIN_WAIT_INTERVAL_MS) return this.lastPending.result;
    try {
      const r = await this.session.fetch(`${this.endpoints.ims}${QR_PATH}/wait`, { method: 'POST', headers: { Accept: 'application/json' } });
      const { json } = await readBody(r);
      if (isRecord(json) && json.stopPolling === true) { await this.finish(); return this.end({ state: 'complete' }); }
      const qr = isRecord(json) && isRecord(json.message) && typeof json.message.qrCode === 'string' ? json.message.qrCode : undefined;
      if (!qr) return this.end({ state: 'failed', reason: `ICA sent no QR code (HTTP ${r.status})` });
      const autoStartToken = findAutoStartToken(json);
      const result: RelayPoll = autoStartToken ? { state: 'pending', qr, autoStartToken } : { state: 'pending', qr };
      this.lastPending = { at: now, result };
      return result;
    } catch (e) {
      const reason = e instanceof RelayError ? e.message : `BankID relay error: ${e instanceof Error ? e.name : 'unknown'}`;
      return this.end({ state: 'failed', reason: redactUrl(reason) });
    }
  }

  /** DCR + register (unless a stored client is reused), then the app's PKCE authorize, followed (on ims only) to the login chooser. */
  private async startApp(): Promise<void> {
    const client = this.presetClient ?? await registerAppClient(this.session, this.endpoints, this.appDcrSecret);
    const { verifier, challenge } = newPkce();
    const state = randomBytes(16).toString('base64url');
    this.app = { client, verifier, state };
    const ims = new URL(this.endpoints.ims).origin;
    let url = new URL(appAuthorizeUrl(this.endpoints, client, challenge, state));
    for (let hop = 0; ; hop++) {
      const res = await this.session.fetch(url.toString(), { redirect: 'manual' });
      await res.body?.cancel();
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) { if (res.status >= 400) throw new RelayError(`BankID start: HTTP ${res.status} from authorize`); return; }
      if (hop >= MAX_REDIRECTS) throw new RelayError('BankID start: too many redirects');
      if (isAppRedirect(location)) throw new RelayError('BankID start: ICA answered the app authorize without a login');
      url = new URL(location, url);
      if (url.origin !== ims) throw new RelayError('BankID start: authorize redirected to an unexpected host');
    }
  }

  /** launch → form1 (token/state; never logged) → follow the redirect chain back to the client. */
  private async finish(): Promise<void> {
    const launch = await this.session.fetch(`${this.endpoints.ims}${QR_PATH}/launch`, { method: 'POST', headers: FORM, body: form({ _pollingDone: 'true' }) });
    const html = await launch.text();
    const action = /id="form1" action="([^"]*)"/.exec(html)?.[1];
    const token = hidden(html, 'token'); const state = hidden(html, 'state');
    if (!action || !token || !state) throw new RelayError(`BankID launch: no login form (HTTP ${launch.status})`);
    const actionUrl = new URL(action.replace(/%3F/gi, '?'), launch.url);
    // token/state are ICA's login proof: they go to ims and nowhere else, whatever the HTML says.
    const ims = new URL(this.endpoints.ims).origin; const web = new URL(this.endpoints.web).origin;
    if (actionUrl.origin !== ims) throw new RelayError('BankID launch: the login form posts to an unexpected host');
    let res = await this.session.fetch(actionUrl.toString(), { method: 'POST', headers: FORM, body: form({ token, state }), redirect: 'manual' });
    let url = actionUrl;
    await res.body?.cancel();
    if (!res.headers.get('location')) throw new RelayError(`BankID login: expected a redirect, got HTTP ${res.status}`);
    const app = this.flow === 'app';
    let appRedirect: string | undefined;
    // Follow the chain hop by hop so every hop is checked before it is requested.
    for (let hop = 0; ; hop++) {
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      if (hop >= MAX_REDIRECTS) throw new RelayError('BankID login: too many redirects');
      // The app's custom-scheme redirect ends the chain; it is parsed, never fetched.
      if (app && isAppRedirect(location)) { appRedirect = location; break; }
      url = new URL(location, url);
      if (app) {
        // The app flow stays on ims: landing on www.ica.se means ICA finished a web login, not an app one.
        if (url.origin === web && web !== ims) throw new RelayError(APP_NO_CODE);
        if (url.origin !== ims) throw new RelayError('BankID login: redirected to an unexpected host');
      } else if (url.origin !== ims && url.origin !== web) throw new RelayError('BankID login: redirected to an unexpected host');
      res = await this.session.fetch(url.toString(), { redirect: 'manual' });
      await res.body?.cancel();
    }
    if (app) { await this.finishApp(appRedirect); return; }
    if (url.origin !== web) throw new RelayError('BankID login: did not end on www.ica.se');
    if (res.status >= 400) throw new RelayError(`BankID login: callback answered HTTP ${res.status}`);
  }

  /** Read the code (and state) from the `icacurity://app` Location and exchange it for app tokens. */
  private async finishApp(location: string | undefined): Promise<void> {
    if (!location || !this.app) throw new RelayError(APP_NO_CODE);
    const params = new URL(location).searchParams;
    const code = params.get('code');
    if (!code) throw new RelayError(APP_NO_CODE);
    const state = params.get('state');
    if (state !== null && state !== this.app.state) throw new RelayError('app login: state mismatch');
    try {
      this.appState = await exchangeAppCode(this.session, this.endpoints, this.app.client, code, this.app.verifier);
    } catch (e) {
      if (e instanceof AppAuthError) throw new RelayError(e.message);
      throw e;
    }
  }

  private end(r: RelayPoll): RelayPoll { this.terminal = r; return r; }
}
