import { describe, expect, it } from 'vitest';
import { redactUrl, qs, hidden, redact } from './http.js';

describe('redactUrl', () => {
  it('redacts code and state query params', () => {
    expect(redactUrl('https://x/cb?code=abc&state=st&foo=1')).toBe('https://x/cb?code=<redacted>&state=<redacted>&foo=1');
  });

  it('redacts personal data like userName and email', () => {
    const redacted = redactUrl('icacurity://app?userName=199001011234&email=a@b.se#token=zz');
    expect(redacted).not.toContain('199001011234');
    expect(redacted).not.toContain('a@b.se');
    expect(redacted).not.toContain('zz');
    expect(redacted).toContain('userName=<redacted>');
  });
});

describe('qs', () => {
  it('throws when key not found, without leaking other secret params', () => {
    expect(() => qs('https://x/?token=secret123', 'code')).toThrow();
    const error = (() => {
      try {
        qs('https://x/?token=secret123', 'code');
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(error).not.toContain('secret123');
  });
});

describe('redact', () => {
  it('redacts nested sensitive fields in objects and arrays', () => {
    expect(redact({ password: 'p', nested: { access_token: 't', ok: 1 }, list: [{ cookie: 'c' }] })).toEqual({
      password: '<redacted>',
      nested: { access_token: '<redacted>', ok: 1 },
      list: [{ cookie: '<redacted>' }],
    });
  });
});

describe('hidden', () => {
  it('extracts value from name first order', () => {
    expect(hidden('<input name="token" value="v1">', 'token')).toBe('v1');
  });

  it('extracts value from value first order', () => {
    expect(hidden('<input value="v2" name="state">', 'state')).toBe('v2');
  });

  it('throws without leaking HTML when field not found', () => {
    expect(() => hidden('<p>none</p>', 'token')).toThrow();
    const error = (() => {
      try {
        hidden('<p>none</p>', 'token');
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(error).not.toContain('<p>');
  });
});
