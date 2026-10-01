import { describe, expect, it } from 'vitest';
import { capName, DISPLAY_NAME_MAX, validateDisplayName } from './display-name.js';

describe('validateDisplayName', () => {
  it.each([
    ['  Åsa  ', 'Åsa'],
    ['é'.repeat(100), 'é'.repeat(100)], // NFD: 200 code points before NFC, 100 after
    ['😀'.repeat(100), '😀'.repeat(100)], // 200 UTF-16 units, 100 code points
    ['a'.repeat(DISPLAY_NAME_MAX), 'a'.repeat(DISPLAY_NAME_MAX)],
  ])('accepts %j', (raw, want) => expect(validateDisplayName(raw)).toBe(want));
  it.each([['😀'.repeat(101)], ['a'.repeat(101)], ['   '], [''], [undefined], [42], [['Åsa']]])('refuses %j', (raw) => {
    expect(validateDisplayName(raw)).toBeUndefined();
  });
});

describe('capName', () => {
  it('caps at 100 code points without splitting a surrogate pair', () => {
    expect(capName('😀'.repeat(150))).toBe('😀'.repeat(100));
    expect(capName('Åsa')).toBe('Åsa');
  });
});
