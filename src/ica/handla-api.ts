import * as z from 'zod/v4';
import type { IcaEndpoints } from './endpoints.js';
import { IcaRejected, IcaUnauthorized, IcaUnavailable, errorCategory } from './errors.js';
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
 * A plain 202 (no WAF header) is retried at most twice, after 0.5 s and then 1 s, each retry rejoining the pacing
 * queue. This was once thought to mean "preparing results"; live, the long-lasting 202s were WAF challenges (see
 * isWafStop), so only a short retry is left.
 */
const DEFAULT_RETRY_DELAYS_MS = [500, 1000];
/** `Retry-After` on a plain 202 is honoured but never waited on for longer than this. */
const RETRY_AFTER_CAP_MS = 2000;
/** At most this many bytes of a 403 body are read to look for "Request blocked" (CloudFront's page is ~1 kB). */
const WAF_BODY_MAX = 16_384;

/** Wait `ms`, or reject with `cancelled` as soon as `signal` fires. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new IcaUnavailable('cancelled'));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(t); reject(new IcaUnavailable('cancelled')); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `Retry-After` (seconds, the only form Handla has been seen to send) converted to ms and capped, or undefined if absent/unparseable. */
function retryAfterMs(headers: Headers): number | undefined {
  const v = headers.get('retry-after');
  if (v === null) return undefined;
  const seconds = Number(v);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, RETRY_AFTER_CAP_MS) : undefined;
}

