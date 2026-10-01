import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/index.js';
import { startFakeOidc, type FakeOidc } from '../auth/test-fakes.js';
import { adminClient, rawFetch, startTestApp, TEST_PASSWORD, type AdminClient, type TestCtx } from '../test-helpers.js';
import { isSelfChangedEmail } from './email.js';
import { createInvite } from './invites.js';

let t: TestCtx; let idp: FakeOidc; let ownerId: string; let memberId: string; let ip = 0;
const client = (): AdminClient => adminClient(t, { forwardedFor: `192.0.2.${++ip}` });
const userBy = (email: string) => t.db.select().from(schema.user).where(eq(schema.user.email, email)).get();
const accountsOf = (id: string) => t.db.select({ p: schema.account.providerId, a: schema.account.accountId }).from(schema.account).where(eq(schema.account.userId, id)).all();
const oidc = async (c: AdminClient, user: FakeOidc['next']) => { idp.next = user; return c.follow(await c.post('/admin/login/oidc', { oauth_query: '' })); };
beforeAll(async () => {
  idp = await startFakeOidc();
  t = await startTestApp({ OIDC_ISSUER_URL: idp.issuer, OIDC_CLIENT_ID: 'ica-hub', OIDC_CLIENT_SECRET: 'fake-secret', OIDC_LABEL: 'Authentik', TRUST_PROXY: '1' });
  ownerId = (await t.auth.api.createUser({ body: { email: 'owner@example.com', password: TEST_PASSWORD, name: 'Owner', role: 'admin' } })).user.id;
  memberId = (await t.auth.api.createUser({ body: { email: 'partner@example.com', password: TEST_PASSWORD, name: 'Partner', role: 'member' } })).user.id;
});
afterAll(async () => { await t.close(); await idp.close(); });

