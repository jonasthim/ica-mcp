import type { Request } from 'express';
import type { Config } from '../config.js';
import { CLIENT_IP_HEADER } from '../auth/index.js';

/**
 * The headers Better Auth needs from a form POST: the session cookie, and UA/IP for the session row. The IP is Express's
 * `req.ip` (which honours TRUST_PROXY), never the client's own X-Forwarded-For. `accept: text/html` marks a navigation.
 * `origin` is our own public URL: only set for requests that already passed the admin router's same-origin check, and
 * required because Better Auth rejects a cookie-bearing POST without an Origin (MISSING_OR_NULL_ORIGIN), which would
 * otherwise break a second login or a login with a stale session cookie.
 */
function authHeaders(req: Request, origin: string): Headers {
  const h = new Headers({ accept: 'text/html', origin });
  for (const k of ['cookie', 'user-agent']) { const v = req.headers[k]; if (typeof v === 'string') h.set(k, v); }
  if (req.ip) h.set(CLIENT_IP_HEADER, req.ip);
  return h;
}

/**
 * Better Auth call options for a form POST. The oauth-provider plugin resumes the authorize flow inside the sign-in /
 * consent call and requires `ctx.request` for that, which a bare `auth.api.*` call does not set, so pass a Request.
 */
export function authCall(config: Config, req: Request, path: string): { headers: Headers; request: globalThis.Request; asResponse: true } {
  const headers = authHeaders(req, config.publicUrl);
  return { headers, request: new globalThis.Request(`${config.authIssuer}${path}`, { method: 'POST', headers }), asResponse: true };
}
