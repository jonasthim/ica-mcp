import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '../db/index.js';
import type { Cipher } from '../crypto.js';
import type { IcaEndpoints } from '../ica/endpoints.js';
import { newSession, type IcaSession } from '../ica/http.js';
import { IcaLoginRejected } from '../ica/web-session.js';
import { IcaUnavailable } from '../ica/errors.js';
import { NeedsAppReconnect } from './errors.js';
import { APP_SESSION_EXPIRED, AppAuthError, AppSessionExpired, appSubject, refreshAppToken, type AppState } from '../ica/app-session.js';
import { assertSameIcaPerson, subjectHash } from './identity.js';

export type AppSessionDeps = { db: Db; cipher: Cipher; endpoints: IcaEndpoints; icaAccountId: string; now?: () => Date; session?: IcaSession };

export const expiresAtOf = (st: AppState): string => new Date(Date.parse(st.issuedAt) + st.token.expires_in * 1000).toISOString();

type SessionRow = typeof schema.icaSession.$inferSelect;

/**
 * Store the app client + tokens as the `app` session of the hub user's linked ICA account (replacing any previous one).
 * A token of another ICA person than the one already connected throws DifferentIcaPerson before anything is written.
 */
export function storeAppSession(o: { db: Db; cipher: Cipher; userId: string; state: AppState; now?: () => Date }): { icaAccountId: string; expiresAt: string } {
  const profile = o.db.select({ icaAccountId: schema.userProfile.icaAccountId }).from(schema.userProfile).where(eq(schema.userProfile.userId, o.userId)).get();
  const icaAccountId = profile?.icaAccountId;
  if (!icaAccountId) throw new IcaLoginRejected('Connect your ICA account with BankID first; app access is added to it');
  const t = (o.now ?? (() => new Date()))().toISOString();
  const state: AppState = { ...o.state, issuedAt: t };
  const expiresAt = expiresAtOf(state);
  const stateEnc = o.cipher.encrypt(JSON.stringify(state));
  const incoming = subjectHash((v) => o.cipher.mac(v), appSubject(o.state.token.access_token));
  o.db.transaction((tx) => {
    // First: a refused person changes nothing (not even the loginState write below).
    const acc = tx.select().from(schema.icaAccount).where(eq(schema.icaAccount.id, icaAccountId)).get();
    assertSameIcaPerson('app', incoming, { webSubjectHash: acc?.webSubjectHash ?? null, appSubjectHash: acc?.appSubjectHash ?? null });
    if (incoming) tx.update(schema.icaAccount).set({ appSubjectHash: incoming, updatedAt: t }).where(eq(schema.icaAccount.id, icaAccountId)).run();
    // An app BankID login drops the web session's loginState to 1 at ICA at once (purchase history goes away), so
    // record that now instead of showing "available" until the next check. A direct column update: the web jar is not
    // touched (no withWebJar needed). A row recorded logged out (0) stays 0.
    const web = tx.select({ id: schema.icaSession.id, loginState: schema.icaSession.loginState }).from(schema.icaSession)
      .where(and(eq(schema.icaSession.icaAccountId, icaAccountId), eq(schema.icaSession.kind, 'web'))).get();
    if (web && web.loginState !== 0) tx.update(schema.icaSession).set({ loginState: 1, loginStateAt: t }).where(eq(schema.icaSession.id, web.id)).run();
    tx.delete(schema.icaSession).where(and(eq(schema.icaSession.icaAccountId, icaAccountId), eq(schema.icaSession.kind, 'app'))).run();
    tx.insert(schema.icaSession).values({ id: randomUUID(), icaAccountId, kind: 'app', stateEnc, expiresAt, lastOkAt: t, lastError: null, connectedAt: t, refreshedAt: t, updatedAt: t }).run();
  });
  return { icaAccountId, expiresAt };
}

