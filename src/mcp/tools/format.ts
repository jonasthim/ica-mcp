import type { AppListRow, AppShoppingList } from '../../ica/app-api.js';
import { icaDay } from '../../ica/dates.js';
import { ToolInputError } from './runtime.js';

/** Matching form of Swedish text: NFC (iOS may send å as a + ring), Swedish lower case, single spaces. */
export const norm = (s: string): string => s.normalize('NFC').toLocaleLowerCase('sv-SE').replace(/\s+/g, ' ').trim();

/** Drop null and undefined fields so tool outputs stay compact for the model. */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}

/**
 * `YYYY-MM-DD` from an ICA timestamp, else undefined: the Europe/Stockholm date for a time with `Z` or an offset and
 * for an epoch, the written date for a zoneless local time.
 */
export const day = (v: string | number | null | undefined): string | undefined => icaDay(v);

/**
 * "6 st" from a row's quantity and unit; only a numeric quantity renders. // shape: quantity/unit round-trip through
 * ICA, verified live 2026-09-30
 */
export const qtyText = (r: AppListRow): string | undefined => (typeof r.quantity === 'number' ? `${r.quantity}${r.unit ? ` ${r.unit}` : ''}` : undefined);

export type ItemView = { id: string; text: string; qty?: string; checked: boolean };
/** Only what Claude needs: the row's offlineId (for the edit tools), its text, quantity and state. */
export const itemView = (r: AppListRow): ItemView => {
  const qty = qtyText(r);
  return { id: r.offlineId, text: r.productName, ...(qty ? { qty } : {}), checked: r.isStrikedOver };
};

export type ListView = { id: string; title: string; open: number; checked: number; items: ItemView[] };
/** A list for Claude: open items first (in ICA's order), then checked ones; ids for the edit tools. */
export function listView(l: AppShoppingList): ListView {
  const open = l.rows.filter((r) => !r.isStrikedOver);
  const done = l.rows.filter((r) => r.isStrikedOver);
  return { id: l.offlineId, title: l.title, open: open.length, checked: done.length, items: [...open, ...done].map(itemView) };
}

const named = (ls: readonly AppShoppingList[]): string => ls.map((l) => `"${l.title}" (id ${l.offlineId})`).join(', ');

/**
 * The list the user means: none given → the first list; else an exact offlineId or numeric id, else the one list whose
 * title equals the reference (case/Unicode-insensitive), else the one whose title contains it. Never guesses.
 * `writes` says whether the write tools exist, so the empty-account text only names create_shopping_list then.
 */
export function resolveList(lists: readonly AppShoppingList[], ref: string | undefined, writes: boolean): AppShoppingList {
  const first = lists[0];
  // `writes`: whether create_shopping_list exists (ICA_HUB_LIST_WRITES is not off); never name a tool Claude cannot see.
  if (!first) throw new ToolInputError(`There are no shopping lists on this ICA account yet. Create one ${writes ? 'with create_shopping_list, or ' : ''}in the ICA app.`);
  if (ref === undefined || ref.trim() === '') return first;
  const r = ref.trim();
  const byId = lists.find((l) => l.offlineId === r || String(l.id) === r);
  if (byId) return byId;
  const q = norm(r);
  const exact = lists.filter((l) => norm(l.title) === q);
  if (exact.length === 1) return exact[0]!;
  const partial = exact.length > 1 ? exact : lists.filter((l) => norm(l.title).includes(q));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) throw new ToolInputError(`"${r}" matches several lists: ${named(partial)}. Ask the user which one, then pass its id.`);
  throw new ToolInputError(`No shopping list called "${r}". The lists are: ${named(lists)}.`);
}
