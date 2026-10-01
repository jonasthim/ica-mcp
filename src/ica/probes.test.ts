import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectListIds, errorCategory, runProbes } from './probes.js';
import { FAKE_PROBE_ROUTES, FAKE_SECRETS, fakeLoggedInSession, startFakeIca, type FakeIca } from './test-fakes.js';
import { newSession } from './http.js';

let fake: FakeIca;
beforeEach(async () => { fake = await startFakeIca({ pendingPolls: 0, routes: FAKE_PROBE_ROUTES }); });
afterEach(async () => { await fake.close(); });

describe('runProbes', () => {
  it('probes every read-only endpoint with the web accessToken and reports shapes, never values', async () => {
    const report = await runProbes(await fakeLoggedInSession(fake), fake.endpoints);
    expect(report.live).toBe(true);
    expect(report.loginState).toBe(2);
    expect(report.results.map((r) => [r.name, r.status])).toEqual([
      ['user-information', 200],
      ['web-list-all', 200],
      ['web-article-search', 200],
      ['mobile-shoppinglists', 200],
      ['mobile-store-favorites', 200],
      ['mobile-store-detail', 200],
      ['mobile-store-offers', 200],
      ['mobile-bonus', 200],
      ['mobile-product-ean', 451],
      ['purchase-month-summaries', 200],
      ['purchase-latest-month', 200],
    ]);
    expect(report.results[0]!.sample).toBe('{"loginState":2}');
    expect(report.results.find((r) => r.name === 'mobile-product-ean')?.note).toMatch(/Swedish IP/);
    expect(report.results.find((r) => r.name === 'purchase-latest-month')?.path).toBe('/api/cpa/purchases/historical/me/byyearmonth/<latest month>');
    expect(fake.seen.paths).toContain('/api/cpa/purchases/historical/me/byyearmonth/2026-08');
    expect(report.results.find((r) => r.name === 'mobile-store-detail')?.path).toBe('/sverige/digx/mobile/storeservice/v1/stores/<favourite store>');
    expect(fake.seen.paths).toContain('/sverige/digx/mobile/storeservice/v1/stores/12345');
    expect(report.results.find((r) => r.name === 'web-article-search')?.path).toBe('/sverige/digx/shoppinglistarticlesearch/v1/search?query=mj%C3%B6lk');
    expect(new Set(fake.seen.bearers)).toEqual(new Set([`Bearer ${FAKE_SECRETS.accessToken}`]));
    expect(report.listIds).toEqual([{ probe: 'web-list-all', ids: ['list-shared-1', 'list-2'] }, { probe: 'mobile-shoppinglists', ids: ['off-1'] }]);
    const all = JSON.stringify(report);
    for (const s of [...Object.values(FAKE_SECRETS), '6035000011112222', 'partner@example.se']) expect(all).not.toContain(s);
    // list names, row text, store names, amounts and dates never appear: only keys and value types
    for (const v of ['Veckohandling', 'Mjölk', 'Fest', 'ICA Fake', 'Kaffe', '"total"', '1000', '12.5', '99', '12345', '2026-08']) expect(all).not.toContain(v);
    expect(report.results.find((r) => r.name === 'web-list-all')?.sample).toBe('array[2] of object{id: string, name: string, ownerName: string, rows: array[1] of object{…}}');
    expect(report.results.find((r) => r.name === 'purchase-month-summaries')?.sample).toBe('object{monthSummaries: array[3] of object{year: number, month: number, total: number}}');
  });

  it('stops after user information when the session is no longer logged in', async () => {
    const report = await runProbes(newSession(), fake.endpoints);
    expect(report).toEqual({ live: false, error: 'logged-out', loginState: 0, listIds: [], elements: [], results: [expect.objectContaining({ name: 'user-information', status: 200, sample: '{"loginState":0}' })] });
    expect(fake.seen.bearers).toEqual([]);
  });

  it('skips the store detail probes without a favourite store and truncates long shapes', async () => {
    const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`someRatherLongKeyName${i}`, { a: 1, b: 'x', c: [true] }]));
    fake.opts.routes = { ...FAKE_PROBE_ROUTES, '/sverige/digx/mobile/storeservice/v1/favorites': { status: 200, body: { favoriteStores: [] } }, '/sverige/digx/mobile/bonusservice/v1/bonus/current': { status: 200, body: wide } };
    const report = await runProbes(await fakeLoggedInSession(fake), fake.endpoints);
    expect(report.results.map((r) => r.name)).not.toContain('mobile-store-detail');
    const bonus = report.results.find((r) => r.name === 'mobile-bonus')!.sample;
    expect(bonus.length).toBeLessThanOrEqual(1201);
    expect(bonus.endsWith('…')).toBe(true);
  });
});

