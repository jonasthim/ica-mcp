import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import type { IcaEndpoints } from './endpoints.js';
import { IcaRejected } from './errors.js';
import { bearerFetcher, icaJson, icaRequest, parseIca, type Fetcher } from './gateway.js';

/**
 * Typed client for the ICA app APIs (`sverige/digx/mobile/*`). Pass the **app** bearer: the web bearer gets 403
 * (WSO2 900908) on every one of them. Schemas are lenient (Global Constraints): unknown keys are kept, which is what
 * lets a row be sent back whole.
 *
 * Each method here is a single ICA call. `SessionKeeper.withAppBearer` re-runs a whole `session.app` callback once
 * after a 401/403, so the write tools (Task 2.12) make every callback safe to re-run: new ids are made outside it,
 * and a re-run drops from its diff whatever the first run already achieved.
 */
const M = '/sverige/digx/mobile';
const SL = `${M}/shoppinglistservice/v1/shoppinglists`;

/**
 * A shopping-list row. `2.1` captured the live mobile shape as `{id, productName, sourceId, isStrikedOver, recipes,
 * internalOrder, articleGroupId, articleGroupIdExtended, latestChange, offlineId}`; `articleGroupId`/
 * `articleGroupIdExtended` are declared as `number`, both confirmed on every live row, kept nullish for lenience.
 * `quantity`/`unit` are also declared (Task 2.8's `qtyText` needs them): the captured row simply had no quantity
 * set, not evidence ICA never sends them — the web row (`web-list-all`) does carry `quantity: null`. Undeclared
 * fields (`id`, `internalOrder`, …) still pass through.
 */
export const AppListRowSchema = z.looseObject({
  offlineId: z.string(),
  productName: z.string(),
  isStrikedOver: z.boolean().default(false),
  sourceId: z.number().optional(),
  quantity: z.number().nullish(), // shape: quantity/unit round-trip through ICA, verified live 2026-09-30
  unit: z.string().nullish(), // shape: verified live 2026-09-30 (see quantity)
  articleGroupId: z.number().nullish(), // shape: from 2.1
  articleGroupIdExtended: z.number().nullish(), // shape: from 2.1
  latestChange: z.string().optional(),
});
export const AppShoppingListSchema = z.looseObject({
  id: z.number(), offlineId: z.string(), title: z.string(),
  commentText: z.string().nullish(), sortingStore: z.number().nullish(), latestChange: z.string().optional(),
  rows: z.array(AppListRowSchema).default([]),
});
export const AppShoppingListsSchema = z.looseObject({ shoppingLists: z.array(AppShoppingListSchema) });

export type AppListRow = z.output<typeof AppListRowSchema>;
export type AppShoppingList = z.output<typeof AppShoppingListSchema>;

/** ICA's list sync body: created rows in full, changed rows in full (with a new `latestChange`), deleted row ids. */
export type ListSync = { createdRows?: AppListRow[]; changedRows?: AppListRow[]; deletedRows?: string[] };

/** A new row or list id, shaped like the ICA app's own (an upper-case uuid). */
export const newOfflineId = (): string => randomUUID().toUpperCase();

/**
 * A new free-text row, shaped like the ICA app's own (upper-case uuid offlineId, sourceId -1, no recipes). Callers
 * build it once per tool call, outside any retried callback, so a retry sends the same offlineId.
 */
export function newListRow(o: { text: string; quantity?: number | undefined; unit?: string | undefined; now: Date }): AppListRow {
  return {
    offlineId: newOfflineId(), productName: o.text, isStrikedOver: false, sourceId: -1, latestChange: o.now.toISOString(), recipes: [],
    ...(o.quantity !== undefined ? { quantity: o.quantity } : {}), // shape: quantity/unit round-trip, verified live 2026-09-30
    ...(o.unit ? { unit: o.unit } : {}),
  };
}

const idLike = z.union([z.number(), z.string()]);
const amount = z.union([z.number(), z.string()]).nullish();

export const FavoritesSchema = z.looseObject({ favoriteStores: z.array(z.number()).default([]), visitedStores: z.array(z.number()).default([]) });

/** One day's opening hours (2.1: `regularHours[0]`/`specialHours[0]`). */
const StoreHoursEntrySchema = z.looseObject({ title: z.string().nullish(), hours: z.string().nullish() });

