import { describe, expect, it } from 'vitest';
import type { AppShoppingList } from '../../ica/app-api.js';
import { compact, day, listView, norm, qtyText, resolveList } from './format.js';

const list = (offlineId: string, title: string, id = 1): AppShoppingList => ({ id, offlineId, title, rows: [] });
const LISTS = [list('LIST-VECKO', 'Veckohandling', 45000001), list('LIST-FEST', 'Fest på Åland', 45000002), list('LIST-MAT', 'Festmat', 45000003)];

describe('norm', () => {
  it('folds case, Unicode form and spaces the Swedish way', () => {
    expect(norm('  FEST  PÅ ÅLAND ')).toBe('fest på åland');
    expect(norm('fest på åland')).toBe('fest på åland');
    expect(norm('ÄGG')).toBe('ägg');
  });
});

describe('resolveList: Swedish letters, case and NFD input', () => {
  it('finds a list by title in any case or Unicode form, by offlineId, or by numeric id', () => {
    expect(resolveList(LISTS, 'FEST PÅ ÅLAND', false).offlineId).toBe('LIST-FEST');
    expect(resolveList(LISTS, 'fest på åland', false).offlineId).toBe('LIST-FEST');
    expect(resolveList(LISTS, 'LIST-MAT', false).title).toBe('Festmat');
    expect(resolveList(LISTS, '45000001', false).title).toBe('Veckohandling');
    expect(resolveList(LISTS, 'vecko', false).title).toBe('Veckohandling');
    expect(resolveList(LISTS, undefined, false).title).toBe('Veckohandling');
  });
  it('lists the candidates instead of guessing when a partial title matches several lists', () => {
    expect(() => resolveList(LISTS, 'fest', false)).toThrow(/matches several lists: "Fest på Åland" \(id LIST-FEST\), "Festmat" \(id LIST-MAT\)/);
  });
  it('names the real lists when nothing matches, and says when there are none', () => {
    expect(() => resolveList(LISTS, 'Jul', false)).toThrow(/No shopping list called "Jul"\. The lists are: "Veckohandling"/);
    expect(() => resolveList([], undefined, true)).toThrow('There are no shopping lists on this ICA account yet. Create one with create_shopping_list, or in the ICA app.');
    expect(() => resolveList([], undefined, false)).toThrow(/^There are no shopping lists on this ICA account yet\. Create one in the ICA app\.$/);
  });
});

describe('listView, compact, day', () => {
  it('puts open items first and keeps ids', () => {
    const v = listView({ id: 1, offlineId: 'L', title: 'T', rows: [
      { offlineId: 'a', productName: 'Bröd', isStrikedOver: true }, { offlineId: 'b', productName: 'Ägg', isStrikedOver: false, quantity: 6, unit: 'st' },
    ] });
    expect(v).toEqual({ id: 'L', title: 'T', open: 1, checked: 1, items: [{ id: 'b', text: 'Ägg', qty: '6 st', checked: false }, { id: 'a', text: 'Bröd', checked: true }] });
  });
  it('qtyText renders only a numeric quantity, with the unit when there is one', () => {
    const r = { offlineId: 'x', productName: 'x', isStrikedOver: false };
    expect(qtyText({ ...r, quantity: 2 })).toBe('2');
    expect(qtyText({ ...r, quantity: 1.5, unit: 'kg' })).toBe('1.5 kg');
    expect(qtyText({ ...r, quantity: null, unit: 'st' })).toBeUndefined();
    expect(qtyText(r)).toBeUndefined();
  });
  it('compact drops null and undefined; day keeps the date part', () => {
    expect(compact({ a: 1, b: null, c: undefined, d: '' })).toEqual({ a: 1, d: '' });
    expect(day('2026-10-04T23:59:59')).toBe('2026-10-04');
    expect(day(null)).toBeUndefined();
  });
  it('day gives the Europe/Stockholm date for a time with Z or an offset, and for an epoch', () => {
    // just after midnight in Stockholm on the 1st (still the 31st in UTC), summer and winter
    expect(day('2026-08-31T22:30:00Z')).toBe('2026-09-01');
    expect(day('2026-01-31T23:30:00.000Z')).toBe('2026-02-01');
    // just after midnight UTC on the 1st is the 1st in Stockholm too
    expect(day('2026-09-01T00:05:00Z')).toBe('2026-09-01');
    expect(day('2026-08-31T23:30:00+01:00')).toBe('2026-09-01');
    expect(day('2026-08-31T23:30:00+0200')).toBe('2026-08-31');
    // no zone: ICA's local time, the date as written
    expect(day('2026-08-31T23:30:00')).toBe('2026-08-31');
    expect(day(Date.parse('2026-08-31T22:30:00Z'))).toBe('2026-09-01');
    expect(day(Date.parse('2026-08-31T22:30:00Z') / 1000)).toBe('2026-09-01');
    expect(day('not a date')).toBeUndefined();
    expect(day('2026-08-31T99:99:99Z')).toBeUndefined();
  });
});
