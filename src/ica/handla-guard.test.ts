import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IcaRejected, IcaUnavailable } from './errors.js';
import { createHandlaGuard, type HandlaGuardOptions } from './handla-guard.js';

const MIN = 60_000;
let logs: object[];
beforeEach(() => { vi.useFakeTimers(); logs = []; });
afterEach(() => { vi.useRealTimers(); });
const guard = (o: HandlaGuardOptions = {}) => createHandlaGuard({ minGapMs: 0, log: { warn: (obj) => { logs.push(obj); } }, ...o });
const stop = (): Promise<never> => Promise.reject(new IcaUnavailable('blocked', 202));
const fine = (): Promise<string> => Promise.resolve('ok');
const err = async (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

describe('Handla circuit breaker', () => {
  it('a WAF stop opens it for the base cooldown; while open every call fails at once, without sending', async () => {
    const g = guard();
    const e = await err(g.request(stop));
    expect(e).toMatchObject({ name: 'IcaUnavailable', reason: 'blocked', status: 202, retryAfterSeconds: 600 });
    expect(logs).toEqual([{ handla: 'blocked', cooldownMinutes: 10 }]);
    expect(g.status()).toEqual({ blocked: true, retryInMinutes: 10 });
    expect(() => { g.assertAvailable(); }).toThrow(IcaUnavailable);
    const send = vi.fn(fine);
    vi.advanceTimersByTime(4 * MIN);
    expect(await err(g.request(send))).toMatchObject({ reason: 'blocked', retryAfterSeconds: 360 });
    expect(send).not.toHaveBeenCalled();
    expect(g.status()).toEqual({ blocked: true, retryInMinutes: 6 });
  });

  it('after the cooldown exactly one probe goes through; a success closes the breaker and resets the cooldown', async () => {
    const g = guard();
    await err(g.request(stop));
    vi.advanceTimersByTime(10 * MIN);
    expect(() => { g.assertAvailable(); }).not.toThrow();
    let release!: (v: string) => void;
    const probe = vi.fn(() => new Promise<string>((r) => { release = r; }));
    const p1 = g.request(probe);
    const second = vi.fn(fine);
    await vi.advanceTimersByTimeAsync(0);
    expect(await err(g.request(second))).toMatchObject({ reason: 'blocked' }); // the probe is in flight: nobody else goes
    expect(() => { g.assertAvailable(); }).toThrow(IcaUnavailable);
    expect(second).not.toHaveBeenCalled();
    release('ok');
    expect(await p1).toBe('ok');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(g.status()).toEqual({ blocked: false });
    expect(await g.request(second)).toBe('ok');
    expect(logs).toEqual([{ handla: 'blocked', cooldownMinutes: 10 }, { handla: 'probe', cooldownMinutes: 10 }, { handla: 'recovered', cooldownMinutes: 10 }]);
    // Reset: the next stop opens for the base cooldown again, not a doubled one.
    await err(g.request(stop));
    expect(g.status()).toEqual({ blocked: true, retryInMinutes: 10 });
  });

  it('a probe that is stopped again reopens with a doubled cooldown, capped at the maximum', async () => {
    const g = guard();
    await err(g.request(stop));
    const seen: number[] = [];
    for (const expected of [20, 40, 60, 60]) {
      vi.advanceTimersByTime(g.status().retryInMinutes! * MIN);
      const e = await err(g.request(stop));
      expect(e).toMatchObject({ reason: 'blocked', retryAfterSeconds: expected * 60 });
      seen.push(g.status().retryInMinutes!);
    }
    expect(seen).toEqual([20, 40, 60, 60]);
    expect(logs.filter((l) => (l as { handla: string }).handla === 'blocked').map((l) => (l as { cooldownMinutes: number }).cooldownMinutes)).toEqual([10, 20, 40, 60, 60]);
  });

  it('the base and maximum cooldown are configurable', async () => {
    const g = guard({ cooldownMinutes: 3, maxCooldownMinutes: 5 });
    await err(g.request(stop));
    expect(g.status()).toEqual({ blocked: true, retryInMinutes: 3 });
    vi.advanceTimersByTime(3 * MIN);
    await err(g.request(stop));
    expect(g.status()).toEqual({ blocked: true, retryInMinutes: 5 });
  });

  it('a probe that gets any other HTTP answer (here a 404) proves the WAF lets us through: closed', async () => {
    const g = guard();
    await err(g.request(stop));
    vi.advanceTimersByTime(10 * MIN);
    expect(await err(g.request(() => Promise.reject(new IcaRejected(404))))).toBeInstanceOf(IcaRejected);
    expect(g.status()).toEqual({ blocked: false });
  });

  it('a probe that never got an answer (network, timeout) is inconclusive: the next call probes again', async () => {
    const g = guard();
    await err(g.request(stop));
    vi.advanceTimersByTime(10 * MIN);
    expect(await err(g.request(() => Promise.reject(new IcaUnavailable('timeout'))))).toMatchObject({ reason: 'timeout' });
    expect(g.status()).toEqual({ blocked: false }); // still half-open: not refusing, the next call is the probe
    expect(logs.at(-1)).toEqual({ handla: 'probe', cooldownMinutes: 10 });
    expect(await g.request(fine)).toBe('ok');
    expect(g.status()).toEqual({ blocked: false });
  });

  it('other errors never open it', async () => {
    const g = guard();
    for (const e of [new IcaUnavailable('server-error', 503), new IcaUnavailable('not-ready'), new IcaRejected(404), new IcaUnavailable('rate-limited', 429)]) await err(g.request(() => Promise.reject(e)));
    expect(g.status()).toEqual({ blocked: false });
    expect(logs).toEqual([]);
  });
});

describe('Handla pacing', () => {
  it('spaces concurrent requests at least the minimum gap apart (start to start)', async () => {
    const g = guard({ minGapMs: 2500 });
    const starts: number[] = [];
    const t0 = Date.now();
    const all = Promise.all([1, 2, 3, 4, 5].map(() => g.request(() => { starts.push(Date.now() - t0); return fine(); })));
    await vi.advanceTimersByTimeAsync(20_000);
    await all;
    expect(starts).toHaveLength(5);
    for (let i = 1; i < starts.length; i += 1) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(2500);
    expect(starts[0]).toBe(0);
  });

  it('a request after a quiet spell goes at once', async () => {
    const g = guard({ minGapMs: 2500 });
    await g.request(fine);
    vi.advanceTimersByTime(3000);
    const send = vi.fn(fine);
    const p = g.request(send);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    await p;
  });

  it('bounds the queue: past 10 waiting, a call fails fast as queue-full without sending', async () => {
    const g = guard({ minGapMs: 2500 });
    const sends: number[] = [];
    const accepted = Array.from({ length: 11 }, (_, i) => g.request(() => { sends.push(i); return fine(); })); // 1 goes now, 10 wait
    expect(g.queued()).toBe(10);
    const extra = vi.fn(fine);
    expect(await err(g.request(extra))).toMatchObject({ name: 'IcaUnavailable', reason: 'queue-full' });
    expect(extra).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(11 * 2500);
    await Promise.all(accepted);
    expect(sends).toHaveLength(11);
  });

  it('drops a queued call whose caller gave up, before it is sent', async () => {
    const g = guard({ minGapMs: 2500 });
    await g.request(fine);
    const c = new AbortController();
    const send = vi.fn(fine);
    const p = err(g.request(send, c.signal));
    expect(g.queued()).toBe(1);
    c.abort(new DOMException('gone', 'AbortError'));
    expect(await p).toMatchObject({ name: 'IcaUnavailable', reason: 'network' });
    expect(g.queued()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).not.toHaveBeenCalled();
  });

  it('a call queued behind a WAF stop is not sent: the breaker is checked again when its turn comes', async () => {
    const g = guard({ minGapMs: 2500 });
    const first = err(g.request(stop));
    const send = vi.fn(fine);
    const second = err(g.request(send));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await first).toMatchObject({ reason: 'blocked' });
    expect(await second).toMatchObject({ reason: 'blocked' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('Handla cache', () => {
  it('a hit does not load again; a miss after the TTL does', async () => {
    const g = guard({ cacheMinutes: 15 });
    const load = vi.fn(() => Promise.resolve(['p']));
    expect(await g.cached('search', 'k', load)).toEqual(['p']);
    vi.advanceTimersByTime(15 * MIN - 1);
    expect(await g.cached('search', 'k', load)).toEqual(['p']);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await g.cached('search', 'k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('store search is kept for 24 h', async () => {
    const g = guard();
    const load = vi.fn(() => Promise.resolve({ stores: 1 }));
    await g.cached('stores', '12345', load);
    vi.advanceTimersByTime(24 * 60 * MIN - 1);
    await g.cached('stores', '12345', load);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await g.cached('stores', '12345', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a failure is not cached', async () => {
    const g = guard();
    await err(g.cached('search', 'k', () => Promise.reject(new IcaUnavailable('not-ready'))));
    const load = vi.fn(() => Promise.resolve(1));
    expect(await g.cached('search', 'k', load)).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('is an LRU capped at its size: the least recently used entry goes first', async () => {
    const g = guard({ cacheMax: 3 });
    for (const k of ['a', 'b', 'c']) await g.cached('search', k, () => Promise.resolve(k));
    await g.cached('search', 'a', () => Promise.resolve('reloaded')); // touch a: b is now the oldest
    await g.cached('search', 'd', () => Promise.resolve('d'));
    expect(g.cacheSize()).toBe(3);
    const loadB = vi.fn(() => Promise.resolve('b2'));
    expect(await g.cached('search', 'b', loadB)).toBe('b2');
    expect(await g.cached('search', 'a', () => Promise.resolve('nope'))).toBe('a');
  });

  it('caps at 500 entries by default', async () => {
    const g = guard();
    for (let i = 0; i < 600; i += 1) await g.cached('search', `k${i}`, () => Promise.resolve(i));
    expect(g.cacheSize()).toBe(500);
  });

  it('cacheMinutes 0 turns the cache off', async () => {
    const g = guard({ cacheMinutes: 0 });
    const load = vi.fn(() => Promise.resolve(1));
    await g.cached('search', 'k', load);
    await g.cached('stores', 'k', load);
    await g.cached('search', 'k', load);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
