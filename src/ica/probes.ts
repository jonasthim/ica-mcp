import type { IcaEndpoints } from './endpoints.js';
import { readBody, type IcaSession } from './http.js';
import { fetchUserInformation } from './web-session.js';
import { shapeOf } from './shape.js';
import { appTokenShape, captureElements, type ElementShape } from './shape-capture.js';
import { isRecord } from './json.js';
import { errorCategory } from './errors.js';

/**
 * Read-only diagnostics: which ICA APIs does a stored web session reach? Gateway probes use the web `accessToken`
 * (from /api/user/information) as bearer, www probes use the cookie jar. A JSON answer is reported as its shape only
 * (keys and value types, see shape.ts), a non-JSON one as content type and size: no ICA value ever leaves this module.
 * User information contributes only `loginState`. Paths that embed account data (the favourite store id, the latest
 * purchase month) are reported with a placeholder instead. With `appBearer` (a stored app session), the `mobile/*`
 * probes use it instead of the web bearer, which the gateway refuses there (403, WSO2 900908).
 */
/** The credential a probe used: the web session's bearer or cookies, or the (experimental) app access token. */
export type ProbeAuth = 'web bearer' | 'app bearer' | 'web cookie';
export type ProbeResult = { name: string; host: 'web' | 'gateway'; auth: ProbeAuth; path: string; status: number | null; sample: string; note?: string };
/**
 * Why a session is not live. Only `logged-out` (loginState 0, or 401/403 on user information) means reconnect;
 * the rest say ICA could not be asked: `network`, `timeout`, `geo-blocked (451)`, `http <status>`.
 */
export type ProbeError = string;
export type ProbeReport = {
  live: boolean; error?: ProbeError; results: ProbeResult[]; listIds: { probe: string; ids: string[] }[]; elements: ElementShape[];
  /**
   * What to record as the session's loginState: the number user information reported with a 200; null when it
   * refused the request (401/403 say nothing about the loginState); absent otherwise (nothing to record).
   */
  loginState?: number | null;
};

export { errorCategory } from './errors.js';

const SAMPLE_MAX = 1200;
const M = '/sverige/digx/mobile';
const truncate = (s: string): string => (s.length > SAMPLE_MAX ? `${s.slice(0, SAMPLE_MAX)}…` : s);
const LIST_ID_KEYS = ['id', 'listId', 'offlineId', 'shoppingListId'] as const;

/** Ids of the objects in a bare array, or in arrays one level down (`{ shoppingLists: [...] }`). */
export function collectListIds(json: unknown): string[] {
  const arrays = Array.isArray(json) ? [json] : isRecord(json) ? Object.values(json).filter(Array.isArray) : [];
  const ids: string[] = [];
  for (const arr of arrays) {
    for (const item of arr as unknown[]) {
      if (!isRecord(item)) continue;
      for (const k of LIST_ID_KEYS) { const v = item[k]; if (typeof v === 'string' || typeof v === 'number') { ids.push(String(v)); break; } }
    }
  }
  return ids;
}

function firstFavourite(json: unknown): string | undefined {
  const favs = isRecord(json) ? json.favoriteStores ?? json.favorites ?? json.stores : json;
  const first: unknown = Array.isArray(favs) ? favs[0] : undefined;
  if (typeof first === 'number' || typeof first === 'string') return String(first);
  if (isRecord(first)) { const id = first.id ?? first.storeId; if (typeof id === 'number' || typeof id === 'string') return String(id); }
  return undefined;
}

function latestMonth(json: unknown): string | undefined {
  const months = isRecord(json) && Array.isArray(json.monthSummaries) ? (json.monthSummaries as unknown[]) : [];
  let best: { year: number; month: number } | undefined;
  for (const m of months) {
    if (!isRecord(m) || typeof m.year !== 'number' || typeof m.month !== 'number') continue;
    if (!best || m.year * 100 + m.month > best.year * 100 + best.month) best = { year: m.year, month: m.month };
  }
  return best && `${best.year}-${String(best.month).padStart(2, '0')}`;
}

