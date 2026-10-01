import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '../db/index.js';
import type { AppUpkeepMode } from '../config.js';
import { APP_SESSION_EXPIRED, APP_SESSION_UNREADABLE } from '../ica/app-session.js';
import type { KeeperLog, SessionKeeper } from './keeper.js';

/** How often the upkeep looks for due app sessions. */
export const UPKEEP_TICK_MS = 60_000;
/** Like the ICA app: a connected app session is refreshed about every 10 minutes, whatever its token's lifetime. */
export const UPKEEP_REFRESH_EVERY_MS = 10 * 60_000;
/** Each session is due up to this much before its 10 minutes are up, spread per session and refresh (upkeepJitterMs). */
export const UPKEEP_JITTER_MS = 2 * 60_000;
/** After a failed refresh the session waits 2, 4, 8 … minutes, at most an hour; a successful refresh resets it. */
export const UPKEEP_BACKOFF_BASE_MS = 2 * 60_000;
export const UPKEEP_BACKOFF_MAX_MS = 60 * 60_000;
/**
 * After a successful upkeep refresh the session is not refreshed by the upkeep again for this long, whatever
 * refreshed_at says (a refresh that lost its compare-and-swap, a clock step): the upkeep can never loop fast.
 */
const UPKEEP_MIN_GAP_MS = UPKEEP_REFRESH_EVERY_MS - UPKEEP_JITTER_MS;
/** Recorded errors that only a new BankID login fixes: refreshing again cannot help. */
const DEAD = new Set<string>([APP_SESSION_EXPIRED, APP_SESSION_UNREADABLE]);

/**
 * A stable offset in [0, UPKEEP_JITTER_MS) per account and refresh, so the household's sessions do not refresh in
 * lockstep or on the minute, and a restart does not change the schedule.
 */
export const upkeepJitterMs = (account: string, refreshedAt: string | null): number =>
  createHash('sha256').update(`${account}|${refreshedAt ?? ''}`).digest().readUInt32BE(0) % UPKEEP_JITTER_MS;

/** The wait after the `failures`-th failed refresh in a row. */
export const backoffMs = (failures: number): number =>
  Math.min(UPKEEP_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), UPKEEP_BACKOFF_MAX_MS);

/**
 * Per ICA account: failed upkeep refreshes in a row (0 after a success), the earliest time the upkeep may refresh it
 * again, and the app session row this applies to (a BankID reconnect stores a new row, which starts afresh). Memory
 * only; one entry per connected account at most (entries of disconnected or reconnected sessions are dropped).
 */
export type UpkeepBackoff = Map<string, { failures: number; retryAt: number; row: string }>;

/**
 * The ICA accounts whose app session should be refreshed now: every connected app session (not known dead) whose
 * last refresh is 8–10 minutes old or older (never refreshed, or stamped more than a cycle in the future after a
 * backwards clock step: at once), unless it is backing off after a failure or was refreshed by the upkeep less than 8
 * minutes ago.
 */
export function appSessionsDue(db: Db, now: Date, backoff: UpkeepBackoff = new Map()): string[] {
  return dueOf(appRows(db), now.getTime(), backoff).map((r) => r.account);
}

type AppRow = ReturnType<typeof appRows>[number];
const appRows = (db: Db) =>
  db.select({ id: schema.icaSession.id, account: schema.icaSession.icaAccountId, refreshedAt: schema.icaSession.refreshedAt, lastError: schema.icaSession.lastError })
    .from(schema.icaSession).where(eq(schema.icaSession.kind, 'app')).all();

function dueOf(rows: AppRow[], t: number, backoff: UpkeepBackoff): AppRow[] {
  return rows
    .filter((r) => !(r.lastError !== null && DEAD.has(r.lastError)))
    .filter((r) => { const b = backoff.get(r.account); return !b || b.row !== r.id || b.retryAt <= t; })
    .filter((r) => {
      const last = r.refreshedAt ? Date.parse(r.refreshedAt) : Number.NaN;
      // A last refresh more than a cycle in the future means the clock stepped backwards: due now (the refresh
      // stamps the current time), instead of waiting until the clock catches up.
      if (Number.isNaN(last) || last > t + UPKEEP_REFRESH_EVERY_MS) return true;
      return last + UPKEEP_REFRESH_EVERY_MS - upkeepJitterMs(r.account, r.refreshedAt) <= t;
    });
}

/**
 * Clock steps backwards: a wait longer than any the upkeep sets (the backoff maximum) is cut back to the wait the
 * entry stands for (its backoff, or the 8-minute hold after a success), so the upkeep never stalls until the clock
 * catches up.
 */
