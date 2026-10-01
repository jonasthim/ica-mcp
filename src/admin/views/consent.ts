import { s } from '../i18n.js';
import type { PageCtx } from '../page-ctx.js';
import { bare } from './layout.js';
import { button, icon, postForm } from './components.js';
import { escapeHtml as e } from './escape.js';

const IDENTITY = new Set(['openid', 'profile', 'email']);

/**
 * Known scopes as plain-language lines (identity scopes merged into one), then any unknown scope verbatim; under a
 * label (`label`, default "This lets it:") whose element id is `labelId`, unique per page. Also used by Connected apps.
 */
export function scopeList(ctx: PageCtx, scopes: string[], o: { labelId?: string; label?: string } = {}): string {
  const labelId = o.labelId ?? 'scopes-label';
  const lines: string[] = [];
  const item = (text: string) => `<li>${icon(ctx, 'check')}<span>${text}</span></li>`;
  if (scopes.some((sc) => IDENTITY.has(sc))) lines.push(item(e(s.consent.scope.identity)));
  if (scopes.includes('mcp')) lines.push(item(e(s.consent.scope.mcp)));
  if (scopes.includes('offline_access')) lines.push(item(e(s.consent.scope.offline_access)));
  const unknown = [...new Set(scopes.filter((sc) => !IDENTITY.has(sc) && sc !== 'mcp' && sc !== 'offline_access'))];
  if (unknown.length) lines.push(`<li>${icon(ctx, 'warn')}<span>${s.consent.unknownScope} ${unknown.map((sc) => `<code>${e(sc)}</code>`).join(' ')}</span></li>`);
  return `<p class="scopes-label" id="${e(labelId)}">${e(o.label ?? s.consent.scopes)}</p><ul class="scopes" aria-labelledby="${e(labelId)}">${lines.join('')}</ul>`;
}

export function consentPage(ctx: PageCtx, o: { clientName: string; scopes: string[]; oauthQuery: string; redirectHost: string; verified: boolean }): string {
  const warn = o.verified ? ''
    : `<div class="card card--warn callout">${icon(ctx, 'warn')}<p><strong>${s.consent.unverified}</strong></p></div>`;
  return bare(ctx, {
    title: s.consent.title,
    body: `<div class="consent-who"><h2 class="consent-client wrap-anywhere">${e(o.clientName)}</h2><p>${s.consent.wants}</p></div>
<p class="dest wrap-anywhere">${s.consent.dest} <strong>${e(o.redirectHost)}</strong></p>${warn}
${scopeList(ctx, o.scopes)}
${postForm(ctx, {
    action: '/admin/consent', className: 'cluster actions',
    body: `<input type="hidden" name="oauth_query" value="${e(o.oauthQuery)}">${button({ label: s.consent.allow, name: 'accept', value: 'yes' })} ${button({ label: s.consent.deny, kind: 'secondary', name: 'accept', value: 'no' })}`,
  })}
<p class="muted small">${s.consent.revokeHint}</p>`,
  });
}
