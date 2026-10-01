import { createHash } from 'node:crypto';
import { Gauge, type Registry } from 'prom-client';
import { schema, type Db } from '../db/index.js';
import type { AppUpkeepMode } from '../config.js';
import { APP_SESSION_EXPIRED, APP_SESSION_UNREADABLE } from '../ica/app-session.js';
import { WEB_SESSION_LOGGED_OUT, WEB_SESSION_UNREADABLE } from '../ica/web-session.js';
import { appWindowEnd } from './keeper.js';

const secs = (iso: string | null): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t / 1000;
};

/**
 * The `account` label: a short one-way hash of our random ica_account uuid, so Prometheus (other retention, other
 * readers) never holds an account id, let alone an ICA id, user id, email or name. Stable across scrapes and restarts,
 * so per-account alerts and joins work. A log line's account (the uuid) maps to its label with
 * `printf 'ica-hub:%s' <uuid> | sha256sum | cut -c1-12` (docs/deployment.md).
 */
export const metricAccount = (icaAccountId: string): string =>
  createHash('sha256').update(`ica-hub:${icaAccountId}`).digest('hex').slice(0, 12);

/** Recorded errors that only a new BankID login fixes (the /admin/ica "Needs reconnect" set, less the view-only one). */
const RECONNECT = new Set<string>([WEB_SESSION_LOGGED_OUT, WEB_SESSION_UNREADABLE, APP_SESSION_EXPIRED, APP_SESSION_UNREADABLE]);
/** The kinds whose count series always exist (zeros included), so an absent() guard can tell "none" from "broken". */
const COUNTED_KINDS = ['app', 'web'] as const;
const HEALTHS = ['ok', 'error', 'reconnect'] as const;
const healthOf = (lastError: string | null): (typeof HEALTHS)[number] => (lastError === null ? 'ok' : RECONNECT.has(lastError) ? 'reconnect' : 'error');

/**
 * ICA session gauges, read from ica_session at scrape time: never stale, and no label outlives a disconnect.
 * `account` is metricAccount(ica_account uuid). Web rows: the cookie expiry, the loginState and the purchase-history
 * flag; app rows: the current access token's expiry, its last refresh and the 4-hour window end. Plus label-free
 * aggregates: session counts per kind and health, and whether the interval upkeep runs.
 */
export function registerSessionMetrics(registry: Registry, db: Db, o: { appUpkeep?: AppUpkeepMode } = {}): void {
  const query = () => db.select({
    account: schema.icaSession.icaAccountId, kind: schema.icaSession.kind, expiresAt: schema.icaSession.expiresAt, lastError: schema.icaSession.lastError,
    connectedAt: schema.icaSession.connectedAt, refreshedAt: schema.icaSession.refreshedAt, loginState: schema.icaSession.loginState, loginStateAt: schema.icaSession.loginStateAt,
  }).from(schema.icaSession).all().map((r) => ({ ...r, account: metricAccount(r.account) }));
  /**
   * One SELECT per scrape: prom-client calls every gauge's collect() synchronously, one after the other, when a scrape
   * starts, so the rows are shared until the next microtask and read afresh by the next scrape (never stale).
   */
  let scraped: ReturnType<typeof query> | undefined;
  const rows = () => {
    if (!scraped) { scraped = query(); queueMicrotask(() => { scraped = undefined; }); }
    return scraped;
  };
  const registers = [registry];
  new Gauge({
    name: 'ica_hub_ica_sessions', help: 'Stored ICA sessions per kind and health (ok; error: transient; reconnect: needs a BankID reconnect)', labelNames: ['kind', 'health'], registers,
    collect() {
      this.reset();
      const n = new Map<string, number>();
      for (const kind of COUNTED_KINDS) for (const health of HEALTHS) n.set(`${kind}|${health}`, 0);
      for (const r of rows()) { const k = `${r.kind}|${healthOf(r.lastError)}`; n.set(k, (n.get(k) ?? 0) + 1); }
      for (const [k, v] of n) { const [kind, health] = k.split('|') as [string, string]; this.set({ kind, health }, v); }
    },
  });
  new Gauge({
    name: 'ica_hub_ica_app_upkeep_enabled', help: '1 when the interval app-token upkeep runs (ICA_HUB_APP_UPKEEP=interval), 0 when on-demand', registers,
    collect() { this.set(o.appUpkeep === 'on-demand' ? 0 : 1); },
  });
  new Gauge({
    name: 'ica_hub_ica_session_healthy', help: '1 when the stored ICA session has no recorded error', labelNames: ['account', 'kind'], registers,
    collect() { this.reset(); for (const r of rows()) this.set({ account: r.account, kind: r.kind }, r.lastError === null ? 1 : 0); },
  });
  new Gauge({
    name: 'ica_hub_ica_session_expires_timestamp_seconds', help: 'When the stored ICA session expires (web: the cookie; app: the current access token)', labelNames: ['account', 'kind'], registers,
    collect() { this.reset(); for (const r of rows()) { const v = secs(r.expiresAt); if (v !== undefined) this.set({ account: r.account, kind: r.kind }, v); } },
  });
  new Gauge({
    name: 'ica_hub_ica_app_last_refresh_timestamp_seconds', help: 'When the ICA app tokens were last issued (connect or refresh)', labelNames: ['account'], registers,
    collect() { this.reset(); for (const r of rows()) { const v = r.kind === 'app' ? secs(r.refreshedAt) : undefined; if (v !== undefined) this.set({ account: r.account }, v); } },
  });
  new Gauge({
    name: 'ica_hub_ica_app_window_end_timestamp_seconds', help: "End of ICA's first 4-hour app-session window (0: connected before Phase 2, long past)", labelNames: ['account'], registers,
    collect() { this.reset(); for (const r of rows()) if (r.kind === 'app') this.set({ account: r.account }, appWindowEnd(r.connectedAt) / 1000); },
  });
  new Gauge({
    name: 'ica_hub_ica_web_login_state', help: 'The loginState ICA last reported for the web session (0 logged out, 1 logged in, 2 purchase history available)', labelNames: ['account'], registers,
    collect() { this.reset(); for (const r of rows()) if (r.kind === 'web' && r.loginState !== null) this.set({ account: r.account }, r.loginState); },
  });
  new Gauge({
    name: 'ica_hub_ica_purchase_history_available', help: '1 when ICA last reported loginState 2 for the web session (purchase history available)', labelNames: ['account'], registers,
    collect() { this.reset(); for (const r of rows()) if (r.kind === 'web' && r.loginState !== null) this.set({ account: r.account }, r.loginState === 2 ? 1 : 0); },
  });
  new Gauge({
    name: 'ica_hub_ica_login_state_checked_timestamp_seconds', help: 'When the web loginState was last checked', labelNames: ['account'], registers,
    collect() { this.reset(); for (const r of rows()) { const v = r.kind === 'web' ? secs(r.loginStateAt) : undefined; if (v !== undefined) this.set({ account: r.account }, v); } },
  });
}
