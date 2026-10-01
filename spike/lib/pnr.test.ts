import { describe, expect, it } from 'vitest';
import { normalizePersonnummer } from './pnr.js';

describe('normalizePersonnummer', () => {
  it('keeps 12 digits', () => expect(normalizePersonnummer('198501011234')).toBe('198501011234'));
  it('strips hyphen from 13 chars', () => expect(normalizePersonnummer('19850101-1234')).toBe('198501011234'));
  it('adds century to 10 digits (born 1985)', () => expect(normalizePersonnummer('8501011234')).toBe('198501011234'));
  it('adds century to hyphenated 10 digits', () => expect(normalizePersonnummer('850101-1234')).toBe('198501011234'));
  it('uses 20xx when that birth date is not in the future (born 2010)', () => {
    expect(normalizePersonnummer('1001011234', new Date('2026-09-29'))).toBe('201001011234');
  });
  it('uses 19xx when 20xx would be in the future (born 1930)', () => {
    expect(normalizePersonnummer('3001011234', new Date('2026-09-29'))).toBe('193001011234');
  });
  it('rejects garbage', () => expect(() => normalizePersonnummer('abc')).toThrow(/personnummer/));
  it('rejects wrong length', () => expect(() => normalizePersonnummer('12345')).toThrow(/personnummer/));
});
