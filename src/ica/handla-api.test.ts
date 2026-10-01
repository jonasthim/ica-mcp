import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHandlaApi } from './handla-api.js';
import { FAKE_HANDLA_ROUTES, startFakeIca, type FakeIca } from './test-fakes.js';

let fake: FakeIca;
beforeEach(async () => { fake = await startFakeIca({ pendingPolls: 0, routes: FAKE_HANDLA_ROUTES }); });
afterEach(async () => { await fake.close(); });
const api = () => createHandlaApi({ endpoints: fake.endpoints });

describe('Handla public API', () => {
  it('finds stores by zip, anonymously', async () => {
    const r = await api().stores('12345');
    expect(r.forHomeDelivery.map((st) => [st.accountId, st.name])).toEqual([['HS-1001', 'ICA Kvantum Testköping'], ['HS-1002', 'ICA Nära Fakeby']]);
    expect(r.forPickupDelivery.map((st) => st.accountId)).toEqual(['HS-1001']);
    expect(fake.seen.handlaRequests[0]).toMatchObject({ path: '/api/store/v1', auth: null, cookie: null });
  });

  it('searches a store\'s products with prices, with the store page as referer and no credentials', async () => {
    const products = await api().search('HS-1001', 'mjölk');
    expect(products.map((p) => [p.productId, p.name, p.price?.amount])).toEqual([['p-1', 'Mellanmjölk 1,5%', '15.90'], ['p-2', 'Laktosfri mjölk', '19.50']]);
    expect(fake.seen.handlaRequests[0]).toMatchObject({ auth: null, cookie: null, referer: `${fake.endpoints.handla}/stores/HS-1001/` });
  });

  it('retries a 202 once, then gives up as unavailable: not ready yet, not a server error', async () => {
    fake.opts.handlaPending = 1;
    expect(await api().search('HS-1001', 'mjölk')).toHaveLength(2);
    fake.opts.handlaPending = 2;
    const e = await api().search('HS-1001', 'mjölk').catch((err: unknown) => err);
    expect(e).toMatchObject({ name: 'IcaUnavailable', reason: 'not-ready' });
    expect((e as { status?: number }).status).toBeUndefined();
  });

  it('an unknown store is IcaRejected 404', async () => {
    await expect(api().search('HS-NOPE', 'mjölk')).rejects.toMatchObject({ name: 'IcaRejected', status: 404 });
  });

  it('a store id with path segments stays one encoded path segment, never escaping to another path', async () => {
    await expect(api().search('../../x', 'mjölk')).rejects.toMatchObject({ name: 'IcaRejected', status: 404 });
    expect(fake.seen.handlaRequests).toEqual([{ path: '/stores/..%2F..%2Fx/api/webproductpagews/v6/product-pages/search', auth: null, cookie: null, referer: `${fake.endpoints.handla}/stores/..%2F..%2Fx/` }]);
  });
});
