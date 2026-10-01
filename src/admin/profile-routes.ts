import { Router, type Request, type Response } from 'express';
import { APIError } from 'better-auth/api';
import { and, count, desc, eq, gt, inArray } from 'drizzle-orm';
import type { AuthHolder } from '../auth/holder.js';
import { OIDC_PROVIDER_ID } from '../auth/index.js';
import { roleOf } from '../auth/roles.js';
import { listAuditEvents, type BoundAudit } from '../audit.js';
import type { Config } from '../config.js';
import { schema, type Db } from '../db/index.js';
import { changeUserEmail, isSelfChangedEmail, normaliseNewEmail } from '../users/email.js';
import { revokeOAuthGrants } from '../users/grants.js';
import { authCall as authCallFor } from './auth-call.js';
import type { SeeOther } from './flash.js';
import { s } from './i18n.js';
import { pageCtx, type Theme } from './page-ctx.js';
import { createLoginLimiter } from './rate-limit.js';
import { validateDisplayName } from './display-name.js';
import type { AdminSession } from './session.js';
import { describeUserAgent, errorPage, profilePage, type EventRow, type SessionView } from './views/index.js';

const HOME = '/admin/profile';
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
const ACTIVITY_LIMIT = 20;
/** At most this many sessions are listed (most recently active first); the rest are only counted. */
const SESSION_LIMIT = 50;

type AuthAccount = { providerId: string };

/** A Better Auth call's outcome: its Response when it answered (ok or not), or the status of the APIError it threw. */
async function settle(call: () => Promise<globalThis.Response>): Promise<{ ok: boolean; status: number; res?: globalThis.Response }> {
  try {
    const res = await call();
    return { ok: res.ok, status: res.status, res };
  } catch (err) {
    if (!(err instanceof APIError)) throw err;
    return { ok: false, status: err.statusCode };
  }
}

/**
 * /admin/profile (mounted behind `requireSession`): the signed-in user's own name, sign-in methods, theme, sessions,
 * password and activity. Better Auth calls run server-side with the user's own session via `authCall`.
 *
 * The session list and the single-session sign-out read and delete `session` rows directly, always scoped to the
 * current user: Better Auth's `listSessions` (and so a token for `revokeSession`) is only available within `freshAge` of
 * signing in, and listing your own devices is not sensitive enough to demand a fresh sign-in. The token column is never
 * selected. Signing out the others, everywhere, and the password change stay on Better Auth's APIs.
 */
