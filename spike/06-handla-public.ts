import { CHROME_UA, newSession, redact, save } from './lib/http.js';

const s = newSession(CHROME_UA);
const zip = process.env.HANDLA_ZIP ?? '11122';
const stores = await s.fetch(`https://handla.ica.se/api/store/v1?${new URLSearchParams({ zip, customerType: 'B2C' })}`, { headers: { Accept: 'application/json' } });
const sj = (await stores.json()) as unknown;
console.log(`store search HTTP ${stores.status}`); save('handla-stores-redacted', redact(sj));
// Deviation from brief: the live response is not a bare array — it's an object with
// forHomeDelivery/forPickupDelivery/offline arrays of stores, each with an `accountId`.
type StoreListResponse = { forHomeDelivery?: { accountId?: string }[]; forPickupDelivery?: { accountId?: string }[] };
const firstStore = Array.isArray(sj)
  ? (sj[0] as { accountId?: string } | undefined)
  : ((sj as StoreListResponse).forHomeDelivery?.[0] ?? (sj as StoreListResponse).forPickupDelivery?.[0]);
const storeId = process.env.HANDLA_STORE_ID ?? String(firstStore?.accountId ?? '');
if (!storeId) throw new Error('set HANDLA_STORE_ID from the store search output (field accountId)');
const base = `https://handlaprivatkund.ica.se/stores/${storeId}`;
const headers = { Accept: 'application/json', Referer: `${base}/`, Origin: 'https://handlaprivatkund.ica.se' };
for (let attempt = 1; attempt <= 3; attempt++) {
  const r = await s.fetch(`${base}/api/webproductpagews/v6/product-pages/search?${new URLSearchParams({ q: 'mjölk', tag: 'web', maxPageSize: '10', includeAdditionalPageInfo: 'false', maxProductsToDecorate: '10' })}`, { headers });
  console.log(`product search HTTP ${r.status} (attempt ${attempt})`);
  if (r.status === 202) { await new Promise((res) => setTimeout(res, 1500)); continue; } // ica-cli: 202 = retry
  save('handla-search-redacted', redact(await r.json())); break;
}
const home = await s.fetch(`${base}/`, { headers: { Accept: 'text/html' } });
const html = await home.text();
const csrf = /"csrf"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/.exec(html)?.[1];
console.log(`store home HTTP ${home.status}; csrf token present (anonymous): ${Boolean(csrf)}; waf challenge: ${/awswaf|challenge/i.test(html)}`);
