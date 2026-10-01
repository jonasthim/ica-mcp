import { describe, expect, it } from 'vitest';
import { shapeOf } from './shape.js';

describe('shapeOf', () => {
  it('names the type of each scalar, never its value', () => {
    expect(shapeOf('Veckohandling')).toBe('string');
    expect(shapeOf(1234.5)).toBe('number');
    expect(shapeOf(true)).toBe('boolean');
    expect(shapeOf(null)).toBe('null');
    expect(shapeOf(undefined)).toBe('undefined');
  });

  it('describes objects by key and value type, arrays by length and first element', () => {
    expect(shapeOf({ id: 'x', total: 99, ok: false, none: null, tags: [], nested: { a: 1 } }))
      .toBe('object{id: string, total: number, ok: boolean, none: null, tags: array[0], nested: object{a: number}}');
    expect(shapeOf([{ a: 'x' }, { b: 1 }])).toBe('array[2] of object{a: string}');
    expect(shapeOf([[1, 2], []])).toBe('array[2] of array[2] of number');
  });

  it('recurses at most 3 levels', () => {
    expect(shapeOf({ a: { b: { c: { d: 'deep' } } } })).toBe('object{a: object{b: object{c: object{…}}}}');
    expect(shapeOf([[[[1]]]])).toBe('array[1] of array[1] of array[1] of array[1]');
  });

  it('never shows a key that looks like data, and caps the number of keys', () => {
    expect(shapeOf({ '2026-08': 1, 'partner@example.se': 'x', normalKey: 'y' })).toBe('object{<key>: number, <key>: string, normalKey: string}');
    const many = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`k${i}`, i]));
    expect(shapeOf(many)).toMatch(/k39: number, … 5 more keys\}$/);
  });

  it('hides an identifier-shaped key that is itself a personnummer, a hex id or a base64url token used as a map key', () => {
    const shape = shapeOf({
      x199001011234: 1, // a personnummer with a letter prefix (6+ digits)
      deadbeefcafe: 2, // 12+ chars, hex digits only, no decimal digits at all
      myToken1AbcDE: 3, // 12+ chars, base64url alphabet, only one digit
    });
    expect(shape).toBe('object{<key>: number, <key>: number, <key>: number}');
    for (const v of ['x199001011234', 'deadbeefcafe', 'myToken1AbcDE']) expect(shape).not.toContain(v);
  });

  it('keeps ordinary ICA field names readable', () => {
    const fields = {
      shoppingLists: [], offlineId: '', title: '', rows: [], productName: '', isStrikedOver: false, quantity: 0,
      openingHours: {}, today: '', regularHours: [], specialHours: [], offers: [], parsedMechanics: {}, category: {},
      articleGroupName: '', vouchers: {}, used: [], active: [], validTo: '', accountBalance: {}, groupedBalances: [],
      monthSummaries: [], year: 0, month: 0, total: 0, storeName: '', customer: {}, firstName: '', accessToken: '',
      loginState: 0, tokenExpires: '', personnummer: '', documents: [], offerId: '', ownerName: '',
    };
    const shape = shapeOf(fields);
    for (const key of Object.keys(fields)) expect(shape).toContain(`${key}: `);
    expect(shape).not.toContain('<key>');
  });

  it('renders a purchase sample with store names, amounts, dates and list rows as keys and types only', () => {
    const sample = {
      storeMarketingName: 'ICA Supermarket Fakeby',
      receipts: [{ transactionDate: '2026-08-14T17:03:00Z', totalAmount: 312.45, storeName: 'ICA Fake', rows: [{ articleName: 'Mjölk 3%', quantity: 2 }] }],
      lists: [{ id: 'list-1', name: 'Veckohandling', rows: [{ text: 'Kaffe bryggmalet' }] }],
    };
    const shape = shapeOf(sample);
    for (const v of ['ICA Supermarket Fakeby', '2026-08-14', '312.45', '312', 'ICA Fake', 'Mjölk', 'Veckohandling', 'Kaffe', 'list-1', '2']) expect(shape).not.toContain(v);
    expect(shape).toBe('object{storeMarketingName: string, receipts: array[1] of object{transactionDate: string, totalAmount: number, storeName: string, rows: array[1]}, lists: array[1] of object{id: string, name: string, rows: array[1]}}');
  });
});
