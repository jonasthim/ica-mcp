import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_SECRETS, fakeHouseholdLists } from '../../ica/test-fakes.js';
import { linkedIcaAccount } from '../../sessions/web-store.js';
import { linkFakeIca, startToolTest, type ToolTest } from '../../test-helpers.js';

let s: ToolTest;
beforeAll(async () => { s = await startToolTest(); });
afterAll(async () => { await s.close(); });
beforeEach(() => { s.fake.opts.appLists = fakeHouseholdLists(); });
const refreshes = () => s.fake.seen.tokenGrants.filter((g) => g === 'refresh_token').length;
const setAppExpiry = (userId: string, ms: number) => {
  const row = linkedIcaAccount(s.t.db, userId)!.app!;
  s.t.db.$client.prepare('update ica_session set expires_at = ? where id = ?').run(new Date(Date.now() + ms).toISOString(), row.id);
};

describe('list read tools', () => {
  it('are listed as read-only', async () => {
    const tools = await s.alice.client.tools();
    for (const name of ['list_shopping_lists', 'get_shopping_list']) expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('list_shopping_lists: ids, titles and counts', async () => {
    expect((await s.alice.client.call('list_shopping_lists')).json).toEqual({ lists: [
      { id: 'LIST-VECKO', title: 'Veckohandling', open: 4, checked: 1 },
      { id: 'LIST-FEST', title: 'Fest på Åland', open: 1, checked: 0 },
    ] });
  });

  it('get_shopping_list: the first list by default, open items first, quantity as text, no internal fields', async () => {
    const r = await s.alice.client.call('get_shopping_list');
    expect(r.json).toEqual({ id: 'LIST-VECKO', title: 'Veckohandling', open: 4, checked: 1, items: [
      { id: 'ROW-MJOLK', text: 'Mjölk', checked: false }, { id: 'ROW-HAVRE', text: 'Havremjölk', checked: false },
      { id: 'ROW-AGG', text: 'Ägg', qty: '6 st', checked: false }, { id: 'ROW-KAFFE', text: 'Kaffe', checked: false },
      { id: 'ROW-BROD', text: 'Bröd', checked: true },
    ] });
    expect(r.text).not.toMatch(/futureField|sourceId|latestChange|articleGroup|sortingStore|commentText|45000001/);
  });

  it('get_shopping_list: by title in another case, and a helpful error for an unknown one', async () => {
    expect((await s.alice.client.call('get_shopping_list', { list: 'FEST PÅ ÅLAND' })).json).toMatchObject({ title: 'Fest på Åland' });
    const r = await s.alice.client.call('get_shopping_list', { list: 'Jul' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"Veckohandling"');
  });

  it('get_shopping_list: a title with a decomposed å (NFD, as iOS may send it) resolves over MCP', async () => {
    const nfd = 'Fest pa\u030A A\u030Aland';
    expect(nfd).not.toBe(nfd.normalize('NFC'));
    const r = await s.alice.client.call('get_shopping_list', { list: nfd });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ id: 'LIST-FEST', title: 'Fest på Åland' });
  });

  it('two members read the shared list at the same time', async () => {
    setAppExpiry(s.alice.id, 30_000); // alice's app token is about to expire; bob's is fresh
    const before = refreshes();
    const rs = await Promise.all([
      s.alice.client.call('get_shopping_list'), s.bob.client.call('get_shopping_list'),
      s.alice.client.call('get_shopping_list'), s.bob.client.call('get_shopping_list'),
    ]);
    expect(rs.map((r) => [r.isError, (r.json as { id: string }).id])).toEqual(Array(4).fill([false, 'LIST-VECKO']));
    expect(refreshes() - before).toBe(1);
    expect(s.fake.seen.bearers).toContain(`Bearer ${FAKE_SECRETS.appAccessTokenB}`);
  });

  it('a hub user without an ICA account is told where to connect', async () => {
    const r = await s.carol.client.call('list_shopping_lists');
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`${s.t.url}/admin/ica`);
    expect(r.text).toContain('"Connect with BankID"');
  });

  it('a web-only member is told to connect app access; the web bearer never reaches mobile/*', async () => {
    await linkFakeIca(s.t, s.fake, s.carol, { app: false });
    const before = s.fake.seen.gatewayCalls.length;
    const r = await s.carol.client.call('get_shopping_list');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"Connect app access with BankID"');
    expect(s.fake.seen.gatewayCalls.slice(before)).toEqual([]);
  });

  it('the app session expires between two calls', async () => {
    expect((await s.alice.client.call('list_shopping_lists')).isError).toBe(false);
    setAppExpiry(s.alice.id, -1000);
    s.fake.opts.refreshInvalid = true;
    try {
      const r = await s.alice.client.call('list_shopping_lists');
      expect(r.isError).toBe(true);
      expect(r.text).toContain(`${s.t.url}/admin/ica`);
      expect(r.text).toContain('"Reconnect app access with BankID"');
      expect(linkedIcaAccount(s.t.db, s.alice.id)!.app!.lastError).toBe('app session expired — reconnect');
    } finally { s.fake.opts.refreshInvalid = false; }
  });

  it('logs one line per call and no secret', () => {
    const calls = s.logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === 'tool call');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(Object.keys(c).filter((k) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(k)).sort()).toEqual(['ms', 'status', 'tool', 'userId']);
    const all = s.logs.join('\n');
    for (const v of Object.values(FAKE_SECRETS)) expect(all).not.toContain(v);
  });
});
