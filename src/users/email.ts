import { and, eq, ne, sql } from 'drizzle-orm';
import * as z from 'zod/v4';
import { schema, type Db } from '../db/index.js';
import { pendingInvite } from './invites.js';

const EMAIL = z.email();
/** The longest address we store (RFC 5321's path limit). */
const EMAIL_MAX = 254;

/**
 * An email we can match safely: unchanged by NFKC and with an ASCII local part. Better Auth lowercases emails before
 * matching, and `toLowerCase` folds lookalikes (U+212A KELVIN SIGN → `k`), so an address that is not already in this
 * plain form could land on someone else's account. Checked on the raw value, before any folding.
 */
export const isMatchableEmail = (raw: string): boolean => {
  const at = raw.lastIndexOf('@');
  return at > 0 && raw === raw.normalize('NFKC') && /^[\x21-\x7e]+$/.test(raw.slice(0, at));
};

/**
 * A typed email as we store it (trimmed, lowercased — as Better Auth stores emails), or undefined when it is not one
 * we accept: the single rule for every email a person types (setup's first admin, an email change).
 */
export function normaliseNewEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t || t.length > EMAIL_MAX || !isMatchableEmail(t)) return undefined;
  const e = t.toLowerCase();
  return EMAIL.safeParse(e).success ? e : undefined;
}

export type EmailChangeError = 'email_invalid' | 'email_taken' | 'email_invited' | 'email_unchanged' | 'user_missing';
export type EmailChangeResult = { ok: true; from: string; to: string; confirmedOnly: boolean } | { ok: false; error: EmailChangeError };

/**
 * A direct, validated update of `user.email` — no verification mail (ICA-MCP sends none) and no Better Auth
 * change-email flow. Better Auth keys the credential account and the sessions on the user id, and this app runs
 * without its session cookie cache (every getSession reads the user row), so nothing else changes and a signed-in
 * session shows the new address on its next request.
 *
 * One IMMEDIATE transaction: the address must not belong to another user (case-insensitively) nor to a pending
 * invite, checked and written under the write lock. `vouched` (an admin made or confirmed the change) clears the
 * "self-changed" mark that keeps OIDC link-by-email from linking into this account; a member's own change sets it.
 * Saving the same address again as an admin only confirms it (`confirmedOnly`).
 */
export function changeUserEmail(db: Db, userId: string, raw: unknown, o: { vouched: boolean; now?: Date }): EmailChangeResult {
  const to = normaliseNewEmail(raw);
  if (!to) return { ok: false, error: 'email_invalid' };
  const now = o.now ?? new Date();
  const mark = o.vouched ? null : now.toISOString();
  return db.transaction((tx): EmailChangeResult => {
    const u = tx.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, userId)).get();
    if (!u) return { ok: false, error: 'user_missing' };
    const p = schema.userProfile;
    const flagged = Boolean(tx.select({ at: p.emailSelfChangedAt }).from(p).where(eq(p.userId, userId)).get()?.at);
    if (u.email === to) {
      if (!o.vouched || !flagged) return { ok: false, error: 'email_unchanged' };
      tx.update(p).set({ emailSelfChangedAt: null }).where(eq(p.userId, userId)).run();
      return { ok: true, from: u.email, to, confirmedOnly: true };
    }
    if (tx.select({ id: schema.user.id }).from(schema.user).where(and(sql`lower(${schema.user.email}) = ${to}`, ne(schema.user.id, userId))).get()) {
      return { ok: false, error: 'email_taken' };
    }
    if (tx.select({ id: schema.invite.id }).from(schema.invite).where(and(eq(schema.invite.email, to), pendingInvite(now))).get()) {
      return { ok: false, error: 'email_invited' };
    }
    tx.update(schema.user).set({ email: to, updatedAt: now }).where(eq(schema.user.id, userId)).run();
    tx.insert(p).values({ userId, createdAt: now.toISOString(), emailSelfChangedAt: mark })
      .onConflictDoUpdate({ target: p.userId, set: { emailSelfChangedAt: mark } }).run();
    return { ok: true, from: u.email, to, confirmedOnly: false };
  }, { behavior: 'immediate' });
}

/** Whether the user's current email was set by themselves (a member) and not yet confirmed by an admin. */
export const isSelfChangedEmail = (db: Db, userId: string): boolean =>
  Boolean(db.select({ at: schema.userProfile.emailSelfChangedAt }).from(schema.userProfile).where(eq(schema.userProfile.userId, userId)).get()?.at);
