import { ROLES, type Role } from '../../auth/roles.js';
import type { PendingInviteView } from '../../users/invites.js';
import { s } from '../i18n.js';
import type { PageCtx } from '../page-ctx.js';
import { shell } from './layout.js';
import { badge, button, card, field, icon, postForm } from './components.js';
import { escapeHtml as e } from './escape.js';
import { statusBadge, timeTag, type StatusTone } from './status.js';

const t = s.users;

export type UserRowView = {
  id: string; name: string; email: string; role: Role; disabled: boolean; isSelf: boolean; lastSignInAt: string | null;
  ica: { tone: StatusTone; label: string }; signInMethods: string[];
  /** The linked ICA account is shared with another profile: a disconnect only unlinks this user. */
  icaShared?: boolean;
  /** The member changed their email themselves; single sign-on does not link to it by email until an admin saves it. */
  emailUnconfirmed: boolean;
};
export type { PendingInviteView } from '../../users/invites.js';
export type UserConfirmKind = 'disable' | 'remove' | 'disconnect';

const label = (u: { name: string; email: string }): string => u.name || u.email;
const icaConnected = (u: UserRowView): boolean => u.ica.tone !== 'none';
/** The action paths, shared by the list and the confirmation page. */
const ACTION_PATH: Record<UserConfirmKind, string> = { disable: 'disable', remove: 'remove', disconnect: 'ica/disconnect' };
const actionUrl = (id: string, kind: UserConfirmKind): string => `/admin/users/${encodeURIComponent(id)}/${ACTION_PATH[kind]}`;

/** The id of the "roles come from the groups" hint each role select points at (only rendered when groups decide). */
const GROUP_ROLES_HINT = 'roles-by-groups';

function roleForm(ctx: PageCtx, u: UserRowView, byGroups: boolean): string {
  const id = `role-${u.id}`;
  const options = ROLES.map((r) => `<option value="${r}"${u.role === r ? ' selected' : ''}>${e(t.roles[r])}</option>`).join('');
  return postForm(ctx, {
    action: `/admin/users/${encodeURIComponent(u.id)}/role`, className: 'role-form',
    body: `<label for="${e(id)}">${t.role}<span class="visually-hidden"> ${e(t.forName(label(u)))}</span></label>`
      + `<select id="${e(id)}" name="role"${byGroups ? ` aria-describedby="${GROUP_ROLES_HINT}"` : ''}>${options}</select>${button({ label: t.saveRole, kind: 'secondary' })}`,
  });
}

/** A destructive action: the dialog asks with JS; without JS the server answers with its confirmation page. */
const dangerForm = (ctx: PageCtx, u: UserRowView, kind: UserConfirmKind, text: string, kindClass: 'danger' | 'secondary'): string => {
  const ask = kind === 'disconnect' && u.icaShared ? t.ask.unlink : t.ask[kind];
  return postForm(ctx, { action: actionUrl(u.id, kind), confirm: ask(label(u)), confirmField: 'confirm', body: button({ label: text, kind: kindClass }) });
};

/** Your own email is changed on Profile (with your current password); anyone else's on its own page here. */
const emailHref = (u: UserRowView): string => (u.isSelf ? '/admin/profile#email' : `/admin/users/${encodeURIComponent(u.id)}/email`);

function actions(ctx: PageCtx, u: UserRowView): string {
  const out: string[] = [`<a class="btn btn-secondary" href="${e(emailHref(u))}">${t.changeEmail}<span class="visually-hidden"> ${e(t.forName(label(u)))}</span></a>`];
  if (u.isSelf) {
    out.push(postForm(ctx, { action: '/admin/logout', body: button({ label: t.signOut, kind: 'secondary' }) }));
  } else if (u.disabled) {
    out.push(postForm(ctx, { action: `/admin/users/${encodeURIComponent(u.id)}/enable`, body: button({ label: t.enable, kind: 'secondary' }) }));
  } else {
    out.push(dangerForm(ctx, u, 'disable', t.disable, 'secondary'));
  }
  if (icaConnected(u)) out.push(dangerForm(ctx, u, 'disconnect', t.disconnectIca, 'secondary'));
  if (!u.isSelf) out.push(dangerForm(ctx, u, 'remove', t.remove, 'danger'));
  return `<div class="user-actions cluster">${out.join('')}</div>`;
}

