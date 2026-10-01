import { Router, urlencoded, type Request, type Response } from 'express';
import { APIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import type { AppDeps } from '../server.js';
import { OIDC_PROVIDER_ID } from '../auth/index.js';
import { roleOf } from '../auth/roles.js';
import { schema } from '../db/index.js';
import { consentPage, errorPage, homePage, loginPage, type LoginErrorCode } from './views/index.js';
import { OIDC_ERROR_CODES, oidcErrorUrl, type OidcErrorCode } from '../auth/oidc-policy.js';
import { isTheme, pageCtx, pageLocals, THEME_COOKIE } from './page-ctx.js';
import { forwardAuthResponse, loadSession, requireAdmin, requireSession, type AdminSession } from './session.js';
import { requireSameOrigin } from './origin.js';
import { createCsrf } from './csrf.js';
import { backPath, createFlash, createSeeOther } from './flash.js';
import { authCall as authCallFor } from './auth-call.js';
import { createLoginLimiter } from './rate-limit.js';
import type { Logger } from '../logger.js';
import { DEFAULT_ICA_ENDPOINTS } from '../ica/endpoints.js';
import { createEnrolments } from '../sessions/enrolment.js';
import { linkedIcaAccount } from '../sessions/web-store.js';
import { allowFormAction, formActionSourceFor } from './security-headers.js';
import { appStatus, icaStatus, NO_WEB_SESSION } from './views/status.js';
import { icaRouter } from './ica-routes.js';
import { activityRouter } from './activity-routes.js';
import { usersRouter } from './users-routes.js';
import { inviteRouter } from './invite-routes.js';
import { profileRouter } from './profile-routes.js';
import { appsRouter } from './apps-routes.js';
import { settingsRouter } from './settings-routes.js';
import { setupGate, setupRouter } from './setup-routes.js';
import type { SessionKeeper } from '../sessions/keeper.js';
import { listConnectedApps } from '../users/grants.js';
import { createInviteShares } from '../users/invites.js';
import { bindAudit, type BoundAudit } from '../audit.js';

const rawQuery = (url: string): string => url.split('?')[1] ?? '';
/** A client's registered redirect URIs. Better Auth stores the JSON array as a string inside the json column, so the
 * value can arrive as an array or as a JSON string; anything else counts as none. */
const redirectUrisOf = (v: unknown): string[] => {
  let x = v;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return []; } }
  return Array.isArray(x) ? x.filter((u): u is string => typeof u === 'string') : [];
};
/** The typed email as Better Auth stores it (trimmed, lowercased), for the user lookup and the audit details. */
const normalEmail = (email: unknown): string => (typeof email === 'string' ? email.trim().toLowerCase() : '');
/** Whether a Better Auth response started a session: it set a non-empty `…session_token` cookie. */
const setsSession = (r: globalThis.Response): boolean => r.headers.getSetCookie().some((c) => /^(?:__Secure-)?[\w.-]*session_token=[^;]+/.test(c));
const auditOf = (res: Response): BoundAudit => res.locals.audit as BoundAudit;
/** A failed sign-in's status as one of the login page's fixed error codes. */
const errorCode = (status: number): LoginErrorCode => (status === 401 ? 'credentials' : status === 429 ? 'rate' : 'failed');
/** Only local admin paths are accepted as a post-login destination (no open redirect). */
const safeNext = (next: string | undefined): string => (next && /^\/admin(?:[/?]|$)/.test(next) ? next : '/admin');
/** Where the authorization code will go, as shown on the consent page: the redirect URI's host (or the whole URI for custom schemes). */
const redirectHostOf = (redirectUri: string | null): string => {
  if (!redirectUri) return 'unknown';
  try { const u = new URL(redirectUri); return u.host || u.href; } catch { return 'invalid redirect URI'; }
};

