import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, openDb, schema, type Db } from '../db/index.js';
import { createAudit } from '../audit.js';
import { loadConfig, type Config } from '../config.js';
import { createInvite } from '../users/invites.js';
import { seedUser } from '../test-helpers.js';
import { activeAdminCount } from '../users/admins.js';
import { createSeenGroups } from './seen-groups.js';
import type { SetupGate } from '../setup/state.js';
import { createOidcPolicy, createOidcRejections, isMatchableEmail, oidcErrorUrl, OIDC_ERROR_CODES } from './oidc-policy.js';

const KEY = Buffer.alloc(32, 1).toString('base64');
const baseEnv = { ICA_HUB_URL: 'https://ica.example.com', ICA_HUB_MASTER_KEY: KEY, ICA_HUB_AUTH_SECRET: 'x'.repeat(32), DATABASE_PATH: ':memory:' };
const oidcEnv = { OIDC_ISSUER_URL: 'https://idp.example.com/application/o/ica-hub/', OIDC_CLIENT_ID: 'ica-hub', OIDC_CLIENT_SECRET: 's', OIDC_ADMIN_GROUP: 'ica-admins' };
type EndpointCtx = Parameters<ReturnType<typeof createOidcPolicy>['validateUserInfo']>[1];
const ctx = { headers: new Headers({ 'x-ica-hub-client-ip': '203.0.113.7', 'user-agent': 'Browser/1' }) } as unknown as EndpointCtx;
const oauth = (action: 'create-user' | 'link-account' | 'sign-in', profile: Record<string, unknown> = {}) =>
  ({ method: 'oauth', action, oauth: { providerId: 'upstream', profile } }) as const;

describe('createOidcRejections', () => {
  it('is single-use and expires after 5 minutes', () => {
    let now = 1_000_000;
    const r = createOidcRejections({ now: () => now });
    const a = r.put('a@example.com');
    expect(a).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(r.take(a)).toBe('a@example.com');
    expect(r.take(a)).toBeUndefined();
    const b = r.put('b@example.com');
    now += 5 * 60_000 + 1;
    expect(r.take(b)).toBeUndefined();
    expect(r.take('unknown')).toBeUndefined();
  });
});

describe('oidcErrorUrl and OIDC_ERROR_CODES', () => {
  it('keeps the OAuth query and ends with our fixed marker', () => {
    expect(oidcErrorUrl('')).toBe('/admin/login?error=oidc');
    expect(oidcErrorUrl('client_id=c&sig=s')).toBe('/admin/login?client_id=c&sig=s&error=oidc');
    expect(OIDC_ERROR_CODES).toEqual([
      'not_invited', 'email_not_verified', 'email_invalid', 'account_not_linked', 'banned_user', 'not_in_group', 'groups_missing', 'setup_incomplete',
      'state_not_found', 'state_mismatch', 'access_denied', 'failed',
    ]);
  });
});

