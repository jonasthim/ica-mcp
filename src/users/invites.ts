import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import * as z from 'zod/v4';
import { isRole, type Role } from '../auth/roles.js';
import { schema, type Db } from '../db/index.js';

/** An invite link works for 7 days (spec "Invites"). */
export const INVITE_TTL_MS = 7 * 86_400_000;
/** How long the plaintext link stays available to the admin (copy / QR) after it was made; then only "Renew link". */
export const INVITE_SHARE_TTL_MS = 15 * 60_000;

export type InviteRow = typeof schema.invite.$inferSelect;
export type InviteState = 'pending' | 'accepted' | 'revoked' | 'expired';
/** A pending invite as the Users page lists it; `shareable` = its link is still held in memory (copy/QR possible). */
export type PendingInviteView = { id: string; email: string; role: Role; expiresAt: string; shareable: boolean };

export class InviteError extends Error {
  constructor(readonly code: 'invalid_email' | 'invalid_role' | 'already_user' | 'already_invited') {
    super(code);
    this.name = 'InviteError';
  }
}

/** 32 random bytes, base64url (43 characters). Only its hash is ever stored. */
export const newInviteToken = (): string => randomBytes(32).toString('base64url');
/** The stored form of a token: SHA-256, hex. A lookup by this unique column is the only comparison (no string compare). */
export const hashInviteToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

const EMAIL = z.email();
const normalEmail = (email: string): string => email.trim().toLowerCase();

export function inviteState(row: InviteRow, now: Date = new Date()): InviteState {
  if (row.revokedAt) return 'revoked';
  if (row.acceptedAt) return 'accepted';
  if (row.expiresAt <= now.toISOString()) return 'expired';
  return 'pending';
}

/** Invites that are neither accepted nor revoked and not expired at `now`. */
export const pendingInvite = (now: Date) => and(isNull(schema.invite.acceptedAt), isNull(schema.invite.revokedAt), gt(schema.invite.expiresAt, now.toISOString()));

/** The pending invite for an email (compared lowercased), if any. Used by the OIDC sign-in (Task 12). */
export function pendingInviteForEmail(db: Db, email: string, now: Date = new Date()): InviteRow | undefined {
  return db.select().from(schema.invite).where(and(eq(schema.invite.email, normalEmail(email)), pendingInvite(now))).get();
}

export function listPendingInvites(db: Db, now: Date = new Date()): InviteRow[] {
  return db.select().from(schema.invite).where(pendingInvite(now)).orderBy(asc(schema.invite.createdAt)).all();
}

/**
 * A new invite for `email` (trimmed, lowercased) with `role`, valid for {@link INVITE_TTL_MS}. Refuses an invalid email
 * or role, an email that already has an account, and a second pending invite for the same email.
 */
export function createInvite(db: Db, o: { email: string; role: Role; createdByUserId: string; now?: Date }): { invite: InviteRow; token: string } {
  const email = normalEmail(o.email);
  const now = o.now ?? new Date();
  if (!EMAIL.safeParse(email).success) throw new InviteError('invalid_email');
  if (!isRole(o.role)) throw new InviteError('invalid_role');
  if (db.select({ id: schema.user.id }).from(schema.user).where(sql`lower(${schema.user.email}) = ${email}`).get()) throw new InviteError('already_user');
  if (pendingInviteForEmail(db, email, now)) throw new InviteError('already_invited');
  const token = newInviteToken();
  const invite = db.insert(schema.invite).values({
    id: randomUUID(), email, role: o.role, tokenHash: hashInviteToken(token), createdByUserId: o.createdByUserId,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
  }).returning().get();
  return { invite, token };
}

export function findInviteByToken(db: Db, token: string, now: Date = new Date()): { invite: InviteRow; state: InviteState } | undefined {
  const invite = db.select().from(schema.invite).where(eq(schema.invite.tokenHash, hashInviteToken(token))).get();
  return invite && { invite, state: inviteState(invite, now) };
}

export const inviteById = (db: Db, id: string): InviteRow | undefined => db.select().from(schema.invite).where(eq(schema.invite.id, id)).get();

/** Revokes a pending invite; undefined when it is not pending (already accepted, revoked or expired, or unknown). */
export function revokeInvite(db: Db, id: string, now: Date = new Date()): InviteRow | undefined {
  return db.update(schema.invite).set({ revokedAt: now.toISOString() }).where(and(eq(schema.invite.id, id), pendingInvite(now))).returning().get();
}

/**
 * A new token and a fresh 7-day expiry for a pending or expired invite; the old link stops working at once.
 * Undefined for an accepted, revoked or unknown invite. Throws {@link InviteError} (and changes nothing) when the email
 * meanwhile has an account or another live invite, so there is never more than one pending invite per email.
 */
export function renewInvite(db: Db, id: string, now: Date = new Date()): { invite: InviteRow; token: string } | undefined {
  const current = inviteById(db, id);
  if (!current || current.acceptedAt || current.revokedAt) return undefined;
  if (db.select({ id: schema.user.id }).from(schema.user).where(sql`lower(${schema.user.email}) = ${current.email}`).get()) throw new InviteError('already_user');
  const other = pendingInviteForEmail(db, current.email, now);
  if (other && other.id !== id) throw new InviteError('already_invited');
  const token = newInviteToken();
  const invite = db.update(schema.invite)
    .set({ tokenHash: hashInviteToken(token), expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString() })
    .where(and(eq(schema.invite.id, id), isNull(schema.invite.acceptedAt), isNull(schema.invite.revokedAt))).returning().get();
  return invite && { invite, token };
}

/**
 * Takes the invite for one acceptance: a single conditional UPDATE, so of two concurrent accepts exactly one sees a
 * changed row. `userId` may be null while the account is still being created ({@link setInviteUser} fills it in).
 */
export function claimInvite(db: Db, id: string, userId: string | null, now: Date = new Date()): boolean {
  return db.update(schema.invite).set({ acceptedAt: now.toISOString(), acceptedUserId: userId })
    .where(and(eq(schema.invite.id, id), pendingInvite(now))).run().changes === 1;
}

export function setInviteUser(db: Db, id: string, userId: string): void {
  db.update(schema.invite).set({ acceptedUserId: userId }).where(eq(schema.invite.id, id)).run();
}

/** Undoes a claim whose account could not be created, so the link can be used again. */
export function releaseInvite(db: Db, id: string): void {
  db.update(schema.invite).set({ acceptedAt: null, acceptedUserId: null }).where(and(eq(schema.invite.id, id), isNull(schema.invite.acceptedUserId))).run();
}

/**
 * The plaintext links, in memory only, for {@link INVITE_SHARE_TTL_MS} after they were made: long enough to copy the
 * link or let someone scan the QR, never persisted. After that the admin renews the invite to get a new link.
 */
export type InviteShares = { put(inviteId: string, token: string): void; get(inviteId: string): string | undefined; delete(inviteId: string): void };
export function createInviteShares(o: { ttlMs?: number; now?: () => number } = {}): InviteShares {
  const ttl = o.ttlMs ?? INVITE_SHARE_TTL_MS;
  const now = o.now ?? Date.now;
  const map = new Map<string, { token: string; at: number }>();
  const sweep = (t: number) => { for (const [k, v] of map) if (t - v.at >= ttl) map.delete(k); };
  return {
    put(inviteId, token) { const t = now(); sweep(t); map.set(inviteId, { token, at: t }); },
    get(inviteId) { sweep(now()); return map.get(inviteId)?.token; },
    delete(inviteId) { map.delete(inviteId); },
  };
}
