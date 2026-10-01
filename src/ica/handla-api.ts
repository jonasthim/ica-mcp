import * as z from 'zod/v4';
import type { IcaEndpoints } from './endpoints.js';
import { IcaUnavailable, errorCategory } from './errors.js';
import { icaResponse, parseIca, type Fetcher } from './gateway.js';
import type { HandlaGuard } from './handla-guard.js';
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

/**
 * A plain 202 (no WAF header) is retried at most twice, after 0.5 s and then 1 s. This was once thought to mean
 * "preparing results"; live, the long-lasting 202s were WAF challenges (see isWafStop), so only a short retry is left.
 */
const DEFAULT_RETRY_DELAYS_MS = [500, 1000];
/** `Retry-After` on a plain 202 is honoured but never waited on for longer than this. */
const RETRY_AFTER_CAP_MS = 2000;
/** A 403 body is searched for "Request blocked" only when it is at most this long (CloudFront's error page is ~1 kB). */
const WAF_BODY_MAX = 16_384;
const defaultSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** `Retry-After` (seconds, the only form Handla has been seen to send) converted to ms and capped, or undefined if absent/unparseable. */
function retryAfterMs(headers: Headers): number | undefined {
  const v = headers.get('retry-after');
  if (v === null) return undefined;
  const seconds = Number(v);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, RETRY_AFTER_CAP_MS) : undefined;
}

/**
 * Whether CloudFront + AWS WAF refused the request (docs/api-notes.md → "Handla: AWS WAF"): any response carrying
 * `x-amzn-waf-action` (live: a 202 `challenge` with an empty body — there is no JS to run and no token to get, so
 * polling never clears it), or a 403 that CloudFront itself produced (`server: CloudFront`, `x-cache: Error from
 * cloudfront`, or a small HTML body saying "Request blocked"). The body is read from a clone, so `r` stays unread.
 */
export async function isWafStop(r: Response): Promise<boolean> {
  if (r.headers.has('x-amzn-waf-action')) return true;
  if (r.status !== 403) return false;
  if ((r.headers.get('server') ?? '').toLowerCase().includes('cloudfront')) return true;
  if ((r.headers.get('x-cache') ?? '').toLowerCase().startsWith('error from cloudfront')) return true;
  const declared = Number(r.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > WAF_BODY_MAX) return false;
  const text = await r.clone().text().catch(() => '');
  return text.length <= WAF_BODY_MAX && text.includes('Request blocked');
}

/** The cache key part of a query: case, surrounding and repeated whitespace do not make another search. */
const normaliseQuery = (q: string): string => q.trim().replace(/\s+/g, ' ').toLocaleLowerCase('sv-SE');

export type HandlaCallOptions = { signal?: AbortSignal };

/**
 * Handla's two anonymous calls. Every HTTP request goes through the process's one `guard` (circuit breaker, pacing
 * queue) and every successful answer through its cache; see handla-guard.ts. A WAF stop is
 * `IcaUnavailable('blocked')` at once, never polled.
 */
export function createHandlaApi(o: {
  endpoints: IcaEndpoints; guard: HandlaGuard; fetcher?: Fetcher;
  /** Test-only: replaces the real 0.5 / 1 s waits before a plain-202 retry. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Spends the caller's ICA budget token (the keeper's `take`; throws RateLimited). Called once per `stores`/`search`
   * call that is answered or sent: after a cache hit, or after the breaker check for a miss — never for a call the
   * open breaker refuses.
   */
  charge?: () => void;
}) {
  const f = o.fetcher ?? anonymous;
  const { guard } = o;
  const sleep = o.sleep ?? defaultSleep;
  const charge = o.charge ?? (() => undefined);

  /** Cache first (served even while the breaker is open), then the breaker, then the budget, then Handla. */
  const answer = async <T>(kind: 'search' | 'stores', key: string, load: () => Promise<T>): Promise<T> => {
    const hit = guard.peek<T>(kind, key);
    if (hit) { charge(); return hit.value; }
    guard.assertAvailable();
    charge();
    return guard.cached(kind, key, load);
  };

  /** One paced, breaker-guarded GET: a WAF stop is `blocked`, anything else maps like any ICA call (icaResponse). */
  const get = (url: string, headers: Record<string, string>, signal: AbortSignal | undefined) => guard.request(async () => {
    let r: Response;
    try {
      r = await f(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, ...(signal ? { signal } : {}) });
    } catch (e) { throw new IcaUnavailable(errorCategory(e)); }
    if (await isWafStop(r)) { await r.body?.cancel().catch(() => undefined); throw new IcaUnavailable('blocked', r.status); }
    return icaResponse(r);
  }, signal);

  return {
    stores: (zip: string, opts: HandlaCallOptions = {}): Promise<HandlaStoreSearch> => answer('stores', zip, async () =>
      parseIca(HandlaStoreSearchSchema, (await get(`${o.endpoints.handlaStores}/api/store/v1?${new URLSearchParams({ zip, customerType: 'B2C' })}`, {}, opts.signal)).json)),
    /**
     * A store's product search. A plain 202 (no WAF header) is retried at most twice (0.5 s, then 1 s; `Retry-After`
     * honoured up to 2 s), each retry through the pacing queue; still 202 → `IcaUnavailable('not-ready')`. One call
     * here spends exactly one of the caller's ICA budget tokens (taken by the keeper); the retries are internal.
     */
    search(storeId: string, query: string, max = 10, opts: HandlaCallOptions = {}): Promise<HandlaProduct[]> {
      return answer('search', `${storeId}\n${normaliseQuery(query)}\n${max}`, async () => {
        const base = `${o.endpoints.handla}/stores/${encodeURIComponent(storeId)}`;
        const url = `${base}/api/webproductpagews/v6/product-pages/search?${new URLSearchParams({ q: query, tag: 'web', maxPageSize: String(max), includeAdditionalPageInfo: 'false', maxProductsToDecorate: String(max) })}`;
        const headers = { Referer: `${base}/`, Origin: new URL(o.endpoints.handla).origin };
        let r = await get(url, headers, opts.signal);
        for (let i = 0; r.status === 202 && i < DEFAULT_RETRY_DELAYS_MS.length; i += 1) {
          await sleep(retryAfterMs(r.headers) ?? DEFAULT_RETRY_DELAYS_MS[i]!);
          r = await get(url, headers, opts.signal);
        }
        if (r.status === 202) throw new IcaUnavailable('not-ready');
        return parseIca(HandlaSearchSchema, r.json).productGroups.flatMap((g) => g.decoratedProducts);
      });
    },
  };
}
export type HandlaApi = ReturnType<typeof createHandlaApi>;
