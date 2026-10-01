import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CryptoFormatError, CryptoKeyMismatch, createCipher } from './crypto.js';

describe('createCipher', () => {
  const key = randomBytes(32);
  const c = createCipher(key);
  it('round-trips unicode', () => {
    const env = c.encrypt('lösenord Åäö 🛒');
    expect(env.startsWith('v1.')).toBe(true);
    expect(c.decrypt(env)).toBe('lösenord Åäö 🛒');
  });
  it('produces different ciphertext for the same input (random iv)', () => {
    expect(c.encrypt('a')).not.toBe(c.encrypt('a'));
  });
  it('fails loudly with the wrong key', () => {
    const other = createCipher(randomBytes(32));
    expect(() => other.decrypt(c.encrypt('secret'))).toThrow(CryptoKeyMismatch);
  });
  it('fails loudly when tampered', () => {
    const env = c.encrypt('secret');
    const parts = env.split('.');
    parts[3] = parts[3]!.slice(0, -2) + 'AA';
    expect(() => c.decrypt(parts.join('.'))).toThrow(CryptoKeyMismatch);
  });
  it('rejects malformed envelopes', () => {
    expect(() => c.decrypt('plaintext')).toThrow(CryptoFormatError);
    expect(() => c.decrypt('v2.a.b.c')).toThrow(CryptoFormatError);
  });
  it('requires a 32-byte key', () => {
    expect(() => createCipher(randomBytes(16))).toThrow(/32/);
  });
});

describe('Cipher.mac', () => {
  it('is deterministic per key, keyed, and does not contain the input', () => {
    const a = createCipher(Buffer.alloc(32, 1)); const b = createCipher(Buffer.alloc(32, 2));
    expect(a.mac('ica-subject:CUST-1')).toBe(a.mac('ica-subject:CUST-1'));
    expect(a.mac('ica-subject:CUST-1')).not.toBe(b.mac('ica-subject:CUST-1'));
    expect(a.mac('ica-subject:CUST-1')).not.toBe(a.mac('ica-subject:CUST-2'));
    expect(a.mac('ica-subject:CUST-1')).not.toContain('CUST');
    expect(a.mac('x')).toMatch(/^[\w-]{43}$/);
  });
});
