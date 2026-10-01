import type { RequestHandler } from 'express';

/**
 * Better Auth endpoints reachable over HTTP, relative to `/auth`. Everything else (admin plugin, session/account
 * management, password change, consent and client management, sign-in/up) is called only server-side by the admin UI,
 * behind its same-origin, CSRF, role and audit checks. New endpoints from a Better Auth upgrade are therefore closed by
 * default. The two `/.well-known/*` rows are Better Auth's own metadata documents under its base path.
 */
export const PUBLIC_AUTH_ROUTES = [
  { method: 'GET', path: '/jwks' },
  { method: 'GET', path: '/.well-known/oauth-authorization-server' }, { method: 'GET', path: '/.well-known/openid-configuration' },
  { method: 'GET', path: '/oauth2/authorize' }, { method: 'POST', path: '/oauth2/authorize' },
  { method: 'POST', path: '/oauth2/token' }, { method: 'POST', path: '/oauth2/register' },
  { method: 'GET', path: '/oauth2/userinfo' }, { method: 'POST', path: '/oauth2/userinfo' },
  { method: 'POST', path: '/oauth2/revoke' }, { method: 'POST', path: '/oauth2/introspect' },
  { method: 'GET', path: '/oauth2/end-session' }, { method: 'POST', path: '/oauth2/end-session' },
  { method: 'GET', path: '/callback/:id' }, { method: 'POST', path: '/callback/:id' },
  { method: 'GET', path: '/ok' }, { method: 'GET', path: '/error' },
] as const satisfies readonly { method: 'GET' | 'POST'; path: string }[];

/** The discovery documents served at the site root (RFC 9728 protected resource, RFC 8414 path-suffixed AS metadata). */
export const PUBLIC_WELL_KNOWN = [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server/auth',
] as const;

const patterns = [
  ...PUBLIC_AUTH_ROUTES.map((r) => ({ method: r.method as string, re: new RegExp(`^/auth${r.path.replace(/\./g, '\\.').replace(/:(\w+)/g, '[^/]+')}$`) })),
  ...PUBLIC_WELL_KNOWN.map((p) => ({ method: 'GET', re: new RegExp(`^${p.replace(/\./g, '\\.')}$`) })),
];

/**
 * Mounted on `/auth` and `/.well-known`: lets an allow-listed request through to Better Auth, answers 404 otherwise.
 * Better Auth routes on the WHATWG-normalised URL (`..`, `%2e%2e` resolved, `\` read as `/`), so the check runs on
 * exactly that path, and any request whose raw path differs from it, or carries `\` or any percent-escape (no
 * public endpoint needs one), is refused outright. Matching is case-sensitive and anchored, so `//`, a trailing
 * slash or another case never reaches Better Auth's own router either.
 */
export function publicAuthSurface(publicUrl: string): RequestHandler {
  return (req, res, next) => {
    const notFound = () => { res.status(404).json({ error: 'not_found' }); };
    const raw = req.originalUrl.split('?')[0]!;
    if (!raw.startsWith('/') || raw.startsWith('//') || /[\\%#]/.test(raw)) { notFound(); return; }
    let normalised: string;
    try { normalised = new URL(req.originalUrl, publicUrl).pathname; } catch { notFound(); return; }
    if (normalised !== raw) { notFound(); return; }
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (!patterns.some((p) => p.method === method && p.re.test(normalised))) { notFound(); return; }
    next();
  };
}
