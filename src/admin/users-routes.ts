import { Router, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { APIError } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import { and, eq, max } from 'drizzle-orm';
import type { AuthHolder } from '../auth/holder.js';
import { OIDC_PROVIDER_ID } from '../auth/index.js';
import { isRole, roleOf } from '../auth/roles.js';
import type { BoundAudit } from '../audit.js';
import type { Config } from '../config.js';
import { schema, type Db } from '../db/index.js';
import { disconnectIcaAccount, icaAccountSharedFor, linkedIcaAccount } from '../sessions/web-store.js';
import type { Logger } from '../logger.js';
import { leavesNoAdmin } from '../users/admins.js';
import { changeUserEmail, isSelfChangedEmail } from '../users/email.js';
import { revokeOAuthGrants } from '../users/grants.js';
import {
  createInvite, InviteError, inviteById, inviteState, listPendingInvites, renewInvite, revokeInvite, type InviteShares, type PendingInviteView,
} from '../users/invites.js';
import { authCall as authCallFor } from './auth-call.js';
import { capName } from './display-name.js';
import type { SeeOther } from './flash.js';
import { s } from './i18n.js';
import { pageCtx } from './page-ctx.js';
import type { AdminSession } from './session.js';
import { errorPage, inviteSharePage, userConfirmPage, userEmailPage, usersPage, type UserConfirmKind, type UserRowView } from './views/index.js';
import { icaStatus, NO_WEB_SESSION } from './views/status.js';

type UserRow = typeof schema.user.$inferSelect;
const LIST = '/admin/users';
/** The name for a flash message: capped like apps-routes', since an OIDC-created user's name comes from the IdP uncapped. */
const nameOf = (u: { name: string; email: string }): string => capName(u.name || u.email);

/**
 * Runs one admin mutation at a time. Every guard (last admin, self) is checked and acted on inside the same turn, so
 * two admins demoting or disabling each other at once cannot both pass the check and leave the hub without an admin.
 *
 * The queue is per router instance and only covers this router's routes. Any future code path that changes a user's
 * role, banned flag or existence outside this router (OIDC group sync, a CLI, another page) must run through this same
 * queue, or the last-admin guard can be raced.
 */
function createSerial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * /admin/users (mounted behind `requireSession` + `requireAdmin`): the household's users with role, status, ICA status
 * and sign-in details, and the admin actions on them. Better Auth's admin endpoints (`setRole`, `banUser`, `unbanUser`,
 * `removeUser`, `listUsers`) are called server-side only, with the acting admin's session. Destructive actions (disable,
 * remove, ICA disconnect) take effect only with `confirm=yes`; without it the POST answers with a confirmation page.
 */
