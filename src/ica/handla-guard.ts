import { HandlaPaced, IcaUnavailable } from './errors.js';

/**
 * The process-wide guard every Handla request goes through (docs/api-notes.md → "Handla: AWS WAF"). Handla sits behind
 * CloudFront + AWS WAF with a rate rule per source IP: about 7 searches in about 15 s and every request from the IP is
 * refused for many minutes. One guard per process (the SessionKeeper owns it), because the rule is per IP, not per
 * user. It holds:
 *
 * - a circuit breaker: a WAF stop (`IcaUnavailable('blocked')`) opens it for a cooldown (base 10 min, doubled after
 *   every probe that is stopped again, up to 60 min; a base of 60 means no doubling). While open every request fails
 *   at once without contacting Handla. After the cooldown exactly one request is let through as a probe (half-open):
 *   any HTTP answer that is not a WAF stop closes the breaker and resets the cooldown; a WAF stop reopens it with the
 *   doubled cooldown; no answer at all (network, timeout, cancelled) is inconclusive and the next request probes again.
 * - pacing: one queue for the whole process. Request starts are at least `minGapMs` apart AND at most `maxPerMinute`
 *   start in any rolling 60 s. A request that would have to wait more than `maxWaitMs` for its turn fails at once
 *   with `HandlaPaced` (rate-limited, with the seconds until a slot frees); at most `maxQueued` wait. The queue wait
 *   comes before the request's 15 s timeout starts; a caller that gives up (abort signal) is dropped from the queue
 *   with `cancelled` before anything is sent. `close()` (graceful shutdown) rejects every waiter with `shutting-down`.
 * - a small in-memory LRU of successful answers (search 15 min, store search 24 h, 500 entries), plus single-flight:
 *   identical misses in flight at the same time share one load. A cached answer needs no Handla request, so it is
 *   served even while the breaker is open (createHandlaApi checks it first) and never counts toward the window.
 *
 * All times come from a monotonic clock (`performance.now()`), so a wall-clock step changes neither the cooldown, the
 * pacing nor the cache TTLs. Each breaker change is logged once at warn as `{ handla, cooldownMinutes }`; never a
 * query, zip or store id.
 */
export type HandlaGuardOptions = {
  /** First cooldown after a WAF stop (ICA_HUB_HANDLA_COOLDOWN_MINUTES, default 10). */
  cooldownMinutes?: number;
  /** The cooldown is doubled after each failed probe up to this (default 60, never below `cooldownMinutes`). */
  maxCooldownMinutes?: number;
  /** Minimum time between two Handla request starts (ICA_HUB_HANDLA_MIN_GAP_MS, default 2500). */
  minGapMs?: number;
  /** At most this many Handla request starts per rolling 60 s (ICA_HUB_HANDLA_MAX_PER_MINUTE, default 8). */
  maxPerMinute?: number;
  /** A request that would wait longer than this for its turn fails fast with HandlaPaced (default 20 000). */
  maxWaitMs?: number;
  /** At most this many requests wait in the queue (default 10); more fail fast with `queue-full`. */
  maxQueued?: number;
  /** How long a product search answer is kept (ICA_HUB_HANDLA_CACHE_MINUTES, default 15). 0 turns the whole cache off. */
  cacheMinutes?: number;
  /** How long a store search answer is kept (default 24 h). */
  storeCacheMinutes?: number;
  /** LRU size (default 500). */
  cacheMax?: number;
  /** Monotonic ms (default performance.now). Timers are the global ones, so tests use fake timers. */
  now?: () => number;
  log?: { warn: (obj: object, msg: string) => void };
};

export type HandlaStatus = { blocked: boolean; retryInMinutes?: number };
type Waiter = { resolve: () => void; reject: (e: unknown) => void; signal: AbortSignal | undefined; onAbort: () => void };

const MIN_MS = 60_000;
const WINDOW_MS = 60_000;

/** Whether an error means Handla was never heard from (so it says nothing about the WAF, and no request counted). */
export const noAnswer = (e: unknown): boolean =>
  e instanceof IcaUnavailable && (e.reason === 'network' || e.reason === 'timeout' || e.reason === 'cancelled');

