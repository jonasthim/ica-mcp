import type { McpServer } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import * as z from 'zod/v4';
import { schema } from '../../db/index.js';
import { isSelfChangedEmail } from '../../users/email.js';
import { IcaUnavailable } from '../../ica/errors.js';
import { newListRow, newOfflineId, type AppListRow, type AppShoppingList, type ListSync } from '../../ica/app-api.js';
import type { IcaUserSession } from '../../sessions/keeper.js';
import { listView, norm, resolveList } from './format.js';
import { matchRows, type MatchOutcome } from './match.js';
import { ok, runTool, ToolInputError, WriteOutcomeUnknown, type ToolDeps } from './runtime.js';

export const listRef = z.string().trim().min(1).max(100).optional()
  .describe('List id or title (any case; a unique part of the title works). Default: the first list.');

const HINT = 'Some texts match several items: nothing was changed for them. Ask the user which one they mean, then call again with the item id.';
const NOT_SEEN = 'ICA accepted the change, but the re-read list does not show it yet for these items. Call get_shopping_list in a moment to check.';
const brief = (r: AppListRow) => ({ id: r.offlineId, text: r.productName });

/** A ListSync without empty parts, or undefined when there is nothing to send. */
function syncOf(d: { createdRows: AppListRow[]; changedRows: AppListRow[]; deletedRows: string[] }): ListSync | undefined {
  const out: ListSync = {
    ...(d.createdRows.length ? { createdRows: d.createdRows } : {}),
    ...(d.changedRows.length ? { changedRows: d.changedRows } : {}),
    ...(d.deletedRows.length ? { deletedRows: d.deletedRows } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/**
 * One list write, safe to re-run. `SessionKeeper.withAppBearer` runs a `session.app` callback again after a 401/403
 * (having refreshed), even when the first run's sync already took effect and only its answer was lost. So:
 *
 * - the callback reads the lists, and the **first** read decides the plan (which list, which rows): a re-run reuses
 *   it, so the report stays what the user asked for and got, and a re-run never re-matches against a list its own
 *   first run already changed;
 * - `pending` turns the plan into what is still missing on the list just read (callers drop created rows whose
 *   offlineId is already there, rows already in the target state, removals of rows already gone), and the sync is
 *   sent only if something is missing; every id and timestamp in it was made by the caller, once per tool call;
 * - the re-read is its own `session.app` call, so a 401 there repeats only the GET.
 *
 * Budget: a write spends 2 limiter tokens (one per `session.app` call) but makes 3 ICA calls when it syncs (read,
 * sync, re-read); one token per callback run is the runtime's rule, and the limiter is a guard, not an exact count.
 *
 * Once the sync may have been sent, every failure but a `ToolInputError` is rethrown as `WriteOutcomeUnknown` (see
 * `maybeApplied`), so the tool tells Claude to check the list before trying again.
 */
async function writeList<P>(
  session: IcaUserSession, ref: string | undefined, writes: boolean,
  plan: (target: AppShoppingList) => P, pending: (plan: P, current: AppShoppingList) => ListSync | undefined,
): Promise<{ plan: P; list: AppShoppingList }> {
  let planned: { listId: string; plan: P } | undefined;
  let sent = false;
  const sending: Sending = { started: false, sendError: undefined };
  return maybeApplied(sending, async () => {
    const read = await session.app(async (api) => {
      sent = false;
      const lists = await api.shoppingLists();
      const target = planned ? lists.find((l) => l.offlineId === planned!.listId) : resolveList(lists, ref, writes);
      if (!target) throw new ToolInputError('The shopping list disappeared while it was being changed. Call list_shopping_lists to see the lists now.');
      planned ??= { listId: target.offlineId, plan: plan(target) };
      const diff = pending(planned.plan, target);
      if (diff) { await send(sending, () => api.syncList(target.offlineId, diff)); sent = true; }
      return target;
    });
    const list = sent ? await session.app((api) => api.shoppingList(read.offlineId)) : read;
    return { plan: planned!.plan, list };
  });
}

/** Whether a write's sync/create has been sent, and the error that call itself last answered with. */
type Sending = { started: boolean; sendError: unknown };

/** Send the sync or create, recording that it went out and how that very call failed. */
async function send(sending: Sending, fn: () => Promise<unknown>): Promise<void> {
  sending.started = true;
  try { await fn(); sending.sendError = undefined; } catch (e) { sending.sendError = e; throw e; }
}

/**
 * Run a write. Once its sync or create has been sent, any failure but a ToolInputError becomes WriteOutcomeUnknown:
 * an ICA outage, a refused or ended app session, the ICA budget on the re-read. The one exception is a 451 or 429
 * answering the sync/create call itself, which ICA gives without processing the request.
 */
async function maybeApplied<T>(sending: Sending, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (!sending.started || e instanceof ToolInputError) throw e;
    const refusedUnprocessed = e === sending.sendError && e instanceof IcaUnavailable && (e.reason === 'geo-blocked' || e.reason === 'rate-limited');
    throw refusedUnprocessed ? e : new WriteOutcomeUnknown(e);
  }
}

const NOT_ENABLED = 'List editing is not enabled for your account yet.';
/**
 * ICA_HUB_LIST_WRITES at call time, before any ICA call. The verified userId must have a user row. With 'all' that is
 * enough; with a list, the user's **current** email (read from the database, never from tool input) must be on it,
 * case-insensitively, and must not be one the member set themselves that no admin has confirmed yet: otherwise a
 * member could claim an allow-listed address nobody holds (the same rule as OIDC link-by-email, oidc-policy.ts).
 */
export function assertCanWrite(deps: Pick<ToolDeps, 'config' | 'db'>, userId: string): void {
  const allowed = deps.config.listWrites;
  const u = deps.db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, userId)).get();
  if (!u || allowed === 'off') throw new ToolInputError(NOT_ENABLED);
  if (allowed === 'all') return;
  if (!allowed.includes(u.email.trim().toLowerCase())) throw new ToolInputError(NOT_ENABLED);
  if (isSelfChangedEmail(deps.db, userId)) throw new ToolInputError(`${NOT_ENABLED} An admin must confirm your email first.`);
}

