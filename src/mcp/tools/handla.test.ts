import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_SECRETS } from '../../ica/test-fakes.js';
import { appKeeper } from '../../server.js';
import { startToolTest, type ToolTest } from '../../test-helpers.js';
import { registerHandlaTools } from './handla.js';

let s: ToolTest;
beforeAll(async () => { s = await startToolTest(); });
afterAll(async () => { await s.close(); });

describe('Handla tools', () => {
  it('finds Handla stores by zip, marking delivery and pickup, without addresses; no ICA account needed', async () => {
    const r = await s.carol.client.call('handla_find_stores', { zip: '123 45' });
    expect(Date.parse((r.json as { asOf: string }).asOf)).not.toBeNaN();
    expect(r.json).toEqual({ zip: '12345', asOf: expect.any(String), stores: [
      { id: 'HS-1001', name: 'ICA Kvantum Testköping', city: 'Testköping', delivery: true, pickup: true },
      { id: 'HS-1002', name: 'ICA Nära Fakeby', city: 'Fakeby', delivery: true, pickup: false },
    ] });
    expect(r.text).not.toContain(FAKE_SECRETS.street);
  });

  it('searches a store\'s online prices', async () => {
    const r = await s.alice.client.call('handla_search_products', { store: 'HS-1001', query: 'mjölk', limit: 5 });
    expect(r.json).toEqual({ store: 'HS-1001', query: 'mjölk', asOf: expect.any(String), products: [
      { id: 'p-1', name: 'Mellanmjölk 1,5%', brand: 'Arla', size: '1 l', price: '15.90 SEK', unitPrice: '15.90 SEK per fop.price.per.litre', available: true },
      { id: 'p-2', name: 'Laktosfri mjölk', brand: 'Arla Ko', size: '1 l', price: '19.50 SEK', unitPrice: '19.50 SEK per fop.price.per.litre', available: false },
    ] });
    expect(r.text).not.toContain('images.example');
  });

  it('rejects a malformed zip, and sends no ICA credential to Handla', async () => {
    expect((await s.alice.client.call('handla_find_stores', { zip: '12' })).isError).toBe(true);
    expect(s.fake.seen.handlaRequests.every((h) => h.auth === null && h.cookie === null)).toBe(true);
  });

  it('rejects a store id that is not a plain Handla id (path segments, dots, too long) before any Handla call', async () => {
    const before = s.fake.seen.handlaRequests.length;
    for (const store of ['..', '.', '../x', 'HS/1001', 'HS-1001?x=1', 'a'.repeat(41), 'HS 1001']) {
      const r = await s.alice.client.call('handla_search_products', { store, query: 'mjölk' });
      expect(r.isError, store).toBe(true);
    }
    expect(s.fake.seen.handlaRequests).toHaveLength(before);
    expect((await s.alice.client.call('handla_search_products', { store: 'HS-1001', query: 'mjölk' })).isError).toBe(false);
  });

  it('Handla still answering a plain 202 after the short retries: says so and to try again, never an HTTP status', async () => {
    s.fake.opts.handlaPending = 99; // far more pending answers than the retries (1 initial + 2) allow
    try {
      const r = await s.alice.client.call('handla_search_products', { store: 'HS-1001', query: 'grädde' }); // not cached by an earlier test
      expect(r).toMatchObject({ isError: true, text: 'Handla is still preparing results; try again in a moment.' });
    } finally { s.fake.opts.handlaPending = 0; }
  });

  it('a plain 202 for a retry or two, then an answer: no error', async () => {
    s.fake.opts.handlaPending = 2;
    try {
      const r = await s.alice.client.call('handla_search_products', { store: 'HS-1001', query: 'smör' });
      expect(r.isError).toBeFalsy();
    } finally { s.fake.opts.handlaPending = 0; }
  });

  it('the plain-202 retries behind one call still spend only one of the caller\'s ICA budget tokens', async () => {
    const tight = await startToolTest({ icaRateLimit: { capacity: 1, refillPerSecond: 0.001 } });
    try {
      tight.fake.opts.handlaPending = 2;
      expect((await tight.carol.client.call('handla_search_products', { store: 'HS-1001', query: 'mjölk' })).isError).toBe(false);
      const r = await tight.carol.client.call('handla_search_products', { store: 'HS-1001', query: 'ost' });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Try again in \d+ s/);
    } finally { await tight.close(); }
  });

  it('a cache hit makes no Handla request but still spends a budget token', async () => {
    const tight = await startToolTest({ icaRateLimit: { capacity: 2, refillPerSecond: 0.001 } });
    try {
      expect((await tight.carol.client.call('handla_search_products', { store: 'HS-1001', query: 'mjölk' })).isError).toBe(false);
      expect((await tight.carol.client.call('handla_search_products', { store: 'HS-1001', query: ' Mjölk' })).isError).toBe(false);
      expect(tight.fake.seen.handlaRequests).toHaveLength(1);
      const r = await tight.carol.client.call('handla_search_products', { store: 'HS-1001', query: 'mjölk' });
      expect(r.text).toMatch(/Try again in \d+ s/);
    } finally { await tight.close(); }
  });
});

