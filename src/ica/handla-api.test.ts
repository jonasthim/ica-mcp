import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IcaEndpoints } from './endpoints.js';
import { createHandlaApi, isWafStop } from './handla-api.js';
import { createHandlaGuard, type HandlaGuard } from './handla-guard.js';
import type { Fetcher } from './gateway.js';
import { FAKE_HANDLA_ROUTES, startFakeIca, type FakeIca } from './test-fakes.js';

let fake: FakeIca;
let guard: HandlaGuard;
beforeEach(async () => { fake = await startFakeIca({ pendingPolls: 0, routes: FAKE_HANDLA_ROUTES }); guard = createHandlaGuard({ minGapMs: 0, cacheMinutes: 0 }); });
afterEach(async () => { await fake.close(); });
/** No real waits in this suite: pending-202 cases only exercise the retry *count*, never real timing. No pacing, no cache. */
const api = () => createHandlaApi({ endpoints: fake.endpoints, guard, sleep: () => Promise.resolve() });

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

describe('Handla product search: a plain 202 (no WAF header)', () => {
  it('is retried briefly and succeeds once Handla answers', async () => {
    fake.opts.handlaPending = 2;
    expect(await api().search('HS-1001', 'mjölk')).toHaveLength(2);
    expect(fake.seen.handlaRequests).toHaveLength(3); // 1 initial + 2 retries
  });

  it('still 202 after the two retries gives up as not-ready (no HTTP status): 3 requests, never more', async () => {
    fake.opts.handlaPending = 99;
    const e = await api().search('HS-1001', 'mjölk').catch((err: unknown) => err);
    expect(e).toMatchObject({ name: 'IcaUnavailable', reason: 'not-ready' });
    expect((e as { status?: number }).status).toBeUndefined();
    expect(fake.seen.handlaRequests).toHaveLength(3);
    expect(guard.status()).toEqual({ blocked: false }); // a plain 202 is not a WAF stop
  });
});

describe('Handla: AWS WAF stops (fake server)', () => {
  it('a WAF challenge (202 + x-amzn-waf-action) is a stop at once: exactly one request, no poll, breaker open', async () => {
    fake.opts.handlaWaf = 'challenge';
    const waits: number[] = [];
    const e = await createHandlaApi({ endpoints: fake.endpoints, guard, sleep: (ms) => { waits.push(ms); return Promise.resolve(); } }).search('HS-1001', 'mjölk').catch((err: unknown) => err);
    expect(e).toMatchObject({ name: 'IcaUnavailable', reason: 'blocked', status: 202, retryAfterSeconds: 600 });
    expect(fake.seen.handlaRequests).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(guard.status()).toEqual({ blocked: true, retryInMinutes: 10 });
  });

  it('a CloudFront 403 "Request blocked" is a stop (not IcaUnauthorized)', async () => {
    fake.opts.handlaWaf = 'block';
    await expect(api().search('HS-1001', 'mjölk')).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'blocked', status: 403 });
    expect(fake.seen.handlaRequests).toHaveLength(1);
  });

  it('the store search is detected too, and shares the breaker with product search', async () => {
    fake.opts.handlaWaf = 'block';
    await expect(api().stores('12345')).rejects.toMatchObject({ reason: 'blocked' });
    fake.opts.handlaWaf = undefined;
    await expect(api().search('HS-1001', 'mjölk')).rejects.toMatchObject({ reason: 'blocked' });
    expect(fake.seen.handlaRequests).toHaveLength(1); // the second never reached Handla
  });

  it('breaker against the fake: one probe after the cooldown; stopped again doubles it, an answer closes it', async () => {
    let clock = 0;
    const g = createHandlaGuard({ minGapMs: 0, cacheMinutes: 0, now: () => clock });
    const a = createHandlaApi({ endpoints: fake.endpoints, guard: g, sleep: () => Promise.resolve() });
    fake.opts.handlaWaf = 'challenge';
    await expect(a.search('HS-1001', 'mjölk')).rejects.toMatchObject({ reason: 'blocked' });
    clock += 9 * 60_000;
    await expect(a.search('HS-1001', 'mjölk')).rejects.toMatchObject({ reason: 'blocked', retryAfterSeconds: 60 });
    expect(fake.seen.handlaRequests).toHaveLength(1);
    clock += 60_000; // cooldown over: the next call is the one probe, and it is stopped again
    await expect(a.search('HS-1001', 'mjölk')).rejects.toMatchObject({ reason: 'blocked', retryAfterSeconds: 1200 });
    expect(fake.seen.handlaRequests).toHaveLength(2);
    expect(g.status()).toEqual({ blocked: true, retryInMinutes: 20 });
    clock += 20 * 60_000;
    fake.opts.handlaWaf = undefined;
    expect(await a.search('HS-1001', 'mjölk')).toHaveLength(2);
    expect(fake.seen.handlaRequests).toHaveLength(3);
    expect(g.status()).toEqual({ blocked: false });
  });

  it('a cached answer is served while the breaker is open; an uncached query is refused; `charge` runs once per served call', async () => {
    const g = createHandlaGuard({ minGapMs: 0 });
    let charged = 0;
    const a = createHandlaApi({ endpoints: fake.endpoints, guard: g, sleep: () => Promise.resolve(), charge: () => { charged += 1; } });
    await a.search('HS-1001', 'mjölk');
    await a.stores('12345');
    fake.opts.handlaWaf = 'block';
    await expect(a.search('HS-1001', 'ost')).rejects.toMatchObject({ reason: 'blocked' });
    expect(charged).toBe(3);
    fake.opts.handlaWaf = undefined;
    await expect(a.search('HS-1001', 'ost')).rejects.toMatchObject({ reason: 'blocked' });
    await expect(a.stores('99999')).rejects.toMatchObject({ reason: 'blocked' });
    expect(charged).toBe(3); // refused by the open breaker: not charged
    expect(await a.search('HS-1001', 'MJÖLK ')).toHaveLength(2);
    expect((await a.stores('12345')).forHomeDelivery).toHaveLength(2);
    expect(charged).toBe(5);
    expect(fake.seen.handlaRequests).toHaveLength(3);
  });

  it('caches a search per (store, normalised query, max) and a store search per zip', async () => {
    const g = createHandlaGuard({ minGapMs: 0 });
    const a = createHandlaApi({ endpoints: fake.endpoints, guard: g, sleep: () => Promise.resolve() });
    await a.search('HS-1001', 'Mjölk');
    await a.search('HS-1001', '  mjölk ');
    expect(fake.seen.handlaRequests).toHaveLength(1);
    await a.search('HS-1001', 'mjölk', 5); // another max
    await a.search('HS-1002', 'mjölk').catch(() => undefined); // another store (404 here)
    expect(fake.seen.handlaRequests).toHaveLength(3);
    await a.stores('12345'); await a.stores('12345');
    expect(fake.seen.handlaRequests).toHaveLength(4);
  });
});

