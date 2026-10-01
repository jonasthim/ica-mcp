import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_ICA_APP_DCR_CLIENT_SECRET, ICA_APP_DCR_CLIENT_ID, ICA_APP_REDIRECT_URI, ICA_APP_SOFTWARE_ID, type IcaEndpoints } from './endpoints.js';
import { BankidRelay } from './bankid-relay.js';
import type { IcaSession } from './http.js';
import type { AppState } from './app-session.js';

/** Secrets the fake hands out; tests assert that none of them are ever stored in clear, logged or rendered. */
export const FAKE_SECRETS = {
  thSessionId: 'TH-SESSION-SECRET-4f1c',
  accessToken: 'WEB-ACCESS-TOKEN-SECRET-9d2e',
  imsToken: 'IMS-TOKEN-SECRET-77aa',
  imsState: 'IMS-STATE-SECRET-88bb',
  personnummer: '199001011234',
  firstName: 'Annafakename',
  street: 'Fakegatan 12',
  dcrToken: 'DCR-BOOT-TOKEN-SECRET-1a2b',
  appClientSecret: 'APP-CLIENT-SECRET-3c4d',
  appCode: 'APP-CODE-SECRET-5e6f',
  appAccessToken: 'APP-ACCESS-TOKEN-SECRET-7a8b',
  appRefreshToken: 'APP-REFRESH-TOKEN-SECRET-9c0d',
  appAccessTokenB: 'APP-ACCESS-TOKEN-B-SECRET-1f2e',
  appRefreshTokenB: 'APP-REFRESH-TOKEN-B-SECRET-3a4b',
  rotatedCookie: 'ROTATED-COOKIE-SECRET-5d6e',
} as const;

/** The client the fake's `/register` hands out (DCR, like the real ICA app). */
export const FAKE_APP_CLIENT = { client_id: 'fake-app-client-1', client_secret: FAKE_SECRETS.appClientSecret, scope: 'openid ica-app-scope offline_access' } as const;

/**
 * A mobile shoppinglistservice row. Live shape (2.1 capture, `mobile-shoppinglists shoppingLists[0].rows[0]`):
 * `{id, productName, sourceId, isStrikedOver, recipes, internalOrder, articleGroupId, articleGroupIdExtended,
 * latestChange, offlineId}`. The captured row had no quantity set; that is not evidence ICA never sends
 * `quantity`/`unit` (the web row carries `quantity: null`), so both stay in the type — confirm at the 2.11 live check.
 */
export type FakeAppRow = { offlineId: string; productName: string; isStrikedOver: boolean; sourceId: number; latestChange: string; recipes: unknown[]; quantity?: number; unit?: string; articleGroupId?: number; articleGroupIdExtended?: number; [extra: string]: unknown };
export type FakeAppList = { id: number; offlineId: string; title: string; commentText: string; sortingStore: number; latestChange: string; rows: FakeAppRow[]; [extra: string]: unknown };

const SLS = '/sverige/digx/mobile/shoppinglistservice/v1/shoppinglists';

/** The household's app lists (invented). `Kaffe` carries a field ICA does not send today, to test pass-through. */
export function fakeHouseholdLists(): FakeAppList[] {
  const row = (offlineId: string, productName: string, extra: Partial<FakeAppRow> = {}): FakeAppRow => ({ offlineId, productName, isStrikedOver: false, sourceId: -1, latestChange: '2026-09-28T10:00:00.000Z', recipes: [], ...extra });
  return [
    { id: 45000001, offlineId: 'LIST-VECKO', title: 'Veckohandling', commentText: '', sortingStore: 12345, latestChange: '2026-09-28T10:00:00.000Z', rows: [
      row('ROW-MJOLK', 'Mjölk'), row('ROW-HAVRE', 'Havremjölk'), row('ROW-AGG', 'Ägg', { quantity: 6, unit: 'st', articleGroupId: 4110, articleGroupIdExtended: 4110 }), // shape: from 2.1 (quantity/unit unconfirmed by the capture; articleGroupId/articleGroupIdExtended confirmed)
      row('ROW-BROD', 'Bröd', { isStrikedOver: true }), row('ROW-KAFFE', 'Kaffe', { futureField: { flag: true } }),
    ] },
    { id: 45000002, offlineId: 'LIST-FEST', title: 'Fest på Åland', commentText: '', sortingStore: 0, latestChange: '2026-09-28T10:00:00.000Z', rows: [row('ROW-CHIPS', 'Chips')] },
  ];
}

