import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_SECRETS } from '../../ica/test-fakes.js';
import { startToolTest, type ToolTest } from '../../test-helpers.js';

let s: ToolTest;
beforeAll(async () => { s = await startToolTest(); });
afterAll(async () => { await s.close(); });

describe('Handla tools', () => {
  it('finds Handla stores by zip, marking delivery and pickup, without addresses; no ICA account needed', async () => {
    const r = await s.carol.client.call('handla_find_stores', { zip: '123 45' });
    expect(r.json).toEqual({ zip: '12345', stores: [
      { id: 'HS-1001', name: 'ICA Kvantum Testköping', city: 'Testköping', delivery: true, pickup: true },
      { id: 'HS-1002', name: 'ICA Nära Fakeby', city: 'Fakeby', delivery: true, pickup: false },
    ] });
    expect(r.text).not.toContain(FAKE_SECRETS.street);
  });

  it('searches a store\'s online prices', async () => {
    const r = await s.alice.client.call('handla_search_products', { store: 'HS-1001', query: 'mjölk', limit: 5 });
    expect(r.json).toEqual({ store: 'HS-1001', query: 'mjölk', products: [
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

  it('Handla still preparing after the retry: says so and to try again, never an HTTP status', async () => {
    s.fake.opts.handlaPending = 2;
    try {
      const r = await s.alice.client.call('handla_search_products', { store: 'HS-1001', query: 'mjölk' });
      expect(r).toMatchObject({ isError: true, text: 'Handla is still preparing results; try again in a moment.' });
    } finally { s.fake.opts.handlaPending = 0; }
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
