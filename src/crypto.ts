import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

export class CryptoKeyMismatch extends Error { constructor() { super('Decryption failed: wrong ICA_HUB_MASTER_KEY or corrupted data'); } }
export class CryptoFormatError extends Error { constructor() { super('Not a v1 encryption envelope'); } }

const ALG = 'aes-256-gcm';

export function createCipher(masterKey: Buffer) {
  if (masterKey.length !== 32) throw new Error('master key must be 32 bytes');
  // A separate key for fingerprints, so a MAC never uses the encryption key itself.
  const macKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'ica-hub subject mac v1', 32));
  return {
    encrypt(plain: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALG, masterKey, iv);
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
    },
    decrypt(envelope: string): string {
      const parts = envelope.split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') throw new CryptoFormatError();
      const [, iv, tag, ct] = parts as [string, string, string, string];
      try {
        const d = createDecipheriv(ALG, masterKey, Buffer.from(iv, 'base64url'));
        d.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
      } catch { throw new CryptoKeyMismatch(); }
    },
    /** A keyed, non-reversible fingerprint (HMAC-SHA256 under a key derived from the master key), base64url. */
    mac(value: string): string { return createHmac('sha256', macKey).update(value, 'utf8').digest('base64url'); },
  };
}
export type Cipher = ReturnType<typeof createCipher>;
