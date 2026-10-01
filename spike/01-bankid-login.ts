import { CHROME_UA, IPHONE_UA, newSession, redact, redactUrl, save } from './lib/http.js';
import { bankidQrRelay, IMS } from './lib/bankid.js';
import { APP_REDIRECT_URI, WEB, appAuthorizeStart, appExchangeCode, appRegisterClient, gatewayApi } from './lib/app-auth.js';
import { saveJar } from './lib/jar.js';

const who = (process.env.ACCOUNT ?? 'A') as 'A' | 'B';   // A = owner, B = partner (each scans with their own BankID)
const mode = process.env.MODE ?? 'app,web';

if (mode.includes('app')) {
  console.log(`[${who}] app flow: DCR + PKCE authorize, then BankID QR`);
  const s = newSession(IPHONE_UA);
  const client = await appRegisterClient(s);
  const start = await appAuthorizeStart(s, client);           // no acr → chooser
  console.log(`authorize → HTTP ${start.status} location=${redactUrl(start.location ?? '')}`);
  if (start.location) await s.fetch(new URL(start.location, IMS).toString());   // render chooser, collect cookies
  try {
    const done = await bankidQrRelay(s);
    console.log(`app relay → HTTP ${done.status} location=${redactUrl(done.location ?? '')}`);
    if (done.location?.startsWith(APP_REDIRECT_URI)) {
      const code = /[?&]code=([^&]+)/.exec(done.location)?.[1];
      if (!code) throw new Error('no code in app redirect');
      const state = await appExchangeCode(s, client, decodeURIComponent(code), start.verifier);
      console.log(`APP TOKENS OBTAINED via BankID: expires_in=${state.token.expires_in} has_refresh=${Boolean(state.token.refresh_token)}`);
      save(`app-state-${who}`, state);
      save(`app-bankid-result-${who}`, { ok: true, expires_in: state.token.expires_in, has_refresh: Boolean(state.token.refresh_token), scope: state.token.scope ?? client.scope });
    } else {
      save(`app-bankid-result-${who}`, { ok: false, status: done.status, location: redactUrl(done.location ?? '') });
      console.log('App flow did NOT end at icacurity://app — record this in docs/api-notes.md and rely on the web flow.');
    }
  } catch (e) {
    save(`app-bankid-result-${who}`, { ok: false, error: String(e) });
    console.log(`App flow failed: ${String(e)}`);
  }
}

if (mode.includes('web')) {
  console.log(`[${who}] web flow: ica.se authorize, then BankID QR`);
  const s = newSession(CHROME_UA);
  await s.fetch(`${IMS}/oauth/v2/authorize?${new URLSearchParams({ client_id: 'ica.se', response_type: 'code', scope: 'openid ica-se-scope ica-se-scope-hard', prompt: 'login', redirect_uri: `${WEB}/logga-in/sso/callback` })}`);
  const done = await bankidQrRelay(s);
  if (!done.location) throw new Error(`web relay: expected redirect, got ${done.status}`);
  const landed = await s.fetch(new URL(done.location, IMS).toString());   // follow to ica.se callback → thSessionId
  console.log(`web callback chain ended at ${redactUrl(landed.url)} HTTP ${landed.status}`);
  const cookies = await s.jar.getCookies(`${WEB}/`);
  const th = cookies.find((c) => c.key === 'thSessionId');
  if (!th) throw new Error(`no thSessionId; jar has ${cookies.map((c) => c.key).join(',')}`);
  console.log(`thSessionId expires: ${th.expires instanceof Date ? th.expires.toISOString() : String(th.expires)}`);
  saveJar(s.jar, `web-jar-${who}`);
  const info = (await (await s.fetch(`${WEB}/api/user/information`, { headers: { Accept: 'application/json' } })).json()) as { accessToken?: string; loginState?: number; tokenExpires?: string } & Record<string, unknown>;
  console.log(`user/information: loginState=${info.loginState} tokenExpires=${info.tokenExpires}`);
  save(`web-user-information-${who}-redacted`, redact(info));
  if (!info.accessToken || info.loginState === 0) throw new Error('web session not live');
  // Which gateway endpoints accept the WEB bearer? This decides the Phase 2 API surface.
  const M = 'sverige/digx/mobile';
  const probes: [string, string][] = [
    ['web-list-all', 'sverige/digx/shopping-list/v1/api/list/all'],
    ['web-article-search', `sverige/digx/shoppinglistarticlesearch/v1/search?${new URLSearchParams({ query: 'mjölk' })}`],
    ['mobile-shoppinglists', `${M}/shoppinglistservice/v1/shoppinglists`],
    ['mobile-store-favorites', `${M}/storeservice/v1/favorites`],
    ['mobile-bonus', `${M}/bonusservice/v1/bonus/current`],
    ['mobile-product-ean', `${M}/productservice/v1/product/7310865004703`],
    ['mobile-recipes-random', `${M}/recipeservice/v1/recipes/random?numberofrecipes=1`],
  ];
  const matrix: Record<string, { status: number; sample: unknown }> = {};
  for (const [name, path] of probes) {
    const r = await gatewayApi(s, info.accessToken, 'GET', path);
    matrix[name] = { status: r.status, sample: redact(r.json ?? r.text.slice(0, 200)) };
    console.log(`${name.padEnd(24)} HTTP ${r.status}`);
  }
  const fav = (matrix['mobile-store-favorites']?.sample as { favoriteStores?: number[] } | undefined)?.favoriteStores?.[0];
  if (fav) {
    for (const [name, path] of [['mobile-store-detail', `${M}/storeservice/v1/stores/${fav}`], ['mobile-store-offers', `${M}/offerservice/v1/offersdiscounts/${fav}`]] as [string, string][]) {
      const r = await gatewayApi(s, info.accessToken, 'GET', path);
      matrix[name] = { status: r.status, sample: redact(r.json ?? r.text.slice(0, 200)) };
      console.log(`${name.padEnd(24)} HTTP ${r.status}`);
    }
  }
  save(`web-token-matrix-${who}`, matrix);
}
