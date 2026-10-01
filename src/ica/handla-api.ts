import * as z from 'zod/v4';
import type { IcaEndpoints } from './endpoints.js';
import { IcaUnavailable } from './errors.js';
import { icaJson, icaRequest, parseIca, type Fetcher } from './gateway.js';
import { CHROME_UA, withTimeout } from './http.js';

/**
 * Handla's anonymous APIs (docs/api-notes.md → "Handla (Ocado) public"): store search by zip on handla.ica.se and a
 * store's product search, with online prices, on handlaprivatkund.ica.se. No cookie, no token, no BankID — these are
 * public calls, not the ICA account. Nothing below has been verified against the live endpoints; every field the
 * schemas type beyond what the tools strictly need is marked as an assumption for Task 2.22's live check.
 */
// shape: unverified — 2.22 live check
const idLike = z.union([z.number(), z.string()]);
export const HandlaStoreSchema = z.looseObject({
  accountId: idLike.transform(String), name: z.string(), city: z.string().nullish(), storeFormat: z.string().nullish(),
});
export const HandlaStoreSearchSchema = z.looseObject({
  forHomeDelivery: z.array(HandlaStoreSchema).default([]), forPickupDelivery: z.array(HandlaStoreSchema).default([]), validZipCode: z.unknown().optional(),
});
const Money = z.looseObject({ amount: z.union([z.number(), z.string()]), currency: z.string().nullish() });
export const HandlaProductSchema = z.looseObject({
  productId: z.string(), name: z.string(), brand: z.string().nullish(), packSizeDescription: z.string().nullish(),
  price: Money.nullish(), unitPrice: z.unknown().optional(), available: z.boolean().nullish(),
});
export const HandlaSearchSchema = z.looseObject({ productGroups: z.array(z.looseObject({ decoratedProducts: z.array(HandlaProductSchema).default([]) })) });

export type HandlaStore = z.output<typeof HandlaStoreSchema>;
export type HandlaStoreSearch = z.output<typeof HandlaStoreSearchSchema>;
export type HandlaProduct = z.output<typeof HandlaProductSchema>;

/**
 * No cookie jar, no bearer: a plain timed fetch with the browser UA, exactly like the other anonymous ICA calls.
 * `withTimeout` combines the 15 s timeout with a caller's own `init.signal` instead of replacing it.
 */
const anonymous: Fetcher = (url, init = {}) => withTimeout(init, (i) => fetch(url, {
  ...i,
  headers: { 'User-Agent': CHROME_UA, 'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8', ...(i.headers as Record<string, string> | undefined) },
}));

/** The default poll schedule after a 202 (0.5, 1, 1.5, 2 and 2 s — about 7 s total), under the 15 s request timeout. */
const DEFAULT_POLL_DELAYS_MS = [500, 1000, 1500, 2000, 2000];
/** `Retry-After` is honoured but never waited on for longer than this, however long Handla asks for. */
const RETRY_AFTER_CAP_MS = 3000;
const defaultSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** `Retry-After` (seconds, the only form Handla has been seen to send) converted to ms and capped, or undefined if absent/unparseable. */
function retryAfterMs(headers: Headers): number | undefined {
  const v = headers.get('retry-after');
  if (v === null) return undefined;
  const seconds = Number(v);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, RETRY_AFTER_CAP_MS) : undefined;
}

export function createHandlaApi(o: {
  endpoints: IcaEndpoints; fetcher?: Fetcher;
  /** Test-only: replaces the real 0.5–2 s waits with something instant or inspectable. */
  sleep?: (ms: number) => Promise<void>;
  /** Test-only: replaces the default poll schedule. */
  pollDelaysMs?: number[];
}) {
  const f = o.fetcher ?? anonymous;
  const sleep = o.sleep ?? defaultSleep;
  const pollDelaysMs = o.pollDelaysMs ?? DEFAULT_POLL_DELAYS_MS;
  return {
    stores: (zip: string): Promise<HandlaStoreSearch> =>
      icaJson(f, `${o.endpoints.handlaStores}/api/store/v1?${new URLSearchParams({ zip, customerType: 'B2C' })}`, HandlaStoreSearchSchema),
    /**
     * A store's product search. Handla sometimes answers 202 while it prepares the page — likely longer for a store
     * or query it hasn't prepared recently — so a 202 is polled with increasing delays (`pollDelaysMs`, about 7 s in
     * total) rather than retried once. A `Retry-After` header is honoured, capped at `RETRY_AFTER_CAP_MS`. One call
     * here still spends exactly one of the caller's ICA budget tokens; the polling is internal. If it is still 202
     * after the last poll, `IcaUnavailable('not-ready')` is thrown, same as before.
     */
    async search(storeId: string, query: string, max = 10): Promise<HandlaProduct[]> {
      const base = `${o.endpoints.handla}/stores/${encodeURIComponent(storeId)}`;
      const url = `${base}/api/webproductpagews/v6/product-pages/search?${new URLSearchParams({ q: query, tag: 'web', maxPageSize: String(max), includeAdditionalPageInfo: 'false', maxProductsToDecorate: String(max) })}`;
      const headers = { Referer: `${base}/`, Origin: new URL(o.endpoints.handla).origin };
      let r = await icaRequest(f, url, { headers });
      for (let i = 0; r.status === 202 && i < pollDelaysMs.length; i += 1) {
        await sleep(retryAfterMs(r.headers) ?? pollDelaysMs[i]!);
        r = await icaRequest(f, url, { headers });
      }
      if (r.status === 202) throw new IcaUnavailable('not-ready');
      return parseIca(HandlaSearchSchema, r.json).productGroups.flatMap((g) => g.decoratedProducts);
    },
  };
}
export type HandlaApi = ReturnType<typeof createHandlaApi>;
