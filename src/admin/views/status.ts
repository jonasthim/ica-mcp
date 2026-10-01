import { s } from '../i18n.js';
import { APP_SESSION_EXPIRED, APP_SESSION_UNREADABLE } from '../../ica/app-session.js';
import { WEB_SESSION_LOGGED_OUT, WEB_SESSION_UNREADABLE } from '../../ica/web-session.js';
import { escapeHtml as e } from './escape.js';

export type StatusTone = 'ok' | 'warn' | 'bad' | 'none';
/** A connection's state as a badge: tone, label, and (when there is an expiry) the absolute time as a tooltip. */
export type IcaStatus = { tone: StatusTone; label: string; title?: string };
export type IcaStatusRow = { expiresAt: string | null; lastError: string | null; lastOkAt: string | null };

const DAY = 86_400_000;
const WARN_WITHIN = 14 * DAY;

/** The household is in Sweden: absolute times are Stockholm time, with the zone named (CET/CEST). */
const ABSOLUTE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
});
const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const parse = (iso: string): Date | undefined => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? undefined : d; };

export const absoluteTime = (iso: string): string => { const d = parse(iso); return d ? ABSOLUTE.format(d) : iso; };

/** "3 hours ago", "yesterday", "in 8 days"; under a minute either way is "just now". */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const d = parse(iso);
  if (!d) return iso;
  const ms = d.getTime() - now.getTime();
  const abs = Math.abs(ms);
  if (abs < 60_000) return s.status.justNow;
  if (abs < 3_600_000) return RELATIVE.format(Math.trunc(ms / 60_000), 'minute');
  if (abs < DAY) return RELATIVE.format(Math.trunc(ms / 3_600_000), 'hour');
  return RELATIVE.format(Math.trunc(ms / DAY), 'day'); // whole days, like the badge ("expires in 61 days")
}

/** A relative time with the absolute time as its tooltip; a value that is not a date renders as plain (escaped) text. */
export function timeTag(iso: string, now: Date = new Date()): string {
  if (!parse(iso)) return e(iso);
  return `<time datetime="${e(iso)}" title="${e(absoluteTime(iso))}">${e(relativeTime(iso, now))}</time>`;
}

/** A web row with no stored session: it can only be fixed by reconnecting. */
export const NO_WEB_SESSION = 'no stored ICA web session';

/**
 * Errors that mean the stored session is dead and only a new BankID login helps. Any other recorded error (geo-block,
 * network, timeout, an HTTP status, a failed refresh) is transient: the session may well work on the next try.
 */
const SESSION_DEAD = new Set<string>([WEB_SESSION_LOGGED_OUT, WEB_SESSION_UNREADABLE, APP_SESSION_EXPIRED, APP_SESSION_UNREADABLE, NO_WEB_SESSION]);
const isDead = (err: string): boolean => SESSION_DEAD.has(err);

/**
 * The status of the stored ICA web session (its expiry is the real ~89-day lifetime). No row → not connected; a
 * session-dead error or a past expiry → needs reconnect; another error → temporarily unavailable (reason and expiry in
 * the tooltip); otherwise connected, with the days left (warning within 14 days).
 */
export function icaStatus(row: IcaStatusRow | undefined, now: Date = new Date()): IcaStatus {
  if (!row) return { tone: 'none', label: s.status.none };
  if (row.lastError && isDead(row.lastError)) return { tone: 'bad', label: s.status.reconnect };
  const exp = row.expiresAt ? parse(row.expiresAt) : undefined;
  const at = exp && row.expiresAt ? (exp <= now ? s.status.expiredAt : s.status.expiresAt)(absoluteTime(row.expiresAt)) : undefined;
  const title = at ? { title: at } : {};
  if (exp && exp <= now) return { tone: 'bad', label: s.status.reconnect, ...title };
  if (row.lastError) return { tone: 'warn', label: s.status.unavailable, title: at ? `${row.lastError} · ${at}` : row.lastError };
  if (!exp) return { tone: 'ok', label: s.status.connected };
  const left = exp.getTime() - now.getTime();
  const days = Math.floor(left / DAY);
  return { tone: left <= WARN_WITHIN ? 'warn' : 'ok', label: days < 1 ? s.status.expiresToday : s.status.expiresIn(days), ...title };
}

/**
 * The status of the ICA app access. Its stored expiry is the short-lived access token, which is refreshed on use, so no
 * day count is shown: connected sessions "renew automatically", with the current token's expiry in the tooltip.
 */
export function appStatus(row: IcaStatusRow | undefined): IcaStatus {
  if (!row) return { tone: 'none', label: s.status.none };
  if (row.lastError && isDead(row.lastError)) return { tone: 'bad', label: s.status.reconnect };
  if (row.lastError) return { tone: 'warn', label: s.status.unavailable, title: row.lastError };
  const exp = row.expiresAt && parse(row.expiresAt) ? { title: s.status.tokenExpiresAt(absoluteTime(row.expiresAt)) } : {};
  return { tone: 'ok', label: s.status.renews, ...exp };
}

const BADGE_TONE = { ok: 'ok', warn: 'warn', bad: 'bad', none: 'neutral' } as const;

export const statusBadge = (st: IcaStatus): string =>
  `<span class="badge badge--${BADGE_TONE[st.tone]}"${st.title ? ` title="${e(st.title)}"` : ''}>${e(st.label)}</span>`;
