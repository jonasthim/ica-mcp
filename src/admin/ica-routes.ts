import { Router, type Response } from 'express';
import QRCode from 'qrcode';
import type { Db } from '../db/index.js';
import type { Cipher } from '../crypto.js';
import type { Logger } from '../logger.js';
import type { IcaEndpoints } from '../ica/endpoints.js';
import { EnrolmentBusy, type Enrolments, type EnrolmentStatus } from '../sessions/enrolment.js';
import { disconnectIcaAccount, icaAccountSharedFor, linkedIcaAccount, loadWebSession, markWebSession, recordLoginState } from '../sessions/web-store.js';
import { WEB_SESSION_LOGGED_OUT, WEB_SESSION_UNREADABLE } from '../ica/web-session.js';
import { APP_SESSION_EXPIRED, APP_SESSION_UNREADABLE } from '../ica/app-session.js';
import { IcaUnavailable } from '../ica/errors.js';
import { NeedsAppReconnect, NeedsWebReconnect } from '../sessions/errors.js';
import type { SessionKeeper } from '../sessions/keeper.js';
import { runProbes } from '../ica/probes.js';
import { redactUrl } from '../ica/redact.js';
import { CryptoFormatError, CryptoKeyMismatch } from '../crypto.js';
import { requireSession, type AdminSession, type AuthRef } from './session.js';
import { icaConnectPage, icaDiagnosticsPage, icaDisconnectConfirmPage, icaErrorPage, icaPage, type DiagnosticsAppView } from './views/index.js';
import { pageCtx } from './page-ctx.js';
import { s } from './i18n.js';
import { createLoginLimiter } from './rate-limit.js';
import type { SeeOther } from './flash.js';
import type { BoundAudit } from '../audit.js';

type StatusJson = { state: EnrolmentStatus['state']; qrSvg?: string; autoStartUrl?: string; reason?: string };

const autoStartUrl = (token: string): string => `bankid:///?autostarttoken=${encodeURIComponent(token)}&redirect=null`;

/**
 * A shape string can run past a thousand characters (an object with many keys, `shape.ts`'s MAX_KEYS = 40, does not
 * truncate). Capped to 500 chars — long enough to keep every key name from the widest known ICA answer, short enough
 * that the whole `ica diagnostics` log line (up to 16 shapes: 14 element captures, the user-information answer, the
 * app token) stays a readable, bounded journal entry.
 */
const SHAPE_LOG_CAP = 500;
const capShape = (s: string): string => (s.length > SHAPE_LOG_CAP ? `${s.slice(0, SHAPE_LOG_CAP)}…` : s);

/**
 * /admin/ica: connect the signed-in hub user's ICA account with BankID and look at what the session reaches.
 * Mounted inside the admin router, so POSTs have already passed its same-origin and CSRF checks.
 */