function clampBackoff(backoff: UpkeepBackoff, t: number): void {
  for (const b of backoff.values()) {
    if (b.retryAt > t + UPKEEP_BACKOFF_MAX_MS) b.retryAt = t + (b.failures > 0 ? backoffMs(b.failures) : UPKEEP_MIN_GAP_MS);
  }
}

const currentAppRowId = (db: Db, account: string): string | undefined =>
  db.select({ id: schema.icaSession.id }).from(schema.icaSession)
    .where(and(eq(schema.icaSession.icaAccountId, account), eq(schema.icaSession.kind, 'app'))).get()?.id;

type UpkeepDeps = {
  db: Db;
  /** The process's one keeper (appKeeper(app)): its refresh is single-flight with tool calls and spends no user's rate limit. */
  keeper: Pick<SessionKeeper, 'refreshAppNow'>;
  /** pino's Logger satisfies it. Given account ids, counts and error names only: never a token. */
  log: KeeperLog;
  now?: () => Date;
  backoff?: UpkeepBackoff;
  /** Aborted: the pass ends before its next session (shutdown). */
  signal?: AbortSignal;
};

/**
 * One pass: refresh every due app session through the keeper (single-flight with tool calls; the refresh itself
 * writes by compare-and-swap). A failure backs that session off; a success resets it and holds the session for 8
 * minutes. Never throws for one session.
 */
export async function runAppUpkeep(o: UpkeepDeps): Promise<{ refreshed: number; failed: number }> {
  const now = o.now ?? (() => new Date());
  const backoff: UpkeepBackoff = o.backoff ?? new Map();
  const rows = appRows(o.db);
  const rowOf = new Map(rows.map((r) => [r.account, r.id]));
  for (const [account, b] of backoff) if (rowOf.get(account) !== b.row) backoff.delete(account);
  const t = now().getTime();
  clampBackoff(backoff, t);
  let refreshed = 0; let failed = 0;
  for (const { account, id: row } of dueOf(rows, t, backoff)) {
    if (o.signal?.aborted) break;
    // The pass works from one snapshot; an earlier refresh in it can take long enough for this account to be
    // disconnected or reconnected (a new row, freshly issued tokens): then leave it to the next pass.
    if (currentAppRowId(o.db, account) !== row) continue;
    try {
      await o.keeper.refreshAppNow(account);
      backoff.set(account, { failures: 0, retryAt: now().getTime() + UPKEEP_MIN_GAP_MS, row });
      refreshed += 1;
    } catch (e) {
      failed += 1;
      const failures = (backoff.get(account)?.failures ?? 0) + 1;
      backoff.set(account, { failures, retryAt: now().getTime() + backoffMs(failures), row });
      o.log.warn({ account, failures, err: { name: e instanceof Error ? e.name : 'unknown' } }, 'app upkeep refresh failed');
    }
  }
  if (refreshed || failed) o.log.info({ refreshed, failed }, 'app upkeep');
  return { refreshed, failed };
}

/**
 * Starts the app-token upkeep: a pass now and then every `everyMs` (default a minute). Passes never overlap; the timer
 * is unref'd. Returns `stop` (idempotent; the graceful shutdown awaits it): clears the timer, ends a running pass
 * before its next session and resolves once that pass has finished — never in the middle of a refresh, whose rotated
 * refresh token must reach the database. With `mode: 'on-demand'` (ICA_HUB_APP_UPKEEP) nothing is scheduled: app
 * tokens are then refreshed only when a tool uses them.
 */
export function startAppUpkeep(o: Omit<UpkeepDeps, 'backoff' | 'signal'> & { everyMs?: number; mode?: AppUpkeepMode }): () => Promise<void> {
  if (o.mode === 'on-demand') {
    o.log.info({}, 'app upkeep off (ICA_HUB_APP_UPKEEP=on-demand): app tokens refresh only when a tool uses them');
    return () => Promise.resolve();
  }
  const backoff: UpkeepBackoff = new Map();
  const stopped = new AbortController();
  /** The running pass (never rejects), or undefined between passes. */
  let running: Promise<void> | undefined;
  const tick = (): void => {
    if (running || stopped.signal.aborted) return;
    running = (async () => {
      try { await runAppUpkeep({ ...o, backoff, signal: stopped.signal }); } catch (e) {
        o.log.warn({ err: { name: e instanceof Error ? e.name : 'unknown' } }, 'app upkeep failed');
      } finally { running = undefined; }
    })();
  };
  const h = setInterval(tick, o.everyMs ?? UPKEEP_TICK_MS);
  h.unref();
  tick();
  return () => { stopped.abort(); clearInterval(h); return running ?? Promise.resolve(); };
}
