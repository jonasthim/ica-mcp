import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { auditEventList, type EventRow } from './index.js';

const row: EventRow = {
  id: 1, at: '2026-09-30T10:00:00.000Z', actorUserId: 'u1', action: 'user.invite_accepted', targetType: 'invite', targetId: 'i1',
  ip: '127.0.0.1', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', outcome: 'success',
  details: { email: 'bjorn@example.com', role: 'member' }, actorLabel: 'Björn Åkesson-Öhrström', targetLabel: 'Invite',
};

/** The class of each cell in the first row, keyed by its data-label. */
function cellClasses(html: string): Record<string, string> {
  const doc = new JSDOM(html).window.document;
  return Object.fromEntries([...doc.querySelectorAll('tbody tr:first-child td')].map((td) => [td.getAttribute('data-label')!, td.className]));
}

describe('audit event table wrapping', () => {
  it('lets only the user agent and details break inside a word on Activity; names, actions and IPs stay whole', () => {
    const c = cellClasses(auditEventList([row]));
    expect(c['User agent']).toBe('wrap-anywhere');
    expect(c.Details).toBe('wrap-anywhere');
    for (const col of ['Time', 'Who', 'What', 'Target', 'Outcome', 'IP address']) expect(c[col], col).toBe('');
  });

  it('marks only details on the compact Profile list', () => {
    const c = cellClasses(auditEventList([row], { compact: true }));
    expect(c.Details).toBe('wrap-anywhere');
    expect(Object.values(c).filter(Boolean)).toHaveLength(1);
  });
});