describe('createOidcPolicy', () => {
  let db: Db; let config: Config; const warn = vi.fn();
  const failures = () => db.select().from(schema.auditEvent).all().filter((e) => e.action === 'auth.login_failed').map((e) => ({ ...JSON.parse(e.detailsJson), ip: e.ip, ua: e.userAgent }));
  const policy = (c: Config = config) => {
    const rejections = createOidcRejections();
    return { rejections, ...createOidcPolicy({ db, config: c, audit: createAudit(db, { warn }), rejections, log: { warn } }) };
  };
  beforeEach(() => {
    db = openDb(':memory:');
    config = loadConfig({ ...baseEnv, ...oidcEnv });
    seedUser(db, 'admin-1', { role: 'admin', email: 'admin@example.com' });
    seedUser(db, 'member-1', { role: 'member', email: 'member@example.com' });
  });
  afterEach(() => { closeDb(db); });

  it('leaves admin and email-password provisioning untouched', async () => {
    const p = policy();
    expect(await p.validateUserInfo({ user: { email: 'x@example.com' }, source: { method: 'admin', action: 'create-user' } }, ctx)).toBeUndefined();
    expect(await p.validateUserInfo({ user: { email: 'x@example.com' }, source: { method: 'email-password', action: 'sign-in' } }, ctx)).toBeUndefined();
    expect(await p.validateUserInfo({ user: { email: 'x@example.com', emailVerified: true }, source: { method: 'oauth', action: 'create-user', oauth: { providerId: 'other' } } }, ctx)).toBeUndefined();
    expect(failures()).toEqual([]);
  });

  it('rejects create-user without an invite with an opaque ref, and records the failure', async () => {
    const p = policy();
    const r = await p.validateUserInfo({ user: { email: 'Stranger@Example.com', emailVerified: true }, source: oauth('create-user') }, ctx);
    expect(r).toEqual({ error: 'not_invited', errorDescription: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/) });
    expect(p.rejections.take(r!.errorDescription!)).toBe('stranger@example.com');
    expect(failures()).toEqual([{ method: 'oidc', reason: 'not_invited', email: 'stranger@example.com', ip: '203.0.113.7', ua: 'Browser/1' }]);
  });

  it('allows create-user with a pending invite', async () => {
    createInvite(db, { email: 'new@example.com', role: 'member', createdByUserId: 'admin-1' });
    expect(await policy().validateUserInfo({ user: { email: 'NEW@example.com', emailVerified: true }, source: oauth('create-user') }, ctx)).toBeUndefined();
  });

  it.each(['create-user', 'link-account', 'sign-in'] as const)('rejects %s unless email_verified is true', async (action) => {
    createInvite(db, { email: 'new@example.com', role: 'member', createdByUserId: 'admin-1' });
    const p = policy();
    for (const emailVerified of [false, undefined, 'true']) {
      const user = { id: action === 'create-user' ? undefined : 'member-1', email: 'new@example.com', emailVerified } as Record<string, unknown>;
      expect(await p.validateUserInfo({ user, source: oauth(action) }, ctx)).toEqual({ error: 'email_not_verified' });
    }
    expect(failures().map((f) => f.reason)).toEqual(['email_not_verified', 'email_not_verified', 'email_not_verified']);
  });

  it('rejects link-account when linking by email is off', async () => {
    const off = loadConfig({ ...baseEnv, ...oidcEnv, OIDC_LINK_BY_EMAIL: 'false' });
    expect(await policy(off).validateUserInfo({ user: { id: 'member-1', email: 'member@example.com', emailVerified: true }, source: oauth('link-account') }, ctx)).toEqual({ error: 'account_not_linked' });
    expect(await policy().validateUserInfo({ user: { id: 'member-1', email: 'member@example.com', emailVerified: true }, source: oauth('link-account') }, ctx)).toBeUndefined();
    expect(failures().map((f) => f.reason)).toEqual(['account_not_linked']);
  });

  it('refuses link-account into an email a member set themselves, until an admin confirms it (rule c)', async () => {
    db.insert(schema.userProfile).values({ userId: 'member-1', createdAt: new Date().toISOString(), emailSelfChangedAt: new Date().toISOString() }).run();
    const p = policy();
    const link = () => p.validateUserInfo({ user: { id: 'member-1', email: 'member@example.com', emailVerified: true }, source: oauth('link-account') }, ctx);
    expect(await link()).toEqual({ error: 'account_not_linked' });
    db.update(schema.userProfile).set({ emailSelfChangedAt: null }).where(eq(schema.userProfile.userId, 'member-1')).run();
    expect(await link()).toBeUndefined();
    expect(failures().map((f) => f.reason)).toEqual(['account_not_linked']);
  });

  it('links only the first OIDC identity of a user (rule c)', async () => {
    db.insert(schema.account).values({ id: 'acc-1', accountId: 'sub-a', providerId: 'upstream', userId: 'admin-1', updatedAt: new Date() }).run();
    const p = policy();
    expect(await p.validateUserInfo({ user: { id: 'admin-1', email: 'admin@example.com', emailVerified: true }, source: oauth('link-account') }, ctx)).toEqual({ error: 'account_not_linked' });
    expect(await p.validateUserInfo({ user: { id: 'admin-1', email: 'admin@example.com', emailVerified: true }, source: oauth('sign-in') }, ctx)).toBeUndefined();
    expect(failures().map((f) => [f.reason, f.email])).toEqual([['account_not_linked', 'admin@example.com']]);
  });

  it('refuses an email claim that is not NFKC-stable or has a non-ASCII local part', async () => {
    expect(isMatchableEmail('admin@example.com')).toBe(true);
    expect(isMatchableEmail('Kid@Example.COM')).toBe(true);
    expect(isMatchableEmail('\u212Aid@example.com')).toBe(false); // KELVIN SIGN, toLowerCase → 'k'
    expect(isMatchableEmail('åsa@example.com')).toBe(false);
    expect(isMatchableEmail('ﬁle@example.com')).toBe(false);
    expect(isMatchableEmail('no-at-sign')).toBe(false);
    const p = policy();
    // Better Auth has already lowercased user.email (the fold happened); the raw claim is in the profile.
    const r = await p.validateUserInfo({ user: { id: 'admin-1', email: 'admin@example.com', emailVerified: true }, source: oauth('link-account', { email: 'ADMIN@example.com'.replace('A', '\u0391') }) }, ctx);
    expect(r).toEqual({ error: 'email_invalid' });
    expect(await p.validateUserInfo({ user: { email: 'kid@example.com', emailVerified: true }, source: oauth('create-user', { email: '\u212Aid@example.com' }) }, ctx)).toEqual({ error: 'email_invalid' });
    expect(failures().map((f) => f.reason)).toEqual(['email_invalid', 'email_invalid']);
  });

  it('refuses a disabled user (a lapsed ban is not a ban)', async () => {
    db.update(schema.user).set({ banned: true }).run();
    const p = policy();
    expect(await p.validateUserInfo({ user: { id: 'member-1', email: 'member@example.com', emailVerified: true }, source: oauth('sign-in', { groups: ['ica-admins'] }) }, ctx)).toEqual({ error: 'banned_user' });
    expect(db.select().from(schema.user).all().find((u) => u.id === 'member-1')?.role).toBe('member');
    db.update(schema.user).set({ banExpires: new Date(Date.now() - 1000) }).run();
    expect(await p.validateUserInfo({ user: { id: 'member-1', email: 'member@example.com', emailVerified: true }, source: oauth('sign-in') }, ctx)).toBeUndefined();
  });

  it('promotes members of OIDC_ADMIN_GROUP once the sign-in has a session, and never demotes', async () => {
    const p = policy();
    const role = (id: string) => db.select().from(schema.user).all().find((u) => u.id === id)?.role;
    const signIn = async (id: string, email: string, groups: unknown) => {
      await p.validateUserInfo({ user: { id, email, emailVerified: true }, source: oauth('sign-in', { groups }) }, ctx);
      await p.afterSessionCreate({ userId: id }, { path: '/callback/:id' });
    };
    await signIn('member-1', 'member@example.com', 'ica-admins');
    expect(role('member-1')).toBe('member'); // not an array: ignored
    await p.validateUserInfo({ user: { id: 'member-1', email: 'member@example.com', emailVerified: true }, source: oauth('sign-in', { groups: ['ica-admins'] }) }, ctx);
    expect(role('member-1')).toBe('member'); // validated only: the flow may still fail
    await p.validateUserInfo({ user: { id: 'member-1', email: 'member@example.com', emailVerified: true }, source: oauth('sign-in', { groups: [] }) }, ctx);
    await p.afterSessionCreate({ userId: 'member-1' }, { path: '/callback/:id' });
    expect(role('member-1')).toBe('member'); // the failed flow's group does not carry over to a later sign-in
    await signIn('member-1', 'member@example.com', ['ica-admins']);
    expect(role('member-1')).toBe('admin');
    await signIn('admin-1', 'admin@example.com', []);
    expect(role('admin-1')).toBe('admin');
    const changed = db.select().from(schema.auditEvent).all().filter((e) => e.action === 'user.role_changed');
    expect(changed.map((e) => [e.targetId, JSON.parse(e.detailsJson)])).toEqual([['member-1', { from: 'member', to: 'admin', via: 'oidc_group' }]]);
  });

  it('keys a pending promotion by user id: an IdP email that is someone else\'s stored email promotes nobody else', async () => {
    seedUser(db, 'member-2', { role: 'member', email: 'b@example.com' });
    const p = policy();
    const role = (id: string) => db.select().from(schema.user).all().find((u) => u.id === id)?.role;
    // A (stored member@example.com) signs in while the IdP says b@example.com and puts A in the admin group…
    await p.validateUserInfo({ user: { id: 'member-1', email: 'b@example.com', emailVerified: true }, source: oauth('sign-in', { email: 'b@example.com', groups: ['ica-admins'] }) }, ctx);
    // …then B (stored b@example.com) signs in without the group, before A's session: B stays a member.
    await p.validateUserInfo({ user: { id: 'member-2', email: 'other@example.com', emailVerified: true }, source: oauth('sign-in', { groups: [] }) }, ctx);
    await p.afterSessionCreate({ userId: 'member-2' }, { path: '/callback/:id' });
    expect(role('member-2')).toBe('member');
    // A's own session applies A's drifted-email promotion.
    await p.afterSessionCreate({ userId: 'member-1' }, { path: '/callback/:id' });
    expect(role('member-1')).toBe('admin');
    expect(role('member-2')).toBe('member');
  });

  it('moves a create-user promotion to the new user only, and applies it once', async () => {
    createInvite(db, { email: 'new@example.com', role: 'member', createdByUserId: 'admin-1' });
    const p = policy();
    await p.validateUserInfo({ user: { email: 'new@example.com', emailVerified: true }, source: oauth('create-user', { groups: ['ica-admins'] }) }, ctx);
    await p.afterSessionCreate({ userId: 'member-1' }, { path: '/callback/:id' }); // someone else's session: nothing
    expect(db.select().from(schema.user).all().find((u) => u.id === 'member-1')?.role).toBe('member');
    seedUser(db, 'new-1', { email: 'new@example.com' });
    await p.afterUserCreate({ id: 'new-1', email: 'new@example.com' }, { path: '/callback/:id' });
    expect(db.select().from(schema.user).all().find((u) => u.id === 'new-1')?.role).toBe('member'); // the invite's role until the session
    await p.afterSessionCreate({ userId: 'new-1' }, { path: '/callback/:id' });
    await p.afterSessionCreate({ userId: 'new-1' }, { path: '/callback/:id' });
    expect(db.select().from(schema.user).all().find((u) => u.id === 'new-1')?.role).toBe('admin');
    expect(db.select().from(schema.auditEvent).all().filter((e) => e.action === 'user.role_changed' && e.targetId === 'new-1')).toHaveLength(1);
  });

  it('ignores the groups claim when no admin group is configured', async () => {
    const noGroup = loadConfig({ ...baseEnv, ...oidcEnv, OIDC_ADMIN_GROUP: '' });
    const p = policy(noGroup);
    await p.validateUserInfo({ user: { id: 'member-1', email: 'member@example.com', emailVerified: true }, source: oauth('sign-in', { groups: ['ica-admins'] }) }, ctx);
    await p.afterSessionCreate({ userId: 'member-1' }, { path: '/callback/:id' });
    expect(db.select().from(schema.user).all().find((u) => u.id === 'member-1')?.role).toBe('member');
  });

  it('afterUserCreate claims the chosen invite and sets its role; without one the user is disabled', async () => {
    const { invite } = createInvite(db, { email: 'new@example.com', role: 'admin', createdByUserId: 'admin-1' });
    const p = policy();
    await p.validateUserInfo({ user: { email: 'new@example.com', emailVerified: true }, source: oauth('create-user') }, ctx);
    seedUser(db, 'new-1', { email: 'new@example.com' });
    await p.afterUserCreate({ id: 'new-1', email: 'new@example.com' }, { path: '/callback/:id' });
    const u = db.select().from(schema.user).all().find((x) => x.id === 'new-1')!;
    expect(u.role).toBe('admin');
    expect(u.banned).toBe(false);
    expect(db.select().from(schema.invite).all()[0]).toMatchObject({ id: invite.id, acceptedUserId: 'new-1' });
    expect(db.select().from(schema.userProfile).all()).toEqual([expect.objectContaining({ userId: 'new-1' })]);

    seedUser(db, 'odd-1', { email: 'odd@example.com' });
    await p.afterUserCreate({ id: 'odd-1', email: 'odd@example.com' }, { path: '/callback/:id' });
    expect(db.select().from(schema.user).all().find((x) => x.id === 'odd-1')?.banned).toBe(true);
    expect(warn).toHaveBeenCalled();

    seedUser(db, 'admin-made', { email: 'made@example.com' });
    await p.afterUserCreate({ id: 'admin-made', email: 'made@example.com' }, { path: '/admin/create-user' });
    await p.afterUserCreate({ id: 'admin-made', email: 'made@example.com' }, null);
    expect(db.select().from(schema.user).all().find((x) => x.id === 'admin-made')?.banned).toBe(false);
  });

  it('afterSessionCreate audits OIDC sign-ins only', async () => {
    const p = policy();
    await p.afterSessionCreate({ userId: 'member-1', ipAddress: '203.0.113.7', userAgent: 'UA' }, { path: '/callback/:id' });
    await p.afterSessionCreate({ userId: 'member-1' }, { path: '/sign-in/email' });
    await p.afterSessionCreate({ userId: 'member-1' }, null);
    const rows = db.select().from(schema.auditEvent).all();
    expect(rows.map((e) => [e.action, e.actorUserId, e.ip, JSON.parse(e.detailsJson)])).toEqual([['auth.login', 'member-1', '203.0.113.7', { method: 'oidc' }]]);
  });
  describe('first admin via OIDC during setup', () => {
    const claimAll = (max = 1): SetupGate & { claims: number } => {
      const g = { claims: 0, claimFirstAdmin: (h: string | undefined) => { if (h !== 'ica-hub.setup=ok' || g.claims >= max) return false; g.claims++; return true; }, close: vi.fn() };
      return g;
    };
    const input = (email: string) => ({ user: { email, emailVerified: true }, source: { method: 'oauth' as const, action: 'create-user' as const, oauth: { providerId: 'upstream', profile: { email, email_verified: true } } } });
    const withCookie = (cookie?: string) => ({ headers: new Headers(cookie ? { cookie } : {}) }) as unknown as EndpointCtx;
    const setupPolicy = (sdb: Db, setup: SetupGate) => createOidcPolicy({ db: sdb, config, audit: createAudit(sdb, { warn }), rejections: createOidcRejections(), log: { warn }, setup });

    it('allows create-user without an invite only for the setup session, once', async () => {
      const sdb = openDb(':memory:'); const setup = claimAll();
      const p = setupPolicy(sdb, setup);
      expect(await p.validateUserInfo(input('stranger@example.com'), withCookie())).toMatchObject({ error: 'not_invited' });
      expect(await p.validateUserInfo(input('owner.new@example.com'), withCookie('ica-hub.setup=ok'))).toBeUndefined();
      expect(await p.validateUserInfo(input('second@example.com'), withCookie('ica-hub.setup=ok'))).toMatchObject({ error: 'not_invited' });
    });
    it('never claims before the email checks pass', async () => {
      const sdb = openDb(':memory:'); const setup = claimAll();
      const p = setupPolicy(sdb, setup);
      const unverified = { ...input('owner.new@example.com'), user: { email: 'owner.new@example.com', emailVerified: false } };
      expect(await p.validateUserInfo(unverified, withCookie('ica-hub.setup=ok'))).toMatchObject({ error: 'email_not_verified' });
      expect(setup.claims).toBe(0);
    });
    it('the created user becomes admin only if it is the only user; otherwise it is disabled', async () => {
      const sdb = openDb(':memory:'); const setup = claimAll();
      const p = setupPolicy(sdb, setup);
      await p.validateUserInfo(input('owner.new@example.com'), withCookie('ica-hub.setup=ok'));
      seedUser(sdb, 'winner', { email: 'winner@example.com', role: 'admin' }); // the password path won the race meanwhile
      seedUser(sdb, 'oidc', { email: 'owner.new@example.com' });
      await p.afterUserCreate({ id: 'oidc', email: 'owner.new@example.com' }, { path: '/callback/upstream' });
      const u = sdb.select().from(schema.user).where(eq(schema.user.id, 'oidc')).get()!;
      expect(u.role).not.toBe('admin'); expect(u.banned).toBe(true);
      expect(setup.close).not.toHaveBeenCalled();
    });
    it('two setup users created before either hook ran: the earlier one still becomes admin (never stuck without one)', async () => {
      const sdb = openDb(':memory:'); const setup = claimAll(2);
      const p = setupPolicy(sdb, setup);
      await p.validateUserInfo(input('a@example.com'), withCookie('ica-hub.setup=ok'));
      await p.validateUserInfo(input('b@example.com'), withCookie('ica-hub.setup=ok'));
      sdb.insert(schema.user).values({ id: 'a', name: 'a', email: 'a@example.com', createdAt: new Date(1_000) }).run();
      sdb.insert(schema.user).values({ id: 'b', name: 'b', email: 'b@example.com', createdAt: new Date(2_000) }).run();
      // The later user's hook runs first: it is not the first user, so it is disabled…
      await p.afterUserCreate({ id: 'b', email: 'b@example.com' }, { path: '/callback/upstream' });
      // …and the earlier user's own hook still promotes it.
      await p.afterUserCreate({ id: 'a', email: 'a@example.com' }, { path: '/callback/upstream' });
      const rows = sdb.select({ id: schema.user.id, role: schema.user.role, banned: schema.user.banned }).from(schema.user).all();
      expect(rows).toEqual(expect.arrayContaining([{ id: 'a', role: 'admin', banned: false }, expect.objectContaining({ id: 'b', banned: true })]));
      expect(setup.close).toHaveBeenCalledTimes(1);
    });
    it('a setup callback slower than the pending TTL still promotes (no invite fail-safe ban)', async () => {
      const sdb = openDb(':memory:'); const setup = claimAll();
      const p = setupPolicy(sdb, setup);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        await p.validateUserInfo(input('owner.new@example.com'), withCookie('ica-hub.setup=ok'));
        vi.setSystemTime(Date.now() + 10 * 60_000);
        seedUser(sdb, 'oidc', { email: 'owner.new@example.com' });
        await p.afterUserCreate({ id: 'oidc', email: 'owner.new@example.com' }, { path: '/callback/upstream' });
      } finally { vi.useRealTimers(); }
      expect(sdb.select({ role: schema.user.role, banned: schema.user.banned }).from(schema.user).get()).toEqual({ role: 'admin', banned: false });
      expect(setup.close).toHaveBeenCalled();
    });
    it('the invite TTL is unchanged: an invite callback past it is disabled', async () => {
      const sdb = openDb(':memory:');
      seedUser(sdb, 'adm', { email: 'adm@example.com', role: 'admin' });
      createInvite(sdb, { email: 'new@example.com', role: 'member', createdByUserId: 'adm' });
      const p = setupPolicy(sdb, claimAll(0));
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        expect(await p.validateUserInfo(input('new@example.com'), withCookie())).toBeUndefined();
        vi.setSystemTime(Date.now() + 121_000);
        seedUser(sdb, 'late', { email: 'new@example.com' });
        await p.afterUserCreate({ id: 'late', email: 'new@example.com' }, { path: '/callback/upstream' });
      } finally { vi.useRealTimers(); }
      expect(sdb.select({ banned: schema.user.banned }).from(schema.user).where(eq(schema.user.id, 'late')).get()).toEqual({ banned: true });
    });
    it('happy path: admin, profile, setup closed, audited', async () => {
      const sdb = openDb(':memory:'); const setup = claimAll();
      const p = setupPolicy(sdb, setup);
      await p.validateUserInfo(input('owner.new@example.com'), withCookie('ica-hub.setup=ok'));
      seedUser(sdb, 'oidc', { email: 'owner.new@example.com' });
      await p.afterUserCreate({ id: 'oidc', email: 'owner.new@example.com' }, { path: '/callback/upstream' });
      expect(sdb.select().from(schema.user).get()!.role).toBe('admin');
      expect(sdb.select().from(schema.userProfile).all()).toHaveLength(1);
      expect(setup.close).toHaveBeenCalled();
      expect(JSON.parse(sdb.select().from(schema.auditEvent).get()!.detailsJson)).toEqual({ setting: 'setup', changes: ['first_admin', 'oidc'] });
    });
  });
});

