import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CHROME_UA, IPHONE_UA, newSession, now } from './http.js';
import { WEB, appApi, gatewayApi, type AppState } from './app-auth.js';
import { loadJar } from './jar.js';

export type ListRow = { id: string; text: string; striked: boolean; raw: Record<string, unknown> };
export type ListSummary = { id: string; name: string; raw: Record<string, unknown> };
export type ListClient = {
  kind: 'app' | 'web';
  lists(): Promise<ListSummary[]>;
  rows(listId: string): Promise<ListRow[]>;
  addRow(listId: string, text: string): Promise<{ status: number; body: unknown; rowId: string | null }>;
  strikeRow(listId: string, row: ListRow, striked: boolean): Promise<{ status: number; body: unknown }>;
  deleteRow(listId: string, row: ListRow): Promise<{ status: number; body: unknown }>;
};

const SL = 'sverige/digx/mobile/shoppinglistservice/v1/shoppinglists';
const WL = 'sverige/digx/shopping-list/v1/api';

export async function listClientFor(who: 'A' | 'B'): Promise<ListClient> {
  const appPath = `spike/out/app-state-${who}.json`;
  if (existsSync(appPath)) {
    const st = JSON.parse(readFileSync(appPath, 'utf8')) as AppState;
    const s = newSession(IPHONE_UA);
    type Raw = { offlineId: string; title: string; rows?: { offlineId: string; productName: string; isStrikedOver: boolean }[] } & Record<string, unknown>;
    return {
      kind: 'app',
      lists: async () => ((await appApi<{ shoppingLists: Raw[] }>(s, st, 'GET', SL)).json?.shoppingLists ?? []).map((l) => ({ id: l.offlineId, name: l.title, raw: l })),
      rows: async (id) => ((await appApi<Raw>(s, st, 'GET', `${SL}/${id}`)).json?.rows ?? []).map((r) => ({ id: r.offlineId, text: r.productName, striked: r.isStrikedOver, raw: r })),
      addRow: async (id, text) => {
        const offlineId = randomUUID().toUpperCase();
        const r = await appApi(s, st, 'POST', `${SL}/${id}/sync`, { createdRows: [{ offlineId, productName: text, sourceId: -Math.floor(1e6 + Math.random() * 1e9), isStrikedOver: false, recipes: [] }] });
        return { status: r.status, body: r.json, rowId: offlineId };
      },
      strikeRow: async (id, row, striked) => { const r = await appApi(s, st, 'POST', `${SL}/${id}/sync`, { changedRows: [{ ...row.raw, isStrikedOver: striked, latestChange: now() }] }); return { status: r.status, body: r.json }; },
      deleteRow: async (id, row) => { const r = await appApi(s, st, 'POST', `${SL}/${id}/sync`, { deletedRows: [row.id] }); return { status: r.status, body: r.json }; },
    };
  }
  const jar = loadJar(`web-jar-${who}`);
  if (!jar) throw new Error(`no session for ${who}: run ACCOUNT=${who} pnpm spike spike/01-bankid-login.ts`);
  const s = newSession(CHROME_UA, jar);
  let bearer: { token: string; until: number } | null = null;
  const token = async (): Promise<string> => {
    if (bearer && bearer.until > Date.now()) return bearer.token;
    const info = (await (await s.fetch(`${WEB}/api/user/information`, { headers: { Accept: 'application/json' } })).json()) as { accessToken?: string; loginState?: number };
    if (!info.accessToken || info.loginState === 0) throw new Error(`web session for ${who} is dead (loginState=${info.loginState}) — scan again`);
    bearer = { token: info.accessToken, until: Date.now() + 4 * 60_000 };
    return bearer.token;
  };
  const call = async (method: string, path: string, body?: unknown) => gatewayApi(s, await token(), method, path, body);
  type WRaw = { id: string; name?: string; rows?: ({ id: string; text?: string; isStriked?: boolean } & Record<string, unknown>)[] } & Record<string, unknown>;
  const fetchRows = async (id: string) => (((await call('GET', `${WL}/list/all`)).json as WRaw[] | null) ?? []).find((l) => l.id === id)?.rows ?? [];
  return {
    kind: 'web',
    lists: async () => (((await call('GET', `${WL}/list/all`)).json as WRaw[] | null) ?? []).map((l) => ({ id: l.id, name: l.name ?? '', raw: l })),
    rows: async (id) => (await fetchRows(id)).map((r) => ({ id: r.id, text: r.text ?? '', striked: Boolean(r.isStriked), raw: r })),
    addRow: async (id, text) => {
      const r = await call('POST', `${WL}/list/${id}/row`, { isStriked: false, quantity: {}, text, article: null });
      // The create response doesn't always carry the new row's id — re-read the rows and match by exact text if not.
      const rowId = (r.json as { id?: string } | null)?.id ?? (await fetchRows(id)).find((row) => row.text === text)?.id ?? null;
      return { status: r.status, body: r.json, rowId };
    },
    strikeRow: async (_id, row, striked) => { const r = await call('PUT', `${WL}/row/${row.id}`, { ...row.raw, isStriked: striked }); return { status: r.status, body: r.json }; },
    deleteRow: async (_id, row) => { const r = await call('DELETE', `${WL}/row/${row.id}`); return { status: r.status, body: r.json }; },
  };
}
