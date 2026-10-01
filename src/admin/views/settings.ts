import { DEFAULT_OIDC_LABEL } from '../../config.js';
import type { SettingsProblem } from '../../settings/effective.js';
import type { CheckId, CheckStatus } from '../../settings/oidc-check.js';
import { s } from '../i18n.js';
import type { PageCtx } from '../page-ctx.js';
import { shell } from './layout.js';
import { badge, button, card, copyButton, field, postForm } from './components.js';
import { escapeHtml as e } from './escape.js';

const t = s.settings;

/**
 * The single sign-on form's values. Never the client secret: only whether a usable one is stored (`secret`), and
 * whether the admin typed one into the form that was tested (`secretTyped`) — it was not kept, so it must be typed again.
 */
export type OidcFieldsView = {
  issuerUrl: string; clientId: string; label: string; linkByEmail: boolean; adminGroup: string; memberGroup: string;
  secret: 'none' | 'stored' | 'unreadable'; secretTyped?: boolean;
};
/** Which switches the environment decides (shown read-only, never as inputs). */
export type SwitchesEnv = { linkByEmail: boolean; adminGroup: boolean; memberGroup: boolean };
export type CheckRowView = { id: CheckId; status: CheckStatus; code?: string };
/** A connection test's result, for the issuer it tested. */
export type CheckView = { issuerUrl: string; ok: boolean; rows: CheckRowView[] };
/** What {@link oidcForm} needs; the setup wizard (Task 7) renders the same form with its own actions. */
export type OidcFormView = {
  action: string; testAction: string; fields: OidcFieldsView;
  /** Switches the environment decides: shown read-only (from `fields`), never as inputs. */
  switchesEnv: SwitchesEnv;
  /** Some account is linked to the current issuer: a new issuer needs the unlink acknowledgement. */
  hasLinks: boolean;
  /** The last connection test; shown when it tested the issuer in `fields`. */
  check?: CheckView;
};
export type SettingsView = {
  problems: readonly SettingsProblem[];
  /** `${publicUrl}/auth/callback/upstream`, to register at the IdP. */
  callbackUrl: string;
  oidc: {
    managed: 'env' | 'ui'; fields: OidcFieldsView; switchesEnv: SwitchesEnv;
    /** Configured and loaded (the sign-in page offers it). */
    active: boolean;
    /** A configuration exists (env, or a stored row). */
    configured: boolean;
    hasLinks: boolean;
  };
  check?: CheckView;
  /** Settings only, when a group is configured: what the viewing admin's latest sign-in sent (see auth/seen-groups.ts). */
  groupsSeen?: GroupsSeenView;
  signIn: { localLogin: boolean; managed: 'env' | 'ui'; activeAdmins: number; adminsWithOidc: number };
};

/**
 * `known` false: the viewing admin's groups are unknown (then no name has `sent`). Only the configured names are ever
 * in the view, never the other groups the admin was seen with.
 */
export type GroupsSeenView = { label: string; known: boolean; configured: { name: string; sent?: boolean }[] };

const TONE: Record<CheckStatus, 'ok' | 'warn' | 'bad'> = { pass: 'ok', warn: 'warn', fail: 'bad' };
const yesNo = (v: boolean): string => (v ? t.yes : t.no);

/** A check's fixed detail sentence: only known codes render (`http_<n>` with its number); anything else, nothing. */
function detail(code: string | undefined): string {
  if (!code) return '';
  const http = /^http_(\d{3})$/.exec(code);
  if (http) return t.checkDetails.http(http[1]!);
  if (code === 'http' || !Object.hasOwn(t.checkDetails, code)) return '';
  return t.checkDetails[code as Exclude<keyof typeof t.checkDetails, 'http'>];
}

/** The connection test's results: one row per check with its status badge, label and detail sentence. */
export function checkResults(c: CheckView): string {
  const rows = c.rows.map((r) => {
    const d = detail(r.code);
    return `<li>${badge(TONE[r.status], t.checkStatus[r.status])}<span><strong>${e(t.checks[r.id])}</strong>${d ? ` <span class="muted">${e(d)}</span>` : ''}</span></li>`;
  }).join('');
  return `<section class="stack check-results" aria-labelledby="check-title"><h3 id="check-title">${t.checkTitle}</h3>`
    + `<p>${badge(c.ok ? 'ok' : 'bad', c.ok ? t.checkStatus.pass : t.checkStatus.fail)} ${e(c.ok ? t.checkPassed : t.checkFailed)}</p>`
    + `<ul class="checklist" aria-live="polite">${rows}</ul></section>`;
}

