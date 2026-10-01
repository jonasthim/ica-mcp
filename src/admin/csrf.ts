import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { AdminSession } from './session.js';

export const CSRF_FIELD = '_csrf';
export const CSRF_COOKIE = 'ica-hub.csrf';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const cookieValue = (header: string | undefined): string | undefined => /(?:^|;\s*)ica-hub\.csrf=([A-Za-z0-9_-]{43})(?:;|$)/.exec(header ?? '')?.[1];

/**
 * Synchronizer tokens for every admin form, on top of the same-origin check. A random per-browser cookie (32 bytes)
 * plus the Better Auth session id are MACed with the server secret: the token only verifies for the same browser and
 * the same session, so a token scraped before sign-in (or from another browser) is refused afterwards.
 * Token = base64url(HMAC-SHA256(secret, `csrf:v1:<cookie>:<session id or ''>`)).
 */
export function createCsrf(o: { secret: string; secure: boolean; onReject: (req: Request, res: Response) => void }) {
  const tokenFor = (cookie: string, sessionId: string | undefined): string =>
    createHmac('sha256', o.secret).update(`csrf:v1:${cookie}:${sessionId ?? ''}`).digest('base64url');
  const sessionIdOf = (locals: Record<string, unknown>): string | undefined => (locals.session as AdminSession | null | undefined)?.session.id;

  /** Ensures the browser has the random cookie and puts this request's token on `res.locals.csrf` for the forms. */
  const issue: RequestHandler = (req, res, next) => {
    let c = cookieValue(req.headers.cookie);
    if (!c) {
      c = randomBytes(32).toString('base64url');
      res.append('Set-Cookie', `${CSRF_COOKIE}=${c}; Path=/admin; HttpOnly; SameSite=Lax${o.secure ? '; Secure' : ''}`);
    }
    res.locals.csrf = tokenFor(c, sessionIdOf(res.locals));
    next();
  };

  /** Every non-GET/HEAD must carry the token for this browser and session; otherwise `onReject` answers and nothing changes. */
  const verify: RequestHandler = (req, res, next) => {
    if (SAFE.has(req.method)) { next(); return; }
    const c = cookieValue(req.headers.cookie);
    const field = (req.body as Record<string, unknown> | undefined)?.[CSRF_FIELD];
    const sent = typeof field === 'string' ? field : '';
    const want = c ? tokenFor(c, sessionIdOf(res.locals)) : '';
    const ok = c !== undefined && sent.length === want.length && timingSafeEqual(Buffer.from(sent), Buffer.from(want));
    if (ok) { next(); return; }
    o.onReject(req, res);
  };
  return { issue, verify, tokenFor };
}
