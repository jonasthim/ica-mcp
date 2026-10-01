import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '../logger.js';

/**
 * `onLimited` runs before the 429 is sent (e.g. to audit it), but only for the first rejection of a limited key in its
 * window: a client hammering a limited key gets 429 after 429 without writing a row per request.
 */
export type LoginLimiterOptions = { max?: number; windowMs?: number; now?: () => number; log?: Pick<Logger, 'warn'>; onLimited?: (req: Request) => void };
/** `firstRejection`: some key over its limit had not been rejected yet in this window (report it; later ones are not). */
export type LimitResult = { ok: true } | { ok: false; retryAfterSeconds: number; firstRejection: boolean };

/**
 * In-memory sliding-window limiter for login attempts, counted separately per client IP and per (lowercased) email.
 * Every allowed attempt counts, successful or not; rejected attempts are not recorded (no self-extending lockout).
 * Entries older than the window are evicted on every call, so the map stays bounded by recent traffic.
 * `reported` holds, per key, when its current run of rejections was first reported; it is cleared as soon as the key
 * is under its limit again (its window reset), so it only ever holds keys that are in `hits` and limited.
 */
export function createLoginLimiter({ max = 10, windowMs = 15 * 60_000, now = Date.now, log, onLimited }: LoginLimiterOptions = {}) {
  const hits = new Map<string, number[]>();
  const reported = new Map<string, number>();

  const evict = (t: number) => {
    for (const [key, times] of hits) {
      const recent = times.filter((x) => x > t - windowMs);
      if (recent.length === 0) hits.delete(key); else if (recent.length !== times.length) hits.set(key, recent);
      if (recent.length < max) reported.delete(key);
    }
  };

  /** Checks and, when allowed, records one attempt for every key. */
  function attempt(keys: string[]): LimitResult {
    const t = now();
    evict(t);
    let retryAt = 0;
    let firstRejection = false;
    for (const key of keys) {
      const times = hits.get(key) ?? [];
      if (times.length < max) continue;
      retryAt = Math.max(retryAt, times[times.length - max]! + windowMs);
      if (!reported.has(key)) { reported.set(key, t); firstRejection = true; }
    }
    if (retryAt) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - t) / 1000)), firstRejection };
    for (const key of keys) hits.set(key, [...(hits.get(key) ?? []), t]);
    return { ok: true };
  }

  function middleware(req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip ?? 'unknown';
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const r = attempt([`ip:${ip}`, ...(email ? [`email:${email}`] : [])]);
    if (r.ok) { next(); return; }
    if (r.firstRejection) {
      log?.warn({ ip }, 'login rate limit exceeded');
      onLimited?.(req);
    }
    res.status(429).set('Retry-After', String(r.retryAfterSeconds)).type('text/plain').send('Too many sign-in attempts. Try again later.');
  }

  return { attempt, middleware, size: () => hits.size, reportedSize: () => reported.size };
}
