import { existsSync, readFileSync } from 'node:fs';
import { CHROME_UA, IPHONE_UA, newSession, redact, save } from './lib/http.js';
import { WEB, gatewayApi, type AppState } from './lib/app-auth.js';
import { loadJar } from './lib/jar.js';

const appPath = 'spike/out/app-state-A.json';
let s; let bearer: string;
if (existsSync(appPath)) { s = newSession(IPHONE_UA); bearer = (JSON.parse(readFileSync(appPath, 'utf8')) as AppState).token.access_token; console.log('using app bearer'); }
else {
  const jar = loadJar('web-jar-A'); if (!jar) throw new Error('run 01-bankid-login first');
  s = newSession(CHROME_UA, jar);
  const info = (await (await s.fetch(`${WEB}/api/user/information`, { headers: { Accept: 'application/json' } })).json()) as { accessToken?: string; loginState?: number };
  if (!info.accessToken || info.loginState === 0) throw new Error('web session dead — scan again'); bearer = info.accessToken; console.log('using web bearer');
}
const M = 'sverige/digx/mobile';
const statuses: Record<string, number> = {};
const call = async (name: string, path: string) => { const r = await gatewayApi(s, bearer, 'GET', path); statuses[name] = r.status; console.log(`${name.padEnd(22)} HTTP ${r.status}`); save(`${name}-redacted`, redact(r.json ?? r.text.slice(0, 300))); return r.json as never; };
const fav = await call('store-favorites', `${M}/storeservice/v1/favorites`) as { favoriteStores?: number[] } | null;
const storeId = fav?.favoriteStores?.[0];
if (storeId) {
  await call('store-detail', `${M}/storeservice/v1/stores/${storeId}`);
  await call('store-offers', `${M}/offerservice/v1/offersdiscounts/${storeId}`);
  await call('offers-search', `${M}/offerservice/v1/offers/search?${new URLSearchParams({ query: 'kyckling', storeId: String(storeId) })}`);
} else console.log('no favourite store (or favourites not reachable) — add one in the ICA app, or note the status');
await call('bonus', `${M}/bonusservice/v1/bonus/current`);
await call('product-ean', `${M}/productservice/v1/product/7310865004703`);
await call('product-ean-missing', `${M}/productservice/v1/product/0000000000000`);
await call('articles-search', `sverige/digx/shoppinglistarticlesearch/v1/search?${new URLSearchParams({ query: 'mjölk' })}`);
save('offers-stores-statuses', statuses);
