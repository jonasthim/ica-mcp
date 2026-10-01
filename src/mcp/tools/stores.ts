import type { McpServer } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import * as z from 'zod/v4';
import { schema } from '../../db/index.js';
import type { Offer, Store } from '../../ica/app-api.js';
import { IcaRejected } from '../../ica/errors.js';
import type { IcaUserSession } from '../../sessions/keeper.js';
import { compact, day, norm } from './format.js';
import { ToolInputError, ok, runTool, type ToolDeps } from './runtime.js';

/*
 * Privacy: every output below is built field by field from named, typed fields. Never spread an ICA object: the
 * schemas are loose, so a spread would pass through whatever ICA adds (bonus `cardNumber`, voucher codes, store
 * phone/e-mail/address, …).
 */

const words = (...parts: (string | null | undefined)[]): string => parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join(' ');

/** Category names an offer query should match. // shape: from 2.1 (offers[0].category) */
const categoryText = (o: Offer): string => words(o.category?.articleGroupName, o.category?.expandedArticleGroupName);

/**
 * The deal text: ICA's `condition` when present, else built from `parsedMechanics`: its values, prefixed by the count
 * for a multibuy (`quantity` ≥ 2, with `unitSign` when present), e.g. "2 st för 89 kr". // shape: from 2.1
 * (parsedMechanics). The exact wording (what `unitSign` and `value1..4` mean per `type`) is provisional: confirm it
 * against live offers at the 2.11 live check.
 */
const dealText = (o: Offer): string | undefined => {
  if (o.condition) return o.condition;
  const m = o.parsedMechanics;
  const values = m ? words(m.value1, m.value2, m.value3, m.value4) : '';
  if (!m || !values) return undefined;
  return typeof m.quantity === 'number' && m.quantity >= 2 ? `${words(String(m.quantity), m.unitSign)} för ${values}` : values;
};

export type OfferView = {
  id: string; name: string; brand?: string; deal?: string; package?: string; compare?: string; limit?: string; validTo?: string;
  personal?: true; stammis?: true; onlineOnly?: true; image?: string;
};
function offerView(o: Offer, images: boolean): OfferView {
  return {
    id: o.id, name: o.name,
    ...compact({
      brand: o.brand ?? undefined, deal: dealText(o), package: o.packageInformation ?? undefined, compare: o.referencePriceText ?? undefined,
      limit: o.restriction ?? undefined, validTo: day(o.validTo),
      personal: o.isPersonal === true ? true as const : undefined,
      stammis: o.requiresLoyaltyCard === true ? true as const : undefined,
      onlineOnly: o.isValidInStore === false ? true as const : undefined,
      image: images ? o.pictureUrl ?? undefined : undefined,
    }),
  };
}

