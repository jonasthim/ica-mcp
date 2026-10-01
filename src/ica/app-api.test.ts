import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAppApi, newListRow, newOfflineId } from './app-api.js';
import { FAKE_APP_ROUTES, FAKE_BONUS, FAKE_SECRETS, fakeHouseholdLists, fakeStore, startFakeIca, type FakeAppRow, type FakeIca } from './test-fakes.js';

let fake: FakeIca;
const api = () => createAppApi({ endpoints: fake.endpoints, bearer: FAKE_SECRETS.appAccessToken });
beforeEach(async () => { fake = await startFakeIca({ pendingPolls: 0, appLists: fakeHouseholdLists(), routes: FAKE_APP_ROUTES, mobileAcceptsWebBearer: false }); });
afterEach(async () => { await fake.close(); });

describe('app shopping lists', () => {
  it('lists and reads lists with typed rows, with the app bearer only', async () => {
    const lists = await api().shoppingLists();
    expect(lists.map((l) => [l.offlineId, l.title, l.rows.length])).toEqual([['LIST-VECKO', 'Veckohandling', 5], ['LIST-FEST', 'Fest på Åland', 1]]);
    const one = await api().shoppingList('LIST-VECKO');
    expect(one.rows.find((r) => r.offlineId === 'ROW-AGG')).toMatchObject({ productName: 'Ägg', quantity: 6, unit: 'st', articleGroupId: 4110, articleGroupIdExtended: 4110, isStrikedOver: false });
    expect(one.rows.find((r) => r.offlineId === 'ROW-KAFFE')!.futureField).toEqual({ flag: true });
    expect(fake.seen.gatewayCalls.every((c) => c.endsWith(' app'))).toBe(true);
  });

  it('the web bearer is refused on mobile/* (403), as by the real gateway', async () => {
    await expect(createAppApi({ endpoints: fake.endpoints, bearer: FAKE_SECRETS.accessToken }).shoppingLists()).rejects.toMatchObject({ name: 'IcaUnauthorized', status: 403 });
  });

  it('missing optional fields parse', async () => {
    const list = fake.opts.appLists![0]!;
    list.rows.push({ offlineId: 'ROW-MIN', productName: 'Salt', isStrikedOver: false } as FakeAppRow);
    delete (list as Record<string, unknown>).commentText;
    const read = await api().shoppingList('LIST-VECKO');
    expect(read.rows.at(-1)).toMatchObject({ offlineId: 'ROW-MIN', productName: 'Salt' });
    expect(read.rows.at(-1)!.articleGroupId).toBeUndefined();
  });

  it('missing required field → unexpected-response with paths only', async () => {
    delete (fake.opts.appLists![0]!.rows[0] as Record<string, unknown>).productName;
    const err = await api().shoppingLists().catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'IcaUnavailable', reason: 'unexpected-response' });
    expect((err as { issues: string[] }).issues).toContain('shoppingLists.0.rows.0.productName: invalid_type');
    expect(JSON.stringify(err)).not.toMatch(/Mjölk|Veckohandling|LIST-VECKO/);
  });

  it('an unknown list id is IcaRejected 404', async () => {
    await expect(api().shoppingList('NOPE')).rejects.toMatchObject({ name: 'IcaRejected', status: 404 });
  });

  it('unknown fields survive a check-off round trip', async () => {
    const list = await api().shoppingList('LIST-VECKO');
    const kaffe = list.rows.find((r) => r.offlineId === 'ROW-KAFFE')!;
    await api().syncList('LIST-VECKO', { changedRows: [{ ...kaffe, isStrikedOver: true, latestChange: '2026-09-29T12:00:00.000Z' }] });
    expect(fake.seen.syncBodies[0]!.body.changedRows![0]).toMatchObject({ offlineId: 'ROW-KAFFE', isStrikedOver: true, futureField: { flag: true }, sourceId: -1, recipes: [] });
    expect((await api().shoppingList('LIST-VECKO')).rows.find((r) => r.offlineId === 'ROW-KAFFE')).toMatchObject({ isStrikedOver: true, futureField: { flag: true } });
  });

  it('creates, changes and deletes rows through /sync', async () => {
    const row = newListRow({ text: 'Bananer', quantity: 2, unit: 'kg', now: new Date('2026-09-29T12:00:00.000Z') });
    expect(row).toMatchObject({ productName: 'Bananer', isStrikedOver: false, quantity: 2, unit: 'kg', sourceId: -1, recipes: [], latestChange: '2026-09-29T12:00:00.000Z' });
    expect(row.offlineId).toMatch(/^[0-9A-F-]{36}$/);
    expect(newListRow({ text: 'Salt', now: new Date() })).not.toHaveProperty('quantity');
    expect(newListRow({ text: 'Salt', now: new Date() })).not.toHaveProperty('unit');
    await api().syncList('LIST-VECKO', { createdRows: [row], deletedRows: ['ROW-HAVRE'] });
    expect(fake.seen.gatewayCalls).toContain('/sverige/digx/mobile/shoppinglistservice/v1/shoppinglists/LIST-VECKO/sync app');
    const rows = (await api().shoppingList('LIST-VECKO')).rows.map((r) => r.productName);
    expect(rows).toContain('Bananer');
    expect(rows).not.toContain('Havremjölk');
  });

  it('creates a list and returns its offlineId', async () => {
    const id = await api().createList('Midsommar', new Date('2026-09-29T12:00:00.000Z'));
    expect(id).toMatch(/^[0-9A-F-]{36}$/);
    expect(fake.seen.createBodies[0]).toMatchObject({ offlineId: id, title: 'Midsommar', rows: [], latestChange: '2026-09-29T12:00:00.000Z' });
    expect((await api().shoppingLists()).map((l) => l.title)).toContain('Midsommar');
  });

  it('creates a list under an offlineId the caller chose (so a retried create can find it)', async () => {
    const chosen = newOfflineId();
    expect(chosen).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    expect(await api().createList('Jul', new Date(), chosen)).toBe(chosen);
    expect((await api().shoppingLists()).find((l) => l.title === 'Jul')?.offlineId).toBe(chosen);
  });

  it('a sync to an unknown list is an ICA rejection, not a silent success', async () => {
    await expect(api().syncList('LIST-NOPE', { deletedRows: ['ROW-X'] })).rejects.toMatchObject({ name: 'IcaRejected', status: 404 });
  });
});

