import { describe, expect, it } from 'vitest';
import { appTokenShape, captureElements, valueAt } from './shape-capture.js';

describe('valueAt', () => {
  it('walks keys, indexes and * steps', () => {
    const j = { a: [{ b: 1 }], c: { empty: [], list: [{ d: true }] } };
    expect(valueAt(j, ['a', 0, 'b'])).toBe(1);
    expect(valueAt(j, ['c', '*'])).toEqual({ d: true });
    expect(valueAt([5, 6], ['*'])).toBe(5);
    expect(valueAt(j, ['a', 'b'])).toBeUndefined();
    expect(valueAt(j, ['x', 0])).toBeUndefined();
    expect(valueAt('s', ['*'])).toBeUndefined();
  });

  it('never reads an inherited property (only an object\'s own keys count as a path step)', () => {
    expect(valueAt({}, ['toString'])).toBeUndefined();
    expect(valueAt({}, ['constructor'])).toBeUndefined();
    expect(valueAt({ toString: 'x' }, ['toString'])).toBe('x');
  });
});

describe('captureElements', () => {
  it('captures only the paths registered for the probe, and says absent when a path is missing', () => {
    expect(captureElements('mobile-bonus', { vouchers: { used: [{ value: 50, validTo: '2026-10-31' }], active: [] } })).toEqual([
      { probe: 'mobile-bonus', label: 'vouchers.used[0]', shape: 'object{value: number, validTo: string}' },
      { probe: 'mobile-bonus', label: 'vouchers.active[0]', shape: 'absent' },
      { probe: 'mobile-bonus', label: 'accountBalance.groupedBalances[0]', shape: 'absent' },
    ]);
    expect(captureElements('unknown-probe', { a: 1 })).toEqual([]);
  });
});

describe('appTokenShape', () => {
  it('shows a JWT payload as claim names and types, and an opaque token as its length', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = `${b64({ alg: 'RS256' })}.${b64({ sub: '199001011234', exp: 1790000000, scope: 'openid ica-app-scope' })}.c2ln`;
    const shape = appTokenShape(jwt);
    expect(shape).toBe('jwt object{sub: string, exp: number, scope: string}');
    for (const v of ['199001011234', '1790000000', 'ica-app-scope']) expect(shape).not.toContain(v);
    expect(appTokenShape('APP-ACCESS-TOKEN-SECRET')).toBe('opaque (23 chars)');
    expect(appTokenShape('a.b.c')).toBe('opaque (5 chars)');
  });
});
