import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/index.js';
import { adminClient, connectClaude, mcpPing, startTestApp, TEST_PASSWORD, type TestCtx } from '../test-helpers.js';

let t: TestCtx; let uid = '';
const EMAIL = 'asa.oberg-angstrom-with-a-very-long-local-part@example.com';
beforeAll(async () => {
  t = await startTestApp();
  uid = (await t.auth.api.createUser({ body: { email: EMAIL, password: TEST_PASSWORD, name: 'Åsa', role: 'member' } })).user.id;
});
afterAll(async () => { await t.close(); });

describe('/admin/profile', () => {
  it('long and Swedish names round-trip and render in wrapping containers', async () => { // Review Focus 5
    const c = adminClient(t); await c.signIn(EMAIL);
    const long = `Åsa Öberg-Ängström ${'å'.repeat(81)}`; // exactly 100 characters
    expect(long).toHaveLength(100);
    await c.post('/admin/profile/name', { name: `  ${long}  ` });
    expect(t.db.select().from(schema.user).where(eq(schema.user.id, uid)).get()!.name).toBe(long);
    const html = await (await c.get('/admin/profile')).text();
    expect(html).toContain(`<span class="truncate wrap-anywhere">${long}</span>`); // top bar
    expect(html).toMatch(/class="[^"]*wrap-anywhere[^"]*"[^>]*>asa\.oberg-angstrom-with-a-very-long-local-part@example\.com</);
    await c.post('/admin/profile/name', { name: `${long}x` });
    expect(t.db.select().from(schema.user).where(eq(schema.user.id, uid)).get()!.name).toBe(long);
    await c.post('/admin/profile/name', { name: '   ' });
    expect(t.db.select().from(schema.user).where(eq(schema.user.id, uid)).get()!.name).toBe(long);
  });

  it('lists sessions without their tokens and revokes one, then all others', async () => {
    const phone = adminClient(t); await phone.signIn(EMAIL);
    const laptop = adminClient(t); await laptop.signIn(EMAIL);
    const html = await (await laptop.get('/admin/profile')).text();
    const tokens = t.db.select({ token: schema.session.token }).from(schema.session).all().map((r) => r.token);
    for (const tok of tokens) expect(html).not.toContain(tok);
    const phoneToken = decodeURIComponent(/session_token=([^;]+)/.exec(phone.cookie())![1]!).split('.')[0]!;
    const phoneSessionId = t.db.select().from(schema.session).where(eq(schema.session.token, phoneToken)).get()!.id;
    await laptop.post(`/admin/profile/sessions/${phoneSessionId}/revoke`, {});
    expect((await phone.get('/admin')).status).toBe(302);
    await laptop.post('/admin/profile/sessions/revoke-others', {});
    expect(t.db.select().from(schema.session).where(eq(schema.session.userId, uid)).all()).toHaveLength(1);
    expect((await laptop.get('/admin')).status).toBe(200);
  });

  it('cannot revoke another user\'s session by id', async () => {
    const otherId = (await t.auth.api.createUser({ body: { email: 'other@example.com', password: TEST_PASSWORD, name: 'O', role: 'member' } })).user.id;
    const o = adminClient(t); await o.signIn('other@example.com');
    const otherSession = t.db.select().from(schema.session).where(eq(schema.session.userId, otherId)).get()!;
    const me = adminClient(t); await me.signIn(EMAIL);
    const count = () => t.db.select().from(schema.session).where(eq(schema.session.userId, otherId)).all().length;
    const before = count();
    const r = await me.post(`/admin/profile/sessions/${otherSession.id}/revoke`, {});
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/admin/profile');
    expect(await (await me.get('/admin/profile')).text()).toContain('That session was not found.');
    expect(count()).toBe(before);
    expect((await o.get('/admin')).status).toBe(200);
  });

  it('sign out everywhere ends browser sessions and Claude grants', async () => {
    const c = adminClient(t);
    const claude = await connectClaude(t, c, { email: EMAIL });
    expect((await mcpPing(t, claude.accessToken)).status).toBe(200);
    const r = await c.post('/admin/profile/sessions/revoke-all', {});
    expect(r.headers.get('location')).toBe('/admin/login');
    expect(r.headers.getSetCookie()).toContain('better-auth.session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    expect((await c.get('/admin')).status).toBe(302);
    expect(t.db.select().from(schema.oauthConsent).where(eq(schema.oauthConsent.userId, uid)).all()).toEqual([]);
    expect(t.db.select().from(schema.oauthRefreshToken).where(eq(schema.oauthRefreshToken.userId, uid)).all().every((r) => r.revoked !== null)).toBe(true);
    const acts = t.db.select({ a: schema.auditEvent.action }).from(schema.auditEvent).all().map((x) => x.a);
    expect(acts).toEqual(expect.arrayContaining(['auth.session_revoked', 'oauth.client_revoked']));
  });

  it('changes the password (current one required) and keeps only this session', async () => {
    const c = adminClient(t); await c.signIn(EMAIL);
    const other = adminClient(t); await other.signIn(EMAIL);
    await c.post('/admin/profile/password', { current: 'wrong-password-xyz', password: 'a-new-long-passphrase', confirm: 'a-new-long-passphrase' });
    expect((await adminClient(t).signIn(EMAIL, 'a-new-long-passphrase')).headers.get('location')).toMatch(/error=/);
    await c.post('/admin/profile/password', { current: TEST_PASSWORD, password: 'a-new-long-passphrase', confirm: 'a-new-long-passphrase' });
    expect((await adminClient(t).signIn(EMAIL, 'a-new-long-passphrase')).headers.get('location')).toBe('/admin');
    expect((await other.get('/admin')).status).toBe(302);
    expect((await c.get('/admin')).status).toBe(200);
  });
});

// A second app: the login limiter allows 10 sign-ins per IP per 15 minutes, and the tests above use them all.
describe('/admin/profile (fresh app)', () => {
  let u: TestCtx; let id = '';
  beforeAll(async () => {
    u = await startTestApp();
    id = (await u.auth.api.createUser({ body: { email: 'member@example.com', password: TEST_PASSWORD, name: 'Member', role: 'member' } })).user.id;
  });
  afterAll(async () => { await u.close(); });

  it('shows the member their own recent activity, without IP or user agent', async () => {
    const c = adminClient(u); await c.signIn('member@example.com');
    const html = await (await c.get('/admin/profile')).text();
    // An actual event row in the activity region: the "What" cell of this sign-in (not a label that always renders).
    const region = /<div id="profile-activity">([\s\S]*)<\/div><\/div><\/section>/.exec(html)?.[1] ?? '';
    expect(region).toMatch(/<tr><td data-label="Time"><time[^>]*>[^<]+<\/time><\/td><td data-label="Who">you<\/td><td data-label="What">Signed in<\/td>/);
    expect(html).not.toContain('User agent');
    expect(html).toContain('This device');
    expect(html).toContain('Password</li>');
  });

  it('refuses a short or mismatched new password and audits a change without any secret', async () => {
    const c = adminClient(u); await c.signIn('member@example.com');
    const short = await c.post('/admin/profile/password', { current: TEST_PASSWORD, password: 'short', confirm: 'short' });
    expect(short.status).toBe(303);
    await c.post('/admin/profile/password', { current: TEST_PASSWORD, password: 'one-long-passphrase', confirm: 'another-long-passphrase' });
    await c.post('/admin/profile/password', { current: 'not-my-password!', password: 'one-long-passphrase', confirm: 'one-long-passphrase' });
    const ok = await c.post('/admin/profile/password', { current: TEST_PASSWORD, password: 'one-long-passphrase', confirm: 'one-long-passphrase' });
    expect(ok.headers.get('location')).toBe('/admin/profile');
    expect(await (await c.get('/admin/profile')).text()).toContain('Password changed.');
    const events = u.db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, 'settings.changed')).all();
    expect(events.map((x) => [x.outcome, x.detailsJson])).toEqual([['failure', '{"setting":"password"}'], ['success', '{"setting":"password"}']]);
    for (const x of events) expect(`${x.detailsJson}`).not.toMatch(/passphrase|not-my-password|correct-horse/);
  });

  it('rate-limits password attempts', async () => {
    const c = adminClient(u); await c.signIn('member@example.com', 'one-long-passphrase');
    for (let i = 0; i < 5; i++) await c.post('/admin/profile/password', { current: 'wrong-wrong-wrong', password: 'x-long-passphrase', confirm: 'x-long-passphrase' });
    await c.post('/admin/profile/password', { current: 'one-long-passphrase', password: 'x-long-passphrase', confirm: 'x-long-passphrase' });
    expect(await (await c.get('/admin/profile')).text()).toContain('Too many password attempts.');
  });

  it('a sign-in older than a day still lists its devices (never a token) and can sign one out', async () => {
    const c = adminClient(u); await c.signIn('member@example.com', 'one-long-passphrase');
    const other = adminClient(u); await other.signIn('member@example.com', 'one-long-passphrase');
    // Past Better Auth's `freshAge` (1 day), where its own listSessions would refuse.
    u.db.update(schema.session).set({ createdAt: new Date(Date.now() - 2 * 86_400_000) }).where(eq(schema.session.userId, id)).run();
    const html = await (await c.get('/admin/profile')).text();
    const mine = u.db.select().from(schema.session).where(eq(schema.session.userId, id)).all();
    expect(html.match(/<li class="session"/g)).toHaveLength(mine.length);
    for (const row of mine) {
      expect(html).not.toContain(row.token);
    }
    const otherToken = decodeURIComponent(/session_token=([^;]+)/.exec(other.cookie())![1]!).split('.')[0]!;
    const otherRow = mine.find((row) => row.token === otherToken)!;
    expect(html).toContain(`action="/admin/profile/sessions/${otherRow.id}/revoke"`);
    await c.post(`/admin/profile/sessions/${otherRow.id}/revoke`, {});
    expect((await other.get('/admin')).status).toBe(302);
    expect((await c.get('/admin')).status).toBe(200);
    const revoked = u.db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, 'auth.session_revoked')).all().at(-1)!;
    expect(revoked).toMatchObject({ targetType: 'session', targetId: otherRow.id, actorUserId: id, detailsJson: '{"scope":"one"}' });
  });

  it('says exactly what happened when Claude is disconnected but ending the sessions fails', async () => {
    const c = adminClient(u); await c.signIn('member@example.com', 'one-long-passphrase');
    const spy = vi.spyOn(u.auth.api, 'revokeSessions').mockResolvedValueOnce(new Response('boom', { status: 500 }) as never);
    try {
      const r = await c.post('/admin/profile/sessions/revoke-all', {});
      expect(r.headers.get('location')).toBe('/admin/profile');
    } finally { spy.mockRestore(); }
    const html = await (await c.get('/admin/profile')).text();
    expect(html).toContain('Claude was disconnected, but signing out your devices failed — try again');
    expect(html).not.toContain('That did not work');
    const last = u.db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, 'auth.session_revoked')).all().at(-1)!;
    expect(last).toMatchObject({ outcome: 'failure', detailsJson: '{"scope":"everywhere"}' });
  });

  it('lists at most 50 sessions (this device always among them) and counts the rest', async () => {
    const c = adminClient(u); await c.signIn('member@example.com', 'one-long-passphrase');
    const now = Date.now();
    // 60 more sessions, all more recently active than this one.
    u.db.insert(schema.session).values(Array.from({ length: 60 }, (_, i) => ({
      id: `bulk-${i}`, token: `bulk-token-${i}`, userId: id, expiresAt: new Date(now + 86_400_000),
      createdAt: new Date(now), updatedAt: new Date(now + 60_000 + i), userAgent: 'Version/1 '.repeat(2000),
    }))).run();
    const total = u.db.select().from(schema.session).where(eq(schema.session.userId, id)).all().length;
    const html = await (await c.get('/admin/profile')).text();
    expect(html.match(/<li class="session"/g)).toHaveLength(50);
    expect(html).toContain('This device');
    expect(html).toContain(`and ${total - 50} more sessions.`);
    expect(html).not.toContain('bulk-token-');
    u.db.delete(schema.session).where(eq(schema.session.userId, id)).run();
  });

  it('stores at most 512 characters of a user agent on the session row', async () => {
    const r = await u.auth.api.signInEmail({
      body: { email: 'member@example.com', password: 'one-long-passphrase' },
      headers: new Headers({ 'user-agent': `Mozilla/5.0 ${'x'.repeat(5000)}` }), asResponse: true,
    });
    expect(r.ok).toBe(true);
    const rows = u.db.select().from(schema.session).where(eq(schema.session.userId, id)).all();
    expect(rows.map((row) => row.userAgent?.length)).toEqual([512]);
  });

  it('an account without a password has no password form and cannot post one', async () => {
    const c = adminClient(u); await c.signIn('member@example.com', 'one-long-passphrase');
    // As for a member who only signs in with single sign-on: no credential account.
    u.db.delete(schema.account).where(eq(schema.account.userId, id)).run();
    const html = await (await c.get('/admin/profile')).text();
    expect(html).not.toContain('action="/admin/profile/password"');
    expect(html).not.toContain('Password</li>');
    expect((await c.post('/admin/profile/password', { current: 'one-long-passphrase', password: 'x-long-passphrase', confirm: 'x-long-passphrase' })).status).toBe(403);
  });
});

