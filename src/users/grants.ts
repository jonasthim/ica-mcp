import { and, asc, eq, isNotNull, isNull, lte, max, or } from 'drizzle-orm';
import { schema, type Db } from '../db/index.js';

/**
 * Revokes a user's OAuth grants (the Claude connections), for one client or all, in one transaction: deletes their
 * consent rows and marks their unrevoked refresh and access tokens revoked. Returns the affected client ids.
 * The refresh tokens stop at the `revoked` column. The access tokens are JWTs checked offline and never looked up in
 * `oauth_access_token`, so marking them does not stop them: `/mcp` does, because its verifier requires a consent row
 * that existed when the token was issued ({@link activeGrantSince}), and the deleted one is gone for good.
 * Better Auth's `deleteOAuthConsent` only deletes the consent (refresh tokens stay alive) and has no server API to
 * revoke another user's tokens, hence the direct query.
 */
export function revokeOAuthGrants(db: Db, userId: string, clientId?: string, now: Date = new Date()): string[] {
  const c = schema.oauthConsent; const rt = schema.oauthRefreshToken; const at = schema.oauthAccessToken;
  return db.transaction((tx) => {
    // drizzle's and() drops undefined conditions, so no clientId means "every client".
    const consents = tx.delete(c).where(and(eq(c.userId, userId), clientId ? eq(c.clientId, clientId) : undefined)).returning({ clientId: c.clientId }).all();
    const refresh = tx.update(rt).set({ revoked: now }).where(and(eq(rt.userId, userId), isNull(rt.revoked), clientId ? eq(rt.clientId, clientId) : undefined)).returning({ clientId: rt.clientId }).all();
    const access = tx.update(at).set({ revoked: now }).where(and(eq(at.userId, userId), isNull(at.revoked), clientId ? eq(at.clientId, clientId) : undefined)).returning({ clientId: at.clientId }).all();
    return [...new Set([...consents, ...refresh, ...access].map((r) => r.clientId))];
  });
}

/** An OAuth client the user has allowed (one `oauth_consent` row), as the Connected apps page and Home show it. */
export type ConnectedApp = { clientId: string; name: string; scopes: string[]; firstUsedAt: string; lastUsedAt: string | null; redirectHost: string | null };

/** A json column's array of strings: Better Auth may store the array itself or its JSON text; anything else is none. */
const stringsOf = (v: unknown): string[] => {
  let x = v;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return []; } }
  return Array.isArray(x) ? x.filter((u): u is string => typeof u === 'string') : [];
};
/** Where a client's codes go: the first registered redirect URI's host (the whole URI for a custom scheme). */
const hostOf = (uri: string | undefined): string | null => {
  if (!uri) return null;
  try { const u = new URL(uri); return u.host || u.href; } catch { return null; }
};

/**
 * The apps the user has allowed: one per `oauth_consent` row (a revoked grant has none), with the client's name and
 * redirect host. `lastUsedAt` is the newest `created_at` of the user's refresh or access tokens for the client: the
 * authorization server records nothing per `/mcp` call, and a token grant or refresh is its only usage signal, so
 * "last used" means "last connected or refreshed" (within one access-token lifetime of the last real use). Oldest
 * grant first.
 */
export function listConnectedApps(db: Db, userId: string): ConnectedApp[] {
  const c = schema.oauthConsent; const cl = schema.oauthClient; const rt = schema.oauthRefreshToken; const at = schema.oauthAccessToken;
  const lastRefresh = db.select({ clientId: rt.clientId, at: max(rt.createdAt).as('rt_at') }).from(rt).where(eq(rt.userId, userId)).groupBy(rt.clientId).as('lr');
  const lastAccess = db.select({ clientId: at.clientId, at: max(at.createdAt).as('at_at') }).from(at).where(eq(at.userId, userId)).groupBy(at.clientId).as('la');
  const rows = db.select({
    clientId: c.clientId, name: cl.name, scopes: c.scopes, createdAt: c.createdAt, redirectUris: cl.redirectUris,
    lastRefresh: lastRefresh.at, lastAccess: lastAccess.at,
  }).from(c)
    .innerJoin(cl, eq(cl.clientId, c.clientId))
    .leftJoin(lastRefresh, eq(lastRefresh.clientId, c.clientId))
    .leftJoin(lastAccess, eq(lastAccess.clientId, c.clientId))
    .where(eq(c.userId, userId)).orderBy(asc(c.createdAt), asc(c.clientId)).all();
  return rows.map((r) => {
    // max() over a timestamp_ms column comes back as the raw epoch milliseconds.
    const last = Math.max(Number(r.lastRefresh ?? 0), Number(r.lastAccess ?? 0));
    return {
      clientId: r.clientId, name: r.name || r.clientId, scopes: stringsOf(r.scopes), firstUsedAt: r.createdAt.toISOString(),
      lastUsedAt: last > 0 ? new Date(last).toISOString() : null, redirectHost: hostOf(stringsOf(r.redirectUris)[0]),
    };
  });
}

/**
 * The lookup behind {@link activeGrantSince}, exported so a test can check its query plan: the user by primary key and
 * the consent through `oauthConsent_userId_idx` (a user has a handful of consents at most).
 */
export function grantActiveQuery(db: Db, userId: string, clientId: string, now: Date) {
  const c = schema.oauthConsent; const u = schema.user;
  return db.select({ createdAt: c.createdAt }).from(c).innerJoin(u, eq(u.id, c.userId))
    .where(and(
      eq(c.userId, userId), eq(c.clientId, clientId),
      // Banned, unless the ban has run out (Better Auth lifts an expired ban at the next sign-in).
      or(isNull(u.banned), eq(u.banned, false), and(isNotNull(u.banExpires), lte(u.banExpires, now))),
    )).limit(1);
}

/**
 * Whether the user still exists, is not disabled (banned), and still has a consent for the client: the per-request
 * check that makes revoking an app, signing out everywhere, disabling or removing a user stop `/mcp` at once.
 */
export function isGrantActive(db: Db, userId: string, clientId: string, now: Date = new Date()): boolean {
  return activeGrantSince(db, userId, clientId, now) !== undefined;
}

/**
 * When the user's current grant for the client began (its consent row's `created_at`), or undefined when there is no
 * active grant ({@link isGrantActive}). A token issued before this moment belongs to an earlier, revoked grant: the
 * verifier refuses it even after the user allows the same client id again. Better Auth writes `created_at` once, when
 * it inserts the consent (to the second), and on a later scope change only updates `scopes`/`updated_at` of the same
 * row, so widening a grant does not cut off its tokens, while a revoke (row deleted) followed by a new consent does.
 */
export function activeGrantSince(db: Db, userId: string, clientId: string, now: Date = new Date()): Date | undefined {
  return grantActiveQuery(db, userId, clientId, now).get()?.createdAt;
}
