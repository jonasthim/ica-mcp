import * as z from 'zod/v4';
import type { IcaEndpoints } from './endpoints.js';
import { bearerFetcher, icaJson, type Fetcher } from './gateway.js';
import type { IcaSession } from './http.js';
import { icaDay } from './dates.js';

/**
 * Typed client for the gateway APIs the web bearer reaches (article search). Pass the **web** bearer: the app bearer
 * presumably (not probed live) gets 403 (WSO2 900908) here, same as the web bearer does on `mobile/*` (api-notes.md
 * marks the app bearer on article search as "not probed").
 *
 * `ArticleSchema` is one search hit (2.1 capture, `web-article-search documents[0]`, truncated at 500 chars):
 * `{_id, id, name, pluralName, alternativeSpelling, productEan, storeArticleGroupId, expandedArticleGroupName,
 * expandedArticleGroupId, articleGroupName, articleGroupId, status, latestChange, maxiFormatCategoryId,
 * maxiFormatCategoryName, …}`. Only `id`/`name` (the tool's identity) and `articleGroupName` (the tool's `category`,
 * the short group name — the same field `stores.ts`'s `categoryText` reads on an offer) are typed; the rest passes
 * through unread (looseObject).
 */
export const ArticleSchema = z.looseObject({ id: z.number(), name: z.string(), articleGroupName: z.string().nullish() }); // shape: from 2.1
/** Required array key: a renamed key must fail loudly, not read as "no hits". */
export const ArticleSearchSchema = z.looseObject({ documents: z.array(ArticleSchema), stats: z.looseObject({ totalHits: z.number().nullish() }).nullish() }); // shape: from 2.1

export type Article = z.output<typeof ArticleSchema>;
export type ArticleSearch = z.output<typeof ArticleSearchSchema>;

export function createWebApi(o: { endpoints: IcaEndpoints; bearer: string; fetcher?: Fetcher }) {
  const f = o.fetcher ?? bearerFetcher(o.bearer);
  const url = (path: string): string => `${o.endpoints.gateway}${path}`;
  return {
    /** GET an article-name search — one ICA call. */
    searchArticles: (query: string): Promise<ArticleSearch> =>
      icaJson(f, `${url('/sverige/digx/shoppinglistarticlesearch/v1/search')}?${new URLSearchParams({ query })}`, ArticleSearchSchema),
  };
}
export type WebApi = ReturnType<typeof createWebApi>;

/*
 * Purchase history (www.ica.se `/api/cpa/purchases/historical/me/*`, cookie session). Shapes from the 2026-09-30 live
 * capture at loginState 2: month summaries `{year, month, amount, amountSaved}`, and per month flat receipt headers
 * `{transactionId, transactionDate, storeId, storeMarketingName, storeCity, transactionChanel (sic), transactionValue,
 * totalDiscount, discountValue}` — no line items. Typed only as far as the tools need, and tolerant: numbers may come
 * as numeric strings (comma decimals), dates as strings or epochs. Never `z.record`: an ICA-chosen key must never end
 * up in an issue path, and every issue path here is made of our own key names.
 */

/**
 * A number, or a numeric string with a comma or dot decimal of at most two places (spaces as thousands separators);
 * anything else → undefined. Kronor never have three decimals, so "1.234" / "1,234" could be a thousands group:
 * ambiguous, so undefined rather than a possibly wrong amount.
 */
export const toAmount = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/[\s\u00a0]/g, '');
  return /^-?\d+([.,]\d{1,2})?$/.test(t) ? Number(t.replace(',', '.')) : undefined;
};
const amount = z.unknown().transform(toAmount).optional();
/** A whole number, or a string of digits. */
const intLike = z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)]);
const YEAR_MONTH = /^(\d{4})-(\d{2})/;

export const MonthSummarySchema = z.looseObject({
  year: intLike.nullish(), month: intLike.nullish(), // shape: from the 2026-09-30 live capture (numbers)
  yearMonth: z.string().nullish(), period: z.string().nullish(), // tolerated alternatives, not observed
  amount, amountSaved: amount, // shape: from the 2026-09-30 live capture
}).transform((m, ctx) => {
  // A zoned timestamp (…T22:30:00Z) belongs to its Stockholm month; a plain `YYYY-MM…` is taken as written.
  const raw = m.yearMonth ?? m.period ?? '';
  const ym = YEAR_MONTH.exec(icaDay(raw) ?? raw);
  const year = m.year ?? (ym ? Number(ym[1]) : undefined);
  const month = m.month ?? (ym ? Number(ym[2]) : undefined);
  if (year === undefined || month === undefined || month < 1 || month > 12) {
    ctx.addIssue({ code: 'custom', message: 'no valid year and month', path: ['month'] });
    return z.NEVER;
  }
  return { year, month, amount: m.amount, amountSaved: m.amountSaved };
});
/** Required array key: a renamed key must fail loudly, not read as "no months". */
export const MonthSummariesSchema = z.looseObject({ monthSummaries: z.array(MonthSummarySchema) }); // shape: from the 2026-09-30 live capture
export const PurchaseSchema = z.looseObject({
  transactionDate: z.union([z.string(), z.number()]).nullish(), // shape: from the 2026-09-30 live capture (string; an epoch is tolerated)
  storeMarketingName: z.string().nullish(), // shape: from the 2026-09-30 live capture
  storeCity: z.string().nullish(), // shape: from the 2026-09-30 live capture
  transactionValue: amount, // shape: from the 2026-09-30 live capture
  totalDiscount: amount, // shape: from the 2026-09-30 live capture
  discountValue: amount, // shape: from the 2026-09-30 live capture
});
/**
 * One month's receipts. The capture recorded the first array (or first array-valued property) without its key name,
 * so the key `transactions` is still assumed (shape: unverified — 2.22 live capture); a bare top-level array is
 * accepted too, and `transactions: null` is an empty month. Neither present fails loudly (a renamed key must never
 * read as "no purchases").
 */
export const PurchaseMonthSchema = z.preprocess(
  (v) => (Array.isArray(v) ? { transactions: v } : v),
  z.looseObject({ transactions: z.array(PurchaseSchema).nullable().transform((t) => t ?? []) }),
);

export type MonthSummary = z.output<typeof MonthSummarySchema>;
export type Purchase = z.output<typeof PurchaseSchema>;
export type PurchaseMonth = z.output<typeof PurchaseMonthSchema>;

/**
 * www.ica.se purchase history with the web cookie jar. ICA answers only while the web loginState is 2; at 1 it answers
 * 403 with an empty body (IcaUnauthorized(403)), which means "needs a fresh web BankID login", not a dead session.
 * Only ever called through the keeper's `withWebCookies` (the jar lock and the loginState check).
 */
export function createPurchaseApi(o: { endpoints: IcaEndpoints; session: IcaSession }) {
  const f: Fetcher = (u, init) => o.session.fetch(u, init);
  const base = `${o.endpoints.web}/api/cpa/purchases/historical/me`;
  return {
    /** The months with purchases — one ICA call. */
    async monthSummaries(): Promise<MonthSummary[]> { return (await icaJson(f, `${base}/monthsummaries`, MonthSummariesSchema)).monthSummaries; },
    /** One month's purchases (`yearMonth` as `YYYY-MM`) — one ICA call. */
    month: (yearMonth: string): Promise<PurchaseMonth> => icaJson(f, `${base}/byyearmonth/${encodeURIComponent(yearMonth)}`, PurchaseMonthSchema),
  };
}
export type PurchaseApi = ReturnType<typeof createPurchaseApi>;