describe('Handla tools: privacy', () => {
  const keysOf = (v: unknown): string[] =>
    Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : [];
  const ALLOWED: Record<string, { args: Record<string, unknown>; keys: string[] }> = {
    handla_find_stores: { args: { zip: '12345' }, keys: ['zip', 'asOf', 'stores', 'id', 'name', 'city', 'delivery', 'pickup'] },
    handla_search_products: { args: { store: 'HS-1001', query: 'mjölk' }, keys: ['store', 'query', 'asOf', 'products', 'id', 'name', 'brand', 'size', 'price', 'unitPrice', 'available'] },
  };
  for (const [tool, { args, keys }] of Object.entries(ALLOWED)) {
    it(`${tool} returns only its named fields (fresh and cached alike), with asOf`, async () => {
      for (const round of ['fresh or cached', 'cached']) {
        const r = await s.bob.client.call(tool, args);
        expect(r.isError, round).toBeFalsy();
        expect([...new Set(keysOf(r.json))].filter((k) => !keys.includes(k)), round).toEqual([]);
        expect(r.text, round).not.toContain(FAKE_SECRETS.street);
        expect(r.text, round).not.toContain('images.example');
      }
    });
  }

  it('a cached answer keeps the asOf of when Handla was asked', async () => {
    const a = (await s.bob.client.call('handla_search_products', { store: 'HS-1001', query: 'filmjölk' })).json as { asOf: string };
    await new Promise((r) => setTimeout(r, 5));
    const b = (await s.bob.client.call('handla_search_products', { store: 'HS-1001', query: 'filmjölk' })).json as { asOf: string };
    expect(b.asOf).toBe(a.asOf);
  });
});

