import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import { changeUserEmail } from '../../users/email.js';
import { assertCanWrite } from './lists.js';
import { MAYBE_APPLIED, ToolInputError, type ToolDeps } from './runtime.js';
import { FAKE_SECRETS, fakeHouseholdLists, type FakeAppList } from '../../ica/test-fakes.js';
import { startToolTest, type ToolTest } from '../../test-helpers.js';

let s: ToolTest;
// A roomy ICA budget: this file makes many calls as alice, and the budget has its own tests.
beforeAll(async () => { s = await startToolTest({ icaRateLimit: { capacity: 1000, refillPerSecond: 100 }, env: { ICA_HUB_LIST_WRITES: 'all' } }); });
afterAll(async () => { await s.close(); });
beforeEach(() => {
  s.fake.opts.appLists = fakeHouseholdLists(); s.fake.opts.gatewayFailures = []; s.fake.opts.appSyncIgnored = false;
  s.fake.seen.syncBodies.length = 0; s.fake.seen.createBodies.length = 0;
});
type Out = { list: { id: string; title: string; items: { id: string; text: string; qty?: string; checked: boolean }[] } } & Record<string, unknown>;
const call = async (name: string, args: Record<string, unknown>) => { const r = await s.alice.client.call(name, args); expect(r.isError, r.text).toBe(false); return r.json as Out; };
const item = (o: Out, text: string) => o.list.items.find((i) => i.text === text);
const SLS = '/sverige/digx/mobile/shoppinglistservice/v1/shoppinglists';
const vecko = (): FakeAppList => s.fake.opts.appLists!.find((l) => l.offlineId === 'LIST-VECKO')!;
const rowsNamed = (text: string) => vecko().rows.filter((r) => r.productName === text);
const refreshes = () => s.fake.seen.tokenGrants.filter((g) => g === 'refresh_token').length;

