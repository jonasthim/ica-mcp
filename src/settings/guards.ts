import { and, count, eq, inArray, isNull, or } from 'drizzle-orm';
import { OIDC_PROVIDER_ID } from '../auth/constants.js';
import { schema, type Db } from '../db/index.js';

/** Why a sign-in settings change was refused (the lockout guard and friends); each has a fixed flash text. */
export type GuardReason = 'env_managed' | 'oidc_checks_failed' | 'oidc_unloadable' | 'not_saved' | 'no_oidc_admin' | 'no_sign_in_method'
  | 'no_password_admin' | 'link_by_email_needed' | 'password_login_required' | 'unlink_locks_out' | 'issuer_change_ack' | 'setup_closed'
  | 'admin_group_not_yours';
export type AdminAccess = { activeAdmins: number; adminsWithOidc: number; adminsWithPassword: number; oidcLinks: number };

/** How the active admins (role admin, not disabled) can sign in, and how many OIDC links exist at all. */
export function adminAccess(db: Db): AdminAccess {
  const u = schema.user; const a = schema.account;
  const admins = db.select({ id: u.id }).from(u).where(and(eq(u.role, 'admin'), or(isNull(u.banned), eq(u.banned, false)))).all().map((x) => x.id);
  const rows = admins.length ? db.select({ userId: a.userId, p: a.providerId }).from(a).where(inArray(a.userId, admins)).all() : [];
  const with_ = (p: string): number => new Set(rows.filter((x) => x.p === p).map((x) => x.userId)).size;
  const oidcLinks = db.select({ n: count() }).from(a).where(eq(a.providerId, OIDC_PROVIDER_ID)).get()?.n ?? 0;
  return { activeAdmins: admins.length, adminsWithOidc: with_(OIDC_PROVIDER_ID), adminsWithPassword: with_('credential'), oidcLinks };
}

/** Password login may go off only if OIDC works, some admin is linked, and every admin can still get linked. */
export function guardSignIn(a: AdminAccess, next: { localLogin: boolean; oidcUsable: boolean; linkByEmail: boolean }): GuardReason | null {
  if (next.localLogin) return null;
  if (!next.oidcUsable) return 'no_sign_in_method';
  if (a.adminsWithOidc === 0) return 'no_oidc_admin';
  if (!next.linkByEmail && a.adminsWithOidc < a.activeAdmins) return 'link_by_email_needed';
  return null;
}

/**
 * Saving single sign-on. While password sign-in is off, the connection itself (issuer, client id, secret) must not
 * change: the credentials cannot be verified before use, so wrong values would lock everyone out. A changed issuer
 * orphans every existing link (subjects belong to the old IdP): it needs the acknowledgement, and afterwards some admin
 * must still get in — with a password, or by being linked again by email. `linkByEmail` is the value after the save.
 */
export function guardOidcSave(
  a: AdminAccess, o: { localLogin: boolean; linkByEmail: boolean; issuerChanged: boolean; credentialsChanged: boolean; unlinkAck: boolean },
): GuardReason | null {
  if (!o.localLogin && (o.credentialsChanged || o.issuerChanged)) return 'password_login_required';
  if (o.issuerChanged && a.oidcLinks > 0) {
    if (a.adminsWithPassword === 0 && !o.linkByEmail) return 'unlink_locks_out';
    if (!o.unlinkAck) return 'issuer_change_ack';
  }
  return o.localLogin ? null : guardSignIn(a, { localLogin: false, oidcUsable: true, linkByEmail: o.linkByEmail });
}

/**
 * The admin group being saved must be one the saving admin is in, whenever that is known: their latest OIDC sign-in's
 * remembered groups (`seen`, see auth/seen-groups.ts). A known set without the name means "not yours": a typo, or a
 * name the IdP's groups mapping filters out, would otherwise demote every admin but the last at their next sign-in. Only unknown (`undefined`: a password-only session, or after a restart) saves, with the page's
 * "could not be checked" warning.
 */
export function guardAdminGroup(adminGroup: string | undefined, seen: readonly string[] | undefined): GuardReason | null {
  if (!adminGroup || !seen) return null;
  return seen.includes(adminGroup) ? null : 'admin_group_not_yours';
}

/** Removing OIDC leaves only passwords: password login must be on and some admin must have one. */
export function guardOidcRemove(a: AdminAccess, localLogin: boolean): GuardReason | null {
  if (!localLogin) return 'no_sign_in_method';
  if (a.adminsWithPassword === 0) return 'no_password_admin';
  return null;
}

/**
 * Saving single sign-on from first-run setup. The other guards keep existing admins able to sign in; while no user
 * exists there is nobody to lock out (a wrong value is fixed by saving again, with the setup code), so the only rule is
 * that setup is still open: once any user exists, setup saves nothing.
 */
export function guardOidcSetupSave(users: number): GuardReason | null {
  return users > 0 ? 'setup_closed' : null;
}
