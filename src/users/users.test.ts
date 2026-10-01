import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { closeDb, openDb, schema, type Db } from '../db/index.js';
import { seedUser } from '../test-helpers.js';
import { activeAdminCount, leavesNoAdmin } from './admins.js';
import { grantActiveQuery, isGrantActive, listConnectedApps, revokeOAuthGrants } from './grants.js';
import { disconnectIcaAccount, icaAccountSharedFor } from '../sessions/web-store.js';

describe('last-admin guard', () => {
  it('counts only active admins and protects the last one', () => {
    const db = openDb(':memory:');
    seedUser(db, 'a', { role: 'admin' }); seedUser(db, 'b', { role: 'admin' }); seedUser(db, 'm', { role: 'member' });
    expect(activeAdminCount(db)).toBe(2);
    expect(leavesNoAdmin(db, 'a')).toBe(false);
    db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, 'b')).run();
    expect(activeAdminCount(db)).toBe(1);
    expect(leavesNoAdmin(db, 'a')).toBe(true);
    expect(leavesNoAdmin(db, 'b')).toBe(false); // already disabled
    expect(leavesNoAdmin(db, 'm')).toBe(false);
    expect(leavesNoAdmin(db, 'nobody')).toBe(false);
    closeDb(db);
  });

  it('treats a null banned flag as active', () => {
    const db = openDb(':memory:');
    seedUser(db, 'a', { role: 'admin' });
    db.update(schema.user).set({ banned: null }).where(eq(schema.user.id, 'a')).run();
    expect(activeAdminCount(db)).toBe(1);
    expect(leavesNoAdmin(db, 'a')).toBe(true);
    closeDb(db);
  });
});

describe('revokeOAuthGrants', () => {
  it('deletes consents and revokes refresh and access tokens, per client or all', () => {
    const db = openDb(':memory:'); const now = new Date(); const later = new Date(now.getTime() + 3_600_000);
    seedUser(db, 'u');
    for (const c of ['claude', 'other']) {
      db.insert(schema.oauthClient).values({ id: c, clientId: c, name: c, redirectUris: ['http://127.0.0.1/cb'] }).run();
      db.insert(schema.oauthConsent).values({ id: `con-${c}`, clientId: c, userId: 'u', scopes: ['mcp'], createdAt: now, updatedAt: now }).run();
      db.insert(schema.oauthRefreshToken).values({ id: `rt-${c}`, token: `rt-${c}`, clientId: c, userId: 'u', scopes: ['mcp'], expiresAt: later, createdAt: now }).run();
      db.insert(schema.oauthAccessToken).values({ id: `at-${c}`, token: `at-${c}`, clientId: c, userId: 'u', scopes: ['mcp'], expiresAt: later, createdAt: now }).run();
    }
    expect(revokeOAuthGrants(db, 'u', 'claude', now)).toEqual(['claude']);
    expect(db.select().from(schema.oauthConsent).all().map((c) => c.clientId)).toEqual(['other']);
    expect(db.select().from(schema.oauthRefreshToken).all().find((r) => r.clientId === 'claude')!.revoked).toEqual(now);
    expect(db.select().from(schema.oauthRefreshToken).all().find((r) => r.clientId === 'other')!.revoked).toBeNull();
    expect(db.select().from(schema.oauthAccessToken).all().find((r) => r.clientId === 'claude')!.revoked).toEqual(now);
    expect(revokeOAuthGrants(db, 'u', undefined, now).sort()).toEqual(['other']);
    expect(db.select().from(schema.oauthConsent).all()).toEqual([]);
    expect(revokeOAuthGrants(db, 'u', undefined, now)).toEqual([]);
    closeDb(db);
  });
});

