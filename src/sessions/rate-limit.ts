export type TakeResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Per-key token bucket for ICA calls (key = hub user id): `capacity` calls at once, refilled at `refillPerSecond`.
 * Protects the household's ICA accounts from a runaway conversation; in memory, one entry per hub user.
 * `now` is in milliseconds and defaults to a monotonic clock; a reading that goes backwards counts as no time passed.
 */
export function createTokenBucket(o: { capacity?: number; refillPerSecond?: number; now?: () => number } = {}) {
  const capacity = o.capacity ?? 60; const rate = o.refillPerSecond ?? 1; const now = o.now ?? (() => performance.now());
  if (!(capacity >= 1)) throw new RangeError(`token bucket capacity must be at least 1 (got ${capacity})`);
  if (!(rate > 0) || !Number.isFinite(rate)) throw new RangeError(`token bucket refillPerSecond must be a positive number (got ${rate})`);
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(key: string): TakeResult {
      const t = now();
      const b = buckets.get(key) ?? { tokens: capacity, at: t };
      const tokens = Math.min(capacity, b.tokens + (Math.max(0, t - b.at) / 1000) * rate);
      if (tokens < 1) { buckets.set(key, { tokens, at: t }); return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / rate)) }; }
      buckets.set(key, { tokens: tokens - 1, at: t });
      return { ok: true };
    },
  };
}
export type TokenBucket = ReturnType<typeof createTokenBucket>;
