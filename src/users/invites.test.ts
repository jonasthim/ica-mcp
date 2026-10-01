import { describe, expect, it } from 'vitest';
import { closeDb, openDb, schema } from '../db/index.js';
import { seedUser } from '../test-helpers.js';
import {
  claimInvite, createInvite, createInviteShares, findInviteByToken, hashInviteToken, InviteError, listPendingInvites, pendingInviteForEmail, releaseInvite,
  renewInvite, revokeInvite, setInviteUser,
} from './invites.js';

const NOW = new Date('2026-10-01T10:00:00Z');
describe('invites', () => {
  it('stores only the token hash and finds the invite by token', () => {
    const db = openDb(':memory:'); seedUser(db, 'admin', { role: 'admin' });
    const { invite, token } = createInvite(db, { email: ' Partner@Example.COM ', role: 'member', createdByUserId: 'admin', now: NOW });
    expect(invite.email).toBe('partner@example.com');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(db.select().from(schema.invite).all())).not.toContain(token);
    expect(invite.tokenHash).toBe(hashInviteToken(token));
    expect(findInviteByToken(db, token, NOW)).toMatchObject({ state: 'pending' });
    expect(findInviteByToken(db, 'x'.repeat(43), NOW)).toBeUndefined();
    expect(findInviteByToken(db, token, new Date(NOW.getTime() + 7 * 86_400_000 + 1))).toMatchObject({ state: 'expired' });
    closeDb(db);
  });

  it('refuses bad emails, existing users and a second pending invite for the same email', () => {
    const db = openDb(':memory:'); seedUser(db, 'admin', { role: 'admin', email: 'owner@example.com' });
    const bad = (email: string) => { try { createInvite(db, { email, role: 'member', createdByUserId: 'admin', now: NOW }); return 'ok'; } catch (e) { return (e as InviteError).code; } };
    expect(bad('not-an-email')).toBe('invalid_email');
    expect(bad('OWNER@example.com')).toBe('already_user');
    expect(bad('p@example.com')).toBe('ok');
    expect(bad('P@example.com')).toBe('already_invited');
    closeDb(db);
  });

  it('claims atomically once; revoked and renewed tokens are dead', () => {
    const db = openDb(':memory:'); seedUser(db, 'admin', { role: 'admin' });
    const a = createInvite(db, { email: 'a@example.com', role: 'member', createdByUserId: 'admin', now: NOW });
    expect(claimInvite(db, a.invite.id, null, NOW)).toBe(true);
    expect(claimInvite(db, a.invite.id, null, NOW)).toBe(false);
    const b = createInvite(db, { email: 'b@example.com', role: 'admin', createdByUserId: 'admin', now: NOW });
    const renewed = renewInvite(db, b.invite.id, NOW)!;
    expect(findInviteByToken(db, b.token, NOW)).toBeUndefined();
    expect(findInviteByToken(db, renewed.token, NOW)).toMatchObject({ state: 'pending' });
    revokeInvite(db, b.invite.id, NOW);
    expect(findInviteByToken(db, renewed.token, NOW)).toMatchObject({ state: 'revoked' });
    expect(pendingInviteForEmail(db, 'B@EXAMPLE.com', NOW)).toBeUndefined();
    closeDb(db);
  });

  it('keeps a share link for 15 minutes only', () => {
    let t = 0; const shares = createInviteShares({ now: () => t });
    shares.put('i', 'tok'); t = 14 * 60_000; expect(shares.get('i')).toBe('tok');
    t = 16 * 60_000; expect(shares.get('i')).toBeUndefined();
  });

  it('releases a claim whose account failed, but never one bound to a user', () => {
    const db = openDb(':memory:'); seedUser(db, 'admin', { role: 'admin' }); seedUser(db, 'new');
    const { invite, token } = createInvite(db, { email: 'r@example.com', role: 'member', createdByUserId: 'admin', now: NOW });
    expect(claimInvite(db, invite.id, null, NOW)).toBe(true);
    expect(listPendingInvites(db, NOW)).toEqual([]);
    releaseInvite(db, invite.id);
    expect(findInviteByToken(db, token, NOW)).toMatchObject({ state: 'pending' });
    expect(claimInvite(db, invite.id, null, NOW)).toBe(true);
    setInviteUser(db, invite.id, 'new');
    releaseInvite(db, invite.id);
    expect(findInviteByToken(db, token, NOW)).toMatchObject({ state: 'accepted', invite: { acceptedUserId: 'new' } });
    closeDb(db);
  });

  it('an expired invite cannot be claimed or revoked but can be renewed; an invalid role is refused', () => {
    const db = openDb(':memory:'); seedUser(db, 'admin', { role: 'admin' });
    const { invite } = createInvite(db, { email: 'x@example.com', role: 'member', createdByUserId: 'admin', now: NOW });
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    expect(claimInvite(db, invite.id, null, later)).toBe(false);
    expect(revokeInvite(db, invite.id, later)).toBeUndefined();
    expect(pendingInviteForEmail(db, 'x@example.com', later)).toBeUndefined();
    const renewed = renewInvite(db, invite.id, later)!;
    expect(findInviteByToken(db, renewed.token, later)).toMatchObject({ state: 'pending' });
    expect(listPendingInvites(db, later).map((i) => i.id)).toEqual([invite.id]);
    expect(() => createInvite(db, { email: 'y@example.com', role: 'owner' as never, createdByUserId: 'admin', now: NOW })).toThrow(InviteError);
    closeDb(db);
  });

  it('renewing never makes a second live invite for an email, nor one for an existing user', () => {
    const db = openDb(':memory:'); seedUser(db, 'admin', { role: 'admin' });
    const old = createInvite(db, { email: 'd@example.com', role: 'member', createdByUserId: 'admin', now: NOW });
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    createInvite(db, { email: 'd@example.com', role: 'member', createdByUserId: 'admin', now: later });
    const code = (f: () => unknown) => { try { f(); return 'ok'; } catch (e) { return (e as InviteError).code; } };
    expect(code(() => renewInvite(db, old.invite.id, later))).toBe('already_invited');
    const u = createInvite(db, { email: 'e@example.com', role: 'member', createdByUserId: 'admin', now: NOW });
    seedUser(db, 'e', { email: 'E@example.com' });
    expect(code(() => renewInvite(db, u.invite.id, NOW))).toBe('already_user');
    expect(findInviteByToken(db, u.token, NOW)).toMatchObject({ state: 'pending' }); // unchanged: the old link still works
    closeDb(db);
  });

  it('forgets a share link on delete', () => {
    const shares = createInviteShares();
    shares.put('i', 'tok'); shares.delete('i');
    expect(shares.get('i')).toBeUndefined();
  });
});