describe('isWafStop', () => {
  const html = '<html><body><h1>403 ERROR</h1>Request blocked.</body></html>';
  it.each([
    ['any status with x-amzn-waf-action', new Response(null, { status: 202, headers: { 'x-amzn-waf-action': 'challenge' } }), true],
    ['a 200 with x-amzn-waf-action', new Response('{}', { status: 200, headers: { 'x-amzn-waf-action': 'captcha' } }), true],
    ['403 with server: CloudFront', new Response('', { status: 403, headers: { server: 'CloudFront' } }), true],
    ['403 with x-cache: Error from cloudfront', new Response('', { status: 403, headers: { 'x-cache': 'Error from cloudfront' } }), true],
    ['403 with a small "Request blocked" body', new Response(html, { status: 403 }), true],
    ['a plain 202', new Response(null, { status: 202 }), false],
    ['a 403 from the origin (JSON)', new Response('{"error":"forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } }), false],
    ['a 403 whose large body mentions it', new Response(`${'x'.repeat(20_000)}Request blocked`, { status: 403 }), false],
    ['a 200 from CloudFront', new Response('{}', { status: 200, headers: { server: 'CloudFront' } }), false],
  ])('%s → %s', async (_name, r, expected) => {
    expect(await isWafStop(r)).toBe(expected);
  });
});

/** Precise control over each answer's status and headers, for the Retry-After and mid-poll-failure cases the fake server can't drive. */
describe('Handla product search: retry timing (mocked fetcher)', () => {
  const endpoints: IcaEndpoints = { ims: 'https://ims.example.com', web: 'https://www.example.com', gateway: 'https://gw.example.com', handla: 'https://handla.example.com', handlaStores: 'https://handla.example.com' };
  const okBody = JSON.stringify({ productGroups: [] });
  const sequence = (answers: Response[]): { fetcher: Fetcher; calls: () => number } => {
    let i = 0;
    const fetcher: Fetcher = () => Promise.resolve(answers[Math.min(i++, answers.length - 1)]!);
    return { fetcher, calls: () => i };
  };
  const make = (fetcher: Fetcher, waits: number[]) => createHandlaApi({ endpoints, fetcher, guard: createHandlaGuard({ minGapMs: 0, cacheMinutes: 0 }), sleep: (ms) => { waits.push(ms); return Promise.resolve(); } });

  it('waits 0.5 s then 1 s by default', async () => {
    const { fetcher, calls } = sequence([new Response(null, { status: 202 }), new Response(null, { status: 202 }), new Response(null, { status: 202 })]);
    const waits: number[] = [];
    await expect(make(fetcher, waits).search('HS-1001', 'mjölk')).rejects.toMatchObject({ reason: 'not-ready' });
    expect(waits).toEqual([500, 1000]);
    expect(calls()).toBe(3);
  });

  it('honours Retry-After (seconds), capped at 2 s', async () => {
    const { fetcher, calls } = sequence([
      new Response(null, { status: 202, headers: { 'retry-after': '10' } }), // asks for 10 s; capped to 2 s
      new Response(null, { status: 202, headers: { 'retry-after': '1' } }), // under the cap, honoured as-is
      new Response(okBody, { status: 200 }),
    ]);
    const waits: number[] = [];
    expect(await make(fetcher, waits).search('HS-1001', 'mjölk')).toEqual([]);
    expect(waits).toEqual([2000, 1000]);
    expect(calls()).toBe(3);
  });

  it('a WAF challenge on a retry stops at once', async () => {
    const { fetcher, calls } = sequence([new Response(null, { status: 202 }), new Response(null, { status: 202, headers: { 'x-amzn-waf-action': 'challenge' } })]);
    const waits: number[] = [];
    await expect(make(fetcher, waits).search('HS-1001', 'mjölk')).rejects.toMatchObject({ reason: 'blocked' });
    expect(calls()).toBe(2);
    expect(waits).toEqual([500]);
  });

  it('a 500 mid-retry surfaces as server-error immediately, with no further retry', async () => {
    const { fetcher, calls } = sequence([new Response(null, { status: 202 }), new Response('boom', { status: 503 })]);
    const waits: number[] = [];
    await expect(make(fetcher, waits).search('HS-1001', 'mjölk')).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'server-error', status: 503 });
    expect(calls()).toBe(2);
    expect(waits).toEqual([500]);
  });

  it('a non-WAF 403 is still IcaUnauthorized-shaped as before (origin refusal)', async () => {
    const { fetcher } = sequence([new Response('{"error":"x"}', { status: 403, headers: { 'content-type': 'application/json' } })]);
    await expect(make(fetcher, []).search('HS-1001', 'mjölk')).rejects.toMatchObject({ name: 'IcaUnauthorized', status: 403 });
  });
});