function userCard(ctx: PageCtx, u: UserRowView, byGroups: boolean): string {
  const you = u.isSelf ? ` <span class="muted">${e(t.you)}</span>` : '';
  const state = u.disabled ? badge('bad', t.disabled) : badge('ok', t.active);
  const methods = u.signInMethods.length ? u.signInMethods.map(e).join(', ') : e(t.none);
  const last = u.lastSignInAt ? timeTag(u.lastSignInAt) : e(s.common.never);
  const self = u.isSelf ? ' data-self' : '';
  return `<li class="user card"${self}><div class="card-header"><h2 class="wrap-anywhere">${e(label(u))}${you}</h2>`
    + `<div class="cluster">${badge('neutral', t.roles[u.role])}${state}</div></div>`
    + `<dl class="kv"><dt>${t.email}</dt><dd><span class="wrap-anywhere">${e(u.email)}</span>${u.emailUnconfirmed ? ` ${badge('warn', t.emailUnconfirmed)}` : ''}</dd><dt>${t.ica}</dt><dd>${statusBadge(u.ica)}</dd>`
    + `<dt>${t.lastSignIn}</dt><dd>${last}</dd><dt>${t.methods}</dt><dd>${methods}</dd></dl>`
    + (u.isSelf ? `<p class="muted small">${e(t.selfNote)}</p>` : '')
    + `<div class="user-controls">${roleForm(ctx, u, byGroups)}${actions(ctx, u)}</div></li>`;
}

/** Invite someone: their email and a role (member by default); the POST answers with the share page. */
function inviteForm(ctx: PageCtx, groupRoles: { label: string } | undefined): string {
  const options = ROLES.map((r) => `<option value="${r}"${r === 'member' ? ' selected' : ''}>${e(t.roles[r])}</option>`).join('');
  const form = postForm(ctx, {
    action: '/admin/users/invites', className: 'invite-form',
    body: field({ label: t.inviteEmail, name: 'email', type: 'email', autocomplete: 'off', required: true, attrs: 'inputmode="email" maxlength="254"' })
      + `<div class="field"><label for="invite-role">${t.inviteRole}</label><select id="invite-role" name="role"${groupRoles ? ' aria-describedby="invite-role-hint"' : ''}>${options}</select>`
      + `${groupRoles ? `<p class="field-hint" id="invite-role-hint">${e(t.inviteRoleByGroups(groupRoles.label))}</p>` : ''}</div>`
      + button({ label: t.inviteSubmit }),
  });
  return card({ title: t.inviteTitle, body: `<p class="muted">${e(t.inviteIntro)}</p>${form}` });
}

function inviteRow(ctx: PageCtx, i: PendingInviteView): string {
  const id = encodeURIComponent(i.id);
  const who = `<span class="visually-hidden"> ${e(t.inviteFor(i.email))}</span>`;
  const share = i.shareable
    ? `<a class="btn btn-secondary" href="/admin/users/invites/${id}">${t.showLink}${who}</a>`
    : postForm(ctx, { action: `/admin/users/invites/${id}/renew`, body: `<button class="btn btn-secondary" type="submit">${t.renewLink}${who}</button>` });
  const revoke = postForm(ctx, {
    action: `/admin/users/invites/${id}/revoke`, confirm: s.invite.share.askRevoke(i.email),
    body: `<button class="btn btn-danger" type="submit">${t.revokeInvite}${who}</button>`,
  });
  return `<li class="invite-row"><div class="stack"><span class="wrap-anywhere">${e(i.email)} ${badge('neutral', t.roles[i.role])}</span>`
    + `<span class="muted small">${t.inviteExpires} ${timeTag(i.expiresAt)}</span></div><div class="cluster">${share}${revoke}</div></li>`;
}

