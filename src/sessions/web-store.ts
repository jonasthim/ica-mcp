import { randomUUID } from 'node:crypto';
import { and, eq, isNull, lte, ne, or } from 'drizzle-orm';
import { CookieJar } from 'tough-cookie';
import { schema, type Db } from '../db/index.js';
import type { Cipher } from '../crypto.js';
import type { IcaEndpoints } from '../ica/endpoints.js';
import { newSession, type IcaSession } from '../ica/http.js';
import { IcaLoginRejected, fetchUserInformation } from '../ica/web-session.js';
import { assertSameIcaPerson, subjectHash } from './identity.js';

/**
 * Turn a jar that has just completed the BankID web login into the stored web session of the hub user's ICA account:
 * verify it (thSessionId present, accessToken issued, loginState ≠ 0), create/link the ica_account on first
 * enrolment, and replace any previous web session with the encrypted serialised jar. A login of another ICA person
 * than the one already connected (by subject hash) throws DifferentIcaPerson before anything is written.
 */
export async function storeWebSession(o: {
  session: IcaSession; endpoints: IcaEndpoints; db: Db; cipher: Cipher; user: { id: string; name: string }; now?: () => Date;
}): Promise<{ icaAccountId: string; expiresAt: string | null }> {
  const th = (await o.session.jar.getCookies(`${o.endpoints.web}/`)).find((c) => c.key === 'thSessionId');
  if (!th) throw new IcaLoginRejected('ICA login finished but set no ica.se session cookie');
  const info = await fetchUserInformation(o.session, o.endpoints);
  if (!info.accessToken || info.loginState === 0) throw new IcaLoginRejected(`ICA did not accept the login (HTTP ${info.status}, loginState ${String(info.loginState)})`);
  const raw = o.session.jar.serializeSync();
  if (!raw) throw new Error('cookie jar is not serialisable');
  const serialized = storedForm(raw, new Date());
  const stateEnc = o.cipher.encrypt(JSON.stringify(serialized));
  const expiresAt = th.expires instanceof Date ? th.expires.toISOString() : null;
  const now = (o.now ?? (() => new Date()))().toISOString();
  const incoming = subjectHash((v) => o.cipher.mac(v), info.subject);

  const icaAccountId = o.db.transaction((tx) => {
    const profile = tx.select().from(schema.userProfile).where(eq(schema.userProfile.userId, o.user.id)).get();
    let accountId = profile?.icaAccountId ?? undefined;
    if (!accountId) {
      accountId = randomUUID();
      tx.insert(schema.icaAccount).values({ id: accountId, displayName: info.firstName ?? o.user.name, createdAt: now, updatedAt: now, ...(incoming ? { webSubjectHash: incoming } : {}) }).run();
      if (profile) tx.update(schema.userProfile).set({ icaAccountId: accountId }).where(eq(schema.userProfile.userId, o.user.id)).run();
      else tx.insert(schema.userProfile).values({ userId: o.user.id, icaAccountId: accountId, createdAt: now }).run();
    } else {
      // First statement of this branch: a refused person must leave the stored account and session as they were.
      const acc = tx.select().from(schema.icaAccount).where(eq(schema.icaAccount.id, accountId)).get();
      assertSameIcaPerson('web', incoming, { webSubjectHash: acc?.webSubjectHash ?? null, appSubjectHash: acc?.appSubjectHash ?? null });
      tx.update(schema.icaAccount).set({ updatedAt: now, ...(info.firstName ? { displayName: info.firstName } : {}), ...(incoming ? { webSubjectHash: incoming } : {}) }).where(eq(schema.icaAccount.id, accountId)).run();
    }
    tx.delete(schema.icaSession).where(and(eq(schema.icaSession.icaAccountId, accountId), eq(schema.icaSession.kind, 'web'))).run();
    tx.insert(schema.icaSession).values({ id: randomUUID(), icaAccountId: accountId, kind: 'web', stateEnc, expiresAt, lastOkAt: now, lastError: null, connectedAt: now, loginState: info.loginState ?? null, loginStateAt: now, updatedAt: now }).run();
    return accountId;
  });
  return { icaAccountId, expiresAt };
}

