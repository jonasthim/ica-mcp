import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Db } from '../db/index.js';
import { CryptoFormatError, CryptoKeyMismatch, type Cipher } from '../crypto.js';
import type { IcaEndpoints } from '../ica/endpoints.js';
import type { IcaSession } from '../ica/http.js';
import { APP_MIN_VALIDITY_MS, APP_SESSION_UNREADABLE, AppAuthError, AppSessionExpired } from '../ica/app-session.js';
import { IcaRejected, IcaUnauthorized, IcaUnavailable, errorCategory } from '../ica/errors.js';
import { fetchUserInformation, WEB_SESSION_LOGGED_OUT, WEB_SESSION_UNREADABLE, type UserInformation } from '../ica/web-session.js';
import { createAppApi, type AppApi } from '../ica/app-api.js';
import { createHandlaApi, type HandlaApi } from '../ica/handla-api.js';
import { createHandlaGuard, type HandlaGuardOptions, type HandlaStatus } from '../ica/handla-guard.js';
import { createPurchaseApi, createWebApi, type PurchaseApi, type WebApi } from '../ica/web-api.js';
import { loadAppSession, refreshAppSession } from './app-store.js';
import { cookieFingerprint, linkedIcaAccount, loadWebSession, markWebSession, purchaseHistoryOf, recordLoginState, saveWebJarIfChanged, type PurchaseHistoryState, type SessionRow } from './web-store.js';
import { subjectHash } from './identity.js';
import { NeedsAppReconnect, NeedsFreshBankId, NeedsWebReconnect, NotLinked, problemOf, RateLimited, type SessionProblem } from './errors.js';
import { createTokenBucket, type TokenBucket } from './rate-limit.js';

/** The two log calls the keeper makes (pino's Logger satisfies it). Never given a token, cookie or ICA body. */
export type KeeperLog = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
export type SessionKeeperDeps = {
  db: Db; cipher: Cipher; endpoints: IcaEndpoints; log?: KeeperLog; now?: () => Date; limiter?: TokenBucket;
  /** Handla's plain-202 retry waits (default real timers, 1.5 s worst case); tests inject an instant one. */
  handlaSleep?: (ms: number) => Promise<void>;
  /** The process's Handla guard settings (config.handla): breaker cooldown, pacing gap, cache TTL. */
  handla?: HandlaGuardOptions;
};

/** Refetch the web bearer when fewer than this many ms of its `tokenExpires` remain. */
const WEB_BEARER_MARGIN_MS = 60_000;
/** How long a web bearer is taken to live when ICA gives no `tokenExpires`. */
const WEB_BEARER_FALLBACK_MS = 4 * 60_000;
/** A cached web bearer is kept at least this long, whatever `tokenExpires` says (no user-information call per use). */
const WEB_BEARER_FLOOR_MS = 30_000;

/** The accounts whose web jar the current async context holds (withWebJar), to refuse re-entry instead of hanging. */
const heldWebJars = new AsyncLocalStorage<ReadonlySet<string>>();

/** What a user-information check of a web session found (returned by `recheck` inside withWebJar). */
export type WebCheck = { accessToken: string; loginState: number | undefined; checkedAt: string; rowId: string };
/** What withWebJar hands its callback besides the session and row. */
export type WebJarUse = {
  /** Run the user-information check on the session already held (no lock taken): records and caches like any check. */
  recheck(): Promise<WebCheck>;
};

const unreadable = (e: unknown): boolean => e instanceof CryptoKeyMismatch || e instanceof CryptoFormatError || e instanceof SyntaxError;

/** ICA's first app-session window: refreshed tokens are capped at connect + 4 h until the first refresh after it. */
export const APP_WINDOW_MS = 4 * 3_600_000;
/** When the app session's first window ends (epoch ms); 0 when the connect time is unknown (a session from before Phase 2: long past). */
export const appWindowEnd = (connectedAt: string | null): number => (connectedAt ? Date.parse(connectedAt) + APP_WINDOW_MS : 0);

