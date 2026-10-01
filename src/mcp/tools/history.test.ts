import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_SECRETS, FAKE_WEB_ROUTES } from '../../ica/test-fakes.js';
import { linkedIcaAccount } from '../../sessions/web-store.js';
import { startToolTest, type ToolTest } from '../../test-helpers.js';

let s: ToolTest;
beforeAll(async () => { s = await startToolTest(); });
afterAll(async () => { await s.close(); });
const cpaCalls = (t: ToolTest = s) => t.fake.seen.paths.filter((p) => p.startsWith('/api/cpa/')).length;
const MONTHS = '/api/cpa/purchases/historical/me/monthsummaries';
const MONTH = (m: string) => `/api/cpa/purchases/historical/me/byyearmonth/${m}`;

describe('purchase history', () => {
  it('lists months newest first', async () => {
    expect((await s.alice.client.call('get_purchase_months')).json).toEqual({ months: [
      { month: '2026-09', spent: 310, saved: 0 }, { month: '2026-08', spent: 1445.5, saved: 23 }, { month: '2025-12', spent: 2210.75, saved: 118.4 },
    ] });
  });

  it('lists one month\'s receipt totals compactly, without transaction or store ids', async () => {
    const r = await s.alice.client.call('get_purchases', { month: '2026-08' });
    expect(r.json).toEqual({ month: '2026-08', count: 2, purchases: [
      { date: '2026-08-14', store: 'ICA Nära Fakeby', city: 'Fakeby', total: 412.5, discount: 23 },
      { date: '2026-08-02', store: 'ICA Kvantum Testköping', city: 'Testköping', total: 1033, discount: 0 },
    ] });
    for (const v of ['TX-FAKE-0001', '12345', 'transactionChanel', 'Butik']) expect(r.text).not.toContain(v);
  });

  it('says it has receipt totals, not the items bought', async () => {
    const d = (await s.alice.client.tools()).find((x) => x.name === 'get_purchases')!.description;
    expect(d).toContain('receipt totals per purchase, not the items bought');
  });

  it('discount falls back to discountValue; a zoned time is dated in Stockholm', async () => {
    const t = await startToolTest({ fake: { routes: { [MONTH('2026-09')]: { status: 200, body: { transactions: [
      { transactionDate: '2026-08-31T22:30:00Z', storeMarketingName: 'ICA Midnatt', discountValue: '4,50', transactionValue: '100,25' },
    ] } } } } });
    try {
      expect((await t.alice.client.call('get_purchases', { month: '2026-09' })).json).toEqual({ month: '2026-09', count: 1, purchases: [
        { date: '2026-09-01', store: 'ICA Midnatt', total: 100.25, discount: 4.5 },
      ] });
    } finally { await t.close(); }
  });

  it('a month ICA has no record for is said so, not shown as an empty month', async () => {
    const r = await s.alice.client.call('get_purchases', { month: '2024-01' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('get_purchase_months');
  });

  it('loginState 1 → needs a fresh BankID login, and no purchase call is made', async () => {
    s.fake.opts.loginState = 1;
    const before = cpaCalls();
    try {
      for (const [tool, args] of [['get_purchases', { month: '2026-08' }], ['get_purchase_months', {}]] as const) {
        const r = await s.alice.client.call(tool, args);
        expect(r.isError).toBe(true);
        expect(r.text).toContain('login level 1');
        expect(r.text).toContain(`${s.t.url}/admin/ica`);
        expect(r.text).toContain('"Reconnect with BankID"');
        expect(r.text).not.toContain('web session has ended');
      }
      expect(cpaCalls()).toBe(before);
      // Recorded as an observation, not as a dead session.
      expect(linkedIcaAccount(s.t.db, s.alice.id)!.web).toMatchObject({ loginState: 1, lastError: null });
    } finally { s.fake.opts.loginState = 2; }
  });

  it('a 403 despite loginState 2 re-checks and gives the same answer, never a reconnect of the session', async () => {
    s.fake.opts.cpaForbidden = true;
    const checks = s.fake.seen.userInfoCalls;
    try {
      const r = await s.alice.client.call('get_purchase_months');
      expect(r.isError).toBe(true);
      expect(r.text).toContain(`ICA refused purchase history although the session reports the right login level. Try a fresh BankID login once: open ${s.t.url}/admin/ica and choose "Reconnect with BankID", then ask again. If it keeps failing, tell the hub operator.`);
      expect(r.text).not.toContain('login level 1');
      expect(r.text).not.toContain('app access has ended');
      expect(r.text).not.toContain('web session has ended');
      expect(s.fake.seen.userInfoCalls - checks).toBe(2);
      // The re-check saw 2, but ICA refused: the flag is not upgraded to "available".
      expect(linkedIcaAccount(s.t.db, s.alice.id)!.web).toMatchObject({ loginState: null, lastError: null });
      const warn = s.logs.find((l) => l.includes('cpa-forbidden-at-level'))!;
      expect(JSON.parse(warn)).toMatchObject({ event: 'cpa-forbidden-at-level', status: 403, loginState: 2 });
      for (const v of ['/api/cpa', 'thSessionId', FAKE_SECRETS.thSessionId, 'cookie']) expect(warn).not.toContain(v);
    } finally { s.fake.opts.cpaForbidden = false; }
  });

  it('a logged-out web session is "Reconnect with BankID" (the session ended), not the step-up text', async () => {
    s.fake.opts.loginState = 0;
    try {
      const r = await s.bob.client.call('get_purchase_months');
      expect(r.isError).toBe(true);
      expect(r.text).toContain('web session has ended');
    } finally { s.fake.opts.loginState = 2; }
  });

  it('a member without an ICA account is told to connect one', async () => {
    const r = await s.carol.client.call('get_purchase_months');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('No ICA account is connected');
  });

  it('rejects a malformed month before any ICA call and never leaks a secret', async () => {
    const before = cpaCalls();
    for (const month of ['2026-13', '2026-8', '26-08', '2026-08/../x', '']) {
      expect((await s.alice.client.call('get_purchases', { month })).isError, month).toBe(true);
    }
    expect(cpaCalls()).toBe(before);
    for (const v of Object.values(FAKE_SECRETS)) expect(s.logs.join('\n')).not.toContain(v);
  });
});

describe('privacy: purchase outputs are built field by field, and no purchase value is ever logged', () => {
  /** Every key anywhere in a JSON value (object keys only). */
  const keysOf = (v: unknown): string[] =>
    Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : [];
  const ALLOWED = ['months', 'month', 'spent', 'saved', 'count', 'purchases', 'date', 'store', 'city', 'total', 'discount'];
  /** Distinctive personal values: none may reach a log line. */
  const PERSONAL = ['ICA Loggtest Distinktby', 'Loggstad', '98765.43', '4321.09', '55443.21', '2026-07-21T11:22:33', 'RCPT-DISTINCT-7788', 'Hemlig Varulogg', '6035009988776655', '9911223'];
  let p: ToolTest;
  beforeAll(async () => {
    p = await startToolTest({ fake: { routes: { ...FAKE_WEB_ROUTES,
      [MONTHS]: { status: 200, body: { monthSummaries: [{ year: 2026, month: 7, amount: 55443.21, amountSaved: 4321.09, cardNumber: '6035009988776655' }], customer: { firstName: FAKE_SECRETS.firstName } } },
      [MONTH('2026-07')]: { status: 200, body: { transactions: [{
        transactionId: 'RCPT-DISTINCT-7788', transactionDate: '2026-07-21T11:22:33', storeId: 9911223, storeMarketingName: 'ICA Loggtest Distinktby', storeCity: 'Loggstad',
        transactionChanel: 'Butik', transactionValue: 98765.43, totalDiscount: 4321.09, discountValue: 1,
        cardNumber: '6035009988776655', items: [{ name: 'Hemlig Varulogg', price: 12 }],
        customer: { firstName: FAKE_SECRETS.firstName, personnummer: FAKE_SECRETS.personnummer },
      }], token: FAKE_SECRETS.accessToken } },
      // A value where a string is expected: the schema-mismatch log line carries our key path, never the value.
      [MONTH('2026-06')]: { status: 200, body: { transactions: [{ storeMarketingName: { 'ICA Loggtest Distinktby': 98765.43 } }] } },
    } } });
  });
  afterAll(async () => { await p.close(); });

  it('returns only the allowed keys; ICA\'s other fields never pass through', async () => {
    const months = await p.alice.client.call('get_purchase_months');
    expect(months.json).toEqual({ months: [{ month: '2026-07', spent: 55443.21, saved: 4321.09 }] });
    const r = await p.alice.client.call('get_purchases', { month: '2026-07' });
    expect(r.json).toEqual({ month: '2026-07', count: 1, purchases: [{ date: '2026-07-21', store: 'ICA Loggtest Distinktby', city: 'Loggstad', total: 98765.43, discount: 4321.09 }] });
    for (const x of [months, r]) {
      expect([...new Set(keysOf(x.json))].filter((k) => !ALLOWED.includes(k))).toEqual([]);
      for (const v of ['RCPT-DISTINCT-7788', '9911223', 'transactionChanel', '6035009988776655', 'Hemlig Varulogg', FAKE_SECRETS.firstName, FAKE_SECRETS.personnummer, FAKE_SECRETS.accessToken]) expect(x.text).not.toContain(v);
    }
  });

  it('a schema mismatch is reported without the offending value', async () => {
    const r = await p.alice.client.call('get_purchases', { month: '2026-06' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('format ica-hub does not understand');
    expect(p.logs.join('\n')).toContain('transactions.0.storeMarketingName: invalid_type');
  });

  it('logs no purchase value, personal field or secret, only the tool-call lines', async () => {
    await p.alice.client.call('get_purchases', { month: '2026-07' });
    const all = p.logs.join('\n');
    expect(all).toContain('"tool":"get_purchases"');
    for (const v of [...PERSONAL, ...Object.values(FAKE_SECRETS)]) expect(all).not.toContain(v);
    expect(cpaCalls(p)).toBeGreaterThan(0);
  });
});
