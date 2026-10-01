import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ok, runTool, type ToolDeps } from './runtime.js';

/*
 * Handla's store search and product search are anonymous: no ICA account, no cart, no login (that stays Phase 4).
 * A call still spends one of the caller's ICA budget tokens (session.handla), so Claude cannot hammer Handla. Handla
 * sits behind AWS WAF with a per-IP rate rule; the keeper's Handla guard paces, caches and stops after a WAF block.
 *
 * Privacy: the outputs are the projected views handla-api.ts builds field by field from named, typed fields (and that
 * is all its cache keeps); `asOf` says when Handla was asked, so Claude can tell how old a cached price is.
 */

/** The MCP request's abort signal (the client cancelled or went away): a Handla call still queued is then dropped. */
const signalOf = (ctx: { mcpReq?: { signal?: AbortSignal } }): AbortSignal | undefined => ctx.mcpReq?.signal;

/**
 * A Handla store id as handla_find_stores returns it: letters, digits, `_` and `-` only. It becomes a URL path segment
 * (`/stores/<id>/...`), so anything else is refused before Handla is asked. This also rejects `.` and `..`, which
 * pass encodeURIComponent unchanged and would resolve to another path.
 */
const HANDLA_STORE_ID = z.string().trim().regex(/^[\w-]{1,40}$/, 'a store id from handla_find_stores (letters, digits, _ and -)');

export function registerHandlaTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool('handla_find_stores', {
    description: 'Find ICA stores that sell online through Handla (handla.ica.se) for a Swedish postcode, with whether they deliver home and/or offer pickup. Needs no ICA account. The store id is what handla_search_products takes. `asOf` is when Handla was asked (answers are cached).',
    inputSchema: z.object({ zip: z.string().trim().regex(/^\d{3} ?\d{2}$/, 'a Swedish postcode, e.g. 123 45') }),
    annotations: { readOnlyHint: true },
  }, async ({ zip }, ctx) => runTool(deps, ctx, 'handla_find_stores', async (session) => {
    const z5 = zip.replace(' ', '');
    const r = await session.handla((api) => api.stores(z5, { signal: signalOf(ctx) }));
    return ok({ zip: z5, asOf: r.asOf, stores: r.stores });
  }));

  server.registerTool('handla_search_products', {
    description: "Search one Handla store's products with their online prices (handla.ica.se; prices may differ from the shop shelf). `store` is an id from handla_find_stores. Needs no ICA account. For this week's in-store offers use get_store_offers. This does not touch any cart. Lookups are paced (a few per minute) and cached for a while; `asOf` is when Handla was asked, so say how old a price is when it matters.",
    inputSchema: z.object({ store: HANDLA_STORE_ID, query: z.string().trim().min(1).max(60), limit: z.number().int().min(1).max(25).default(10) }),
    annotations: { readOnlyHint: true },
  }, async ({ store, query, limit }, ctx) => runTool(deps, ctx, 'handla_search_products', async (session) => {
    const r = await session.handla((api) => api.search(store, query, limit, { signal: signalOf(ctx) }));
    return ok({ store, query, asOf: r.asOf, products: r.products.slice(0, limit) });
  }));
}