describe('email change', () => {
  it('owner changes email with only the password, signs in again, links OIDC by email; nothing is sent', async () => {
    const verificationsBefore = t.db.select().from(schema.verification).all().length;
    const c = client(); await c.signIn('owner@example.com');
    const r = await c.post('/admin/profile/email', { email: 'Owner.new@example.com', current: TEST_PASSWORD });
    expect(r.status).toBe(303);
    expect(userBy('owner.new@example.com')?.id).toBe(ownerId);
    expect(userBy('owner@example.com')).toBeUndefined();
    expect(t.db.select().from(schema.verification).all()).toHaveLength(verificationsBefore); // no change-email token, no mail
    expect(accountsOf(ownerId)).toEqual([{ p: 'credential', a: ownerId }]); // keyed on the user id: untouched
    // The same session, new email: read from the identity card (the flash on this first GET also names the address).
    const identity = /<section class="card profile-id">[\s\S]*?<\/section>/.exec(await (await c.get('/admin/profile')).text())?.[0] ?? '';
    expect(identity).toContain('>owner.new@example.com<');
    expect(identity).not.toContain('owner@example.com');
    expect((await client().signIn('owner.new@example.com')).headers.get('location')).toBe('/admin');
    expect((await client().signIn('owner@example.com')).headers.get('location')).toMatch(/error=credentials/);
    const { url } = await oidc(client(), { sub: 'sub-owner', email: 'owner.new@example.com', name: 'Owner' });
    expect(url).toBe(`${t.url}/admin`);
    expect(accountsOf(ownerId).map((a) => a.p).sort()).toEqual(['credential', 'upstream']);
    const ev = t.db.select().from(schema.auditEvent).where(and(eq(schema.auditEvent.action, 'user.email_changed'), eq(schema.auditEvent.outcome, 'success'))).get()!;
    expect(ev).toMatchObject({ actorUserId: ownerId, targetId: ownerId });
    expect(JSON.parse(ev.detailsJson)).toEqual({ from: 'owner@example.com', to: 'owner.new@example.com' });
    expect((await rawFetch(`${t.url}/auth/change-email`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
  });

  it('a wrong current password changes nothing and is audited', async () => {
    const c = client(); await c.signIn('partner@example.com');
    await c.post('/admin/profile/email', { email: 'c2@example.com', current: 'wrong-password-123' });
    expect(userBy('partner@example.com')?.id).toBe(memberId);
    expect(await (await c.get('/admin/profile')).text()).toContain('Your current password is wrong');
    const ev = t.db.select().from(schema.auditEvent).where(and(eq(schema.auditEvent.action, 'user.email_changed'), eq(schema.auditEvent.outcome, 'failure'))).get()!;
    expect(ev).toMatchObject({ actorUserId: memberId, targetId: memberId });
    expect(ev.detailsJson).not.toContain('wrong-password-123');
  });

  it('a member’s own change does not link by email until an admin confirms it', async () => {
    const c = client(); await c.signIn('partner@example.com');
    await c.post('/admin/profile/email', { email: 'partner@example.org', current: TEST_PASSWORD });
    expect((await oidc(client(), { sub: 'sub-partner', email: 'partner@example.org' })).url).toMatch(/error=account_not_linked/);
    const admin = client(); await admin.signIn('owner.new@example.com');
    expect(await (await admin.get('/admin/users')).text()).toContain('Email not confirmed');
    await admin.post(`/admin/users/${memberId}/email`, { email: 'partner@example.org' });
    expect((await oidc(client(), { sub: 'sub-partner', email: 'partner@example.org' })).url).toBe(`${t.url}/admin`);
  });

  it('admin changes a user’s email on the Users page; uniqueness is case-insensitive', async () => {
    const admin = client(); await admin.signIn('owner.new@example.com');
    await admin.post(`/admin/users/${memberId}/email`, { email: 'OWNER.NEW@EXAMPLE.COM' });
    expect(await (await admin.get(`/admin/users/${memberId}/email`)).text()).toContain('already belongs to another account');
    await admin.post(`/admin/users/${memberId}/email`, { email: 'caro@example.com' });
    expect(userBy('caro@example.com')?.id).toBe(memberId);
  });

  it('an OIDC-only user changes their own email without a password field', async () => {
    const { token } = createInvite(t.db, { email: 'oidc-only@example.com', role: 'member', createdByUserId: ownerId });
    const c = client();
    idp.next = { sub: 'sub-only', email: 'oidc-only@example.com' };
    expect((await c.follow(await c.post(`/admin/invite/${token}/oidc`, {}))).url).toBe(`${t.url}/admin`);
    const page = await (await c.get('/admin/profile')).text();
    expect(page).toContain('action="/admin/profile/email"');
    expect(page).not.toContain('name="current"');
    await c.post('/admin/profile/email', { email: 'only@example.com' });
    const u = userBy('only@example.com')!;
    expect(u).toBeDefined();
    expect(isSelfChangedEmail(t.db, u.id)).toBe(true); // a member's own change: rule (c) will not link by email into it
    const ev = t.db.select().from(schema.auditEvent).where(and(eq(schema.auditEvent.action, 'user.email_changed'), eq(schema.auditEvent.targetId, u.id))).all();
    expect(ev.map((x) => [x.outcome, JSON.parse(x.detailsJson)])).toEqual([['success', { from: 'oidc-only@example.com', to: 'only@example.com' }]]);
    const admin = client(); await admin.signIn('owner.new@example.com');
    expect(await (await admin.get('/admin/users')).text()).toContain('Email not confirmed'); // a member's own change
  });

  it('an OIDC-only admin\'s own change is vouched, not marked', async () => {
    const id = (await t.auth.api.createUser({ body: { email: 'sso-admin@example.com', password: TEST_PASSWORD, name: 'SSO admin', role: 'admin' } })).user.id;
    const c = client(); await c.signIn('sso-admin@example.com');
    t.db.delete(schema.account).where(eq(schema.account.userId, id)).run(); // single sign-on only from here on
    expect(await (await c.get('/admin/profile')).text()).not.toContain('name="current"');
    await c.post('/admin/profile/email', { email: 'sso-admin@example.org' });
    expect(userBy('sso-admin@example.org')?.id).toBe(id);
    expect(isSelfChangedEmail(t.db, id)).toBe(false);
  });
});
