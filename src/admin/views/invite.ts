import type { Role } from '../../auth/roles.js';
import { s } from '../i18n.js';
import type { PageCtx } from '../page-ctx.js';
import { bare, shell } from './layout.js';
import { badge, button, card, copyButton, field, postForm } from './components.js';
import { escapeHtml as e } from './escape.js';
import { timeTag } from './status.js';

const t = s.invite;

/**
 * What the invite link shows. `accept`: the email (read-only) and the ways to accept — OIDC first when configured,
 * then a password form when local login is on. `gone`: unknown, used, revoked and expired links alike (no oracle).
 * `same-user`: already signed in as the invited email. `other-user`: signed in as someone else, who must sign out first.
 */
export type InviteView =
  | { state: 'accept'; email: string; token: string; localLogin: boolean; oidcLabel?: string }
  | { state: 'gone' }
  | { state: 'same-user'; email: string }
  | { state: 'other-user'; email: string; signedInAs: string; token: string };

const base = (token: string): string => `/admin/invite/${encodeURIComponent(token)}`;
const home = `<p><a class="btn btn-secondary" href="/admin">${s.errors.home}</a></p>`;

function acceptBody(ctx: PageCtx, v: Extract<InviteView, { state: 'accept' }>): string {
  const who = `<p>${e(t.intro)}</p><p class="invite-email wrap-anywhere"><strong>${e(v.email)}</strong></p>`;
  // OIDC acceptance posts to `${base}/oidc` (the route passes `oidcLabel` when OIDC is configured).
  const oidc = v.oidcLabel
    ? postForm(ctx, { action: `${base(v.token)}/oidc`, className: 'stack', body: button({ label: s.login.continueWith(v.oidcLabel) }) })
    : '';
  const divider = oidc && v.localLogin ? `<p class="divider">${t.orPassword}</p>` : '';
  const strength = Object.entries(t.strength).map(([k, text]) => `data-${k}="${e(text)}"`).join(' ');
  const local = v.localLogin
    ? postForm(ctx, {
      action: `${base(v.token)}/accept`, className: 'stack',
      body: field({ label: t.name, name: 'name', autocomplete: 'name', required: true, attrs: 'maxlength="100"' })
        + field({
          label: t.password, name: 'password', type: 'password', autocomplete: 'new-password', required: true, hint: t.passwordHint,
          attrs: 'minlength="12" maxlength="128" data-strength="pw-hint"',
        })
        + `<p id="pw-hint" class="field-hint" aria-live="polite" ${strength}></p>`
        + field({ label: t.confirm, name: 'confirm', type: 'password', autocomplete: 'new-password', required: true, attrs: 'minlength="12" maxlength="128"' })
        + button({ label: t.submit, kind: oidc ? 'secondary' : 'primary' }),
    })
    : '';
  const none = !oidc && !local ? `<p class="muted">${e(t.oidcOnly)}</p>` : '';
  return `${who}${oidc}${divider}${local}${none}`;
}

/** The invite link's page (outside the shell: the invitee usually has no account yet). */
export function invitePage(ctx: PageCtx, v: InviteView): string {
  switch (v.state) {
    case 'accept':
      return bare(ctx, { title: t.title, body: acceptBody(ctx, v) });
    case 'gone':
      return bare(ctx, { title: s.common.statusTitles[410], body: `<p>${s.errors.gone}</p><p class="muted">${e(t.gone)}</p>${home}` });
    case 'same-user':
      return bare(ctx, { title: t.sameUser.title, body: `<p class="wrap-anywhere">${e(t.sameUser.body(v.email))}</p>${home}` });
    case 'other-user': {
      const form = postForm(ctx, {
        action: `${base(v.token)}/switch`, className: 'cluster',
        body: button({ label: t.otherUser.action }) + `<a class="btn btn-secondary" href="/admin">${s.errors.home}</a>`,
      });
      return bare(ctx, {
        title: t.otherUser.title,
        body: `<div class="card card--warn callout"><p class="wrap-anywhere">${e(t.otherUser.body(v.signedInAs, v.email))}</p></div>${form}`,
      });
    }
  }
}

/**
 * The admin's share page for one invite: the link with a copy button and its QR code (inline SVG from `qrcode`, no
 * script, so it passes the CSP) while the link is still held in memory; afterwards only Renew. Revoke is always offered.
 */
export function inviteSharePage(ctx: PageCtx, v: { email: string; role: Role; link?: string; qrSvg?: string; expiresAt: string; inviteId: string }): string {
  const sh = t.share;
  const id = encodeURIComponent(v.inviteId);
  const who = `<p class="wrap-anywhere"><strong>${e(v.email)}</strong> ${badge('neutral', s.users.roles[v.role])}</p>`
    + `<p class="muted small">${s.users.inviteExpires} ${timeTag(v.expiresAt)}</p>`;
  const renew = postForm(ctx, { action: `/admin/users/invites/${id}/renew`, confirm: v.link ? sh.askRenew : undefined, body: button({ label: sh.renew, kind: v.link ? 'secondary' : 'primary' }) });
  const revoke = postForm(ctx, { action: `/admin/users/invites/${id}/revoke`, confirm: sh.askRevoke(v.email), body: button({ label: sh.revoke, kind: 'danger' }) });
  const shared = v.link
    ? `<p class="wrap-anywhere">${e(sh.body(v.email))}</p>`
      + `<div class="field"><label for="invite-link">${sh.link}</label><input id="invite-link" class="invite-link" type="text" readonly value="${e(v.link)}"></div>`
      + `<div class="cluster">${copyButton(v.link, sh.copy)}</div>`
      + (v.qrSvg ? `<figure class="qr" role="img" aria-label="${e(sh.qrLabel)}">${v.qrSvg}</figure>` : '')
      + `<p class="muted small">${e(sh.shownOnce)}</p>`
    : `<p>${e(sh.hidden)}</p>`;
  const body = card({ title: sh.title, body: `${who}${shared}<div class="cluster">${renew}${revoke}</div>` })
    + `<p><a class="tap-link" href="/admin/users">${sh.back}</a></p>`;
  return shell(ctx, { title: s.users.title, nav: 'users', body });
}