export type SessionRow = typeof schema.icaSession.$inferSelect;
export type AccountRow = typeof schema.icaAccount.$inferSelect;

/** The hub user's linked ICA account and its web and (experimental) app session rows, if any. */
export function linkedIcaAccount(db: Db, userId: string): { account: AccountRow; web: SessionRow | undefined; app: SessionRow | undefined } | undefined {
  const profile = db.select({ icaAccountId: schema.userProfile.icaAccountId }).from(schema.userProfile).where(eq(schema.userProfile.userId, userId)).get();
  if (!profile?.icaAccountId) return undefined;
  const account = db.select().from(schema.icaAccount).where(eq(schema.icaAccount.id, profile.icaAccountId)).get();
  if (!account) return undefined;
  const rows = db.select().from(schema.icaSession).where(eq(schema.icaSession.icaAccountId, account.id)).all();
  return { account, web: rows.find((r) => r.kind === 'web'), app: rows.find((r) => r.kind === 'app') };
}

/** Decrypt a stored web session into a live cookie session. Throws CryptoKeyMismatch on a wrong master key. */
export function loadWebSession(o: { db: Db; cipher: Cipher; icaAccountId: string }): { row: SessionRow; session: IcaSession } | undefined {
  const row = o.db.select().from(schema.icaSession).where(and(eq(schema.icaSession.icaAccountId, o.icaAccountId), eq(schema.icaSession.kind, 'web'))).get();
  if (!row) return undefined;
  return { row, session: newSession(CookieJar.deserializeSync(o.cipher.decrypt(row.stateEnc))) };
}

/** Record the outcome of a use of the stored web session (diagnostics) without touching the jar itself. */
export function markWebSession(db: Db, rowId: string, ok: boolean, error: string | null, now: Date = new Date()): void {
  const t = now.toISOString();
  db.update(schema.icaSession).set(ok ? { lastOkAt: t, lastError: null, updatedAt: t } : { lastError: error, updatedAt: t }).where(eq(schema.icaSession.id, rowId)).run();
}

/** A cookie's identity (key, domain, path) and its state (value, expiry), as serialised by tough-cookie. */
type SerializedCookie = { key?: string; value?: string; domain?: string | null; path?: string | null; expires?: unknown; maxAge?: unknown; lastAccessed?: unknown };
const cookieId = (c: SerializedCookie): string => JSON.stringify([c.key, c.domain ?? null, c.path ?? null]);

/**
 * When a cookie really expires. tough-cookie measures Max-Age from `lastAccessed` (when the cookie was last set or
 * sent), so a Max-Age cookie kept as such would never expire once stored, and a sliding Max-Age would not look like
 * a change. Its expiry is taken as lastAccessed + Max-Age.
 */
function effectiveExpiry(c: SerializedCookie): unknown {
  if (typeof c.maxAge === 'number') {
    const from = typeof c.lastAccessed === 'string' ? Date.parse(c.lastAccessed) : Number.NaN;
    if (!Number.isNaN(from)) return new Date(from + c.maxAge * 1000).toISOString();
  }
  return c.expires ?? null;
}
const cookieState = (c: SerializedCookie): string => JSON.stringify([c.value ?? null, effectiveExpiry(c)]);

/**
 * A serialised jar as it is stored: numeric Max-Age turned into an absolute expiry (see effectiveExpiry), and expired
 * cookies left out (tough-cookie keeps a cookie ICA deleted, with an expiry in the past; stored, it is a removal).
 */
function storedForm<T extends { cookies: unknown[] }>(serialized: T, now: Date): T {
  const cookies = (serialized.cookies as SerializedCookie[]).flatMap((c) => {
    const expiry = effectiveExpiry(c);
    if (typeof expiry === 'string' && Date.parse(expiry) <= now.getTime()) return [];
    if (typeof c.maxAge !== 'number') return [c];
    const out: SerializedCookie = { ...c, expires: expiry };
    delete out.maxAge;
    return [out];
  });
  return { ...serialized, cookies };
}