/** get_session_status: what a live web check plus the stored session health found. Never a token, cookie, account id or name. */
export type SessionStatus =
  | { linked: false; handla: HandlaStatus }
  | {
    linked: true;
    /** Whether Handla calls (handla_*) are refused right now after an AWS WAF stop, and for about how many minutes. */
    handla: HandlaStatus;
    /** `connected`: a session is linked. `working`: it was checked OK just now (the web check is live; the app one, its last use). */
    web: { connected: boolean; working: boolean; expiresAt: string | null; lastOkAt: string | null; lastError: string | null; problem?: SessionProblem['kind'] };
    purchaseHistory: PurchaseHistoryState;
    purchaseHistoryNote: string;
    app: { connected: boolean; working: boolean; connectedAt: string | null; accessExpiresAt: string | null; lastRefreshAt: string | null; windowEndsAt: string | null; lastOkAt: string | null; lastError: string | null };
  };

/**
 * A hub user's ICA access for one tool call. Every callback run is one ICA call against the user's rate limit. The
 * ICA account is resolved per call, so a member without one gets NotLinked only from a call that needs it.
 */
export type IcaUserSession = {
  readonly userId: string;
  /** The app APIs (`mobile/*`), always with the account's app bearer. */
  app<T>(fn: (api: AppApi) => Promise<T>): Promise<T>;
  /** The gateway APIs the web bearer reaches (article search). */
  web<T>(fn: (api: WebApi) => Promise<T>): Promise<T>;
  /** www purchase history with the cookie jar; only while ICA reports loginState 2 (checked first), else NeedsFreshBankId. */
  purchases<T>(fn: (api: PurchaseApi) => Promise<T>): Promise<T>;
  /**
   * Handla's anonymous store and product search: no ICA account needed, but it counts against the rate limit. A
   * cached answer is served even while the process's Handla circuit breaker is open, and still spends the token (one
   * call, one token, whatever answers it). An uncached call while the breaker is open fails at once with
   * IcaUnavailable('blocked'), before the token is taken.
   */
  handla<T>(fn: (api: HandlaApi) => Promise<T>): Promise<T>;
  /**
   * get_session_status: no account linked, or a live web check plus the stored session health (charges one budget
   * token, like the other calls above; never NotLinked — an unlinked user gets `{ linked: false }`).
   */
  status(adminUrl: string): Promise<SessionStatus>;
};

/**
 * One per process: resolves hub users to ICA accounts and hands out ICA credentials. Its maps of in-flight refreshes
 * must outlive the per-request MCP servers, which is why it is never created per request.
 */
