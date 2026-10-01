import { Router, type RequestHandler, type Response } from 'express';
import type { AuthHolder, AuthSnapshot } from '../auth/holder.js';
import { OIDC_PROVIDER_ID } from '../auth/constants.js';
import { OIDC_ERROR_CODES, type OidcErrorCode } from '../auth/oidc-policy.js';
import { normaliseNewEmail } from '../users/email.js';
import type { BoundAudit } from '../audit.js';
import type { Config } from '../config.js';
import type { Cipher } from '../crypto.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import { adminAccess } from '../settings/guards.js';
import { checkOidcIssuer, type OidcReport } from '../settings/oidc-check.js';
import { oversizedField, parseOidcForm, saveOidc } from '../settings/service.js';
import type { Setup } from '../setup/state.js';
import { insertFirstAdmin } from '../users/first-admin.js';
import { authCall } from './auth-call.js';
import { validateDisplayName } from './display-name.js';
import type { FlashCode, SeeOther } from './flash.js';
import { pageCtx } from './page-ctx.js';
import { createLoginLimiter } from './rate-limit.js';
import { allowFormAction } from './security-headers.js';
import { forwardAuthResponse } from './session.js';
import { buildSettingsView, draftOf, envManagedPost, isStale, SETTINGS_FETCH_LIMIT, storedView, type StoredView } from './settings-routes.js';
import { errorPage, setupPage, type OidcFieldsView, type SetupSsoView } from './views/index.js';

const HERE = '/admin/setup';
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
const RESULT_MS = 10 * 60_000;
const notFound: RequestHandler = (_req, res) => { res.status(404).type('html').send(errorPage(pageCtx(res), { status: 404, code: 'not_found' })); };

/**
 * While no user exists every admin page leads to setup; once one exists it only expires a leftover setup cookie (and
 * /admin/setup is 404). The path check ignores case, like Express routing: /admin/Setup/code reaches the setup router.
 */
export function setupGate(setup: Setup): RequestHandler {
  return (req, res, next) => {
    if (!setup.isOpen()) {
      if (/(?:^|;\s*)ica-hub\.setup=/.test(req.headers.cookie ?? '')) res.append('Set-Cookie', setup.clearCookie());
      next(); return;
    }
    const path = req.path.toLowerCase();
    if (path === '/setup' || path.startsWith('/setup/')) { next(); return; }
    if (req.method === 'GET' || req.method === 'HEAD') { res.redirect(302, HERE); return; }
    notFound(req, res, next);
  };
}

/** A failed sign-in comes back as `error=oidc` (ours) then `error=<code>` (Better Auth's): only a known code is shown. */
function oidcErrorOf(originalUrl: string): OidcErrorCode | undefined {
  const errs = new URLSearchParams(originalUrl.split('?')[1] ?? '').getAll('error');
  const raw = (errs[1] ?? '').toLowerCase();
  return errs[0] !== 'oidc' ? undefined : (OIDC_ERROR_CODES as readonly string[]).includes(raw) ? (raw as OidcErrorCode) : 'failed';
}

/** The form as typed (never the secret), and the last connection test, per setup session. */
type Draft = Omit<OidcFieldsView, 'secret'>;
type LastResult = { at: number; issuerUrl: string; report: OidcReport; draft: Draft };

/**
 * The setup SSO step's view: the Settings page's single sign-on view (same fields, env handling and last test), minus
 * everything about admins, which do not exist yet. `ready` when the provider is configured and loaded.
 */
export function ssoFormView(config: Config, snap: AuthSnapshot, stored: StoredView, last: LastResult | undefined, db: Db): Omit<SetupSsoView, 'oidcError'> {
  const v = buildSettingsView(config, snap, stored, last, adminAccess(db));
  return {
    step: 'sso', managed: v.oidc.managed, fields: v.oidc.fields, switchesEnv: v.oidc.switchesEnv, hasLinks: v.oidc.hasLinks, callbackUrl: v.callbackUrl,
    ...(v.check ? { check: v.check } : {}), ...(snap.config.oidc ? { ready: { label: snap.config.oidc.label } } : {}),
  };
}

