import { describe, expect, it } from 'vitest';
import { redact, redactText, redactUrl } from './redact.js';

describe('redact', () => {
  it('redacts secret keys at any depth, keeping structure and harmless values', () => {
    const input = {
      accessToken: 'eyJhbGciOi.payload.sig', loginState: 2, personnummer: '199001011234', firstName: 'Anna', lastName: 'Exempelsson',
      details: { address: { street: 'Gatan 1' }, email: 'a@b.se', phone: '0701234567', cardNumber: '6035000011112222' },
      lists: [{ id: 'list-1', name: 'Veckohandling', rows: [{ articleName: 'Mjölk', quantity: 2 }] }],
      stores: [1004599], ean: '7310865004703',
    };
    expect(redact(input)).toEqual({
      accessToken: '<redacted>', loginState: 2, personnummer: '<redacted>', firstName: '<redacted>', lastName: '<redacted>',
      details: { address: '<redacted>', email: '<redacted>', phone: '<redacted>', cardNumber: '<redacted>' },
      lists: [{ id: 'list-1', name: 'Veckohandling', rows: [{ articleName: 'Mjölk', quantity: 2 }] }],
      stores: [1004599], ean: '7310865004703',
    });
  });

  it('redacts secret-looking values under innocent keys (personnummer, card numbers, JWTs, emails)', () => {
    const out = redact({ a: '19900101-1234', b: '9001011234', c: '6035000011112222', d: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln', e: 'x@example.se', f: 1990010112345678, g: 'ok' });
    expect(out).toEqual({ a: '<redacted>', b: '<redacted>', c: '<redacted>', d: '<redacted>', e: '<redacted>', f: '<redacted>', g: 'ok' });
  });

  it('scrubs secret-looking substrings inside longer string values', () => {
    expect(redact({ note: 'kort 6035000011112222 för 19900101-1234', ean: 'EAN 7310865004703' })).toEqual({ note: 'kort <redacted> för <redacted>', ean: 'EAN 7310865004703' });
  });

  it('redacts names and sessions under common key spellings', () => {
    expect(redact({ fullName: 'A B', givenName: 'A', surname: 'B', sessionId: 's', authorization: 'Bearer x', ssn: '1' }))
      .toEqual({ fullName: '<redacted>', givenName: '<redacted>', surname: '<redacted>', sessionId: '<redacted>', authorization: '<redacted>', ssn: '<redacted>' });
  });
});

describe('redact: people', () => {
  it('redacts people-shaped keys wholesale but keeps list, store and product names', () => {
    expect(redact({ ownerName: 'A', memberName: 'B', displayName: 'C', nickname: 'D', owner: { name: 'E' }, members: [{ name: 'F' }], sharedWith: ['G'], dateOfBirth: '1990', name: 'Veckohandling', storeName: 'ICA Kvantum', articleName: 'Mjölk' }))
      .toEqual({ ownerName: '<redacted>', memberName: '<redacted>', displayName: '<redacted>', nickname: '<redacted>', owner: '<redacted>', members: '<redacted>', sharedWith: '<redacted>', dateOfBirth: '<redacted>', name: 'Veckohandling', storeName: 'ICA Kvantum', articleName: 'Mjölk' });
  });
});

describe('redact: addresses and authorship', () => {
  it('redacts address parts and who-edited-what keys', () => {
    const keys = ['street', 'streetAddress', 'city', 'zip', 'zipCode', 'postalCode', 'createdBy', 'modifiedBy', 'updatedBy', 'author', 'owner', 'listOwner'];
    expect(redact(Object.fromEntries(keys.map((k) => [k, 'x'])))).toEqual(Object.fromEntries(keys.map((k) => [k, '<redacted>'])));
  });
});

describe('redactText', () => {
  it('scrubs secret-looking substrings from free text', () => {
    const t = redactText('user 19900101-1234 token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln mail x@example.se ean 7310865004703');
    expect(t).not.toMatch(/19900101|eyJhbG|x@example/);
    expect(t).toContain('ean 7310865004703');
  });
});

describe('redactUrl', () => {
  it('redacts secret query and fragment params only', () => {
    expect(redactUrl('https://www.ica.se/cb?code=abc&state=xyz&lang=sv#access_token=t')).toBe('https://www.ica.se/cb?code=<redacted>&state=<redacted>&lang=sv#access_token=<redacted>');
  });
});
