import { AUDIT_ACTIONS, AUDIT_DETAILS, type AuditRow } from '../../audit.js';
import { s } from '../i18n.js';
import type { PageCtx } from '../page-ctx.js';
import { shell } from './layout.js';
import { badge, dataTable, emptyState, mascot } from './components.js';
import { escapeHtml as e } from './escape.js';

const t = s.activity;

/** The household is in Sweden: `sv-SE` short date+time, always Stockholm local time regardless of the viewer's own TZ. */
const AT = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Stockholm' });
const atTag = (iso: string): string => {
  const d = new Date(iso);
  return `<time datetime="${e(iso)}">${e(Number.isNaN(d.getTime()) ? iso : AT.format(d))}</time>`;
};

const actionLabel = (action: string): string => (s.audit.actions as Record<string, string>)[action] ?? action;
const outcomeBadge = (outcome: AuditRow['outcome']): string => badge(outcome === 'success' ? 'ok' : 'bad', t.outcome[outcome]);

/** Only the keys {@link AUDIT_DETAILS} allow-lists for the row's action are ever shown, each escaped. An action the UI
 * no longer recognises (or one whose `details` were written before a key was added) simply shows nothing. */
function detailsText(row: AuditRow): string {
  const keys = (AUDIT_DETAILS as Record<string, readonly string[]>)[row.action] ?? [];
  const parts = keys.filter((k) => Object.hasOwn(row.details, k)).map((k) => {
    const v = row.details[k];
    const text = Array.isArray(v) ? v.join(', ') : String(v as string | number | boolean);
    return `${e(k)}: ${e(text)}`;
  });
  return parts.length ? parts.join('; ') : '—';
}

export type EventRow = AuditRow & { actorLabel: string; targetLabel: string };

/**
 * One event per row: time, who, what, target, outcome, and (unless `compact`, used on the member's own Profile page)
 * IP and user agent — those stay admin-only, since only the admin-only Activity page renders without `compact`.
 */
export function auditEventList(rows: EventRow[], o: { compact?: boolean } = {}): string {
  const head = [
    t.table.time, t.table.who, t.table.what, t.table.target, t.table.outcome,
    ...(o.compact ? [] : [t.table.ip, t.table.userAgent]),
    t.table.details,
  ];
  const tableRows = rows.map((row) => [
    atTag(row.at), e(row.actorLabel), e(actionLabel(row.action)), row.targetLabel ? e(row.targetLabel) : '—', outcomeBadge(row.outcome),
    ...(o.compact ? [] : [row.ip ? e(row.ip) : '—', row.userAgent ? e(row.userAgent) : '—']),
    detailsText(row),
  ]);
  // The user agent and the details may be long tokens; every other column breaks between words only.
  const anywhere = o.compact ? [head.length - 1] : [head.length - 2, head.length - 1];
  return dataTable({ caption: t.title, head, rows: tableRows, anywhere });
}

export type ActivityView = {
  rows: EventRow[]; total: number; page: number; pageSize: number;
  filter: { user?: string; action?: string; from?: string; to?: string };
  users: { id: string; label: string }[];
};

/**
 * The GET filter form: no CSRF token, since a GET changes nothing. Selections and dates round-trip from `v.filter`.
 * Each action option's `value` is the raw action key (what the query string and `listAuditEvents` use); its text is
 * the `s.audit.actions` label, so an admin picks "Changed a role" rather than `user.role_changed`.
 */
function filterForm(v: ActivityView): string {
  const userOptions = [`<option value=""${v.filter.user ? '' : ' selected'}>${e(t.filters.allUsers)}</option>`]
    .concat(v.users.map((u) => `<option value="${e(u.id)}"${v.filter.user === u.id ? ' selected' : ''}>${e(u.label)}</option>`)).join('');
  const actionOptions = [`<option value=""${v.filter.action ? '' : ' selected'}>${e(t.filters.allActions)}</option>`]
    .concat(AUDIT_ACTIONS.map((a) => `<option value="${e(a)}"${v.filter.action === a ? ' selected' : ''}>${e(s.audit.actions[a])}</option>`)).join('');
  return `<form method="get" class="filters">
<div class="field"><label for="activity-f-user">${t.filters.user}</label><select id="activity-f-user" name="user">${userOptions}</select></div>
<div class="field"><label for="activity-f-action">${t.filters.action}</label><select id="activity-f-action" name="action">${actionOptions}</select></div>
<div class="field"><label for="activity-f-from">${t.filters.from}</label><input id="activity-f-from" type="date" name="from" value="${e(v.filter.from ?? '')}"></div>
<div class="field"><label for="activity-f-to">${t.filters.to}</label><input id="activity-f-to" type="date" name="to" value="${e(v.filter.to ?? '')}"></div>
<div class="cluster"><button class="btn btn-primary" type="submit">${t.filters.apply}</button><a class="btn btn-secondary" href="/admin/activity">${t.filters.clear}</a></div>
</form>`;
}

/** The current filter, as a query string, with `page` replaced (and dropped when it is the first page). */
function pageHref(v: ActivityView, page: number): string {
  const p = new URLSearchParams();
  if (v.filter.user) p.set('user', v.filter.user);
  if (v.filter.action) p.set('action', v.filter.action);
  if (v.filter.from) p.set('from', v.filter.from);
  if (v.filter.to) p.set('to', v.filter.to);
  if (page > 1) p.set('page', String(page));
  const qs = p.toString();
  return `/admin/activity${qs ? `?${qs}` : ''}`;
}

function pagination(v: ActivityView, totalPages: number): string {
  const prev = v.page > 1 ? `<a class="tap-link" href="${e(pageHref(v, v.page - 1))}">${t.pagination.previous}</a>` : `<span class="muted">${t.pagination.previous}</span>`;
  const next = v.page < totalPages ? `<a class="tap-link" href="${e(pageHref(v, v.page + 1))}">${t.pagination.next}</a>` : `<span class="muted">${t.pagination.next}</span>`;
  return `<nav class="pagination" aria-label="${e(t.title)}">${prev}<span>${e(t.pagination.pageOf(v.page, totalPages))}</span>${next}</nav>`;
}

/**
 * The results region: the event list + pagination, the "nothing matches at all" empty state, or — when a page
 * beyond the last one was requested (e.g. an old bookmark after events aged out) — a distinct "no events on this
 * page" state with a way back, rather than claiming nothing has ever happened.
 */
function results(ctx: PageCtx, v: ActivityView, totalPages: number): string {
  if (v.rows.length) return `${auditEventList(v.rows)}${pagination(v, totalPages)}`;
  if (v.total > 0) {
    return emptyState({
      title: t.pastEnd.title, body: t.pastEnd.body,
      action: `<a class="btn btn-secondary" href="${e(pageHref(v, 1))}">${t.pastEnd.back}</a>`,
    });
  }
  return emptyState({ art: mascot(ctx, 'sm'), title: s.brand.emptyLog, titleLang: 'sv', body: t.emptyBody });
}

/** The admin-only audit log: filter by user/action/date, newest first, paginated 50 per page. */
export function activityPage(ctx: PageCtx, v: ActivityView): string {
  const totalPages = Math.max(1, Math.ceil(v.total / v.pageSize));
  // A distinct region for the event list/pagination (as opposed to the filter form above it), so a test — or a
  // future script — can scope to the actual rows without also matching the filter's own option text.
  const body = `<section id="activity-events">${results(ctx, v, totalPages)}</section>`;
  return shell(ctx, { title: t.title, subtitle: s.brand.activitySubtitle, nav: 'activity', body: `${filterForm(v)}${body}`, wide: true });
}
