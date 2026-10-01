import { Registry } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import { closeDb, openDb, schema } from '../db/index.js';
import { APP_SESSION_EXPIRED } from '../ica/app-session.js';
import { WEB_SESSION_LOGGED_OUT } from '../ica/web-session.js';
import { metricAccount, registerSessionMetrics } from './metrics.js';

const T = '2026-09-30T10:00:00.000Z';
const secs = (iso: string) => Date.parse(iso) / 1000;
const ACC = '5f0c2a8e-3b1d-4c6f-9a7e-2d4b6c8e0f13';
const ACC2 = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';

function setup(o?: Parameters<typeof registerSessionMetrics>[2]) {
  const db = openDb(':memory:');
  const registry = new Registry();
  registerSessionMetrics(registry, db, o);
  return { db, registry };
}

describe('registerSessionMetrics', () => {
  it('exposes expiry, last refresh, window end, health and purchase history per account, read at scrape time', async () => {
    const { db, registry } = setup();
    db.insert(schema.icaAccount).values({ id: ACC, displayName: 'Annafakename', createdAt: T, updatedAt: T }).run();
    db.insert(schema.icaSession).values([
      { id: 'a', icaAccountId: ACC, kind: 'app', stateEnc: 'v1.x', expiresAt: '2026-10-30T14:05:00.000Z', connectedAt: T, refreshedAt: '2026-09-30T14:05:00.000Z', lastError: null, updatedAt: T },
      { id: 'w', icaAccountId: ACC, kind: 'web', stateEnc: 'v1.y', expiresAt: '2026-12-28T10:00:00.000Z', connectedAt: T, loginState: 1, loginStateAt: T, lastError: 'ICA answered HTTP 502', updatedAt: T },
    ]).run();
    const a = metricAccount(ACC);
    const text = await registry.metrics();
    expect(text).toContain(`ica_hub_ica_session_expires_timestamp_seconds{account="${a}",kind="app"} ${secs('2026-10-30T14:05:00.000Z')}`);
    expect(text).toContain(`ica_hub_ica_session_expires_timestamp_seconds{account="${a}",kind="web"} ${secs('2026-12-28T10:00:00.000Z')}`);
    expect(text).toContain(`ica_hub_ica_app_last_refresh_timestamp_seconds{account="${a}"} ${secs('2026-09-30T14:05:00.000Z')}`);
    expect(text).toContain(`ica_hub_ica_app_window_end_timestamp_seconds{account="${a}"} ${secs(T) + 4 * 3600}`);
    expect(text).toContain(`ica_hub_ica_session_healthy{account="${a}",kind="app"} 1`);
    expect(text).toContain(`ica_hub_ica_session_healthy{account="${a}",kind="web"} 0`);
    expect(text).toContain(`ica_hub_ica_purchase_history_available{account="${a}"} 0`);
    expect(text).toContain(`ica_hub_ica_web_login_state{account="${a}"} 1`);
    expect(text).toContain(`ica_hub_ica_login_state_checked_timestamp_seconds{account="${a}"} ${secs(T)}`);
    expect(text).not.toContain('Annafakename');
    db.delete(schema.icaAccount).run();
    expect(await registry.metrics()).not.toContain(a); // no label outlives a disconnect
    closeDb(db);
  });

  it('never exports an account id, user id or email: the account label is a short one-way hash', async () => {
    const { db, registry } = setup();
    db.insert(schema.icaAccount).values({ id: ACC, displayName: 'A', createdAt: T, updatedAt: T }).run();
    db.insert(schema.icaSession).values({ id: 'a', icaAccountId: ACC, kind: 'app', stateEnc: 'v1.x', expiresAt: T, refreshedAt: T, connectedAt: T, updatedAt: T }).run();
    const text = await registry.metrics();
    expect(metricAccount(ACC)).toMatch(/^[0-9a-f]{12}$/);
    expect(metricAccount(ACC)).not.toBe(metricAccount(ACC2));
    expect(metricAccount(ACC)).toBe(metricAccount(ACC)); // stable across scrapes and restarts
    expect(text).toContain(metricAccount(ACC));
    for (const part of ACC.split('-')) expect(text).not.toContain(part);
    closeDb(db);
  });

  it('counts sessions per kind and health (ok, error, reconnect), with zeros so the series always exist', async () => {
    const { db, registry } = setup();
    expect(await registry.metrics()).toContain('ica_hub_ica_sessions{kind="app",health="ok"} 0');
    db.insert(schema.icaAccount).values([ACC, ACC2].map((id) => ({ id, displayName: 'A', createdAt: T, updatedAt: T }))).run();
    db.insert(schema.icaSession).values([
      { id: 'a1', icaAccountId: ACC, kind: 'app', stateEnc: 'v1.x', lastError: null, updatedAt: T },
      { id: 'a2', icaAccountId: ACC2, kind: 'app', stateEnc: 'v1.x', lastError: APP_SESSION_EXPIRED, updatedAt: T },
      { id: 'w1', icaAccountId: ACC, kind: 'web', stateEnc: 'v1.y', lastError: 'app token refresh failed (network)', updatedAt: T },
      { id: 'w2', icaAccountId: ACC2, kind: 'web', stateEnc: 'v1.y', lastError: WEB_SESSION_LOGGED_OUT, updatedAt: T },
    ]).run();
    const text = await registry.metrics();
    for (const [kind, health, n] of [['app', 'ok', 1], ['app', 'error', 0], ['app', 'reconnect', 1], ['web', 'ok', 0], ['web', 'error', 1], ['web', 'reconnect', 1]] as const) {
      expect(text).toContain(`ica_hub_ica_sessions{kind="${kind}",health="${health}"} ${n}`);
    }
    closeDb(db);
  });

  it('a scrape runs one query for all the gauges, and the next scrape reads afresh', async () => {
    const { db, registry } = setup();
    const select = vi.spyOn(db, 'select');
    await registry.metrics();
    expect(select).toHaveBeenCalledTimes(1);
    db.insert(schema.icaAccount).values({ id: ACC, displayName: 'A', createdAt: T, updatedAt: T }).run();
    db.insert(schema.icaSession).values({ id: 'a', icaAccountId: ACC, kind: 'app', stateEnc: 'v1.x', expiresAt: T, updatedAt: T }).run();
    expect(await registry.metrics()).toContain('ica_hub_ica_sessions{kind="app",health="ok"} 1');
    expect(select).toHaveBeenCalledTimes(2);
    closeDb(db);
  });

  it('a session without connected_at counts as past the window', async () => {
    const { db, registry } = setup();
    db.insert(schema.icaAccount).values({ id: 'acc-old', displayName: 'A', createdAt: T, updatedAt: T }).run();
    db.insert(schema.icaSession).values({ id: 'a', icaAccountId: 'acc-old', kind: 'app', stateEnc: 'v1.x', expiresAt: T, updatedAt: T }).run();
    expect(await registry.metrics()).toContain(`ica_hub_ica_app_window_end_timestamp_seconds{account="${metricAccount('acc-old')}"} 0`);
    closeDb(db);
  });

  it('reports whether the interval upkeep runs (ICA_HUB_APP_UPKEEP), so alerts that assume it can be gated', async () => {
    const on = setup();
    expect(await on.registry.metrics()).toContain('ica_hub_ica_app_upkeep_enabled 1');
    closeDb(on.db);
    const off = setup({ appUpkeep: 'on-demand' });
    expect(await off.registry.metrics()).toContain('ica_hub_ica_app_upkeep_enabled 0');
    closeDb(off.db);
  });
});