const byId = (l: AppShoppingList, id: string): AppListRow | undefined => l.rows.find((r) => r.offlineId === id);

/** Split planned rows by whether the final list shows the intended result; never claim a change the re-read does not show. */
function verified(rows: readonly AppListRow[], shows: (r: AppListRow) => boolean): { done: AppListRow[]; notSeen: AppListRow[] } {
  return { done: rows.filter(shows), notSeen: rows.filter((r) => !shows(r)) };
}

const matchReport = (m: MatchOutcome) => ({
  ...(m.unchanged.length ? { unchanged: m.unchanged } : {}),
  ...(m.ambiguous.length ? { ambiguous: m.ambiguous, hint: HINT } : {}),
  ...(m.notFound.length ? { notFound: m.notFound } : {}),
});
const notSeenReport = (rows: readonly AppListRow[]) => (rows.length ? { notSeen: rows.map(brief), notSeenHint: NOT_SEEN } : {});

export function registerListTools(server: McpServer, deps: ToolDeps): void {
  /** Whether the write tools exist (ICA_HUB_LIST_WRITES is not 'off'): texts mention them only then. */
  const writes = deps.config.listWrites !== 'off';
  server.registerTool('list_shopping_lists', {
    description: "List the household's ICA shopping lists (shared between household members in the ICA app), with how many items are open and checked off.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async (_args, ctx) => runTool(deps, ctx, 'list_shopping_lists', async (session) => {
    const lists = await session.app((api) => api.shoppingLists());
    return ok({ lists: lists.map((l) => { const v = listView(l); return { id: v.id, title: v.title, open: v.open, checked: v.checked }; }) });
  }));

  server.registerTool('get_shopping_list', {
    description: writes
      ? 'Show one ICA shopping list with its items, open items first, then checked-off ones. Items carry ids for check_list_items, uncheck_list_items and remove_list_items.'
      : 'Show one ICA shopping list with its items, open items first, then checked-off ones, each with its id.',
    inputSchema: z.object({ list: listRef }),
    annotations: { readOnlyHint: true },
  }, async ({ list }, ctx) => runTool(deps, ctx, 'get_shopping_list', async (session) => {
    const lists = await session.app((api) => api.shoppingLists());
    return ok(listView(resolveList(lists, list, writes)));
  }));

  // The write tools exist only when ICA_HUB_LIST_WRITES is not 'off': with it off, Claude never sees them.
  if (writes) registerListWriteTools(server, deps);
}

