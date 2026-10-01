import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { HandlaProduct, HandlaStore } from '../../ica/handla-api.js';
import { compact } from './format.js';
import { ok, runTool, type ToolDeps } from './runtime.js';

/** The MCP request's abort signal (the client cancelled or went away): a Handla call still queued is then dropped. */
const signalOf = (ctx: unknown): AbortSignal | undefined => (ctx as { mcpReq?: { signal?: AbortSignal } } | undefined)?.mcpReq?.signal;

/*
 * Handla's store search and product search are anonymous: no ICA account, no cart, no login (that stays Phase 4).
 * A call still spends one of the caller's ICA budget tokens (session.handla), so Claude cannot hammer Handla. Handla
 * sits behind AWS WAF with a per-IP rate rule; the keeper's Handla guard paces, caches and stops after a WAF block.
 *
 * Privacy: every output below is built field by field from named, typed fields. Never spread an ICA object: the
 * schemas are loose, so a spread would pass through whatever Handla adds (a store's street/phone/e-mail, a product's
 * image, …).
 */

const money = (m: { amount: string | number; currency?: string | null } | null | undefined): string | undefined =>
  m ? `${typeof m.amount === 'number' ? m.amount.toFixed(2) : m.amount}${m.currency ? ` ${m.currency}` : ''}` : undefined;
/** The comparison price when it has the usual Ocado shape `{ price: { amount, currency }, unit }`; else left out. // shape: unverified — 2.22 live check */
function unitPriceText(u: unknown): string | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const o = u as { price?: { amount?: unknown; currency?: unknown }; unit?: unknown };
  const amount = o.price?.amount;
  if (typeof amount !== 'string' && typeof amount !== 'number') return undefined;
  const p = money({ amount, currency: typeof o.price?.currency === 'string' ? o.price.currency : null });
  return typeof o.unit === 'string' && o.unit ? `${p} per ${o.unit}` : p;
}
const productView = (p: HandlaProduct) => compact({
  id: p.productId, name: p.name, brand: p.brand, size: p.packSizeDescription, price: money(p.price), unitPrice: unitPriceText(p.unitPrice),
  available: typeof p.available === 'boolean' ? p.available : undefined,
});

/**
 * A Handla store id as handla_find_stores returns it: letters, digits, `_` and `-` only. It becomes a URL path segment
 * (`/stores/<id>/...`), so anything else is refused before Handla is asked. This also rejects `.` and `..`, which
 * pass encodeURIComponent unchanged and would resolve to another path.
 */
const HANDLA_STORE_ID = z.string().trim().regex(/^[\w-]{1,40}$/, 'a store id from handla_find_stores (letters, digits, _ and -)');

export function registerHandlaTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool('handla_find_stores', {
    description: 'Find ICA stores that sell online through Handla (handla.ica.se) for a Swedish postcode, with whether they deliver home and/or offer pickup. Needs no ICA account. The store id is what handla_search_products takes.',
    inputSchema: z.object({ zip: z.string().trim().regex(/^\d{3} ?\d{2}$/, 'a Swedish postcode, e.g. 123 45') }),
    annotations: { readOnlyHint: true },
  }, async ({ zip }, ctx) => runTool(deps, ctx, 'handla_find_stores', async (session) => {
    const z5 = zip.replace(' ', '');
    const r = await session.handla((api) => api.stores(z5, { signal: signalOf(ctx) }));
    const byId = new Map<string, { store: HandlaStore; delivery: boolean; pickup: boolean }>();
    for (const st of r.forHomeDelivery) byId.set(st.accountId, { store: st, delivery: true, pickup: false });
    for (const st of r.forPickupDelivery) { const e = byId.get(st.accountId); if (e) e.pickup = true; else byId.set(st.accountId, { store: st, delivery: false, pickup: true }); }
    return ok({ zip: z5, stores: [...byId.values()].slice(0, 15).map((e) => compact({ id: e.store.accountId, name: e.store.name, city: e.store.city, delivery: e.delivery, pickup: e.pickup })) });
  }));

  server.registerTool('handla_search_products', {
    description: "Search one Handla store's products with their online prices (handla.ica.se; prices may differ from the shop shelf). `store` is an id from handla_find_stores. Needs no ICA account. For this week's in-store offers use get_store_offers. This does not touch any cart.",
    inputSchema: z.object({ store: HANDLA_STORE_ID, query: z.string().trim().min(1).max(60), limit: z.number().int().min(1).max(25).default(10) }),
    annotations: { readOnlyHint: true },
  }, async ({ store, query, limit }, ctx) => runTool(deps, ctx, 'handla_search_products', async (session) => {
    const products = await session.handla((api) => api.search(store, query, limit, { signal: signalOf(ctx) }));
    return ok({ store, query, products: products.slice(0, limit).map(productView) });
  }));
}
