import { and, count, eq, isNull, or } from 'drizzle-orm';
import { schema, type Db } from '../db/index.js';
import { roleOf, type Role } from '../auth/roles.js';

/** A Drizzle transaction on {@link Db}. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Users who can act as admin right now: `role = 'admin'` and not disabled (`banned` false or unset). */
export function activeAdminCount(db: Db | Tx): number {
  const u = schema.user;
  return db.select({ n: count() }).from(u).where(and(eq(u.role, 'admin'), or(isNull(u.banned), eq(u.banned, false)))).get()?.n ?? 0;
}

/**
 * Whether taking the admin role away from `targetUserId` (by demotion, disabling or removal) would leave the hub with
 * no active admin: true only when the target is itself an active admin and the last one.
 */
export function leavesNoAdmin(db: Db | Tx, targetUserId: string): boolean {
  const u = schema.user;
  const t = db.select({ role: u.role, banned: u.banned }).from(u).where(eq(u.id, targetUserId)).get();
  if (!t || t.role !== 'admin' || t.banned) return false;
  return activeAdminCount(db) <= 1;
}

export type GroupRoleOutcome = { changed: true; from: Role; to: Role } | { changed: false; keptLastAdmin?: true };

/**
 * The OIDC group mapping's role for `userId` (see auth/oidc-policy.ts): set it, except never demote the last active
 * admin (`keptLastAdmin`). The last-admin count and the update are one `BEGIN IMMEDIATE` transaction, so two sign-ins
 * at once (in this process or another) can never demote the last two admins together: the second one waits for the
 * first one's commit and then counts again.
 */
export function syncGroupRole(db: Db, userId: string, to: Role): GroupRoleOutcome {
  return db.transaction((tx): GroupRoleOutcome => {
    const u = tx.select({ role: schema.user.role, banned: schema.user.banned }).from(schema.user).where(eq(schema.user.id, userId)).get();
    if (!u) return { changed: false };
    const from = roleOf(u);
    if (from === to) return { changed: false };
    if (to !== 'admin' && leavesNoAdmin(tx, userId)) return { changed: false, keptLastAdmin: true };
    tx.update(schema.user).set({ role: to }).where(eq(schema.user.id, userId)).run();
    return { changed: true, from, to };
  }, { behavior: 'immediate' });
}