export function createSessionKeeper(deps: SessionKeeperDeps) {
  const { db, cipher, endpoints } = deps;
  const now = deps.now ?? (() => new Date());
  /** In-flight app refreshes per ICA account: refresh tokens rotate, so concurrent callers must share one refresh. */
  const appRefreshes = new Map<string, Promise<string>>();

  function accountFor(userId: string): string {
    const p = db.select({ icaAccountId: schema.userProfile.icaAccountId }).from(schema.userProfile).where(eq(schema.userProfile.userId, userId)).get();
    if (!p?.icaAccountId) throw new NotLinked();
    return p.icaAccountId;
  }

  /** The account's current app session row id, if any. */
  const appRowId = (accountId: string): string | undefined =>
    db.select({ id: schema.icaSession.id }).from(schema.icaSession)
      .where(and(eq(schema.icaSession.icaAccountId, accountId), eq(schema.icaSession.kind, 'app'))).get()?.id;

  /**
   * Record the outcome of a use of one app session row, by row id: a late outcome of a use of a row a reconnect has
   * replaced meanwhile changes nothing (the row is gone), so it never marks the fresh row.
   */
  function markApp(rowId: string | undefined, error: string | null): void {
    if (rowId === undefined) return;
    const t = now().toISOString();
    db.update(schema.icaSession).set(error === null ? { lastOkAt: t, lastError: null, updatedAt: t } : { lastError: error, updatedAt: t })
      .where(and(eq(schema.icaSession.id, rowId), eq(schema.icaSession.kind, 'app'))).run();
  }

  function loadApp(accountId: string) {
    let loaded;
    try { loaded = loadAppSession({ db, cipher, icaAccountId: accountId }); } catch (e) {
      if (unreadable(e)) { markApp(appRowId(accountId), APP_SESSION_UNREADABLE); throw new NeedsAppReconnect('unreadable'); }
      throw e;
    }
    if (!loaded) throw new NeedsAppReconnect('not-connected');
    return loaded;
  }

  /** Set by beginClosing (the graceful shutdown): no new app refresh or web jar use starts; in-flight ones can be joined. */
  let closing = false;

  function refreshApp(accountId: string): Promise<string> {
    const running = appRefreshes.get(accountId);
    if (running) return running;
    // A refresh started now might still be waiting on ICA when the process exits: ICA would have rotated the refresh
    // token and the new one would never be stored (a BankID reconnect). Refuse it; the stored token stays valid.
    if (closing) return Promise.reject(new IcaUnavailable('shutting-down'));
    const started = Date.now();
    const rowAtStart = appRowId(accountId); // the row refreshAppSession reads (and would find unreadable)
    const logRefresh = (ok: boolean, error?: string) =>
      deps.log?.info({ account: accountId, kind: 'app', event: 'refresh', ok, ms: Date.now() - started, ...(error ? { error } : {}) }, 'ica session refresh');
    const p = refreshAppSession({ db, cipher, endpoints, icaAccountId: accountId, now })
      .then((st) => { logRefresh(true); return st.token.access_token; }, (e: unknown) => {
        logRefresh(false, e instanceof Error ? e.name : 'unknown');
        if (e instanceof AppSessionExpired) throw new NeedsAppReconnect('expired');
        if (e instanceof AppAuthError) throw new NeedsAppReconnect('rejected');
        if (unreadable(e)) { markApp(rowAtStart, APP_SESSION_UNREADABLE); throw new NeedsAppReconnect('unreadable'); }
        throw e; // IcaUnavailable (network, 5xx): try again later, the session is fine
      })
      .finally(() => { appRefreshes.delete(accountId); });
    appRefreshes.set(accountId, p);
    return p;
  }

  /** A usable app access token: the stored one while it has more than 60 s left, else a (shared) refresh. */
  async function appToken(accountId: string): Promise<string> {
    const { row, state } = loadApp(accountId);
    const expires = row.expiresAt ? Date.parse(row.expiresAt) : 0;
    if (expires - now().getTime() > APP_MIN_VALIDITY_MS) return state.token.access_token;
    return refreshApp(accountId);
  }

  /** Refresh now whatever the token's lifetime (the upkeep job); shares an in-flight refresh. */
  async function refreshAppNow(accountId: string): Promise<string> {
    loadApp(accountId);
    return refreshApp(accountId);
  }

  /** After ICA refused `used`: a token another call has already refreshed to, else a (shared) refresh. */
  async function tokenAfterRejection(accountId: string, used: string): Promise<string> {
    const running = appRefreshes.get(accountId);
    if (running) return running;
    const { state } = loadApp(accountId);
    return state.token.access_token !== used ? state.token.access_token : refreshApp(accountId);
  }

  /**
   * Run `fn` with the account's app bearer (the only credential `mobile/*` accepts). A 401/403 from ICA refreshes (or
   * picks up a newer token) and retries once; a second refusal means ICA no longer accepts this app session. Success
   * records `lastOkAt`. Outcomes are recorded on the row the token was obtained from (markApp), so a reconnect while
   * ICA is answering is never marked by this call.
   */
  async function withAppBearer<T>(accountId: string, fn: (bearer: string) => Promise<T>): Promise<T> {
    const first = await appToken(accountId);
    const firstRow = appRowId(accountId);
    try { const out = await fn(first); markApp(firstRow, null); return out; } catch (e) { if (!(e instanceof IcaUnauthorized)) throw e; }
    const second = await tokenAfterRejection(accountId, first);
    const secondRow = appRowId(accountId);
    try { const out = await fn(second); markApp(secondRow, null); return out; } catch (e) {
      if (e instanceof IcaUnauthorized) { markApp(secondRow, `ICA refused the app token (HTTP ${e.status})`); throw new NeedsAppReconnect('rejected'); }
      throw e;
    }
  }

  const limiter = deps.limiter ?? createTokenBucket();
  /** One per process: AWS WAF's rate rule in front of Handla is per source IP, so its breaker, queue and cache are too. */
  const handlaGuard = createHandlaGuard({ ...deps.handla, ...(deps.log ? { log: deps.log } : {}) });
  /** Spend one of the user's ICA calls, or throw RateLimited. */
  function take(userId: string): void {
    const r = limiter.take(userId);
    if (!r.ok) throw new RateLimited(r.retryAfterSeconds);
  }

  type CheckedWeb = WebCheck;
  /**
   * Cached web bearers per account, tagged with the web session row they were minted from: a reconnect inserts a new
   * row (possibly another BankID person), so an entry for another row is never served. In-flight user-information
   * checks per account are shared by concurrent callers.
   */
  const webBearers = new Map<string, { token: string; until: number; rowId: string }>();
  const webChecks = new Map<string, Promise<CheckedWeb>>();
  /** Per-account queue of jar uses: one use of an account's cookie jar at a time (see withWebJar). */
  const webJarLocks = new Map<string, Promise<void>>();

  function markWebByAccount(accountId: string, error: string): void {
    db.update(schema.icaSession).set({ lastError: error, updatedAt: now().toISOString() })
      .where(and(eq(schema.icaSession.icaAccountId, accountId), eq(schema.icaSession.kind, 'web'))).run();
  }

  const webRowId = (accountId: string): string | undefined =>
    db.select({ id: schema.icaSession.id }).from(schema.icaSession)
      .where(and(eq(schema.icaSession.icaAccountId, accountId), eq(schema.icaSession.kind, 'web'))).get()?.id;

  function loadWeb(accountId: string) {
    let loaded;
    try { loaded = loadWebSession({ db, cipher, icaAccountId: accountId }); } catch (e) {
      if (unreadable(e)) { markWebByAccount(accountId, WEB_SESSION_UNREADABLE); throw new NeedsWebReconnect(); }
      throw e;
    }
    if (!loaded) throw new NeedsWebReconnect();
    return { ...loaded, before: cookieFingerprint(loaded.session.jar) };
  }

  /** Write the jar back if ICA rotated its cookies. A failed save is logged and never changes the use's outcome. */
  async function saveJar(accountId: string, l: ReturnType<typeof loadWeb>): Promise<void> {
    try {
      await saveWebJarIfChanged({ db, cipher, row: l.row, session: l.session, before: l.before, web: endpoints.web, now: now(), ...(deps.log ? { log: deps.log } : {}) });
    } catch (e) {
      deps.log?.warn({ account: accountId, err: { name: e instanceof Error ? e.name : 'unknown' } }, 'ica web jar save failed');
    }
  }

  /**
   * The one way to use an account's stored web cookie jar: waits for the account's previous jar use, loads the jar,
   * runs `fn` with it and writes rotated cookies back (compare-and-swap, merging on a miss), whatever `fn`'s outcome.
   * Used by the user-information check, by diagnostics' probes and by the purchase-history calls (Task 2.15's
   * `withWebCookies`). Throws NeedsWebReconnect when the account has no readable web session.
   *
   * Not re-entrant: calling it (or anything that checks the web session, like webLoginState) for the same account
   * from inside `fn` would wait on its own lock forever, so it throws instead. Inside `fn`, use `use.recheck()`.
   */
  async function withWebJar<T>(accountId: string, fn: (session: IcaSession, row: SessionRow, use: WebJarUse) => Promise<T>): Promise<T> {
    const held = heldWebJars.getStore();
    if (held?.has(accountId)) throw new Error('withWebJar re-entered for the same account');
    // Every jar use can rotate cookies (saved when it ends): none starts once the shutdown has begun. Uses already
    // held or queued go on (idle waits for them), and so do rechecks inside a held use and joins of a running check.
    if (closing) throw new IcaUnavailable('shutting-down');
    const previous = webJarLocks.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = previous.then(() => mine);
    webJarLocks.set(accountId, tail);
    await previous;
    try {
      const l = loadWeb(accountId);
      const use: WebJarUse = { recheck: () => checkHeld(accountId, l.session, l.row) };
      try { return await heldWebJars.run(new Set([...(held ?? []), accountId]), () => fn(l.session, l.row, use)); } finally { await saveJar(accountId, l); }
    } finally {
      release();
      if (webJarLocks.get(accountId) === tail) webJarLocks.delete(accountId);
    }
  }

  /**
   * Log a web check: the account, the outcome and the loginState only (never a cookie, bearer or ICA body). `'absent'`:
   * ICA answered without a loginState key.
   */
  const logCheck = (accountId: string, ok: boolean, loginState?: number | 'absent') =>
    deps.log?.info({ account: accountId, kind: 'web', event: 'check', ok, ...(loginState !== undefined ? { loginState } : {}) }, 'ica web session check');

  /**
   * /api/user/information with the stored jar: maps failures, records the outcome and the loginState ICA reported
   * (as reported, never assumed or raised), caches the bearer; the jar is saved by withWebJar.
   */
  function checkWeb(accountId: string): Promise<CheckedWeb> {
    return withWebJar(accountId, (session, row) => checkHeld(accountId, session, row));
  }

  /**
   * Same-person backfill: an account enrolled before subject hashes existed (or when ICA gave none) gets its hash from
   * a successful check of its stored, already trusted session, so it is protected without a new BankID login. Only
   * ever fills a null hash (conditional UPDATE); a different subject here is never written. Nothing is logged.
   */
  function backfillSubject(accountId: string, subject: string | undefined): void {
    const hash = subjectHash((v) => cipher.mac(v), subject);
    if (!hash) return;
    const a = schema.icaAccount;
    db.update(a).set({ webSubjectHash: hash }).where(and(eq(a.id, accountId), isNull(a.webSubjectHash))).run();
  }

  /** The check itself, on a session whose jar the caller holds (withWebJar). */
  async function checkHeld(accountId: string, session: IcaSession, row: SessionRow): Promise<CheckedWeb> {
    // Taken before asking ICA: the recorded loginState is written only over states recorded before this (CAS).
    const startedAt = now();
    let info: UserInformation;
    try { info = await fetchUserInformation(session, endpoints); } catch (e) {
      logCheck(accountId, false);
      throw new IcaUnavailable(errorCategory(e));
    }
    const t = now();
    if (info.status === 451) { logCheck(accountId, false); throw new IcaUnavailable('geo-blocked', 451); }
    if (info.status === 429) { logCheck(accountId, false); throw new IcaUnavailable('rate-limited', 429); }
    if (info.status >= 500) { logCheck(accountId, false); throw new IcaUnavailable('server-error', info.status); }
    if (info.status === 401 || info.status === 403 || info.loginState === 0) {
      webBearers.delete(accountId);
      markWebSession(db, row.id, false, WEB_SESSION_LOGGED_OUT, t);
      // Only a reported 0 is recorded as 0; a refused request says nothing about the loginState.
      recordLoginState(db, row.id, info.loginState === 0 ? 0 : null, t, startedAt);
      logCheck(accountId, false, info.loginState ?? 'absent');
      throw new NeedsWebReconnect();
    }
    if (info.status >= 400) { logCheck(accountId, false); throw new IcaRejected(info.status); }
    if (!info.accessToken) {
      if (info.loginState !== undefined) recordLoginState(db, row.id, info.loginState, t, startedAt);
      logCheck(accountId, false, info.loginState ?? 'absent');
      throw new IcaUnavailable('unexpected-response', info.status, ['accessToken: missing']);
    }
    markWebSession(db, row.id, true, null, t);
    recordLoginState(db, row.id, info.loginState ?? null, t, startedAt);
    backfillSubject(accountId, info.subject);
    const expires = info.tokenExpires ? Date.parse(info.tokenExpires) : t.getTime() + WEB_BEARER_FALLBACK_MS;
    webBearers.set(accountId, { token: info.accessToken, until: Math.max(expires - WEB_BEARER_MARGIN_MS, t.getTime() + WEB_BEARER_FLOOR_MS), rowId: row.id });
    logCheck(accountId, true, info.loginState ?? 'absent');
    return { accessToken: info.accessToken, loginState: info.loginState, checkedAt: t.toISOString(), rowId: row.id };
  }

  function checkWebShared(accountId: string): Promise<CheckedWeb> {
    const running = webChecks.get(accountId);
    if (running) return running;
    const p = checkWeb(accountId).finally(() => { webChecks.delete(accountId); });
    webChecks.set(accountId, p);
    return p;
  }

  /** A check of the account's current web session: one that raced a reconnect (checked the replaced row) is redone. */
  async function checkCurrentWeb(accountId: string): Promise<CheckedWeb> {
    const c = await checkWebShared(accountId);
    return c.rowId === webRowId(accountId) ? c : checkWebShared(accountId);
  }

  async function webBearer(accountId: string, force = false): Promise<string> {
    const cached = webBearers.get(accountId);
    if (!force && cached && cached.until > now().getTime() && cached.rowId === webRowId(accountId)) return cached.token;
    return (await checkCurrentWeb(accountId)).accessToken;
  }

  /**
   * Run `fn` with the web bearer (the web list and article-search APIs only). A 401/403 re-mints once through a fresh
   * user-information check (NeedsWebReconnect itself if that finds the session logged out). A second 401/403 right
   * after a successful fresh check is IcaRejected, not a reconnect: the session demonstrably works.
   */
  async function withWebBearer<T>(accountId: string, fn: (bearer: string) => Promise<T>): Promise<T> {
    const first = await webBearer(accountId);
    try { return await fn(first); } catch (e) { if (!(e instanceof IcaUnauthorized)) throw e; }
    webBearers.delete(accountId);
    const second = await webBearer(accountId, true);
    try { return await fn(second); } catch (e) {
      if (e instanceof IcaUnauthorized) { webBearers.delete(accountId); throw new IcaRejected(e.status); }
      throw e;
    }
  }

  /** The web session's loginState right now (a live check, recorded on the row) and when it was checked. */
  async function webLoginState(accountId: string): Promise<{ loginState: number | undefined; checkedAt: string }> {
    const c = await checkCurrentWeb(accountId);
    return { loginState: c.loginState, checkedAt: c.checkedAt };
  }

  /**
   * Run `fn` with the account's stored cookie jar (www APIs), inside the jar lock (withWebJar: rotated cookies are
   * saved whatever the outcome). A live user-information check runs first, inside the same lock (`use.recheck()`,
   * recorded on the row); a logged-out session is NeedsWebReconnect from that check. With `minLoginState`, a lower
   * loginState is NeedsFreshBankId before `fn` runs, and a 401/403 from `fn` re-checks (and records) the state and is
   * NeedsFreshBankId too, never a reconnect: at loginState 1 ICA answers `/api/cpa/*` with an empty 403 although the
   * session is fine. When the re-check still reports at least `minLoginState`, ICA refused at the right level: one warn
   * line (account, status, loginState only), the recorded state is set to unknown (the re-check's level must not show
   * as "available"), and the error's reason is `refused-at-level`. Without `minLoginState`, a 401/403 from `fn` is
   * NeedsWebReconnect.
   *
   * Not re-entrant (withWebJar): `fn` must not call withWebJar, webLoginState or withWebCookies for
   * the same account.
   */
  async function withWebCookies<T>(accountId: string, fn: (session: IcaSession) => Promise<T>, o: { minLoginState?: number } = {}): Promise<T> {
    const min = o.minLoginState;
    return withWebJar(accountId, async (session, row, use) => {
      const first = await use.recheck();
      if (min !== undefined && (first.loginState ?? 0) < min) throw new NeedsFreshBankId(first.loginState);
      try { return await fn(session); } catch (e) {
        if (!(e instanceof IcaUnauthorized)) throw e;
        if (min === undefined) throw new NeedsWebReconnect();
        const again = await use.recheck(); // NeedsWebReconnect itself if the session really ended meanwhile
        if (again.loginState !== undefined && again.loginState < min) throw new NeedsFreshBankId(again.loginState);
        deps.log?.warn({ account: accountId, event: 'cpa-forbidden-at-level', status: e.status, loginState: again.loginState ?? 'absent' }, 'ica refused a www call at the reported login level');
        const t = now();
        recordLoginState(db, row.id, null, t, new Date(Date.parse(again.checkedAt)));
        throw new NeedsFreshBankId(again.loginState, 'refused-at-level');
      }
    });
  }

  /**
   * get_session_status: no account linked (no charge), or one budget token plus a live web check (it records
   * loginState) and the stored app-session health. A web check that fails for a reason `sessionErrorText` knows
   * (session ended, ICA unavailable, any other 4xx) degrades the web section to a `problem` instead of failing the
   * whole call: the app section and purchase-history flag are still worth reporting. Never a token, cookie, account
   * id or name.
   */
  async function statusFor(userId: string, adminUrl: string): Promise<SessionStatus> {
    const before = linkedIcaAccount(db, userId);
    if (!before) return { linked: false, handla: handlaGuard.status() };
    take(userId);
    let problem: SessionProblem | undefined;
    if (before.web) {
      try { await webLoginState(before.account.id); } catch (e) { problem = problemOf(e); if (!problem) throw e; }
    }
    const l = linkedIcaAccount(db, userId) ?? before; // re-read: the check updated lastOkAt / lastError / loginState
    const ph = purchaseHistoryOf(l.web);
    const windowEnd = appWindowEnd(l.app?.connectedAt ?? null);
    return {
      linked: true,
      handla: handlaGuard.status(),
      web: {
        connected: Boolean(l.web), working: Boolean(l.web) && !problem, expiresAt: l.web?.expiresAt ?? null,
        lastOkAt: l.web?.lastOkAt ?? null, lastError: l.web?.lastError ?? null, ...(problem ? { problem: problem.kind } : {}),
      },
      purchaseHistory: ph,
      purchaseHistoryNote: ph.available
        ? 'ICA shows purchase history now. It ends on its own after somewhere between half an hour and a few hours, and at once when app access is connected with BankID.'
        : `Purchase history needs a fresh web BankID login: open ${adminUrl} and choose "Reconnect with BankID" (after any app access reconnect).`,
      app: {
        connected: Boolean(l.app), working: Boolean(l.app) && l.app?.lastError == null,
        connectedAt: l.app?.connectedAt ?? null, accessExpiresAt: l.app?.expiresAt ?? null, lastRefreshAt: l.app?.refreshedAt ?? null,
        windowEndsAt: l.app && windowEnd > now().getTime() ? new Date(windowEnd).toISOString() : null,
        lastOkAt: l.app?.lastOkAt ?? null, lastError: l.app?.lastError ?? null,
      },
    };
  }

  function forUser(userId: string): IcaUserSession {
    return {
      userId,
      app: async <T>(fn: (api: AppApi) => Promise<T>): Promise<T> => {
        const accountId = accountFor(userId);
        take(userId);
        return withAppBearer(accountId, (bearer) => fn(createAppApi({ endpoints, bearer })));
      },
      web: async <T>(fn: (api: WebApi) => Promise<T>): Promise<T> => {
        const accountId = accountFor(userId);
        take(userId);
        return withWebBearer(accountId, (bearer) => fn(createWebApi({ endpoints, bearer })));
      },
      purchases: async <T>(fn: (api: PurchaseApi) => Promise<T>): Promise<T> => {
        const accountId = accountFor(userId);
        take(userId);
        return withWebCookies(accountId, (session) => fn(createPurchaseApi({ endpoints, session })), { minLoginState: 2 });
      },
      status: (adminUrl: string): Promise<SessionStatus> => statusFor(userId, adminUrl),
      handla: async <T>(fn: (api: HandlaApi) => Promise<T>): Promise<T> => {
        // The API spends the token itself: after a cache hit (served even while the breaker is open), or after the
        // breaker check for a miss, so a call the open breaker refuses spends nothing; a miss that never reached
        // Handla (refused or dropped while queued) is refunded.
        return fn(createHandlaApi({ endpoints, guard: handlaGuard, charge: () => { take(userId); return () => { limiter.refund(userId); }; }, ...(deps.handlaSleep ? { sleep: deps.handlaSleep } : {}) }));
      },
    };
  }

  /**
   * The graceful shutdown's first step (at the signal): from now on no new app refresh or web jar use starts (they
   * throw IcaUnavailable('shutting-down')); in-flight ones finish and can still be joined. Queued Handla requests are
   * rejected with 'shutting-down' and no new one starts. Not undone.
   */
  function beginClosing(): void { closing = true; handlaGuard.close(); }

  /**
   * Resolves when no app refresh, web check or web jar use (held or queued) is in flight, whatever their outcomes:
   * their rotated tokens and cookies have then been written. It waits in rounds, taking a fresh snapshot after each,
   * so work that joined or started meanwhile is waited for too (after beginClosing nothing new can start). The
   * graceful shutdown awaits it before closing the database: exiting between ICA's answer and that write would lose
   * the rotated refresh token (a BankID reconnect).
   */
  async function idle(): Promise<void> {
    for (;;) {
      const inFlight: Promise<unknown>[] = [...appRefreshes.values(), ...webChecks.values(), ...webJarLocks.values()];
      if (inFlight.length === 0) return;
      await Promise.allSettled(inFlight);
    }
  }

  return {
    /** Tool calls (runTool only). */
    forUser,
    /** /admin/ica diagnostics. */
    appToken, withWebJar, markAppOk: (accountId: string): void => markApp(appRowId(accountId), null),
    /** The app-token upkeep. */
    refreshAppNow,
    /** The graceful shutdown. */
    beginClosing, idle,
    /** @internal test — production code reaches these through forUser. */
    withAppBearer,
    /** @internal test */
    withWebBearer,
    /** @internal test */
    webLoginState,
    /** @internal test */
    withWebCookies,
    /** @internal test */
    handlaStatus: (): HandlaStatus => handlaGuard.status(),
    /** @internal test */
    webJarUsesQueued: (): number => webJarLocks.size,
  };
}
export type SessionKeeper = ReturnType<typeof createSessionKeeper>;