/** A secret typed into a tested form was not kept: ask for it again, whatever is stored. */
const secretHint = (f: OidcFieldsView): string =>
  f.secretTyped ? t.secretRetype : f.secret === 'stored' ? t.secretStored : f.secret === 'unreadable' ? t.secretUnreadable : t.secretRequired;

let checkSeq = 0;
/** A labelled checkbox with an optional hint (the whole row is the tap target). */
function checkbox(o: { name: string; label: string; checked: boolean; hint?: string }): string {
  const id = `c-${o.name}-${++checkSeq}`;
  const hint = o.hint ? `<p class="field-hint" id="${id}-hint">${e(o.hint)}</p>` : '';
  return `<div class="field"><div class="check"><input type="checkbox" id="${id}" name="${e(o.name)}"${o.checked ? ' checked' : ''}${o.hint ? ` aria-describedby="${id}-hint"` : ''}>`
    + `<label for="${id}">${e(o.label)}</label></div>${hint}</div>`;
}
const readOnly = (label: string, value: string): string =>
  `<p class="wrap-anywhere"><strong>${e(label)}:</strong> ${e(value)} <span class="muted">(${e(t.envNote)})</span></p>`;

/**
 * The single sign-on form: issuer, client id, write-only secret, label, the two switches (read-only when the
 * environment decides them), the unlink acknowledgement when links exist, and Test connection / Save. A pure
 * function of its view, so the setup wizard reuses it. The secret input never has a value: blank keeps the stored one.
 */
export function oidcForm(ctx: PageCtx, o: OidcFormView): string {
  const f = o.fields;
  const body = field({ label: t.issuerUrl, name: 'issuer_url', type: 'url', value: f.issuerUrl, required: true, hint: t.issuerHint, attrs: 'inputmode="url" maxlength="500" spellcheck="false" autocapitalize="off"' })
    + field({ label: t.clientId, name: 'client_id', value: f.clientId, required: true, attrs: 'maxlength="200" spellcheck="false" autocapitalize="off"' })
    + field({ label: t.clientSecret, name: 'client_secret', type: 'password', autocomplete: 'new-password', required: f.secret !== 'stored', hint: secretHint(f), attrs: 'maxlength="500"' })
    + field({ label: t.label, name: 'label', value: f.label, hint: t.labelHint, attrs: 'maxlength="40"' })
    + (o.switchesEnv.linkByEmail ? readOnly(t.linkByEmail, yesNo(f.linkByEmail)) : checkbox({ name: 'link_by_email', label: t.linkByEmail, checked: f.linkByEmail, hint: t.linkByEmailHint }))
    + `<p class="muted">${e(t.groupsIntro)}</p>`
    + (o.switchesEnv.adminGroup ? readOnly(t.adminGroup, f.adminGroup || t.none) : field({ label: t.adminGroup, name: 'admin_group', value: f.adminGroup, hint: t.adminGroupHint(f.label || DEFAULT_OIDC_LABEL), attrs: 'maxlength="100" spellcheck="false" autocapitalize="off"' }))
    + (o.switchesEnv.memberGroup ? readOnly(t.memberGroup, f.memberGroup || t.none) : field({ label: t.memberGroup, name: 'member_group', value: f.memberGroup, hint: t.memberGroupHint, attrs: 'maxlength="100" spellcheck="false" autocapitalize="off"' }))
    + (o.hasLinks ? checkbox({ name: 'unlink_ack', label: t.unlinkAck, checked: false }) : '')
    + `<div class="cluster">${button({ kind: 'secondary', label: t.test, attrs: `formaction="${e(o.testAction)}" formnovalidate` })}${button({ label: t.save })}</div>`;
  const results = o.check && o.check.issuerUrl === f.issuerUrl ? checkResults(o.check) : '';
  return postForm(ctx, { action: o.action, className: 'stack', body }) + results;
}

/** The groups the viewing admin's latest sign-in sent, and whether each configured group was among them. */
function groupsSeenPanel(g: GroupsSeenView | undefined): string {
  if (!g) return '';
  if (!g.known) return `<p class="alert">${e(t.groupsUnchecked(g.label))}</p>`;
  const rows = g.configured.map((c) => `<li><code class="wrap-anywhere">${e(c.name)}</code> `
    + `${c.sent ? badge('ok', t.groupSent) : badge('bad', t.groupNotSent)}</li>`).join('');
  return `<section class="stack" aria-labelledby="groups-seen-title"><h3 id="groups-seen-title">${e(t.groupsSeenTitle)}</h3>`
    + `<p class="wrap-anywhere">${e(t.groupsSeen(g.label))}</p><ul class="checklist">${rows}</ul></section>`;
}

