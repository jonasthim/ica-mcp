import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cspHeader, formActionSourceFor } from './security-headers.js';
import { startTestApp, type TestCtx } from '../test-helpers.js';

describe('cspHeader', () => {
  it('is strict, nonce-based and has no unsafe-inline', () => {
    const h = cspHeader('abc');
    expect(h).toBe("default-src 'self'; script-src 'self' 'nonce-abc'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'");
    expect(h).not.toContain('unsafe');
  });
  it('adds extra form-action sources', () => {
    expect(cspHeader('n', ['https://claude.ai'])).toContain("form-action 'self' https://claude.ai;");
  });
});

describe('formActionSourceFor', () => {
  it.each([
    ['https://claude.ai/api/mcp/auth_callback', 'https://claude.ai'],
    ['http://127.0.0.1:33418/cb', 'http://127.0.0.1:33418'],
    ['com.example.app:/oauth/cb', 'com.example.app:'],
    ['not a url', undefined],
    [null, undefined],
    ['javascript:alert(1)', undefined],
    ['http://[::1]:8080/cb', 'http://[::1]:8080'],
    // WHATWG URL keeps `;` and `,` in special-scheme hosts: they would inject CSP directives or sources
    ['http://x;script-src/', undefined],
    ['https://evil.example;script-src https:/cb', undefined],
    ['http://a,b/cb', undefined],
    ['https://a%3Bb.example/cb', undefined],
  ])('%s → %s', (uri, want) => expect(formActionSourceFor(uri)).toBe(want));
});

describe('headers on every response', () => {
  let t: TestCtx;
  beforeAll(async () => { t = await startTestApp(); });
  afterAll(async () => { await t.close(); });

  it.each(['/admin', '/admin/users', '/healthz', '/auth/jwks', '/nope', '/.well-known/oauth-authorization-server/auth'])('%s carries the full set', async (path) => {
    const r = await fetch(`${t.url}${path}`, { redirect: 'manual' });
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{24}'/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(r.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(r.headers.get('strict-transport-security')).toBeNull(); // http test URL
  });

  // claude.ai may run Connect in a popup and wait on window.opener: COOP same-origin on any page of the flow would sever it.
  it.each([
    '/auth/oauth2/authorize?client_id=x', '/auth/oauth2/token', '/auth/callback/oidc', '/auth/oauth2/callback/oidc',
    '/admin/login', '/admin/login?next=%2Fadmin', '/admin/login/oidc', '/admin/consent', '/admin/invite/abc', '/admin/invite/abc/accept', '/Admin/Login',
  ])('%s (OAuth flow) sends COOP unsafe-none and the rest of the set', async (path) => {
    const r = await fetch(`${t.url}${path}`, { redirect: 'manual' });
    expect(r.headers.get('cross-origin-opener-policy')).toBe('unsafe-none');
    expect(r.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it.each(['/admin/loginx', '/admin/consentx', '/admin/invitex', '/auth/oauth2x', '/admin/profile'])('%s is not an OAuth-flow path: COOP stays same-origin', async (path) => {
    const r = await fetch(`${t.url}${path}`, { redirect: 'manual' });
    expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  it('uses a fresh nonce per request', async () => {
    const a = (await fetch(`${t.url}/admin/login`)).headers.get('content-security-policy');
    const b = (await fetch(`${t.url}/admin/login`)).headers.get('content-security-policy');
    expect(a).not.toBe(b);
  });

  it('sends HSTS only for an https public URL', async () => {
    const { securityHeaders } = await import('./security-headers.js');
    const headers = new Map<string, string>();
    const res = { locals: {} as Record<string, unknown>, setHeader: (k: string, v: string) => headers.set(k.toLowerCase(), v) };
    securityHeaders({ publicUrl: 'https://ica.example.com' } as never)({} as never, res as never, () => {});
    expect(headers.get('strict-transport-security')).toBe('max-age=31536000');
  });
});
