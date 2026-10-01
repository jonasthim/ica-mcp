import { s } from '../i18n.js';
import type { PageCtx } from '../page-ctx.js';
import { bare } from './layout.js';
import { button, field, postForm } from './components.js';
import { escapeHtml as e } from './escape.js';
import type { OidcErrorCode } from '../../auth/oidc-policy.js';

/**
 * The only errors the login page shows, keyed by the `?error=` code. The page never renders the query value itself,
 * so a crafted link cannot put attacker text ("call this number…") on our own sign-in page; unknown codes show nothing.
 */
export const LOGIN_ERRORS = s.login.errors;
export type LoginErrorCode = keyof typeof LOGIN_ERRORS;
const loginErrorMessage = (code: string | undefined): string | undefined =>
  code && Object.hasOwn(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code as LoginErrorCode] : undefined;

/** A failed OIDC sign-in's fixed message; an unknown code reads as a plain failure. Only `not_invited` uses `email`. */
const oidcErrorMessage = (e: { code: string; email?: string }, label: string): string => {
  const known = Object.hasOwn(s.login.oidcErrors, e.code) ? (e.code as OidcErrorCode) : 'failed';
  return s.login.oidcErrors[known](label, e.email);
};

/**
 * Sign in: "Continue with <IdP>" first and full width when OIDC is configured, then a divider and the local form
 * (both omitted when local login is off). `oidcError` is a failed OIDC sign-in, by code, with the refused email when
 * the server still holds it (never taken from the query).
 */
export function loginPage(ctx: PageCtx, o: {
  oauthQuery: string; oidcLabel: string | undefined; localLogin: boolean; error: string | undefined;
  oidcError?: { code: string; email?: string }; next?: string | undefined;
  /** The query names a known OAuth client: show that sign-in continues connecting it. */
  continuingApp?: boolean;
}): string {
  const error = o.oidcError ? oidcErrorMessage(o.oidcError, o.oidcLabel ?? s.profile.sso) : loginErrorMessage(o.error);
  const oauth = `<input type="hidden" name="oauth_query" value="${e(o.oauthQuery)}">`;
  const oidc = o.oidcLabel
    ? postForm(ctx, { action: '/admin/login/oidc', className: 'stack', body: `${oauth}${button({ label: s.login.continueWith(o.oidcLabel) })}` })
    : '';
  const divider = oidc && o.localLogin ? `<p class="divider">${s.login.or}</p>` : '';
  const local = o.localLogin
    ? postForm(ctx, {
      action: '/admin/login', className: 'stack',
      body: `${oauth}${o.next ? `<input type="hidden" name="next" value="${e(o.next)}">` : ''}`
        + field({ label: s.login.email, name: 'email', type: 'email', autocomplete: 'username', required: true, attrs: 'inputmode="email"' })
        + field({ label: s.login.password, name: 'password', type: 'password', autocomplete: 'current-password', required: true })
        + button({ label: s.login.submit, kind: o.oidcLabel ? 'secondary' : 'primary' }),
    })
    : '';
  const toast = error ? `<div class="toast toast--error" role="alert">${e(error)}</div>` : '';
  const hint = o.oauthQuery && o.continuingApp ? `<p class="muted">${s.login.oauthHint}</p>` : '';
  return bare(ctx, { title: s.login.title, hero: true, body: `${toast}${hint}${oidc}${divider}${local}` });
}