function invitesSection(ctx: PageCtx, invites: PendingInviteView[]): string {
  if (!invites.length) return '';
  return card({ title: t.invitesTitle, body: `<ul class="plain-list">${invites.map((i) => inviteRow(ctx, i)).join('')}</ul>` });
}

/**
 * The admin-only Users page: one card per household member (name, role, active/disabled, ICA status — never session
 * data — last sign-in, sign-in methods) with its role form and actions. The admin's own card has no Disable/Remove,
 * only Sign out. When a single active admin is left, a banner says why their role cannot change.
 */
export function usersPage(ctx: PageCtx, v: {
  users: UserRowView[]; invites: PendingInviteView[];
  /** A member group is set: roles follow the identity provider's groups (named by its label) at every sign-in. */
  groupRoles?: { label: string };
}): string {
  const admins = v.users.filter((u) => u.role === 'admin' && !u.disabled).length;
  const banner = admins <= 1
    ? `<div class="card card--warn callout">${icon(ctx, 'warn')}<p>${e(t.lastAdmin)}</p></div>`
    : '';
  const byGroups = Boolean(v.groupRoles);
  const hint = v.groupRoles ? `<p class="field-hint" id="${GROUP_ROLES_HINT}">${e(t.rolesByGroups(v.groupRoles.label))}</p>` : '';
  const list = `<ul class="user-list" aria-label="${e(t.caption)}">${v.users.map((u) => userCard(ctx, u, byGroups)).join('')}</ul>`;
  return shell(ctx, { title: t.title, nav: 'users', wide: true, body: `${banner}${hint}${list}${inviteForm(ctx, v.groupRoles)}${invitesSection(ctx, v.invites)}` });
}

/**
 * The confirmation step for a destructive action, rendered when its POST arrives without `confirm=yes` (the no-JS
 * path): what will happen, and a form that repeats the POST confirmed. Cancel goes back to the list.
 */
export function userConfirmPage(ctx: PageCtx, v: { kind: UserConfirmKind; user: { id: string; name: string; email: string }; icaShared?: boolean }): string {
  const c = v.kind === 'disconnect' && v.icaShared ? t.confirm.unlink : t.confirm[v.kind];
  const name = label(v.user);
  const form = postForm(ctx, {
    action: actionUrl(v.user.id, v.kind), className: 'cluster',
    body: `<input type="hidden" name="confirm" value="yes">${button({ label: c.action, kind: 'danger' })}`
      + `<a class="btn btn-secondary" href="/admin/users">${s.common.cancel}</a>`,
  });
  const body = card({
    tone: 'bad', title: c.title(name),
    body: `<p class="wrap-anywhere muted">${e(v.user.email)}</p><p>${e(c.body)}</p>${form}`,
  });
  return shell(ctx, { title: t.title, nav: 'users', body });
}

/**
 * An admin changes someone's email: the new address, saved at once (nothing is sent to it). Saving also confirms an
 * address the member set themselves, so single sign-on can link to it by email. Cancel goes back to the list.
 */
export function userEmailPage(ctx: PageCtx, v: { user: { id: string; name: string; email: string }; unconfirmed: boolean }): string {
  const p = t.emailPage;
  const form = postForm(ctx, {
    action: `/admin/users/${encodeURIComponent(v.user.id)}/email`, className: 'stack',
    body: field({ label: p.label, name: 'email', type: 'email', value: v.user.email, autocomplete: 'off', required: true, attrs: 'inputmode="email" maxlength="254"' })
      + `<p class="muted small">${e(p.confirmNote)}</p>`
      + `<div class="cluster">${button({ label: p.save })}<a class="btn btn-secondary" href="/admin/users">${s.common.cancel}</a></div>`,
  });
  const warn = v.unconfirmed ? `<p>${badge('warn', t.emailUnconfirmed)} ${e(p.unconfirmed)}</p>` : '';
  const body = card({
    title: p.title(label(v.user)),
    body: `<p class="wrap-anywhere muted">${e(v.user.email)}</p>${warn}<p>${e(p.intro)}</p>${form}`,
  });
  return shell(ctx, { title: t.title, nav: 'users', body });
}
