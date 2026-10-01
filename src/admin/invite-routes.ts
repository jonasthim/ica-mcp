import { Router, type Request, type Response } from 'express';
import { APIError } from 'better-auth/api';
import { OIDC_PROVIDER_ID } from '../auth/index.js';
import type { AuthHolder } from '../auth/holder.js';
import { oidcErrorUrl } from '../auth/oidc-policy.js';
import type { BoundAudit } from '../audit.js';
import type { Config } from '../config.js';
import { schema, type Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import { claimInvite, findInviteByToken, releaseInvite, setInviteUser, type InviteRow } from '../users/invites.js';
import { authCall as authCallFor } from './auth-call.js';
import type { SeeOther } from './flash.js';
import { pageCtx } from './page-ctx.js';
import { createLoginLimiter } from './rate-limit.js';
import { validateDisplayName } from './display-name.js';
import { forwardAuthResponse, type AdminSession } from './session.js';
import { errorPage, invitePage, type InviteView } from './views/index.js';
import { allowFormAction } from './security-headers.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;

/**
 * /admin/invite/:token — the invite link. Mounted inside the admin router (same-origin check, CSRF, flash) but without
 * `requireSession`: the invitee has no account yet. Every token that is not a pending invite (unknown, used, revoked,
 * expired) gets the same 410 page, so the link says nothing about why. A browser already signed in as someone else is
 * never used to accept: it must sign out first, so the invite cannot land on the wrong account (e.g. the partner
 * opening the link on the admin's phone).
 */
export function inviteRouter(deps: { auth: AuthHolder; db: Db; config: Config; log: Pick<Logger, 'warn'> }): Router {
  const { auth: holder, db, config, log } = deps;
  // Own budget (per IP) for both ways to accept: it does not spend the sign-in form's attempts.
  const limiter = createLoginLimiter({
    log,
    // Runs before the route, after `bindAudit`: the first refused attempt per window is recorded, without the (unverified) token's invite.
    onLimited: (req) => {
      (req.res!.locals.audit as BoundAudit)('user.invite_accepted', { actorUserId: null, outcome: 'failure', details: { method: req.path.endsWith('/oidc') ? 'oidc' : 'local', reason: 'rate' } });
    },
  }).middleware;
  // Password login off: no password form and no password acceptance; the OIDC button (when configured) remains. Read
  // per request from the holder, so a settings save applies to invite pages at once.
  const signIn = () => {
    const { auth, config: eff } = holder.snapshot();
    return { auth, localLogin: eff.localLogin, oidc: eff.oidc, oidcLabel: eff.oidc?.label, oidcOrigin: eff.oidc && new URL(eff.oidc.issuerUrl).origin };
  };
  const r = Router();

  const session = (res: Response): AdminSession | null => (res.locals.session as AdminSession | null | undefined) ?? null;
  const render = (res: Response, v: InviteView, status = 200): void => {
    // The URL carries the token: never cache the page, and send only the origin as a Referer. Not `no-referrer`: with it,
    // browsers send `Origin: null` on this page's form POSTs, which the same-origin check (rightly) refuses.
    res.status(status).set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin' }).type('html').send(invitePage(pageCtx(res), v));
  };
  const gone = (res: Response): void => { render(res, { state: 'gone' }, 410); };
  /** The pending invite for the route's token, or undefined (malformed, unknown, used, revoked or expired alike). */
  const pendingFor = (req: Request): { invite: InviteRow; token: string } | undefined => {
    const token = String(req.params.token);
    if (!TOKEN.test(token)) return undefined;
    const found = findInviteByToken(db, token);
    return found?.state === 'pending' ? { invite: found.invite, token } : undefined;
  };
  const back = (token: string): string => `/admin/invite/${token}`;

  r.get('/:token', (req, res) => {
    holder.retryIfUnreachable(); // an invitee may be the first to open a sign-in page after the IdP came back
    const p = pendingFor(req);
    if (!p) { gone(res); return; }
    const s = session(res);
    if (s && s.user.email.toLowerCase() === p.invite.email) { render(res, { state: 'same-user', email: s.user.email }); return; }
    if (s) { render(res, { state: 'other-user', email: p.invite.email, signedInAs: s.user.email, token: p.token }); return; }
    const { localLogin, oidcLabel, oidcOrigin } = signIn();
    // The OIDC button's POST redirects to the IdP: Chromium checks form-action on that redirect.
    if (oidcOrigin) allowFormAction(res, [oidcOrigin]);
    render(res, { state: 'accept', email: p.invite.email, token: p.token, localLogin, ...(oidcLabel ? { oidcLabel } : {}) });
  });

  /**
   * Accept with the IdP: an ordinary OIDC sign-in that may create the account (rule b). The invite is claimed by the
   * callback (oidc-policy.ts) for the email the IdP verifies — matched case-insensitively, whatever the button — so
   * this route only checks the link is live, refuses a signed-in browser, and hints the invited email to the IdP.
   */
  r.post('/:token/oidc', limiter, async (req, res) => {
    const p = pendingFor(req);
    const { auth, oidc } = signIn();
    if (!p || !oidc) { gone(res); return; }
    if (session(res)) { (res.locals.seeOther as SeeOther)(res, back(p.token)); return; }
    const response = await auth.api.signInSocial({
      body: {
        provider: OIDC_PROVIDER_ID, callbackURL: '/admin', errorCallbackURL: oidcErrorUrl(''), requestSignUp: true, loginHint: p.invite.email,
      },
      ...authCallFor(config, req, '/sign-in/social'),
    });
    await forwardAuthResponse(res, response, back(p.token));
  });

  r.post('/:token/accept', limiter, async (req, res) => {
    const see = res.locals.seeOther as SeeOther;
    const audit = res.locals.audit as BoundAudit;
    const p = pendingFor(req);
    if (!p) { gone(res); return; }
    const { auth, localLogin } = signIn();
    // Signed in (as anyone): nothing happens here; the GET explains what to do.
    if (!localLogin) { res.status(403).type('html').send(errorPage(pageCtx(res), { status: 403, code: 'local_login_disabled' })); return; }
    if (session(res)) { see(res, back(p.token)); return; }
    const body = req.body as Record<string, unknown>;
    const name = validateDisplayName(body.name);
    const password = typeof body.password === 'string' ? body.password : '';
    const confirm = typeof body.confirm === 'string' ? body.confirm : '';
    if (name === undefined) { see(res, back(p.token), { kind: 'error', code: 'invite_name' }); return; }
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) { see(res, back(p.token), { kind: 'error', code: 'invite_password' }); return; }
    if (password !== confirm) { see(res, back(p.token), { kind: 'error', code: 'invite_mismatch' }); return; }

    // Single use: of two concurrent accepts only one claims the row; the other sees a used link.
    const { invite } = p;
    if (!claimInvite(db, invite.id, null)) { gone(res); return; }
    let userId: string;
    try {
      userId = (await auth.api.createUser({ body: { email: invite.email, password, name, role: invite.role } })).user.id;
    } catch (err) {
      releaseInvite(db, invite.id);
      log.warn({ status: err instanceof APIError ? err.statusCode : undefined, err: { name: err instanceof Error ? err.name : 'unknown' } }, 'invite acceptance: user creation failed');
      see(res, back(p.token), { kind: 'error', code: 'invite_failed' });
      return;
    }
    setInviteUser(db, invite.id, userId);
    db.insert(schema.userProfile).values({ userId, createdAt: new Date().toISOString() }).onConflictDoNothing().run();
    audit('user.invite_accepted', {
      actorUserId: userId, target: { type: 'invite', id: invite.id }, details: { email: invite.email, role: invite.role, method: 'local' },
    });

    // Sign the new member in. The account exists either way: a failed sign-in just sends them to the sign-in page.
    try {
      const response = await auth.api.signInEmail({ body: { email: invite.email, password }, ...authCallFor(config, req, '/sign-in/email') });
      if (response.ok) {
        for (const c of response.headers.getSetCookie()) res.append('Set-Cookie', c);
        audit('auth.login', { actorUserId: userId, target: { type: 'user', id: userId }, details: { method: 'local' } });
        see(res, '/admin', { kind: 'success', code: 'welcome', params: { name } });
        return;
      }
      log.warn({ status: response.status }, 'invite acceptance: sign-in refused');
    } catch (err) {
      log.warn({ status: err instanceof APIError ? err.statusCode : undefined }, 'invite acceptance: sign-in failed');
    }
    see(res, '/admin/login', { kind: 'success', code: 'welcome', params: { name } });
  });

  r.post('/:token/switch', async (req, res) => {
    const token = String(req.params.token);
    const target = TOKEN.test(token) ? back(token) : '/admin/login';
    if (!session(res)) { (res.locals.seeOther as SeeOther)(res, target); return; }
    (res.locals.audit as BoundAudit)('auth.logout');
    const response = await holder.current.api.signOut(authCallFor(config, req, '/sign-out'));
    await forwardAuthResponse(res, response, target);
  });

  return r;
}
