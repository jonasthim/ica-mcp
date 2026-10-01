import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDb, schema } from '../db/index.js';
import { seedUser } from '../test-helpers.js';
import { adminAccess, guardOidcRemove, guardOidcSave, guardOidcSetupSave, guardSignIn, type AdminAccess } from './guards.js';

const a = (o: Partial<AdminAccess> = {}): AdminAccess => ({ activeAdmins: 1, adminsWithOidc: 1, adminsWithPassword: 1, oidcLinks: 1, ...o });
const eqId = (id: string) => eq(schema.user.id, id);

describe('lockout guard', () => {
  it('setup: nobody can be locked out while no user exists; once one exists, setup saves nothing', () => {
    expect(guardOidcSetupSave(0)).toBeNull();
    expect(guardOidcSetupSave(1)).toBe('setup_closed');
  });
  it('password on is always allowed', () => expect(guardSignIn(a({ adminsWithOidc: 0 }), { localLogin: true, oidcUsable: false, linkByEmail: false })).toBeNull());
  it('no_sign_in_method: password off without usable OIDC', () => expect(guardSignIn(a(), { localLogin: false, oidcUsable: false, linkByEmail: true })).toBe('no_sign_in_method'));
  it('no_oidc_admin: password off while no admin is linked', () => expect(guardSignIn(a({ adminsWithOidc: 0 }), { localLogin: false, oidcUsable: true, linkByEmail: true })).toBe('no_oidc_admin'));
  it('link_by_email_needed: password and linking off while an admin is unlinked', () => {
    expect(guardSignIn(a({ activeAdmins: 2 }), { localLogin: false, oidcUsable: true, linkByEmail: false })).toBe('link_by_email_needed');
    expect(guardSignIn(a({ activeAdmins: 2 }), { localLogin: false, oidcUsable: true, linkByEmail: true })).toBeNull();
    expect(guardSignIn(a({ activeAdmins: 2, adminsWithOidc: 2 }), { localLogin: false, oidcUsable: true, linkByEmail: false })).toBeNull();
  });
  it('no_password_admin / no_sign_in_method on removing OIDC', () => {
    expect(guardOidcRemove(a({ adminsWithPassword: 0 }), true)).toBe('no_password_admin');
    expect(guardOidcRemove(a(), false)).toBe('no_sign_in_method');
    expect(guardOidcRemove(a(), true)).toBeNull();
  });
  const save = (o: Partial<Parameters<typeof guardOidcSave>[1]> = {}) =>
    ({ localLogin: true, linkByEmail: true, issuerChanged: false, credentialsChanged: false, unlinkAck: false, ...o });
  it('issuer_change_ack: a new issuer with links needs the acknowledgement', () => {
    expect(guardOidcSave(a(), save({ issuerChanged: true, credentialsChanged: true }))).toBe('issuer_change_ack');
    expect(guardOidcSave(a(), save({ issuerChanged: true, credentialsChanged: true, unlinkAck: true }))).toBeNull();
    expect(guardOidcSave(a({ oidcLinks: 0 }), save({ issuerChanged: true, credentialsChanged: true }))).toBeNull();
  });
  it('password_login_required: no change to issuer, client id or secret while password sign-in is off', () => {
    expect(guardOidcSave(a(), save({ localLogin: false, issuerChanged: true, credentialsChanged: true, unlinkAck: true }))).toBe('password_login_required');
    expect(guardOidcSave(a(), save({ localLogin: false, credentialsChanged: true }))).toBe('password_login_required');
    expect(guardOidcSave(a(), save({ localLogin: false }))).toBeNull(); // label or switches only
  });
  it('unlink_locks_out: unlinking is refused when no admin has a password and linking by email is off', () => {
    const probe = save({ linkByEmail: false, issuerChanged: true, credentialsChanged: true, unlinkAck: true });
    expect(guardOidcSave(a({ adminsWithPassword: 0 }), probe)).toBe('unlink_locks_out');
    expect(guardOidcSave(a({ adminsWithPassword: 0 }), { ...probe, linkByEmail: true })).toBeNull();
    expect(guardOidcSave(a(), probe)).toBeNull();
    expect(guardOidcSave(a({ adminsWithPassword: 0, oidcLinks: 0 }), probe)).toBeNull(); // nothing to unlink
  });
  it('turning linking off on Save while password is off goes through the sign-in rule', () =>
    expect(guardOidcSave(a({ activeAdmins: 2 }), save({ localLogin: false, linkByEmail: false }))).toBe('link_by_email_needed'));
  it('adminAccess counts only active admins', () => {
    const db = openDb(':memory:');
    seedUser(db, 'a1', { role: 'admin' }); seedUser(db, 'a2', { role: 'admin' }); seedUser(db, 'm1');
    db.update(schema.user).set({ banned: true }).where(eqId('a2')).run();
    const acc = (userId: string, providerId: string) => db.insert(schema.account).values({ id: `${userId}-${providerId}`, accountId: userId, providerId, userId, createdAt: new Date(), updatedAt: new Date() }).run();
    acc('a1', 'credential'); acc('a2', 'upstream'); acc('m1', 'upstream');
    expect(adminAccess(db)).toEqual({ activeAdmins: 1, adminsWithOidc: 0, adminsWithPassword: 1, oidcLinks: 2 });
  });
});