describe('stores, offers, bonus, product', () => {
  it('parses favourites, a store, offers, bonus and a product; unknown EAN → null', async () => {
    expect(await api().favorites()).toMatchObject({ favoriteStores: [12345, 67890] });
    expect(await api().store(12345)).toMatchObject({ id: 12345, marketingName: 'ICA Nära Fakeby', address: { city: 'Fakeby' }, openingHours: { today: '08–22' } });
    const { offers } = await api().offers(12345);
    expect(offers.map((o) => o.id)).toEqual(['OF-1', 'OF-2', 'OF-3', 'OF-4']);
    expect(offers[0]).toMatchObject({ name: 'Kycklingfilé', brand: 'Kronfågel', condition: '99 kr/st', category: { articleGroupName: 'Kyckling' } });
    expect(await api().bonus()).toMatchObject({ accountBalance: { remainingPointsIncludingBoost: 812, remainingDays: 2 } });
    expect(await api().product('7310865004703')).toMatchObject({ gtin: '7310865004703', name: 'Mellanmjölk 1,5% 1l' });
    expect(await api().product('0000000000000')).toBeNull();
    expect(fake.seen.gatewayCalls.every((c) => c.endsWith(' app'))).toBe(true);
  });

  it('an offer without a name is an unexpected response, not a silent skip', async () => {
    fake.opts.routes = { ...FAKE_APP_ROUTES, '/sverige/digx/mobile/offerservice/v1/offersdiscounts/12345': { status: 200, body: { offers: [{ id: 'X' }] } } };
    await expect(api().offers(12345)).rejects.toMatchObject({ name: 'IcaUnavailable', reason: 'unexpected-response', issues: ['offers.0.name: invalid_type'] });
  });

  it('each method makes exactly one gateway GET', async () => {
    const a = api();
    await a.favorites();
    await a.store(12345);
    await a.offers(12345);
    await a.bonus();
    await a.product('7310865004703');
    const count = (path: string) => fake.seen.gatewayCalls.filter((c) => c === `${path} app`).length;
    expect(count('/sverige/digx/mobile/storeservice/v1/favorites')).toBe(1);
    expect(count('/sverige/digx/mobile/storeservice/v1/stores/12345')).toBe(1);
    expect(count('/sverige/digx/mobile/offerservice/v1/offersdiscounts/12345')).toBe(1);
    expect(count('/sverige/digx/mobile/bonusservice/v1/bonus/current')).toBe(1);
    expect(count('/sverige/digx/mobile/productservice/v1/product/7310865004703')).toBe(1);
  });

  it('a parse failure on the bonus body carries no secret, only paths and codes', async () => {
    fake.opts.routes = { ...FAKE_APP_ROUTES, '/sverige/digx/mobile/bonusservice/v1/bonus/current': { status: 200, body: { ...FAKE_BONUS, stammisBoostBonusLevelText: 42 } } };
    const err = await api().bonus().catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'IcaUnavailable', reason: 'unexpected-response', issues: ['stammisBoostBonusLevelText: invalid_type'] });
    const s = JSON.stringify(err);
    expect(s).not.toContain(FAKE_BONUS.cardNumber);
    expect(s).not.toContain('VCH-FAKE-1234');
  });

  it('a parse failure on the store body carries no secret, only paths and codes', async () => {
    const body = { ...fakeStore(12345, 'ICA Nära Fakeby', 'Fakeby', '08–22'), webURL: 12345 };
    fake.opts.routes = { ...FAKE_APP_ROUTES, '/sverige/digx/mobile/storeservice/v1/stores/12345': { status: 200, body } };
    const err = await api().store(12345).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'IcaUnavailable', reason: 'unexpected-response', issues: ['webURL: invalid_type'] });
    const s = JSON.stringify(err);
    expect(s).not.toContain('ICA Nära Fakeby');
    expect(s).not.toContain(FAKE_SECRETS.street);
  });

  it('vouchers.active stays lenient: empty, a used-shaped element, or an unknown object', async () => {
    for (const active of [[], [{ title: 'Kupong', voucherCode: 'X-1', voucherAmount: 5 }], [{ weird: true, nested: { a: 1 } }]]) {
      fake.opts.routes = { ...FAKE_APP_ROUTES, '/sverige/digx/mobile/bonusservice/v1/bonus/current': { status: 200, body: { ...FAKE_BONUS, vouchers: { ...FAKE_BONUS.vouchers, active } } } };
      const b = await api().bonus();
      expect(b.vouchers?.active).toEqual(active);
    }
  });

  it('a 204 (null-bodied) product answer is null, not a parse error', async () => {
    fake.opts.routes = { ...FAKE_APP_ROUTES, '/sverige/digx/mobile/productservice/v1/product/9999999999999': { status: 204, body: null } };
    expect(await api().product('9999999999999')).toBeNull();
  });

  it('parses a store body shaped exactly like the 2.1 capture', async () => {
    const liveStore = {
      id: 12345, marketingName: 'ICA Nära Fakeby', address: { street: 'Fakegatan 1', zip: '11122', city: 'Fakeby' }, phone: '08-123 45 67',
      openingHours: {
        today: '08–22', // shape: from 2.1 capture (openingHours.today: string)
        regularHours: [{ title: 'Mån-fre', hours: '08-22' }], // shape: from 2.1 capture (regularHours[0]: {title, hours})
        specialHours: [{ title: 'Julafton', hours: '08-13' }], // shape: from 2.1 capture (specialHours[0]: {title, hours})
        departmentHours: [], serviceOpeningHours: [],
      },
      services: [],
    };
    fake.opts.routes = { ...FAKE_APP_ROUTES, '/sverige/digx/mobile/storeservice/v1/stores/12345': { status: 200, body: liveStore } };
    expect(await api().store(12345)).toMatchObject({
      openingHours: { today: '08–22', regularHours: [{ title: 'Mån-fre', hours: '08-22' }], specialHours: [{ title: 'Julafton', hours: '08-13' }] },
    });
  });

  it('parses an offers body shaped exactly like the 2.1 capture', async () => {
    const liveOffers = {
      discounts: [],
      offers: [{
        id: 'OF-LIVE', name: 'Kycklingfilé', brand: 'Kronfågel', condition: '99 kr/st',
        category: { articleGroupName: 'Kyckling', articleGroupId: 4110, expandedArticleGroupName: 'Kyckling och fågel', expandedArticleGroupId: 4100 }, // shape: from 2.1 capture (offers[0].category)
        parsedMechanics: { type: 'multibuy', quantity: 2, unitSign: 'st', value1: '89', value2: '', value3: '', value4: '' }, // shape: from 2.1 capture (offers[0].parsedMechanics)
      }],
    };
    fake.opts.routes = { ...FAKE_APP_ROUTES, '/sverige/digx/mobile/offerservice/v1/offersdiscounts/12345': { status: 200, body: liveOffers } };
    const { offers } = await api().offers(12345);
    expect(offers[0]).toMatchObject({
      category: { articleGroupName: 'Kyckling', articleGroupId: 4110, expandedArticleGroupName: 'Kyckling och fågel', expandedArticleGroupId: 4100 },
      parsedMechanics: { type: 'multibuy', quantity: 2, unitSign: 'st', value1: '89', value2: '', value3: '', value4: '' },
    });
  });

  it('parses a bonus body shaped exactly like the 2.1 capture', async () => {
    const liveBonus = {
      vouchers: {
        active: [], // 2.1 capture: vouchers.active[0] absent
        used: [{ title: 'Extra kaffe', subTitle: '2 för 1', description: 'Rabatt på bryggkaffe', redeemedDate: '2026-08-01', voucherCode: 'VCH-LIVE-0001', voucherType: 'discount', sender: 'ICA', voucherAmount: 20 }], // shape: from 2.1 capture (vouchers.used[0])
      },
      accountBalance: {
        title: 'Din bonus', totalVoucherValue: 50, nextVoucherValue: 75, remainingPointsIncludingBoost: 812, remainingDays: 2,
        groupedBalances: [{ balanceCode: 1, balanceDescription: 'Ordinarie bonus', pointValue: 812, voucherValue: 50, detailedBalances: [
          { balanceDescription: 'Kvitto A', pointValue: 100, voucherValue: 5, sender: 'ICA Nära Fakeby' },
          { balanceDescription: 'Kvitto B', pointValue: 200, voucherValue: 10, sender: 'ICA Nära Fakeby' },
          { balanceDescription: 'Kvitto C', pointValue: 300, voucherValue: 15, sender: 'ICA Nära Fakeby' },
          { balanceDescription: 'Kvitto D', pointValue: 212, voucherValue: 20, sender: 'ICA Nära Fakeby' },
        ] }], // shape: from 2.1 capture (accountBalance.groupedBalances[0], detailedBalances: array[4])
      },
    };
    fake.opts.routes = { ...FAKE_APP_ROUTES, '/sverige/digx/mobile/bonusservice/v1/bonus/current': { status: 200, body: liveBonus } };
    const b = await api().bonus();
    expect(b.vouchers?.used[0]).toMatchObject({ title: 'Extra kaffe', voucherAmount: 20, voucherCode: 'VCH-LIVE-0001' });
    expect(b.accountBalance?.groupedBalances[0]).toMatchObject({ balanceCode: 1, pointValue: 812 });
    expect(b.accountBalance?.groupedBalances[0]?.detailedBalances).toHaveLength(4);
    expect(b.accountBalance?.groupedBalances[0]?.detailedBalances[0]).toMatchObject({ balanceDescription: 'Kvitto A', pointValue: 100 });
  });
});