/**
 * What identifies a jar's cookies: identity and value/expiry per cookie, not tough-cookie's access timestamps (which
 * change on every request). Also the baseline `saveWebJarIfChanged` computes a use's changes against.
 */
export function cookieFingerprint(jar: CookieJar): string {
  const cookies = (jar.serializeSync()?.cookies ?? []) as SerializedCookie[];
  return JSON.stringify(cookies.map((c) => [cookieId(c), cookieState(c)]).sort());
}

export type JarSaveLog = { warn: (obj: object, msg: string) => void };

async function thSessionExpiry(serialized: object, web: string): Promise<string | undefined> {
  const th = (await CookieJar.deserializeSync(serialized as Parameters<typeof CookieJar.deserializeSync>[0]).getCookies(`${web}/`)).find((c) => c.key === 'thSessionId');
  return th?.expires instanceof Date ? th.expires.toISOString() : undefined;
}

/**
 * Write a used jar back when its cookies changed (ICA rotates them), keeping expiresAt in step with thSessionId.
 * Returns whether it wrote.
 *
 * Compare-and-swap on `state_enc`, like the app tokens. The keeper serialises its own uses of an account's jar
 * (`withWebJar`), so a miss means some other writer got in between. Then this use's changes (cookies whose value or
 * expiry differ from the jar as loaded, keyed by key/domain/path, plus cookies it lost) are applied on top of the row
 * as it is now and swapped in once more: cookies only the other writer changed survive, for a cookie both changed
 * the later writer wins, and a lost cookie is dropped only if the other writer left it as it was. Max-Age is stored
 * as an absolute expiry, so a sliding Max-Age counts as a change and is persisted. A second miss, or a row that is
 * gone (a reconnect replaced it), gives up. Every miss and merge is logged at warn with the account and the counts.
 */
export async function saveWebJarIfChanged(o: { db: Db; cipher: Cipher; row: SessionRow; session: IcaSession; before: string; web: string; now?: Date; log?: JarSaveLog }): Promise<boolean> {
  if (cookieFingerprint(o.session.jar) === o.before) return false;
  const raw = o.session.jar.serializeSync();
  if (!raw) return false;
  const serialized = storedForm(raw, new Date());
  const t = (o.now ?? new Date()).toISOString();
  const swap = async (next: object, expected: string): Promise<boolean> => {
    const expiresAt = await thSessionExpiry(next, o.web);
    return o.db.update(schema.icaSession)
      .set({ stateEnc: o.cipher.encrypt(JSON.stringify(next)), ...(expiresAt ? { expiresAt } : {}), updatedAt: t })
      .where(and(eq(schema.icaSession.id, o.row.id), eq(schema.icaSession.stateEnc, expected))).run().changes > 0;
  };
  if (await swap(serialized, o.row.stateEnc)) return true;

  const before = new Map(JSON.parse(o.before) as [string, string][]);
  const mine = serialized.cookies as SerializedCookie[];
  const changed = mine.filter((c) => before.get(cookieId(c)) !== cookieState(c));
  const mineIds = new Set(mine.map(cookieId));
  const removed = new Set([...before.keys()].filter((id) => !mineIds.has(id)));
  const counts = { account: o.row.icaAccountId, changed: changed.length, removed: removed.size };
  o.log?.warn({ ...counts, event: 'jar-cas-miss' }, 'ica web jar changed underneath, merging');
  const current = o.db.select().from(schema.icaSession).where(eq(schema.icaSession.id, o.row.id)).get();
  if (!current) { o.log?.warn({ ...counts, event: 'jar-merge-gave-up' }, 'ica web jar merge gave up'); return false; }
  const theirs = JSON.parse(o.cipher.decrypt(current.stateEnc)) as { cookies: SerializedCookie[] };
  const changedIds = new Set(changed.map(cookieId));
  // Three-way for deletes: a cookie this use lost is dropped only while the stored copy is still the one it loaded.
  const dropped = (c: SerializedCookie) => removed.has(cookieId(c)) && cookieState(c) === before.get(cookieId(c));
  const merged = { ...theirs, cookies: [...theirs.cookies.filter((c) => !changedIds.has(cookieId(c)) && !dropped(c)), ...changed] };
  if (await swap(merged, current.stateEnc)) { o.log?.warn({ ...counts, event: 'jar-merged' }, 'ica web jar merged'); return true; }
  o.log?.warn({ ...counts, event: 'jar-merge-gave-up' }, 'ica web jar merge gave up');
  return false;
}

