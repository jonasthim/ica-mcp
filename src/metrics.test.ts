import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestCtx } from './test-helpers.js';

let t: TestCtx;
beforeAll(async () => { t = await startTestApp(); });
afterAll(async () => { await t.close(); });

describe('ops endpoints', () => {
  it('healthz reports db ok and a reachable jwks', async () => {
    const j = (await (await fetch(`${t.url}/healthz`)).json()) as { ok: boolean; db: string; jwks: string };
    expect(j).toMatchObject({ ok: true, db: 'ok', jwks: 'ok' });
  });
  it('metrics exposes build info and request counts', async () => {
    await fetch(`${t.url}/healthz`);
    const text = await (await fetch(`${t.url}/metrics`)).text();
    expect(text).toContain('ica_hub_build_info');
    expect(text).toMatch(/ica_hub_http_requests_total\{[^}]*route="\/healthz"/);
  });
  it('collapses unmatched paths to a bounded metrics label instead of the raw path', async () => {
    const res = await fetch(`${t.url}/definitely-not-a-route/xyz`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    const text = await (await fetch(`${t.url}/metrics`)).text();
    expect(text).toMatch(/ica_hub_http_requests_total\{[^}]*route="unmatched"/);
    expect(text).not.toContain('definitely-not-a-route');
  });
  it('collapses the /auth wildcard subtree to a single metrics label', async () => {
    await fetch(`${t.url}/auth/jwks`);
    const text = await (await fetch(`${t.url}/metrics`)).text();
    expect(text).toMatch(/ica_hub_http_requests_total\{[^}]*route="\/auth\/\*"/);
  });
  it('metrics declares the ICA session gauges', async () => {
    const text = await (await fetch(`${t.url}/metrics`)).text();
    for (const name of ['ica_hub_ica_sessions', 'ica_hub_ica_app_upkeep_enabled', 'ica_hub_ica_session_healthy', 'ica_hub_ica_session_expires_timestamp_seconds', 'ica_hub_ica_app_last_refresh_timestamp_seconds', 'ica_hub_ica_app_window_end_timestamp_seconds', 'ica_hub_ica_web_login_state', 'ica_hub_ica_purchase_history_available', 'ica_hub_ica_login_state_checked_timestamp_seconds']) expect(text).toContain(`# TYPE ${name} gauge`);
    expect(text).toContain('ica_hub_ica_app_upkeep_enabled 1');
  });
});

describe('METRICS_ENABLED=false', () => {
  it('does not serve /metrics', async () => {
    const off = await startTestApp({ METRICS_ENABLED: 'false' });
    try {
      expect(off.config.metricsEnabled).toBe(false);
      expect((await fetch(`${off.url}/metrics`)).status).toBe(404);
    } finally { await off.close(); }
  });
});
