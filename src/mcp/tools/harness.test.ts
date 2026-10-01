import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appKeeper } from '../../server.js';
import { linkedIcaAccount } from '../../sessions/web-store.js';
import { FAKE_SECRETS } from '../../ica/test-fakes.js';
import { startToolTest, type ToolTest } from '../../test-helpers.js';
import { ok, runTool, type ToolDeps } from './runtime.js';

let s: ToolTest;
beforeAll(async () => { s = await startToolTest(); });
afterAll(async () => { await s.close(); });

describe('tool test harness', () => {
  it('gives each member a real /mcp token that resolves to their own hub user', async () => {
    for (const u of [s.alice, s.bob, s.carol]) {
      expect((await u.client.call('ping')).json).toMatchObject({ ok: true, userId: u.id });
    }
    expect((await s.alice.client.tools()).map((t) => t.name)).toContain('ping');
  });

  it('links alice and bob to separate ICA accounts with web and app sessions; carol has none', () => {
    const a = linkedIcaAccount(s.t.db, s.alice.id)!; const b = linkedIcaAccount(s.t.db, s.bob.id)!;
    expect(a.account.id).not.toBe(b.account.id);
    expect([Boolean(a.web), Boolean(a.app), Boolean(b.web), Boolean(b.app)]).toEqual([true, true, true, true]);
    expect(linkedIcaAccount(s.t.db, s.carol.id)).toBeUndefined();
  });

  it('an unknown tool is an error, not a crash', async () => {
    expect((await s.alice.client.call('no_such_tool')).isError).toBe(true);
  });
});

/** runTool over the app's one keeper, as a tool registered in buildMcpServer runs it (Task 2.8 on). */
const listsVia = (ts: ToolTest, log: ToolDeps['log'], userId: string) =>
  runTool({ config: ts.t.config, db: ts.t.db, keeper: appKeeper(ts.t.app), log }, { http: { authInfo: { extra: { userId } } } }, 'lists',
    async (session) => ok(await session.app((api) => api.shoppingLists())));
const quiet: ToolDeps['log'] = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('runTool with the real keeper', () => {
  it("each member reaches ICA with their own account's app bearer", async () => {
    const before = s.fake.seen.bearers.length;
    expect((await listsVia(s, quiet, s.alice.id)).isError).toBeUndefined();
    expect((await listsVia(s, quiet, s.bob.id)).isError).toBeUndefined();
    expect(s.fake.seen.bearers.slice(before)).toEqual([`Bearer ${FAKE_SECRETS.appAccessToken}`, `Bearer ${FAKE_SECRETS.appAccessTokenB}`]);
  });

  it('carol (no ICA account) gets the actionable not-linked text, and nothing reaches ICA', async () => {
    const before = s.fake.seen.bearers.length;
    const r = await listsVia(s, quiet, s.carol.id);
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toContain(`${s.t.config.publicUrl}/admin/ica`);
    expect(s.fake.seen.bearers.length).toBe(before);
  });

  it('a schema mismatch logs issue paths and codes for the operator, never ICA values; Claude gets no ICA body', async () => {
    const saved = s.fake.opts.appLists;
    s.fake.opts.appLists = [{ id: 1, offlineId: 'off-1', title: 42 as unknown as string, commentText: `Lista ${FAKE_SECRETS.personnummer}`, sortingStore: 0, latestChange: '', rows: [] }];
    try {
      const logs: object[] = [];
      const push = (o: object) => { logs.push(o); };
      const res = await listsVia(s, { info: push, warn: push, error: push }, s.alice.id);
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).toContain('does not understand');
      expect(logs).toContainEqual({ tool: 'lists', issues: ['shoppingLists.0.title: invalid_type'] });
      for (const leak of [FAKE_SECRETS.personnummer, FAKE_SECRETS.appAccessToken, '"title":42']) {
        expect(JSON.stringify(res)).not.toContain(leak);
        expect(JSON.stringify(logs)).not.toContain(leak);
      }
    } finally { s.fake.opts.appLists = saved; }
  });

  it("ToolTest.logs captures the app's keeper, whose refresh line carries no ICA secret", async () => {
    const acc = linkedIcaAccount(s.t.db, s.alice.id)!.account.id;
    await appKeeper(s.t.app).refreshAppNow(acc); // rotates alice's tokens at the fake; later calls use the new ones
    const refresh = s.logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'ica session refresh');
    expect(refresh).toMatchObject({ account: acc, kind: 'app', event: 'refresh', ok: true });
    const all = s.logs.join('\n');
    for (const secret of Object.values(FAKE_SECRETS)) expect(all).not.toContain(secret);
  });
});

describe('runTool: the per-user ICA budget', () => {
  let r: ToolTest;
  beforeAll(async () => { r = await startToolTest({ icaRateLimit: { capacity: 1, refillPerSecond: 0.01 } }); });
  afterAll(async () => { await r.close(); });

  it('alice spends her one call and is told when to retry; bob still has his', async () => {
    expect((await listsVia(r, quiet, r.alice.id)).isError).toBeUndefined();
    const limited = await listsVia(r, quiet, r.alice.id);
    expect(limited.isError).toBe(true);
    expect(JSON.stringify(limited)).toMatch(/Try again in \d+ s/);
    expect((await listsVia(r, quiet, r.bob.id)).isError).toBeUndefined();
  });
});
