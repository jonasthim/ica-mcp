import { describe, expect, it } from 'vitest';
import type { AppListRow } from '../../ica/app-api.js';
import { matchRows } from './match.js';

const row = (offlineId: string, productName: string, isStrikedOver = false): AppListRow => ({ offlineId, productName, isStrikedOver });
const ROWS = [row('M', 'Mjölk'), row('H', 'Havremjölk'), row('A', 'Ägg'), row('B', 'Bröd', true)];
const open = (r: AppListRow) => !r.isStrikedOver;
const done = (r: AppListRow) => r.isStrikedOver;
const ids = (rs: AppListRow[]) => rs.map((r) => r.offlineId);

describe('matchRows', () => {
  it('prefers the exact text over a longer one containing it', () => {
    expect(ids(matchRows(ROWS, ['mjölk'], open).matched)).toEqual(['M']);
  });
  it('accepts a unique part of the text, any case and Unicode form', () => {
    expect(ids(matchRows(ROWS, ['HAVRE', 'ägg'], open).matched)).toEqual(['H', 'A']);
    expect(ids(matchRows(ROWS, ['ägg'], open).matched)).toEqual(['A']);
  });
  it('returns candidates instead of guessing', () => {
    const m = matchRows([row('M3', 'Mjölk 3%'), row('H', 'Havremjölk')], ['mjölk'], open);
    expect(m.matched).toEqual([]);
    expect(m.ambiguous).toEqual([{ query: 'mjölk', candidates: [{ id: 'M3', text: 'Mjölk 3%', checked: false }, { id: 'H', text: 'Havremjölk', checked: false }] }]);
  });
  it('an id always wins, even where the text would be ambiguous', () => {
    expect(ids(matchRows([row('M3', 'Mjölk 3%'), row('H', 'Havremjölk')], ['H'], open).matched)).toEqual(['H']);
  });
  it('reports rows already in the wanted state as unchanged, and unknown texts as not found', () => {
    const m = matchRows(ROWS, ['bröd', 'banan'], open);
    expect(m.unchanged).toEqual([{ query: 'bröd', id: 'B', text: 'Bröd' }]);
    expect(m.notFound).toEqual(['banan']);
  });
  it('matches a row once, and a repeated query once', () => {
    const m = matchRows(ROWS, ['mjölk', 'Mjölk'], open);
    expect(ids(m.matched)).toEqual(['M']);
    expect(m.ambiguous).toEqual([]);
  });

  it('an exact text on a row already in the wanted state is never redirected to a longer open one', () => {
    // "mjölk" is checked; "Havremjölk" is open: checking "mjölk" must not check the oat milk.
    const m = matchRows([row('M', 'Mjölk', true), row('H', 'Havremjölk')], ['mjölk'], open);
    expect(m.matched).toEqual([]);
    expect(m.unchanged).toEqual([{ query: 'mjölk', id: 'M', text: 'Mjölk' }]);
  });
  it('a part that fits rows in both states is ambiguous, with each candidate\'s state', () => {
    const m = matchRows([row('M', 'Mjölk', true), row('H', 'Havremjölk')], ['mjö'], open);
    expect(m.matched).toEqual([]);
    expect(m.ambiguous).toEqual([{ query: 'mjö', candidates: [{ id: 'M', text: 'Mjölk', checked: true }, { id: 'H', text: 'Havremjölk', checked: false }] }]);
  });
  it('a part that fits only rows already in the wanted state is unchanged, not ambiguous', () => {
    const m = matchRows([row('M', 'Mjölk', true), row('H', 'Havremjölk', true)], ['mjö'], open);
    expect(m.ambiguous).toEqual([]);
    expect(m.unchanged.map((u) => u.id)).toEqual(['M', 'H']);
  });
  it('two identical open rows are ambiguous (ids decide); one open and one checked copy matches the open one', () => {
    expect(matchRows([row('M1', 'Mjölk'), row('M2', 'mjölk')], ['Mjölk'], open).ambiguous[0]!.candidates.map((c) => c.id)).toEqual(['M1', 'M2']);
    expect(ids(matchRows([row('M1', 'Mjölk', true), row('M2', 'Mjölk')], ['mjölk'], open).matched)).toEqual(['M2']);
  });
  it('unchecking matches checked rows, and an id of a row already open is unchanged', () => {
    expect(ids(matchRows(ROWS, ['bröd'], done).matched)).toEqual(['B']);
    expect(matchRows(ROWS, ['M'], done).unchanged).toEqual([{ query: 'M', id: 'M', text: 'Mjölk' }]);
  });
  it('never resolves a query by elimination: an earlier match does not narrow a later query, in either order', () => {
    const rows = [row('M3', 'Mjölk 3%'), row('H', 'Havremjölk')];
    for (const qs of [['mjölk 3%', 'mjölk'], ['mjölk', 'mjölk 3%'], ['M3', 'mjölk'], ['mjölk', 'M3']]) {
      const m = matchRows(rows, qs, open);
      expect(ids(m.matched), qs.join(',')).toEqual(['M3']);
      expect(m.ambiguous, qs.join(',')).toEqual([{ query: 'mjölk', candidates: [{ id: 'M3', text: 'Mjölk 3%', checked: false }, { id: 'H', text: 'Havremjölk', checked: false }] }]);
    }
  });
  it('an id and a text naming the same row match it once, in either order, and never move on to another row', () => {
    const rows = [row('M', 'Mjölk'), row('H', 'Havremjölk')];
    for (const qs of [['M', 'mjölk'], ['mjölk', 'M']]) {
      const m = matchRows(rows, qs, open);
      expect(ids(m.matched), qs.join(',')).toEqual(['M']);
      expect([m.ambiguous, m.notFound, m.unchanged]).toEqual([[], [], []]);
    }
  });
  it('a text whose candidates were all matched by earlier queries is the same rows again, not ambiguous', () => {
    const m = matchRows([row('M3', 'Mjölk 3%'), row('H', 'Havremjölk')], ['mjölk 3%', 'havremjölk', 'mjölk'], open);
    expect(ids(m.matched)).toEqual(['M3', 'H']);
    expect([m.ambiguous, m.notFound, m.unchanged]).toEqual([[], [], []]);
  });
  it('ids are deduplicated exactly (case matters), texts by their matching form', () => {
    const rows = [row('ab', 'Ost'), row('AB', 'Smör')];
    expect(ids(matchRows(rows, ['ab', 'AB'], open).matched)).toEqual(['ab', 'AB']);
    const m = matchRows(ROWS, ['Ägg', 'a\u0308gg', ' ÄGG '], open);
    expect(ids(m.matched)).toEqual(['A']);
    expect([m.ambiguous, m.notFound]).toEqual([[], []]);
  });
  it('without substring matching only an exact text or an id matches', () => {
    const m = matchRows(ROWS, ['e', 'havre', 'mjölk', 'A'], () => true, { substring: false });
    expect(ids(m.matched)).toEqual(['M', 'A']);
    expect(m.notFound).toEqual(['e', 'havre']);
  });
  it('an ambiguous query changes nothing while the others in the same call still match', () => {
    const m = matchRows(ROWS, ['mj', 'ägg'], open);
    expect(ids(m.matched)).toEqual(['A']);
    expect(m.ambiguous.map((a) => a.query)).toEqual(['mj']);
  });
});