/** Decrypt the account's app session. Throws CryptoKeyMismatch / CryptoFormatError on an unreadable row. */
export function loadAppSession(o: { db: Db; cipher: Cipher; icaAccountId: string }): { row: SessionRow; state: AppState } | undefined {
  const row = o.db.select().from(schema.icaSession).where(and(eq(schema.icaSession.icaAccountId, o.icaAccountId), eq(schema.icaSession.kind, 'app'))).get();
  if (!row) return undefined;
  return { row, state: JSON.parse(o.cipher.decrypt(row.stateEnc)) as AppState };
}

/** Record a failed use of the stored app session (the tokens themselves are untouched). */
export function markAppError(db: Db, rowId: string, error: string, now: Date = new Date()): void {
  db.update(schema.icaSession).set({ lastError: error, updatedAt: now.toISOString() }).where(eq(schema.icaSession.id, rowId)).run();
}

/**
 * Refresh the stored app tokens (Basic auth with the registered client) and store the rotated ones, compare-and-swap:
 * only over the row that was read. `invalid_grant` for the still-stored refresh token marks the session
 * `app session expired — reconnect` and throws AppSessionExpired; for a token another refresh already rotated it is
 * stale and the stored state is returned. No answer, a 5xx or a 429 throws IcaUnavailable (try again; the session is
 * fine). No app row (never connected, or disconnected while the refresh ran) throws NeedsAppReconnect('not-connected').
 *
 * Only race-safe behind SessionKeeper's per-account single-flight; never call it directly from anywhere else.
 */
export async function refreshAppSession(o: AppSessionDeps): Promise<AppState> {
  const now = o.now ?? (() => new Date());
  const loaded = loadAppSession(o);
  if (!loaded) throw new NeedsAppReconnect('not-connected');
  const { row, state } = loaded;
  const used = state.token.refresh_token;
  const r = await refreshAppToken(o.session ?? newSession(), o.endpoints, state);
  if (r.kind === 'invalid-grant') {
    // Another refresh may have rotated the token after we read it: then ours was merely stale and the stored
    // session is fine. Only a refresh token that is still the stored one is really dead.
    const current = loadAppSession(o);
    if (current && current.state.token.refresh_token !== used) return current.state;
    markAppError(o.db, row.id, APP_SESSION_EXPIRED, now());
    throw new AppSessionExpired(APP_SESSION_EXPIRED);
  }
  if (r.kind === 'failed') {
    if (r.status === null) { markAppError(o.db, row.id, 'app token refresh failed (network)', now()); throw new IcaUnavailable(r.errorName === 'TimeoutError' ? 'timeout' : 'network'); }
    markAppError(o.db, row.id, `app token refresh failed (HTTP ${r.status})`, now());
    if (r.status >= 500) throw new IcaUnavailable('server-error', r.status);
    if (r.status === 429) throw new IcaUnavailable('rate-limited', 429);
    throw new AppAuthError(`app token refresh failed: HTTP ${r.status}`);
  }
  // Inside ICA's first 4 hours the new token is capped at connect + 4 h; the first refresh after that returns a
  // 30-day token. Both are stored as they come: expiresAt follows expires_in.
  const t = now().toISOString();
  const next: AppState = { client: state.client, token: { ...state.token, ...r.token }, issuedAt: t };
  // Compare-and-swap: write over exactly the row we read. If it changed meanwhile (a reconnect, another refresh),
  // the stored tokens are newer than ours: keep them.
  const res = o.db.update(schema.icaSession)
    .set({ stateEnc: o.cipher.encrypt(JSON.stringify(next)), expiresAt: expiresAtOf(next), lastOkAt: t, lastError: null, refreshedAt: t, updatedAt: t })
    .where(and(eq(schema.icaSession.id, row.id), eq(schema.icaSession.stateEnc, row.stateEnc))).run();
  if (res.changes === 1) return next;
  const current = loadAppSession(o);
  if (!current) throw new NeedsAppReconnect('not-connected');
  return current.state;
}