describe('listConnectedApps and isGrantActive', () => {
  const setup = () => {
    const db = openDb(':memory:');
    seedUser(db, 'u'); seedUser(db, 'v');
    const t0 = new Date('2026-09-01T10:00:00.000Z'); const t1 = new Date('2026-09-20T08:30:00.000Z'); const t2 = new Date('2026-09-25T12:00:00.000Z');
    const exp = new Date('2027-01-01T00:00:00.000Z');
    db.insert(schema.oauthClient).values({ id: 'c1', clientId: 'claude', name: 'Claude', redirectUris: JSON.stringify(['https://claude.ai/api/mcp/auth_callback']) }).run();
    db.insert(schema.oauthClient).values({ id: 'c2', clientId: 'nameless', name: null, redirectUris: ['my.app:/cb'] }).run();
    db.insert(schema.oauthClient).values({ id: 'c3', clientId: 'unused', name: 'Unused', redirectUris: [] }).run();
    db.insert(schema.oauthConsent).values({ id: 'k1', clientId: 'claude', userId: 'u', scopes: ['openid', 'mcp', 'offline_access'], createdAt: t0, updatedAt: t0 }).run();
    db.insert(schema.oauthConsent).values({ id: 'k2', clientId: 'nameless', userId: 'u', scopes: JSON.stringify(['mcp']) as unknown as string[], createdAt: t1, updatedAt: t1 }).run();
    db.insert(schema.oauthConsent).values({ id: 'k3', clientId: 'claude', userId: 'v', scopes: ['mcp'], createdAt: t0, updatedAt: t0 }).run();
    // u's newest token for claude is a (revoked, rotated) refresh token at t1, and an access token at t2
    db.insert(schema.oauthRefreshToken).values({ id: 'r1', token: 'r1', clientId: 'claude', userId: 'u', scopes: ['mcp'], expiresAt: exp, createdAt: t1, revoked: t2 }).run();
    db.insert(schema.oauthAccessToken).values({ id: 'a1', token: 'a1', clientId: 'claude', userId: 'u', scopes: ['mcp'], expiresAt: exp, createdAt: t2 }).run();
    // v's later token must not count for u
    db.insert(schema.oauthRefreshToken).values({ id: 'r2', token: 'r2', clientId: 'claude', userId: 'v', scopes: ['mcp'], expiresAt: exp, createdAt: exp }).run();
    return { db, t0, t1, t2 };
  };

  it('lists one app per consent of the user, with name, host, scopes, first grant and last token issue', () => {
    const { db, t0, t1, t2 } = setup();
    expect(listConnectedApps(db, 'u')).toEqual([
      { clientId: 'claude', name: 'Claude', scopes: ['openid', 'mcp', 'offline_access'], firstUsedAt: t0.toISOString(), lastUsedAt: t2.toISOString(), redirectHost: 'claude.ai' },
      { clientId: 'nameless', name: 'nameless', scopes: ['mcp'], firstUsedAt: t1.toISOString(), lastUsedAt: null, redirectHost: 'my.app:/cb' },
    ]);
    expect(listConnectedApps(db, 'v').map((a) => a.clientId)).toEqual(['claude']);
    expect(listConnectedApps(db, 'nobody')).toEqual([]);
    closeDb(db);
  });

  it('is active only while the user exists, is not banned, and has a consent for that client', () => {
    const { db } = setup();
    expect(isGrantActive(db, 'u', 'claude')).toBe(true);
    expect(isGrantActive(db, 'u', 'unused')).toBe(false);
    expect(isGrantActive(db, 'nobody', 'claude')).toBe(false);
    revokeOAuthGrants(db, 'u', 'claude');
    expect(isGrantActive(db, 'u', 'claude')).toBe(false);
    expect(isGrantActive(db, 'v', 'claude')).toBe(true);
    db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, 'v')).run();
    expect(isGrantActive(db, 'v', 'claude')).toBe(false);
    // a ban that has run out no longer blocks (Better Auth lifts it at the next sign-in)
    db.update(schema.user).set({ banExpires: new Date(Date.now() - 1000) }).where(eq(schema.user.id, 'v')).run();
    expect(isGrantActive(db, 'v', 'claude')).toBe(true);
    db.update(schema.user).set({ banned: null, banExpires: null }).where(eq(schema.user.id, 'v')).run();
    expect(isGrantActive(db, 'v', 'claude')).toBe(true);
    db.delete(schema.user).where(eq(schema.user.id, 'v')).run();
    expect(isGrantActive(db, 'v', 'claude')).toBe(false);
    closeDb(db);
  });

  it('answers from an index, not a table scan', () => {
    const { db } = setup();
    const q = grantActiveQuery(db, 'u', 'claude', new Date()).toSQL();
    const plan = db.$client.prepare(`explain query plan ${q.sql}`).all(...(q.params as unknown[])) as { detail: string }[];
    expect(plan.map((p) => p.detail).join('\n')).not.toMatch(/SCAN (oauth_consent|user)\b/);
    closeDb(db);
  });
});

const linkAccount = (db: Db, userId: string, acc: string, now: string) => {
  db.insert(schema.userProfile).values({ userId, icaAccountId: acc, createdAt: now }).run();
};

describe('disconnectIcaAccount', () => {
  it('deletes the account and its sessions, unlinks the profile', () => {
    const db = openDb(':memory:'); const now = new Date().toISOString();
    seedUser(db, 'u');
    db.insert(schema.icaAccount).values({ id: 'acc', displayName: 'A', createdAt: now, updatedAt: now }).run();
    linkAccount(db, 'u', 'acc', now);
    db.insert(schema.icaSession).values({ id: 's', icaAccountId: 'acc', kind: 'web', stateEnc: 'v1.x', updatedAt: now }).run();
    expect(disconnectIcaAccount(db, 'u')).toEqual({ mode: 'deleted' });
    expect(db.select().from(schema.icaSession).all()).toEqual([]);
    expect(db.select().from(schema.icaAccount).all()).toEqual([]);
    expect(db.select().from(schema.userProfile).get()?.icaAccountId).toBeNull();
    expect(disconnectIcaAccount(db, 'u')).toBeUndefined();
    closeDb(db);
  });

  it('only unlinks this user when another profile shares the ICA account', () => {
    const db = openDb(':memory:'); const now = new Date().toISOString();
    seedUser(db, 'u'); seedUser(db, 'partner');
    db.insert(schema.icaAccount).values({ id: 'acc', displayName: 'A', createdAt: now, updatedAt: now }).run();
    linkAccount(db, 'u', 'acc', now); linkAccount(db, 'partner', 'acc', now);
    db.insert(schema.icaSession).values({ id: 's', icaAccountId: 'acc', kind: 'web', stateEnc: 'v1.x', updatedAt: now }).run();
    expect(icaAccountSharedFor(db, 'u')).toBe(true);
    expect(disconnectIcaAccount(db, 'u')).toEqual({ mode: 'unlinked' });
    expect(icaAccountSharedFor(db, 'partner')).toBe(false);
    expect(db.select().from(schema.icaSession).all()).toHaveLength(1);
    expect(db.select().from(schema.userProfile).where(eq(schema.userProfile.userId, 'u')).get()?.icaAccountId).toBeNull();
    expect(db.select().from(schema.userProfile).where(eq(schema.userProfile.userId, 'partner')).get()?.icaAccountId).toBe('acc');
    // the last user of the account disconnecting deletes it
    expect(disconnectIcaAccount(db, 'partner')).toEqual({ mode: 'deleted' });
    expect(db.select().from(schema.icaAccount).all()).toEqual([]);
    expect(db.select().from(schema.icaSession).all()).toEqual([]);
    closeDb(db);
  });
});