describe('/admin/profile/email', () => {
  let u: TestCtx; let id = '';
  const emailOf = () => u.db.select({ e: schema.user.email }).from(schema.user).where(eq(schema.user.id, id)).get()?.e;
  beforeAll(async () => {
    u = await startTestApp();
    id = (await u.auth.api.createUser({ body: { email: 'member@example.com', password: TEST_PASSWORD, name: 'Member', role: 'member' } })).user.id;
  });
  afterAll(async () => { await u.close(); });

  it('shows the email form with the current password; a member is told an admin confirms it', async () => {
    const c = adminClient(u); await c.signIn('member@example.com');
    const html = await (await c.get('/admin/profile')).text();
    expect(html).toContain('action="/admin/profile/email"');
    expect(html).toMatch(/name="current"[^>]*autocomplete="current-password"|autocomplete="current-password"[^>]*name="current"/);
    expect(html).toContain('An admin confirms a new address before single sign-on can link to it.');
  });

  it('refuses without the Origin header or CSRF token, and an empty password', async () => {
    const c = adminClient(u); await c.signIn('member@example.com');
    await c.post('/admin/profile/email', { email: 'm1@example.com', current: TEST_PASSWORD }, { origin: null });
    await c.post('/admin/profile/email', { email: 'm2@example.com', current: TEST_PASSWORD }, { csrf: null });
    await c.post('/admin/profile/email', { email: 'm3@example.com' });
    expect(emailOf()).toBe('member@example.com');
  });

  it('rate-limits wrong current passwords; failures are audited without the password', async () => {
    const c = adminClient(u); await c.signIn('member@example.com');
    for (let i = 0; i < 5; i++) await c.post('/admin/profile/email', { email: 'new@example.com', current: 'wrong-wrong-wrong' });
    await c.post('/admin/profile/email', { email: 'new@example.com', current: TEST_PASSWORD });
    expect(emailOf()).toBe('member@example.com');
    expect(await (await c.get('/admin/profile')).text()).toContain('Too many attempts. Wait a few minutes and try again.');
    const failures = u.db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, 'user.email_changed')).all();
    expect(failures.length).toBeGreaterThan(0);
    for (const x of failures) {
      expect(x.outcome).toBe('failure');
      expect(x.detailsJson).not.toMatch(/wrong-wrong|correct-horse/);
    }
  });

  it('rate-limits an account without a password too (own app: the per-IP budget above is spent)', async () => {
    const u = await startTestApp();
    const sso = (await u.auth.api.createUser({ body: { email: 'sso@example.com', password: TEST_PASSWORD, name: 'SSO', role: 'member' } })).user.id;
    const c = adminClient(u); await c.signIn('sso@example.com');
    u.db.delete(schema.account).where(eq(schema.account.userId, sso)).run(); // single sign-on only
    for (let i = 1; i <= 6; i++) await c.post('/admin/profile/email', { email: `sso${i}@example.com` });
    expect(u.db.select({ e: schema.user.email }).from(schema.user).where(eq(schema.user.id, sso)).get()?.e).toBe('sso5@example.com');
    const html = await (await c.get('/admin/profile')).text();
    expect(html).toContain('Too many attempts. Wait a few minutes and try again.');
    expect(html).not.toContain('Too many password attempts.');
    await u.close();
  });
});
