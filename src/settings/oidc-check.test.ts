import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeOidc, type FakeOidc } from '../auth/test-fakes.js';
import { checkOidcIssuer, discoveryUrlFor, normaliseIssuer } from './oidc-check.js';

let idp: FakeOidc; let other: FakeOidc;
/** A scratch server on loopback whose discovery answer the test writes by hand (streams, trickles). */
async function scratch(onDiscovery: (res: ServerResponse) => void): Promise<{ issuer: string; close(): Promise<void> }> {
  const server: Server = createServer((_req, res) => { onDiscovery(res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/o/`;
  return { issuer, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
beforeAll(async () => { idp = await startFakeOidc(); other = await startFakeOidc(); });
afterAll(async () => { await idp.close(); await other.close(); });
beforeEach(() => { idp.patch = {}; idp.hang = false; idp.redirectDiscoveryTo = undefined; });
const status = (r: Awaited<ReturnType<typeof checkOidcIssuer>>) => Object.fromEntries(r.checks.map((c) => [c.id, c.code ? `${c.status}:${c.code}` : c.status]));

describe('checkOidcIssuer', () => {
  it('passes an Authentik-shaped provider (authorize on another path of the same origin)', async () => {
    const r = await checkOidcIssuer(idp.issuer, { groups: true });
    expect(r.ok).toBe(true);
    expect(status(r)).toEqual({ scheme: 'pass', discovery: 'pass', issuer: 'pass', endpoints: 'pass', authorize_origin: 'pass', jwks: 'pass', scopes: 'pass', email_verified: 'pass', groups: 'pass' });
  });
  it('checks the groups scope only when a group mapping is configured, and only warns', async () => {
    expect(status(await checkOidcIssuer(idp.issuer)).groups).toBeUndefined();
    idp.patch = { scopes_supported: ['openid', 'email', 'profile'] };
    const r = await checkOidcIssuer(idp.issuer, { groups: true });
    expect(r.ok).toBe(true); expect(status(r).groups).toBe('warn:missing_scope');
  });
  it('normalises the trailing slash both ways', async () => {
    expect((await checkOidcIssuer(idp.issuer.replace(/\/$/, ''))).ok).toBe(true);
    idp.patch = { issuer: idp.issuer.replace(/\/$/, '') };
    expect((await checkOidcIssuer(idp.issuer)).ok).toBe(true);
    expect(normaliseIssuer('https://a/b///')).toBe('https://a/b');
  });
  it('fails a different issuer', async () => {
    idp.patch = { issuer: 'https://evil.example/application/o/ica-hub/' };
    const r = await checkOidcIssuer(idp.issuer);
    expect(r.ok).toBe(false); expect(status(r).issuer).toBe('fail:issuer_mismatch');
  });
  it('warns (not fails) when the sign-in page is on another origin: CSP form-action', async () => {
    idp.patch = { authorization_endpoint: `${other.origin}/application/o/authorize/` };
    const r = await checkOidcIssuer(idp.issuer);
    expect(r.ok).toBe(true); expect(status(r).authorize_origin).toBe('warn:other_origin');
  });
  it('warns when email_verified is not listed, and when scopes are not listed at all', async () => {
    idp.patch = { claims_supported: ['sub', 'email'], scopes_supported: undefined };
    const r = await checkOidcIssuer(idp.issuer);
    expect(r.ok).toBe(true); expect(status(r)).toMatchObject({ email_verified: 'warn:missing_claim', scopes: 'warn:not_listed' });
  });
  it('fails listed scopes without openid/email/profile, missing endpoints, and an empty key set', async () => {
    idp.patch = { scopes_supported: ['openid'] };
    expect(status(await checkOidcIssuer(idp.issuer)).scopes).toBe('fail:missing_scopes');
    idp.patch = { token_endpoint: undefined };
    expect(status(await checkOidcIssuer(idp.issuer)).endpoints).toBe('fail:missing_endpoints');
    idp.patch = { jwks_uri: `${idp.origin}/application/o/ica-hub/.well-known/openid-configuration` }; // JSON without keys
    expect(status(await checkOidcIssuer(idp.issuer)).jwks).toBe('fail:no_keys');
  });
  it('never fetches another host: jwks elsewhere is a warning, a redirect elsewhere a failure', async () => {
    idp.patch = { jwks_uri: `${other.origin}/application/o/ica-hub/jwks/` };
    expect(status(await checkOidcIssuer(idp.issuer)).jwks).toBe('warn:other_host');
    idp.patch = {}; idp.redirectDiscoveryTo = `${other.issuer}.well-known/openid-configuration`;
    const r = await checkOidcIssuer(idp.issuer);
    expect(r.ok).toBe(false); expect(status(r).discovery).toBe('fail:redirect_other_host');
  });
  it('requires https except for loopback, without fetching', async () => {
    const fetchImpl = vi.fn();
    const r = await checkOidcIssuer('http://auth.example.com/application/o/ica-hub/', { fetchImpl: fetchImpl as never });
    expect(status(r)).toEqual({ scheme: 'fail:https_required' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(status(await checkOidcIssuer('not a url')).scheme).toBe('fail:invalid_url');
  });
  it('rejects credentials, a query or a fragment in the issuer, without fetching', async () => {
    const fetchImpl = vi.fn();
    for (const u of ['https://user:pw@auth.example.com/o/', 'https://auth.example.com/o/?x=1', 'https://auth.example.com/o/#x']) {
      expect(status(await checkOidcIssuer(u, { fetchImpl: fetchImpl as never }))).toEqual({ scheme: 'fail:invalid_url' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('follows a redirect on the same origin', async () => {
    idp.redirectDiscoveryTo = `${idp.issuer}.well-known/openid-configuration?moved=1`;
    const seen: string[] = [];
    // The fake redirects once; the wrapper records each request and switches the redirect off after the first answer.
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push(String(input)); const res = await fetch(input, init); idp.redirectDiscoveryTo = undefined; return res;
    };
    expect((await checkOidcIssuer(idp.issuer, { fetchImpl })).ok).toBe(true);
    expect(seen.slice(0, 2)).toEqual([`${idp.issuer}.well-known/openid-configuration`, `${idp.issuer}.well-known/openid-configuration?moved=1`]);
  });
  it('one deadline covers the whole check, including the key set', async () => {
    const hold = idp.pause('/application/o/ica-hub/jwks/');
    const r = await checkOidcIssuer(idp.issuer, { timeoutMs: 200 });
    hold.release();
    expect(status(r)).toMatchObject({ discovery: 'pass', jwks: 'fail:timeout' }); expect(r.ok).toBe(false);
  });
  it('builds the same discovery URL as the runtime, whatever the trailing slashes', async () => {
    expect(normaliseIssuer('https://x/o//')).toBe('https://x/o');
    expect(discoveryUrlFor('https://x/o//')).toBe('https://x/o/.well-known/openid-configuration');
    expect(discoveryUrlFor('https://x/o')).toBe('https://x/o/.well-known/openid-configuration');
    expect((await checkOidcIssuer(`${idp.issuer}/`)).ok).toBe(true);
  });
  it('fails endpoints that are not https (outside loopback): the client secret would go in cleartext', async () => {
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      idp.patch = { [key]: 'http://auth.example.com/application/o/x/' };
      const r = await checkOidcIssuer(idp.issuer);
      expect(r.ok).toBe(false); expect(status(r).endpoints).toBe('fail:endpoints_insecure');
    }
    idp.patch = { token_endpoint: 'ftp://127.0.0.1/token' };
    expect(status(await checkOidcIssuer(idp.issuer)).endpoints).toBe('fail:endpoints_insecure');
  });
  it('warns when the token endpoint is on another origin', async () => {
    idp.patch = { token_endpoint: `${other.origin}/application/o/token/` };
    const r = await checkOidcIssuer(idp.issuer);
    expect(r.ok).toBe(true); expect(status(r).endpoints).toBe('warn:token_other_origin');
  });
  it('reports an unparseable Location with a fixed code, not as unreachable', async () => {
    const s = await scratch((res) => { res.writeHead(302, { location: 'http://[bad' }); res.end(); });
    try { expect(status(await checkOidcIssuer(s.issuer)).discovery).toBe('fail:bad_redirect'); } finally { await s.close(); }
  });
  it('stops a redirect loop after 3 hops', async () => {
    idp.redirectDiscoveryTo = `${idp.issuer}.well-known/openid-configuration`;
    const seen: string[] = [];
    const fetchImpl: typeof fetch = (input, init) => { seen.push(String(input)); return fetch(input, init); };
    expect(status(await checkOidcIssuer(idp.issuer, { fetchImpl })).discovery).toBe('fail:too_many_redirects');
    expect(seen).toHaveLength(4); // the request and 3 redirects
  });
  it('stops an endless body at the cap, without buffering it all', async () => {
    const chunk = Buffer.alloc(16_384, 0x20);
    const s = await scratch((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const pump = (): void => { while (!res.destroyed && res.write(chunk)); if (!res.destroyed) res.once('drain', pump); };
      pump();
    });
    try {
      const t0 = Date.now();
      expect(status(await checkOidcIssuer(s.issuer, { timeoutMs: 5000 })).discovery).toBe('fail:too_large');
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally { await s.close(); }
  });
  it('times out while a body trickles in', async () => {
    const s = await scratch((res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); res.write('{');
      const t = setInterval(() => { if (res.destroyed) clearInterval(t); else res.write(' '); }, 20);
      res.on('close', () => clearInterval(t));
    });
    try {
      const t0 = Date.now();
      expect(status(await checkOidcIssuer(s.issuer, { timeoutMs: 300 })).discovery).toBe('fail:timeout');
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally { await s.close(); }
  });
  it('times out', async () => {
    idp.hang = true;
    const r = await checkOidcIssuer(idp.issuer, { timeoutMs: 200 });
    expect(status(r).discovery).toBe('fail:timeout');
  });
  it('fails unreachable and HTTP errors with a fixed code', async () => {
    expect(status(await checkOidcIssuer('http://127.0.0.1:9/o/')).discovery).toBe('fail:unreachable');
    expect(status(await checkOidcIssuer(`${idp.origin}/nope/`)).discovery).toBe('fail:http_404');
  });
  it('caps the body', async () => {
    idp.patch = { filler: 'x'.repeat(300_000) };
    expect(status(await checkOidcIssuer(idp.issuer)).discovery).toBe('fail:too_large');
  });
});
