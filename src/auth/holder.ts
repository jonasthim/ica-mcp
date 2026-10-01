import type { IncomingMessage, ServerResponse } from 'node:http';
import { toNodeHandler } from 'better-auth/node';
import type { Audit } from '../audit.js';
import type { Config } from '../config.js';
import type { Cipher } from '../crypto.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import { effectiveConfig, resolveSettings, type EffectiveSettings, type SettingsProblem } from '../settings/effective.js';
import { createAuth, OIDC_PROVIDER_ID, type Auth } from './index.js';
import type { OidcRejections } from './oidc-policy.js';
import type { SetupGate } from '../setup/state.js';
import { createSeenGroups, type SeenGroups } from './seen-groups.js';

/**
 * One immutable view of the auth state in use. `config` is the effective config with `oidc` removed when the provider
 * did not load, so everything that reads `snap.config.oidc` hides single sign-on on its own; `settings` keeps what was
 * configured (the Settings page shows it) plus the problems found.
 */
export type AuthSnapshot = {
  auth: Auth; config: Config; settings: EffectiveSettings; generation: number;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};
/**
 * What a save wants applied, decided inside the holder's queue: the candidate settings and the commit that makes them
 * stored, or a refusal (a guard that failed against the state at that moment).
 */
export type ApplyPlan<R extends string> = { settings: EffectiveSettings; commit: () => void } | { refused: R };
export type ApplyResult<R extends string> = { ok: true; snapshot: AuthSnapshot } | { ok: false; reason: 'oidc_unloadable' | R };
export type AuthHolder = {
  readonly current: Auth;
  /** Admins' latest groups claims (memory only), shared by every instance this holder builds. */
  readonly seenGroups: SeenGroups;
  snapshot(): AuthSnapshot;
  reload(): Promise<AuthSnapshot>;
  /**
   * Builds, commits and swaps. With a `plan` function, the candidate is resolved inside the serial queue — after every
   * earlier save has committed — so two saves of different sections never leave the running instance behind the
   * database (the second one's candidate includes the first one's row). Pass settings directly only when nothing
   * else can be saving (tests).
   */
  apply(settings: EffectiveSettings, commit: () => void): Promise<ApplyResult<never>>;
  apply<R extends string>(plan: () => ApplyPlan<R>): Promise<ApplyResult<R>>;
  retryIfUnreachable(): void;
};
type Deps = {
  config: Config; db: Db; cipher: Cipher; audit: Audit; oidcRejections: OidcRejections;
  /** First-run setup: lets the first OIDC sign-in of a live setup session become the first admin (every instance built). */
  setup?: SetupGate;
  /** Defaults to a new store; see {@link AuthHolder.seenGroups}. */
  seenGroups?: SeenGroups;
  log: Pick<Logger, 'info' | 'warn' | 'error'>; now?: () => number;
  /** How long an instance's plugin init (OIDC discovery) may take; tests shorten it. Default {@link AUTH_INIT_TIMEOUT_MS}. */
  initTimeoutMs?: number;
};
const RETRY_MS = 60_000;
/**
 * The longest a build waits for Better Auth's plugin init. genericOAuth's discovery fetch has no timeout of its own, so
 * an IdP that accepts the connection and never answers would otherwise stall the start (and a settings save) for minutes.
 */
export const AUTH_INIT_TIMEOUT_MS = 5_000;
const TIMED_OUT = Symbol('timed out');

/** `p`, or TIMED_OUT after `ms`. The timer never keeps the process alive and is cleared when `p` settles first. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((r) => { timer = setTimeout(() => r(TIMED_OUT), ms); timer.unref(); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(timer); }
}
/** An error's name only: a build error's message could carry configuration (never log the client secret). */
const errName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown');

/**
 * The one Better Auth instance in use, swappable. Better Auth bakes OIDC into the instance at creation, so a settings
 * change builds a new instance, awaits its plugin init (the upstream discovery), and only then swaps one immutable
 * snapshot. A build that throws or (for `apply`) whose provider did not load changes nothing. Consumers call
 * `snapshot()`/`current` per request: a request keeps the instance it started with, and nothing module-level in
 * better-auth 1.7.6 is tied to one instance (see the plan's Q1). Builds are serialised.
 */