export const StoreSchema = z.looseObject({
  id: z.number(), marketingName: z.string(),
  address: z.looseObject({ street: z.string().nullish(), zip: z.string().nullish(), city: z.string().nullish() }).nullish(),
  phone: z.string().nullish(), webURL: z.string().nullish(),
  openingHours: z.looseObject({
    today: z.string().nullish(), // shape: from 2.1
    regularHours: z.array(StoreHoursEntrySchema).default([]), // shape: from 2.1
    specialHours: z.array(StoreHoursEntrySchema).default([]), // shape: from 2.1
  }).nullish(),
  services: z.array(z.string()).default([]),
});

/** An offer's category (2.1: `offers[0].category`). */
const OfferCategorySchema = z.looseObject({
  articleGroupName: z.string().nullish(), articleGroupId: idLike.nullish(),
  expandedArticleGroupName: z.string().nullish(), expandedArticleGroupId: idLike.nullish(),
}).nullish();

/** How ICA describes an offer's discount mechanic, e.g. "2 for X kr" (2.1: `offers[0].parsedMechanics`). */
const OfferMechanicsSchema = z.looseObject({
  type: z.string().nullish(), quantity: z.number().nullish(), unitSign: z.string().nullish(),
  value1: z.string().nullish(), value2: z.string().nullish(), value3: z.string().nullish(), value4: z.string().nullish(),
}).nullish();

export const OfferSchema = z.looseObject({
  id: idLike.transform(String), name: z.string(),
  brand: z.string().nullish(), packageInformation: z.string().nullish(), condition: z.string().nullish(), restriction: z.string().nullish(),
  category: OfferCategorySchema,
  parsedMechanics: OfferMechanicsSchema,
  requiresLoyaltyCard: z.boolean().nullish(), isPersonal: z.boolean().nullish(), isUsed: z.boolean().nullish(),
  validFrom: z.string().nullish(), validTo: z.string().nullish(), isValidInStore: z.boolean().nullish(), isValidOnline: z.boolean().nullish(),
  referencePriceText: z.string().nullish(), pictureUrl: z.string().nullish(),
});
export const OffersSchema = z.looseObject({ offers: z.array(OfferSchema), discounts: z.array(z.unknown()).default([]) });

/**
 * A redeemed bonus voucher (2.1: `vouchers.used[0]`). `voucherCode` is a redeemable code: the client may parse
 * it, but it must never be returned by a tool (Task 2.10 leaves it out of every tool's output).
 */
const VoucherSchema = z.looseObject({
  title: z.string().nullish(), subTitle: z.string().nullish(), description: z.string().nullish(),
  redeemedDate: z.string().nullish(), voucherCode: z.string().nullish(), voucherType: z.string().nullish(),
  sender: z.string().nullish(), voucherAmount: amount,
});

/** One line of a bonus balance breakdown (2.1: `accountBalance.groupedBalances[0]`). */
const GroupedBalanceSchema = z.looseObject({
  balanceCode: idLike.nullish(), balanceDescription: z.string().nullish(), pointValue: amount, voucherValue: amount,
  detailedBalances: z.array(z.looseObject({
    balanceDescription: z.string().nullish(), pointValue: amount, voucherValue: amount, sender: z.string().nullish(),
  })).default([]),
});

export const BonusSchema = z.looseObject({
  stammisBoostText: z.string().nullish(), stammisBoostBonusLevelText: z.string().nullish(),
  bonusLevels: z.array(z.looseObject({ levelId: idLike.nullish(), pointValueFrom: amount, pointValueTom: amount, voucherValue: amount })).default([]),
  vouchers: z.looseObject({
    active: z.array(z.unknown()).default([]), // shape: unknown (2.1's capture found it empty); kept lenient
    used: z.array(VoucherSchema).default([]), // shape: from 2.1
  }).nullish(),
  accountBalance: z.looseObject({
    title: z.string().nullish(), totalVoucherValue: amount, nextVoucherValue: amount, remainingPointsIncludingBoost: amount,
    remainingDays: amount, voucherMonth: amount, loyaltyMonth: amount, preliminaryBonusText: z.string().nullish(),
    groupedBalances: z.array(GroupedBalanceSchema).default([]), // shape: from 2.1
  }).nullish(),
  discountSummary: z.looseObject({ totalDiscount: amount, numberOfPurchases: amount }).nullish(),
  errorFetchingDiscount: z.boolean().nullish(),
  /** The physical/plastic Stammis card number. Must never be returned by a tool (Task 2.10 leaves it out of every tool's output). */
  cardNumber: z.string().nullish(),
});
export const ProductSchema = z.looseObject({
  gtin: idLike.transform(String), name: z.string(),
  consumerItemId: idLike.nullish(), articleId: idLike.nullish(), articleGroupId: idLike.nullish(), expandedArticleGroupId: idLike.nullish(),
});