export function icaRouter(deps: { auth: AuthRef; db: Db; cipher: Cipher; endpoints: IcaEndpoints; enrolments: Enrolments; log: Logger; keeper: SessionKeeper; connectLimit?: { max: number; windowMs: number } }): Router {
  const { db, enrolments, log } = deps;
  const r = Router();
  r.use(requireSession(deps.auth));
  const userOf = (locals: Record<string, unknown>) => (locals.session as AdminSession).user;
  /** Enrolments already audited (connected, or refused as another ICA person): later polls report the same end state. Kept 10 minutes. */
  const auditedEnrolments = new Set<string>();
  const AUDITED_TTL_MS = 10 * 60_000;

  /** BankID starts per hub user and flow (never per IP alone): each one makes ICA calls, and the app flow may register a client. */
  const connectLimit = createLoginLimiter({ max: deps.connectLimit?.max ?? 10, windowMs: deps.connectLimit?.windowMs ?? 15 * 60_000 });
  /** Answers 429 and returns true when this user has started too many BankID logins of this flow recently. */
  const limited = (res: Response, userId: string, flow: 'web' | 'app'): boolean => {
    const r = connectLimit.attempt([`connect:${flow}:${userId}`]);
    if (r.ok) return false;
    if (r.firstRejection) log.warn({ userId, flow }, 'ica connect rate limit exceeded');
    res.status(429).set('Retry-After', String(r.retryAfterSeconds)).type('html').send(icaErrorPage(pageCtx(res), s.ica.errors.tooMany(Math.ceil(r.retryAfterSeconds / 60))));
    return true;
  };
  /** A double click: the first start's page shows the QR code; send this one back to the ICA page. Not counted by the limit. */
  const busy = (res: Response): void => { (res.locals.seeOther as SeeOther)(res, '/admin/ica', { kind: 'info', code: 'ica_busy' }); };

  r.get('/', (_req, res) => {
    const linked = linkedIcaAccount(db, userOf(res.locals).id);
    res.type('html').send(icaPage(pageCtx(res), {
      account: linked && {
        displayName: linked.account.displayName, hasSession: Boolean(linked.web),
        expiresAt: linked.web?.expiresAt ?? null, lastOkAt: linked.web?.lastOkAt ?? null, lastError: linked.web?.lastError ?? null,
        loginState: linked.web?.loginState ?? null, loginStateAt: linked.web?.loginStateAt ?? null,
        app: linked.app && { expiresAt: linked.app.expiresAt, lastOkAt: linked.app.lastOkAt, lastError: linked.app.lastError },
      },
    }));
  });

  /**
   * Self-service disconnect (to switch to another person's ICA account: the same-person check refuses one otherwise).
   * Asks first; takes effect with `confirm=yes`. A household-shared account is only unlinked for this user. Nothing
   * linked: back to the page, nothing to confirm or audit.
   */
  r.post('/disconnect', (req, res) => {
    const user = userOf(res.locals);
    const seeOther = res.locals.seeOther as SeeOther;
    if (!linkedIcaAccount(db, user.id)) { seeOther(res, '/admin/ica'); return; }
    if ((req.body as Record<string, unknown> | undefined)?.confirm !== 'yes') {
      res.type('html').send(icaDisconnectConfirmPage(pageCtx(res), { shared: icaAccountSharedFor(db, user.id) })); return;
    }
    const done = disconnectIcaAccount(db, user.id);
    if (done) {
      (res.locals.audit as BoundAudit)('ica.disconnected', { target: { type: 'user', id: user.id }, details: { by: 'self', mode: done.mode } });
      log.info({ userId: user.id, mode: done.mode }, 'ica account disconnected by its user');
    }
    seeOther(res, '/admin/ica', done ? { kind: 'success', code: done.mode === 'unlinked' ? 'ica_self_unlinked' : 'ica_self_disconnected' } : undefined);
  });

  /** Experimental: BankID through the ICA app's own OAuth client, for the mobile/* APIs the web bearer cannot reach. */
  r.post('/connect-app', async (_req, res) => {
    const user = userOf(res.locals);
    if (!linkedIcaAccount(db, user.id)) {
      res.status(409).type('html').send(icaErrorPage(pageCtx(res), s.ica.errors.appNeedsWeb)); return;
    }
    if (enrolments.isStarting(user.id)) { busy(res); return; }
    if (limited(res, user.id, 'app')) return;
    try {
      const e = await enrolments.start({ id: user.id, name: user.name }, 'app');
      (res.locals.seeOther as SeeOther)(res, `/admin/ica/connect/${e.id}`);
    } catch (err) {
      if (err instanceof EnrolmentBusy) { busy(res); return; }
      log.warn({ flow: 'app', reason: err instanceof Error ? redactUrl(err.message) : 'unknown' }, 'ica enrolment start failed');
      res.status(502).type('html').send(icaErrorPage(pageCtx(res), s.ica.errors.appStart));
    }
  });

  r.post('/connect', async (_req, res) => {
    const user = userOf(res.locals);
    if (enrolments.isStarting(user.id)) { busy(res); return; }
    if (limited(res, user.id, 'web')) return;
    try {
      const e = await enrolments.start({ id: user.id, name: user.name });
      (res.locals.seeOther as SeeOther)(res, `/admin/ica/connect/${e.id}`);
    } catch (err) {
      if (err instanceof EnrolmentBusy) { busy(res); return; }
      log.warn({ reason: err instanceof Error ? redactUrl(err.message) : 'unknown' }, 'ica enrolment start failed');
      res.status(502).type('html').send(icaErrorPage(pageCtx(res), s.ica.errors.webStart));
    }
  });

  r.get('/connect/:id', (req, res) => {
    const e = enrolments.get(req.params.id, userOf(res.locals).id);
    if (!e) { res.status(404).type('html').send(icaErrorPage(pageCtx(res), s.ica.errors.expired)); return; }
    res.type('html').send(icaConnectPage(pageCtx(res), { statusUrl: `/admin/ica/connect/${e.id}/status`, flow: e.flow }));
  });

  r.get('/connect/:id/status', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const e = enrolments.get(req.params.id, userOf(res.locals).id);
    if (!e) { res.status(404).json({ state: 'failed', reason: s.ica.errors.expired } satisfies StatusJson); return; }
    const st = await e.poll();
    let body: StatusJson;
    if (st.state === 'pending') {
      body = { state: 'pending', qrSvg: await QRCode.toString(st.qr, { type: 'svg', margin: 2 }), ...(st.autoStartToken ? { autoStartUrl: autoStartUrl(st.autoStartToken) } : {}) };
    } else body = st.state === 'failed' ? { state: 'failed', reason: st.reason } : { state: 'complete' };
    if (st.state === 'complete' && !auditedEnrolments.has(e.id)) {
      auditedEnrolments.add(e.id);
      setTimeout(() => auditedEnrolments.delete(e.id), AUDITED_TTL_MS).unref();
      (res.locals.audit as BoundAudit)(e.flow === 'app' ? 'ica.app_connected' : 'ica.web_connected');
    }
    if (st.state === 'failed' && 'identityRefused' in st && !auditedEnrolments.has(e.id)) {
      auditedEnrolments.add(e.id);
      setTimeout(() => auditedEnrolments.delete(e.id), AUDITED_TTL_MS).unref();
      (res.locals.audit as BoundAudit)('ica.identity_refused', { outcome: 'failure', details: { kind: st.identityRefused } });
    }
    res.json(body);
  });

  r.get('/diagnostics', async (_req, res) => {
    const linked = linkedIcaAccount(db, userOf(res.locals).id);
    if (!linked?.web) { res.type('html').send(icaDiagnosticsPage(pageCtx(res), { kind: 'not-connected' })); return; }
    let loaded;
    try { loaded = loadWebSession({ db, cipher: deps.cipher, icaAccountId: linked.account.id }); } catch (err) {
      if (!(err instanceof CryptoKeyMismatch || err instanceof CryptoFormatError)) throw err;
      // Persisted so Home and the ICA page show "Needs reconnect", not a healthy session.
      markWebSession(db, linked.web.id, false, WEB_SESSION_UNREADABLE);
      res.type('html').send(icaDiagnosticsPage(pageCtx(res), { kind: 'unreadable' })); return;
    }
    if (!loaded) { res.type('html').send(icaDiagnosticsPage(pageCtx(res), { kind: 'not-connected' })); return; }
    // With an app session, the mobile/* probes use its access token (refreshed first if it expires within 60 s).
    let appBearer: string | undefined;
    let app: DiagnosticsAppView = { state: 'none' };
    if (linked.app) {
      try {
        appBearer = await deps.keeper.appToken(linked.account.id);
        app = { state: 'used' };
      } catch (err) {
        const problem = err instanceof NeedsAppReconnect
          ? err.why === 'expired' ? APP_SESSION_EXPIRED
            : err.why === 'unreadable' ? APP_SESSION_UNREADABLE
              : err.why === 'not-connected' ? 'app access is not connected — connect it on the ICA page'
                : 'ICA refused the app session — reconnect'
          : err instanceof IcaUnavailable ? 'ICA did not answer the token refresh — try again later' : 'the app token could not be refreshed';
        log.warn({ problem, err: { name: (err as Error).name } }, 'ica app session unusable');
        app = { state: 'error', problem };
      }
    }
    // The probes use the jar through the keeper: one jar use per account at a time, rotated cookies written back.
    let report;
    try {
      report = await deps.keeper.withWebJar(linked.account.id, async (session, row) => {
        const startedAt = new Date();
        const r = await runProbes(session, deps.endpoints, appBearer ? { appBearer } : {});
        const t = new Date();
        markWebSession(db, row.id, r.live, r.error === 'logged-out' ? WEB_SESSION_LOGGED_OUT : r.error ?? null, t);
        if (r.loginState !== undefined) recordLoginState(db, row.id, r.loginState, t, startedAt);
        return r;
      });
    } catch (err) {
      // The session went away (or became unreadable, which the keeper records) since it was loaded above.
      if (!(err instanceof NeedsWebReconnect)) throw err;
      res.type('html').send(icaDiagnosticsPage(pageCtx(res), { kind: 'not-connected' })); return;
    }
    if (appBearer && report.results.some((r) => r.auth === 'app bearer' && r.status === 200)) deps.keeper.markAppOk(linked.account.id);
    // External monitoring cannot see /admin/ica/diagnostics, so this line is how it reads the element-shape capture: shapes only
    // (keys and value types, see shape.ts), each capped so one wide answer cannot make the log line unbounded.
    const userInfoShape = report.elements.find((el) => el.probe === 'user-information')?.shape;
    const appTokenShapeStr = report.elements.find((el) => el.probe === 'app-token')?.shape;
    // user-information and app-token are reported as userInfoShape/appTokenShape below; kept out of `elements` so
    // the log line does not carry each of them twice.
    const capturedElements = report.elements.filter((el) => el.probe !== 'user-information' && el.probe !== 'app-token');
    log.info({
      live: report.live, probes: report.results.map((p) => `${p.name}:${p.auth}:${String(p.status)}`),
      elements: capturedElements.map((el) => ({ probe: el.probe, label: el.label, shape: capShape(el.shape) })),
      ...(userInfoShape !== undefined ? { userInfoShape: capShape(userInfoShape) } : {}),
      ...(appTokenShapeStr !== undefined ? { appTokenShape: capShape(appTokenShapeStr) } : {}),
    }, 'ica diagnostics');
    (res.locals.audit as BoundAudit)('ica.diagnostics_run', { details: { live: report.live } });
    res.type('html').send(icaDiagnosticsPage(pageCtx(res), { kind: 'report', ...report, app }));
  });

  return r;
}
