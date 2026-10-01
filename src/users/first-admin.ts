import { randomUUID } from 'node:crypto';
import { asc, count, eq } from 'drizzle-orm';
import { schema, type Db } from '../db/index.js';

export const userCount = (db: Db): number => db.select({ n: count() }).from(schema.user).get()?.n ?? 0;

/**
 * The first admin, only on an empty `user` table. `BEGIN IMMEDIATE` takes SQLite's write lock before the count, so
 * neither a second request (better-sqlite3 transactions are synchronous: nothing interleaves) nor a second process
 * can insert between the check and the insert. The password is hashed by the caller, outside the transaction.
 */
export function insertFirstAdmin(db: Db, o: { email: string; name: string; passwordHash: string; now?: Date }): string | null {
  const now = o.now ?? new Date();
  return db.transaction((tx) => {
    if ((tx.select({ n: count() }).from(schema.user).get()?.n ?? 0) > 0) return null;
    const id = randomUUID();
    tx.insert(schema.user).values({ id, name: o.name, email: o.email, emailVerified: false, role: 'admin', createdAt: now, updatedAt: now }).run();
    // Better Auth keys the credential account on the user id (plugins/admin/routes.mjs: accountId: user.id).
    tx.insert(schema.account).values({ id: randomUUID(), accountId: id, providerId: 'credential', userId: id, password: o.passwordHash, createdAt: now, updatedAt: now }).run();
    tx.insert(schema.userProfile).values({ userId: id, createdAt: now.toISOString() }).run();
    return id;
  }, { behavior: 'immediate' });
}

/**
 * OIDC-first setup: the user Better Auth just created becomes admin only while no admin exists, and only if it is the
 * earliest-created user (ties broken by id). Normally that is simply "the only user". It is not "the only user" on
 * purpose: if two setup sign-ins ever both created a user before either hook ran, "only user" would refuse both, and
 * with setup closed (a user exists) nobody could ever become admin. "Earliest" always picks exactly one of them, from
 * that user's own hook, whichever order the hooks run in. One IMMEDIATE transaction, like insertFirstAdmin.
 */
export function promoteFirstAdmin(db: Db, userId: string): boolean {
  return db.transaction((tx) => {
    if (tx.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.role, 'admin')).limit(1).get()) return false;
    const first = tx.select({ id: schema.user.id }).from(schema.user).orderBy(asc(schema.user.createdAt), asc(schema.user.id)).limit(1).get();
    if (first?.id !== userId) return false;
    tx.update(schema.user).set({ role: 'admin' }).where(eq(schema.user.id, userId)).run();
    tx.insert(schema.userProfile).values({ userId, createdAt: new Date().toISOString() }).onConflictDoNothing().run();
    return true;
  }, { behavior: 'immediate' });
}

/**
 * First run with an admin group (env OIDC + OIDC_ADMIN_GROUP, no setup code): the user Better Auth just created from
 * an admin-group sign-in becomes admin only while no admin exists at all. Unlike {@link promoteFirstAdmin} it does not
 * need to be the earliest user — every candidate is vouched for by the identity provider's admin group, and a member
 * cannot be created while the table is empty — so of two concurrent first sign-ins exactly the first hook to run wins,
 * and never neither. One IMMEDIATE transaction.
 */
export function promoteFirstGroupAdmin(db: Db, userId: string): boolean {
  return db.transaction((tx) => {
    if (tx.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.role, 'admin')).limit(1).get()) return false;
    if (!tx.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, userId)).get()) return false;
    tx.update(schema.user).set({ role: 'admin' }).where(eq(schema.user.id, userId)).run();
    tx.insert(schema.userProfile).values({ userId, createdAt: new Date().toISOString() }).onConflictDoNothing().run();
    return true;
  }, { behavior: 'immediate' });
}

export function ensureProfiles(db: Db, now: Date = new Date()): number {
  return db.$client.prepare('insert into user_profile (user_id, created_at) select id, ? from user where id not in (select user_id from user_profile)').run(now.toISOString()).changes;
}