export type FakeIcaOptions = {
  /** How many /wait calls answer with a QR before `stopPolling`. */
  pendingPolls: number;
  loginState: number;
  firstName: string | undefined;
  /** Where the /wait response carries an autostart token, if at all (the real key name is unverified). */
  autoStart: { where: 'top' | 'message'; key: string; value: string } | undefined;
  /** /wait answers without a qrCode. */
  waitBroken: boolean;
  /** Answers for bearer (gateway) and cookie (www) GETs, keyed by pathname: JSON, or a raw string with `contentType`. */
  routes: Record<string, { status: number; body: unknown; contentType?: string }>;
  /** Overrides: where form1 posts, where its POST redirects, where the www callback redirects. */
  form1Action: string | undefined;
  doneLocation: string | undefined;
  callbackLocation: string | undefined;
  /** Replaces the /api/user/information answer. */
  userInfo: { status: number; body: unknown } | undefined;
  /** App flow: where the last ims hop redirects (default `icacurity://app?code=…&state=…`). */
  appFinalLocation: string | undefined;
  /** App tokens' `expires_in` (seconds). */
  appExpiresIn: number;
  /** The refresh grant answers 400 `invalid_grant`. */
  refreshInvalid: boolean;
  /** `mobile/*` gateway paths accept the web bearer (the real gateway answers 403 900908). */
  mobileAcceptsWebBearer: boolean;
  /** `tokenExpires` in /api/user/information (ISO string or epoch seconds); undefined leaves the field out. */
  webTokenExpires: string | number | undefined;
  /** /api/user/information also sets a new `icaRotated` cookie on every call (ICA rotating its cookies). */
  rotateCookie: boolean;
  /**
   * Answer the next `times` gateway calls under `pathPrefix` (and with `method`, when given) with `status` (a
   * WSO2-style error body), then behave normally. `applied: true` lets a shopping-list request take effect first and
   * only then answers the failure: the "ICA did it but the answer was lost" case a retried write must survive.
   */
  gatewayFailures: { pathPrefix: string; status: number; times: number; method?: string; applied?: boolean }[];
  /** Further app access tokens the gateway accepts (other household members' accounts). */
  extraAppBearers: string[];
  /** The household's app shopping lists, served over `SLS`; `undefined` leaves the list paths to fall through to `routes`. */
  appLists: FakeAppList[] | undefined;
  /** List syncs answer 200 (and are recorded in `seen.syncBodies`) but change nothing, as if ICA ignored the diff. */
  appSyncIgnored: boolean;
  /** `/api/cpa/*` answers 403 (empty body) even at loginState 2, as if ICA dropped the step-up between two calls. */
  cpaForbidden: boolean;
  /** /api/user/information waits for this promise before answering (counted in `seen.userInfoCalls` on arrival). */
  holdUserInfo: Promise<void> | undefined;
  /** Answer this many Handla product-search calls with a bare 202 (still preparing the page) before falling through to `routes`. */
  handlaPending: number;
  /**
   * Answer every Handla call (store and product search) the way CloudFront + AWS WAF does once its rate rule has
   * tripped: `challenge` — 202, `x-amzn-waf-action: challenge`, empty body (what a browser-looking client gets);
   * `block` — 403, `server: CloudFront`, an HTML "Request blocked" page, no WAF header (a plain client). Undefined: off.
   */
  handlaWaf: 'challenge' | 'block' | undefined;
  /** App authorize answers 400 `invalid_client` for these client ids (a DCR client ICA no longer knows). */
  rejectClientIds: string[];
  /** /oauth/v2/authorize waits for this promise before answering (its path is recorded in `seen.paths` on arrival). */
  holdAuthorize: Promise<void> | undefined;
  /** A refresh_token grant waits for this promise before rotating and answering (counted in `seen.tokenGrants` on arrival). */
  holdRefresh: Promise<void> | undefined;
  /** `customerId` in the logged-in /api/user/information answer (a number live); undefined leaves it out. */
  webSubject: string | number | undefined;
};

export type FakeIca = {
  endpoints: IcaEndpoints;
  opts: FakeIcaOptions;
  seen: {
    authorizeQuery: URLSearchParams | undefined; waitCalls: number; launchBody: string | undefined; form1Body: string | undefined; bearers: string[]; paths: string[];
    /** Every gateway call as `<path> <bearer kind>` (`web`, `app` or `other`). */
    gatewayCalls: string[];
    tokenGrants: string[];
    userInfoCalls: number;
    /** Every `query` sent to the article-search endpoint, in order. */
    searchQueries: string[];
    /** Every shopping-list sync the fake accepted, in order. */
    syncBodies: { offlineId: string; body: { createdRows?: FakeAppRow[]; changedRows?: FakeAppRow[]; deletedRows?: string[] } }[];
    /** Every list-create body the fake received, in order. */
    createBodies: unknown[];
    /** Every Handla store/product-search call the fake answered (anonymous: no bearer, no cookie), in order. */
    handlaRequests: { path: string; auth: string | null; cookie: string | null; referer: string | null }[];
  };
  /** The app tokens currently valid at the fake (they rotate on refresh). */
  app: { accessToken: string; refreshToken: string; rotations: number };
  close: () => Promise<void>;
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => { const c: Buffer[] = []; req.on('data', (d: Buffer) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); });
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };
const hasCookie = (req: IncomingMessage, kv: string) => (req.headers.cookie ?? '').split(/;\s*/).includes(kv);

/**
 * One local HTTP server playing ims (authorize → icase-bankid-qr start/wait/launch/form1), www.ica.se (sso callback
 * setting `thSessionId`, `/api/user/information`, purchase history) and the API gateway (bearer = the web accessToken).
 */
