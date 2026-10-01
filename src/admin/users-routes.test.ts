import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/index.js';
import { activeAdminCount } from '../users/admins.js';
import { s } from './i18n.js';
import { adminClient, startTestApp, TEST_PASSWORD, type AdminClient, type TestCtx } from '../test-helpers.js';

let t: TestCtx; let ids: Record<string, string> = {}; let clients = new Map<string, AdminClient>();
const mk = async (key: string, role: 'admin' | 'member') => { ids[key] = (await t.auth.api.createUser({ body: { email: `${key}@example.com`, password: TEST_PASSWORD, name: key, role } })).user.id; };
/** A signed-in client per user, reused: sign-ins are rate limited per IP, so each app instance gets few of them. */
const as = async (key: string, o: { fresh?: boolean } = {}): Promise<AdminClient> => {
  const cached = clients.get(key);
  if (cached && !o.fresh) return cached;
  const c = adminClient(t); await c.signIn(`${key}@example.com`); clients.set(key, c); return c;
};
/** Each describe block runs on its own app (and so its own sign-in rate limiter) with owner (admin), partner and kid. */
const freshApp = () => {
  beforeAll(async () => {
    t = await startTestApp(); ids = {}; clients = new Map();
    await mk('owner', 'admin'); await mk('partner', 'member'); await mk('kid', 'member');
  });
  afterAll(async () => { await t.close(); });
};
const roleOf = (key: string) => t.db.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, ids[key]!)).get()?.role;
const bannedOf = (key: string) => t.db.select({ b: schema.user.banned }).from(schema.user).where(eq(schema.user.id, ids[key]!)).get()?.b;
const exists = (key: string) => Boolean(t.db.select().from(schema.user).where(eq(schema.user.id, ids[key]!)).get());
const actions = () => t.db.select({ a: schema.auditEvent.action }).from(schema.auditEvent).all().map((r) => r.a);
const YES = { confirm: 'yes' };
const linkIca = (key: string, acc: string) => {
  const now = new Date().toISOString();
  t.db.insert(schema.icaAccount).values({ id: acc, displayName: key, createdAt: now, updatedAt: now }).onConflictDoNothing().run();
  t.db.insert(schema.icaSession).values({ id: `${acc}-web-${key}`, icaAccountId: acc, kind: 'web', stateEnc: 'v1.secret-state', expiresAt: new Date(Date.now() + 40 * 86_400_000).toISOString(), updatedAt: now }).run();
  t.db.insert(schema.userProfile).values({ userId: ids[key]!, icaAccountId: acc, createdAt: now })
    .onConflictDoUpdate({ target: schema.userProfile.userId, set: { icaAccountId: acc } }).run();
};
const grant = (key: string, client: string) => {
  const now = new Date(); const later = new Date(now.getTime() + 3_600_000);
  t.db.insert(schema.oauthClient).values({ id: client, clientId: client, name: client, redirectUris: ['http://127.0.0.1/cb'] }).onConflictDoNothing().run();
  t.db.insert(schema.oauthConsent).values({ id: `con-${client}-${key}`, clientId: client, userId: ids[key]!, scopes: ['mcp'], createdAt: now, updatedAt: now }).run();
  t.db.insert(schema.oauthRefreshToken).values({ id: `rt-${client}-${key}`, token: `rt-${client}-${key}`, clientId: client, userId: ids[key]!, scopes: ['mcp'], expiresAt: later, createdAt: now }).run();
};