export async function runProbes(session: IcaSession, endpoints: IcaEndpoints, o: { appBearer?: string } = {}): Promise<ProbeReport> {
  const results: ProbeResult[] = [];
  const listIds: ProbeReport['listIds'] = [];
  const elements: ElementShape[] = [];

  let info;
  try { info = await fetchUserInformation(session, endpoints); } catch (e) {
    const error = errorCategory(e);
    results.push({ name: 'user-information', host: 'web', auth: 'web cookie', path: '/api/user/information', status: null, sample: '', note: `request failed (${error})` });
    return { live: false, error, results, listIds, elements };
  }
  results.push({ name: 'user-information', host: 'web', auth: 'web cookie', path: '/api/user/information', status: info.status, sample: JSON.stringify({ loginState: info.loginState ?? null }) });
  const bearer = info.accessToken;
  const reported = info.status === 200 && info.loginState !== undefined ? { loginState: info.loginState }
    : info.status === 401 || info.status === 403 ? { loginState: null } : {};
  const error: ProbeError | undefined =
    info.status === 401 || info.status === 403 || info.loginState === 0 ? 'logged-out'
      : info.status === 451 ? 'geo-blocked (451)'
        : info.status >= 400 ? `http ${info.status}`
          : !bearer ? `http ${info.status} without accessToken` : undefined;
  if (error || !bearer) {
    results[0]!.note = error === 'logged-out' ? 'not logged in: reconnect with BankID' : `could not check the session: ${error ?? 'unknown'}`;
    return { live: false, error: error ?? 'unknown', results, listIds, elements, ...reported };
  }
  elements.push({ probe: 'user-information', label: '(whole answer)', shape: info.shape });
  if (o.appBearer) elements.push({ probe: 'app-token', label: 'access token claims', shape: appTokenShape(o.appBearer) });

  /** One GET; returns the parsed JSON (for follow-up probes only) and records its shape. `shownPath` masks account data. */
  const probe = async (name: string, host: ProbeResult['host'], path: string, shownPath: string = path): Promise<unknown> => {
    const url = `${host === 'gateway' ? endpoints.gateway : endpoints.web}${path}`;
    const useApp = host === 'gateway' && o.appBearer !== undefined && path.startsWith(`${M}/`);
    const auth: ProbeAuth = host === 'web' ? 'web cookie' : useApp ? 'app bearer' : 'web bearer';
    const headers: Record<string, string> = { Accept: 'application/json', ...(host === 'gateway' ? { Authorization: `Bearer ${useApp ? o.appBearer : bearer}` } : {}) };
    try {
      const r = await session.fetch(url, { headers });
      const { json, text } = await readBody(r);
      // Non-JSON (an HTML error page, say) is described, never excerpted: it can hold anything.
      const sample = json !== null ? truncate(shapeOf(json)) : `${r.headers.get('content-type') ?? 'unknown type'}, ${Buffer.byteLength(text)} bytes`;
      results.push({ name, host, auth, path: shownPath, status: r.status, sample, ...(r.status === 451 ? { note: 'geo-blocked: ICA needs a Swedish IP' } : {}) });
      if (r.ok && json !== null) elements.push(...captureElements(name, json));
      return r.ok ? json : null;
    } catch (e) {
      results.push({ name, host, auth, path: shownPath, status: null, sample: '', note: `request failed (${errorCategory(e)})` });
      return null;
    }
  };

  const webLists = await probe('web-list-all', 'gateway', '/sverige/digx/shopping-list/v1/api/list/all');
  listIds.push({ probe: 'web-list-all', ids: collectListIds(webLists) });
  await probe('web-article-search', 'gateway', `/sverige/digx/shoppinglistarticlesearch/v1/search?${new URLSearchParams({ query: 'mjölk' })}`);
  const mobileLists = await probe('mobile-shoppinglists', 'gateway', `${M}/shoppinglistservice/v1/shoppinglists`);
  listIds.push({ probe: 'mobile-shoppinglists', ids: collectListIds(mobileLists) });
  const fav = firstFavourite(await probe('mobile-store-favorites', 'gateway', `${M}/storeservice/v1/favorites`));
  if (fav) {
    await probe('mobile-store-detail', 'gateway', `${M}/storeservice/v1/stores/${encodeURIComponent(fav)}`, `${M}/storeservice/v1/stores/<favourite store>`);
    await probe('mobile-store-offers', 'gateway', `${M}/offerservice/v1/offersdiscounts/${encodeURIComponent(fav)}`, `${M}/offerservice/v1/offersdiscounts/<favourite store>`);
  }
  await probe('mobile-bonus', 'gateway', `${M}/bonusservice/v1/bonus/current`);
  await probe('mobile-product-ean', 'gateway', `${M}/productservice/v1/product/7310865004703`);
  const month = latestMonth(await probe('purchase-month-summaries', 'web', '/api/cpa/purchases/historical/me/monthsummaries'));
  if (month) await probe('purchase-latest-month', 'web', `/api/cpa/purchases/historical/me/byyearmonth/${month}`, '/api/cpa/purchases/historical/me/byyearmonth/<latest month>');
  return { live: true, results, listIds, elements, ...reported };
}
