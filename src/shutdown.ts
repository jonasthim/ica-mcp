import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { closeDb, type Db } from './db/index.js';

/** The whole shutdown: the HTTP drain (one ICA call is at most 15 s) plus margin for the keeper drain. */
export const SHUTDOWN_TIMEOUT_MS = 20_000;
/** In-flight requests get this long to finish; then their connections are cut and the drain goes on. */
export const SHUTDOWN_HTTP_TIMEOUT_MS = 15_000;
/** While HTTP drains, idle keep-alive connections (also ones whose last request just finished) are closed this often. */
const IDLE_SWEEP_MS = 100;
/** A repeat of the same signal within this long is one keypress relayed twice (tsx watch), not a request to force. */
const REPEAT_SIGNAL_MS = 1_000;

export type ShutdownDeps = {
  server: Server;
  /** startAppUpkeep's stop: stops scheduling now, resolves when a running pass has finished. */
  stopUpkeep: () => Promise<void>;
  /**
   * The process's one keeper (appKeeper(app)). `beginClosing` (at the signal) stops new refreshes and jar uses from
   * starting; `idle` resolves when the in-flight ones have settled.
   */
  keeper: { beginClosing(): void; idle(): Promise<void> };
  db: Db;
  /** Given signal names, step names, ms and error names only: never a token. */
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  /** Plain timers to clear at once (audit pruning). */
  stopTimers?: (() => void)[];
  /** Default SHUTDOWN_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Default SHUTDOWN_HTTP_TIMEOUT_MS. */
  httpTimeoutMs?: number;
  exit?: (code: number) => void;
  /** Epoch ms (tests). */
  now?: () => number;
};

type Step = 'http' | 'upkeep' | 'keeper' | 'db';

/**
 * The SIGINT/SIGTERM handler. At the signal the keeper stops starting new token refreshes and web jar uses (tool calls
 * then get "ica-hub is restarting"), the upkeep stops scheduling, and responses still to be written close their
 * connection (`Connection: close`). Then, in order: stop accepting HTTP and let in-flight requests finish (at most
 * `httpTimeoutMs`, then their connections are cut), await the upkeep's running pass, await the keeper's in-flight
 * refreshes and jar uses (so a rotated refresh token always reaches the database), close the database, exit 0. One
 * info line per step with its ms. The whole sequence is bounded by `timeoutMs`: when it is hit, a warn names the step
 * still running, the database is closed anyway and the exit code is 1 (also after a step that failed). A second,
 * different signal (or the same one again after a second) during the shutdown exits at once (code 1).
 *
 * Create it right after `listen`: it tracks the responses in flight from then on.
 */
export function createShutdown(o: ShutdownDeps): (signal: string) => void {
  const timeoutMs = o.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const httpTimeoutMs = o.httpTimeoutMs ?? SHUTDOWN_HTTP_TIMEOUT_MS;
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const now = o.now ?? Date.now;
  let started = false; let finished = false;
  let first: { signal: string; at: number } | undefined;
  /** Responses not yet finished, so the shutdown can make them close their keep-alive connection. */
  const open = new Set<ServerResponse>();
  o.server.prependListener('request', (_req: IncomingMessage, res: ServerResponse) => {
    if (started) { res.shouldKeepAlive = false; return; }
    open.add(res);
    const done = (): void => { open.delete(res); };
    res.once('finish', done); res.once('close', done);
  });
  let step: Step = 'http';
  let failed = false;

  const closeDbOnce = (): void => {
    if (!o.db.$client.open) return;
    try { closeDb(o.db); } catch (e) { o.log.warn({ step: 'db', err: { name: e instanceof Error ? e.name : 'unknown' } }, 'shutdown: closing the database failed'); }
  };
  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    closeDbOnce();
    exit(code);
  };

  /** Run one step, log its ms; a failure is logged and the shutdown goes on. */
  async function run(name: Step, fn: () => Promise<void>): Promise<void> {
    step = name;
    const t0 = Date.now();
    try { await fn(); } catch (e) {
      failed = true;
      o.log.warn({ step: name, ms: Date.now() - t0, err: { name: e instanceof Error ? e.name : 'unknown' } }, 'shutdown step failed');
      return;
    }
    o.log.info({ step: name, ms: Date.now() - t0 }, `shutdown: ${name} done`);
  }

  function closeHttp(): Promise<void> {
    return new Promise<void>((resolve) => {
      const sweep = setInterval(() => o.server.closeIdleConnections(), IDLE_SWEEP_MS);
      sweep.unref();
      const cut = setTimeout(() => {
        o.log.warn({ step: 'http', timeoutMs: httpTimeoutMs }, 'shutdown: requests still running; cutting their connections');
        o.server.closeAllConnections();
      }, httpTimeoutMs);
      o.server.close(() => { clearInterval(sweep); clearTimeout(cut); resolve(); });
      o.server.closeIdleConnections();
    });
  }

  async function sequence(stoppingUpkeep: Promise<void>): Promise<void> {
    await run('http', closeHttp);
    await run('upkeep', () => stoppingUpkeep);
    await run('keeper', () => o.keeper.idle());
    if (finished) return;
    step = 'db';
    const t0 = Date.now();
    closeDbOnce();
    o.log.info({ step: 'db', ms: Date.now() - t0 }, 'shutdown: db done');
    finish(failed ? 1 : 0);
  }

  return (signal: string): void => {
    if (finished) return;
    if (started) {
      if (first && signal === first.signal && now() - first.at < REPEAT_SIGNAL_MS) return; // the same keypress, relayed twice
      o.log.warn({ signal, step }, 'second signal during shutdown: exiting now');
      finish(1);
      return;
    }
    started = true;
    first = { signal, at: now() };
    o.log.info({ signal, timeoutMs }, 'shutting down');
    // No new token refresh or web jar use from here on: one started now could be cut mid-rotation at exit.
    o.keeper.beginClosing();
    for (const res of open) res.shouldKeepAlive = false;
    open.clear();
    for (const stop of o.stopTimers ?? []) stop();
    // Stop scheduling upkeep passes now; the running one is awaited after the HTTP drain.
    let stoppingUpkeep: Promise<void>;
    try { stoppingUpkeep = o.stopUpkeep(); } catch (e) { stoppingUpkeep = Promise.reject(e); }
    stoppingUpkeep.catch(() => {}); // handled (logged) by its step
    const bound = setTimeout(() => {
      o.log.warn({ step, timeoutMs }, 'shutdown timed out; closing the database anyway');
      finish(1);
    }, timeoutMs); // ref'd: the bound fires even if nothing else keeps the process alive
    void sequence(stoppingUpkeep).finally(() => clearTimeout(bound));
  };
}
