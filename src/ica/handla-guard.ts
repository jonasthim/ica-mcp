import { IcaUnavailable, errorCategory } from './errors.js';

/**
 * The process-wide guard every Handla request goes through (docs/api-notes.md → "Handla: AWS WAF"). Handla sits behind
 * CloudFront + AWS WAF with a rate rule per source IP: about 7 searches in about 15 s and every request from the IP is
 * refused for many minutes. One guard per process (the SessionKeeper owns it), because the rule is per IP, not per
 * user. It holds:
 *
 * - a circuit breaker: a WAF stop (`IcaUnavailable('blocked')`) opens it for a cooldown (base 10 min, doubled after
 *   every probe that is stopped again, up to 60 min). While open every call fails at once without contacting Handla.
 *   After the cooldown exactly one request is let through as a probe (half-open): any HTTP answer that is not a WAF
 *   stop closes the breaker and resets the cooldown; a WAF stop reopens it with the doubled cooldown; no answer at all
 *   (network, timeout) is inconclusive and the next request probes again.
 * - pacing: one queue for the whole process, request starts at least `minGapMs` apart, at most `maxQueued` waiting.
 *   The queue wait comes before the request's 15 s timeout starts, so waiting never times a request out; a caller that
 *   gives up (abort signal) is dropped from the queue before anything is sent.
 * - a small in-memory LRU of successful answers (search 15 min, store search 24 h, 500 entries).
 *
 * Each breaker change is logged once at warn as `{ handla, cooldownMinutes }`; never a query, zip or store id.
 */
export type HandlaGuardOptions = {
  /** First cooldown after a WAF stop (ICA_HUB_HANDLA_COOLDOWN_MINUTES, default 10). */
  cooldownMinutes?: number;
  /** The cooldown is doubled after each failed probe up to this (default 60, never below `cooldownMinutes`). */
  maxCooldownMinutes?: number;
  /** Minimum time between two Handla request starts (ICA_HUB_HANDLA_MIN_GAP_MS, default 2500). */
  minGapMs?: number;
  /** At most this many requests wait in the queue (default 20); more fail fast with `queue-full`. */
  maxQueued?: number;
  /** How long a product search answer is kept (ICA_HUB_HANDLA_CACHE_MINUTES, default 15). 0 turns the whole cache off. */
  cacheMinutes?: number;
  /** How long a store search answer is kept (default 24 h). */
  storeCacheMinutes?: number;
  /** LRU size (default 500). */
  cacheMax?: number;
  /** Epoch ms (default Date.now). Timers are the global ones, so tests use fake timers. */
  now?: () => number;
  log?: { warn: (obj: object, msg: string) => void };
};

export type HandlaStatus = { blocked: boolean; retryInMinutes?: number };
type Waiter = { resolve: () => void; reject: (e: unknown) => void; signal: AbortSignal | undefined; onAbort: () => void };

const MIN_MS = 60_000;

export function createHandlaGuard(o: HandlaGuardOptions = {}) {
  const now = o.now ?? Date.now;
  const baseMs = (o.cooldownMinutes ?? 10) * MIN_MS;
  const maxMs = Math.max(baseMs, (o.maxCooldownMinutes ?? 60) * MIN_MS);
  const gap = o.minGapMs ?? 2500;
  const maxQueued = o.maxQueued ?? 20;
  const ttl = { search: (o.cacheMinutes ?? 15) * MIN_MS, stores: (o.storeCacheMinutes ?? 24 * 60) * MIN_MS };
  const cacheOff = o.cacheMinutes === 0;
  const cacheMax = o.cacheMax ?? 500;

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

  // ---- pacing ----
  let lastStart = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Waiter[] = [];
  function pump(): void {
    if (timer !== undefined) return;
    while (queue.length > 0) {
      const wait = lastStart + gap - now();
      if (wait > 0) { timer = setTimeout(() => { timer = undefined; pump(); }, wait); return; }
      const w = queue.shift()!;
      w.signal?.removeEventListener('abort', w.onAbort);
      lastStart = now();
      w.resolve();
    }
  }
  function slot(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(new IcaUnavailable(errorCategory(signal.reason)));
    if (queue.length === 0 && timer === undefined && now() - lastStart >= gap) { lastStart = now(); return Promise.resolve(); }
    if (queue.length >= maxQueued) return Promise.reject(new IcaUnavailable('queue-full'));
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        resolve, reject, signal,
        onAbort: () => {
          const i = queue.indexOf(w);
          if (i >= 0) queue.splice(i, 1);
          reject(new IcaUnavailable(errorCategory(signal?.reason)));
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
   */
  async function request<T>(send: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    assertAvailable();
    await slot(signal);
    let probe = false;
    if (tripped) {
      assertAvailable();
      probing = true; probe = true;
      logChange('probe');
    }
    try {
      const out = await send();
      if (probe) recover();
      return out;
    } catch (e) {
      if (e instanceof IcaUnavailable && e.reason === 'blocked') { trip(probe); throw blocked(e.status); }
      const noAnswer = e instanceof IcaUnavailable && (e.reason === 'network' || e.reason === 'timeout');
      if (probe && !noAnswer) recover(); // Handla answered something other than a WAF stop: the IP is let through
      throw e;
    } finally {
      if (probe) probing = false;
    }
  }

  // ---- cache (a Map keeps insertion order: re-inserting on a hit makes it an LRU) ----
  const cache = new Map<string, { value: unknown; until: number }>();
  async function cached<T>(kind: 'search' | 'stores', key: string, load: () => Promise<T>): Promise<T> {
    if (cacheOff) return load();
    const k = `${kind}\n${key}`;
    const hit = cache.get(k);
    if (hit) {
      cache.delete(k);
      if (hit.until > now()) { cache.set(k, hit); return hit.value as T; }
    }
    const value = await load();
    cache.delete(k);
    cache.set(k, { value, until: now() + ttl[kind] });
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value!);
    return value;
  }

  return {
    assertAvailable, request, cached,
    /** get_session_status: whether Handla calls are refused right now, and for about how long. */
    status(): HandlaStatus {
      if (!tripped || (now() >= openUntil && !probing)) return { blocked: false }; // closed, or half-open: the next call probes
      return { blocked: true, retryInMinutes: Math.ceil(remainingSeconds() / 60) };
    },
    /** @internal test */
    queued: (): number => queue.length,
    /** @internal test */
    cacheSize: (): number => cache.size,
  };
}
export type HandlaGuard = ReturnType<typeof createHandlaGuard>;