export function profileRouter(deps: { auth: AuthHolder; db: Db; config: Config }): Router {
  const { auth: holder, db, config } = deps;
  // Password attempts per user and per IP (password and email changes share it): the current password is checked
  // here, so it is a guessing surface.
  const passwordLimit = createLoginLimiter({ max: 5 });
  const r = Router();

  const me = (res: Response): AdminSession => res.locals.session as AdminSession;
  const see = (res: Response): SeeOther => res.locals.seeOther as SeeOther;
  const audit = (res: Response): BoundAudit => res.locals.audit as BoundAudit;
  const call = (req: Request, path: string) => authCallFor(config, req, path);

  /**
   * The user's unexpired sessions, most recently active first, at most {@link SESSION_LIMIT}, plus how many more there
   * are. The token is deliberately not selected. The current session is always listed first, even beyond the limit.
   */
  const sessionsOf = (userId: string, currentId: string): { sessions: SessionView[]; more: number } => {
    const x = schema.session;
    const mine = and(eq(x.userId, userId), gt(x.expiresAt, new Date()));
    const cols = { id: x.id, ip: x.ipAddress, userAgent: x.userAgent, createdAt: x.createdAt, updatedAt: x.updatedAt };
    const rows = db.select(cols).from(x).where(mine).orderBy(desc(x.updatedAt), desc(x.id)).limit(SESSION_LIMIT).all();
    const total = db.select({ n: count() }).from(x).where(mine).get()?.n ?? 0;
    if (!rows.some((row) => row.id === currentId)) {
      const current = db.select(cols).from(x).where(and(mine, eq(x.id, currentId))).get();
      if (current) rows.splice(rows.length - 1, 1, current);
    }
    const sessions = rows.map((row) => ({
      id: row.id, device: describeUserAgent(row.userAgent), ip: row.ip ?? null,
      lastSeenAt: row.updatedAt.toISOString(), createdAt: row.createdAt.toISOString(), current: row.id === currentId,
    })).sort((a, b) => Number(b.current) - Number(a.current));
    return { sessions, more: Math.max(0, total - sessions.length) };
  };
  /** Our Better Auth session cookie, expired (Max-Age=0) with the attributes Better Auth set it with. */
  const clearedSessionCookie = async (): Promise<string> => {
    const { name, attributes: options } = (await holder.current.$context).authCookies.sessionToken;
    const attrs = [`Path=${options.path ?? '/'}`, 'Max-Age=0', options.httpOnly ? 'HttpOnly' : '', options.secure ? 'Secure' : '', options.sameSite ? `SameSite=${String(options.sameSite)[0]!.toUpperCase()}${String(options.sameSite).slice(1)}` : ''];
    return [`${name}=`, ...attrs.filter(Boolean)].join('; ');
  };
  const listAccounts = async (req: Request): Promise<AuthAccount[]> => {
    const out = await settle(() => holder.current.api.listUserAccounts(call(req, '/list-accounts')));
    return out.ok && out.res ? (await out.res.json()) as AuthAccount[] : [];
  };
  // Password login off: a password cannot be used to sign in, so it is not offered for change either (read per request).
  const canChangePassword = (accounts: AuthAccount[]): boolean => holder.snapshot().config.localLogin && accounts.some((a) => a.providerId === 'credential');
  const methodLabel = (providerId: string): string =>
    providerId === 'credential' ? s.profile.password : providerId === OIDC_PROVIDER_ID ? (holder.snapshot().settings.oidc?.label ?? s.profile.sso) : providerId;
  /** The user's password hash, when the account has a password (a `credential` account). Never leaves this module. */
  const passwordHashOf = (userId: string): string | undefined => db.select({ hash: schema.account.password }).from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'credential'))).get()?.hash ?? undefined;
  const forwardCookies = (res: Response, r2: globalThis.Response | undefined): void => {
    for (const c of r2?.headers.getSetCookie() ?? []) res.append('Set-Cookie', c);
  };

  /** The user's own recent events (things they did, and things done to their account), labelled like the Activity page. */
  const activityOf = (userId: string): EventRow[] => {
    const { rows } = listAuditEvents(db, { involvingUserId: userId }, { limit: ACTIVITY_LIMIT, offset: 0 });
    const ids = [...new Set(rows.flatMap((x) => [x.actorUserId, x.targetType === 'user' ? x.targetId : null]).filter((x): x is string => Boolean(x)))];
    const users = new Map((ids.length ? db.select({ id: schema.user.id, name: schema.user.name, email: schema.user.email }).from(schema.user).where(inArray(schema.user.id, ids)).all() : [])
      .map((u) => [u.id, u.name || u.email]));
    const label = (id: string | null): string => (id === userId ? s.common.you : id ? users.get(id) ?? s.activity.removedUser : s.activity.system);
    return rows.map((x) => ({
      ...x,
      actorLabel: label(x.actorUserId),
      targetLabel: x.targetType === 'user' ? label(x.targetId) : x.targetType ? ((s.activity.targets as Record<string, string>)[x.targetType] ?? x.targetType) : '',
    }));
  };

  r.get('/', async (req, res) => {
    const session = me(res);
    const accounts = await listAccounts(req);
    res.set('Cache-Control', 'no-store').type('html').send(profilePage(pageCtx(res), {
      name: session.user.name, email: session.user.email,
      methods: [...new Set(accounts.map((a) => a.providerId))].map((providerId) => ({ providerId, label: methodLabel(providerId) })),
      canChangePassword: canChangePassword(accounts), theme: res.locals.theme as Theme,
      hasPassword: passwordHashOf(session.user.id) !== undefined, isAdmin: roleOf(session.user) === 'admin',
      emailUnconfirmed: isSelfChangedEmail(db, session.user.id),
      ...(({ sessions, more }) => ({ sessions, moreSessions: more }))(sessionsOf(session.user.id, session.session.id)), activity: activityOf(session.user.id),
    }));
  });

  r.post('/name', async (req, res) => {
    const name = validateDisplayName((req.body as Record<string, unknown>).name);
    if (name === undefined) { see(res)(res, HOME, { kind: 'error', code: 'name_invalid' }); return; }
    const out = await settle(() => holder.current.api.updateUser({ body: { name }, ...call(req, '/update-user') }));
    if (!out.ok) { see(res)(res, HOME, { kind: 'error', code: 'profile_failed' }); return; }
    forwardCookies(res, out.res);
    audit(res)('settings.changed', { target: { type: 'user', id: me(res).user.id }, details: { setting: 'name' } });
    see(res)(res, HOME, { kind: 'success', code: 'name_saved' });
  });

  /**
   * The user's own email (spec 1.6 "Account email"): set directly, nothing is sent. Rate-limited like the password
   * change, for every account. A local account (one with a password) must give its current password, checked with
   * Better Auth's own hasher against the credential row; a wrong one is audited (never the password). An account
   * without a password (single sign-on only) has nothing to re-enter, so the spec requires none. An admin's own change
   * is vouched for; a member's is marked, so OIDC link-by-email does not link to it until an admin confirms it.
   * No cookie to refresh: Better Auth's cookie cache is off here, so the next getSession reads the new email.
   */
  r.post('/email', async (req, res) => {
    const session = me(res); const userId = session.user.id;
    const body = req.body as Record<string, unknown>;
    const hash = passwordHashOf(userId);
    if (normaliseNewEmail(body.email) === undefined) { see(res)(res, HOME, { kind: 'error', code: 'email_invalid' }); return; }
    if (!passwordLimit.attempt([`user:${userId}`, `ip:${req.ip ?? 'unknown'}`]).ok) { see(res)(res, HOME, { kind: 'error', code: 'email_rate' }); return; }
    const current = typeof body.current === 'string' ? body.current : '';
    const ok = hash === undefined || (current !== '' && await (await holder.snapshot().auth.$context).password.verify({ hash, password: current }));
    if (!ok) {
      audit(res)('user.email_changed', { target: { type: 'user', id: userId }, outcome: 'failure', details: { from: session.user.email } });
      see(res)(res, HOME, { kind: 'error', code: 'email_password_wrong' });
      return;
    }
    const isAdmin = roleOf(session.user) === 'admin';
    const out = changeUserEmail(db, userId, body.email, { vouched: isAdmin });
    if (!out.ok) {
      see(res)(res, HOME, out.error === 'user_missing' ? { kind: 'error', code: 'user_not_changed' } : { kind: out.error === 'email_unchanged' ? 'info' : 'error', code: out.error });
      return;
    }
    audit(res)('user.email_changed', { target: { type: 'user', id: userId }, details: { from: out.from, to: out.to } });
    see(res)(res, HOME, { kind: 'success', code: isAdmin ? 'email_changed_self' : 'email_changed_member', params: { email: out.to } });
  });

  r.post('/sessions/revoke-others', async (req, res) => {
    const out = await settle(() => holder.current.api.revokeOtherSessions(call(req, '/revoke-other-sessions')));
    if (!out.ok) { see(res)(res, HOME, { kind: 'error', code: 'profile_failed' }); return; }
    audit(res)('auth.session_revoked', { target: { type: 'user', id: me(res).user.id }, details: { scope: 'others' } });
    see(res)(res, HOME, { kind: 'success', code: 'others_signed_out' });
  });

  r.post('/sessions/revoke-all', async (req, res) => {
    const userId = me(res).user.id;
    // Claude first: its grants are revoked even if ending the browser sessions then fails.
    for (const clientId of revokeOAuthGrants(db, userId)) {
      const clientName = db.select({ name: schema.oauthClient.name }).from(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId)).get()?.name ?? clientId;
      audit(res)('oauth.client_revoked', { target: { type: 'oauth_client', id: clientId }, details: { clientName, reason: 'sign_out_everywhere' } });
    }
    const out = await settle(() => holder.current.api.revokeSessions(call(req, '/revoke-sessions')));
    audit(res)('auth.session_revoked', { target: { type: 'user', id: userId }, outcome: out.ok ? 'success' : 'failure', details: { scope: 'everywhere' } });
    // Half done: say exactly what happened, so the user knows to try again (Claude is already disconnected).
    if (!out.ok) { see(res)(res, HOME, { kind: 'error', code: 'everywhere_partial' }); return; }
    forwardCookies(res, out.res);
    // revokeSessions deletes the rows but leaves this browser's cookie: clear it too.
    res.append('Set-Cookie', await clearedSessionCookie());
    see(res)(res, '/admin/login', { kind: 'info', code: 'signed_out_everywhere' });
  });

  r.post('/sessions/:id/revoke', async (req, res) => {
    const id = String(req.params.id);
    const session = me(res);
    if (id === session.session.id) {
      // This very session: a normal sign-out, so Better Auth also clears the cookie.
      const out = await settle(() => holder.current.api.signOut(call(req, '/sign-out')));
      audit(res)('auth.session_revoked', { target: { type: 'session', id }, outcome: out.ok ? 'success' : 'failure', details: { scope: 'one' } });
      if (!out.ok) { see(res)(res, HOME, { kind: 'error', code: 'profile_failed' }); return; }
      forwardCookies(res, out.res);
      see(res)(res, '/admin/login', { kind: 'info', code: 'signed_out' });
      return;
    }
    // Scoped to the current user: another user's id (or a made-up one) deletes nothing.
    const x = schema.session;
    const gone = db.delete(x).where(and(eq(x.id, id), eq(x.userId, session.user.id))).run().changes;
    if (!gone) { see(res)(res, HOME, { kind: 'error', code: 'session_not_found' }); return; }
    audit(res)('auth.session_revoked', { target: { type: 'session', id }, details: { scope: 'one' } });
    see(res)(res, HOME, { kind: 'success', code: 'session_revoked' });
  });

  r.post('/password', async (req, res) => {
    const userId = me(res).user.id;
    if (!canChangePassword(await listAccounts(req))) { res.status(403).type('html').send(errorPage(pageCtx(res), { status: 403, code: 'forbidden' })); return; }
    const body = req.body as Record<string, unknown>;
    const str = (k: string): string => (typeof body[k] === 'string' ? body[k] : '');
    const [current, password, confirm] = [str('current'), str('password'), str('confirm')];
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) { see(res)(res, HOME, { kind: 'error', code: 'password_invalid' }); return; }
    if (password !== confirm) { see(res)(res, HOME, { kind: 'error', code: 'password_mismatch' }); return; }
    if (!passwordLimit.attempt([`user:${userId}`, `ip:${req.ip ?? 'unknown'}`]).ok) { see(res)(res, HOME, { kind: 'error', code: 'password_rate' }); return; }
    const out = await settle(() => holder.current.api.changePassword({
      body: { currentPassword: current, newPassword: password, revokeOtherSessions: true }, ...call(req, '/change-password'),
    }));
    if (!out.ok) {
      audit(res)('settings.changed', { target: { type: 'user', id: userId }, outcome: 'failure', details: { setting: 'password' } });
      see(res)(res, HOME, { kind: 'error', code: out.status === 400 ? 'password_wrong' : 'profile_failed' });
      return;
    }
    // Better Auth ended every session and issued this browser a fresh one: pass its cookie on.
    forwardCookies(res, out.res);
    audit(res)('settings.changed', { target: { type: 'user', id: userId }, details: { setting: 'password' } });
    see(res)(res, HOME, { kind: 'success', code: 'password_changed' });
  });

  return r;
}