export async function startFakeIca(overrides: Partial<FakeIcaOptions> = {}): Promise<FakeIca> {
  const opts: FakeIcaOptions = {
    pendingPolls: 2, loginState: 2, firstName: FAKE_SECRETS.firstName, autoStart: undefined, waitBroken: false, routes: {},
    form1Action: undefined, doneLocation: undefined, callbackLocation: undefined, userInfo: undefined,
    appFinalLocation: undefined, appExpiresIn: 1800, refreshInvalid: false, mobileAcceptsWebBearer: true,
    webTokenExpires: new Date(Date.now() + 3_600_000).toISOString(), rotateCookie: false, gatewayFailures: [], extraAppBearers: [], appLists: undefined, appSyncIgnored: false, cpaForbidden: false, holdUserInfo: undefined, handlaPending: 0, handlaWaf: undefined, rejectClientIds: [], holdAuthorize: undefined, holdRefresh: undefined, webSubject: undefined, ...overrides,
  };
  const seen: FakeIca['seen'] = { authorizeQuery: undefined, waitCalls: 0, launchBody: undefined, form1Body: undefined, bearers: [], paths: [], gatewayCalls: [], tokenGrants: [], userInfoCalls: 0, syncBodies: [], createBodies: [], searchQueries: [], handlaRequests: [] };
  const app: FakeIca['app'] = { accessToken: FAKE_SECRETS.appAccessToken, refreshToken: FAKE_SECRETS.appRefreshToken, rotations: 0 };
  /** The app authorize request in progress (the fake plays one login at a time). */
  let appAuthorize: { challenge: string; state: string | null } | undefined;
  let flow: 'web' | 'app' = 'web';
  /** /wait calls since the last authorize: each login gets its own `pendingPolls` QR answers. */
  let loginWaits = 0;
  /** Cookies rotated by /api/user/information (`rotateCookie`), so every rotation has a new value. */
  let cookieRotations = 0;
  const appTokens = () => ({ access_token: app.accessToken, refresh_token: app.refreshToken, expires_in: opts.appExpiresIn, token_type: 'Bearer', scope: FAKE_APP_CLIENT.scope });
  /** The mobile shoppinglistservice over `opts.appLists`: list all, get one, sync (created/changed/deleted rows), create. */
  const handleLists = (method: string, rest: string, body: string): { status: number; body: unknown } => {
    const lists = opts.appLists ?? [];
    if (rest === '' && method === 'GET') return { status: 200, body: { shoppingLists: lists } };
    if (rest === '' && method === 'POST') {
      const b = JSON.parse(body || '{}') as Partial<FakeAppList>;
      seen.createBodies.push(b);
      if (typeof b.offlineId !== 'string' || typeof b.title !== 'string') return { status: 400, body: { error: 'bad list' } };
      lists.push({ id: 45_000_100 + lists.length, offlineId: b.offlineId, title: b.title, commentText: '', sortingStore: 0, latestChange: new Date().toISOString(), rows: [] });
      return { status: 200, body: {} };
    }
    const m = /^\/([^/]+)(\/sync)?$/.exec(rest);
    const list = m ? lists.find((l) => l.offlineId === decodeURIComponent(m[1]!)) : undefined;
    if (!m || !list) return { status: 404, body: { error: 'no such list' } };
    if (!m[2] && method === 'GET') return { status: 200, body: list };
    if (m[2] && method === 'POST') {
      const diff = JSON.parse(body || '{}') as { createdRows?: FakeAppRow[]; changedRows?: FakeAppRow[]; deletedRows?: string[] };
      seen.syncBodies.push({ offlineId: list.offlineId, body: diff });
      if (opts.appSyncIgnored) return { status: 200, body: {} };
      for (const r of diff.createdRows ?? []) list.rows.push(r);
      for (const r of diff.changedRows ?? []) { const i = list.rows.findIndex((x) => x.offlineId === r.offlineId); if (i >= 0) list.rows[i] = r; }
      list.rows = list.rows.filter((x) => !(diff.deletedRows ?? []).includes(x.offlineId));
      list.latestChange = new Date().toISOString();
      return { status: 200, body: {} };
    }
    return { status: 405, body: { error: 'method not allowed' } };
  };
  let base = '';
  const QR = '/authn/authenticate/icase-bankid-qr';
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', base);
      const body = await readBody(req);
      seen.paths.push(url.pathname);
      const imsCookie = hasCookie(req, 'imsSession=ims-1');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'POST /oauth/v2/token') {
        const f = new URLSearchParams(body);
        const grant = f.get('grant_type') ?? '';
        seen.tokenGrants.push(grant);
        const clientOk = f.get('client_id') === FAKE_APP_CLIENT.client_id && f.get('client_secret') === FAKE_APP_CLIENT.client_secret;
        if (grant === 'client_credentials') {
          if (f.get('client_id') !== ICA_APP_DCR_CLIENT_ID || f.get('client_secret') !== DEFAULT_ICA_APP_DCR_CLIENT_SECRET || f.get('scope') !== 'dcr') { json(res, 401, { error: 'invalid_client' }); return; }
          json(res, 200, { access_token: FAKE_SECRETS.dcrToken, token_type: 'Bearer', expires_in: 300 }); return;
        }
        if (grant === 'authorization_code') {
          const verifierOk = appAuthorize !== undefined && createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === appAuthorize.challenge;
          if (!clientOk) { json(res, 401, { error: 'invalid_client' }); return; }
          if (!verifierOk || f.get('code') !== FAKE_SECRETS.appCode || f.get('redirect_uri') !== ICA_APP_REDIRECT_URI) { json(res, 400, { error: 'invalid_grant' }); return; }
          json(res, 200, appTokens()); return;
        }
        if (grant === 'refresh_token') {
          if (opts.holdRefresh) await opts.holdRefresh;
          const basic = `Basic ${Buffer.from(`${FAKE_APP_CLIENT.client_id}:${FAKE_APP_CLIENT.client_secret}`).toString('base64')}`;
          if (req.headers.authorization !== basic) { json(res, 401, { error: 'invalid_client' }); return; }
          if (opts.refreshInvalid || f.get('refresh_token') !== app.refreshToken) { json(res, 400, { error: 'invalid_grant', error_description: 'refresh token expired' }); return; }
          app.rotations += 1;
          app.accessToken = `${FAKE_SECRETS.appAccessToken}-r${app.rotations}`; app.refreshToken = `${FAKE_SECRETS.appRefreshToken}-r${app.rotations}`;
          json(res, 200, appTokens()); return;
        }
        json(res, 400, { error: 'unsupported_grant_type' }); return;
      }
      if (route === 'POST /register') {
        const ok = req.headers.authorization === `Bearer ${FAKE_SECRETS.dcrToken}` && (JSON.parse(body || '{}') as { software_id?: string }).software_id === ICA_APP_SOFTWARE_ID;
        if (!ok) { json(res, 401, { error: 'invalid_token' }); return; }
        json(res, 201, FAKE_APP_CLIENT); return;
      }
      if (route === 'GET /oauth/v2/authorize/continue') {
        const state = appAuthorize?.state;
        res.writeHead(302, { location: opts.appFinalLocation ?? `${ICA_APP_REDIRECT_URI}?code=${FAKE_SECRETS.appCode}${state ? `&state=${encodeURIComponent(state)}` : ''}` }).end(); return;
      }
      if (route === 'GET /oauth/v2/authorize') {
        if (opts.holdAuthorize) await opts.holdAuthorize;
        if (opts.rejectClientIds.includes(url.searchParams.get('client_id') ?? '')) { json(res, 400, { error: 'invalid_client' }); return; }
        seen.authorizeQuery = url.searchParams;
        flow = url.searchParams.get('client_id') === FAKE_APP_CLIENT.client_id ? 'app' : 'web';
        loginWaits = 0;
        if (flow === 'app') appAuthorize = { challenge: url.searchParams.get('code_challenge') ?? '', state: url.searchParams.get('state') };
        res.writeHead(302, { 'set-cookie': 'imsSession=ims-1; Path=/; HttpOnly', location: '/authn/authenticate' }).end(); return;
      }
      if (route === 'GET /authn/authenticate') { res.writeHead(200, { 'content-type': 'text/html' }).end('<p>chooser</p>'); return; }
      if (route === `GET ${QR}`) { res.writeHead(imsCookie ? 200 : 400, { 'content-type': 'text/html' }).end('<p>qr</p>'); return; }
      if (route === `POST ${QR}/wait`) {
        if (!imsCookie) { json(res, 400, { error: 'no session' }); return; }
        seen.waitCalls += 1; loginWaits += 1;
        if (opts.waitBroken) { json(res, 200, {}); return; }
        if (loginWaits > opts.pendingPolls) { json(res, 200, { stopPolling: true }); return; }
        const message: Record<string, unknown> = { qrCode: `bankid.fakeqr.${loginWaits}` };
        const top: Record<string, unknown> = { message };
        if (opts.autoStart) (opts.autoStart.where === 'top' ? top : message)[opts.autoStart.key] = opts.autoStart.value;
        json(res, 200, top); return;
      }
      if (route === `POST ${QR}/launch`) {
        seen.launchBody = body;
        res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><body><form id="form1" action="${opts.form1Action ?? `${QR}/done%3Fsid=1`}" method="post">
<input type="hidden" name="token" value="${FAKE_SECRETS.imsToken}"><input type="hidden" value="${FAKE_SECRETS.imsState}" name="state"></form></body></html>`);
        return;
      }
      if (route === `POST ${QR}/done`) {
        seen.form1Body = body;
        if (url.searchParams.get('sid') !== '1') { res.writeHead(400).end(); return; }
        const next = flow === 'app' ? `${base}/oauth/v2/authorize/continue` : `${base}/logga-in/sso/callback?code=c1&state=s1`;
        res.writeHead(302, { location: opts.doneLocation ?? next }).end(); return;
      }
      if (route === 'GET /logga-in/sso/callback') {
        const expires = new Date(Date.now() + 86_400_000).toUTCString();
        res.writeHead(302, { 'set-cookie': `thSessionId=${FAKE_SECRETS.thSessionId}; Path=/; Expires=${expires}; HttpOnly`, location: opts.callbackLocation ?? '/' }).end(); return;
      }
      if (route === 'GET /') { res.writeHead(200, { 'content-type': 'text/html' }).end('<p>ica.se</p>'); return; }
      const loggedIn = hasCookie(req, `thSessionId=${FAKE_SECRETS.thSessionId}`);
      if (route === 'GET /api/user/information') {
        seen.userInfoCalls += 1;
        if (opts.holdUserInfo) await opts.holdUserInfo;
        if (opts.rotateCookie) res.setHeader('set-cookie', `icaRotated=${FAKE_SECRETS.rotatedCookie}-${++cookieRotations}; Path=/; HttpOnly`);
        if (opts.userInfo) { json(res, opts.userInfo.status, opts.userInfo.body); return; }
        json(res, 200, loggedIn
          ? { accessToken: FAKE_SECRETS.accessToken, loginState: opts.loginState, ...(opts.webTokenExpires !== undefined ? { tokenExpires: opts.webTokenExpires } : {}), ...(opts.firstName ? { firstName: opts.firstName } : {}), personnummer: FAKE_SECRETS.personnummer, ...(opts.webSubject !== undefined ? { customerId: opts.webSubject } : {}) }
          : { loginState: 0 });
        return;
      }
      const auth = req.headers.authorization;
      if (auth) seen.bearers.push(auth);
      const known = opts.routes[url.pathname];
      const send = (k: NonNullable<typeof known>) => {
        if (k.contentType) res.writeHead(k.status, { 'content-type': k.contentType }).end(String(k.body)); else json(res, k.status, k.body);
      };
      if (url.pathname.startsWith('/sverige/')) {
        const kind = auth === `Bearer ${FAKE_SECRETS.accessToken}` ? 'web'
          : auth === `Bearer ${app.accessToken}` || opts.extraAppBearers.some((b) => auth === `Bearer ${b}`) ? 'app' : 'other';
        seen.gatewayCalls.push(`${url.pathname} ${kind}`);
        if (url.pathname === '/sverige/digx/shoppinglistarticlesearch/v1/search') seen.searchQueries.push(url.searchParams.get('query') ?? '');
        const failure = opts.gatewayFailures.find((f) => f.times > 0 && url.pathname.startsWith(f.pathPrefix) && (f.method === undefined || f.method === req.method));
        const fail = (f: NonNullable<typeof failure>) => { json(res, f.status, { code: 900901, message: 'Invalid Credentials', description: 'fake failure' }); };
        if (failure) { failure.times -= 1; if (!failure.applied) { fail(failure); return; } }
        const mobile = url.pathname.startsWith('/sverige/digx/mobile/');
        if (kind === 'other' || (kind === 'app' && !mobile)) { json(res, 401, { error: 'unauthorized' }); return; }
        // What the real WSO2 gateway answers the web bearer on the mobile API products.
        if (kind === 'web' && mobile && !opts.mobileAcceptsWebBearer) { json(res, 403, { code: 900908, message: 'Resource forbidden ', description: 'Access failure for API' }); return; }
        if (opts.appLists && kind === 'app' && url.pathname.startsWith(SLS)) {
          const out = handleLists(req.method ?? 'GET', url.pathname.slice(SLS.length), body);
          if (failure) fail(failure); else json(res, out.status, out.body);
          return;
        }
        if (failure) { fail(failure); return; }
        if (known) { send(known); return; }
      }
      if (url.pathname.startsWith('/api/cpa/')) {
        if (!loggedIn) { json(res, 401, { error: 'unauthorized' }); return; }
        // What ICA does once the BankID step-up has lapsed: 403 with an empty body.
        if (opts.loginState !== 2 || opts.cpaForbidden) { res.writeHead(403, { 'content-type': 'text/plain' }).end(); return; }
        if (known) { send(known); return; }
      }
      if (url.pathname.startsWith('/api/store/') || url.pathname.startsWith('/stores/')) {
        seen.handlaRequests.push({ path: url.pathname, auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null, referer: req.headers.referer ?? null });
        if (opts.handlaWaf === 'challenge') { res.writeHead(202, { 'x-amzn-waf-action': 'challenge', server: 'CloudFront', 'x-cache': 'Error from cloudfront' }).end(); return; }
        if (opts.handlaWaf === 'block') { res.writeHead(403, { server: 'CloudFront', 'x-cache': 'Error from cloudfront', 'content-type': 'text/html' }).end('<HTML><HEAD><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD><BODY><H1>403 ERROR</H1><H2>Request blocked.</H2></BODY></HTML>'); return; }
        if (url.pathname.startsWith('/stores/') && opts.handlaPending > 0) { opts.handlaPending -= 1; res.writeHead(202).end(); return; }
        if (known) { send(known); return; }
      }
      json(res, 404, { error: 'not found' });
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoints: { ims: base, web: base, gateway: base, handla: base, handlaStores: base }, opts, seen, app,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** Run the whole fake BankID web login and return the logged-in cookie session. */
export async function fakeLoggedInSession(fake: FakeIca): Promise<IcaSession> {
  let t = Date.now();
  const relay = new BankidRelay({ endpoints: fake.endpoints, now: () => (t += 1000) });
  await relay.start('web');
  for (let i = 0; i < 100; i++) {
    const r = await relay.poll();
    if (r.state === 'complete') return relay.session;
    if (r.state === 'failed') throw new Error(r.reason);
  }
  throw new Error('fake login did not complete');
}

/** Gateway/www answers for the diagnostics probes, sprinkled with personal data that must never be rendered. */
export const FAKE_PROBE_ROUTES: FakeIcaOptions['routes'] = {
  '/sverige/digx/shopping-list/v1/api/list/all': { status: 200, body: [
    { id: 'list-shared-1', name: 'Veckohandling', ownerName: FAKE_SECRETS.firstName, rows: [{ articleName: 'Mjölk', quantity: 2 }] },
    { id: 'list-2', name: 'Fest', sharedWith: [{ firstName: FAKE_SECRETS.firstName, email: 'partner@example.se' }] },
  ] },
  '/sverige/digx/shoppinglistarticlesearch/v1/search': { status: 200, body: { articles: [{ id: 1, name: 'Mjölk 3%' }] } },
  '/sverige/digx/mobile/shoppinglistservice/v1/shoppinglists': { status: 200, body: { shoppingLists: [{ offlineId: 'off-1', title: 'Veckohandling' }] } },
  '/sverige/digx/mobile/storeservice/v1/favorites': { status: 200, body: { favoriteStores: [12345, 67890] } },
  '/sverige/digx/mobile/storeservice/v1/stores/12345': { status: 200, body: { id: 12345, storeName: 'ICA Fake', address: { street: FAKE_SECRETS.street } } },
  '/sverige/digx/mobile/offerservice/v1/offersdiscounts/12345': { status: 200, body: { offers: [{ offerId: 'o1', articleName: 'Kaffe' }] } },
  '/sverige/digx/mobile/bonusservice/v1/bonus/current': { status: 200, body: { cardNumber: '6035000011112222', personnummer: FAKE_SECRETS.personnummer, bonus: 12.5, note: `for ${FAKE_SECRETS.personnummer}` } },
  '/sverige/digx/mobile/productservice/v1/product/7310865004703': { status: 451, body: { error: 'geo' } },
  '/api/cpa/purchases/historical/me/monthsummaries': { status: 200, body: { monthSummaries: [{ year: 2026, month: 8, total: 1000 }, { year: 2025, month: 12, total: 900 }, { year: 2026, month: 7, total: 800 }] } },
  '/api/cpa/purchases/historical/me/byyearmonth/2026-08': { status: 200, body: { receipts: [{ storeName: 'ICA Fake', total: 99, customer: { firstName: FAKE_SECRETS.firstName } }], token: FAKE_SECRETS.accessToken } },
};

export const fakeStore = (id: number, marketingName: string, city: string, today: string) => ({
  id, accountNumber: 'ACC-FAKE', marketingName, address: { street: FAKE_SECRETS.street, zip: '12345', city }, phone: '08-000 00 00', email: 'butik@example.se',
  coordinates: { latitude: 59.3, longitude: 18.0 }, webURL: 'https://example.se',
  openingHours: {
    today, // shape: from 2.1 (today)
    regularHours: [{ title: 'Mån–fre', hours: '08–22' }, { title: 'Lördag–söndag', hours: '09–20' }], // shape: from 2.1 (regularHours[0])
    specialHours: [{ title: 'Midsommarafton', hours: '08–14' }], // shape: from 2.1 (specialHours[0])
    departmentHours: [], serviceOpeningHours: [],
  },
  services: ['Apotek'], storeOnlineEngagements: [], otherOnlineEngagements: [],
});
const offer = (id: string, name: string, brand: string, condition: string, group: string, extra: Record<string, unknown> = {}) => ({
  id,
  category: { articleGroupName: group, articleGroupId: 100, expandedArticleGroupName: `${group} (utökad)`, expandedArticleGroupId: 200 }, // shape: from 2.1 (category)
  name, brand, packageInformation: '900 g', condition, restriction: 'Max 2 köp/hushåll',
  isSelfScan: false, requiresLoyaltyCard: true, pictureUrl: `https://images.example/${id}.jpg`, listImageUrl: `https://images.example/${id}-s.jpg`,
  parsedMechanics: { type: 'fixed', quantity: 1, unitSign: 'st', value1: condition, value2: '', value3: '', value4: '' }, // shape: from 2.1 (parsedMechanics)
  isPersonal: false, isUsed: false, validFrom: '2026-09-28T00:00:00', validTo: '2026-10-04T23:59:59',
  isValidInStore: true, isValidOnline: false, referencePriceText: 'Jfr-pris 110 kr/kg', isProfileHighlight: false, isStoreHighlight: false, isKlipp: false, ...extra,
});
export const FAKE_OFFERS = [
  offer('OF-1', 'Kycklingfilé', 'Kronfågel', '99 kr/st', 'Kyckling'),
  offer('OF-2', 'Bryggkaffe', 'Zoégas', '2 för 89 kr', 'Kaffe'),
  offer('OF-3', 'Kycklingklubbor', 'Guldfågeln', '49 kr/kg', 'Kyckling', { isPersonal: true }),
  offer('OF-4', 'Mellanmjölk', 'Arla', '15 kr/st', 'Mejeri', { isValidInStore: false, isValidOnline: true }),
];
export const FAKE_BONUS = {
  stammisBoostPreamble: 'Stammis', stammisBoostText: 'Du är Stammis', stammisBoostBonusLevelText: 'Bonusnivå 3',
  bonusLevels: [{ levelId: 1, pointValueFrom: 0, pointValueTom: 2499, voucherValue: 25 }, { levelId: 2, pointValueFrom: 2500, pointValueTom: 4999, voucherValue: 50 }],
  vouchers: {
    active: [{ value: 50 }], // shape: unknown (2.1's capture found it empty); kept lenient
    used: [{ title: 'Extra kaffe', subTitle: '2 för 1', description: 'Rabatt på bryggkaffe', redeemedDate: '2026-08-15', voucherCode: 'VCH-FAKE-1234', voucherType: 'discount', sender: 'ICA', voucherAmount: 20 }], // shape: from 2.1 (vouchers.used[0])
  },
  accountBalance: {
    showPreliminaryBonus: false, preliminaryBonusText: '', voucherMonth: 'oktober', loyaltyMonth: 'september', totalVoucherValue: 50, nextVoucherValue: 75,
    remainingPointsIncludingBoost: 812, remainingDays: 2, title: 'Din bonus',
    groupedBalances: [{ balanceCode: 1, balanceDescription: 'Ordinarie bonus', pointValue: 812, voucherValue: 50, detailedBalances: [
      { balanceDescription: 'Kvitto 2026-09-01', pointValue: 200, voucherValue: 10, sender: 'ICA Nära Fakeby' },
    ] }], // shape: from 2.1 (accountBalance.groupedBalances[0])
  },
  discountSummary: { totalDiscount: 1234.5, numberOfPurchases: 87 }, errorFetchingDiscount: false,
  cardNumber: '6035000011112222',
};
export const FAKE_APP_ROUTES: FakeIcaOptions['routes'] = {
  '/sverige/digx/mobile/storeservice/v1/favorites': { status: 200, body: { favoriteStores: [12345, 67890], visitedStores: [12345] } },
  '/sverige/digx/mobile/storeservice/v1/stores/12345': { status: 200, body: fakeStore(12345, 'ICA Nära Fakeby', 'Fakeby', '08–22') },
  '/sverige/digx/mobile/storeservice/v1/stores/67890': { status: 200, body: fakeStore(67890, 'ICA Kvantum Testköping', 'Testköping', '07–23') },
  '/sverige/digx/mobile/offerservice/v1/offersdiscounts/12345': { status: 200, body: { discounts: [], offers: FAKE_OFFERS } },
  '/sverige/digx/mobile/offerservice/v1/offersdiscounts/67890': { status: 200, body: { discounts: [], offers: [FAKE_OFFERS[1]] } },
  '/sverige/digx/mobile/bonusservice/v1/bonus/current': { status: 200, body: FAKE_BONUS },
  '/sverige/digx/mobile/productservice/v1/product/7310865004703': { status: 200, body: { gtin: '7310865004703', consumerItemId: 111, name: 'Mellanmjölk 1,5% 1l', articleId: 222, articleGroupId: 333, expandedArticleGroupId: 444 } },
};

