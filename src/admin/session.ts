import type { NextFunction, Request, Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import type { Auth } from '../auth/index.js';
import { errorPage } from './views/index.js';
import { pageCtx } from './page-ctx.js';
import { roleOf } from '../auth/roles.js';

export type AdminSession = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;

/**
 * Better Auth's session for the request, forwarding the Set-Cookie it answers with: when the session is past its
 * update age, getSession extends it in the database and re-issues the session cookie (sliding sessions); for an
 * expired or unknown session it expires the cookie. Without forwarding, the browser's cookie would keep its first
 * Max-Age and lapse after 7 days however active the user was.
 */
/** Anything that hands out the Better Auth instance in use (the AuthHolder); read per request, never cached. */
export type AuthRef = { readonly current: Auth };

async function sessionOf(ref: AuthRef, req: Request, res: Response): Promise<AdminSession | null> {
  const { headers, response } = await ref.current.api.getSession({ headers: fromNodeHeaders(req.headers), returnHeaders: true });
  for (const c of headers.getSetCookie()) res.append('Set-Cookie', c);
  return response ?? null;
}

/** Looks the Better Auth session up once per request: `res.locals.session` is the session or `null`. */
export function loadSession(ref: AuthRef) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    res.locals.session = await sessionOf(ref, req, res);
    next();
  };
}

const toLogin = (req: Request, res: Response): void => { res.redirect(302, `/admin/login?${new URLSearchParams({ next: req.originalUrl })}`); };

/** Redirects to the login page (remembering where to come back to) unless the request carries a Better Auth session. */
export function requireSession(ref: AuthRef) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // `loadSession` has already looked the session up (null = none); only ask Better Auth when it has not run.
    const s = res.locals.session === undefined ? await sessionOf(ref, req, res) : res.locals.session as AdminSession | null;
    if (!s) { toLogin(req, res); return; }
    res.locals.session = s;
    next();
  };
}

/** Admin-only routes: the login page without a session, the styled 403 page unless Better Auth's `user.role` is admin. */
export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  const s = res.locals.session as AdminSession | null | undefined;
  if (!s) { toLogin(req, res); return; }
  if (roleOf(s.user) !== 'admin') { res.status(403).type('html').send(errorPage(pageCtx(res), { status: 403, code: 'forbidden' })); return; }
  next();
};

/** The target of a Better Auth JSON redirect (`{ redirect: true, url }`), which several endpoints answer instead of a 302. */
async function jsonRedirectUrl(r: globalThis.Response): Promise<string | undefined> {
  if (!(r.headers.get('content-type') ?? '').includes('application/json')) return undefined;
  const j: unknown = await r.clone().json().catch(() => null);
  if (j && typeof j === 'object' && 'redirect' in j && j.redirect === true && 'url' in j && typeof j.url === 'string' && j.url) return j.url;
  return undefined;
}

/**
 * Copy a Better Auth Response onto the Express response as a browser navigation: Set-Cookie always; then a 302 to its
 * Location, or to the `url` of a JSON `{ redirect: true, url }` body (oauth2Consent always answers that way, even for
 * `accept: text/html`), or to `fallbackRedirect` on any other success. Errors are passed through as plain text.
 */
export async function forwardAuthResponse(res: Response, r: globalThis.Response, fallbackRedirect: string): Promise<void> {
  for (const c of r.headers.getSetCookie()) res.append('Set-Cookie', c);
  const loc = r.headers.get('location');
  if (loc) { res.redirect(r.status >= 300 && r.status < 400 ? r.status : 302, loc); return; }
  if (r.ok) { res.redirect(302, (await jsonRedirectUrl(r)) ?? fallbackRedirect); return; }
  res.status(r.status).type('text/plain').send(await r.text());
}
