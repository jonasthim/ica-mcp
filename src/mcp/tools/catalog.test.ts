import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '../../db/index.js';
import { FAKE_SECRETS } from '../../ica/test-fakes.js';
import { linkedIcaAccount } from '../../sessions/web-store.js';
import { startToolTest, type ToolTest } from '../../test-helpers.js';

let s: ToolTest;
beforeAll(async () => { s = await startToolTest(); });
afterAll(async () => { await s.close(); });

describe('search_articles', () => {
  it('searches ICA article names with the web session, Swedish query as typed', async () => {
    const r = await s.alice.client.call('search_articles', { query: 'mjölk', limit: 2 });
    expect(r.json).toEqual({ query: 'mjölk', total: 3, articles: [{ id: 1001, name: 'Mellanmjölk 1,5%', category: 'Mejeri' }, { id: 1002, name: 'Standardmjölk 3%', category: 'Mejeri' }] });
    expect(s.fake.seen.searchQueries).toContain('mjölk');
    expect(s.fake.seen.gatewayCalls.filter((c) => c.includes('shoppinglistarticlesearch')).every((c) => c.endsWith(' web'))).toBe(true);
  });

  it('a dead web session → reconnect with BankID (web), not app access', async () => {
    s.fake.opts.loginState = 0;
    try {
      const r = await s.bob.client.call('search_articles', { query: 'ost' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('"Reconnect with BankID"');
      expect(r.text).not.toContain('app access');
    } finally { s.fake.opts.loginState = 2; }
  });

  it('a query with &, ? and / round-trips intact to ICA', async () => {
    const q = 'mjölk & ost? /test';
    await s.alice.client.call('search_articles', { query: q });
    expect(s.fake.seen.searchQueries).toContain(q);
  });

  it('never logs a secret', () => {
    const all = s.logs.join('\n');
    for (const v of Object.values(FAKE_SECRETS)) expect(all).not.toContain(v);
  });
});

describe('search_articles: app access linked but no web row', () => {
  it('is NeedsWebReconnect ("Reconnect with BankID"), never the app-access text', async () => {
    const t = await startToolTest();
    try {
      const linked = linkedIcaAccount(t.t.db, t.bob.id)!;
      t.t.db.delete(schema.icaSession).where(eq(schema.icaSession.id, linked.web!.id)).run();
      const r = await t.bob.client.call('search_articles', { query: 'ost' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('"Reconnect with BankID"');
      expect(r.text).not.toContain('app access');
    } finally { await t.close(); }
  });
});

describe('privacy: search_articles output is built field by field', () => {
  /** Every key anywhere in a JSON value (object keys only; array indices are not names). */
  const keysOf = (v: unknown): string[] =>
    Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : [];
  const ALLOWED = ['query', 'total', 'articles', 'id', 'name', 'category'];

  it('returns only query/total/articles[].id/name/category, no other ICA fields', async () => {
    const r = await s.alice.client.call('search_articles', { query: 'mjölk' });
    expect(r.isError).toBeFalsy();
    expect([...new Set(keysOf(r.json))].filter((k) => !ALLOWED.includes(k))).toEqual([]);
    // Raw article-search fields a real answer carries (2.1 capture) that the tool must never pass through.
    for (const v of ['_id', 'pluralName', 'alternativeSpelling', 'productEan', 'storeArticleGroupId', 'expandedArticleGroupName', 'status', 'latestChange', 'maxiFormatCategoryId']) {
      expect(r.text).not.toContain(v);
    }
  });
});