describe('/admin/users: list, roles and the last-admin guard', () => {
  freshApp();
  it('lists users with role, ICA status and escaped names; members get 403', async () => {
    const a = await as('owner');
    const html = await (await a.get('/admin/users')).text();
    for (const k of ['owner', 'partner', 'kid']) expect(html).toContain(`${k}@example.com`);
    expect(html).toContain('Not connected');
    expect(html).toContain('Password'); // sign-in method
    expect(html).toMatch(/<time datetime=/); // owner's last sign-in, from the audit log
    const m = await as('partner');
    expect((await m.get('/admin/users')).status).toBe(403);
    expect((await m.post(`/admin/users/${ids.kid}/role`, { role: 'admin' })).status).toBe(403);
    expect((await m.post(`/admin/users/${ids.kid}/disable`, YES)).status).toBe(403);
    expect(roleOf('kid')).toBe('member');
    expect(bannedOf('kid')).toBeFalsy();
  });

  it('shows the ICA status only, never session data', async () => {
    linkIca('partner', 'partner-acc');
    const html = await (await (await as('owner')).get('/admin/users')).text();
    expect(html).toMatch(/Connected · expires in \d+ days/);
    expect(html).not.toContain('secret-state');
    expect(html).not.toContain('partner-acc');
  });

  it('changes a role with audit and flash; rejects an unknown role', async () => {
    const a = await as('owner');
    const r = await a.post(`/admin/users/${ids.partner}/role`, { role: 'admin' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/admin/users');
    expect(roleOf('partner')).toBe('admin');
    expect(actions()).toContain('user.role_changed');
    const html = await (await a.get('/admin/users')).text();
    expect(html).toContain('role="status"');
    expect(html).toContain('partner is now an admin');
    await a.post(`/admin/users/${ids.partner}/role`, { role: 'superuser' });
    expect(roleOf('partner')).toBe('admin');
    expect(await (await a.get('/admin/users')).text()).toContain('toast--error');
  });

  it('refuses to remove the last active admin by demotion, disable or removal', async () => {
    const a = await as('owner');
    await a.post(`/admin/users/${ids.partner}/role`, { role: 'member' }); // back to one admin
    expect(roleOf('partner')).toBe('member');
    const selfDemote = await a.post(`/admin/users/${ids.owner}/role`, { role: 'member' });
    expect(selfDemote.status).toBe(303);
    expect(roleOf('owner')).toBe('admin');
    const page = await (await a.get('/admin/users')).text();
    expect(page).toContain('at least one admin');
    for (const action of ['disable', 'remove']) {
      const r = await a.post(`/admin/users/${ids.owner}/${action}`, YES);
      expect(r.status).toBe(303);
      expect(await (await a.get('/admin/users')).text()).toContain('your own account');
    }
    expect(bannedOf('owner')).toBeFalsy();
    expect(exists('owner')).toBe(true);
    // with a second admin, self-demotion works and lands on Home (Users is now 403)
    await a.post(`/admin/users/${ids.partner}/role`, { role: 'admin' });
    const ok = await a.post(`/admin/users/${ids.owner}/role`, { role: 'member' });
    expect(ok.headers.get('location')).toBe('/admin');
    expect(roleOf('owner')).toBe('member');
    expect((await a.get('/admin/users')).status).toBe(403);
    const p = await as('partner');
    await p.post(`/admin/users/${ids.owner}/role`, { role: 'admin' });
    expect(roleOf('owner')).toBe('admin');
  });

  it('refuses to demote or disable the only other active admin', async () => {
    // partner is the only active admin besides owner; disable owner's admin role by banning owner directly, so that
    // partner is the last active admin, then owner's leftover session must not be able to take it away.
    const p = await as('partner');
    await mk('extra', 'admin');
    const x = await as('extra');
    // extra and partner are both active admins (plus owner): disabling owner is allowed
    expect((await x.post(`/admin/users/${ids.owner}/disable`, YES)).status).toBe(303);
    expect(bannedOf('owner')).toBe(true);
    // partner demotes extra: allowed, partner stays
    await p.post(`/admin/users/${ids.extra}/role`, { role: 'member' });
    expect(roleOf('extra')).toBe('member');
    expect(activeAdminCount(t.db)).toBe(1);
    // the only remaining admin cannot be demoted or disabled (by themselves — no other admin can act)
    await p.post(`/admin/users/${ids.partner}/role`, { role: 'member' });
    await p.post(`/admin/users/${ids.partner}/disable`, YES);
    expect(roleOf('partner')).toBe('admin');
    expect(bannedOf('partner')).toBeFalsy();
    // re-enable owner: two active admins again
    await p.post(`/admin/users/${ids.owner}/enable`, {});
    expect(bannedOf('owner')).toBeFalsy();
    expect(activeAdminCount(t.db)).toBe(2);
    await p.post(`/admin/users/${ids.extra}/remove`, YES);
    expect(exists('extra')).toBe(false);
  });

  it('keeps an admin when two admins demote each other at the same time', async () => {
    const a = await as('owner', { fresh: true }); // disabling owner above ended the old session
    const p = await as('partner');
    expect(activeAdminCount(t.db)).toBe(2);
    // Slow Better Auth down so both requests are past their own guard check before either role change lands.
    const api = t.auth.api as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const setRole = api.setRole!;
    api.setRole = async (...args) => { await new Promise((r) => setTimeout(r, 50)); return setRole(...args); };
    const rs = await Promise.all([
      a.post(`/admin/users/${ids.partner}/role`, { role: 'member' }),
      p.post(`/admin/users/${ids.owner}/role`, { role: 'member' }),
    ]).finally(() => { api.setRole = setRole; });
    // Serialised: the second runs after the first landed, finds its actor no longer an admin, and is refused (403)
    // before it reaches Better Auth.
    expect(rs.map((r) => r.status).sort()).toEqual([303, 403]);
    expect(activeAdminCount(t.db)).toBe(1);
    const left = roleOf('owner') === 'admin' ? a : p;
    await left.post(`/admin/users/${roleOf('owner') === 'admin' ? ids.partner : ids.owner}/role`, { role: 'admin' });
    expect(activeAdminCount(t.db)).toBe(2);
  });

  it('ignores a POST without the CSRF token, and an unknown user', async () => {
    const a = await as('owner');
    await a.post(`/admin/users/${ids.partner}/role`, { role: 'member' }, { csrf: null });
    expect(roleOf('partner')).toBe('admin');
    const r = await a.post('/admin/users/nobody/disable', YES);
    expect(r.status).toBe(303);
    expect(await (await a.get('/admin/users')).text()).toContain('toast--error');
  });
});

describe('/admin/users: disable, remove and ICA disconnect', () => {
  freshApp();

  it('asks for confirmation before a destructive action and changes nothing until confirmed', async () => {
    const a = await as('owner');
    linkIca('kid', 'kid-acc-0');
    for (const action of ['disable', 'remove', 'ica/disconnect']) {
      const r = await a.post(`/admin/users/${ids.kid}/${action}`, {});
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(html).toContain(`action="/admin/users/${ids.kid}/${action}"`);
      expect(html).toContain('name="confirm" value="yes"');
      expect(html).toContain('href="/admin/users"'); // cancel
    }
    expect(bannedOf('kid')).toBeFalsy();
    expect(exists('kid')).toBe(true);
    expect(t.db.select().from(schema.icaAccount).where(eq(schema.icaAccount.id, 'kid-acc-0')).get()).toBeDefined();
    // once disconnected there is nothing left to confirm: the POST just says so
    await a.post(`/admin/users/${ids.kid}/ica/disconnect`, YES);
    const again = await a.post(`/admin/users/${ids.kid}/ica/disconnect`, {});
    expect(again.status).toBe(303);
    expect(await (await a.get('/admin/users')).text()).toContain('kid has no ICA account connected');
  });

  it('disables (sign-in refused, sessions and Claude grants revoked) and enables', async () => {
    grant('kid', 'claude-kid');
    const kid = await as('kid');
    const a = await as('owner');
    await a.post(`/admin/users/${ids.kid}/disable`, YES);
    expect(bannedOf('kid')).toBe(true);
    expect((await kid.get('/admin')).status).toBe(302); // session gone
    const again = await adminClient(t).signIn('kid@example.com');
    expect(again.headers.get('location')).toMatch(/error=/);
    expect(actions()).toContain('user.disabled');
    expect(t.db.select().from(schema.oauthConsent).where(eq(schema.oauthConsent.userId, ids.kid!)).all()).toEqual([]);
    expect(t.db.select().from(schema.oauthRefreshToken).where(eq(schema.oauthRefreshToken.userId, ids.kid!)).get()?.revoked).toBeInstanceOf(Date);
    const revoked = t.db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, 'oauth.client_revoked')).all();
    expect(revoked.map((r) => [r.targetId, JSON.parse(r.detailsJson).reason])).toContainEqual(['claude-kid', 'user_disabled']);
    expect(await (await a.get('/admin/users')).text()).toContain('Disabled');
    await a.post(`/admin/users/${ids.kid}/enable`, {});
    expect((await adminClient(t).signIn('kid@example.com')).headers.get('location')).toBe('/admin');
    expect(actions()).toContain('user.enabled');
  });

  it('caps a huge (IdP-supplied) name at 100 code points in the flash message', async () => {
    t.db.update(schema.user).set({ name: '😀'.repeat(5000) }).where(eq(schema.user.id, ids.partner!)).run();
    const a = await as('owner');
    const r = await a.post(`/admin/users/${ids.partner}/disable`, YES);
    expect(r.status).toBe(303);
    const html = await (await a.get('/admin/users')).text();
    expect(html).toContain(s.flash.user_disabled({ name: '😀'.repeat(100) }));
    expect(html).not.toContain(s.flash.user_disabled({ name: '😀'.repeat(101) }));
    await a.post(`/admin/users/${ids.partner}/enable`, {});
    expect(await (await a.get('/admin/users')).text()).toContain(s.flash.user_enabled({ name: '😀'.repeat(100) }));
    t.db.update(schema.user).set({ name: 'partner' }).where(eq(schema.user.id, ids.partner!)).run();
  });

  it('disconnects a user\'s ICA account: sessions deleted, audited', async () => {
    const a = await as('owner');
    linkIca('kid', 'kid-acc-1');
    await a.post(`/admin/users/${ids.kid}/ica/disconnect`, YES);
    expect(t.db.select().from(schema.icaAccount).where(eq(schema.icaAccount.id, 'kid-acc-1')).get()).toBeUndefined();
    expect(t.db.select().from(schema.icaSession).where(eq(schema.icaSession.icaAccountId, 'kid-acc-1')).all()).toEqual([]);
    const ev = t.db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, 'ica.disconnected')).all().at(-1)!;
    expect([ev.actorUserId, ev.targetId, JSON.parse(ev.detailsJson)]).toEqual([ids.owner, ids.kid, { by: 'admin', mode: 'deleted' }]);
  });

  it('disconnecting a shared ICA account only unlinks it, and says so before and after', async () => {
    const a = await as('owner');
    linkIca('partner', 'shared-acc');
    linkIca('kid', 'shared-acc');
    const ask = await (await a.post(`/admin/users/${ids.kid}/ica/disconnect`, {})).text();
    expect(ask).toContain('shared with someone else in the household');
    const list = await (await a.get('/admin/users')).text();
    expect(list).toContain('Unlink kid from the shared ICA account?');
    await a.post(`/admin/users/${ids.kid}/ica/disconnect`, YES);
    expect(t.db.select().from(schema.icaAccount).where(eq(schema.icaAccount.id, 'shared-acc')).get()).toBeDefined();
    const ev = t.db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, 'ica.disconnected')).all().at(-1)!;
    expect(JSON.parse(ev.detailsJson)).toEqual({ by: 'admin', mode: 'unlinked' });
    expect(await (await a.get('/admin/users')).text()).toContain('kid is unlinked from the shared ICA account');
  });

  it('a removal that fails after grants and ICA were revoked says it is partial and asks for a retry', async () => {
    const a = await as('owner');
    await mk('flaky', 'member');
    linkIca('flaky', 'flaky-acc');
    const spy = vi.spyOn(t.auth.api, 'removeUser').mockResolvedValueOnce(new Response(null, { status: 500 }) as never);
    try {
      await a.post(`/admin/users/${ids.flaky}/remove`, YES);
    } finally { spy.mockRestore(); }
    expect(exists('flaky')).toBe(true);
    const html = await (await a.get('/admin/users')).text();
    expect(html).toContain('flaky was only partly removed');
    expect(html).not.toContain('Nothing was changed');
    const evs = t.db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, 'user.removed')).all()
      .filter((e) => e.targetId === ids.flaky).map((e) => [e.outcome, JSON.parse(e.detailsJson).stage]);
    expect(evs).toEqual([['success', 'intent'], ['failure', 'partial']]);
  });

  it('removes a user: sessions, grants, profile and ICA account go too; the audit trail stays', async () => {
    const a = await as('owner');
    linkIca('kid', 'kid-acc');
    grant('kid', 'claude-kid2');
    const kid = await as('kid', { fresh: true });
    await a.post(`/admin/users/${ids.kid}/remove`, YES);
    expect(exists('kid')).toBe(false);
    expect((await kid.get('/admin')).status).toBe(302);
    expect(t.db.select().from(schema.icaAccount).where(eq(schema.icaAccount.id, 'kid-acc')).get()).toBeUndefined();
    expect(t.db.select().from(schema.icaSession).where(eq(schema.icaSession.icaAccountId, 'kid-acc')).all()).toEqual([]);
    expect(t.db.select().from(schema.oauthRefreshToken).where(eq(schema.oauthRefreshToken.userId, ids.kid!)).all()).toEqual([]);
    const evs = t.db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, 'user.removed')).all().filter((e) => e.targetId === ids.kid);
    expect(evs.map((ev) => [ev.actorUserId, ev.outcome, JSON.parse(ev.detailsJson)])).toEqual([
      [ids.owner, 'success', { email: 'kid@example.com', stage: 'intent' }], [ids.owner, 'success', { email: 'kid@example.com', stage: 'done' }],
    ]);
    expect(await (await a.get('/admin/users')).text()).not.toContain('kid@example.com');
  });

  it('removing a user keeps an ICA account the household shares with another profile', async () => {
    const a = await as('owner');
    await mk('guest', 'member');
    linkIca('partner', 'partner-acc');
    linkIca('guest', 'partner-acc'); // the household shares partner's ICA account
    await a.post(`/admin/users/${ids.guest}/remove`, YES);
    expect(exists('guest')).toBe(false);
    expect(t.db.select().from(schema.icaAccount).where(eq(schema.icaAccount.id, 'partner-acc')).get()).toBeDefined();
    expect(t.db.select().from(schema.userProfile).where(eq(schema.userProfile.userId, ids.partner!)).get()?.icaAccountId).toBe('partner-acc');
  });

  it('offers Sign out instead of Disable/Remove on the admin\'s own row', async () => {
    const html = await (await (await as('owner')).get('/admin/users')).text();
    const own = /<li class="user card"[^>]*data-self[\s\S]*?<\/li>/.exec(html)![0];
    expect(own).toContain('action="/admin/logout"');
    expect(own).not.toContain('/disable"');
    expect(own).not.toContain('/remove"');
    expect(own).toContain('(you)');
  });
});

