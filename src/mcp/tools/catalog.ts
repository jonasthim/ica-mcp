import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ok, runTool, type ToolDeps } from './runtime.js';

/*
 * Privacy: the output is built field by field from named, typed fields (never a spread of an ICA object — the
 * schema is loose, so a spread would pass through whatever unrelated fields ICA adds to a search hit).
 */

export function registerCatalogTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool('search_articles', {
    description: "Search ICA's article names (the catalogue the ICA app suggests when you add to a list), e.g. to find the exact product name for \"laktosfri mjölk\". Swedish queries work best. For prices use handla_search_products; for offers use get_store_offers.",
    inputSchema: z.object({ query: z.string().trim().min(1).max(60), limit: z.number().int().min(1).max(25).default(10) }),
    annotations: { readOnlyHint: true },
  }, async ({ query, limit }, ctx) => runTool(deps, ctx, 'search_articles', async (session) => {
    const r = await session.web((api) => api.searchArticles(query));
    return ok({
      query,
      total: r.stats?.totalHits ?? r.documents.length,
      articles: r.documents.slice(0, limit).map((d) => ({ id: d.id, name: d.name, ...(d.articleGroupName ? { category: d.articleGroupName } : {}) })),
    });
  }));
}