describe('add_list_items', () => {
  it('adds free-text items with quantity and unit, and returns the new list', async () => {
    const o = await call('add_list_items', { items: [{ text: 'Bananer' }, { text: 'Yoghurt', quantity: 2, unit: 'st' }] });
    expect(o.added).toEqual(['Bananer', 'Yoghurt']);
    expect(item(o, 'Yoghurt')).toMatchObject({ qty: '2 st', checked: false });
    const created = s.fake.seen.syncBodies[0]!.body.createdRows!;
    expect(created.map((r) => r.productName)).toEqual(['Bananer', 'Yoghurt']);
    expect(created[1]).toMatchObject({ quantity: 2, unit: 'st', isStrikedOver: false, sourceId: -1 });
    expect(created[0]).not.toHaveProperty('quantity');
    expect(s.fake.seen.syncBodies).toHaveLength(1);
  });

  it('does not add an item that is already open, and re-opens one that is checked off', async () => {
    const o = await call('add_list_items', { items: [{ text: 'MJÖLK' }, { text: 'bröd' }] });
    expect(o).toMatchObject({ added: [], alreadyOnList: ['Mjölk'], reopened: ['Bröd'] });
    expect(item(o, 'Bröd')!.checked).toBe(false);
    expect(s.fake.seen.syncBodies[0]!.body.createdRows).toBeUndefined();
    expect(s.fake.seen.syncBodies[0]!.body.changedRows!.map((r) => r.offlineId)).toEqual(['ROW-BROD']);
  });

  it('reports a quantity it did not apply because the item was already open', async () => {
    const o = await call('add_list_items', { items: [{ text: 'mjölk', quantity: 2, unit: 'l' }, { text: 'Ägg', quantity: 12 }, { text: 'kaffe' }] });
    expect(o).toMatchObject({ added: [], alreadyOnList: ['Mjölk', 'Ägg', 'Kaffe'], quantityNotChanged: [{ text: 'Mjölk', qty: '2 l' }, { text: 'Ägg', qty: '12' }] });
    expect(item(o, 'Ägg')!.qty).toBe('6 st');
    expect(s.fake.seen.syncBodies).toEqual([]);
    expect(await call('add_list_items', { items: [{ text: 'mjölk' }] })).not.toHaveProperty('quantityNotChanged');
  });

  it('adds a repeated item once, and sends nothing when nothing changes', async () => {
    expect((await call('add_list_items', { items: [{ text: 'Salt' }, { text: 'salt' }] })).added).toEqual(['Salt']);
    expect(rowsNamed('Salt')).toHaveLength(1);
    s.fake.seen.syncBodies.length = 0;
    expect(await call('add_list_items', { items: [{ text: 'mjölk' }] })).toMatchObject({ added: [], alreadyOnList: ['Mjölk'] });
    expect(s.fake.seen.syncBodies).toEqual([]);
  });

  it('writes to the list named in any case', async () => {
    await call('add_list_items', { list: 'fest på åland', items: [{ text: 'Dipp' }] });
    expect(s.fake.seen.syncBodies[0]!.offlineId).toBe('LIST-FEST');
  });

  it('an unknown list changes nothing and names the lists', async () => {
    const r = await s.alice.client.call('add_list_items', { list: 'Jul', items: [{ text: 'Skinka' }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"Veckohandling"');
    expect(s.fake.seen.syncBodies).toEqual([]);
  });

  it('on an account without lists, points Claude to create_shopping_list', async () => {
    s.fake.opts.appLists = [];
    const r = await s.alice.client.call('add_list_items', { items: [{ text: 'Skinka' }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('create_shopping_list');
  });
});

describe('check_list_items / uncheck_list_items', () => {
  it('checks only the matching row and sends the whole row back, unknown fields included', async () => {
    const o = await call('check_list_items', { items: ['mjölk', 'kaffe'] });
    expect(o.checked).toEqual([{ id: 'ROW-MJOLK', text: 'Mjölk' }, { id: 'ROW-KAFFE', text: 'Kaffe' }]);
    expect(item(o, 'Havremjölk')!.checked).toBe(false);
    expect(item(o, 'Mjölk')!.checked).toBe(true);
    const changed = s.fake.seen.syncBodies[0]!.body.changedRows!;
    expect(changed.find((r) => r.offlineId === 'ROW-KAFFE')).toMatchObject({ isStrikedOver: true, futureField: { flag: true }, sourceId: -1, recipes: [] });
    expect(changed.map((r) => r.offlineId)).toEqual(['ROW-MJOLK', 'ROW-KAFFE']);
    expect(changed[0]!.latestChange).not.toBe('2026-09-28T10:00:00.000Z');
  });

  it('returns candidates for an ambiguous text and changes nothing for it', async () => {
    const o = await call('check_list_items', { items: ['mj'] });
    expect(o.checked).toEqual([]);
    expect(o.ambiguous).toEqual([{ query: 'mj', candidates: [{ id: 'ROW-MJOLK', text: 'Mjölk', checked: false }, { id: 'ROW-HAVRE', text: 'Havremjölk', checked: false }] }]);
    expect(o.hint).toMatch(/ask the user/i);
    expect(s.fake.seen.syncBodies).toEqual([]);
  });

  it('an ambiguous text leaves its rows alone while the other items in the call are checked', async () => {
    const o = await call('check_list_items', { items: ['mj', 'kaffe', 'banan'] });
    expect(o).toMatchObject({ checked: [{ id: 'ROW-KAFFE', text: 'Kaffe' }], notFound: ['banan'] });
    expect(s.fake.seen.syncBodies[0]!.body.changedRows!.map((r) => r.offlineId)).toEqual(['ROW-KAFFE']);
    expect(vecko().rows.filter((r) => r.isStrikedOver).map((r) => r.offlineId).sort()).toEqual(['ROW-BROD', 'ROW-KAFFE']);
  });

  it('reports an already checked item as unchanged; uncheck re-opens it', async () => {
    expect(await call('check_list_items', { items: ['bröd'] })).toMatchObject({ checked: [], unchanged: [{ query: 'bröd', id: 'ROW-BROD', text: 'Bröd' }] });
    expect(s.fake.seen.syncBodies).toEqual([]);
    const o = await call('uncheck_list_items', { items: ['bröd'] });
    expect(o.unchecked).toEqual([{ id: 'ROW-BROD', text: 'Bröd' }]);
    expect(item(o, 'Bröd')!.checked).toBe(false);
  });

  it('checking "mjölk" when Mjölk is already checked never checks Havremjölk', async () => {
    vecko().rows.find((r) => r.offlineId === 'ROW-MJOLK')!.isStrikedOver = true;
    const o = await call('check_list_items', { items: ['mjölk'] });
    expect(o).toMatchObject({ checked: [], unchanged: [{ id: 'ROW-MJOLK' }] });
    expect(item(o, 'Havremjölk')!.checked).toBe(false);
    expect(s.fake.seen.syncBodies).toEqual([]);
  });
});

describe('remove_list_items', () => {
  it('is marked destructive and tells Claude to confirm first; the other writes are not destructive', async () => {
    const tools = await s.alice.client.tools();
    const tool = tools.find((t) => t.name === 'remove_list_items')!;
    expect(tool.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(tool.description).toMatch(/confirm with the user/i);
    for (const name of ['add_list_items', 'check_list_items', 'uncheck_list_items', 'create_shopping_list']) {
      expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
  });

  it('never removes more than the matched rows', async () => {
    vecko().rows.push({ ...vecko().rows[0]!, offlineId: 'ROW-MJOLK-2' }); // a second "Mjölk"
    const amb = await call('remove_list_items', { items: ['mjölk'] });
    expect(amb.removed).toEqual([]);
    expect(amb.ambiguous).toEqual([{ query: 'mjölk', candidates: [{ id: 'ROW-MJOLK', text: 'Mjölk', checked: false }, { id: 'ROW-MJOLK-2', text: 'Mjölk', checked: false }] }]);
    expect(amb.hint).toMatch(/ask the user/i);
    expect(s.fake.seen.syncBodies).toEqual([]);
    const o = await call('remove_list_items', { items: ['ROW-HAVRE'] });
    expect(o.removed).toEqual([{ id: 'ROW-HAVRE', text: 'Havremjölk' }]);
    expect(s.fake.seen.syncBodies[0]!.body).toEqual({ deletedRows: ['ROW-HAVRE'] });
    expect(o.list.items.map((i) => i.text)).toEqual(['Mjölk', 'Ägg', 'Kaffe', 'Mjölk', 'Bröd']);
  });

  it('matches exact texts and ids only: a part of a text removes nothing', async () => {
    const o = await call('remove_list_items', { items: ['e', 'havre'] });
    expect(o).toMatchObject({ removed: [], notFound: ['e', 'havre'] });
    expect(s.fake.seen.syncBodies).toEqual([]);
    expect(vecko().rows).toHaveLength(5);
    const tool = (await s.alice.client.tools()).find((t) => t.name === 'remove_list_items')!;
    expect(tool.description).toMatch(/exact/i);
  });

  it('never removes a row by elimination: "Mjölk 3%" and "mjölk" leave Havremjölk on the list', async () => {
    const list = vecko();
    list.rows = list.rows.filter((r) => r.offlineId !== 'ROW-MJOLK');
    list.rows.unshift({ ...list.rows[0]!, offlineId: 'ROW-M3', productName: 'Mjölk 3%', isStrikedOver: false });
    for (const items of [['mjölk 3%', 'mjölk'], ['ROW-M3', 'Mjölk']]) {
      const o = await call('check_list_items', { items });
      expect(o.checked).toEqual([{ id: 'ROW-M3', text: 'Mjölk 3%' }]);
      expect(item(o, 'Havremjölk')!.checked).toBe(false);
      await call('uncheck_list_items', { items: ['ROW-M3'] });
    }
    const o = await call('remove_list_items', { items: ['Mjölk 3%', 'ROW-M3', 'mjölk'] });
    expect(o.removed).toEqual([{ id: 'ROW-M3', text: 'Mjölk 3%' }]);
    expect(rowsNamed('Havremjölk')).toHaveLength(1);
    expect(s.fake.seen.syncBodies.at(-1)!.body).toEqual({ deletedRows: ['ROW-M3'] });
  });

  it('removes a checked-off row by its text too', async () => {
    const o = await call('remove_list_items', { items: ['bröd', 'banan'] });
    expect(o).toMatchObject({ removed: [{ id: 'ROW-BROD', text: 'Bröd' }], notFound: ['banan'] });
    expect(rowsNamed('Bröd')).toEqual([]);
  });
});

describe('create_shopping_list', () => {
  it('creates a list, and returns an existing one with the same title instead of a duplicate', async () => {
    const o = await call('create_shopping_list', { title: 'Midsommar' });
    expect(o).toMatchObject({ created: true, list: { title: 'Midsommar', items: [] } });
    expect(s.fake.seen.createBodies[0]).toMatchObject({ title: 'Midsommar', offlineId: o.list.id });
    expect(await call('create_shopping_list', { title: 'veckohandling' })).toMatchObject({ created: false, list: { id: 'LIST-VECKO' } });
    expect(s.fake.seen.createBodies).toHaveLength(1);
  });

  it('works on an account without any list', async () => {
    s.fake.opts.appLists = [];
    expect(await call('create_shopping_list', { title: 'Första' })).toMatchObject({ created: true, list: { title: 'Första' } });
  });
});

/**
 * `SessionKeeper.withAppBearer` re-runs a whole `session.app` callback once after a 401/403. These force exactly one
 * 401 at the worst moments: the sync (or create) took effect at ICA but its answer was a 401 (`applied`), and the
 * re-read after a successful sync. Every write must then have happened exactly once.
 */
describe('writes are safe to retry after a 401', () => {
  const lostAnswer = (pathPrefix: string, method = 'POST') => { s.fake.opts.gatewayFailures = [{ pathPrefix, method, status: 401, times: 1, applied: true }]; };
  const rereadFails = () => { s.fake.opts.gatewayFailures = [{ pathPrefix: `${SLS}/LIST-VECKO`, method: 'GET', status: 401, times: 1 }]; };

  it('add: a sync that took effect but answered 401 does not add the row twice', async () => {
    lostAnswer(`${SLS}/LIST-VECKO/sync`);
    const before = refreshes();
    const o = await call('add_list_items', { items: [{ text: 'Bananer' }, { text: 'bröd' }] });
    expect(refreshes() - before).toBe(1);
    expect(s.fake.opts.gatewayFailures[0]!.times).toBe(0);
    expect(s.fake.seen.syncBodies).toHaveLength(1);
    expect(rowsNamed('Bananer')).toHaveLength(1);
    expect(o).toMatchObject({ added: ['Bananer'], reopened: ['Bröd'] });
    expect(o.list.items.filter((i) => i.text === 'Bananer')).toHaveLength(1);
  });

  it('add: a 401 on the re-read after the sync does not send the sync again', async () => {
    rereadFails();
    const o = await call('add_list_items', { items: [{ text: 'Bananer' }] });
    expect(s.fake.opts.gatewayFailures[0]!.times).toBe(0);
    expect(s.fake.seen.syncBodies).toHaveLength(1);
    expect(rowsNamed('Bananer')).toHaveLength(1);
    expect(o.added).toEqual(['Bananer']);
  });

  it('add: a sync refused with 401 (not applied) is sent again once, with the same row id', async () => {
    s.fake.opts.gatewayFailures = [{ pathPrefix: `${SLS}/LIST-VECKO/sync`, method: 'POST', status: 401, times: 1 }];
    await call('add_list_items', { items: [{ text: 'Bananer' }] });
    expect(s.fake.seen.syncBodies).toHaveLength(1); // the refused attempt never reached the list
    expect(rowsNamed('Bananer')).toHaveLength(1);
  });

  it('check: a lost sync answer changes the row once and still reports it checked', async () => {
    lostAnswer(`${SLS}/LIST-VECKO/sync`);
    const o = await call('check_list_items', { items: ['mjölk'] });
    expect(s.fake.seen.syncBodies).toHaveLength(1);
    expect(o.checked).toEqual([{ id: 'ROW-MJOLK', text: 'Mjölk' }]);
    expect(o.unchanged).toBeUndefined();
    expect(item(o, 'Mjölk')!.checked).toBe(true);
    expect(vecko().rows.filter((r) => r.isStrikedOver).map((r) => r.offlineId).sort()).toEqual(['ROW-BROD', 'ROW-MJOLK']);
  });

  it('check: a 401 on the re-read does not sync again', async () => {
    rereadFails();
    const o = await call('check_list_items', { items: ['kaffe'] });
    expect(s.fake.seen.syncBodies).toHaveLength(1);
    expect(o.checked).toEqual([{ id: 'ROW-KAFFE', text: 'Kaffe' }]);
  });

  it('uncheck: a lost sync answer re-opens the row once', async () => {
    lostAnswer(`${SLS}/LIST-VECKO/sync`);
    const o = await call('uncheck_list_items', { items: ['bröd'] });
    expect(s.fake.seen.syncBodies).toHaveLength(1);
    expect(o.unchecked).toEqual([{ id: 'ROW-BROD', text: 'Bröd' }]);
    expect(item(o, 'Bröd')!.checked).toBe(false);
  });

  it('remove: a lost sync answer removes exactly the matched row once and reports it removed', async () => {
    lostAnswer(`${SLS}/LIST-VECKO/sync`);
    const o = await call('remove_list_items', { items: ['havremjölk'] });
    expect(s.fake.seen.syncBodies).toHaveLength(1);
    expect(o.removed).toEqual([{ id: 'ROW-HAVRE', text: 'Havremjölk' }]);
    expect(o.notFound).toBeUndefined();
    expect(vecko().rows.map((r) => r.offlineId)).toEqual(['ROW-MJOLK', 'ROW-AGG', 'ROW-BROD', 'ROW-KAFFE']);
  });

  it('create: a create that took effect but answered 401 makes one list, reported as created', async () => {
    lostAnswer(SLS);
    const o = await call('create_shopping_list', { title: 'Midsommar' });
    expect(s.fake.opts.gatewayFailures[0]!.times).toBe(0);
    expect(s.fake.seen.createBodies).toHaveLength(1);
    expect(s.fake.opts.appLists!.filter((l) => l.title === 'Midsommar')).toHaveLength(1);
    expect(o).toMatchObject({ created: true, list: { title: 'Midsommar' } });
  });
});

describe('a failure after the sync may have been sent', () => {
  it('a 5xx after an applied sync says the change may already be applied', async () => {
    s.fake.opts.gatewayFailures = [{ pathPrefix: `${SLS}/LIST-VECKO/sync`, method: 'POST', status: 502, times: 1, applied: true }];
    const r = await s.alice.client.call('add_list_items', { items: [{ text: 'Bananer' }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('HTTP 502');
    expect(r.text).toContain('The change may already have been applied — check with get_shopping_list before trying again.');
    expect(rowsNamed('Bananer')).toHaveLength(1);
  });

  it('a 5xx on the create says so too; a 5xx before any write does not', async () => {
    s.fake.opts.gatewayFailures = [{ pathPrefix: SLS, method: 'POST', status: 503, times: 1, applied: true }];
    expect((await s.alice.client.call('create_shopping_list', { title: 'Jul' })).text).toContain('may already have been applied');
    s.fake.opts.gatewayFailures = [{ pathPrefix: SLS, method: 'GET', status: 503, times: 1 }];
    const r = await s.alice.client.call('check_list_items', { items: ['kaffe'] });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain('may already have been applied');
    expect(s.fake.seen.syncBodies).toEqual([]);
  });
});

describe('a failure after the sync is always "may already be applied"', () => {
  it('a 401 after an applied sync, then a failed app refresh: reconnect text plus the advice', async () => {
    const t = await startToolTest({ env: { ICA_HUB_LIST_WRITES: 'all' } });
    try {
      t.fake.opts.gatewayFailures = [{ pathPrefix: `${SLS}/LIST-VECKO/sync`, method: 'POST', status: 401, times: 1, applied: true }];
      t.fake.opts.refreshInvalid = true;
      const r = await t.alice.client.call('add_list_items', { items: [{ text: 'Bananer' }] });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('Reconnect app access with BankID');
      expect(r.text).toContain(MAYBE_APPLIED);
      expect(t.fake.opts.appLists![0]!.rows.filter((x) => x.productName === 'Bananer')).toHaveLength(1);
    } finally { await t.close(); }
  });

  it('the ICA budget running out on the re-read: try-again text plus the advice', async () => {
    const t = await startToolTest({ env: { ICA_HUB_LIST_WRITES: 'all' }, icaRateLimit: { capacity: 1, refillPerSecond: 0.001 } });
    try {
      const r = await t.alice.client.call('check_list_items', { items: ['kaffe'] });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Try again in \d+ s/);
      expect(r.text).toContain(MAYBE_APPLIED);
      expect(t.fake.seen.syncBodies).toHaveLength(1);
    } finally { await t.close(); }
  });

  it('a 429 answering the sync itself is not "may be applied"; a 429 on the re-read is', async () => {
    s.fake.opts.gatewayFailures = [{ pathPrefix: `${SLS}/LIST-VECKO/sync`, method: 'POST', status: 429, times: 1 }];
    const r = await s.alice.client.call('check_list_items', { items: ['kaffe'] });
    expect(r.text).toContain('HTTP 429');
    expect(r.text).not.toContain(MAYBE_APPLIED);
    s.fake.opts.gatewayFailures = [{ pathPrefix: `${SLS}/LIST-VECKO`, method: 'GET', status: 429, times: 1 }];
    const r2 = await s.alice.client.call('check_list_items', { items: ['ägg'] });
    expect(r2.text).toContain('HTTP 429');
    expect(r2.text).toContain(MAYBE_APPLIED);
  });
});

describe('the report only claims what the re-read list shows', () => {
  it('when ICA accepts a sync but the list does not change, nothing is reported as done', async () => {
    s.fake.opts.appSyncIgnored = true;
    const add = await call('add_list_items', { items: [{ text: 'Bananer' }] });
    expect(add).toMatchObject({ added: [], notSeen: [{ text: 'Bananer' }] });
    expect(add.notSeenHint).toMatch(/get_shopping_list/);
    expect(await call('check_list_items', { items: ['kaffe'] })).toMatchObject({ checked: [], notSeen: [{ id: 'ROW-KAFFE', text: 'Kaffe' }] });
    expect(await call('uncheck_list_items', { items: ['bröd'] })).toMatchObject({ unchecked: [], notSeen: [{ id: 'ROW-BROD', text: 'Bröd' }] });
    expect(await call('remove_list_items', { items: ['ägg'] })).toMatchObject({ removed: [], notSeen: [{ id: 'ROW-AGG', text: 'Ägg' }] });
  });
});

describe('write tools: privacy and hygiene', () => {
  /** Every key anywhere in a JSON value (object keys only; array indices are not names). */
  const keysOf = (v: unknown): string[] =>
    Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : [];
  const LIST_KEYS = ['list', 'id', 'title', 'open', 'checked', 'items', 'text', 'qty'];
  const CASES: [string, Record<string, unknown>, string[]][] = [
    ['add_list_items', { items: [{ text: 'Bananer', quantity: 2, unit: 'st' }, { text: 'mjölk', quantity: 1 }, { text: 'bröd' }] }, ['added', 'reopened', 'alreadyOnList', 'quantityNotChanged']],
    ['check_list_items', { items: ['kaffe', 'mj', 'bröd', 'banan'] }, ['unchanged', 'query', 'ambiguous', 'candidates', 'hint', 'notFound']],
    ['uncheck_list_items', { items: ['bröd'] }, ['unchecked']],
    ['remove_list_items', { items: ['ROW-KAFFE', 'mj'] }, ['removed', 'notFound']],
    ['create_shopping_list', { title: 'Midsommar' }, ['created']],
  ];
  /** Raw ICA fields and values the fake sends that no write tool may pass on. */
  const NEVER = ['futureField', 'sourceId', 'latestChange', 'recipes', 'articleGroup', 'sortingStore', 'commentText', 'isStrikedOver', 'offlineId', '45000001'];

  for (const [tool, args, extra] of CASES) {
    it(`${tool} returns only the list view and its own report fields`, async () => {
      const r = await s.alice.client.call(tool, args);
      expect(r.isError, r.text).toBe(false);
      expect([...new Set(keysOf(r.json))].filter((k) => !LIST_KEYS.includes(k) && !extra.includes(k))).toEqual([]);
      for (const v of NEVER) expect(r.text).not.toContain(v);
    });
  }

  it('only the app bearer reached mobile/*, and no output or log line contains a secret or a list text', () => {
    expect(s.fake.seen.gatewayCalls.filter((c) => c.includes('/mobile/')).every((c) => c.endsWith(' app'))).toBe(true);
    const all = s.logs.join('\n');
    for (const v of [...Object.values(FAKE_SECRETS), 'Bananer', 'Mjölk', 'Midsommar', 'Veckohandling', 'LIST-VECKO', 'ROW-']) expect(all).not.toContain(v);
    expect(s.logs.some((l) => l.includes('"tool":"add_list_items"'))).toBe(true);
  });
});

describe('ICA_HUB_LIST_WRITES gate', () => {
  const WRITES = ['add_list_items', 'check_list_items', 'uncheck_list_items', 'remove_list_items', 'create_shopping_list'];
  const names = async (t: ToolTest) => (await t.alice.client.tools()).map((x) => x.name);

  it('off (the default): the write tools are not registered at all, and no text mentions them', async () => {
    const off = await startToolTest();
    try {
      const all = await off.alice.client.tools();
      const tools = all.map((x) => x.name);
      for (const w of WRITES) expect(tools).not.toContain(w);
      expect(tools).toContain('get_shopping_list');
      const texts = JSON.stringify(all.map((x) => x.description));
      for (const w of WRITES) expect(texts).not.toContain(w);
      off.fake.opts.appLists = [];
      const empty = await off.alice.client.call('get_shopping_list');
      expect(empty.text).toBe('There are no shopping lists on this ICA account yet. Create one in the ICA app.');
      expect((await s.alice.client.tools()).find((x) => x.name === 'get_shopping_list')!.description).toContain('check_list_items');
      expect((await off.alice.client.call('add_list_items', { items: [{ text: 'Bananer' }] })).isError).toBe(true);
      expect(off.fake.seen.syncBodies).toEqual([]);
    } finally { await off.close(); }
  });

  it('all: every linked user can write', async () => {
    expect(await names(s)).toEqual(expect.arrayContaining(WRITES));
    expect((await s.bob.client.call('check_list_items', { items: ['kaffe'] })).isError).toBe(false);
  });

  it('a list of emails: registered for everyone, refused at call time for anyone else, by the current email (any case)', async () => {
    const some = await startToolTest({ env: { ICA_HUB_LIST_WRITES: 'ALICE@example.com, nobody@example.com' } });
    try {
      expect(await names(some)).toEqual(expect.arrayContaining(WRITES));
      expect((await some.alice.client.call('add_list_items', { items: [{ text: 'Bananer' }] })).isError).toBe(false);
      expect(some.fake.seen.syncBodies).toHaveLength(1);
      const calls = some.fake.seen.gatewayCalls.length;
      for (const [tool, args] of [['add_list_items', { items: [{ text: 'Salt' }] }], ['remove_list_items', { items: ['kaffe'] }], ['create_shopping_list', { title: 'Jul' }]] as const) {
        const r = await some.bob.client.call(tool, args);
        expect(r.isError).toBe(true);
        expect(r.text).toBe('List editing is not enabled for your account yet.');
      }
      expect(some.fake.seen.gatewayCalls.length).toBe(calls); // refused before any ICA call
      expect(some.fake.seen.syncBodies).toHaveLength(1);
      expect((await some.bob.client.call('get_shopping_list')).isError).toBe(false);
      // The gate reads the email from the database at call time: a changed email changes the answer.
      some.t.db.update(schema.user).set({ email: 'someone-else@example.com' }).where(eq(schema.user.id, some.alice.id)).run();
      expect((await some.alice.client.call('check_list_items', { items: ['kaffe'] })).text).toBe('List editing is not enabled for your account yet.');
      some.t.db.update(schema.user).set({ email: 'Nobody@Example.com' }).where(eq(schema.user.id, some.bob.id)).run();
      expect((await some.bob.client.call('check_list_items', { items: ['kaffe'] })).isError).toBe(false);
      // A member's own, unconfirmed change to an allow-listed address does not open the gate; an admin's confirmation does.
      expect(changeUserEmail(some.t.db, some.alice.id, 'ALICE@example.com', { vouched: false })).toMatchObject({ ok: true });
      const self = await some.alice.client.call('check_list_items', { items: ['ägg'] });
      expect(self.text).toBe('List editing is not enabled for your account yet. An admin must confirm your email first.');
      expect(changeUserEmail(some.t.db, some.alice.id, 'alice@example.com', { vouched: true })).toMatchObject({ ok: true, confirmedOnly: true });
      expect((await some.alice.client.call('check_list_items', { items: ['ägg'] })).isError).toBe(false);
    } finally { await some.close(); }
  });
});

describe('assertCanWrite', () => {
  const deps = (listWrites: 'all' | string[]) => ({ config: { ...s.t.config, listWrites }, db: s.t.db }) as unknown as ToolDeps;
  it('refuses a user id with no user row, in every mode', () => {
    for (const mode of ['all', ['alice@example.com']] as const) {
      expect(() => assertCanWrite(deps(mode as 'all' | string[]), 'no-such-user')).toThrow(new ToolInputError('List editing is not enabled for your account yet.'));
    }
    expect(() => assertCanWrite(deps(['alice@example.com']), s.alice.id)).not.toThrow();
    expect(() => assertCanWrite(deps('all'), s.bob.id)).not.toThrow();
  });
});