/**
 * Article search over the web bearer. Live shape (2.1 capture, `web-article-search documents[0]`, truncated at 500
 * chars): `{_id, id, name, pluralName, alternativeSpelling, productEan, storeArticleGroupId, expandedArticleGroupName,
 * expandedArticleGroupId, articleGroupName, articleGroupId, status, latestChange, maxiFormatCategoryId, …}`. The
 * category field is `articleGroupName` (confirmed live, the short group name — same field `offer.category` uses in
 * `FAKE_OFFERS`); reconciled from the brief's invented `naraFormatCategoryName`, which is not a field ICA sends.
 */
export const FAKE_WEB_ROUTES: FakeIcaOptions['routes'] = {
  '/sverige/digx/shoppinglistarticlesearch/v1/search': { status: 200, body: { documents: [
    { _id: 'a1', id: 1001, name: 'Mellanmjölk 1,5%', articleGroupName: 'Mejeri' },
    { _id: 'a2', id: 1002, name: 'Standardmjölk 3%', articleGroupName: 'Mejeri' },
    { _id: 'a3', id: 1003, name: 'Havredryck', articleGroupName: 'Mejeri' },
  ], stats: { totalHits: 3 }, facets: [], spellSuggestions: [] } }, // shape: from 2.1 (documents[0])
  // Purchase history (2026-09-30 live capture at loginState 2): month summaries, and flat receipt headers per month
  // (no line items). The capture did not record the transactions array's key name: `transactions` is still assumed.
  '/api/cpa/purchases/historical/me/monthsummaries': { status: 200, body: { monthSummaries: [ // shape: from the 2026-09-30 live capture
    { year: 2026, month: 8, amount: 1445.5, amountSaved: 23 }, { year: 2026, month: 9, amount: 310, amountSaved: 0 }, { year: 2025, month: 12, amount: 2210.75, amountSaved: 118.4 },
  ] } },
  '/api/cpa/purchases/historical/me/byyearmonth/2026-08': { status: 200, body: { transactions: [ // shape: key name unverified — 2.22 live capture; elements from the 2026-09-30 live capture
    { transactionId: 'TX-FAKE-0001', transactionDate: '2026-08-14T17:02:11', storeId: 12345, storeMarketingName: 'ICA Nära Fakeby', storeCity: 'Fakeby', transactionChanel: 'Butik', transactionValue: 412.5, totalDiscount: 23, discountValue: 23 },
    { transactionId: 'TX-FAKE-0002', transactionDate: '2026-08-02T10:00:00', storeId: 67890, storeMarketingName: 'ICA Kvantum Testköping', storeCity: 'Testköping', transactionChanel: 'Butik', transactionValue: 1033, totalDiscount: 0, discountValue: 0 },
  ] } },
};
const handlaStore = (id: number, accountId: string, name: string, city: string) => ({
  id, storeOwnerId: 9000 + id, name, city, street: FAKE_SECRETS.street, zipCode: '12345', storeFormat: 'kvantum', deliveryMethods: ['HOME_DELIVERY'],
  customerTypes: ['B2C'], accountId, retailerSiteId: `RS-${id}`, storeProfileId: `SP-${id}`, slug: `store-${id}`,
});
const handlaProduct = (productId: string, name: string, brand: string, size: string, amount: string, available: boolean) => ({
  productId, retailerProductId: `R-${productId}`, type: 'product', name, brand, packSizeDescription: size, countryOfOrigin: 'Sverige',
  price: { amount, currency: 'SEK' }, unitPrice: { price: { amount, currency: 'SEK' }, unit: 'fop.price.per.litre' }, available,
  isVerifiedPurchase: false, quantityInBasket: 0, maxQuantityReached: false, image: { src: `https://images.example/${productId}.jpg` },
});
/** Handla's anonymous store/product-search answers (docs/api-notes.md → "Handla (Ocado) public"). // shape: unverified — 2.22 live check */
export const FAKE_HANDLA_ROUTES: FakeIcaOptions['routes'] = {
  '/api/store/v1': { status: 200, body: { combinedHomePickupDelivery: false, forHomeDelivery: [handlaStore(1001, 'HS-1001', 'ICA Kvantum Testköping', 'Testköping'), handlaStore(1002, 'HS-1002', 'ICA Nära Fakeby', 'Fakeby')], forPickupDelivery: [handlaStore(1001, 'HS-1001', 'ICA Kvantum Testköping', 'Testköping')], offline: [], validZipCode: true, zipCode: '12345' } },
  '/stores/HS-1001/api/webproductpagews/v6/product-pages/search': { status: 200, body: { productGroups: [{ type: 'personalized', decoratedProducts: [handlaProduct('p-1', 'Mellanmjölk 1,5%', 'Arla', '1 l', '15.90', true), handlaProduct('p-2', 'Laktosfri mjölk', 'Arla Ko', '1 l', '19.50', false)] }], metadata: {}, missedPromotions: [] } },
};
export const FAKE_ALL_ROUTES: FakeIcaOptions['routes'] = { ...FAKE_APP_ROUTES, ...FAKE_WEB_ROUTES, ...FAKE_HANDLA_ROUTES };

/** A server on another origin that only counts requests: nothing ICA-bound may ever reach it. */
export async function startForeignHost(): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(302, { location: '/' }).end(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** An unsigned JWT-shaped token with the given claims (the hub only reads `sub`, it never verifies ICA's tokens). */
export const fakeJwt = (claims: Record<string, unknown>): string =>
  `${[{ alg: 'none' }, claims].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).join('.')}.sig`;

/** A stored-session state for tests that do not need the BankID app login (storeAppSession stamps issuedAt). */
export function fakeAppState(o: { accessToken?: string; refreshToken?: string; expiresIn?: number } = {}): AppState {
  return {
    client: { ...FAKE_APP_CLIENT },
    token: { access_token: o.accessToken ?? FAKE_SECRETS.appAccessToken, refresh_token: o.refreshToken ?? FAKE_SECRETS.appRefreshToken, expires_in: o.expiresIn ?? 900, token_type: 'Bearer', scope: FAKE_APP_CLIENT.scope },
    issuedAt: new Date(0).toISOString(),
  };
}
