import { shapeOf } from './shape.js';
import { isRecord } from './json.js';

/**
 * Element shapes for the diagnostics page: the shape (keys and value types, see shape.ts) of one element at a chosen
 * path of a probe's JSON answer, so the Phase 2 schemas can be written from what ICA really sends. Same rule as
 * shape.ts: never a value. A step is an object key, an array index, or `*` = the first element of an array, or of
 * the first non-empty array-valued property of an object (for answers whose array key we do not know yet).
 */
export type Step = string | number | '*';
export type ElementShape = { probe: string; label: string; shape: string };

export function valueAt(json: unknown, path: readonly Step[]): unknown {
  let cur: unknown = json;
  for (const step of path) {
    if (step === '*') {
      if (Array.isArray(cur)) { cur = cur[0]; continue; }
      if (isRecord(cur)) { const arr = Object.values(cur).find((v): v is unknown[] => Array.isArray(v) && v.length > 0); cur = arr?.[0]; continue; }
      return undefined;
    }
    if (typeof step === 'number') { cur = Array.isArray(cur) ? cur[step] : undefined; continue; }
    cur = isRecord(cur) && Object.hasOwn(cur, step) ? cur[step] : undefined;
  }
  return cur;
}

export const ELEMENT_CAPTURES: readonly { probe: string; label: string; path: readonly Step[] }[] = [
  { probe: 'web-list-all', label: '[0].rows[0]', path: [0, 'rows', 0] },
  { probe: 'web-article-search', label: 'documents[0]', path: ['documents', 0] },
  { probe: 'mobile-shoppinglists', label: 'shoppingLists[0].rows[0]', path: ['shoppingLists', 0, 'rows', 0] },
  { probe: 'mobile-store-detail', label: 'openingHours.today', path: ['openingHours', 'today'] },
  { probe: 'mobile-store-detail', label: 'openingHours.regularHours[0]', path: ['openingHours', 'regularHours', 0] },
  { probe: 'mobile-store-detail', label: 'openingHours.specialHours[0]', path: ['openingHours', 'specialHours', 0] },
  { probe: 'mobile-store-offers', label: 'offers[0].parsedMechanics', path: ['offers', 0, 'parsedMechanics'] },
  { probe: 'mobile-store-offers', label: 'offers[0].category', path: ['offers', 0, 'category'] },
  { probe: 'mobile-bonus', label: 'vouchers.used[0]', path: ['vouchers', 'used', 0] },
  { probe: 'mobile-bonus', label: 'vouchers.active[0]', path: ['vouchers', 'active', 0] },
  { probe: 'mobile-bonus', label: 'accountBalance.groupedBalances[0]', path: ['accountBalance', 'groupedBalances', 0] },
  { probe: 'purchase-month-summaries', label: 'monthSummaries[0]', path: ['monthSummaries', 0] },
  { probe: 'purchase-latest-month', label: 'first transaction (*)', path: ['*'] },
  { probe: 'purchase-latest-month', label: 'first item of the first transaction (*.*)', path: ['*', '*'] },
];

export function captureElements(probe: string, json: unknown): ElementShape[] {
  return ELEMENT_CAPTURES.filter((c) => c.probe === probe).map((c) => {
    const v = valueAt(json, c.path);
    return { probe, label: c.label, shape: v === undefined ? 'absent' : shapeOf(v) };
  });
}

/** The claim names and types of a JWT access token (never values), or `opaque (<n> chars)`. */
export function appTokenShape(token: string): string {
  const parts = token.split('.');
  if (parts.length === 3 && parts[1]) {
    try {
      const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (isRecord(payload)) return `jwt ${shapeOf(payload)}`;
    } catch { /* not a JWT */ }
  }
  return `opaque (${token.length} chars)`;
}
