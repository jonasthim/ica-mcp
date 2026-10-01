import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { IcaRejected } from '../../ica/errors.js';
import type { MonthSummary, Purchase } from '../../ica/web-api.js';
import { compact, day } from './format.js';
import { ToolInputError, ok, runTool, type ToolDeps } from './runtime.js';

/*
 * Purchase history is personal (stores, amounts, dates). Privacy: the output is built field by field from named,
 * typed fields (never a spread of an ICA object: the schemas are loose, so a spread would pass through card numbers,
 * receipt ids, items or whatever else ICA sends). Nothing here logs; runTool logs only { tool, userId, status, ms }
 * and, on a schema mismatch, issue paths made of our own key names.
 *
 * Availability: ICA answers `/api/cpa/*` only while the web session's loginState is 2 (a recent web BankID login). The
 * keeper checks it live right before the call (`purchases`); below 2 the tool answers "needs a fresh BankID login"
 * (NeedsFreshBankId) and never guesses or makes up purchases.
 */

const ym = (year: number, month: number): string => `${year}-${String(month).padStart(2, '0')}`;
/**
 * One receipt for Claude (shape: from the 2026-09-30 live capture): never `transactionId`, `storeId` or the channel.
 * ICA has no `discount` field: `totalDiscount`, falling back to `discountValue`.
 */
const purchaseView = (p: Purchase) => compact({
  date: day(p.transactionDate), store: p.storeMarketingName, city: p.storeCity, total: p.transactionValue, discount: p.totalDiscount ?? p.discountValue,
});
/** One month for Claude: `YYYY-MM`, what was spent and saved (shape: from the 2026-09-30 live capture). */
const monthView = (m: MonthSummary) => ({ month: ym(m.year, m.month), ...compact({ spent: m.amount, saved: m.amountSaved }) });

export function registerHistoryTools(server: McpServer, deps: ToolDeps): void {
  const stepUp = 'ICA only shows purchase history for a while after a web BankID login (it lapses on its own within hours, and at once when app access is connected with BankID); when the tool says so, relay its reconnect instructions and never guess the purchases.';

  server.registerTool('get_purchase_months', {
    description: `The months (YYYY-MM, newest first) that have ICA purchase history (kvitton) on the signed-in member's account, with the amount spent and saved per month (SEK). ${stepUp}`,
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async (_args, ctx) => runTool(deps, ctx, 'get_purchase_months', async (session) => {
    const months = await session.purchases((api) => api.monthSummaries());
    return ok({ months: months.map(monthView).sort((a, b) => b.month.localeCompare(a.month)) });
  }));

  server.registerTool('get_purchases', {
    description: `The ICA purchases in one month: receipt totals per purchase, not the items bought (date, store, city, total and discount in SEK). Use get_purchase_months for the months that have purchases. ${stepUp}`,
    inputSchema: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month as YYYY-MM') }),
    annotations: { readOnlyHint: true },
  }, async ({ month }, ctx) => runTool(deps, ctx, 'get_purchases', async (session) => {
    try {
      const m = await session.purchases((api) => api.month(month));
      return ok({ month, count: m.transactions.length, purchases: m.transactions.map(purchaseView) });
    } catch (e) {
      // shape: unverified — 2.22 live capture (whether ICA answers 404, or 200 with no transactions, for such a month)
      if (e instanceof IcaRejected && e.status === 404) throw new ToolInputError(`ICA has no purchase record for ${month}. get_purchase_months lists the months that have purchases.`);
      throw e;
    }
  }));
}