export function registerStoreTools(server: McpServer, deps: ToolDeps): void {
  const householdDefault = (): number | undefined =>
    deps.db.select({ id: schema.household.defaultStoreId }).from(schema.household).where(eq(schema.household.id, 1)).get()?.id ?? undefined;

  /** The favourite stores (at most 10), one ICA call each after the favourites call. */
  async function favouriteStores(session: IcaUserSession): Promise<Store[]> {
    const fav = await session.app((api) => api.favorites());
    return Promise.all(fav.favoriteStores.slice(0, 10).map((id) => session.app((api) => api.store(id))));
  }

  /** One store's name; a store id ICA does not know (404) is the caller's input to fix. */
  async function storeName(session: IcaUserSession, id: number): Promise<{ id: number; name: string }> {
    try {
      return { id, name: (await session.app((api) => api.store(id))).marketingName };
    } catch (e) {
      if (e instanceof IcaRejected && e.status === 404) throw new ToolInputError(`No ICA store with id ${id}. Use get_favorite_stores to see your stores.`);
      throw e;
    }
  }

  /** The store the user means: an id; a unique part of a favourite's name or city; else the household default or the first favourite. */
  async function resolveStore(session: IcaUserSession, ref: string | undefined): Promise<{ id: number; name: string }> {
    const r = ref?.trim();
    if (r && /^\d+$/.test(r)) return storeName(session, Number(r));
    if (!r) {
      const id = householdDefault() ?? (await session.app((api) => api.favorites())).favoriteStores[0];
      if (id === undefined) throw new ToolInputError('This ICA account has no favourite store. Pass a store id, or add a favourite store in the ICA app.');
      return storeName(session, id);
    }
    const stores = await favouriteStores(session);
    const q = norm(r);
    const hits = stores.filter((st) => norm(st.marketingName).includes(q) || norm(st.address?.city ?? '').includes(q));
    const names = (list: Store[]): string => list.map((st) => `${st.marketingName} (id ${st.id})`).join(', ');
    if (hits.length === 1) return { id: hits[0]!.id, name: hits[0]!.marketingName };
    if (hits.length > 1) throw new ToolInputError(`"${r}" fits several favourite stores: ${names(hits)}. Ask the user which one, then pass its id.`);
    throw new ToolInputError(`No favourite store matches "${r}". Favourite stores: ${names(stores) || 'none'}.`);
  }

  server.registerTool('get_favorite_stores', {
    description: "The ICA account's favourite stores: name, city, today's opening hours and store id (for get_store_offers). The default store is marked.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async (_args, ctx) => runTool(deps, ctx, 'get_favorite_stores', async (session) => {
    const stores = await favouriteStores(session);
    const def = householdDefault() ?? stores[0]?.id;
    return ok({ stores: stores.map((st) => ({
      id: st.id, name: st.marketingName,
      ...compact({ city: st.address?.city, openToday: st.openingHours?.today, default: st.id === def ? true as const : undefined }), // shape: from 2.1 (openingHours.today)
    })) });
  }));

  server.registerTool('get_store_offers', {
    description: "This week's offers (erbjudanden) at an ICA store: defaults to the household's store, or else your first favourite. `store` is a store id or part of a favourite store's name or city. `query` filters by words in the name, brand or category (Swedish works best, e.g. \"kyckling\"). Returns at most `limit` offers and the total count.",
    inputSchema: z.object({
      store: z.string().trim().min(1).max(60).optional(),
      query: z.string().trim().min(1).max(60).optional(),
      limit: z.number().int().min(1).max(100).default(25),
      includeImages: z.boolean().default(false),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ store, query, limit, includeImages }, ctx) => runTool(deps, ctx, 'get_store_offers', async (session) => {
    const target = await resolveStore(session, store);
    const { offers } = await session.app((api) => api.offers(target.id));
    const want = query ? norm(query).split(' ') : [];
    const hits = offers.filter((o) => { const hay = norm(words(o.name, o.brand, categoryText(o))); return want.every((w) => hay.includes(w)); });
    return ok({ store: { id: target.id, name: target.name }, total: hits.length, shown: Math.min(limit, hits.length), offers: hits.slice(0, limit).map((o) => offerView(o, includeImages)) });
  }));

  server.registerTool('get_bonus', {
    description: "The ICA Stammis bonus status of the signed-in member's ICA account: level, points left to the next bonus voucher, voucher values, days left in the period, and this year's savings.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async (_args, ctx) => runTool(deps, ctx, 'get_bonus', async (session) => {
    const b = await session.app((api) => api.bonus());
    const ab = b.accountBalance;
    // Never cardNumber, and nothing from vouchers but the active count (a used voucher carries a redeemable voucherCode).
    return ok(compact({
      title: ab?.title, level: b.stammisBoostBonusLevelText, pointsToNextVoucher: ab?.remainingPointsIncludingBoost, nextVoucherValue: ab?.nextVoucherValue,
      voucherValueThisPeriod: ab?.totalVoucherValue, daysLeft: ab?.remainingDays, activeVouchers: b.vouchers?.active.length,
      savedThisYear: b.discountSummary?.totalDiscount, purchasesThisYear: b.discountSummary?.numberOfPurchases,
    }));
  }));

  server.registerTool('lookup_product', {
    description: 'Look up an ICA product by its barcode (EAN/GTIN, 8 or 12–14 digits), e.g. from a photo of a package.',
    inputSchema: z.object({ ean: z.string().trim().regex(/^(\d{8}|\d{12,14})$/, 'an EAN has 8 or 12–14 digits') }),
    annotations: { readOnlyHint: true },
  }, async ({ ean }, ctx) => runTool(deps, ctx, 'lookup_product', async (session) => {
    const p = await session.app((api) => api.product(ean));
    if (!p) return ok({ found: false, ean });
    return ok({ found: true, ean: p.gtin, name: p.name, ...compact({ articleId: p.articleId, articleGroupId: p.articleGroupId }) });
  }));
}
