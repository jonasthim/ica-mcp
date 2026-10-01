import { type Session, redactUrl } from './http.js';
import { IMS, bankidQrRelay } from './bankid.js';
import { saveJar } from './jar.js';

export const HANDLA = 'https://handlaprivatkund.ica.se';

/** Log in to Handla: open the site's login start URL (→ ims authorize for client OcadoB2C → chooser), run the BankID QR relay, follow the redirect to /sso-login. Saves the jar as handla-jar-<who>. */
export async function handlaBankidLogin(s: Session, startUrl: string, who: string): Promise<void> {
  const start = await s.fetch(startUrl);
  if (!start.ok) throw new Error(`handla login start: HTTP ${start.status} at ${redactUrl(start.url)}`);
  const done = await bankidQrRelay(s);
  if (!done.location) throw new Error(`handla relay: expected redirect, got ${done.status}`);
  const landed = await s.fetch(new URL(done.location, IMS).toString());   // → https://handlaprivatkund.ica.se/sso-login?code=… → store
  console.log(`handla callback chain ended at ${redactUrl(landed.url)} HTTP ${landed.status}`);
  const cookies = await s.jar.getCookies(`${HANDLA}/`);
  if (cookies.length === 0) throw new Error('no handlaprivatkund cookies after login');
  saveJar(s.jar, `handla-jar-${who}`);
}

export async function handlaCsrf(s: Session, storeId: string): Promise<string> {
  const r = await s.fetch(`${HANDLA}/stores/${storeId}/`, { headers: { Accept: 'text/html' } });
  const html = await r.text();
  const m = /"csrf"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/.exec(html);
  if (!m?.[1]) throw new Error(`no csrf token in store page (HTTP ${r.status}); waf=${/awswaf/i.test(html)}`);
  return m[1];
}

/** True for an object we can actually trust as a cart line: a numeric `quantity` plus the exact key `productId` or `retailerProductId` (present, any value) — the keys `handlaCartQuantity` matches against. A quantity next to some other product-id-*like* key (e.g. `itemProductId`) doesn't count: we'd never be able to match a product against a key we don't check. */
function isTrustworthyCartLine(obj: Record<string, unknown>): boolean {
  return typeof obj.quantity === 'number' && ('productId' in obj || 'retailerProductId' in obj);
}

/**
 * Defensively search a Handla cart JSON response (shape unconfirmed — we've never captured one)
 * for a line whose `productId` or `retailerProductId` equals `productId`, and return its numeric
 * `quantity`.
 *
 * Returns 0 only if at least one *trustworthy* cart line was found (a numeric `quantity` next to
 * an exact `productId` or `retailerProductId` key) and none matched — i.e. the product genuinely
 * isn't in the cart. Returns `'unknown'` if no trustworthy cart line was found anywhere in the
 * response — either the shape wasn't recognised at all (wrong wrapper, an error body, …) or every
 * candidate line used some other product-id-like key we don't check (e.g. `itemProductId`), which
 * would let a real match slip past us silently. Callers must *not* treat `'unknown'` as "not in
 * the cart".
 */
export function handlaCartQuantity(cart: unknown, productId: string): number | 'unknown' {
  let sawTrustworthyLine = false;
  const visit = (node: unknown): number | undefined => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (isTrustworthyCartLine(obj)) {
        sawTrustworthyLine = true;
        if (obj.productId === productId || obj.retailerProductId === productId) return obj.quantity as number;
      }
      for (const value of Object.values(obj)) {
        const found = visit(value);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const found = visit(cart);
  if (found !== undefined) return found;
  return sawTrustworthyLine ? 0 : 'unknown';
}

export function handlaHeaders(storeId: string, csrf?: string): Record<string, string> {
  return {
    Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8',
    Origin: HANDLA, Referer: `${HANDLA}/stores/${storeId}/`,
    'ecom-request-source': 'web', 'ecom-request-source-version': '2.0.0',
    ...(csrf ? { 'X-CSRF-TOKEN': csrf } : {}),
  };
}
