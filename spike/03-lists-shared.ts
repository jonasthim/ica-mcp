import { now, redact, save } from './lib/http.js';
import { listClientFor, type ListRow } from './lib/lists.js';

const A = await listClientFor('A'); const B = await listClientFor('B');
console.log(`A via ${A.kind}, B via ${B.kind}`);
const la = await A.lists(); const lb = await B.lists();
save('lists-A-redacted', redact(la.map((l) => l.raw))); save('lists-B-redacted', redact(lb.map((l) => l.raw)));
const shared = la.filter((l) => lb.some((m) => m.id === l.id));
console.log(`A sees ${la.length} lists, B sees ${lb.length}, shared by id: ${shared.length}`);
const target = shared[0];
if (!target) throw new Error('no shared list — is the household (stammiskonto) shared?');
console.log(`using shared list "${target.name}" householdId=${JSON.stringify(target.raw.householdId)}`);
const text = `ica-hub spike ${now()}`;
const add = await A.addRow(target.id, text); console.log(`A add → HTTP ${add.status}`); save('list-add-response-redacted', redact(add.body));
// From here on, the spike row (identified by add.rowId, or by its exact text if that came back null)
// exists in the real household list. Everything below is wrapped so a failure at any step still
// triggers a cleanup pass instead of leaving the spike row behind.
const spikeRowId = add.rowId;
try {
  const seenByB = (await B.rows(target.id)).find((r) => r.text === text);
  console.log(`B sees A's row: ${Boolean(seenByB)}`);
  if (!seenByB) throw new Error('B cannot see the row A added');
  const strike = await B.strikeRow(target.id, seenByB, true); console.log(`B strike → HTTP ${strike.status}`);
  const seenByA = (await A.rows(target.id)).find((r) => r.id === seenByB.id);
  console.log(`A sees strike: ${seenByA?.striked}`);
  const del = await A.deleteRow(target.id, seenByA ?? seenByB); console.log(`A delete → HTTP ${del.status}`);
  const gone = !(await B.rows(target.id)).some((r) => r.id === seenByB.id);
  console.log(`row gone for B: ${gone}`);
  save('list-rows-redacted', redact((await A.rows(target.id)).map((r) => r.raw)));
} finally {
  try {
    const rows = await A.rows(target.id).catch(() => [] as ListRow[]);
    const leftover = rows.find((r) => r.id === spikeRowId) ?? rows.find((r) => r.text === text);
    if (leftover) {
      await A.deleteRow(target.id, leftover);
      console.log('cleanup: deleted');
    } else {
      console.log('cleanup: nothing to delete');
    }
  } catch (e) {
    console.log(`cleanup failed: ${String(e)}`);
  }
}
