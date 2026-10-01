import type { NextFunction, Request, Response } from 'express';
import type { AssetManifest } from './assets.js';
import type { AdminSession } from './session.js';
import type { Flash } from './flash.js';
import { roleOf, type Role } from '../auth/roles.js';

export type Theme = 'light' | 'dark' | 'system';
export type NavKey = 'home' | 'ica' | 'apps' | 'users' | 'activity' | 'settings' | 'profile';
export type PageUser = { id: string; name: string; email: string; role: Role };
export type PageCtx = { nonce: string; assets: AssetManifest; csrf: string; theme: Theme; user?: PageUser; flash?: Flash };

export const THEME_COOKIE = 'ica-hub.theme';
export const isTheme = (v: unknown): v is Theme => v === 'light' || v === 'dark' || v === 'system';
export const themeOf = (cookieHeader: string | undefined): Theme => {
  const m = /(?:^|;\s*)ica-hub\.theme=(light|dark|system)(?:;|$)/.exec(cookieHeader ?? '');
  return (m?.[1] as Theme | undefined) ?? 'system';
};

export function pageCtx(res: Response): PageCtx {
  const l = res.locals as { cspNonce: string; csrf?: string; theme?: Theme; pageUser?: PageUser; flash?: Flash };
  return {
    nonce: l.cspNonce, assets: res.app.locals.assets as AssetManifest, csrf: l.csrf ?? '', theme: l.theme ?? 'system',
    ...(l.pageUser ? { user: l.pageUser } : {}), ...(l.flash ? { flash: l.flash } : {}),
  };
}

/**
 * Sets what every page needs: `res.locals.theme` from the theme cookie and, when signed in (the session `loadSession`
 * put on `res.locals.session`), `res.locals.pageUser` (role from Better Auth's `user.role`).
 */
export function pageLocals() {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.locals.theme = themeOf(req.headers.cookie);
    const s = res.locals.session as AdminSession | null | undefined;
    if (s) res.locals.pageUser = { id: s.user.id, name: s.user.name, email: s.user.email, role: roleOf(s.user) } satisfies PageUser;
    next();
  };
}