function registerListWriteTools(server: McpServer, deps: ToolDeps): void {
  const itemsArg = z.array(z.string().trim().min(1).max(100)).min(1).max(30)
    .describe('Item ids from get_shopping_list, or item texts as the user said them (any case).');

  server.registerTool('add_list_items', {
    description: 'Add items to an ICA shopping list (default: the first list). Write items as the user said them, Swedish or English (e.g. "mjölk", or "ägg" with quantity 6 and unit "st"); do not turn them into specific products unless the user asked for one. Items already open on the list are not added twice; checked-off ones are re-opened. Returns the updated list.',
    inputSchema: z.object({
      list: listRef,
      items: z.array(z.object({
        text: z.string().trim().min(1).max(100),
        quantity: z.number().positive().max(999).optional(),
        unit: z.string().trim().min(1).max(20).optional().describe('e.g. st, kg, g, l, förp'),
      })).min(1).max(30),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ list, items }, ctx) => runTool(deps, ctx, 'add_list_items', async (session, userId) => {
    assertCanWrite(deps, userId);
    // Made once per tool call, outside the retried callback: a re-run sends the same row ids and timestamps.
    const now = new Date();
    const stamp = now.toISOString();
    const fresh = items.map((it) => ({ ...it, row: newListRow({ text: it.text, quantity: it.quantity, unit: it.unit, now }) }));
    type Plan = {
      create: AppListRow[]; reopen: { row: AppListRow; quantity?: number | undefined; unit?: string | undefined }[]; alreadyOnList: string[];
      /** A quantity/unit the user gave for an item already open: not applied, reported so Claude can tell the user. */
      quantityNotChanged: { text: string; qty: string }[];
    };
    const { plan, list: after } = await writeList<Plan>(session, list, true, (target) => {
      const p: Plan = { create: [], reopen: [], alreadyOnList: [], quantityNotChanged: [] };
      const seen = new Set<string>();
      for (const it of fresh) {
        const q = norm(it.text);
        if (seen.has(q)) continue;
        seen.add(q);
        const same = target.rows.filter((r) => norm(r.productName) === q);
        const openRow = same.find((r) => !r.isStrikedOver);
        if (openRow) {
          p.alreadyOnList.push(openRow.productName);
          const asked = [it.quantity, it.unit].filter((x) => x !== undefined).join(' ');
          if (asked) p.quantityNotChanged.push({ text: openRow.productName, qty: asked });
        }
        else if (same[0]) p.reopen.push({ row: same[0], quantity: it.quantity, unit: it.unit });
        else p.create.push(it.row);
      }
      return p;
    }, (p, cur) => syncOf({
      createdRows: p.create.filter((r) => !byId(cur, r.offlineId)),
      changedRows: p.reopen.flatMap(({ row, quantity, unit }) => {
        const r = byId(cur, row.offlineId);
        if (!r || !r.isStrikedOver) return [];
        return [{
          ...r, isStrikedOver: false, latestChange: stamp,
          ...(quantity !== undefined ? { quantity } : {}), // shape: quantity/unit round-trip, verified live 2026-09-30
          ...(unit ? { unit } : {}),
        }];
      }),
      deletedRows: [],
    }));
    const added = verified(plan.create, (r) => byId(after, r.offlineId) !== undefined);
    const reopened = verified(plan.reopen.map((x) => x.row), (r) => byId(after, r.offlineId)?.isStrikedOver === false);
    return ok({
      added: added.done.map((r) => r.productName), reopened: reopened.done.map((r) => r.productName), alreadyOnList: plan.alreadyOnList,
      ...(plan.quantityNotChanged.length ? { quantityNotChanged: plan.quantityNotChanged } : {}),
      ...notSeenReport([...added.notSeen, ...reopened.notSeen]),
      list: listView(after),
    });
  }));

  const setChecked = (tool: 'check_list_items' | 'uncheck_list_items', checked: boolean, description: string) =>
    server.registerTool(tool, {
      description, inputSchema: z.object({ list: listRef, items: itemsArg }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    }, async ({ list, items }, ctx) => runTool(deps, ctx, tool, async (session, userId) => {
      assertCanWrite(deps, userId);
      const stamp = new Date().toISOString(); // once per tool call: a re-run sends the same change
      const { plan: m, list: after } = await writeList<MatchOutcome>(session, list, true,
        (target) => matchRows(target.rows, items, (r) => r.isStrikedOver !== checked),
        (m, cur) => syncOf({
          createdRows: [], deletedRows: [],
          changedRows: m.matched.flatMap((planned) => {
            const r = byId(cur, planned.offlineId);
            return r && r.isStrikedOver !== checked ? [{ ...r, isStrikedOver: checked, latestChange: stamp }] : [];
          }),
        }));
      const v = verified(m.matched, (r) => byId(after, r.offlineId)?.isStrikedOver === checked);
      return ok({ [checked ? 'checked' : 'unchecked']: v.done.map(brief), ...matchReport(m), ...notSeenReport(v.notSeen), list: listView(after) });
    }));
  setChecked('check_list_items', true, 'Check off (strike over) items on an ICA shopping list (default: the first list). If a text matches several items, nothing is changed for it and the candidates are returned: ask the user which one. Returns the updated list.');
  setChecked('uncheck_list_items', false, 'Un-check items on an ICA shopping list, making them open again (default: the first list). Matching works as for check_list_items. Returns the updated list.');

  server.registerTool('remove_list_items', {
    description: 'Delete items from an ICA shopping list (default: the first list). Destructive: confirm with the user before calling, unless they explicitly asked to remove exactly these items. Items are matched by id or by their exact text (any case), never by a part of the text; a text that fits several rows removes nothing and returns the candidates. Returns the updated list.',
    inputSchema: z.object({ list: listRef, items: itemsArg }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async ({ list, items }, ctx) => runTool(deps, ctx, 'remove_list_items', async (session, userId) => {
    assertCanWrite(deps, userId);
    const { plan: m, list: after } = await writeList<MatchOutcome>(session, list, true,
      (target) => matchRows(target.rows, items, () => true, { substring: false }), // deleting: exact text or id only
      (m, cur) => syncOf({ createdRows: [], changedRows: [], deletedRows: m.matched.map((r) => r.offlineId).filter((id) => byId(cur, id)) }));
    const v = verified(m.matched, (r) => byId(after, r.offlineId) === undefined);
    return ok({ removed: v.done.map(brief), ...matchReport(m), ...notSeenReport(v.notSeen), list: listView(after) });
  }));

  server.registerTool('create_shopping_list', {
    description: 'Create a new ICA shopping list, shared with the household. If a list with the same title exists, that list is returned instead.',
    inputSchema: z.object({ title: z.string().trim().min(1).max(60) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ title }, ctx) => runTool(deps, ctx, 'create_shopping_list', async (session, userId) => {
    assertCanWrite(deps, userId);
    // Made once per tool call, outside the retried callback: a re-run recognises the list its first run created.
    const offlineId = newOfflineId();
    const now = new Date();
    const sending: Sending = { started: false, sendError: undefined };
    return maybeApplied(sending, async () => {
      const first = await session.app(async (api) => {
        const lists = await api.shoppingLists();
        if (lists.some((l) => l.offlineId === offlineId)) return { created: true } as const;
        const existing = lists.find((l) => norm(l.title) === norm(title));
        if (existing) return { created: false, list: existing } as const;
        await send(sending, () => api.createList(title, now, offlineId));
        return { created: true } as const;
      });
      if (!first.created) return ok({ created: false, list: listView(first.list) });
      const made = (await session.app((api) => api.shoppingLists())).find((l) => l.offlineId === offlineId);
      if (!made) throw new ToolInputError('ICA accepted the new list but does not show it yet. Call list_shopping_lists in a moment.');
      return ok({ created: true, list: listView(made) });
    });
  }));
}