export function adminRouter(deps: AppDeps, log: Logger, keeper: SessionKeeper): Router {
  // `config` is the environment's (public URL, secrets, proxy); the sign-in settings in force (OIDC, password login) and
  // the Better Auth instance come from the holder's snapshot, read once per request so a request sees one instance.
  const { auth: holder, config, db } = deps;
  /** The login page's OIDC error: a known code (lowercased, e.g. `BANNED_USER`) or `failed`; the email only for `not_invited`. */
  const oidcErrorOf = (raw: string | undefined, description: string | null): { code: OidcErrorCode; email?: string } => {
    const lower = (raw ?? '').toLowerCase();
    const code = (OIDC_ERROR_CODES as readonly string[]).includes(lower) ? (lower as OidcErrorCode) : 'failed';
    const email = code === 'not_invited' && description ? deps.oidcRejections.take(description) : undefined;
    return email ? { code, email } : { code };
  };
  /**
   * The OAuth client named by an authorize query, and its redirect_uri only when that exact string is one of the
   * client's registered redirect URIs. The query's signature is only checked by Better Auth on the POST, so the page
   * GETs must not trust the query: an unknown client or unregistered URI adds nothing to form-action.
   */
  const oauthClientOf = (params: URLSearchParams): { name: string | null; registeredRedirect: string | undefined } | undefined => {
    const clientId = params.get('client_id');
    if (!clientId) return undefined;
    const c = db.select({ name: schema.oauthClient.name, redirectUris: schema.oauthClient.redirectUris }).from(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId)).get();
    if (!c) return undefined;
    const uri = params.get('redirect_uri');
    const registered = uri !== null && redirectUrisOf(c.redirectUris).includes(uri);
    return { name: c.name, registeredRedirect: registered ? uri : undefined };
  };
  // Direct auth.api calls bypass Better Auth's own rate limiter, so login attempts are limited here (per IP and per email).
  const loginLimit = createLoginLimiter({
    log,
    // Runs on the router before the route, so `bindAudit` has set `res.locals.audit` for this request. Only the first
    // 429 per limited key per window gets here (see createLoginLimiter), so a flood cannot fill the audit log.
    onLimited: (req) => {
      const email = normalEmail((req.body as Record<string, unknown> | undefined)?.email);
      auditOf(req.res!)('auth.login_failed', {
        actorUserId: null, outcome: 'failure',
        details: { method: req.path === '/login/oidc' ? 'oidc' : 'local', reason: 'rate', ...(email ? { email } : {}) },
      });
    },
  }).middleware;
  const authCall = (req: Request, path: string) => authCallFor(config, req, path);
  const secure = config.publicUrl.startsWith('https:');
  const flash = createFlash({ secret: config.authSecret, secure });
  const seeOther = createSeeOther(flash);
  // A rejected token changes nothing: an HTML form goes back where it came from with the `csrf` flash, others get 403.
  const csrf = createCsrf({ secret: config.authSecret, secure, onReject: (req, res) => {
    if ((req.headers.accept ?? '').includes('text/html')) seeOther(res, backPath(req), { kind: 'error', code: 'csrf' });
    else res.status(403).type('text/plain').send('invalid CSRF token');
  } });
  const r = Router();
  r.use(urlencoded({ extended: false, limit: '16kb' }));
  r.use(loadSession(holder));
  r.use(bindAudit(deps.audit));
  r.use(requireSameOrigin(config.publicUrl)); // fail-closed for every state-changing request (Better Auth checks its own)
  r.use(csrf.issue);
  r.use(csrf.verify);
  r.use(flash.read);
  r.use(pageLocals());
  r.use((_req, res, next) => { res.locals.seeOther = seeOther; next(); });
  // First-run setup: while no user exists every admin page leads to /admin/setup (other POSTs are 404); afterwards
  // the gate is a no-op and /admin/setup is 404. After the security middleware above, so it covers the setup POSTs.
  r.use(setupGate(deps.setup));
  r.use('/setup', setupRouter({ db, config, holder, setup: deps.setup, cipher: deps.cipher, log }));

  r.get('/login', (req, res) => {
    holder.retryIfUnreachable();
    const { config: eff } = holder.snapshot();
    // Our own `error`/`next` params (and Better Auth's `error_description`) must not reach Better Auth: the signed
    // oauth query is verified param by param.
    const params = new URLSearchParams(rawQuery(req.originalUrl));
    const errs = params.getAll('error');
    const next = params.get('next') ?? undefined;
    // A failed OIDC sign-in comes back as `error=oidc` (ours) then `error=<code>` (Better Auth's). Only a known code
    // picks a fixed message; the email comes from the server-side reference, never from the query.
    const oidcError = errs[0] === 'oidc' ? oidcErrorOf(errs[1], params.get('error_description')) : undefined;
    const error = oidcError ? undefined : errs[0];
    const extra = errs.length > 0 || params.has('error_description') || next !== undefined;
    params.delete('error'); params.delete('error_description'); params.delete('next');
    const oauthQuery = params.has('sig') ? (extra ? params.toString() : rawQuery(req.originalUrl)) : '';
    // The sign-in POST may redirect straight on to the OAuth client (consent already given), and the OIDC button's POST
    // redirects to the IdP: Chromium checks form-action on those redirects, so both origins are allowed here — the
    // client's only when the redirect_uri is one it registered.
    const client = oauthQuery ? oauthClientOf(new URLSearchParams(oauthQuery)) : undefined;
    const sources = [
      formActionSourceFor(client?.registeredRedirect), eff.oidc && new URL(eff.oidc.issuerUrl).origin,
    ].filter((x): x is string => Boolean(x));
    if (sources.length) allowFormAction(res, sources);
    res.type('html').send(loginPage(pageCtx(res), {
      oauthQuery, oidcLabel: eff.oidc?.label, localLogin: eff.localLogin, error, oidcError, next: oauthQuery ? undefined : next,
      continuingApp: Boolean(client),
    }));
  });

  r.post('/login', loginLimit, async (req, res) => {
    const { email, password, oauth_query, next } = req.body as Record<string, string | undefined>;
    const { auth, config: eff } = holder.snapshot();
    // Password login off: no password reaches Better Auth (the form is not shown either).
    if (!eff.localLogin) {
      auditOf(res)('auth.login_failed', { actorUserId: null, outcome: 'failure', details: { method: 'local', reason: 'local_disabled', email: normalEmail(email) } });
      res.status(403).type('html').send(errorPage(pageCtx(res), { status: 403, code: 'local_login_disabled' }));
      return;
    }
    const retry = (error: LoginErrorCode) => {
      const q = new URLSearchParams(oauth_query ?? '');
      if (!oauth_query && next) q.set('next', safeNext(next));
      q.set('error', error);
      res.redirect(302, `/admin/login?${q}`);
    };
    const loginFailed = (reason: LoginErrorCode) => {
      auditOf(res)('auth.login_failed', { actorUserId: null, outcome: 'failure', details: { method: 'local', reason, email: normalEmail(email) } });
    };
    try {
      const response = await auth.api.signInEmail({
        body: { email: email ?? '', password: password ?? '', ...(oauth_query ? { oauth_query } : {}) },
        ...authCall(req, '/sign-in/email'),
      });
      if (setsSession(response)) {
        const id = db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, normalEmail(email))).get()?.id ?? null;
        auditOf(res)('auth.login', { actorUserId: id, ...(id ? { target: { type: 'user' as const, id } } : {}), details: { method: 'local' } });
      } else loginFailed(errorCode(response.status));
      if (!response.ok && !response.headers.get('location')) { retry(errorCode(response.status)); return; }
      await forwardAuthResponse(res, response, safeNext(next));
    } catch (e) {
      const code = errorCode(e instanceof APIError ? e.statusCode : 500);
      loginFailed(code);
      retry(code);
    }
  });

  r.post('/login/oidc', loginLimit, async (req, res) => {
    const { oauth_query } = req.body as Record<string, string | undefined>;
    const { auth } = holder.snapshot();
    // Generic OAuth providers are ordinary social providers in Better Auth 1.7 (`/sign-in/social`); the oauth-provider
    // plugin picks `oauth_query` up from that request's body and resumes the authorize flow after the callback.
    // `requestSignUp`: an invited email may be created here too (rule b); validateUserInfo refuses anyone without an invite.
    const response = await auth.api.signInSocial({
      body: {
        provider: OIDC_PROVIDER_ID, callbackURL: '/admin', errorCallbackURL: oidcErrorUrl(oauth_query ?? ''), requestSignUp: true,
        ...(oauth_query ? { oauth_query } : {}),
      },
      ...authCall(req, '/sign-in/social'),
    });
    // Answers { url, redirect: true } plus a Location header and the state cookie; forward as a 302 to the IdP.
    await forwardAuthResponse(res, response, '/admin/login');
  });

  r.get('/consent', requireSession(holder), (req, res) => {
    const oauthQuery = rawQuery(req.originalUrl);
    const params = new URLSearchParams(oauthQuery);
    const clientId = params.get('client_id') ?? '';
    const client = oauthClientOf(params);
    // Allow redirects the consent POST to the client's redirect_uri: allowed only when it is a registered one.
    const dest = formActionSourceFor(client?.registeredRedirect);
    if (dest) allowFormAction(res, [dest]);
    // The client name is self-chosen (open DCR), so also show where the code goes. redirect_uri is part of the signed
    // query: a tampered value here fails signature verification on the consent POST.
    res.type('html').send(consentPage(pageCtx(res), {
      clientName: client?.name ?? clientId, scopes: (params.get('scope') ?? '').split(' ').filter(Boolean), oauthQuery,
      redirectHost: redirectHostOf(params.get('redirect_uri')), verified: config.trustedClientIds.includes(clientId),
    }));
  });

  r.post('/consent', requireSession(holder), async (req, res) => {
    const { accept, oauth_query } = req.body as Record<string, string | undefined>;
    const response = await holder.current.api.oauth2Consent({ body: { accept: accept === 'yes', oauth_query: oauth_query ?? '' }, ...authCall(req, '/oauth2/consent') });
    // Better Auth verified the signed query when it answers with a redirect (JSON `{ redirect, url }` or a Location),
    // so the client and scopes read from it are the ones decided on. A tampered query is an error and records nothing.
    if (response.ok || response.headers.has('location')) {
      const params = new URLSearchParams(oauth_query ?? '');
      const clientId = params.get('client_id') ?? '';
      const clientName = oauthClientOf(params)?.name ?? clientId;
      const scopes = (params.get('scope') ?? '').split(' ').filter(Boolean);
      auditOf(res)(accept === 'yes' ? 'oauth.consent_granted' : 'oauth.consent_denied', {
        target: { type: 'oauth_client', id: clientId }, details: { clientName, scopes },
      });
    }
    await forwardAuthResponse(res, response, '/admin');
  });

  const { cipher } = deps;
  const endpoints = deps.icaEndpoints ?? DEFAULT_ICA_ENDPOINTS;
  r.use('/ica', icaRouter({ auth: holder, db, cipher, endpoints, enrolments: createEnrolments({ db, cipher, endpoints, appDcrSecret: config.icaAppDcrClientSecret, log }), log, keeper }));

  // The invite links' plaintext, in memory for 15 minutes after they are made (copy / QR on the share page).
  const shares = createInviteShares();
  r.use('/users', requireSession(holder), requireAdmin, usersRouter({ auth: holder, db, config, log, shares }));
  // No requireSession: the invitee has no account yet. The router-level origin/CSRF checks above still apply.
  r.use('/invite', inviteRouter({ auth: holder, db, config, log }));
  r.use('/activity', requireSession(holder), requireAdmin, activityRouter({ db }));
  r.use('/profile', requireSession(holder), profileRouter({ auth: holder, db, config }));
  r.use('/apps', requireSession(holder), appsRouter({ db, config }));
  r.use('/settings', requireSession(holder), requireAdmin, settingsRouter({ db, config, cipher, holder, log, fetchLimit: deps.settingsFetchLimit }));

  r.get('/', requireSession(holder), (_req, res) => {
    const { user } = res.locals.session as AdminSession;
    const userId = user.id;
    const linked = linkedIcaAccount(db, userId);
    // An account linked without a stored web session needs a reconnect, like an expired one.
    const web = linked && (linked.web ?? { expiresAt: null, lastOkAt: null, lastError: NO_WEB_SESSION });
    // Claude is "connected" through the apps this user allowed: the same live consents the Connected apps page lists.
    const apps = listConnectedApps(db, userId);
    const lastUsedAt = apps.reduce<string | null>((m, a) => (a.lastUsedAt && (!m || a.lastUsedAt > m) ? a.lastUsedAt : m), null);
    res.type('html').send(homePage(pageCtx(res), {
      ica: { web: icaStatus(web), app: appStatus(linked?.app) }, claude: { connected: apps.length, lastUsedAt }, mcpUrl: config.mcpResource,
      // Admins see why sign-in does not work as configured (e.g. the IdP was unreachable at start).
      ...(roleOf(user) === 'admin' ? { settingsProblems: holder.snapshot().settings.problems } : {}),
    }));
  });

  /** The theme preference (the form is on Profile): a cookie only, not an audited account setting. */
  r.post('/theme', (req, res) => {
    const { theme, next } = req.body as Record<string, string | undefined>;
    if (!isTheme(theme)) { res.status(400).type('text/plain').send('invalid theme'); return; }
    res.cookie(THEME_COOKIE, theme, { path: '/admin', maxAge: 31_536_000_000, sameSite: 'lax', httpOnly: true, secure });
    seeOther(res, safeNext(next), { kind: 'success', code: 'theme_saved' });
  });

  r.post('/logout', async (req, res) => {
    // Recorded first, while the session (the actor) is still known; signing out without one is a no-op.
    if (res.locals.session) auditOf(res)('auth.logout');
    const response = await holder.current.api.signOut(authCall(req, '/sign-out'));
    if (response.ok) flash.set(res, { kind: 'info', code: 'signed_out' });
    await forwardAuthResponse(res, response, '/admin/login');
  });
  return r;
}