export function usersRouter(deps: { auth: AuthHolder; db: Db; config: Config; log: Pick<Logger, 'warn'>; shares: InviteShares }): Router {
  const { auth: holder, db, config, log, shares } = deps;
  const serial = createSerial();
  const r = Router();

  const userById = (id: string): UserRow | undefined => db.select().from(schema.user).where(eq(schema.user.id, id)).get();
  /** A Better Auth admin call: true when it succeeded; a refusal (an error response or APIError) is logged and false. */
  const betterAuth = async (action: string, call: () => Promise<globalThis.Response>): Promise<boolean> => {
    try {
      const res = await call();
      if (res.ok) return true;
      log.warn({ action, status: res.status }, 'admin user action refused');
      return false;
    } catch (err) {
      if (!(err instanceof APIError)) throw err;
      log.warn({ action, status: err.statusCode }, 'admin user action refused');
      return false;
    }
  };

  type Ctx = { req: Request; res: Response; see: SeeOther; audit: BoundAudit; me: UserRow; target: UserRow };
  /**
   * The shared frame of every action: serialised; the acting user re-read (still an active admin, or a 403); the target
   * looked up (unknown → `user_not_changed`). `fn` then runs with both rows.
   */
  const action = (fn: (c: Ctx) => Promise<void> | void) => async (req: Request, res: Response): Promise<void> => {
    await serial(async () => {
      const see = res.locals.seeOther as SeeOther;
      const me = userById((res.locals.session as AdminSession).user.id);
      if (!me || roleOf(me) !== 'admin' || me.banned) { res.status(403).type('html').send(errorPage(pageCtx(res), { status: 403, code: 'forbidden' })); return; }
      const target = userById(String(req.params.id));
      if (!target) { see(res, LIST, { kind: 'error', code: 'user_not_changed' }); return; }
      await fn({ req, res, see, audit: res.locals.audit as BoundAudit, me, target });
    });
  };
  const confirmed = (req: Request): boolean => (req.body as Record<string, unknown> | undefined)?.confirm === 'yes';
  const askFirst = (res: Response, kind: UserConfirmKind, target: UserRow): void => {
    res.type('html').send(userConfirmPage(pageCtx(res), {
      kind, user: { id: target.id, name: target.name, email: target.email }, ...(kind === 'disconnect' ? { icaShared: icaAccountSharedFor(db, target.id) } : {}),
    }));
  };

  r.get('/', async (req, res) => {
    const me = (res.locals.session as AdminSession).user.id;
    const { users } = await holder.current.api.listUsers({ query: { limit: 200, sortBy: 'createdAt', sortDirection: 'asc' }, headers: fromNodeHeaders(req.headers) });
    const a = schema.auditEvent;
    const lastSignIn = new Map(db.select({ actor: a.actorUserId, at: max(a.at) }).from(a)
      .where(and(eq(a.action, 'auth.login'), eq(a.outcome, 'success'))).groupBy(a.actorUserId).all()
      .map((row) => [row.actor, row.at]));
    const methods = new Map<string, string[]>();
    for (const acc of db.select({ userId: schema.account.userId, provider: schema.account.providerId }).from(schema.account).all()) {
      const label = acc.provider === 'credential' ? s.users.password : acc.provider === OIDC_PROVIDER_ID ? (holder.snapshot().settings.oidc?.label ?? acc.provider) : acc.provider;
      methods.set(acc.userId, [...(methods.get(acc.userId) ?? []), label]);
    }
    const rows: UserRowView[] = users.map((u) => {
      const linked = linkedIcaAccount(db, u.id);
      // Status only: the badge is derived from the session row's expiry/error, never its (encrypted) contents.
      const web = linked && (linked.web ?? { expiresAt: null, lastOkAt: null, lastError: NO_WEB_SESSION });
      const ica = icaStatus(web);
      return {
        id: u.id, name: u.name, email: u.email, role: roleOf(u), disabled: Boolean(u.banned), isSelf: u.id === me,
        lastSignInAt: lastSignIn.get(u.id) ?? null, ica: { tone: ica.tone, label: ica.label }, signInMethods: [...new Set(methods.get(u.id) ?? [])],
        icaShared: Boolean(linked) && icaAccountSharedFor(db, u.id), emailUnconfirmed: isSelfChangedEmail(db, u.id),
      };
    });
    const invites: PendingInviteView[] = listPendingInvites(db).map((i) => ({
      id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt, shareable: shares.get(i.id) !== undefined,
    }));
    // A member group set: roles follow the IdP's groups at every sign-in (see auth/oidc-policy.ts), so say so here.
    const oidc = holder.snapshot().settings.oidc;
    res.type('html').send(usersPage(pageCtx(res), { users: rows, invites, ...(oidc?.memberGroup ? { groupRoles: { label: oidc.label } } : {}) }));
  });

  // ---- Invites (spec "Invites"). The link's token exists in plaintext only in `shares`, for 15 minutes. ----
  const INVITE_ERRORS = {
    invalid_email: 'invite_invalid_email', invalid_role: 'invite_invalid_role', already_user: 'invite_already_user', already_invited: 'invite_already_invited',
  } as const;
  const sharePath = (id: string): string => `${LIST}/invites/${encodeURIComponent(id)}`;

  r.post('/invites', (req, res) => {
    const see = res.locals.seeOther as SeeOther;
    const body = req.body as Record<string, unknown>;
    const role = body.role ?? 'member';
    try {
      if (!isRole(role)) throw new InviteError('invalid_role');
      const { invite, token } = createInvite(db, {
        email: typeof body.email === 'string' ? body.email : '', role, createdByUserId: (res.locals.session as AdminSession).user.id,
      });
      shares.put(invite.id, token);
      (res.locals.audit as BoundAudit)('user.invited', { target: { type: 'invite', id: invite.id }, details: { email: invite.email, role: invite.role } });
      see(res, sharePath(invite.id), { kind: 'success', code: 'invite_created', params: { email: invite.email } });
    } catch (err) {
      if (!(err instanceof InviteError)) throw err;
      see(res, LIST, { kind: 'error', code: INVITE_ERRORS[err.code] });
    }
  });

  r.get('/invites/:id', async (req, res) => {
    const invite = inviteById(db, String(req.params.id));
    const state = invite && inviteState(invite);
    if (!invite || state === 'accepted' || state === 'revoked') {
      res.status(404).type('html').send(errorPage(pageCtx(res), { status: 404, code: 'not_found' }));
      return;
    }
    const token = state === 'pending' ? shares.get(invite.id) : undefined;
    const link = token && `${config.publicUrl}/admin/invite/${token}`;
    const qrSvg = link ? await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : undefined;
    res.set('Cache-Control', 'no-store').type('html').send(inviteSharePage(pageCtx(res), {
      email: invite.email, role: invite.role, expiresAt: invite.expiresAt, inviteId: invite.id, ...(link ? { link, qrSvg } : {}),
    }));
  });

  r.post('/invites/:id/renew', (req, res) => {
    const see = res.locals.seeOther as SeeOther;
    let renewed: ReturnType<typeof renewInvite>;
    try {
      renewed = renewInvite(db, String(req.params.id));
    } catch (err) {
      if (!(err instanceof InviteError)) throw err;
      see(res, LIST, { kind: 'error', code: INVITE_ERRORS[err.code] });
      return;
    }
    if (!renewed) { see(res, LIST, { kind: 'error', code: 'invite_not_changed' }); return; }
    shares.put(renewed.invite.id, renewed.token);
    (res.locals.audit as BoundAudit)('user.invited', {
      target: { type: 'invite', id: renewed.invite.id }, details: { email: renewed.invite.email, role: renewed.invite.role, renewed: true },
    });
    see(res, sharePath(renewed.invite.id), { kind: 'success', code: 'invite_renewed' });
  });

  r.post('/invites/:id/revoke', (req, res) => {
    const see = res.locals.seeOther as SeeOther;
    const revoked = revokeInvite(db, String(req.params.id));
    shares.delete(String(req.params.id)); // the plaintext link goes with it, whatever the outcome
    if (!revoked) { see(res, LIST, { kind: 'error', code: 'invite_not_changed' }); return; }
    (res.locals.audit as BoundAudit)('user.invite_revoked', { target: { type: 'invite', id: revoked.id }, details: { email: revoked.email } });
    see(res, LIST, { kind: 'success', code: 'invite_revoked', params: { email: revoked.email } });
  });

  r.post('/:id/role', action(async ({ req, res, see, audit, me, target }) => {
    const role = (req.body as Record<string, unknown>).role;
    if (!isRole(role)) { see(res, LIST, { kind: 'error', code: 'user_not_changed' }); return; }
    const from = roleOf(target);
    if (from === role) { see(res, LIST); return; }
    if (from === 'admin' && leavesNoAdmin(db, target.id)) { see(res, LIST, { kind: 'error', code: 'last_admin' }); return; }
    const ok = await betterAuth('set-role', () => holder.current.api.setRole({ body: { userId: target.id, role }, ...authCallFor(config, req, '/admin/set-role') }));
    if (!ok) { see(res, LIST, { kind: 'error', code: 'user_not_changed' }); return; }
    audit('user.role_changed', { target: { type: 'user', id: target.id }, details: { from, to: role, via: 'admin' } });
    // Demoting yourself ends your access to this page: land on Home instead of a 403.
    see(res, target.id === me.id && role !== 'admin' ? '/admin' : LIST, { kind: 'success', code: 'role_changed', params: { name: nameOf(target), role } });
  }));

  r.post('/:id/disable', action(async ({ req, res, see, audit, me, target }) => {
    if (target.id === me.id) { see(res, LIST, { kind: 'error', code: 'cannot_disable_self' }); return; }
    if (target.banned) { see(res, LIST); return; }
    if (leavesNoAdmin(db, target.id)) { see(res, LIST, { kind: 'error', code: 'last_admin' }); return; }
    if (!confirmed(req)) { askFirst(res, 'disable', target); return; }
    // banUser also deletes the user's sessions; their Claude grants are revoked here.
    const ok = await betterAuth('ban-user', () => holder.current.api.banUser({ body: { userId: target.id, banReason: 'Disabled by an admin' }, ...authCallFor(config, req, '/admin/ban-user') }));
    if (!ok) { see(res, LIST, { kind: 'error', code: 'user_not_changed' }); return; }
    audit('user.disabled', { target: { type: 'user', id: target.id } });
    for (const clientId of revokeOAuthGrants(db, target.id)) {
      const clientName = db.select({ name: schema.oauthClient.name }).from(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId)).get()?.name ?? clientId;
      audit('oauth.client_revoked', { target: { type: 'oauth_client', id: clientId }, details: { clientName, reason: 'user_disabled' } });
    }
    see(res, LIST, { kind: 'success', code: 'user_disabled', params: { name: nameOf(target) } });
  }));

  r.post('/:id/enable', action(async ({ req, res, see, audit, target }) => {
    if (!target.banned) { see(res, LIST); return; }
    const ok = await betterAuth('unban-user', () => holder.current.api.unbanUser({ body: { userId: target.id }, ...authCallFor(config, req, '/admin/unban-user') }));
    if (!ok) { see(res, LIST, { kind: 'error', code: 'user_not_changed' }); return; }
    audit('user.enabled', { target: { type: 'user', id: target.id } });
    see(res, LIST, { kind: 'success', code: 'user_enabled', params: { name: nameOf(target) } });
  }));

  r.post('/:id/remove', action(async ({ req, res, see, audit, me, target }) => {
    if (target.id === me.id) { see(res, LIST, { kind: 'error', code: 'cannot_disable_self' }); return; }
    if (leavesNoAdmin(db, target.id)) { see(res, LIST, { kind: 'error', code: 'last_admin' }); return; }
    if (!confirmed(req)) { askFirst(res, 'remove', target); return; }
    // The intent is recorded before anything changes, so a crash part-way still leaves a trace; the outcome follows.
    audit('user.removed', { target: { type: 'user', id: target.id }, details: { email: target.email, stage: 'intent' } });
    // Claude grants and the ICA link go first (an ICA account shared with another profile stays), so a failed
    // removal still leaves nothing usable behind. Better Auth then deletes the sessions, accounts and the user; FKs
    // cascade the remaining consents, tokens and the profile.
    revokeOAuthGrants(db, target.id);
    disconnectIcaAccount(db, target.id);
    const ok = await betterAuth('remove-user', () => holder.current.api.removeUser({ body: { userId: target.id }, ...authCallFor(config, req, '/admin/remove-user') }));
    if (!ok) {
      // Grants and the ICA link are already gone at this point: say so, and that Remove can simply be retried.
      audit('user.removed', { target: { type: 'user', id: target.id }, outcome: 'failure', details: { email: target.email, stage: 'partial' } });
      see(res, LIST, { kind: 'error', code: 'user_partially_removed', params: { name: nameOf(target) } });
      return;
    }
    audit('user.removed', { target: { type: 'user', id: target.id }, details: { email: target.email, stage: 'done' } });
    see(res, LIST, { kind: 'success', code: 'user_removed', params: { name: nameOf(target) } });
  }));

  // ---- Account email (spec 1.6 "Account email"): set directly, nothing is sent. ----
  r.get('/:id/email', (req, res) => {
    const u = userById(String(req.params.id));
    if (!u) { res.status(404).type('html').send(errorPage(pageCtx(res), { status: 404, code: 'not_found' })); return; }
    // Your own email is changed on Profile (with your current password), as the POST below insists.
    if (u.id === (res.locals.session as AdminSession).user.id) { res.redirect(303, '/admin/profile#email'); return; }
    res.type('html').send(userEmailPage(pageCtx(res), { user: { id: u.id, name: u.name, email: u.email }, unconfirmed: isSelfChangedEmail(db, u.id) }));
  });

  /**
   * An admin's change is vouched for: it also clears a member's "self-changed" mark, so saving the same address again
   * confirms it for link-by-email. The admin's own email is changed on Profile, where the current password is asked
   * for; allowing it here would sidestep that check.
   */
  r.post('/:id/email', action(({ req, res, see, audit, me, target }) => {
    if (target.id === me.id) { see(res, '/admin/profile', { kind: 'info', code: 'email_use_profile' }); return; }
    const out = changeUserEmail(db, target.id, (req.body as Record<string, unknown>).email, { vouched: true });
    if (!out.ok) {
      if (out.error === 'user_missing') { see(res, LIST, { kind: 'error', code: 'user_not_changed' }); return; }
      see(res, `${LIST}/${encodeURIComponent(target.id)}/email`, { kind: out.error === 'email_unchanged' ? 'info' : 'error', code: out.error });
      return;
    }
    audit('user.email_changed', { target: { type: 'user', id: target.id }, details: { from: out.from, to: out.to } });
    see(res, LIST, { kind: 'success', code: out.confirmedOnly ? 'email_confirmed' : 'email_changed', params: { name: nameOf(target), email: out.to } });
  }));

  r.post('/:id/ica/disconnect', action(({ req, res, see, audit, target }) => {
    if (!linkedIcaAccount(db, target.id)) { see(res, LIST, { kind: 'info', code: 'ica_not_connected', params: { name: nameOf(target) } }); return; }
    if (!confirmed(req)) { askFirst(res, 'disconnect', target); return; }
    const done = disconnectIcaAccount(db, target.id);
    if (!done) { see(res, LIST, { kind: 'info', code: 'ica_not_connected', params: { name: nameOf(target) } }); return; }
    audit('ica.disconnected', { target: { type: 'user', id: target.id }, details: { by: 'admin', mode: done.mode } });
    see(res, LIST, { kind: 'success', code: done.mode === 'unlinked' ? 'ica_unlinked' : 'ica_disconnected', params: { name: nameOf(target) } });
  }));

  return r;
}
