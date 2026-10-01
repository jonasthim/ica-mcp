import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_SECRETS } from '../../ica/test-fakes.js';
import { linkedIcaAccount } from '../../sessions/web-store.js';
import { startToolTest, type ToolTest } from '../../test-helpers.js';

let s: ToolTest;
beforeAll(async () => { s = await startToolTest(); });
afterAll(async () => { await s.close(); });
const SECRETS = Object.values(FAKE_SECRETS);
type Status = { linked: boolean; web: Record<string, unknown>; purchaseHistory: { available: boolean | null; loginState: number | null; checkedAt: string | null }; app: Record<string, string | boolean | null> };

describe('get_session_status', () => {
  it('reports a linked account with working web and app sessions, the app window, and never a secret or a name', async () => {
    const r = await s.alice.client.call('get_session_status');
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ linked: true, adminUrl: `${s.t.url}/admin/ica`, web: { connected: true, working: true, lastError: null }, purchaseHistory: { available: true, loginState: 2 }, app: { connected: true, working: true, lastError: null } });
    const app = (r.json as Status).app;
    expect(Date.parse(app.windowEndsAt as string) - Date.parse(app.connectedAt as string)).toBe(4 * 3_600_000);
    expect(app.lastRefreshAt).toBe(app.connectedAt);
    for (const v of SECRETS) expect(r.text).not.toContain(v);
  });

  it('status checks loginState live and never reports a stale "available"', async () => {
    const calls = s.fake.seen.userInfoCalls;
    s.fake.opts.loginState = 1;
    try {
      const r = (await s.alice.client.call('get_session_status')).json as Status;
      expect(r.purchaseHistory).toMatchObject({ available: false, loginState: 1 });
      expect((r as unknown as { purchaseHistoryNote: string }).purchaseHistoryNote).toContain('Reconnect with BankID');
    } finally { s.fake.opts.loginState = 2; }
    expect(s.fake.seen.userInfoCalls).toBe(calls + 1);
    expect(((await s.alice.client.call('get_session_status')).json as Status).purchaseHistory.available).toBe(true);
  });

  it('reports a dead web session as a problem, without failing', async () => {
    s.fake.opts.loginState = 0;
    try {
      const r = (await s.bob.client.call('get_session_status')).json as Status;
      expect(r.web).toMatchObject({ working: false, problem: 'needs-rescan', lastError: 'ICA session is no longer logged in' });
      expect(r.purchaseHistory).toMatchObject({ available: false, loginState: 0 });
    } finally { s.fake.opts.loginState = 2; }
  });

  it('user-information answering an unrecognised 4xx (404, 422) degrades the web section to a problem, without failing the whole call', async () => {
    for (const status of [404, 422]) {
      s.fake.opts.userInfo = { status, body: { error: 'nope' } };
      try {
        const r = await s.bob.client.call('get_session_status');
        expect(r.isError, String(status)).toBe(false);
        const j = r.json as Status;
        expect(j.linked, String(status)).toBe(true);
        expect(j.web, String(status)).toMatchObject({ working: false, problem: 'transient' });
        // The rest of the payload is still reported: the app section and the purchase-history flag survive.
        expect(j.app, String(status)).toMatchObject({ connected: true });
        expect(j.purchaseHistory, String(status)).toHaveProperty('available');
        for (const v of SECRETS) expect(r.text, String(status)).not.toContain(v);
      } finally { s.fake.opts.userInfo = undefined; }
    }
  });

  it('tells an unlinked user where to connect, without an error', async () => {
    expect(await s.carol.client.call('get_session_status')).toMatchObject({ isError: false, json: { linked: false, adminUrl: `${s.t.url}/admin/ica` } });
  });

  it('logs exactly one line per call, with tool, userId, status and ms only; no secret in any log line', async () => {
    const before = s.logs.length;
    await s.bob.client.call('get_session_status');
    const calls = s.logs.slice(before).map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === 'tool call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool: 'get_session_status', userId: s.bob.id, status: 'ok' });
    const all = s.logs.join('\n');
    for (const v of SECRETS) expect(all).not.toContain(v);
  });
});

describe('privacy: session status is built from named fields only', () => {
  /** Every key anywhere in a JSON value (object keys only). */
  const keysOf = (v: unknown): string[] =>
    Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : [];
  const ALLOWED = [
    'linked', 'adminUrl', 'web', 'connected', 'working', 'expiresAt', 'lastOkAt', 'lastError', 'problem',
    'purchaseHistory', 'available', 'loginState', 'checkedAt', 'purchaseHistoryNote',
    'app', 'connectedAt', 'accessExpiresAt', 'lastRefreshAt', 'windowEndsAt',
    'handla', 'blocked', 'retryInMinutes',
  ];

  it('returns only the allowed keys; no ICA account id, token, cookie or personnummer ever passes through', async () => {
    const accountId = linkedIcaAccount(s.t.db, s.alice.id)!.account.id;
    const r = await s.alice.client.call('get_session_status');
    expect([...new Set(keysOf(r.json))].filter((k) => !ALLOWED.includes(k))).toEqual([]);
    for (const v of [accountId, FAKE_SECRETS.personnummer, FAKE_SECRETS.firstName, ...SECRETS]) expect(r.text).not.toContain(v);
  });

  it('logs no personnummer, name or secret across a run of calls, and one tool-call line per call', async () => {
    const before = s.logs.length;
    await s.alice.client.call('get_session_status');
    await s.bob.client.call('get_session_status');
    await s.carol.client.call('get_session_status');
    const lines = s.logs.slice(before).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((l) => l.msg === 'tool call' && l.tool === 'get_session_status')).toHaveLength(3);
    const all = lines.map((l) => JSON.stringify(l)).join('\n');
    for (const v of [FAKE_SECRETS.personnummer, FAKE_SECRETS.firstName, ...SECRETS]) expect(all).not.toContain(v);
  });
});

describe('get_session_status rate limit', () => {
  it('spends one per-user ICA budget token for a linked user (its live web check is an ICA call)', async () => {
    const tight = await startToolTest({ icaRateLimit: { capacity: 1, refillPerSecond: 0.001 } });
    try {
      expect((await tight.alice.client.call('get_session_status')).isError).toBe(false);
      const r = await tight.alice.client.call('get_session_status');
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/Try again in \d+ s/);
    } finally { await tight.close(); }
  });
});