describe('Handla pacing (mocked fetcher, fake timers)', () => {
  const endpoints: IcaEndpoints = { ims: 'https://ims.example.com', web: 'https://www.example.com', gateway: 'https://gw.example.com', handla: 'https://handla.example.com', handlaStores: 'https://handla.example.com' };
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('5 concurrent searches start at least 2.5 s apart, plain-202 retries included', async () => {
    const starts: number[] = [];
    let n = 0;
    const fetcher: Fetcher = () => {
      starts.push(Date.now());
      n += 1;
      return Promise.resolve(n === 1 ? new Response(null, { status: 202 }) : new Response(JSON.stringify({ productGroups: [] }), { status: 200 }));
    };
    const a = createHandlaApi({ endpoints, fetcher, guard: createHandlaGuard({ minGapMs: 2500, cacheMinutes: 0 }) }); // real (faked) sleeps
    const all = Promise.all(['a', 'b', 'c', 'd', 'e'].map((q) => a.search('HS-1001', q)));
    await vi.advanceTimersByTimeAsync(30_000);
    await all;
    expect(starts).toHaveLength(6); // 5 searches + 1 retry of the first
    for (let i = 1; i < starts.length; i += 1) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(2500);
  });

  it('the queue is bounded at 10 waiting: the next search fails fast as queue-full', async () => {
    let sent = 0;
    const fetcher: Fetcher = () => { sent += 1; return Promise.resolve(new Response(JSON.stringify({ productGroups: [] }), { status: 200 })); };
    const g = createHandlaGuard({ minGapMs: 2500, cacheMinutes: 0 });
    const a = createHandlaApi({ endpoints, fetcher, guard: g });
    const accepted = Array.from({ length: 11 }, (_, i) => a.search('HS-1001', `q${i}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(g.queued()).toBe(10);
    await expect(a.search('HS-1001', 'one too many')).rejects.toMatchObject({ reason: 'queue-full' });
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(accepted);
    expect(sent).toBe(11);
  });
});
