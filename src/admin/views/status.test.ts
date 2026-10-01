import { describe, expect, it } from 'vitest';
import { APP_SESSION_EXPIRED, APP_SESSION_UNREADABLE } from '../../ica/app-session.js';
import { WEB_SESSION_LOGGED_OUT, WEB_SESSION_UNREADABLE } from '../../ica/web-session.js';
import { absoluteTime, appStatus, icaStatus, NO_WEB_SESSION, relativeTime, statusBadge, timeTag } from './status.js';

const NOW = new Date('2026-10-01T12:00:00Z');
/** The absolute time as the app formats it (ICU month abbreviations differ between Node builds, so never hard-coded). */
const at = (iso: string) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
}).format(new Date(iso));
describe('icaStatus', () => {
  it.each([
    [undefined, 'none', 'Not connected', undefined],
    [{ expiresAt: '2026-12-27T00:00:00Z', lastError: null, lastOkAt: '2026-10-01T11:00:00Z' }, 'ok', 'Connected · expires in 86 days', 'Expires ' + at('2026-12-27T00:00:00Z')],
    [{ expiresAt: '2026-10-09T12:00:00Z', lastError: null, lastOkAt: null }, 'warn', 'Connected · expires in 8 days', 'Expires ' + at('2026-10-09T12:00:00Z')],
    [{ expiresAt: '2026-10-01T20:00:00Z', lastError: null, lastOkAt: null }, 'warn', 'Connected · expires today', 'Expires ' + at('2026-10-01T20:00:00Z')],
    [{ expiresAt: '2026-09-30T00:00:00Z', lastError: null, lastOkAt: null }, 'bad', 'Needs reconnect', 'Expired ' + at('2026-09-30T00:00:00Z')],
    [{ expiresAt: null, lastError: 'ICA session is no longer logged in', lastOkAt: null }, 'bad', 'Needs reconnect', undefined],
    [{ expiresAt: '2026-12-27T00:00:00Z', lastError: WEB_SESSION_LOGGED_OUT, lastOkAt: null }, 'bad', 'Needs reconnect', undefined],
    [{ expiresAt: '2026-12-27T00:00:00Z', lastError: 'geo-blocked (451)', lastOkAt: null }, 'warn', 'Temporarily unavailable', 'geo-blocked (451) · Expires ' + at('2026-12-27T00:00:00Z')],
    [{ expiresAt: null, lastError: 'network', lastOkAt: null }, 'warn', 'Temporarily unavailable', 'network'],
    [{ expiresAt: '2026-09-30T00:00:00Z', lastError: 'timeout', lastOkAt: null }, 'bad', 'Needs reconnect', 'Expired ' + at('2026-09-30T00:00:00Z')],
    [{ expiresAt: null, lastError: null, lastOkAt: null }, 'ok', 'Connected', undefined],
  ] as const)('%j → %s %s', (row, tone, label, title) => expect(icaStatus(row, NOW)).toEqual(title ? { tone, label, title } : { tone, label }));

  it('warns from 14 days before expiry', () => {
    expect(icaStatus({ expiresAt: '2026-10-15T12:00:00Z', lastError: null, lastOkAt: null }, NOW).tone).toBe('warn');
    expect(icaStatus({ expiresAt: '2026-10-15T12:00:01Z', lastError: null, lastOkAt: null }, NOW).tone).toBe('ok');
  });
});

describe('session-dead vs transient errors', () => {
  const web = (lastError: string) => icaStatus({ expiresAt: '2026-12-27T00:00:00Z', lastError, lastOkAt: null }, NOW);
  it.each([WEB_SESSION_LOGGED_OUT, WEB_SESSION_UNREADABLE, APP_SESSION_EXPIRED, APP_SESSION_UNREADABLE, NO_WEB_SESSION])('%s → Needs reconnect', (err) =>
    expect(web(err)).toEqual({ tone: 'bad', label: 'Needs reconnect' }));
  it.each(['geo-blocked (451)', 'network', 'timeout', 'http 503', 'unknown', 'the app token could not be refreshed', 'app token refresh failed (network)', 'app token refresh failed (HTTP 500)'])(
    '%s → Temporarily unavailable, reason in the tooltip, expiry kept', (err) =>
      expect(web(err)).toEqual({ tone: 'warn', label: 'Temporarily unavailable', title: `${err} · Expires ${at('2026-12-27T00:00:00Z')}` }));
});

describe('appStatus', () => {
  it.each([
    [undefined, 'none', 'Not connected', undefined],
    [{ expiresAt: '2026-10-01T12:30:00Z', lastError: null, lastOkAt: null }, 'ok', 'Connected · renews automatically', 'Current token expires ' + at('2026-10-01T12:30:00Z')],
    [{ expiresAt: '2026-09-30T00:00:00Z', lastError: null, lastOkAt: null }, 'ok', 'Connected · renews automatically', 'Current token expires ' + at('2026-09-30T00:00:00Z')],
    [{ expiresAt: null, lastError: null, lastOkAt: null }, 'ok', 'Connected · renews automatically', undefined],
    [{ expiresAt: '2026-10-01T12:30:00Z', lastError: APP_SESSION_EXPIRED, lastOkAt: null }, 'bad', 'Needs reconnect', undefined],
    [{ expiresAt: '2026-10-01T12:30:00Z', lastError: APP_SESSION_UNREADABLE, lastOkAt: null }, 'bad', 'Needs reconnect', undefined],
    [{ expiresAt: '2026-10-01T12:30:00Z', lastError: 'the app token could not be refreshed', lastOkAt: null }, 'warn', 'Temporarily unavailable', 'the app token could not be refreshed'],
  ] as const)('%j → %s %s', (row, tone, label, title) => expect(appStatus(row)).toEqual(title ? { tone, label, title } : { tone, label }));
  it('never shows a day count', () => expect(appStatus({ expiresAt: '2026-12-27T00:00:00Z', lastError: null, lastOkAt: null }).label).not.toMatch(/day|today/));
});

describe('statusBadge', () => {
  it('renders the tone as a badge, the absolute time as a tooltip, and escapes', () => {
    expect(statusBadge({ tone: 'none', label: 'Not connected' })).toBe('<span class="badge badge--neutral">Not connected</span>');
    expect(statusBadge({ tone: 'warn', label: 'a<b', title: 'x"y' })).toBe('<span class="badge badge--warn" title="x&quot;y">a&lt;b</span>');
  });
});

describe('relative and absolute times', () => {
  it.each([
    ['2026-10-01T11:59:40Z', 'just now'],
    ['2026-10-01T11:15:00Z', '45 minutes ago'],
    ['2026-10-01T09:00:00Z', '3 hours ago'],
    ['2026-09-30T10:00:00Z', 'yesterday'],
    ['2026-09-24T12:00:00Z', '7 days ago'],
    ['2026-10-09T12:00:00Z', 'in 8 days'],
  ])('%s → %s', (iso, text) => expect(relativeTime(iso, NOW)).toBe(text));

  it('formats absolute times in Stockholm time', () => expect(absoluteTime('2026-12-27T00:00:00Z')).toMatch(/^27 Dec\w* 2026, 01:00 (CET|GMT\+1)$/));

  it('renders a <time> with the absolute tooltip, and survives a value that is not a date', () => {
    expect(timeTag('2026-10-01T09:00:00Z', NOW)).toBe('<time datetime="2026-10-01T09:00:00Z" title="' + at('2026-10-01T09:00:00Z') + '">3 hours ago</time>');
    expect(timeTag('<soon>', NOW)).toBe('&lt;soon&gt;');
  });
});