describe('/admin/users/:id/email', () => {
  freshApp();
  const emailOf = (key: string) => t.db.select({ e: schema.user.email }).from(schema.user).where(eq(schema.user.id, ids[key]!)).get()?.e;

  it('an admin changes a member\'s email: audited {from, to}, flash on the list', async () => {
    const a = await as('owner');
    const form = await (await a.get(`/admin/users/${ids.partner}/email`)).text();
    expect(form).toContain(`action="/admin/users/${ids.partner}/email"`);
    expect(form).toContain('partner@example.com');
    const r = await a.post(`/admin/users/${ids.partner}/email`, { email: ' Partner@Example.org ' });
    expect(r.headers.get('location')).toBe('/admin/users');
    expect(emailOf('partner')).toBe('partner@example.org');
    const ev = t.db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, 'user.email_changed')).all();
    expect(ev.map((x) => [x.actorUserId, x.targetId, JSON.parse(x.detailsJson)])).toEqual([[ids.owner, ids.partner, { from: 'partner@example.com', to: 'partner@example.org' }]]);
    expect(await (await a.get('/admin/users')).text()).toContain('email is now partner@example.org');
  });

  it('refuses a member (403), a POST without CSRF or Origin, and an invalid address', async () => {
    const m = await as('kid');
    expect((await m.post(`/admin/users/${ids.kid}/email`, { email: 'kid@example.com' })).status).toBe(403);
    expect((await m.get(`/admin/users/${ids.kid}/email`)).status).toBe(403);
    const a = await as('owner');
    await a.post(`/admin/users/${ids.kid}/email`, { email: 'kid2@example.com' }, { csrf: null });
    await a.post(`/admin/users/${ids.kid}/email`, { email: 'kid3@example.com' }, { origin: null });
    await a.post(`/admin/users/${ids.kid}/email`, { email: 'kidK@example.com' });
    expect(emailOf('kid')).toBe('kid@example.com');
    expect(await (await a.get(`/admin/users/${ids.kid}/email`)).text()).toContain('Enter a valid email address');
    expect((await a.get('/admin/users/nobody/email')).status).toBe(404);
  });

  it('an admin\'s own email is changed on Profile (current password), not here', async () => {
    const a = await as('owner');
    const r = await a.post(`/admin/users/${ids.owner}/email`, { email: 'owner.new@example.com' });
    expect(r.headers.get('location')).toBe('/admin/profile');
    expect(emailOf('owner')).toBe('owner@example.com');
    expect(await (await a.get('/admin/users')).text()).toContain('href="/admin/profile#email"');
    const form = await a.get(`/admin/users/${ids.owner}/email`);
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toBe('/admin/profile#email');
  });
});
