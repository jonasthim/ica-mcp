import { describe, expect, it } from 'vitest';
import { IcaRejected, IcaUnavailable } from '../ica/errors.js';
import { NeedsAppReconnect, NeedsFreshBankId, NeedsWebReconnect, NotLinked, RateLimited, problemOf, sessionErrorText } from './errors.js';

const URL_ = 'https://ica.example.com';
const ADMIN = 'https://ica.example.com/admin/ica';

describe('sessionErrorText', () => {
  it('names the admin page and the button to press for every reconnect case', () => {
    expect(sessionErrorText(new NotLinked(), URL_)).toContain(ADMIN);
    expect(sessionErrorText(new NotLinked(), URL_)).toContain('"Connect with BankID"');
    expect(sessionErrorText(new NeedsWebReconnect(), URL_)).toContain('"Reconnect with BankID"');
    expect(sessionErrorText(new NeedsAppReconnect('not-connected'), URL_)).toContain('"Connect app access with BankID"');
    for (const why of ['expired', 'rejected', 'unreadable'] as const) {
      const t = sessionErrorText(new NeedsAppReconnect(why), URL_)!;
      expect(t).toContain(ADMIN);
      expect(t).toContain('"Reconnect app access with BankID"');
    }
    const fresh = sessionErrorText(new NeedsFreshBankId(1), URL_)!;
    expect(fresh).toContain(ADMIN);
    expect(fresh).toContain('login level 1');
    expect(fresh).toContain('app access');
    expect(sessionErrorText(new NeedsFreshBankId(undefined), URL_)).not.toContain('login level');
    expect(sessionErrorText(new NeedsFreshBankId(2, 'refused-at-level'), URL_)).toBe(
      `ICA refused purchase history although the session reports the right login level. Try a fresh BankID login once: open ${ADMIN} and choose "Reconnect with BankID", then ask again. If it keeps failing, tell the hub operator.`);
    expect(problemOf(new NeedsFreshBankId(2, 'refused-at-level'))).toEqual({ kind: 'needs-step-up', loginState: 2 });
  });

  it('says "try again" for transient problems and never "reconnect"', () => {
    for (const e of [new IcaUnavailable('network'), new IcaUnavailable('timeout'), new IcaUnavailable('server-error', 503), new IcaUnavailable('geo-blocked', 451), new IcaUnavailable('unexpected-response'), new IcaUnavailable('rate-limited', 429), new IcaUnavailable('shutting-down'), new IcaUnavailable('not-ready'), new RateLimited(12)]) {
      const t = sessionErrorText(e, URL_)!;
      expect(t).toBeTruthy();
      expect(t.toLowerCase()).not.toContain('reconnect');
    }
    expect(sessionErrorText(new RateLimited(12), URL_)).toContain('12 s');
    expect(sessionErrorText(new IcaUnavailable('rate-limited', 429), URL_)).toContain('HTTP 429');
    expect(sessionErrorText(new IcaRejected(404), URL_)).toContain('HTTP 404');
    expect(sessionErrorText(new IcaUnavailable('shutting-down'), URL_)).toBe('ica-hub is restarting; try again in a moment.');
    expect(problemOf(new IcaUnavailable('shutting-down'))).toEqual({ kind: 'transient', detail: 'shutting-down' });
    expect(sessionErrorText(new IcaUnavailable('not-ready'), URL_)).toBe('Handla is still preparing results; try again in a moment.');
  });

  it('Handla bot protection: says how long, that ICA itself is unaffected, and never an HTTP status', () => {
    const t = sessionErrorText(new IcaUnavailable('blocked', 202, [], 540), URL_)!;
    expect(t).toBe("Handla's bot protection is blocking price lookups for a while (too many searches in a short time). Try again in about 9 minutes. ICA lists, offers and bonus are not affected.");
    expect(sessionErrorText(new IcaUnavailable('blocked', undefined, [], 30), URL_)).toContain('Try again in about 1 minute.');
    expect(sessionErrorText(new IcaUnavailable('blocked'), URL_)).toContain('Try again in about 10 minutes.');
    expect(t).not.toMatch(/HTTP|202|reconnect/i);
    expect(problemOf(new IcaUnavailable('blocked', 202, [], 540))).toEqual({ kind: 'transient', detail: 'blocked by Handla bot protection' });
    expect(sessionErrorText(new IcaUnavailable('queue-full'), URL_)).toBe('Too many Handla lookups queued; try fewer items at once. ICA lists, offers and bonus are not affected.');
    expect(problemOf(new IcaUnavailable('queue-full'))).toEqual({ kind: 'transient', detail: 'queue-full' });
  });

  it('knows nothing about other errors', () => {
    expect(sessionErrorText(new Error('boom'), URL_)).toBeUndefined();
    expect(sessionErrorText('x', URL_)).toBeUndefined();
  });
});

describe('problemOf', () => {
  it('classifies errors into the three session problem kinds', () => {
    expect(problemOf(new NeedsWebReconnect())).toEqual({ kind: 'needs-rescan', detail: 'web session ended' });
    expect(problemOf(new NeedsAppReconnect('expired'))).toEqual({ kind: 'needs-rescan', detail: 'app access expired' });
    expect(problemOf(new NeedsFreshBankId(1))).toEqual({ kind: 'needs-step-up', loginState: 1 });
    expect(problemOf(new IcaUnavailable('geo-blocked', 451))).toEqual({ kind: 'transient', detail: 'geo-blocked (451)' });
    expect(problemOf(new IcaUnavailable('network'))).toEqual({ kind: 'transient', detail: 'network' });
    expect(problemOf(new IcaUnavailable('rate-limited', 429))).toEqual({ kind: 'transient', detail: 'rate-limited (HTTP 429)' });
    expect(problemOf(new IcaRejected(404))).toEqual({ kind: 'transient', detail: 'could not check (HTTP 404)' });
    expect(problemOf(new Error('x'))).toBeUndefined();
  });
});
