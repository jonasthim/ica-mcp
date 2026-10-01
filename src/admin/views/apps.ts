import type { ConnectedApp } from '../../users/grants.js';
import { s } from '../i18n.js';
import type { PageCtx } from '../page-ctx.js';
import { shell } from './layout.js';
import { badge, button, card, copyButton, emptyState, postForm } from './components.js';
import { scopeList } from './consent.js';
import { escapeHtml as e } from './escape.js';
import { timeTag } from './status.js';

const t = s.apps;

/** A connected app as the page shows it: `verified` follows the consent page (`ICA_HUB_TRUSTED_CLIENT_IDS`). */
export type AppView = ConnectedApp & { verified: boolean };

/** Revoke posts the client id as a field: a CIMD client id is a URL, so it does not fit in a path segment. */
const REVOKE = '/admin/apps/revoke';
const clientField = (clientId: string): string => `<input type="hidden" name="client_id" value="${e(clientId)}">`;

/** One app: its self-chosen name (escaped), whether it is verified, where its codes go, when, and what it may do. */
function appCard(ctx: PageCtx, a: AppView, i: number): string {
  const state = a.verified ? badge('ok', t.verified) : badge('neutral', t.unverified);
  const last = a.lastUsedAt ? timeTag(a.lastUsedAt) : e(s.common.never);
  const revoke = postForm(ctx, {
    action: REVOKE, confirm: t.ask(a.name), confirmField: 'confirm',
    body: `${clientField(a.clientId)}<button class="btn btn-danger" type="submit">${t.revoke}<span class="visually-hidden"> ${e(t.revokeFor(a.name))}</span></button>`,
  });
  return `<li class="app card"><div class="card-header"><h2 class="wrap-anywhere">${e(a.name)}</h2>${state}</div>`
    + `<dl class="kv"><dt>${t.sendsTo}</dt><dd>${a.redirectHost ? `<strong>${e(a.redirectHost)}</strong>` : e(s.common.unknown)}</dd>`
    + `<dt>${t.allowed}</dt><dd>${timeTag(a.firstUsedAt)}</dd><dt>${t.lastUsed}</dt><dd>${last}</dd></dl>`
    + scopeList(ctx, a.scopes, { labelId: `app-scopes-${i}`, label: t.access })
    + `<div class="user-controls cluster">${revoke}</div></li>`;
}

/**
 * Connected apps: the OAuth clients the signed-in user allowed, each with a Revoke that stops it at once (the dialog
 * asks with JS; without JS the server answers with {@link appConfirmPage}). With none, how to add ICA-MCP in Claude.
 */
export function appsPage(ctx: PageCtx, v: { apps: AppView[]; mcpUrl: string }): string {
  if (!v.apps.length) {
    const how = `<div class="copy-row"><code class="wrap-anywhere">${e(v.mcpUrl)}</code>${copyButton(v.mcpUrl, t.copyUrl)}</div>`;
    return shell(ctx, { title: t.title, nav: 'apps', body: card({ body: emptyState({ title: t.emptyTitle, body: t.emptyBody, action: how }) }) });
  }
  const list = `<ul class="user-list" aria-label="${e(t.caption)}">${v.apps.map((a, i) => appCard(ctx, a, i)).join('')}</ul>`;
  return shell(ctx, {
    title: t.title, nav: 'apps', wide: true,
    body: `<p class="muted">${e(t.intro)}</p>${list}<p class="muted small">${e(t.lastUsedHint)}</p>`,
  });
}

/** The no-JS confirmation step for Revoke: what happens, and the same POST confirmed. Cancel goes back to the list. */
export function appConfirmPage(ctx: PageCtx, v: { clientId: string; name: string; redirectHost: string | null }): string {
  const form = postForm(ctx, {
    action: REVOKE, className: 'cluster',
    body: `${clientField(v.clientId)}<input type="hidden" name="confirm" value="yes">${button({ label: t.confirm.action, kind: 'danger' })}`
      + `<a class="btn btn-secondary" href="/admin/apps">${s.common.cancel}</a>`,
  });
  const where = v.redirectHost ? `<p class="wrap-anywhere muted">${t.sendsTo} <strong>${e(v.redirectHost)}</strong></p>` : '';
  return shell(ctx, { title: t.title, nav: 'apps', body: card({ tone: 'bad', title: t.confirm.title(v.name), body: `${where}<p>${e(t.confirm.body)}</p>${form}` }) });
}