/**
 * /admin/setup — first-run setup (spec 1.6). Mounted inside the admin router, so the same-origin check, the (pre-session)
 * CSRF token, the security headers and the audit binding apply. Everything here is 404 once any user exists.
 * The setup code is never audited or logged: a wrong one is `auth.login_failed {method:'setup', reason:'credentials'}`.
 */
export function setupRouter(deps: {
  db: Db; config: Config; holder: AuthHolder; setup: Setup; cipher: Cipher; log: Pick<Logger, 'warn'>; check?: typeof checkOidcIssuer;
}): Router {
  const { db, config, holder, setup, log } = deps;
  // Per IP like the sign-in form, plus an overall cap: the code is guessed against from many IPs at once, too.
  const perIp = createLoginLimiter({ max: 10 });
  const overall = createLoginLimiter({ max: 50 });
  const r = Router();
  r.use((req, res, next) => { if (!setup.isOpen()) { notFound(req, res, next); return; } res.set('Cache-Control', 'no-store'); next(); });

  /**
   * First run with OIDC and an admin group in env: the identity provider's admin group vouches for the first admin, so
   * "Continue with <label>" needs no setup code (the policy creates only an admin-group user while the table is empty,
   * see oidc-policy.ts). Only while that provider is loaded; a UI-managed connection always goes through the code.
   */
  const groupStart = (snap: AuthSnapshot): { label: string; origin: string } | undefined => {
    const o = snap.config.oidc;
    return snap.settings.source.oidc === 'env' && o?.adminGroup ? { label: o.label, origin: new URL(o.issuerUrl).origin } : undefined;
  };

  r.get('/', (req, res) => {
    holder.retryIfUnreachable();
    const snap = holder.snapshot();
    const source = snap.settings.source.oidc;
    const sso = { label: snap.settings.oidc?.label, managed: source === 'default' ? 'none' as const : source === 'env' ? 'env' as const : 'ui' as const, ready: Boolean(snap.config.oidc) };
    const choose = { step: 'choose' as const, sso, localLogin: snap.config.localLogin };
    const group = groupStart(snap);
    // "Continue" redirects to the IdP: Chromium checks form-action on that redirect.
    if (group) allowFormAction(res, [group.origin]);
    const code = oidcErrorOf(req.originalUrl);
    const view = setup.hasSession(req.headers.cookie) ? choose : { step: 'code' as const };
    res.type('html').send(setupPage(pageCtx(res), { ...view, ...(group ? { groupStart: { label: group.label } } : {}), ...(code ? { oidcError: { code } } : {}) }));
  });

  // Rate-limited per IP like the sign-in button; the router's same-origin and CSRF checks apply.
  const groupLimit = createLoginLimiter({ max: 10 });
  r.post('/group', async (req, res, next) => {
    const snap = holder.snapshot();
    if (!groupStart(snap)) { notFound(req, res, next); return; }
    if (!groupLimit.attempt([`ip:${req.ip ?? 'unknown'}`]).ok) { (res.locals.seeOther as SeeOther)(res, HERE, { kind: 'error', code: 'setup_rate' }); return; }
    // requestSignUp: the first admin is created at the callback, and only from the admin group (see oidc-policy).
    const response = await snap.auth.api.signInSocial({
      body: { provider: OIDC_PROVIDER_ID, callbackURL: '/admin', errorCallbackURL: `${HERE}?error=oidc`, requestSignUp: true },
      ...authCall(config, req, '/sign-in/social'),
    });
    await forwardAuthResponse(res, response, HERE);
  });

  r.post('/code', (req, res) => {
    const see = res.locals.seeOther as SeeOther; const audit = res.locals.audit as BoundAudit;
    // The overall budget only counts attempts a single IP's own limit let through, so one client cannot spend it all.
    const ipLimit = perIp.attempt([`ip:${req.ip ?? 'unknown'}`]);
    const limited = ipLimit.ok ? overall.attempt(['setup']) : ipLimit;
    if (!limited.ok) {
      if (limited.firstRejection) audit('auth.login_failed', { actorUserId: null, outcome: 'failure', details: { method: 'setup', reason: 'rate' } });
      see(res, HERE, { kind: 'error', code: 'setup_rate' }); return;
    }
    if (!setup.checkCode((req.body as Record<string, unknown>).code)) {
      audit('auth.login_failed', { actorUserId: null, outcome: 'failure', details: { method: 'setup', reason: 'credentials' } });
      see(res, HERE, { kind: 'error', code: 'setup_code_wrong' }); return;
    }
    res.append('Set-Cookie', setup.startSession());
    see(res, HERE);
  });

  r.post('/admin', async (req, res, next) => {
    const see = res.locals.seeOther as SeeOther; const audit = res.locals.audit as BoundAudit;
    if (!setup.hasSession(req.headers.cookie)) { see(res, HERE, { kind: 'error', code: 'setup_expired' }); return; }
    // Password sign-in is off (env AUTH_LOCAL_LOGIN=false, or a leftover UI password-off row while SSO works): creating a password
    // admin here would leave them unable to ever sign in — the choose step already hides this option for the same
    // reason, so a POST reaching this line is a stale page or a crafted request.
    if (!holder.snapshot().config.localLogin) { see(res, HERE, { kind: 'error', code: 'setup_password_disabled' }); return; }
    const body = req.body as Record<string, unknown>;
    const str = (k: string): string => (typeof body[k] === 'string' ? body[k] : '');
    // Stored as Better Auth stores emails (trimmed, lowercased); the raw input must not change under case folding.
    const email = normaliseNewEmail(body.email);
    if (email === undefined) { see(res, HERE, { kind: 'error', code: 'setup_email' }); return; }
    const name = validateDisplayName(body.name);
    if (name === undefined) { see(res, HERE, { kind: 'error', code: 'invite_name' }); return; }
    const [password, confirm] = [str('password'), str('confirm')];
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) { see(res, HERE, { kind: 'error', code: 'invite_password' }); return; }
    if (password !== confirm) { see(res, HERE, { kind: 'error', code: 'invite_mismatch' }); return; }
    const { auth } = holder.snapshot();
    const passwordHash = await (await auth.$context).password.hash(password);
    // Atomic (BEGIN IMMEDIATE): of two concurrent submits only one inserts; null means someone else finished setup.
    const userId = insertFirstAdmin(db, { email, name, passwordHash });
    setup.close();
    if (!userId) { notFound(req, res, next); return; }
    res.append('Set-Cookie', setup.clearCookie());
    audit('settings.changed', { actorUserId: userId, target: { type: 'user', id: userId }, details: { setting: 'setup', changes: ['first_admin', 'password'] } });
    // Sign the new admin in. The account exists either way: a failed sign-in just sends them to the sign-in page.
    const response = await auth.api.signInEmail({ body: { email, password }, ...authCall(config, req, '/sign-in/email') }).catch(() => undefined);
    if (response?.ok) {
      for (const c of response.headers.getSetCookie()) res.append('Set-Cookie', c);
      audit('auth.login', { actorUserId: userId, target: { type: 'user', id: userId }, details: { method: 'local' } });
      see(res, '/admin', { kind: 'success', code: 'setup_done' }); return;
    }
    log.warn({ status: response?.status }, 'first-run setup: sign-in after creating the admin failed');
    see(res, '/admin/login', { kind: 'success', code: 'setup_done' });
  });

  // "Set up single sign-on first": the Settings page's form, test and save, then "Continue with <label>". Every step
  // needs the setup session (the setup code); the first OIDC sign-in carrying it becomes the admin (see oidc-policy).
  // The client secret is write-only: never rendered, logged, audited or put in a redirect.
  const results = new Map<string, LastResult>(); // setup session key → last connection test
  const fetches = createLoginLimiter({ max: SETTINGS_FETCH_LIMIT, windowMs: 10 * 60_000 });
  const SSO = `${HERE}/sso`;
  const prune = (): void => { for (const [k, v] of results) if (Date.now() - v.at > RESULT_MS) results.delete(k); };
  const keyOf = (res: Response): string => res.locals.setupKey as string;
  const needSession: RequestHandler = (req, res, next) => {
    const key = setup.sessionKey(req.headers.cookie);
    if (key) { res.locals.setupKey = key; next(); return; }
    (res.locals.seeOther as SeeOther)(res, HERE, { kind: 'error', code: 'setup_expired' });
  };
  /** Outbound fetches (test, save) per setup session, like Settings per admin: false means the flash was sent. */
  const allowed = (res: Response): boolean => {
    if (fetches.attempt([`setup:${keyOf(res)}`]).ok) return true;
    (res.locals.seeOther as SeeOther)(res, SSO, { kind: 'error', code: 'settings_rate' });
    return false;
  };

  r.get('/sso', needSession, (req, res) => {
    prune();
    holder.retryIfUnreachable();
    const snap = holder.snapshot();
    const stored = storedView(db, deps.cipher);
    let last = results.get(keyOf(res));
    if (last && isStale(last, stored)) { results.delete(keyOf(res)); last = undefined; }
    const code = oidcErrorOf(req.originalUrl);
    // "Continue" redirects to the IdP: Chromium checks form-action on that redirect.
    if (snap.config.oidc) allowFormAction(res, [new URL(snap.config.oidc.issuerUrl).origin]);
    res.type('html').send(setupPage(pageCtx(res), { ...ssoFormView(config, snap, stored, last, db), ...(code ? { oidcError: { code } } : {}) }));
  });

  r.post('/sso/test', needSession, async (req, res) => {
    const see = res.locals.seeOther as SeeOther;
    const body = req.body as Record<string, unknown>;
    const tooLong = oversizedField(body);
    if (tooLong) { see(res, SSO, { kind: 'error', code: `settings_${tooLong}` }); return; }
    if (!allowed(res)) return;
    const draft = draftOf(body);
    const report = await (deps.check ?? checkOidcIssuer)(draft.issuerUrl, { groups: Boolean(draft.adminGroup || draft.memberGroup) });
    prune(); results.set(keyOf(res), { at: Date.now(), issuerUrl: draft.issuerUrl, report, draft });
    see(res, SSO);
  });

  r.post('/sso', needSession, async (req, res, next) => {
    const see = res.locals.seeOther as SeeOther; const audit = res.locals.audit as BoundAudit;
    const body = req.body as Record<string, unknown>;
    const refuse = (code: FlashCode, reason: string): void => {
      audit('settings.changed', { actorUserId: null, outcome: 'failure', details: { setting: 'oidc', changes: [reason] } });
      see(res, SSO, { kind: 'error', code });
    };
    // As on Settings: an env-managed switch is never an input on the page, so a POST that carries one is refused.
    if (envManagedPost(config.envManaged, body)) { refuse('settings_env_managed', 'env_managed'); return; }
    const parsed = parseOidcForm(body);
    if (!parsed.ok) { see(res, SSO, { kind: 'error', code: `settings_${parsed.error}` }); return; }
    if (!allowed(res)) return;
    // `setup`: no admins exist to lock out; saved only while the user table is still empty (decided in the holder's queue).
    const out = await saveOidc({ db, config, cipher: deps.cipher, holder, ...(deps.check ? { check: deps.check } : {}) }, parsed.value, { actorUserId: null, unlinkAck: false, setup: true });
    if (!out.ok && out.reason === 'setup_closed') { notFound(req, res, next); return; }
    if (out.report) {
      prune();
      results.set(keyOf(res), { at: Date.now(), issuerUrl: parsed.value.issuerUrl, report: out.report, draft: { ...draftOf(body), issuerUrl: parsed.value.issuerUrl, ...(out.ok ? { secretTyped: false } : {}) } });
    }
    if (!out.ok) {
      if (out.reason !== 'oidc_checks_failed') log.warn({ reason: out.reason }, 'setup: single sign-on settings not saved');
      refuse(`settings_${out.reason}`, out.reason); return;
    }
    audit('settings.changed', { actorUserId: null, details: { setting: 'oidc', changes: out.changes } });
    see(res, SSO, { kind: 'success', code: 'settings_saved' });
  });

  r.post('/sso/start', needSession, async (req, res) => {
    const { auth, config: eff } = holder.snapshot();
    if (!eff.oidc) { (res.locals.seeOther as SeeOther)(res, SSO, { kind: 'error', code: 'settings_oidc_unloadable' }); return; }
    // requestSignUp: the first admin is created at the callback; validateUserInfo allows that only for a live setup session.
    const response = await auth.api.signInSocial({
      body: { provider: OIDC_PROVIDER_ID, callbackURL: '/admin', errorCallbackURL: `${SSO}?error=oidc`, requestSignUp: true },
      ...authCall(config, req, '/sign-in/social'),
    });
    await forwardAuthResponse(res, response, SSO);
  });
  return r;
}
