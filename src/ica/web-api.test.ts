import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPurchaseApi, createWebApi, toAmount } from './web-api.js';
import { FAKE_SECRETS, FAKE_WEB_ROUTES, fakeLoggedInSession, startFakeIca, type FakeIca } from './test-fakes.js';

let fake: FakeIca;
beforeEach(async () => { fake = await startFakeIca({ pendingPolls: 0, routes: FAKE_WEB_ROUTES }); });
afterEach(async () => { await fake.close(); });
const web = () => createWebApi({ endpoints: fake.endpoints, bearer: FAKE_SECRETS.accessToken });

describe('web gateway API', () => {
  it('searches articles with the web bearer and sends the query as typed', async () => {
    const r = await web().searchArticles('mjölk');
    expect(r.documents.map((d) => d.name)).toEqual(['Mellanmjölk 1,5%', 'Standardmjölk 3%', 'Havredryck']);
    expect(r.stats?.totalHits).toBe(3);
    expect(fake.seen.searchQueries).toEqual(['mjölk']);
    expect(fake.seen.gatewayCalls.every((c) => c.endsWith(' web'))).toBe(true);
  });
  it('a renamed documents key is an unexpected response, not an empty result', async () => {
    fake.opts.routes = { '/sverige/digx/shoppinglistarticlesearch/v1/search': { status: 200, body: { results: [] } } };
    await expect(web().searchArticles('ost')).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'unexpected-response' });
  });
  it('a query with &, ? and / round-trips intact (URLSearchParams-encoded, not path-mangled)', async () => {
    const q = 'mjölk & ost? /test';
    await web().searchArticles(q);
    expect(fake.seen.searchQueries).toEqual([q]);
  });
});