export async function createAuthHolder(d: Deps): Promise<AuthHolder> {
  const now = d.now ?? Date.now;
  const seenGroups = d.seenGroups ?? createSeenGroups();
  let generation = 0;
  let lastTry = now();
  const initTimeoutMs = d.initTimeoutMs ?? AUTH_INIT_TIMEOUT_MS;
  let chain: Promise<unknown> = Promise.resolve();
  /** Builds queued or running: the background retry never queues another one behind them. */
  let busy = 0;
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    busy++;
    const run = chain.then(fn, fn).finally(() => { busy--; });
    chain = run.catch(() => undefined);
    return run;
  };

  /**
   * A Better Auth instance for `config`, initialised. When the init (OIDC discovery) does not finish in time, the
   * instance is dropped — every request to it would wait on that init — and one without OIDC is built instead.
   */
  async function instance(config: Config): Promise<{ auth: Auth; loaded: boolean }> {
    const auth = createAuth(config, d.db, { audit: d.audit, oidcRejections: d.oidcRejections, seenGroups, ...(d.setup ? { setup: d.setup } : {}) });
    const init = auth.$context; // runs plugin init: genericOAuth discovery (skips the provider on failure, never throws)
    const ctx = await within(init, initTimeoutMs);
    if (ctx !== TIMED_OUT) return { auth, loaded: !config.oidc || ctx.socialProviders.some((p) => p.id === OIDC_PROVIDER_ID) };
    init.catch(() => undefined); // the abandoned init may still settle later; nothing waits on it
    if (!config.oidc) throw new Error('auth init timed out');
    d.log.warn({ timeoutMs: initTimeoutMs }, 'single sign-on provider did not answer discovery in time; continuing without it');
    return { auth: (await instance({ ...config, oidc: undefined })).auth, loaded: false };
  }

  /** Builds and initialises an instance for `settings`; `loaded` says whether the configured OIDC provider registered. */
  async function build(settings: EffectiveSettings): Promise<{ snap: AuthSnapshot; loaded: boolean }> {
    const config = effectiveConfig(d.config, settings);
    const { auth, loaded } = await instance(config);
    const problems: SettingsProblem[] = loaded ? [...settings.problems] : [...settings.problems, 'oidc_unreachable'];
    // Password login switched off in the UI stays on while no OIDC provider is usable (nobody could sign in otherwise).
    const usable = Boolean(config.oidc) && loaded;
    const forced = !usable && !settings.localLogin && settings.source.localLogin === 'ui';
    if (forced) problems.push('local_login_forced');
    const localLogin = forced ? true : settings.localLogin;
    return {
      loaded,
      snap: {
        auth, settings: { ...settings, localLogin, problems }, config: { ...config, localLogin, oidc: loaded ? config.oidc : undefined },
        generation: generation + 1, handler: toNodeHandler(auth),
      },
    };
  }

  /**
   * The boot build. DB settings never stop the start: when a UI-managed OIDC configuration makes the build throw, the
   * instance is built without it (`oidc_invalid`). An env-managed one still throws (env keeps failing fast).
   */
  async function boot(): Promise<AuthSnapshot> {
    const settings = resolveSettings(d.config, d.db, d.cipher);
    try {
      return (await build(settings)).snap;
    } catch (err) {
      if (settings.source.oidc !== 'ui') throw err;
      d.log.error({ err: { name: errName(err) } }, 'saved single sign-on settings could not be applied; starting without single sign-on');
      return (await build({ localLogin: settings.localLogin, source: settings.source, problems: [...settings.problems, 'oidc_invalid'] })).snap;
    }
  }

  let snap = await boot();
  generation = snap.generation;
  const swap = (next: AuthSnapshot): AuthSnapshot => { snap = next; generation = next.generation; return next; };
  if (snap.settings.problems.length) d.log.warn({ problems: snap.settings.problems }, 'sign-in settings problem (see Settings)');

  const reload = (): Promise<AuthSnapshot> => serial(async () => {
    lastTry = now();
    return swap((await build(resolveSettings(d.config, d.db, d.cipher))).snap);
  });

  return {
    get current() { return snap.auth; },
    seenGroups,
    snapshot: () => snap,
    reload,
    /**
     * Save flow, all inside the serial queue: resolve the plan (a refusal ends here), build a candidate for its
     * settings, refuse it when the OIDC provider did not load (nothing committed), otherwise run `commit` (a synchronous
     * DB transaction) and swap, in that order. A plan, build or commit that throws rejects without swapping.
     */
    apply: <R extends string>(a: EffectiveSettings | (() => ApplyPlan<R>), commit?: () => void): Promise<ApplyResult<R>> => serial(async () => {
      const plan: ApplyPlan<R> = typeof a === 'function' ? a() : { settings: a, commit: commit ?? (() => undefined) };
      if ('refused' in plan) return { ok: false as const, reason: plan.refused };
      const { snap: next, loaded } = await build(plan.settings);
      if (!loaded) return { ok: false as const, reason: 'oidc_unloadable' as const };
      plan.commit();
      d.log.info({ generation: next.generation }, 'sign-in settings applied');
      return { ok: true as const, snapshot: swap(next) };
    }),
    /**
     * Called from the sign-in and invite pages: an IdP that was unreachable is retried in the background, at most once a
     * minute, and never while a build is already queued or running (retries do not pile up behind a slow IdP).
     */
    retryIfUnreachable() {
      if (!snap.settings.problems.includes('oidc_unreachable') || busy > 0 || now() - lastTry < RETRY_MS) return;
      lastTry = now();
      reload().catch((err: unknown) => { d.log.error({ err: { name: errName(err) } }, 'sign-in settings reload failed'); });
    },
  };
}