describe('Handla tools: pacing, origin refusals and cancellation', () => {
  it('past the per-minute window: the pacing text (no HTTP status), reason rate-limited logged, budget refunded', async () => {
    const w = await startToolTest({ env: { ICA_HUB_HANDLA_MAX_PER_MINUTE: '2' }, icaRateLimit: { capacity: 3, refillPerSecond: 0.001 } });
    try {
      for (const q of ['a', 'b']) expect((await w.carol.client.call('handla_search_products', { store: 'HS-1001', query: q })).isError).toBe(false);
      const r = await w.carol.client.call('handla_search_products', { store: 'HS-1001', query: 'c' });
      expect(r).toMatchObject({ isError: true, text: "Handla lookups are paced to 2 per minute to avoid ICA's bot protection. Try the remaining items in about 60 seconds. Earlier results are cached for 15 minutes." });
      const line = w.logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === 'tool call').at(-1);
      expect(line).toMatchObject({ status: 'IcaUnavailable', reason: 'rate-limited' });
      expect(line).not.toHaveProperty('httpStatus');
      expect(w.fake.seen.handlaRequests).toHaveLength(2);
      // The refused call's token was refunded: the third token still answers a cached search.
      expect((await w.carol.client.call('handla_search_products', { store: 'HS-1001', query: 'a' })).isError).toBe(false);
    } finally { await w.close(); }
  });

  it('a bad store id answered with an origin 403 through CloudFront never opens the breaker', async () => {
    const w = await startToolTest();
    try {
      w.fake.opts.handlaUnknownStore403 = true;
      for (let i = 0; i < 3; i += 1) {
        const r = await w.carol.client.call('handla_search_products', { store: 'HS-NOPE', query: 'mjölk' });
        expect(r).toMatchObject({ isError: true, text: 'ICA rejected the request (HTTP 403).' });
      }
      expect((await w.carol.client.call('get_session_status')).json).toMatchObject({ handla: { blocked: false } });
      expect((await w.carol.client.call('handla_search_products', { store: 'HS-1001', query: 'mjölk' })).isError).toBe(false);
    } finally { await w.close(); }
  });

  it('after keeper.beginClosing (graceful shutdown) Handla calls are refused as restarting, before any request', async () => {
    const w = await startToolTest();
    try {
      appKeeper(w.t.app).beginClosing();
      const r = await w.carol.client.call('handla_search_products', { store: 'HS-1001', query: 'mjölk' });
      expect(r).toMatchObject({ isError: true, text: 'ica-hub is restarting; try again in a moment.' });
      expect(w.fake.seen.handlaRequests).toHaveLength(0);
    } finally { await w.close(); }
  });

  it('a cancelled MCP request: the queued Handla call is dropped as `cancelled`, nothing is sent, the log says so', async () => {
    const handlers = new Map<string, (args: unknown, ctx: unknown) => Promise<CallToolResult>>();
    const server = { registerTool: (name: string, _c: unknown, h: (args: unknown, ctx: unknown) => Promise<CallToolResult>) => { handlers.set(name, h); } } as unknown as McpServer;
    const logged: Record<string, unknown>[] = [];
    const log = { info: (o: object) => { logged.push(o as Record<string, unknown>); }, warn: () => undefined, error: () => undefined };
    registerHandlaTools(server, { config: s.t.config, db: s.t.db, keeper: appKeeper(s.t.app), log } as never);
    const before = s.fake.seen.handlaRequests.length;
    const c = new AbortController();
    c.abort();
    const r = await handlers.get('handla_search_products')!({ store: 'HS-1001', query: 'kvarg', limit: 10 }, { http: { authInfo: { extra: { userId: s.carol.id } } }, mcpReq: { signal: c.signal } });
    expect(r).toMatchObject({ isError: true, content: [{ type: 'text', text: 'The request was cancelled before ICA answered.' }] });
    expect(s.fake.seen.handlaRequests).toHaveLength(before);
    expect(logged.at(-1)).toMatchObject({ tool: 'handla_search_products', status: 'IcaUnavailable', reason: 'cancelled' });
  });
});

