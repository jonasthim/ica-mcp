import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeOidcUser = { sub: string; email: string; email_verified?: boolean; name?: string; groups?: string[] };
export type FakeOidc = {
  issuer: string; origin: string; next: FakeOidcUser; seen: { authorize?: URLSearchParams; token?: URLSearchParams };
  /** While true, every request answers 503 (an IdP that is down). */
  down: boolean;
  /** Merged into the discovery document (an `undefined` value removes that key). */
  patch: Record<string, unknown>;
  /** While true, discovery never answers (the caller's timeout must fire). */
  hang: boolean;
  /** When set, discovery answers 302 to this URL. */
  redirectDiscoveryTo?: string;
  /** Holds the next request to `pathname` until `release()`; `reached` resolves when it arrives (a request kept in flight). */
  pause(pathname: string): { reached: Promise<void>; release(): void };
  close(): Promise<void>;
};

const b64u = (v: string | Buffer): string => Buffer.from(v).toString('base64url');

/**
 * A minimal OIDC provider on 127.0.0.1 in Authentik's layout (issuer `/application/o/ica-hub/`, authorize, token and
 * userinfo under `/application/o/`, JWKS under the issuer) for tests: discovery, JWKS, authorize (auto-approves
 * `next`, the user the test chose), token (PKCE S256 + client secret, basic or post) and userinfo. It never talks to
 * anything else, so tests never reach a real IdP.
 */
export async function startFakeOidc(o: { clientId?: string; clientSecret?: string } = {}): Promise<FakeOidc> {
  const clientId = o.clientId ?? 'ica-hub';
  const clientSecret = o.clientSecret ?? 'fake-secret';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { user: FakeOidcUser; nonce?: string; challenge?: string; redirectUri: string }>();
  const tokens = new Map<string, FakeOidcUser>();
  const pauses = new Map<string, { arrived: () => void; gate: Promise<void> }>();
  const state: FakeOidc = {
    issuer: '', origin: '', next: { sub: 'sub-1', email: 'someone@example.com', email_verified: true, name: 'Someone' }, seen: {}, down: false, patch: {}, hang: false,
    pause(pathname) {
      let arrived!: () => void; let release!: () => void;
      const reached = new Promise<void>((r) => { arrived = r; });
      pauses.set(pathname, { arrived, gate: new Promise<void>((r) => { release = r; }) });
      return { reached, release };
    },
    close: async () => {},
  };
  const sign = (claims: Record<string, unknown>): string => {
    const head = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
    const body = b64u(JSON.stringify(claims));
    return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey, 'base64url')}`;
  };
  const claimsOf = (u: FakeOidcUser) => ({
    sub: u.sub, email: u.email, email_verified: u.email_verified ?? true, name: u.name ?? u.email, ...(u.groups ? { groups: u.groups } : {}),
  });
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', state.origin).pathname;
    const held = pauses.get(path);
    if (!held) { handle(req, res); return; }
    pauses.delete(path);
    held.arrived();
    void held.gate.then(() => { handle(req, res); });
  });
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', state.origin);
    const json = (status: number, v: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (state.down) { json(503, { error: 'unavailable' }); return; }
    if (url.pathname === '/application/o/ica-hub/.well-known/openid-configuration') {
      if (state.hang) return; // never answers: the caller's timeout must fire
      if (state.redirectDiscoveryTo) { res.writeHead(302, { location: state.redirectDiscoveryTo }); res.end(); return; }
      const o = state.origin;
      json(200, {
        issuer: state.issuer, authorization_endpoint: `${o}/application/o/authorize/`, token_endpoint: `${o}/application/o/token/`,
        userinfo_endpoint: `${o}/application/o/userinfo/`, jwks_uri: `${o}/application/o/ica-hub/jwks/`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'email', 'profile', 'groups'],
        claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'email', 'email_verified', 'name', 'preferred_username', 'groups'],
        ...state.patch,
      });
      return;
    }
    if (url.pathname === '/application/o/ica-hub/jwks/') { json(200, { keys: [jwk] }); return; }
    if (url.pathname === '/application/o/authorize/') {
      state.seen.authorize = url.searchParams;
      const redirectUri = url.searchParams.get('redirect_uri');
      if (!redirectUri) { json(400, { error: 'invalid_request' }); return; }
      const code = randomBytes(16).toString('hex');
      codes.set(code, { user: { ...state.next }, nonce: url.searchParams.get('nonce') ?? undefined, challenge: url.searchParams.get('code_challenge') ?? undefined, redirectUri });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.href });
      res.end();
      return;
    }
    if (url.pathname === '/application/o/token/' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => {
        const p = new URLSearchParams(raw);
        state.seen.token = p;
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        const [id, secret] = basic ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent) : [p.get('client_id'), p.get('client_secret')];
        const code = p.get('code') ?? '';
        const c = codes.get(code);
        if (id !== clientId || secret !== clientSecret || !c || c.redirectUri !== p.get('redirect_uri')) { json(400, { error: 'invalid_grant' }); return; }
        if (c.challenge && createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') !== c.challenge) { json(400, { error: 'invalid_grant' }); return; }
        codes.delete(code);
        const now = Math.floor(Date.now() / 1000);
        const at = randomBytes(16).toString('hex');
        tokens.set(at, c.user);
        json(200, {
          access_token: at, token_type: 'Bearer', expires_in: 300, scope: 'openid email profile',
          id_token: sign({ iss: state.issuer, aud: clientId, iat: now, exp: now + 300, ...(c.nonce ? { nonce: c.nonce } : {}), ...claimsOf(c.user) }),
        });
      });
      return;
    }
    if (url.pathname === '/application/o/userinfo/') {
      const u = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!u) { json(401, { error: 'invalid_token' }); return; }
      json(200, claimsOf(u));
      return;
    }
    json(404, { error: 'not_found' });
  };
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.issuer = `${state.origin}/application/o/ica-hub/`;
  state.close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return state;
}
