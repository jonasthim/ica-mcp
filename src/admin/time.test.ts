import { describe, expect, it } from 'vitest';
import { stockholmDayEndUtc, stockholmDayStartUtc } from './time.js';

describe('stockholmDayStartUtc / stockholmDayEndUtc', () => {
  it('an event at 23:30 Stockholm on 2026-09-29 (21:30Z) is inside the to=2026-09-29 range', () => {
    const at = '2026-09-29T21:30:00.000Z';
    expect(at < stockholmDayEndUtc('2026-09-29')).toBe(true);
  });

  it("an event at 00:30 Stockholm on 2026-09-30 (22:30Z on 09-29) is outside to=2026-09-29 and inside from=2026-09-30", () => {
    const at = '2026-09-29T22:30:00.000Z';
    expect(at < stockholmDayEndUtc('2026-09-29')).toBe(false);
    expect(at >= stockholmDayStartUtc('2026-09-30')).toBe(true);
  });

  it('a winter date (CET, UTC+1)', () => {
    expect(stockholmDayStartUtc('2026-01-15')).toBe('2026-01-14T23:00:00.000Z');
    expect(stockholmDayEndUtc('2026-01-15')).toBe('2026-01-15T23:00:00.000Z');
  });

  it('the DST fall-back transition date (2026-10-25, a 25-hour Stockholm day)', () => {
    expect(stockholmDayStartUtc('2026-10-25')).toBe('2026-10-24T22:00:00.000Z');
    expect(stockholmDayEndUtc('2026-10-25')).toBe('2026-10-25T23:00:00.000Z');
  });

  it('a summer date (CEST, UTC+2), for contrast with the winter case', () => {
    expect(stockholmDayStartUtc('2026-09-29')).toBe('2026-09-28T22:00:00.000Z');
    expect(stockholmDayEndUtc('2026-09-29')).toBe('2026-09-29T22:00:00.000Z');
  });
});