export function createHandlaGuard(o: HandlaGuardOptions = {}) {
  const now = o.now ?? (() => performance.now());
  const baseMs = (o.cooldownMinutes ?? 10) * MIN_MS;
  const maxMs = Math.max(baseMs, (o.maxCooldownMinutes ?? 60) * MIN_MS);
  const gap = o.minGapMs ?? 2500;
  const perMinute = o.maxPerMinute ?? 8;
  const maxWaitMs = o.maxWaitMs ?? 20_000;
  const maxQueued = o.maxQueued ?? 10;
  const cacheMinutes = o.cacheMinutes ?? 15;
  const ttl = { search: cacheMinutes * MIN_MS, stores: (o.storeCacheMinutes ?? 24 * 60) * MIN_MS };
  const cacheOff = cacheMinutes === 0;
  const cacheMax = o.cacheMax ?? 500;
  let closed = false;

  // ---- circuit breaker ----
  let tripped = false;
  let openUntil = 0;
  let cooldownMs = baseMs;
  let probing = false;
  const logChange = (handla: 'blocked' | 'probe' | 'recovered'): void => {
    o.log?.warn({ handla, cooldownMinutes: Math.round(cooldownMs / MIN_MS) }, 'handla circuit breaker');
  };
  const remainingSeconds = (): number => Math.max(60, Math.ceil((openUntil - now()) / 1000));
  const blocked = (status?: number): IcaUnavailable => new IcaUnavailable('blocked', status, [], remainingSeconds());

  /** Throws `blocked` while the breaker is open or a probe is in flight; never claims the probe. */
  function assertAvailable(): void {
    if (closed) throw new IcaUnavailable('shutting-down');
    if (tripped && (now() < openUntil || probing)) throw blocked();
  }
  function trip(wasProbe: boolean): void {
    if (tripped && !wasProbe) return; // a request that was already in flight when the breaker opened: nothing new
    cooldownMs = wasProbe ? Math.min(cooldownMs * 2, maxMs) : baseMs;
    tripped = true;
    openUntil = now() + cooldownMs;
    logChange('blocked');
  }
  function recover(): void {
    tripped = false; openUntil = 0;
    logChange('recovered');
    cooldownMs = baseMs;
  }

  // ---- pacing: the gap between starts plus a sliding window of starts ----
  /** Recent request starts, oldest first; at most `perMinute` are kept (older ones cannot constrain anything). */
  const starts: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Waiter[] = [];
  /** The earliest time (≥ t) a request may start after the starts in `s`. */
  const earliest = (s: readonly number[], t: number): number => {
    let e = t;
    if (s.length > 0) e = Math.max(e, s[s.length - 1]! + gap);
    if (s.length >= perMinute) e = Math.max(e, s[s.length - perMinute]! + WINDOW_MS);
    return e;
  };
  const recordStart = (t: number): void => { starts.push(t); if (starts.length > perMinute) starts.shift(); };
  function pump(): void {
    if (timer !== undefined) return;
    while (queue.length > 0) {
      const t = now();
      const wait = earliest(starts, t) - t;
      if (wait > 0) { timer = setTimeout(() => { timer = undefined; pump(); }, wait); timer.unref?.(); return; }
      const w = queue.shift()!;
      w.signal?.removeEventListener('abort', w.onAbort);
      recordStart(t);
      w.resolve();
    }
  }
  /** How long from now the next request to join the queue would wait for its start. */
  function projectedWait(t: number): number {
    const sim = [...starts];
    let s = t;
    for (let i = 0; i <= queue.length; i += 1) { s = earliest(sim, t); sim.push(s); }
    return s - t;
  }
  function slot(signal: AbortSignal | undefined): Promise<void> {
    if (closed) return Promise.reject(new IcaUnavailable('shutting-down'));
    if (signal?.aborted) return Promise.reject(new IcaUnavailable('cancelled'));
    const t = now();
    const wait = projectedWait(t);
    if (wait <= 0 && queue.length === 0 && timer === undefined) { recordStart(t); return Promise.resolve(); }
    if (wait > maxWaitMs) return Promise.reject(new HandlaPaced(Math.ceil(wait / 1000), perMinute, cacheMinutes));
    if (queue.length >= maxQueued) return Promise.reject(new IcaUnavailable('queue-full'));
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        resolve, reject, signal,
        onAbort: () => {
          const i = queue.indexOf(w);
          if (i >= 0) queue.splice(i, 1);
          reject(new IcaUnavailable('cancelled'));
        },
      };
      signal?.addEventListener('abort', w.onAbort, { once: true });
      queue.push(w);
      pump();
    });
  }

  /**
   * Send one Handla request: breaker check, wait for a pacing slot, breaker check again (it may have opened while
   * waiting; after a cooldown this request may become the one probe), send, and feed the outcome to the breaker.
   * `onSend` runs right before `send`, i.e. only when a request really goes to Handla.
   */
  async function request<T>(send: () => Promise<T>, signal?: AbortSignal, onSend?: () => void): Promise<T> {
    assertAvailable();
    await slot(signal);
    let probe = false;
    if (tripped) {
      assertAvailable();
      probing = true; probe = true;
      logChange('probe');
    }
    try {
      onSend?.();
      const out = await send();
      if (probe) recover();
      return out;
    } catch (e) {
      if (e instanceof IcaUnavailable && e.reason === 'blocked') { trip(probe); throw blocked(e.status); }
      if (probe && !noAnswer(e)) recover(); // Handla answered something other than a WAF stop: the IP is let through
      throw e;
    } finally {
      if (probe) probing = false;
    }
  }

  // ---- cache (a Map keeps insertion order: re-inserting on a hit makes it an LRU) ----
  const cache = new Map<string, { value: unknown; until: number }>();
  const inflight = new Map<string, Promise<unknown>>();
  /** A fresh cached answer (marked as most recently used), or undefined. Never contacts Handla, so it ignores the breaker. */
  function peek<T>(kind: 'search' | 'stores', key: string): { value: T } | undefined {
    if (cacheOff) return undefined;
    const k = `${kind}\n${key}`;
    const hit = cache.get(k);
    if (!hit) return undefined;
    cache.delete(k);
    if (hit.until <= now()) return undefined;
    cache.set(k, hit);
    return { value: hit.value as T };
  }
  /**
   * The cached answer, or the answer of an identical load already in flight, or `load()` (cached on success). A
   * joined load that ends `cancelled` (its first caller gave up) is not this caller's cancellation: it loads itself.
   */
  async function cached<T>(kind: 'search' | 'stores', key: string, load: () => Promise<T>): Promise<T> {
    const k = `${kind}\n${key}`;
    const hit = peek<T>(kind, key);
    if (hit) return hit.value;
    const running = inflight.get(k) as Promise<T> | undefined;
    if (running) {
      try { return await running; } catch (e) {
        if (!(e instanceof IcaUnavailable && e.reason === 'cancelled')) throw e;
      }
      return cached(kind, key, load);
    }
    const p = load();
    inflight.set(k, p);
    try {
      const value = await p;
      if (!cacheOff) {
        cache.delete(k);
        cache.set(k, { value, until: now() + ttl[kind] });
        while (cache.size > cacheMax) cache.delete(cache.keys().next().value!);
      }
      return value;
    } finally {
      if (inflight.get(k) === p) inflight.delete(k);
    }
  }

  return {
    assertAvailable, request, cached, peek,
    /** get_session_status: whether Handla calls are refused right now, and for about how long. */
    status(): HandlaStatus {
      if (!tripped || (now() >= openUntil && !probing)) return { blocked: false }; // closed, or half-open: the next call probes
      return { blocked: true, retryInMinutes: Math.ceil(remainingSeconds() / 60) };
    },
    /** Graceful shutdown: every queued request is rejected with `shutting-down`, and no new one starts. */
    close(): void {
      closed = true;
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      for (const w of queue.splice(0)) { w.signal?.removeEventListener('abort', w.onAbort); w.reject(new IcaUnavailable('shutting-down')); }
    },
    /** @internal test */
    queued: (): number => queue.length,
    /** @internal test */
    cacheSize: (): number => cache.size,
  };
}
export type HandlaGuard = ReturnType<typeof createHandlaGuard>;
