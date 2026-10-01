import type { OidcErrorCode } from '../../auth/oidc-policy.js';
import { s } from '../i18n.js';
import type { PageCtx } from '../page-ctx.js';
import { bare } from './layout.js';
import { button, card, copyButton, field, postForm, quip } from './components.js';
import { escapeHtml as e } from './escape.js';
import { oidcForm, type CheckView, type OidcFieldsView, type SwitchesEnv } from './settings.js';

const t = s.setup;
export type SetupSso = { label?: string; managed: 'env' | 'ui' | 'none'; ready: boolean };
/**
 * "Set up single sign-on first". `managed: 'ui'` shows the Settings page's form (posting to the setup routes); `ready`
 * (the provider is configured and loaded) adds "Continue with <label>", whose sign-in becomes the first admin.
 */
export type SetupSsoView = {
  step: 'sso'; managed: 'env' | 'ui'; fields: OidcFieldsView; switchesEnv: SwitchesEnv;
  hasLinks: boolean;
  /** `${publicUrl}/auth/callback/upstream`, to register at the IdP. */
  callbackUrl: string;
  check?: CheckView; ready?: { label: string }; oidcError?: { code: OidcErrorCode };
};
/**
 * `groupStart`: OIDC and an admin group are set in the environment, so "Continue with <label>" is offered without the
 * setup code (only an admin-group sign-in becomes the admin). `oidcError`: that sign-in failed, by code.
 */
type GroupStart = { groupStart?: { label: string }; oidcError?: { code: OidcErrorCode } };
export type SetupView = ({ step: 'code' } & GroupStart) | ({ step: 'choose'; sso: SetupSso; localLogin: boolean } & GroupStart) | SetupSsoView;

const codeStep = (ctx: PageCtx): string => `<p>${e(t.codeIntro)}</p>` + postForm(ctx, {
  action: '/admin/setup/code', className: 'stack',
  body: field({ label: t.codeLabel, name: 'code', autocomplete: 'one-time-code', required: true, hint: t.codeHint, attrs: 'maxlength="80" autocapitalize="characters" spellcheck="false"' })
    + `<div class="cluster">${button({ label: t.codeSubmit })}</div>`,
});

/** `localLogin` false (env `AUTH_LOCAL_LOGIN=false`, or a leftover UI password-off row while SSO works): the password
 * option is hidden — creating a password admin would only be signed in through a path the config already refuses. */
const chooseStep = (ctx: PageCtx, sso: SetupSso, localLogin: boolean): string => {
  const password = localLogin ? card({ title: t.passwordTitle, body: postForm(ctx, {
    action: '/admin/setup/admin', className: 'stack',
    body: field({ label: t.email, name: 'email', type: 'email', autocomplete: 'username', required: true, attrs: 'maxlength="254"' })
      + field({ label: t.name, name: 'name', autocomplete: 'name', required: true, attrs: 'maxlength="100"' })
      + field({ label: t.password, name: 'password', type: 'password', autocomplete: 'new-password', required: true, hint: t.passwordHint, attrs: 'minlength="12" maxlength="128"' })
      + field({ label: t.confirm, name: 'confirm', type: 'password', autocomplete: 'new-password', required: true, attrs: 'minlength="12" maxlength="128"' })
      + `<div class="cluster">${button({ label: t.create })}</div>`,
  }) }) : '';
  const ssoBody = sso.managed === 'env' && sso.label ? `<p>${e(t.ssoEnv(sso.label))}</p>` : `<p>${e(t.ssoIntro)}</p>`;
  const single = card({ title: t.ssoTitle, body: `${ssoBody}<p><a class="btn btn-secondary" href="/admin/setup/sso">${e(t.ssoLink)}</a></p>` });
  return `<p>${e(t.chooseIntro)}</p>${password}${single}`;
};

/** A failed OIDC sign-in's fixed message (the codes are already narrowed to OIDC_ERROR_CODES by the route). */
const oidcAlert = (v: SetupSsoView): string => {
  if (!v.oidcError) return '';
  const label = v.ready?.label ?? (v.fields.label || s.settings.ssoTitle);
  return `<p class="alert" role="alert">${e(s.login.oidcErrors[v.oidcError.code](label))}</p>`;
};

const ssoStep = (ctx: PageCtx, v: SetupSsoView): string => {
  const callback = `<div class="stack"><p><strong>${e(s.settings.callbackLabel)}</strong></p>`
    + `<div class="copy-row"><code class="wrap-anywhere">${e(v.callbackUrl)}</code>${copyButton(v.callbackUrl, s.settings.copyCallback)}</div></div>`;
  const config = v.managed === 'ui'
    ? card({ title: t.ssoTitle, body: `<p class="muted">${e(t.ssoIntro)}</p>${callback}${oidcForm(ctx, {
      action: '/admin/setup/sso', testAction: '/admin/setup/sso/test', fields: v.fields, switchesEnv: v.switchesEnv, hasLinks: v.hasLinks, check: v.check,
    })}` })
    : card({ title: t.ssoTitle, body: `<p>${e(v.ready ? t.ssoEnv(v.ready.label) : t.ssoEnvUnavailable)}</p>${callback}` });
  const finish = v.ready
    ? card({ title: t.ssoFinishTitle, body: `<p>${e(t.ssoFinish)}</p>` + postForm(ctx, { action: '/admin/setup/sso/start', body: button({ label: s.login.continueWith(v.ready.label) }) }) })
    : '';
  return oidcAlert(v) + config + finish + `<p><a class="tap-link" href="/admin/setup">${e(s.common.back)}</a></p>`;
};

/** "Continue with <label>" for the first admin, from the admin group, without the setup code (see {@link GroupStart}). */
const groupCard = (ctx: PageCtx, g: GroupStart): string => {
  if (!g.groupStart) return '';
  const label = g.groupStart.label;
  const alert = g.oidcError ? `<p class="alert" role="alert">${e(s.login.oidcErrors[g.oidcError.code](label))}</p>` : '';
  return alert + card({ title: t.groupTitle, body: `<p>${e(t.groupIntro(label))}</p>`
    + postForm(ctx, { action: '/admin/setup/group', body: button({ label: s.login.continueWith(label) }) }) });
};

/** First-run setup: outside the shell (nobody is signed in), with the mascot and one playful Swedish line. */
export function setupPage(ctx: PageCtx, v: SetupView): string {
  const step = v.step === 'code' ? groupCard(ctx, v) + codeStep(ctx) : v.step === 'choose' ? groupCard(ctx, v) + chooseStep(ctx, v.sso, v.localLogin) : ssoStep(ctx, v);
  return bare(ctx, { title: t.title, hero: true, body: quip(s.brand.setupWelcome) + step });
}