describe('runProbes: app bearer', () => {
  it('labels each row with the credential it used; without an app token every gateway row uses the web bearer', async () => {
    const report = await runProbes(await fakeLoggedInSession(fake), fake.endpoints);
    expect(report.results.map((r) => `${r.name} ${r.auth}`)).toEqual([
      'user-information web cookie', 'web-list-all web bearer', 'web-article-search web bearer', 'mobile-shoppinglists web bearer',
      'mobile-store-favorites web bearer', 'mobile-store-detail web bearer', 'mobile-store-offers web bearer', 'mobile-bonus web bearer',
      'mobile-product-ean web bearer', 'purchase-month-summaries web cookie', 'purchase-latest-month web cookie',
    ]);
  });

  it('sends the app bearer to mobile/* and keeps the web bearer on the web APIs', async () => {
    fake.opts.mobileAcceptsWebBearer = false;
    const report = await runProbes(await fakeLoggedInSession(fake), fake.endpoints, { appBearer: FAKE_SECRETS.appAccessToken });
    const row = (n: string) => report.results.find((r) => r.name === n)!;
    for (const n of ['mobile-shoppinglists', 'mobile-store-favorites', 'mobile-store-detail', 'mobile-bonus']) expect([n, row(n).auth, row(n).status]).toEqual([n, 'app bearer', 200]);
    for (const n of ['web-list-all', 'web-article-search']) expect([n, row(n).auth, row(n).status]).toEqual([n, 'web bearer', 200]);
    expect(fake.seen.gatewayCalls.filter((c) => c.includes('/mobile/')).every((c) => c.endsWith(' app'))).toBe(true);
    expect(fake.seen.gatewayCalls.filter((c) => !c.includes('/mobile/')).every((c) => c.endsWith(' web'))).toBe(true);
    expect(JSON.stringify(report)).not.toContain(FAKE_SECRETS.appAccessToken);
  });

  it('shows the 900908 answer the real gateway gives the web bearer on mobile/*', async () => {
    fake.opts.mobileAcceptsWebBearer = false;
    const report = await runProbes(await fakeLoggedInSession(fake), fake.endpoints);
    expect(report.results.find((r) => r.name === 'mobile-bonus')).toMatchObject({ status: 403, auth: 'web bearer', sample: 'object{code: number, message: string, description: string}' });
  });
});

describe('runProbes: element shapes', () => {
  it('records the shapes of chosen elements and of user information, never their values', async () => {
    fake.opts.routes = {
      ...FAKE_PROBE_ROUTES,
      '/sverige/digx/mobile/shoppinglistservice/v1/shoppinglists': { status: 200, body: { shoppingLists: [{ offlineId: 'off-1', title: 'Veckohandling', rows: [{ offlineId: 'r1', productName: 'Mjölk', isStrikedOver: false, quantity: 2 }] }] } },
      '/sverige/digx/mobile/offerservice/v1/offersdiscounts/12345': { status: 200, body: { offers: [{ id: 'o1', name: 'Kaffe', parsedMechanics: { type: 'X_FOR_Y', value1: 2, value2: 50 }, category: { articleGroupName: 'Kaffe' } }] } },
    };
    const report = await runProbes(await fakeLoggedInSession(fake), fake.endpoints);
    const el = (label: string) => report.elements.find((e) => e.label === label)?.shape;
    expect(el('(whole answer)')).toBe('object{accessToken: string, loginState: number, tokenExpires: string, firstName: string, personnummer: string}');
    expect(el('shoppingLists[0].rows[0]')).toBe('object{offlineId: string, productName: string, isStrikedOver: boolean, quantity: number}');
    expect(el('offers[0].parsedMechanics')).toBe('object{type: string, value1: number, value2: number}');
    expect(el('offers[0].category')).toBe('object{articleGroupName: string}');
    expect(el('openingHours.regularHours[0]')).toBe('absent');
    expect(el('[0].rows[0]')).toBe('object{articleName: string, quantity: number}');
    expect(el('monthSummaries[0]')).toBe('object{year: number, month: number, total: number}');
    expect(el('first transaction (*)')).toBe('object{storeName: string, total: number, customer: object{firstName: string}}');
    expect(el('first item of the first transaction (*.*)')).toBe('absent');
    expect(el('access token claims')).toBeUndefined();
    const all = JSON.stringify(report.elements);
    for (const v of ['Mjölk', 'Kaffe', 'X_FOR_Y', 'Veckohandling', 'ICA Fake', FAKE_SECRETS.firstName, FAKE_SECRETS.personnummer, FAKE_SECRETS.accessToken, '50', '99']) expect(all).not.toContain(v);
  });

  it('describes the app token by claim names only when an app bearer is used', async () => {
    const report = await runProbes(await fakeLoggedInSession(fake), fake.endpoints, { appBearer: FAKE_SECRETS.appAccessToken });
    expect(report.elements.find((e) => e.label === 'access token claims')).toEqual({ probe: 'app-token', label: 'access token claims', shape: `opaque (${FAKE_SECRETS.appAccessToken.length} chars)` });
    expect(JSON.stringify(report)).not.toContain(FAKE_SECRETS.appAccessToken);
  });

  it('captures nothing from a failed probe', async () => {
    fake.opts.routes = { ...FAKE_PROBE_ROUTES, '/sverige/digx/mobile/bonusservice/v1/bonus/current': { status: 500, body: { vouchers: { used: [{ v: 1 }] } } } };
    const report = await runProbes(await fakeLoggedInSession(fake), fake.endpoints);
    expect(report.elements.filter((e) => e.probe === 'mobile-bonus')).toEqual([]);
  });
});

