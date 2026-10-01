import { describe, expect, it } from 'vitest';
import { createTokenBucket } from './rate-limit.js';

describe('createTokenBucket', () => {
  it('allows `capacity` calls at once, then one per second per key', () => {
    let t = 0;
    const b = createTokenBucket({ capacity: 3, refillPerSecond: 1, now: () => t });
    expect([b.take('u'), b.take('u'), b.take('u')].every((r) => r.ok)).toBe(true);
    expect(b.take('u')).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(b.take('other').ok).toBe(true);
    t = 1000;
    expect(b.take('u').ok).toBe(true);
    expect(b.take('u').ok).toBe(false);
    t = 60_000;
    expect([b.take('u'), b.take('u'), b.take('u')].every((r) => r.ok)).toBe(true); // refill is capped at capacity
    expect(b.take('u').ok).toBe(false);
  });
  it('defaults to 60 per minute', () => {
    const b = createTokenBucket({ now: () => 0 });
    for (let i = 0; i < 60; i++) expect(b.take('u').ok).toBe(true);
    expect(b.take('u').ok).toBe(false);
  });
  it('a clock that jumps backwards neither drains nor mints tokens', () => {
    let t = 10_000;
    const b = createTokenBucket({ capacity: 2, refillPerSecond: 1, now: () => t });
    expect(b.take('u').ok).toBe(true);
    t = 0; // backwards 10 s: must not count as -10 s of refill
    expect(b.take('u').ok).toBe(true);
    expect(b.take('u')).toEqual({ ok: false, retryAfterSeconds: 1 });
    t = 1000; // forwards again from the new reading: one second of refill
    expect(b.take('u').ok).toBe(true);
    expect(b.take('u').ok).toBe(false);
  });
  it('rejects settings that could never allow a call or never refill', () => {
    expect(() => createTokenBucket({ refillPerSecond: 0 })).toThrow(/refillPerSecond/);
    expect(() => createTokenBucket({ refillPerSecond: -1 })).toThrow(/refillPerSecond/);
    expect(() => createTokenBucket({ capacity: 0 })).toThrow(/capacity/);
    expect(() => createTokenBucket({ capacity: 0.5 })).toThrow(/capacity/);
    expect(() => createTokenBucket({ refillPerSecond: Number.NaN })).toThrow(/refillPerSecond/);
  });
});
