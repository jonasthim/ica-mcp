import { s } from '../i18n.js';
import type { PageCtx, Theme } from '../page-ctx.js';
import { shell } from './layout.js';
import { badge, button, card, field, postForm, themeForm } from './components.js';
import { escapeHtml as e } from './escape.js';
import { timeTag } from './status.js';
import { auditEventList, type ActivityView } from './activity.js';

const t = s.profile;

/** One signed-in device. `id` is the session row's id: the session token never reaches the page. */
export type SessionView = { id: string; device: string; ip: string | null; lastSeenAt: string; createdAt: string; current: boolean };
export type ProfileView = {
  name: string; email: string; methods: { providerId: string; label: string }[]; canChangePassword: boolean; theme: Theme;
  sessions: SessionView[]; activity: ActivityView['rows'];
  /** The account has a password (a local account): its current password is required to change the email. */
  hasPassword: boolean;
  /** An admin's own change is vouched for; a member's waits for an admin before single sign-on can link to it. */
  isAdmin: boolean;
  /** The member changed their email themselves and no admin has confirmed it yet. */
  emailUnconfirmed: boolean;
  /** Sessions beyond the listed ones (the list is capped). */
  moreSessions?: number;
};

const strengthAttrs = Object.entries(s.invite.strength).map(([k, text]) => `data-${k}="${e(text)}"`).join(' ');

function nameCard(ctx: PageCtx, v: ProfileView): string {
  const form = postForm(ctx, {
    action: '/admin/profile/name', className: 'stack',
    body: field({ label: t.name, name: 'name', value: v.name, autocomplete: 'name', required: true, hint: t.nameHint, attrs: 'maxlength="100"' })
      + `<div class="cluster">${button({ label: t.saveName, kind: 'secondary' })}</div>`,
  });
  return card({ title: t.nameTitle, body: form });
}

/**
 * The account email. A local account confirms a change with its current password; a single-sign-on-only account has
 * none to give (spec: "requires current password if local"), so it gets no password field. The anchor `#email` is
 * where the Users page sends an admin for their own email.
 */
function emailCard(ctx: PageCtx, v: ProfileView): string {
  const aside = v.emailUnconfirmed ? { aside: badge('warn', t.emailUnconfirmed) } : {};
  const password = v.hasPassword
    // The account for password managers, as in the password form; not read by the route.
    ? `<input type="email" name="username" autocomplete="username" value="${e(v.email)}" hidden readonly>`
      + field({ label: t.currentPassword, name: 'current', type: 'password', autocomplete: 'current-password', required: true, attrs: 'maxlength="128"' })
    : '';
  const form = postForm(ctx, {
    action: '/admin/profile/email', className: 'stack',
    body: field({
      label: t.emailLabel, name: 'email', type: 'email', value: v.email, autocomplete: 'email', required: true,
      ...(v.isAdmin ? {} : { hint: t.emailMemberHint }), attrs: 'inputmode="email" maxlength="254"',
    })
      + password + `<div class="cluster">${button({ label: t.saveEmail, kind: 'secondary' })}</div>`,
  });
  return `<div id="email">${card({ title: t.emailTitle, ...aside, body: `<p class="muted">${e(t.emailIntro)}</p>${form}` })}</div>`;
}

function methodsCard(v: ProfileView): string {
  const items = v.methods.length
    ? `<ul class="plain-list">${v.methods.map((m) => `<li class="wrap-anywhere">${e(m.label)}</li>`).join('')}</ul>`
    : `<p class="muted">${t.noMethods}</p>`;
  return card({ title: t.methodsTitle, body: `<p class="muted">${t.methodsIntro}</p>${items}` });
}