describe('collectListIds', () => {
  it('finds ids in a bare array or in arrays one level down', () => {
    expect(collectListIds([{ id: 'a' }, { listId: 7 }, { nope: 1 }, 'x'])).toEqual(['a', '7']);
    expect(collectListIds({ lists: [{ offlineId: 'b' }], other: 1 })).toEqual(['b']);
    expect(collectListIds(null)).toEqual([]);
  });
});

describe('runProbes: non-JSON bodies', () => {
  it('describes a non-JSON body by type and size only, never an excerpt', async () => {
    const body = `<html><body>Hej ${FAKE_SECRETS.firstName} ${FAKE_SECRETS.personnummer}</body></html>`;
    fake.opts.routes = { ...FAKE_PROBE_ROUTES, '/sverige/digx/mobile/bonusservice/v1/bonus/current': { status: 500, body, contentType: 'text/html' } };
    const report = await runProbes(await fakeLoggedInSession(fake), fake.endpoints);
    expect(report.results.find((r) => r.name === 'mobile-bonus')).toMatchObject({ status: 500, sample: `text/html, ${Buffer.byteLength(body)} bytes` });
    expect(JSON.stringify(report)).not.toContain('Hej');
  });
});

describe('runProbes: why user information failed', () => {
  const probe = async (userInfo: { status: number; body: unknown }) => {
    const s = await fakeLoggedInSession(fake);
    fake.opts.userInfo = userInfo;
    return runProbes(s, fake.endpoints);
  };
  it('401 and 403 mean logged out', async () => {
    expect((await probe({ status: 401, body: {} })).error).toBe('logged-out');
    expect((await probe({ status: 403, body: {} })).error).toBe('logged-out');
  });
  it('451 is geo-blocking, not a logout', async () => {
    expect(await probe({ status: 451, body: {} })).toMatchObject({ live: false, error: 'geo-blocked (451)' });
  });
  it('other HTTP errors are reported by status', async () => {
    expect(await probe({ status: 503, body: {} })).toMatchObject({ live: false, error: 'http 503' });
  });
  it('a 200 without an accessToken is not a logout either', async () => {
    expect(await probe({ status: 200, body: { loginState: 2 } })).toMatchObject({ live: false, error: 'http 200 without accessToken' });
  });
  it('an unreachable ICA is a network error', async () => {
    const s = await fakeLoggedInSession(fake);
    const endpoints = { ...fake.endpoints };
    await fake.close();
    const report = await runProbes(s, endpoints);
    expect(report).toMatchObject({ live: false, error: 'network' });
    fake = await startFakeIca();
  });
  it('classifies timeouts separately', () => {
    expect(errorCategory(new DOMException('slow', 'TimeoutError'))).toBe('timeout');
    expect(errorCategory(new TypeError('fetch failed'))).toBe('network');
  });
});