/** The first `max` bytes of a body (decoded), or undefined when it is longer: never more than `max + chunk` read. */
async function smallBody(r: Response, max: number): Promise<string | undefined> {
  const reader = r.clone().body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) return undefined;
      chunks.push(value);
    }
  } catch { return ''; } finally {
    // Not awaited: cancelling one branch of a cloned (teed) body settles only once the other branch is cancelled too.
    void reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Whether AWS WAF refused the request (docs/api-notes.md → "Handla: AWS WAF"): any response carrying
 * `x-amzn-waf-action` (live: a 202 `challenge` with an empty body — there is no JS to run and no token to get, so
 * polling never clears it), or a 403 with any `x-amzn-waf-*` header or with a small body saying "Request blocked"
 * (CloudFront's own block page). `server: CloudFront` / `x-cache: Error from cloudfront` alone prove nothing: CloudFront
 * sets them on the origin's own 4xx too (e.g. an unknown store), and those must never open the breaker. At most
 * WAF_BODY_MAX bytes are read, from a clone, so `r` stays unread.
 */
export async function isWafStop(r: Response): Promise<boolean> {
  if (r.headers.has('x-amzn-waf-action')) return true;
  if (r.status !== 403) return false;
  for (const name of r.headers.keys()) if (name.toLowerCase().startsWith('x-amzn-waf-')) return true;
  const declared = Number(r.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > WAF_BODY_MAX) return false;
  return (await smallBody(r, WAF_BODY_MAX))?.includes('Request blocked') ?? false;
}

/** The cache key part of a query: case, surrounding and repeated whitespace do not make another search. */
const normaliseQuery = (q: string): string => q.trim().replace(/\s+/g, ' ').toLocaleLowerCase('sv-SE');

const compact = <T extends Record<string, unknown>>(o: T): { [K in keyof T]?: NonNullable<T[K]> } =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as { [K in keyof T]?: NonNullable<T[K]> };
const money = (m: { amount: string | number; currency?: string | null } | null | undefined): string | undefined =>
  m ? `${typeof m.amount === 'number' ? m.amount.toFixed(2) : m.amount}${m.currency ? ` ${m.currency}` : ''}` : undefined;
/** The comparison price when it has the usual Ocado shape `{ price: { amount, currency }, unit }`; else left out. // shape: unverified — 2.22 live check */
function unitPriceText(u: unknown): string | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const v = u as { price?: { amount?: unknown; currency?: unknown }; unit?: unknown };
  const amount = v.price?.amount;
  if (typeof amount !== 'string' && typeof amount !== 'number') return undefined;
  const p = money({ amount, currency: typeof v.price?.currency === 'string' ? v.price.currency : null });
  return typeof v.unit === 'string' && v.unit ? `${p} per ${v.unit}` : p;
}

/**
 * What the tools return — and all the cache keeps. Built field by field from named, typed fields: the schemas are
 * loose, so a spread would pass through whatever Handla adds (a store's street/phone/e-mail, a product's image, …).
 */
export type HandlaProductView = Partial<{ id: string; name: string; brand: string; size: string; price: string; unitPrice: string; available: boolean }>;
export type HandlaStoreView = Partial<{ id: string; name: string; city: string; delivery: boolean; pickup: boolean }>;
/** `asOf`: when Handla was asked (ISO time), so a cached price can be told apart from a fresh one. */
export type HandlaSearchResult = { asOf: string; products: HandlaProductView[] };
export type HandlaStoresResult = { asOf: string; stores: HandlaStoreView[] };
/** At most this many stores are returned for a postcode. */
export const HANDLA_MAX_STORES = 15;

const productView = (p: HandlaProduct): HandlaProductView => compact({
  id: p.productId, name: p.name, brand: p.brand, size: p.packSizeDescription, price: money(p.price), unitPrice: unitPriceText(p.unitPrice),
  available: typeof p.available === 'boolean' ? p.available : undefined,
});
function storesView(r: HandlaStoreSearch): HandlaStoreView[] {
  const byId = new Map<string, { store: HandlaStore; delivery: boolean; pickup: boolean }>();
  for (const st of r.forHomeDelivery) byId.set(st.accountId, { store: st, delivery: true, pickup: false });
  for (const st of r.forPickupDelivery) { const e = byId.get(st.accountId); if (e) e.pickup = true; else byId.set(st.accountId, { store: st, delivery: false, pickup: true }); }
  return [...byId.values()].slice(0, HANDLA_MAX_STORES).map((e) => compact({ id: e.store.accountId, name: e.store.name, city: e.store.city, delivery: e.delivery, pickup: e.pickup }));
}

export type HandlaCallOptions = { signal?: AbortSignal | undefined };

/**
 * Handla's two anonymous calls. Every HTTP request goes through the process's one `guard` (circuit breaker, pacing)
 * and every successful answer (its projected view only) through its cache; see handla-guard.ts. A WAF stop is
 * `IcaUnavailable('blocked')` at once, never polled.
 */
export function createHandlaApi(o: {
  endpoints: IcaEndpoints; guard: HandlaGuard; fetcher?: Fetcher;
  /** Test-only: replaces the real 0.5 / 1 s waits before a plain-202 retry (default: honours the abort signal). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Spends the caller's ICA budget token (the keeper's `take`; throws RateLimited) and returns how to give it back.
   * Called once per `stores`/`search` call: after a cache hit, or after the breaker check for a miss — never for a
   * call the open breaker refuses. A miss that ends without any request reaching Handla (refused or dropped while
   * queued, cancelled, shutting down, or joined to another caller's load that failed) is refunded.
   */
  charge?: () => (() => void) | void;
  /** Wall clock for `asOf` (default `new Date()`). */
  clock?: () => Date;
}) {
  const f = o.fetcher ?? anonymous;
  const { guard } = o;
  const sleep = o.sleep ?? abortableSleep;
  const charge = o.charge ?? (() => undefined);
  const clock = o.clock ?? (() => new Date());

  /** Cache first (served even while the breaker is open), then the breaker, then the budget, then Handla. */
  const answer = async <T>(kind: 'search' | 'stores', key: string, load: (sent: () => void) => Promise<T>): Promise<T> => {
    const hit = guard.peek<T>(kind, key);
    if (hit) { charge(); return hit.value; }
    guard.assertAvailable();
    const refund = charge();
    let sent = false;
    try {
      return await guard.cached(kind, key, () => load(() => { sent = true; }));
    } catch (e) {
      if (!sent) refund?.();
      throw e;
    }
  };

  /**
   * One paced, breaker-guarded GET: a WAF stop is `blocked`; a caller abort is `cancelled`; any other 401/403 is the
   * origin refusing this request (an unknown store, say), IcaRejected — the ICA credential is not involved; the rest
   * maps like any ICA call (icaResponse).
   */
  const get = (url: string, headers: Record<string, string>, signal: AbortSignal | undefined, sent: () => void) => guard.request(async () => {
    let r: Response;
    try {
      r = await f(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, ...(signal ? { signal } : {}) });
    } catch (e) { throw new IcaUnavailable(signal?.aborted ? 'cancelled' : errorCategory(e)); }
    if (await isWafStop(r)) { await r.body?.cancel().catch(() => undefined); throw new IcaUnavailable('blocked', r.status); }
    try { return await icaResponse(r); } catch (e) {
      if (e instanceof IcaUnauthorized) throw new IcaRejected(e.status);
      throw e;
    }
  }, signal, sent);

  return {
    stores: (zip: string, opts: HandlaCallOptions = {}): Promise<HandlaStoresResult> => answer('stores', zip, async (sent) => {
      const asOf = clock().toISOString();
      const r = await get(`${o.endpoints.handlaStores}/api/store/v1?${new URLSearchParams({ zip, customerType: 'B2C' })}`, {}, opts.signal, sent);
      return { asOf, stores: storesView(parseIca(HandlaStoreSearchSchema, r.json)) };
    }),
    /**
     * A store's product search. A plain 202 (no WAF header) is retried at most twice (0.5 s, then 1 s; `Retry-After`
     * honoured up to 2 s), each retry rejoining the pacing queue; still 202 → `IcaUnavailable('not-ready')`. One call
     * spends one of the caller's ICA budget tokens (`charge`); the retries are internal.
     */
    search(storeId: string, query: string, max = 10, opts: HandlaCallOptions = {}): Promise<HandlaSearchResult> {
      return answer('search', `${storeId}\n${normaliseQuery(query)}\n${max}`, async (sent) => {
        const base = `${o.endpoints.handla}/stores/${encodeURIComponent(storeId)}`;
        const url = `${base}/api/webproductpagews/v6/product-pages/search?${new URLSearchParams({ q: query, tag: 'web', maxPageSize: String(max), includeAdditionalPageInfo: 'false', maxProductsToDecorate: String(max) })}`;
        const headers = { Referer: `${base}/`, Origin: new URL(o.endpoints.handla).origin };
        const asOf = clock().toISOString();
        let r = await get(url, headers, opts.signal, sent);
        for (let i = 0; r.status === 202 && i < DEFAULT_RETRY_DELAYS_MS.length; i += 1) {
          await sleep(retryAfterMs(r.headers) ?? DEFAULT_RETRY_DELAYS_MS[i]!, opts.signal);
          r = await get(url, headers, opts.signal, sent);
        }
        if (r.status === 202) throw new IcaUnavailable('not-ready');
        const products = parseIca(HandlaSearchSchema, r.json).productGroups.flatMap((g) => g.decoratedProducts);
        return { asOf, products: products.slice(0, max).map(productView) };
      });
    },
  };
}
export type HandlaApi = ReturnType<typeof createHandlaApi>;