function sessionItem(ctx: PageCtx, x: SessionView): string {
  const here = x.current ? badge('ok', t.thisDevice) : '';
  const out = x.current ? '' : postForm(ctx, {
    action: `/admin/profile/sessions/${encodeURIComponent(x.id)}/revoke`, confirm: t.signOutSession(x.device),
    body: button({ label: t.signOut, kind: 'secondary' }),
  });
  return `<li class="session"${x.current ? ' data-current' : ''}><div class="session-head"><h3 class="wrap-anywhere">${e(x.device)}</h3>${here}</div>`
    + `<dl class="kv"><dt>${t.ip}</dt><dd>${x.ip ? e(x.ip) : e(s.common.unknown)}</dd>`
    + `<dt>${t.lastSeen}</dt><dd>${timeTag(x.lastSeenAt)}</dd><dt>${t.signedIn}</dt><dd>${timeTag(x.createdAt)}</dd></dl>${out}</li>`;
}

function sessionsCard(ctx: PageCtx, v: ProfileView): string {
  const list = `<ul class="session-list" aria-label="${e(t.sessionsCaption)}">${v.sessions.map((x) => sessionItem(ctx, x)).join('')}</ul>`
    + (v.moreSessions ? `<p class="muted">${e(t.moreSessions(v.moreSessions))}</p>` : '');
  const others = postForm(ctx, { action: '/admin/profile/sessions/revoke-others', confirm: t.askOthers, body: button({ label: t.signOutOthers, kind: 'secondary' }) });
  const everywhere = postForm(ctx, { action: '/admin/profile/sessions/revoke-all', confirm: t.askEverywhere, body: button({ label: t.signOutEverywhere, kind: 'danger' }) });
  return card({
    title: t.sessionsTitle,
    body: `<p class="muted">${e(t.sessionsIntro)}</p>${list}`,
    footer: `<div class="stack"><div class="cluster">${others}${everywhere}</div><p class="muted small">${e(t.everywhereHint)}</p></div>`,
  });
}

function passwordCard(ctx: PageCtx): string {
  const form = postForm(ctx, {
    action: '/admin/profile/password', className: 'stack',
    // The account for password managers (Chrome warns about a password form without one); not read by the route.
    body: `<input type="email" name="username" autocomplete="username" value="${e(ctx.user?.email ?? '')}" hidden readonly>`
      + field({ label: t.currentPassword, name: 'current', type: 'password', autocomplete: 'current-password', required: true, attrs: 'maxlength="128"' })
      + field({
        label: t.newPassword, name: 'password', type: 'password', autocomplete: 'new-password', required: true, hint: t.passwordHint,
        attrs: 'minlength="12" maxlength="128" data-strength="profile-pw-hint"',
      })
      + `<p id="profile-pw-hint" class="field-hint" aria-live="polite" ${strengthAttrs}></p>`
      + field({ label: t.confirmPassword, name: 'confirm', type: 'password', autocomplete: 'new-password', required: true, attrs: 'minlength="12" maxlength="128"' })
      + `<p class="muted small">${e(t.passwordNote)}</p><div class="cluster">${button({ label: t.savePassword, kind: 'secondary' })}</div>`,
  });
  return card({ title: t.passwordTitle, body: form });
}

function activityCard(v: ProfileView): string {
  return card({
    title: t.activityTitle,
    body: `<div id="profile-activity">${v.activity.length ? auditEventList(v.activity, { compact: true }) : `<p class="muted">${e(t.activityEmpty)}</p>`}</div>`,
  });
}

/**
 * Profile & security: who you are, your email, how you sign in, this device's theme, your signed-in devices (sign out one, the
 * others, or everywhere including Claude), the password (local accounts only) and your own recent activity — without
 * the IP/user-agent columns, which stay on the admin-only Activity page.
 */
export function profilePage(ctx: PageCtx, v: ProfileView): string {
  const id = `<section class="card profile-id"><h2 class="wrap-anywhere">${e(v.name || v.email)}</h2><p class="wrap-anywhere muted">${e(v.email)}</p></section>`;
  const appearance = card({ title: t.appearanceTitle, body: `<p class="muted">${e(t.appearanceIntro)}</p>${themeForm({ ...ctx, theme: v.theme }, '/admin/profile')}` });
  const body = id + nameCard(ctx, v) + emailCard(ctx, v) + methodsCard(v) + appearance + sessionsCard(ctx, v)
    + (v.canChangePassword ? passwordCard(ctx) : '') + activityCard(v);
  return shell(ctx, { title: t.title, nav: 'profile', body });
}
