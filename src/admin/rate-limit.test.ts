import { describe, expect, it, vi } from 'vitest';
import { createLoginLimiter } from './rate-limit.js';

describe('createLoginLimiter', () => {
  it('allows 10 attempts per key in the window and rejects the 11th with a retry time', () => {
    let t = 1_000_000;
    const l = createLoginLimiter({ now: () => t });
    for (let i = 0; i < 10; i++) { expect(l.attempt(['ip:1.2.3.4']).ok).toBe(true); t += 1000; }
    const r = l.attempt(['ip:1.2.3.4']);
    expect(r).toEqual({ ok: false, retryAfterSeconds: 15 * 60 - 10, firstRejection: true });
    expect(l.attempt(['ip:5.6.7.8']).ok).toBe(true); // other keys are unaffected
  });
  it('limits by email independently of the IP', () => {
    const l = createLoginLimiter({ max: 2, now: () => 0 });
    expect(l.attempt(['ip:a', 'email:x@y.se']).ok).toBe(true);
    expect(l.attempt(['ip:b', 'email:x@y.se']).ok).toBe(true);
    expect(l.attempt(['ip:c', 'email:x@y.se']).ok).toBe(false);
    expect(l.attempt(['ip:c', 'email:other@y.se']).ok).toBe(true);
  });
  it('slides: attempts older than the window stop counting, and old entries are evicted', () => {
    let t = 0;
    const l = createLoginLimiter({ max: 2, windowMs: 60_000, now: () => t });
    l.attempt(['ip:a']); t = 30_000; l.attempt(['ip:a']);
    expect(l.attempt(['ip:a']).ok).toBe(false);
    t = 60_001; // the first attempt left the window, the second has not
    expect(l.attempt(['ip:a']).ok).toBe(true);
    expect(l.attempt(['ip:a']).ok).toBe(false);
    t = 200_000;
    l.attempt(['ip:b']);
    expect(l.size()).toBe(1); // ip:a evicted
  });
  it('middleware answers 429 with Retry-After and logs the IP only', () => {
    const warn = vi.fn();
    const l = createLoginLimiter({ max: 1, now: () => 0, log: { warn } as never });
    const req = { ip: '9.9.9.9', body: { email: 'Secret@Example.com', password: 'hunter2hunter2' } } as never;
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), type: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
    l.middleware(req, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    l.middleware(req, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.set).toHaveBeenCalledWith('Retry-After', '900');
    expect(warn).toHaveBeenCalledWith({ ip: '9.9.9.9' }, 'login rate limit exceeded');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|hunter2/i);
  });
  it('middleware calls onLimited with the rejected request only', () => {
    const onLimited = vi.fn();
    const l = createLoginLimiter({ max: 1, now: () => 0, onLimited });
    const req = { ip: '9.9.9.9', body: {} } as never;
    const res = { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), type: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
    l.middleware(req, res as never, vi.fn());
    expect(onLimited).not.toHaveBeenCalled();
    l.middleware(req, res as never, vi.fn());
    expect(onLimited).toHaveBeenCalledExactlyOnceWith(req);
  });
  it('reports only the first rejection per key per window, so a flood cannot write an audit row per request', () => {
    let t = 0;
    const onLimited = vi.fn();
    const l = createLoginLimiter({ max: 2, windowMs: 60_000, now: () => t, onLimited });
    const res = { status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), type: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
    const req = (ip: string, email?: string) => ({ ip, body: email ? { email } : {} }) as never;
    l.middleware(req('1.1.1.1'), res as never, vi.fn());
    l.middleware(req('1.1.1.1'), res as never, vi.fn());
    for (let i = 0; i < 50; i++) l.middleware(req('1.1.1.1'), res as never, vi.fn());
    expect(res.status).toHaveBeenCalledTimes(50); // every one of them is still refused
    expect(onLimited).toHaveBeenCalledTimes(1);
    // Another key that becomes limited is reported once too, even from the already-reported IP.
    l.middleware(req('2.2.2.2', 'a@b.se'), res as never, vi.fn());
    l.middleware(req('3.3.3.3', 'a@b.se'), res as never, vi.fn());
    for (let i = 0; i < 20; i++) l.middleware(req(`4.4.4.${i}`, 'A@b.se'), res as never, vi.fn());
    l.middleware(req('1.1.1.1', 'a@b.se'), res as never, vi.fn());
    expect(onLimited).toHaveBeenCalledTimes(2);
    // A new window: the key's attempts have aged out, it is allowed again, and its next rejection is reported again.
    t = 60_001;
    l.middleware(req('1.1.1.1'), res as never, vi.fn());
    l.middleware(req('1.1.1.1'), res as never, vi.fn());
    for (let i = 0; i < 5; i++) l.middleware(req('1.1.1.1'), res as never, vi.fn());
    expect(onLimited).toHaveBeenCalledTimes(3);
  });
  it('keeps the reported set bounded like the hits: an idle key leaves both maps', () => {
    let t = 0;
    const l = createLoginLimiter({ max: 1, windowMs: 1000, now: () => t });
    expect(l.attempt(['ip:a']).ok).toBe(true);
    expect(l.attempt(['ip:a'])).toMatchObject({ ok: false, firstRejection: true });
    expect(l.attempt(['ip:a'])).toMatchObject({ ok: false, firstRejection: false });
    expect(l.reportedSize()).toBe(1);
    t = 5000;
    l.attempt(['ip:b']);
    expect(l.size()).toBe(1);
    expect(l.reportedSize()).toBe(0);
  });
});