describe('purchase history (cookie session)', () => {
  const MONTH = '/api/cpa/purchases/historical/me/byyearmonth/2026-08';
  const MONTHS = '/api/cpa/purchases/historical/me/monthsummaries';
  it('reads month summaries and one month', async () => {
    const p = createPurchaseApi({ endpoints: fake.endpoints, session: await fakeLoggedInSession(fake) });
    expect((await p.monthSummaries()).map((m) => `${m.year}-${m.month}`)).toEqual(['2026-8', '2026-9', '2025-12']);
    expect((await p.month('2026-08')).transactions).toHaveLength(2);
    expect(fake.seen.paths).toContain(MONTH);
  });
  it('answers IcaUnauthorized(403) at loginState 1, as ICA does', async () => {
    const p = createPurchaseApi({ endpoints: fake.endpoints, session: await fakeLoggedInSession(fake) });
    fake.opts.loginState = 1;
    await expect(p.monthSummaries()).rejects.toMatchObject({ name: 'IcaUnauthorized', status: 403 });
    await expect(p.month('2026-08')).rejects.toMatchObject({ name: 'IcaUnauthorized', status: 403 });
  });
  it('a renamed array key is an unexpected response, not an empty month', async () => {
    fake.opts.routes = { ...FAKE_WEB_ROUTES, [MONTH]: { status: 200, body: { receipts: [] } } };
    const p = createPurchaseApi({ endpoints: fake.endpoints, session: await fakeLoggedInSession(fake) });
    await expect(p.month('2026-08')).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'unexpected-response' });
  });
  const api = async () => createPurchaseApi({ endpoints: fake.endpoints, session: await fakeLoggedInSession(fake) });
  const monthsAnswer = (body: unknown) => { fake.opts.routes = { ...FAKE_WEB_ROUTES, [MONTHS]: { status: 200, body } }; };
  const monthAnswer = (body: unknown) => { fake.opts.routes = { ...FAKE_WEB_ROUTES, [MONTH]: { status: 200, body } }; };

  it('month summaries: the live shape, with amount and amountSaved as numbers', async () => {
    expect((await (await api()).monthSummaries())[0]).toEqual({ year: 2026, month: 8, amount: 1445.5, amountSaved: 23 });
  });
  it('month summaries: numeric strings, yearMonth or period, comma-decimal amounts; anything else is nullish', async () => {
    monthsAnswer({ monthSummaries: [
      { year: '2026', month: '07', amount: '1 234,50', amountSaved: '12,5' },
      { yearMonth: '2026-06', amount: 'lots', amountSaved: null },
      { period: '2026-05-01T00:00:00', amount: 99 },
      { period: '2026-04-30T22:30:00Z' }, // just after midnight in Stockholm on May 1st
    ] });
    expect(await (await api()).monthSummaries()).toEqual([
      { year: 2026, month: 7, amount: 1234.5, amountSaved: 12.5 },
      { year: 2026, month: 6, amount: undefined, amountSaved: undefined },
      { year: 2026, month: 5, amount: 99, amountSaved: undefined },
      { year: 2026, month: 5, amount: undefined, amountSaved: undefined },
    ]);
  });
  it('month summaries: a month outside 1–12, or no year/month at all, is an unexpected response naming our key only', async () => {
    for (const bad of [{ year: 2026, month: 13 }, { year: 2026, month: '0' }, { period: '2026-13' }, { amount: 5 }, { year: 'twenty', month: 1 }]) {
      monthsAnswer({ monthSummaries: [bad] });
      const err = await (await api()).monthSummaries().catch((e: unknown) => e) as { name: string; reason: string; issues: string[] };
      expect(err, JSON.stringify(bad)).toMatchObject({ name: 'IcaUnavailable', reason: 'unexpected-response' });
      expect(err.issues.every((i) => i.startsWith('monthSummaries.0')), err.issues.join()).toBe(true);
    }
  });
  it('a month: the live header fields; string, epoch and comma-decimal values parse; unknown keys pass the schema', async () => {
    monthAnswer({ transactions: [
      {}, { transactionDate: 1788000000, storeMarketingName: null, transactionValue: '99,50', totalDiscount: 'n/a', discountValue: '3,25', items: [{ name: 'x' }] },
    ], extra: { anything: true } });
    const t = (await (await api()).month('2026-08')).transactions;
    expect(t).toHaveLength(2);
    expect(t[1]).toMatchObject({ transactionDate: 1788000000, transactionValue: 99.5, totalDiscount: undefined, discountValue: 3.25 });
  });
  it('a month: a bare top-level array is accepted, transactions: null is an empty month', async () => {
    monthAnswer([{ storeMarketingName: 'ICA Bar Array', transactionValue: 5 }]);
    expect((await (await api()).month('2026-08')).transactions).toMatchObject([{ storeMarketingName: 'ICA Bar Array', transactionValue: 5 }]);
    monthAnswer({ transactions: null });
    expect((await (await api()).month('2026-08')).transactions).toEqual([]);
  });
  it('a schema mismatch reports our own key names as issue paths, never an ICA value', async () => {
    fake.opts.routes = { ...FAKE_WEB_ROUTES, [MONTH]: { status: 200, body: { transactions: [{ storeMarketingName: { 'ICA Secret Store': 1 } }] } } };
    const p = createPurchaseApi({ endpoints: fake.endpoints, session: await fakeLoggedInSession(fake) });
    const err = await p.month('2026-08').catch((e: unknown) => e) as { issues: string[] };
    expect(err.issues).toEqual(['transactions.0.storeMarketingName: invalid_type']);
  });
});

describe('toAmount', () => {
  it('reads unambiguous kronor amounts and refuses anything that could be misread', () => {
    expect(toAmount(99.5)).toBe(99.5);
    expect(toAmount('1 234,50')).toBe(1234.5);
    expect(toAmount('-12,00')).toBe(-12);
    expect(toAmount('45.9')).toBe(45.9);
    expect(toAmount('1.234')).toBeUndefined(); // a thousands group or three decimals: ambiguous
    expect(toAmount('1,234')).toBeUndefined();
    expect(toAmount('12.345,6')).toBeUndefined();
    expect(toAmount('abc')).toBeUndefined();
  });
});