export type Favorites = z.output<typeof FavoritesSchema>;
export type Store = z.output<typeof StoreSchema>;
export type Offer = z.output<typeof OfferSchema>;
export type Bonus = z.output<typeof BonusSchema>;
export type Product = z.output<typeof ProductSchema>;

export function createAppApi(o: { endpoints: IcaEndpoints; bearer: string; fetcher?: Fetcher }) {
  const f = o.fetcher ?? bearerFetcher(o.bearer);
  const url = (path: string): string => `${o.endpoints.gateway}${path}`;
  const listUrl = (offlineId: string): string => url(`${SL}/${encodeURIComponent(offlineId)}`);
  return {
    /** GET all shopping lists — one ICA call. */
    async shoppingLists(): Promise<AppShoppingList[]> { return (await icaJson(f, url(SL), AppShoppingListsSchema)).shoppingLists; },
    /** GET one shopping list — one ICA call. */
    shoppingList: (offlineId: string): Promise<AppShoppingList> => icaJson(f, listUrl(offlineId), AppShoppingListSchema),
    /**
     * POST one sync to a list — one ICA call. ICA's sync protocol: created rows in full, changed rows in full (with a
     * new latestChange), deleted row ids. Verified live 2026-09-30 (add, check, uncheck, remove); the answer's body is
     * ignored: callers re-read the list.
     */
    async syncList(offlineId: string, diff: ListSync): Promise<void> { await icaRequest(f, `${listUrl(offlineId)}/sync`, { method: 'POST', body: diff }); },
    /**
     * POST a new, empty list — one ICA call; returns its offlineId. Pass `offlineId` (from `newOfflineId`, made
     * outside any retried callback) so a retry can recognise a list the first attempt created. The request shape is
     * verified live 2026-09-30 (the list appeared in the ICA app); the answer's body is ignored.
     */
    async createList(title: string, now: Date, offlineId: string = newOfflineId()): Promise<string> {
      await icaRequest(f, url(SL), { method: 'POST', body: { offlineId, title, commentText: '', sortingStore: 0, rows: [], latestChange: now.toISOString() } });
      return offlineId;
    },
    /** GET the account's favourite and visited stores — one ICA call. */
    favorites: (): Promise<Favorites> => icaJson(f, url(`${M}/storeservice/v1/favorites`), FavoritesSchema),
    /** GET one store — one ICA call. */
    store: (id: number): Promise<Store> => icaJson(f, url(`${M}/storeservice/v1/stores/${id}`), StoreSchema),
    /** GET the current offers at a store — one ICA call. */
    offers: (storeId: number): Promise<{ offers: Offer[] }> => icaJson(f, url(`${M}/offerservice/v1/offersdiscounts/${storeId}`), OffersSchema),
    /** GET the account's current bonus status — one ICA call. */
    bonus: (): Promise<Bonus> => icaJson(f, url(`${M}/bonusservice/v1/bonus/current`), BonusSchema),
    /** A product by EAN/GTIN, or null when ICA does not know it (404, or an empty answer). One ICA call. */
    async product(ean: string): Promise<Product | null> {
      let r;
      try { r = await icaRequest(f, url(`${M}/productservice/v1/product/${encodeURIComponent(ean)}`)); } catch (e) {
        if (e instanceof IcaRejected && e.status === 404) return null;
        throw e;
      }
      return r.status === 204 || r.json === null ? null : parseIca(ProductSchema, r.json);
    },
  };
}
export type AppApi = ReturnType<typeof createAppApi>;