describe('OIDC group mapping (member group, provisioning, two-way role sync)', () => {
  let db: Db; const warn = vi.fn();
  const mapped = { ...oidcEnv, OIDC_ADMIN_GROUP: 'ica-hub-admins', OIDC_MEMBER_GROUP: 'ica-hub-users' };
  const cfg = (env: Record<string, string> = mapped) => loadConfig({ ...baseEnv, ...env });
  const make = (c: Config = cfg(), setup?: SetupGate) => createOidcPolicy({ db, config: c, audit: createAudit(db, { warn }), rejections: createOidcRejections(), log: { warn }, ...(setup ? { setup } : {}) });
  const cb = { path: '/callback/:id' };
  const user = (id: string) => db.select().from(schema.user).where(eq(schema.user.id, id)).get();
  const audits = (action: string) => db.select().from(schema.auditEvent).all().filter((e) => e.action === action).map((e) => ({ actor: e.actorUserId, target: e.targetId, ...JSON.parse(e.detailsJson) }));
  const create = (p: ReturnType<typeof make>, email: string, profile: Record<string, unknown>, c: EndpointCtx = ctx) =>
    p.validateUserInfo({ user: { email, emailVerified: true }, source: oauth('create-user', { email, ...profile }) }, c);
  const signIn = async (p: ReturnType<typeof make>, id: string, email: string, profile: Record<string, unknown>, action: 'sign-in' | 'link-account' = 'sign-in') => {
    const r = await p.validateUserInfo({ user: { id, email, emailVerified: true }, source: oauth(action, profile) }, ctx);
    if (r === undefined) await p.afterSessionCreate({ userId: id }, cb);
    return r;
  };
  /** What Better Auth does after an allowed create-user: insert the user, then run the hooks. */
  const created = async (p: ReturnType<typeof make>, id: string, email: string) => {
    seedUser(db, id, { email });
    await p.afterUserCreate({ id, email }, cb);
    await p.afterSessionCreate({ userId: id }, cb);
  };
  beforeEach(() => {
    db = openDb(':memory:'); warn.mockReset();
    seedUser(db, 'admin-1', { role: 'admin', email: 'admin@example.com' });
    seedUser(db, 'member-1', { role: 'member', email: 'member@example.com' });
  });
  afterEach(() => { closeDb(db); });

  describe('rule (d): provision by group', () => {
    it('an admin-group sign-in without an account creates an admin, audited as user.provisioned then auth.login', async () => {
      const p = make();
      expect(await create(p, 'new@example.com', { groups: ['household', 'ica-hub-admins'] })).toBeUndefined();
      await created(p, 'new-1', 'new@example.com');
      expect(user('new-1')).toMatchObject({ role: 'admin', banned: false });
      expect(db.select().from(schema.userProfile).where(eq(schema.userProfile.userId, 'new-1')).get()).toBeDefined();
      const rows = db.select().from(schema.auditEvent).all().filter((e) => e.targetId === 'new-1').map((e) => [e.action, JSON.parse(e.detailsJson)]);
      expect(rows).toEqual([['user.provisioned', { role: 'admin' }], ['auth.login', { method: 'oidc' }]]);
      expect(audits('user.provisioned')).toEqual([{ actor: null, target: 'new-1', role: 'admin' }]);
    });
    it('a member-group sign-in creates a member; both groups → admin', async () => {
      const p = make();
      expect(await create(p, 'kid@example.com', { groups: ['ica-hub-users'] })).toBeUndefined();
      await created(p, 'kid-1', 'kid@example.com');
      expect(user('kid-1')?.role).toBe('member');
      expect(await create(p, 'both@example.com', { groups: ['ica-hub-users', 'ica-hub-admins'] })).toBeUndefined();
      await created(p, 'both-1', 'both@example.com');
      expect(user('both-1')?.role).toBe('admin');
      expect(audits('user.provisioned').map((a) => a.role)).toEqual(['member', 'admin']);
    });
    it('outside the groups: not_in_group, nothing pending (a later user with that email is not given a role)', async () => {
      const p = make();
      expect(await create(p, 'out@example.com', { groups: ['household'] })).toEqual({ error: 'not_in_group' });
      expect(await create(p, 'odd@example.com', { groups: ['ica-hub-admins', 7] })).toEqual({ error: 'not_in_group' }); // not all strings: no groups
      expect(failures(db).map((f) => f.reason)).toEqual(['not_in_group', 'not_in_group']);
      seedUser(db, 'out-1', { email: 'out@example.com' });
      await p.afterUserCreate({ id: 'out-1', email: 'out@example.com' }, cb);
      expect(user('out-1')).toMatchObject({ banned: true }); // the fail-safe for a creation nobody allowed
    });
    it('only the admin group configured: a non-member without an invite still gets not_invited (unchanged)', async () => {
      const p = make(cfg({ ...oidcEnv, OIDC_ADMIN_GROUP: 'ica-hub-admins' }));
      expect(await create(p, 'out@example.com', { groups: ['household'] })).toMatchObject({ error: 'not_invited' });
      expect(await create(p, 'boss@example.com', { groups: ['ica-hub-admins'] })).toBeUndefined();
    });
    it('no group configured: the groups claim is ignored (no provisioning)', async () => {
      const p = make(cfg({ ...oidcEnv, OIDC_ADMIN_GROUP: '' }));
      expect(await create(p, 'boss@example.com', { groups: ['ica-hub-admins'] })).toMatchObject({ error: 'not_invited' });
      expect(warn).not.toHaveBeenCalled();
    });
    it('an email that already belongs to a user is never created twice: account_not_linked', async () => {
      const p = make();
      expect(await create(p, 'member@example.com', { groups: ['ica-hub-admins'] })).toEqual({ error: 'account_not_linked' });
      expect(await create(p, 'MEMBER@example.com', { groups: ['ica-hub-users'] })).toEqual({ error: 'account_not_linked' });
      expect(db.select().from(schema.user).all()).toHaveLength(2);
    });
    it('an invite still wins over the group (its role), and the admin group still promotes it', async () => {
      createInvite(db, { email: 'inv@example.com', role: 'member', createdByUserId: 'admin-1' });
      const p = make();
      expect(await create(p, 'inv@example.com', { groups: ['ica-hub-users'] })).toBeUndefined();
      await created(p, 'inv-1', 'inv@example.com');
      expect(user('inv-1')?.role).toBe('member');
      expect(audits('user.invite_accepted')).toHaveLength(1);
      expect(audits('user.provisioned')).toEqual([]);
    });
    it('with a member group set, an invite is created with the role the groups give, not the invite\'s', async () => {
      createInvite(db, { email: 'boss@example.com', role: 'admin', createdByUserId: 'admin-1' });
      createInvite(db, { email: 'kid@example.com', role: 'member', createdByUserId: 'admin-1' });
      const p = make();
      expect(await create(p, 'boss@example.com', { groups: ['ica-hub-users'] })).toBeUndefined();
      await created(p, 'boss-1', 'boss@example.com');
      expect(user('boss-1')?.role).toBe('member');
      // …so the second sign-in does not flip it (it is already what the groups say).
      expect(await signIn(p, 'boss-1', 'boss@example.com', { groups: ['ica-hub-users'] })).toBeUndefined();
      expect(user('boss-1')?.role).toBe('member');
      expect(await create(p, 'kid@example.com', { groups: ['ica-hub-admins'] })).toBeUndefined();
      await created(p, 'kid-1', 'kid@example.com');
      expect(user('kid-1')?.role).toBe('admin');
      expect(audits('user.invite_accepted').map((a) => [a.email, a.role])).toEqual([['boss@example.com', 'member'], ['kid@example.com', 'admin']]);
    });
    it('with only the admin group set, an invite keeps its role (promote-only, unchanged)', async () => {
      createInvite(db, { email: 'boss@example.com', role: 'admin', createdByUserId: 'admin-1' });
      const p = make(cfg({ ...oidcEnv, OIDC_ADMIN_GROUP: 'ica-hub-admins' }));
      expect(await create(p, 'boss@example.com', { groups: [] })).toBeUndefined();
      await created(p, 'boss-1', 'boss@example.com');
      expect(user('boss-1')?.role).toBe('admin');
    });
    it('an invitee in neither group is refused too (they could never sign in with it afterwards)', async () => {
      createInvite(db, { email: 'inv@example.com', role: 'member', createdByUserId: 'admin-1' });
      expect(await create(make(), 'inv@example.com', { groups: [] })).toEqual({ error: 'not_in_group' });
    });
    it('a group creation past the pending TTL is disabled (fail safe), never given a role', async () => {
      const p = make();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        await create(p, 'slow@example.com', { groups: ['ica-hub-admins'] });
        vi.setSystemTime(Date.now() + 121_000);
        seedUser(db, 'slow-1', { email: 'slow@example.com' });
        await p.afterUserCreate({ id: 'slow-1', email: 'slow@example.com' }, cb);
      } finally { vi.useRealTimers(); }
      expect(user('slow-1')).toMatchObject({ banned: true });
      expect(user('slow-1')?.role).not.toBe('admin');
    });
  });

  describe('role sync at every sign-in', () => {
    it('admin group → admin; member group only → member (demotion), audited with a null actor', async () => {
      seedUser(db, 'admin-2', { role: 'admin', email: 'admin2@example.com' });
      const p = make();
      expect(await signIn(p, 'member-1', 'member@example.com', { groups: ['ica-hub-admins'] })).toBeUndefined();
      expect(user('member-1')?.role).toBe('admin');
      expect(await signIn(p, 'admin-2', 'admin2@example.com', { groups: ['ica-hub-users'] })).toBeUndefined();
      expect(user('admin-2')?.role).toBe('member');
      expect(audits('user.role_changed')).toEqual([
        { actor: null, target: 'member-1', from: 'member', to: 'admin', via: 'oidc_group' },
        { actor: null, target: 'admin-2', from: 'admin', to: 'member', via: 'oidc_group' },
      ]);
    });
    it('applies to a link-by-email sign-in too', async () => {
      seedUser(db, 'admin-2', { role: 'admin', email: 'admin2@example.com' });
      expect(await signIn(make(), 'admin-2', 'admin2@example.com', { groups: ['ica-hub-users'] }, 'link-account')).toBeUndefined();
      expect(user('admin-2')?.role).toBe('member');
    });
    it('never demotes the last active admin: kept, and a warn line with the user id only', async () => {
      db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, 'member-1')).run();
      seedUser(db, 'old-admin', { role: 'admin', email: 'old@example.com' });
      db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, 'old-admin')).run(); // disabled: does not count
      expect(await signIn(make(), 'admin-1', 'admin@example.com', { groups: ['ica-hub-users'] })).toBeUndefined();
      expect(user('admin-1')?.role).toBe('admin');
      expect(audits('user.role_changed')).toEqual([]);
      expect(warn).toHaveBeenCalledWith({ userId: 'admin-1' }, expect.any(String));
    });
    it('two sign-ins of the last two admins, both only in the member group: one admin is left', async () => {
      seedUser(db, 'admin-2', { role: 'admin', email: 'admin2@example.com' });
      const p = make();
      // Both validations happen before either session (interleaved callbacks).
      await p.validateUserInfo({ user: { id: 'admin-1', email: 'admin@example.com', emailVerified: true }, source: oauth('sign-in', { groups: ['ica-hub-users'] }) }, ctx);
      await p.validateUserInfo({ user: { id: 'admin-2', email: 'admin2@example.com', emailVerified: true }, source: oauth('sign-in', { groups: ['ica-hub-users'] }) }, ctx);
      await Promise.all([p.afterSessionCreate({ userId: 'admin-1' }, cb), p.afterSessionCreate({ userId: 'admin-2' }, cb)]);
      expect(activeAdminCount(db)).toBe(1);
    });
    it('in neither group: not_in_group; nothing changes, nobody is disabled', async () => {
      const p = make();
      expect(await signIn(p, 'member-1', 'member@example.com', { groups: ['household'] })).toEqual({ error: 'not_in_group' });
      expect(await signIn(p, 'admin-1', 'admin@example.com', { groups: [] })).toEqual({ error: 'not_in_group' });
      expect(user('member-1')).toMatchObject({ role: 'member', banned: false });
      expect(user('admin-1')).toMatchObject({ role: 'admin', banned: false });
      expect(failures(db).map((f) => [f.reason, f.email])).toEqual([['not_in_group', 'member@example.com'], ['not_in_group', 'admin@example.com']]);
    });
    it('no groups claim at all: groups_missing (its own code) and a warn line with the user id only', async () => {
      const p = make();
      expect(await signIn(p, 'member-1', 'member@example.com', {})).toEqual({ error: 'groups_missing' });
      expect(warn).toHaveBeenCalledWith({ userId: 'member-1' }, expect.any(String));
      expect(JSON.stringify(warn.mock.calls)).not.toContain('member@example.com');
      warn.mockReset();
      expect(await create(p, 'new@example.com', { groups: 'ica-hub-admins' })).toEqual({ error: 'groups_missing' }); // not an array
      expect(warn).toHaveBeenCalledWith({}, expect.any(String));
      // Only the admin group set: no refusal of its own (promote-only), but the warning still says why nothing maps.
      warn.mockReset();
      const adminOnly = make(cfg({ ...oidcEnv, OIDC_ADMIN_GROUP: 'ica-hub-admins' }));
      expect(await signIn(adminOnly, 'member-1', 'member@example.com', {})).toBeUndefined();
      expect(warn).toHaveBeenCalledWith({ userId: 'member-1' }, expect.any(String));
      expect(failures(db).map((f) => f.reason)).toEqual(['groups_missing', 'groups_missing']);
    });
    it('only the admin group configured: promote-only, non-members keep their role and are let in', async () => {
      const p = make(cfg({ ...oidcEnv, OIDC_ADMIN_GROUP: 'ica-hub-admins' }));
      expect(await signIn(p, 'admin-1', 'admin@example.com', { groups: ['ica-hub-users'] })).toBeUndefined();
      expect(await signIn(p, 'member-1', 'member@example.com', { groups: [] })).toBeUndefined();
      expect(user('admin-1')?.role).toBe('admin');
      expect(user('member-1')?.role).toBe('member');
      expect(await signIn(p, 'member-1', 'member@example.com', { groups: ['ica-hub-admins'] })).toBeUndefined();
      expect(user('member-1')?.role).toBe('admin');
    });
    it('only the member group configured: it gates sign-in, but never demotes (no admin group to be in)', async () => {
      seedUser(db, 'admin-2', { role: 'admin', email: 'admin2@example.com' });
      const p = make(cfg({ ...oidcEnv, OIDC_ADMIN_GROUP: '', OIDC_MEMBER_GROUP: 'ica-hub-users' }));
      expect(await signIn(p, 'admin-2', 'admin2@example.com', { groups: ['ica-hub-users'] })).toBeUndefined();
      expect(user('admin-2')?.role).toBe('admin');
      expect(await signIn(p, 'member-1', 'member@example.com', { groups: ['household'] })).toEqual({ error: 'not_in_group' });
    });
    it('a failed flow\'s verdict never carries over to a later sign-in', async () => {
      seedUser(db, 'admin-2', { role: 'admin', email: 'admin2@example.com' });
      const p = make();
      await p.validateUserInfo({ user: { id: 'admin-2', email: 'admin2@example.com', emailVerified: true }, source: oauth('sign-in', { groups: ['ica-hub-users'] }) }, ctx);
      await signIn(p, 'admin-2', 'admin2@example.com', { groups: ['ica-hub-admins'] });
      expect(user('admin-2')?.role).toBe('admin');
    });
  });

  describe('remembered groups (memory only, for the Settings check)', () => {
    it('keeps an admin\'s groups from the latest sign-in; forgets a member\'s and an absent claim', async () => {
      const seen = createSeenGroups();
      const p = createOidcPolicy({ db, config: cfg(), audit: createAudit(db, { warn }), rejections: createOidcRejections(), log: { warn }, seenGroups: seen });
      await signIn(p, 'admin-1', 'admin@example.com', { groups: ['household', 'ica-hub-admins', 'ica-hub-users'] });
      expect(seen.get('admin-1')).toEqual(['household', 'ica-hub-admins', 'ica-hub-users']);
      await signIn(p, 'member-1', 'member@example.com', { groups: ['ica-hub-users'] });
      expect(seen.get('member-1')).toBeUndefined();
      const adminOnly = createOidcPolicy({ db, config: cfg({ ...oidcEnv, OIDC_ADMIN_GROUP: 'ica-hub-admins' }), audit: createAudit(db, { warn }), rejections: createOidcRejections(), log: { warn }, seenGroups: seen });
      await signIn(adminOnly, 'admin-1', 'admin@example.com', {});
      expect(seen.get('admin-1')).toBeUndefined();
      expect(db.select().from(schema.auditEvent).all().map((e) => e.detailsJson).join()).not.toContain('household');
    });
    it('a newly provisioned admin\'s groups are remembered too', async () => {
      const seen = createSeenGroups();
      const p = createOidcPolicy({ db, config: cfg(), audit: createAudit(db, { warn }), rejections: createOidcRejections(), log: { warn }, seenGroups: seen });
      await create(p, 'new@example.com', { groups: ['ica-hub-admins'] });
      await created(p, 'new-1', 'new@example.com');
      expect(seen.get('new-1')).toEqual(['ica-hub-admins']);
    });
  });

  describe('first run with groups (env OIDC, empty user table)', () => {
    const gate = () => { const close = vi.fn<() => void>(); return { claimFirstAdmin: () => false, close }; };
    beforeEach(() => { db.delete(schema.user).run(); });

    it('the first admin-group sign-in creates the admin and closes setup', async () => {
      const g = gate(); const p = make(cfg(), g);
      expect(await create(p, 'owner.new@example.com', { groups: ['ica-hub-admins'] })).toBeUndefined();
      await created(p, 'first', 'owner.new@example.com');
      expect(user('first')).toMatchObject({ role: 'admin', banned: false });
      expect(g.close).toHaveBeenCalled();
      expect(audits('settings.changed')).toEqual([{ actor: 'first', target: 'first', setting: 'setup', changes: ['first_admin', 'oidc_group'] }]);
      expect(audits('user.provisioned')).toEqual([{ actor: null, target: 'first', role: 'admin' }]);
    });
    it('a member-group sign-in on an empty table creates nobody: setup_incomplete', async () => {
      const g = gate(); const p = make(cfg(), g);
      expect(await create(p, 'kid@example.com', { groups: ['ica-hub-users'] })).toEqual({ error: 'setup_incomplete' });
      seedUser(db, 'kid', { email: 'kid@example.com' });
      await p.afterUserCreate({ id: 'kid', email: 'kid@example.com' }, cb);
      expect(user('kid')).toMatchObject({ banned: true }); // nothing was pending for it
      expect(g.close).not.toHaveBeenCalled();
    });
    it('two concurrent first admin-group sign-ins: exactly one admin; the other stays a member until its next sign-in', async () => {
      const g = gate(); const p = make(cfg(), g);
      await create(p, 'a@example.com', { groups: ['ica-hub-admins'] });
      await create(p, 'b@example.com', { groups: ['ica-hub-admins'] });
      seedUser(db, 'a', { email: 'a@example.com' }); seedUser(db, 'b', { email: 'b@example.com' });
      await p.afterUserCreate({ id: 'b', email: 'b@example.com' }, cb);
      await p.afterUserCreate({ id: 'a', email: 'a@example.com' }, cb);
      expect(activeAdminCount(db)).toBe(1);
      expect(user('b')?.role).toBe('admin');
      expect(user('a')).toMatchObject({ banned: false });
      expect(g.close).toHaveBeenCalledTimes(1);
    });
    it('without env OIDC (a UI-managed connection) the group path does not open setup: not_invited', async () => {
      const ui = { ...cfg(), envManaged: { ...cfg().envManaged, oidc: false } };
      expect(await create(make(ui, gate()), 'owner.new@example.com', { groups: ['ica-hub-admins'] })).toMatchObject({ error: 'not_invited' });
    });
  });
});

function failures(db: Db) {
  return db.select().from(schema.auditEvent).all().filter((e) => e.action === 'auth.login_failed').map((e) => JSON.parse(e.detailsJson) as { reason: string; email: string });
}
