import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Strings } from './i18n.js';

export type FlashCode = keyof Strings['flash'];
export type Flash = { kind: 'success' | 'error' | 'info'; code: FlashCode; params?: Record<string, string> };
/** The one PRG exit for every admin POST: optionally sets a flash, then answers 303 See Other. */
export type SeeOther = (res: Response, path: string, f?: Flash) => void;
const NAME = 'ica-hub.flash';

/**
 * A one-shot message for the page after a POST-redirect-GET, in a short-lived HMAC-signed cookie. It is read (and
 * cleared) by the next GET under /admin; a forged or tampered cookie is dropped without a message.
 */
export function createFlash(o: { secret: string; secure: boolean }) {
  const sign = (v: string) => createHmac('sha256', o.secret).update(`flash:v1:${v}`).digest('base64url');
  const attrs = `Path=/admin; HttpOnly; SameSite=Lax${o.secure ? '; Secure' : ''}`;
  return {
    set(res: Response, f: Flash): void {
      const v = Buffer.from(JSON.stringify(f)).toString('base64url');
      res.append('Set-Cookie', `${NAME}=${v}.${sign(v)}; Max-Age=60; ${attrs}`);
    },
    read: ((req, res, next) => {
      const m = /(?:^|;\s*)ica-hub\.flash=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)(?:;|$)/.exec(req.headers.cookie ?? '');
      if (m && req.method === 'GET') {
        res.append('Set-Cookie', `${NAME}=; Max-Age=0; ${attrs}`);
        const good = sign(m[1]!);
        if (good.length === m[2]!.length && timingSafeEqual(Buffer.from(good), Buffer.from(m[2]!))) {
          try { res.locals.flash = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as Flash; } catch { /* ignore */ }
        }
      }
      next();
    }) as RequestHandler,
  };
}

export function createSeeOther(flash: { set(res: Response, f: Flash): void }): SeeOther {
  return (res, path, f) => { if (f) flash.set(res, f); res.redirect(303, path); };
}

/** Where to send a rejected form back to: the Referer's local /admin path (and query), else /admin. */
export function backPath(req: Request): string {
  try {
    const u = new URL(req.headers.referer ?? '');
    const path = `${u.pathname}${u.search}`;
    return /^\/admin(?:[/?]|$)/.test(path) ? path : '/admin';
  } catch { return '/admin'; }
}