/**
 * Purchase history as last observed: available only when ICA reported loginState 2 at `checkedAt` (it lapses on its
 * own within hours, and at once on an app BankID login); null = unknown (never checked, or the check was refused).
 * Never inferred from elapsed time.
 */
export type PurchaseHistoryState = { available: boolean | null; loginState: number | null; checkedAt: string | null };
export const purchaseHistoryOf = (row: { loginState: number | null; loginStateAt: string | null } | undefined): PurchaseHistoryState =>
  !row || row.loginState === null ? { available: null, loginState: null, checkedAt: row?.loginStateAt ?? null }
    : { available: row.loginState === 2, loginState: row.loginState, checkedAt: row.loginStateAt };

/**
 * Record the loginState ICA reported for a web session (2 = purchase history available) and when it was checked.
 * Compare-and-swap on `loginStateAt`: an observation whose request started at `startedAt` never overwrites a state
 * recorded after that (an app BankID connect that dropped the level while the check was in flight). Returns whether
 * it was written.
 */
export function recordLoginState(db: Db, rowId: string, loginState: number | null, at: Date, startedAt: Date = at): boolean {
  const s = schema.icaSession;
  return db.update(s).set({ loginState, loginStateAt: at.toISOString() })
    .where(and(eq(s.id, rowId), or(isNull(s.loginStateAt), lte(s.loginStateAt, startedAt.toISOString())))).run().changes === 1;
}

/**
 * Removes the user's ICA link. When no other profile uses the ICA account, the account is deleted (its encrypted
 * sessions cascade, the profile link is set null). When the household shares it with another profile, only this
 * user's link is cleared, so the other member keeps their sessions. `mode` says which of the two happened; undefined
 * when no account was linked.
 */
export function disconnectIcaAccount(db: Db, userId: string): { mode: 'deleted' | 'unlinked' } | undefined {
  const p = schema.userProfile;
  return db.transaction((tx) => {
    const acc = tx.select({ acc: p.icaAccountId }).from(p).where(eq(p.userId, userId)).get()?.acc;
    if (!acc) return undefined;
    if (icaAccountShared(tx, userId, acc)) {
      return tx.update(p).set({ icaAccountId: null }).where(eq(p.userId, userId)).run().changes > 0 ? { mode: 'unlinked' as const } : undefined;
    }
    return tx.delete(schema.icaAccount).where(eq(schema.icaAccount.id, acc)).run().changes > 0 ? { mode: 'deleted' as const } : undefined;
  });
}

/** Whether another profile than `userId`'s is linked to the ICA account `acc` (a disconnect then only unlinks). */
function icaAccountShared(db: Pick<Db, 'select'>, userId: string, acc: string): boolean {
  const p = schema.userProfile;
  return Boolean(db.select({ userId: p.userId }).from(p).where(and(eq(p.icaAccountId, acc), ne(p.userId, userId))).get());
}

/** Whether the user's linked ICA account is shared with another household profile (so a disconnect keeps it). */
export function icaAccountSharedFor(db: Db, userId: string): boolean {
  const acc = db.select({ acc: schema.userProfile.icaAccountId }).from(schema.userProfile).where(eq(schema.userProfile.userId, userId)).get()?.acc;
  return Boolean(acc && icaAccountShared(db, userId, acc));
}
