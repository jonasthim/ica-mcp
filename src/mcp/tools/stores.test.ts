import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../../db/index.js';
import { FAKE_OFFERS, FAKE_SECRETS, fakeStore } from '../../ica/test-fakes.js';
import { startToolTest, type ToolTest } from '../../test-helpers.js';

let s: ToolTest;
beforeAll(async () => { s = await startToolTest(); });
afterAll(async () => { await s.close(); });
type Offers = { store: { id: number; name: string }; total: number; shown: number; offers: Record<string, unknown>[] };

/** Every key anywhere in a JSON value (object keys only; array indices are not names). */
const keysOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : [];

describe('get_favorite_stores', () => {
  it('names, cities, today\'s hours and ids; the first is the default; no address, phone or email', async () => {
    const r = await s.alice.client.call('get_favorite_stores');
    expect(r.json).toEqual({ stores: [
      { id: 12345, name: 'ICA Nära Fakeby', city: 'Fakeby', openToday: '08–22', default: true },
      { id: 67890, name: 'ICA Kvantum Testköping', city: 'Testköping', openToday: '07–23' },
    ] });
    for (const v of [FAKE_SECRETS.street, '08-000 00 00', 'butik@example.se']) expect(r.text).not.toContain(v);
  });
});

describe('get_store_offers', () => {
  it('defaults to the first favourite, filters by a Swedish word, no image URLs unless asked', async () => {
    const o = (await s.alice.client.call('get_store_offers', { query: 'kyckling' })).json as Offers;
    expect(o.store).toEqual({ id: 12345, name: 'ICA Nära Fakeby' });
    expect([o.total, o.shown]).toEqual([2, 2]);
    expect(o.offers[0]).toEqual({ id: 'OF-1', name: 'Kycklingfilé', brand: 'Kronfågel', deal: '99 kr/st', package: '900 g', compare: 'Jfr-pris 110 kr/kg', limit: 'Max 2 köp/hushåll', validTo: '2026-10-04', stammis: true });
    expect(o.offers[1]).toMatchObject({ id: 'OF-3', personal: true });
    expect(JSON.stringify(o)).not.toContain('images.example');
    const withImages = (await s.alice.client.call('get_store_offers', { query: 'kyckling', includeImages: true })).json as Offers;
    expect(withImages.offers[0]).toMatchObject({ image: 'https://images.example/OF-1.jpg' });
  });

  it('caps the list at `limit` but reports the total, and marks online-only offers', async () => {
    const o = (await s.alice.client.call('get_store_offers', { limit: 1 })).json as Offers;
    expect([o.total, o.shown, o.offers.length]).toEqual([4, 1, 1]);
    const all = (await s.alice.client.call('get_store_offers', {})).json as Offers;
    expect(all.offers.find((x) => x.id === 'OF-4')).toMatchObject({ onlineOnly: true });
  });

  it('matches the query against the offer category too', async () => {
    const o = (await s.alice.client.call('get_store_offers', { query: 'mejeri' })).json as Offers;
    expect(o.offers.map((x) => x.id)).toEqual(['OF-4']);
  });

  it('finds a favourite store by part of its name, and asks when the name fits several', async () => {
    expect(((await s.alice.client.call('get_store_offers', { store: 'kvantum' })).json as Offers).store).toEqual({ id: 67890, name: 'ICA Kvantum Testköping' });
    const r = await s.alice.client.call('get_store_offers', { store: 'ica' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('ICA Nära Fakeby');
    expect(r.text).toContain('ICA Kvantum Testköping');
  });

  it('takes a store id, and says which favourites exist when nothing matches', async () => {
    expect(((await s.alice.client.call('get_store_offers', { store: '67890' })).json as Offers).store).toEqual({ id: 67890, name: 'ICA Kvantum Testköping' });
    const r = await s.alice.client.call('get_store_offers', { store: 'coop' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('No favourite store matches "coop"');
    expect(r.text).toContain('ICA Nära Fakeby (id 12345)');
  });

  it('an unknown store id is an input error that points at get_favorite_stores', async () => {
    const r = await s.alice.client.call('get_store_offers', { store: '99999' });
    expect(r.isError).toBe(true);
    expect(r.text).toBe('No ICA store with id 99999. Use get_favorite_stores to see your stores.');
  });

  it('without a condition, the deal text comes from the mechanic and keeps a multibuy count', async () => {
    const base = FAKE_OFFERS[0]!;
    const noCond = (id: string, parsedMechanics: Record<string, unknown>) => ({ ...base, id, condition: null, parsedMechanics });
    const routes = s.fake.opts.routes;
    s.fake.opts.routes = {
      ...routes,
      '/sverige/digx/mobile/storeservice/v1/stores/55555': { status: 200, body: fakeStore(55555, 'ICA Mekanik', 'Mekby', '08–20') },
      '/sverige/digx/mobile/offerservice/v1/offersdiscounts/55555': { status: 200, body: { discounts: [], offers: [
        noCond('M-MULTI', { type: 'multibuy', quantity: 2, unitSign: 'st', value1: '89 kr', value2: '', value3: '', value4: '' }),
        noCond('M-SINGLE', { type: 'fixed', quantity: 1, unitSign: 'st', value1: '15 kr', value2: '', value3: '', value4: '' }),
        noCond('M-UNKNOWN', { type: 'mystery', quantity: null, unitSign: null, value1: 'Halva priset', value2: null }),
      ] } },
    };
    try {
      const o = (await s.alice.client.call('get_store_offers', { store: '55555' })).json as Offers;
      expect(o.offers.map((x) => [x.id, x.deal])).toEqual([['M-MULTI', '2 st för 89 kr'], ['M-SINGLE', '15 kr'], ['M-UNKNOWN', 'Halva priset']]);
    } finally { s.fake.opts.routes = routes; }
  });

  it('uses the household default store when one is set', async () => {
    s.t.db.insert(schema.household).values({ id: 1, defaultStoreId: 67890, updatedAt: new Date().toISOString() }).run();
    try {
      expect(((await s.alice.client.call('get_store_offers', {})).json as Offers).store.id).toBe(67890);
      const fav = (await s.alice.client.call('get_favorite_stores')).json as { stores: { id: number; default?: true }[] };
      expect(fav.stores.filter((x) => x.default).map((x) => x.id)).toEqual([67890]);
    } finally { s.t.db.delete(schema.household).run(); }
  });
});

describe('get_bonus', () => {
  it('summarises level, points to the next voucher, voucher values and days left; no card number', async () => {
    const r = await s.alice.client.call('get_bonus');
    expect(r.json).toEqual({ title: 'Din bonus', level: 'Bonusnivå 3', pointsToNextVoucher: 812, nextVoucherValue: 75, voucherValueThisPeriod: 50, daysLeft: 2, activeVouchers: 1, savedThisYear: 1234.5, purchasesThisYear: 87 });
    expect(r.text).not.toContain('6035000011112222');
  });
});

describe('lookup_product', () => {
  it('finds a product by EAN, says not found for an unknown one, rejects a malformed one', async () => {
    expect((await s.alice.client.call('lookup_product', { ean: '7310865004703' })).json).toEqual({ found: true, ean: '7310865004703', name: 'Mellanmjölk 1,5% 1l', articleId: 222, articleGroupId: 333 });
    expect((await s.alice.client.call('lookup_product', { ean: '0000000000000' })).json).toEqual({ found: false, ean: '0000000000000' });
    expect((await s.alice.client.call('lookup_product', { ean: '123' })).isError).toBe(true);
  });
});

describe('privacy: outputs are built field by field', () => {
  const ALLOWED: Record<string, { args: Record<string, unknown>; keys: string[] }> = {
    get_favorite_stores: { args: {}, keys: ['stores', 'id', 'name', 'city', 'openToday', 'default'] },
    get_store_offers: { args: { includeImages: true, limit: 100 }, keys: ['store', 'id', 'name', 'total', 'shown', 'offers', 'brand', 'deal', 'package', 'compare', 'limit', 'validTo', 'personal', 'stammis', 'onlineOnly', 'image'] },
    get_bonus: { args: {}, keys: ['title', 'level', 'pointsToNextVoucher', 'nextVoucherValue', 'voucherValueThisPeriod', 'daysLeft', 'activeVouchers', 'savedThisYear', 'purchasesThisYear'] },
    lookup_product: { args: { ean: '7310865004703' }, keys: ['found', 'ean', 'name', 'articleId', 'articleGroupId'] },
  };
  /** Values from the fake that none of these tools may pass on: vouchers, card, contact data, and other raw ICA fields. */
  const NEVER = [
    'VCH-FAKE-1234', '6035000011112222', FAKE_SECRETS.street, '08-000 00 00', 'butik@example.se', 'ACC-FAKE', 'https://example.se', 'Apotek',
    'Mån–fre', 'Midsommarafton', 'images.example/OF-1-s.jpg', 'Kyckling (utökad)', 'Extra kaffe', 'Kvitto 2026-09-01', 'Du är Stammis', 'oktober',
  ];

  for (const [tool, { args, keys }] of Object.entries(ALLOWED)) {
    it(`${tool} returns only the brief's fields and no voucher code, card number or other raw ICA value`, async () => {
      const r = await s.alice.client.call(tool, args);
      expect(r.isError).toBeFalsy();
      expect([...new Set(keysOf(r.json))].filter((k) => !keys.includes(k))).toEqual([]);
      for (const v of NEVER) expect(r.text).not.toContain(v);
    });
  }

  it('store and offer objects carry exactly the specified fields', async () => {
    const o = (await s.alice.client.call('get_store_offers', { includeImages: true })).json as Offers;
    expect(Object.keys(o).sort()).toEqual(['offers', 'shown', 'store', 'total']);
    expect(Object.keys(o.store).sort()).toEqual(['id', 'name']);
    for (const x of o.offers) expect(Object.keys(x).every((k) => ALLOWED.get_store_offers!.keys.includes(k))).toBe(true);
  });
});

describe('startToolTest routes', () => {
  it('merges extra fake routes over FAKE_APP_ROUTES instead of replacing them', async () => {
    const extra = await startToolTest({ fake: { routes: { '/sverige/digx/mobile/productservice/v1/product/12345678': { status: 200, body: { gtin: '12345678', name: 'Extra' } } } } });
    try {
      expect((await extra.alice.client.call('lookup_product', { ean: '12345678' })).json).toEqual({ found: true, ean: '12345678', name: 'Extra' });
      expect((await extra.alice.client.call('get_bonus')).isError).toBe(false);
    } finally { await extra.close(); }
  });
});

describe('rate limit and hygiene', () => {
  it('stops a user at the per-user ICA budget with a "try again" message, without affecting others', async () => {
    const tight = await startToolTest({ icaRateLimit: { capacity: 3, refillPerSecond: 0.01 } });
    try {
      expect((await tight.alice.client.call('get_favorite_stores')).isError).toBe(false); // favourites + 2 stores = 3 calls
      const r = await tight.alice.client.call('get_bonus');
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Try again in \d+ s/);
      expect((await tight.bob.client.call('get_bonus')).isError).toBe(false);
    } finally { await tight.close(); }
  });

  it('only the app bearer reached mobile/*, and no secret was logged', () => {
    expect(s.fake.seen.gatewayCalls.filter((c) => c.includes('/mobile/')).every((c) => c.endsWith(' app'))).toBe(true);
    const all = s.logs.join('\n');
    for (const v of [...Object.values(FAKE_SECRETS), 'VCH-FAKE-1234', '6035000011112222']) expect(all).not.toContain(v);
  });
});