function ssoCard(ctx: PageCtx, v: SettingsView): string {
  const o = v.oidc;
  const state = o.active ? badge('ok', t.state.active) : o.configured ? badge('bad', t.state.broken) : badge('neutral', t.state.off);
  const callback = `<div class="stack"><p><strong>${t.callbackLabel}</strong></p>`
    + `<div class="copy-row"><code class="wrap-anywhere">${e(v.callbackUrl)}</code>${copyButton(v.callbackUrl, t.copyCallback)}</div></div>`;
  if (o.managed === 'env') {
    const f = o.fields;
    // Env-managed: read-only, and the secret is a fixed mask — never derived from the secret itself.
    const kv = `<dl class="kv"><dt>${t.issuerUrl}</dt><dd class="wrap-anywhere">${e(f.issuerUrl)}</dd><dt>${t.clientId}</dt><dd class="wrap-anywhere">${e(f.clientId)}</dd>`
      + `<dt>${t.clientSecret}</dt><dd>${t.secretMasked} <span class="muted">${t.secretEnv}</span></dd><dt>${t.label}</dt><dd class="wrap-anywhere">${e(f.label)}</dd>`
      + `<dt>${t.linkByEmail}</dt><dd>${yesNo(f.linkByEmail)}</dd><dt>${t.adminGroup}</dt><dd class="wrap-anywhere">${e(f.adminGroup || t.none)}</dd>`
      + `<dt>${t.memberGroup}</dt><dd class="wrap-anywhere">${e(f.memberGroup || t.none)}</dd></dl><p class="muted">${e(t.groupsIntro)}</p>`;
    return `<div id="sso">${card({ title: t.ssoTitle, aside: state, body: `<p class="muted">${e(t.envNote)}</p>${kv}${groupsSeenPanel(v.groupsSeen)}${callback}` })}</div>`;
  }
  const form = oidcForm(ctx, { action: '/admin/settings/oidc', testAction: '/admin/settings/oidc/test', fields: o.fields, switchesEnv: o.switchesEnv, hasLinks: o.hasLinks, check: v.check });
  const remove = o.configured
    ? postForm(ctx, { action: '/admin/settings/oidc/remove', confirm: t.askRemove, confirmField: 'confirm', body: button({ label: t.remove, kind: 'danger' }) })
    : '';
  return `<div id="sso">${card({ title: t.ssoTitle, aside: state, body: `<p class="muted">${e(t.ssoIntro)}</p>${callback}${groupsSeenPanel(v.groupsSeen)}${form}`, ...(remove ? { footer: remove } : {}) })}</div>`;
}

function signInCard(ctx: PageCtx, v: SettingsView['signIn']): string {
  if (v.managed === 'env') return card({ title: t.signInTitle, body: `<p>${e(t.localLoginEnv(v.localLogin))}</p><p class="muted">${e(t.envNote)}</p>` });
  const form = postForm(ctx, {
    action: '/admin/settings/sign-in', className: 'stack',
    body: checkbox({ name: 'local_login', label: t.localLogin, checked: v.localLogin, hint: t.localLoginHint(v.adminsWithOidc, v.activeAdmins) })
      + `<div class="cluster">${button({ label: t.saveSignIn })}</div>`,
  });
  return card({ title: t.signInTitle, body: form });
}

function problemCard(ctx: PageCtx, code: SettingsProblem): string {
  const retry = code === 'oidc_unreachable' ? postForm(ctx, { action: '/admin/settings/reload', body: button({ label: t.retry, kind: 'secondary' }) }) : '';
  return card({ tone: 'warn', title: t.problemTitle, body: `<p>${e(t.problems[code])}</p>`, ...(retry ? { footer: retry } : {}) });
}

/** Settings (admins): problems first, then Single sign-on and Sign-in methods. */
export function settingsPage(ctx: PageCtx, v: SettingsView): string {
  const body = v.problems.map((p) => problemCard(ctx, p)).join('') + ssoCard(ctx, v) + signInCard(ctx, v.signIn);
  return shell(ctx, { title: t.title, nav: 'settings', body });
}

/** The no-JS confirmation step for Remove single sign-on (with JS the dialog asks and adds confirm=yes). */
export function settingsConfirmPage(ctx: PageCtx): string {
  const form = postForm(ctx, {
    action: '/admin/settings/oidc/remove', className: 'cluster',
    body: `<input type="hidden" name="confirm" value="yes">${button({ label: t.remove, kind: 'danger' })}<a class="btn btn-secondary" href="/admin/settings">${s.common.cancel}</a>`,
  });
  return shell(ctx, { title: t.title, nav: 'settings', body: card({ tone: 'bad', title: t.removeConfirm.title, body: `<p>${e(t.removeConfirm.body)}</p>${form}` }) });
}
