import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IcaEndpoints } from './endpoints.js';
import { createHandlaApi } from './handla-api.js';
import type { Fetcher } from './gateway.js';
import { FAKE_HANDLA_ROUTES, startFakeIca, type FakeIca } from './test-fakes.js';

let fake: FakeIca;
beforeEach(async () => { fake = await startFakeIca({ pendingPolls: 0, routes: FAKE_HANDLA_ROUTES }); });
afterEach(async () => { await fake.close(); });
/** No real waits in this suite: pending-202 cases only exercise the retry *count*, never real timing. */
const api = () => createHandlaApi({ endpoints: fake.endpoints, sleep: () => Promise.resolve() });

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

  it('an unknown store is IcaRejected 404', async () => {
    await expect(api().search('HS-NOPE', 'mjölk')).rejects.toMatchObject({ name: 'IcaRejected', status: 404 });
  });

  it('a store id with path segments stays one encoded path segment, never escaping to another path', async () => {
    await expect(api().search('../../x', 'mjölk')).rejects.toMatchObject({ name: 'IcaRejected', status: 404 });
    expect(fake.seen.handlaRequests).toEqual([{ path: '/stores/..%2F..%2Fx/api/webproductpagews/v6/product-pages/search', auth: null, cookie: null, referer: `${fake.endpoints.handla}/stores/..%2F..%2Fx/` }]);
  });
});

describe('Handla product search: 202 polling', () => {
  it('polls through repeated 202s and succeeds once Handla answers', async () => {
    fake.opts.handlaPending = 3;
    expect(await api().search('HS-1001', 'mjölk')).toHaveLength(2);
    expect(fake.seen.handlaRequests).toHaveLength(4); // 1 initial + 3 still-pending polls before the 4th answers 200
  });

  it('still 202 after the last poll gives up as unavailable (not-ready, no HTTP status), bounded to 6 attempts total', async () => {
    fake.opts.handlaPending = 99; // far more pending answers than the poll budget allows
    const e = await api().search('HS-1001', 'mjölk').catch((err: unknown) => err);
    expect(e).toMatchObject({ name: 'IcaUnavailable', reason: 'not-ready' });
    expect((e as { status?: number }).status).toBeUndefined();
    expect(fake.seen.handlaRequests).toHaveLength(6); // 1 initial + 5 polls, never more
  });
});

/** Precise control over each answer's status and headers, for the Retry-After and mid-poll-failure cases the fake server can't drive. */
describe('Handla product search: poll timing (mocked fetcher)', () => {
  const endpoints: IcaEndpoints = { ims: 'https://ims.example.com', web: 'https://www.example.com', gateway: 'https://gw.example.com', handla: 'https://handla.example.com', handlaStores: 'https://handla.example.com' };
  const okBody = JSON.stringify({ productGroups: [] });
  const sequence = (answers: Response[]): { fetcher: Fetcher; calls: () => number } => {
    let i = 0;
    const fetcher: Fetcher = () => Promise.resolve(answers[Math.min(i++, answers.length - 1)]!);
    return { fetcher, calls: () => i };
  };

  it('honours Retry-After (seconds) instead of the default schedule, capped at 3 s', async () => {
    const { fetcher, calls } = sequence([
      new Response(null, { status: 202, headers: { 'retry-after': '10' } }), // asks for 10 s; capped to 3 s
      new Response(null, { status: 202, headers: { 'retry-after': '1' } }), // asks for 1 s; under the cap, honoured as-is
      new Response(okBody, { status: 200 }),
    ]);
    const waits: number[] = [];
    const products = await createHandlaApi({ endpoints, fetcher, sleep: (ms) => { waits.push(ms); return Promise.resolve(); } }).search('HS-1001', 'mjölk');
    expect(products).toEqual([]);
    expect(waits).toEqual([3000, 1000]);
    expect(calls()).toBe(3);
  });

  it('falls back to the given poll schedule when there is no Retry-After', async () => {
    const { fetcher } = sequence([
      new Response(null, { status: 202 }),
      new Response(null, { status: 202 }),
      new Response(okBody, { status: 200 }),
    ]);
    const waits: number[] = [];
    const products = await createHandlaApi({ endpoints, fetcher, pollDelaysMs: [10, 20, 30], sleep: (ms) => { waits.push(ms); return Promise.resolve(); } }).search('HS-1001', 'mjölk');
    expect(products).toEqual([]);
    expect(waits).toEqual([10, 20]);
  });

  it('a 500 mid-poll surfaces as server-error immediately, with no further polling', async () => {
    const { fetcher, calls } = sequence([
      new Response(null, { status: 202 }),
      new Response('boom', { status: 503 }),
    ]);
    const waits: number[] = [];
    const api2 = createHandlaApi({ endpoints, fetcher, sleep: (ms) => { waits.push(ms); return Promise.resolve(); } });
    await expect(api2.search('HS-1001', 'mjölk')).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'server-error', status: 503 });
    expect(calls()).toBe(2);
    expect(waits).toEqual([500]); // the wait before the failing poll; none after it
  });
});