describe('Handla tools: AWS WAF stop', () => {
  it('a WAF challenge: one request, the bot-protection text (no HTTP 202), reason blocked logged, breaker in session status', async () => {
    const w = await startToolTest({ icaRateLimit: { capacity: 3, refillPerSecond: 0.001 } });
    try {
      w.fake.opts.handlaWaf = 'challenge';
      const r = await w.carol.client.call('handla_search_products', { store: 'HS-1001', query: 'mjölk' });
      expect(r).toMatchObject({ isError: true, text: "Handla's bot protection is blocking price lookups for a while (too many searches in a short time). Try again in about 10 minutes. ICA lists, offers and bonus are not affected." });
      expect(r.text).not.toContain('202');
      expect(r.text).not.toContain('HTTP');
      expect(w.fake.seen.handlaRequests).toHaveLength(1);
      const lines = w.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines.find((l) => l.msg === 'tool call' && l.tool === 'handla_search_products')).toMatchObject({ status: 'IcaUnavailable', reason: 'blocked', httpStatus: 202 });
      expect(lines.filter((l) => l.handla !== undefined)).toEqual([expect.objectContaining({ level: 40, handla: 'blocked', cooldownMinutes: 10 })]);

      // While open: no request reaches Handla (store search too) and no budget token is spent (capacity 3, 1 used).
      w.fake.opts.handlaWaf = undefined;
      for (let i = 0; i < 5; i += 1) {
        const again = await w.carol.client.call(i % 2 ? 'handla_find_stores' : 'handla_search_products', i % 2 ? { zip: '12345' } : { store: 'HS-1001', query: 'mjölk' });
        expect(again.text).toContain("Handla's bot protection");
      }
      expect(w.fake.seen.handlaRequests).toHaveLength(1);
      const status = await w.carol.client.call('get_session_status');
      expect(status.json).toMatchObject({ linked: false, handla: { blocked: true, retryInMinutes: 10 } });
      // get_session_status spends nothing for an unlinked user; two tokens are left for ICA calls.
      expect((await w.alice.client.call('get_session_status')).json).toMatchObject({ linked: true, handla: { blocked: true } });
    } finally { await w.close(); }
  });

  it('while the breaker is open a cached answer is still served (spending a token, no request); an uncached one is refused (spending none)', async () => {
    const w = await startToolTest({ icaRateLimit: { capacity: 4, refillPerSecond: 0.001 } });
    try {
      expect((await w.carol.client.call('handla_search_products', { store: 'HS-1001', query: 'mjölk' })).isError).toBe(false); // token 1, cached
      expect((await w.carol.client.call('handla_find_stores', { zip: '12345' })).isError).toBe(false); // token 2, cached
      w.fake.opts.handlaWaf = 'challenge';
      expect((await w.carol.client.call('handla_search_products', { store: 'HS-1001', query: 'ost' })).text).toContain("Handla's bot protection"); // token 3, trips
      expect(w.fake.seen.handlaRequests).toHaveLength(3);
      w.fake.opts.handlaWaf = undefined;
      // Uncached: refused before any request and before the budget (tried three times; only one token is left).
      for (let i = 0; i < 3; i += 1) expect((await w.carol.client.call('handla_search_products', { store: 'HS-1001', query: 'ost' })).text).toContain("Handla's bot protection");
      // Cached: answered from the cache while blocked, spending the last token.
      const hit = await w.carol.client.call('handla_search_products', { store: 'HS-1001', query: 'Mjölk' });
      expect(hit.isError).toBe(false);
      expect((hit.json as { products: unknown[] }).products).toHaveLength(2);
      expect(w.fake.seen.handlaRequests).toHaveLength(3);
      // The budget is now used up: even a cached answer is refused by the per-user limit.
      expect((await w.carol.client.call('handla_find_stores', { zip: '12345' })).text).toMatch(/Try again in \d+ s/);
    } finally { await w.close(); }
  });

  it('a CloudFront 403 block is the same stop, not "refused the credential"', async () => {
    const w = await startToolTest();
    try {
      w.fake.opts.handlaWaf = 'block';
      const r = await w.alice.client.call('handla_find_stores', { zip: '12345' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Handla's bot protection is blocking price lookups");
      expect(r.text).not.toContain('403');
    } finally { await w.close(); }
  });

  it('session status reports Handla as not blocked normally', async () => {
    expect((await s.carol.client.call('get_session_status')).json).toMatchObject({ handla: { blocked: false } });
  });
});

describe('Handla tools rate limit', () => {
  it('handla_find_stores spends one per-user ICA budget token, even without a linked ICA account', async () => {
    const tight = await startToolTest({ icaRateLimit: { capacity: 1, refillPerSecond: 0.001 } });
    try {
      expect((await tight.carol.client.call('handla_find_stores', { zip: '123 45' })).isError).toBe(false);
      const r = await tight.carol.client.call('handla_find_stores', { zip: '123 45' });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Try again in \d+ s/);
      expect(tight.fake.seen.handlaRequests).toHaveLength(1);
    } finally { await tight.close(); }
  });

  it('handla_search_products spends one per-user ICA budget token, even without a linked ICA account', async () => {
    const tight = await startToolTest({ icaRateLimit: { capacity: 1, refillPerSecond: 0.001 } });
    try {
      expect((await tight.carol.client.call('handla_search_products', { store: 'HS-1001', query: 'mjölk' })).isError).toBe(false);
      const r = await tight.carol.client.call('handla_search_products', { store: 'HS-1001', query: 'mjölk' });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Try again in \d+ s/);
      expect(tight.fake.seen.handlaRequests).toHaveLength(1);
    } finally { await tight.close(); }
  });
});
