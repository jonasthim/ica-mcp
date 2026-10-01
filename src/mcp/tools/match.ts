import type { AppListRow } from '../../ica/app-api.js';
import { norm } from './format.js';

export type Candidate = { id: string; text: string; checked: boolean };
export type MatchOutcome = { matched: AppListRow[]; ambiguous: { query: string; candidates: Candidate[] }[]; notFound: string[]; unchanged: { query: string; id: string; text: string }[] };
const candidate = (r: AppListRow): Candidate => ({ id: r.offlineId, text: r.productName, checked: r.isStrikedOver });

/**
 * Match what the user said to list rows without guessing. A query is a row id, else a text: the rows whose text equals
 * it (case/Unicode-insensitive) if there are any, else (with `substring`, the default) the rows containing it.
 * `eligible` says which rows the tool would change (e.g. open rows, for checking off).
 *
 * - One row → matched if eligible, else unchanged (already in the wanted state).
 * - Several rows → the one eligible row among identical texts is matched; if none is eligible every one is unchanged;
 *   otherwise the query is ambiguous and all of them are returned as candidates (the tool asks the user).
 * - An exact text never falls through to longer texts: "mjölk" on a checked "Mjölk" is unchanged, never "Havremjölk".
 * - Every query is resolved against **all** rows, never against what earlier queries left over: a query resolved by
 *   elimination would be a guess ("Mjölk 3%" then "mjölk" must not mean Havremjölk), and the outcome must not depend on
 *   the order of the queries. A query whose eligible rows were all matched by earlier queries names the same rows
 *   again (nothing more to do, not ambiguous); a row is matched at most once. A repeated id (exactly) or text (by its
 *   matching form) is handled once.
 */
export function matchRows(
  rows: readonly AppListRow[], queries: readonly string[], eligible: (r: AppListRow) => boolean, o: { substring?: boolean } = {},
): MatchOutcome {
  const substring = o.substring ?? true;
  const out: MatchOutcome = { matched: [], ambiguous: [], notFound: [], unchanged: [] };
  const used = new Set<string>();
  const seen = new Set<string>();
  for (const query of queries) {
    const q = norm(query);
    const byId = rows.find((r) => r.offlineId === query.trim());
    // An id is deduplicated exactly (ids are case-sensitive), a text by its matching form.
    const key = byId ? `id:${byId.offlineId}` : `text:${q}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const exact = byId ? [byId] : rows.filter((r) => norm(r.productName) === q);
    const hits = exact.length > 0 || !substring ? exact : rows.filter((r) => norm(r.productName).includes(q));
    const want = hits.filter(eligible);
    const identical = exact.length > 0;
    if (hits.length === 0) out.notFound.push(query);
    else if (want.length === 0) for (const r of hits) out.unchanged.push({ query, id: r.offlineId, text: r.productName });
    else if (want.every((r) => used.has(r.offlineId))) continue; // the same rows earlier queries matched: nothing more to do
    else if (want.length === 1 && (hits.length === 1 || identical)) {
      out.matched.push(want[0]!); used.add(want[0]!.offlineId);
    } else out.ambiguous.push({ query, candidates: (identical ? want : hits).map(candidate) });
  }
  return out;
}
