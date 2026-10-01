import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, startTestApp, TEST_PASSWORD, type TestCtx } from '../test-helpers.js';

/** The event list/pagination region only — not the filter form, whose action `<select>` lists every action's label
 * (so "Signed in" and "Changed a role" both always appear there, regardless of which rows are shown or filtered). */
const eventsRegion = (html: string): string => /<section id="activity-events">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';

let t: TestCtx; let adminId = ''; let memberId = '';
beforeAll(async () => {
  t = await startTestApp();
  adminId = (await t.auth.api.createUser({ body: { email: 'admin@example.com', password: TEST_PASSWORD, name: 'Admin', role: 'admin' } })).user.id;
  memberId = (await t.auth.api.createUser({ body: { email: 'm@example.com', password: TEST_PASSWORD, name: '<b>Mallory</b>', role: 'member' } })).user.id;
  for (let i = 0; i < 60; i++) t.audit.record({ action: 'auth.login', actorUserId: memberId, details: { method: 'local' }, at: new Date(Date.UTC(2026, 8, 1, 0, i)) });
  t.audit.record({ action: 'user.role_changed', actorUserId: adminId, target: { type: 'user', id: memberId }, details: { from: 'member', to: 'admin', via: 'admin' }, at: new Date('2030-01-02T00:00:00Z') }); // newer than the sign-ins the tests themselves record
});
afterAll(async () => { await t.close(); });

describe('/admin/activity', () => {
  it('is admin-only', async () => {
    const m = adminClient(t); await m.signIn('m@example.com');
    expect((await m.get('/admin/activity')).status).toBe(403);
  });
  it('shows newest first, 50 per page, with pagination and escaped names', async () => {
    const a = adminClient(t); await a.signIn('admin@example.com');
    const html = await (await a.get('/admin/activity')).text();
    const events = eventsRegion(html);
    expect(events.indexOf('Changed a role')).toBeLessThan(events.indexOf('Signed in'));
    expect(html).toContain('&lt;b&gt;Mallory&lt;/b&gt;');
    expect(html).toContain('href="/admin/activity?page=2"');
    const p2 = await (await a.get('/admin/activity?page=2')).text();
    expect(p2).toContain('Page 2 of 2');
  });
  it('filters by user, action and date; ignores invalid filter values', async () => {
    const a = adminClient(t); await a.signIn('admin@example.com');
    const html = await (await a.get(`/admin/activity?action=user.role_changed&from=2030-01-02&to=2030-01-02&user=${adminId}`)).text();
    expect(html).toContain('Changed a role');
    expect(eventsRegion(html)).not.toContain('>Signed in<');
    expect((await a.get('/admin/activity?action=drop%20table&from=yesterday&page=-4')).status).toBe(200);
  });
  it('labels a refused login of another ICA person, with only its kind', async () => {
    t.audit.record({ action: 'ica.identity_refused', actorUserId: memberId, outcome: 'failure', details: { kind: 'app' }, at: new Date('2030-01-03T00:00:00Z') });
    const a = adminClient(t); await a.signIn('admin@example.com');
    const events = eventsRegion(await (await a.get('/admin/activity?action=ica.identity_refused')).text());
    expect(events).toContain('Refused another ICA person');
    expect(events).toContain('app');
  });
  it('filters from/to by the Stockholm-local calendar day, not the UTC one', async () => {
    const a = adminClient(t); await a.signIn('admin@example.com');
    // 23:30 Stockholm on 09-29 (still CEST, UTC+2) and 00:30 Stockholm on 09-30 — one UTC calendar day apart, but
    // both after 21:00Z: a UTC-day filter would put them on the wrong sides of the `to=2026-09-29` boundary.
    t.audit.record({ action: 'settings.changed', actorUserId: adminId, details: { setting: 'theme' }, at: new Date('2026-09-29T21:30:00Z') });
    t.audit.record({ action: 'settings.changed', actorUserId: adminId, details: { setting: 'theme' }, at: new Date('2026-09-29T22:30:00Z') });
    const to29 = eventsRegion(await (await a.get('/admin/activity?action=settings.changed&to=2026-09-29')).text());
    expect(to29).toContain('2026-09-29 23:30');
    expect(to29).not.toContain('2026-09-30 00:30');
    const from30 = eventsRegion(await (await a.get('/admin/activity?action=settings.changed&from=2026-09-30')).text());
    expect(from30).toContain('2026-09-30 00:30');
    expect(from30).not.toContain('2026-09-29 23:30');
  });
  it('treats a non-digit page as page 1, and a page past the last one as "no events" rather than "nothing yet"', async () => {
    const a = adminClient(t); await a.signIn('admin@example.com');
    const junk = eventsRegion(await (await a.get('/admin/activity?page=2abc')).text());
    expect(junk).toContain('Changed a role'); // page 1's content (the newest row), not page 2's
    const pastEnd = await (await a.get('/admin/activity?page=99')).text();
    expect(pastEnd).toContain('No events on this page');
    expect(pastEnd).toContain('href="/admin/activity"');
    expect(pastEnd).not.toContain('Tomt på kassaremsan');
  });
});
