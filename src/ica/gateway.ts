import type * as z from 'zod/v4';
import { CHROME_UA, readBody, withTimeout } from './http.js';
import { IcaRejected, IcaUnauthorized, IcaUnavailable, errorCategory } from './errors.js';

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type IcaRequest = { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; headers?: Record<string, string> };

/**
 * A fetch that sends `Authorization: Bearer …` (app or web token) with the browser User-Agent the relay uses. The
 * 15 s timeout always applies; a caller's `init.signal` can abort earlier.
 */
export function bearerFetcher(bearer: string): Fetcher {
  return (url, init = {}) => withTimeout(init, (i) => fetch(url, {
    ...i,
    headers: { 'User-Agent': CHROME_UA, 'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8', ...(i.headers as Record<string, string> | undefined), Authorization: `Bearer ${bearer}` },
  }));
}

/**
 * One ICA call. 451 → IcaUnavailable('geo-blocked'), 429 → IcaUnavailable('rate-limited'), 401/403 → IcaUnauthorized,
 * other 4xx → IcaRejected, 5xx → IcaUnavailable('server-error'), no answer → IcaUnavailable('network' | 'timeout'). The body is parsed as JSON when
 * it is JSON and is never put into an error. `headers` is the raw response's headers (e.g. for a caller that reads
 * `Retry-After`, such as Handla's product search 202 poll); nothing in it is logged or put into an error.
 */
export async function icaRequest(f: Fetcher, url: string, req: IcaRequest = {}): Promise<{ status: number; json: unknown; headers: Headers }> {
  const hasBody = req.body !== undefined;
  let r: Response;
  try {
    r = await f(url, {
      method: req.method ?? 'GET',
      headers: { Accept: 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...req.headers },
      ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
    });
  } catch (e) { throw new IcaUnavailable(errorCategory(e)); }
  const { json } = await readBody(r);
  if (r.status === 451) throw new IcaUnavailable('geo-blocked', 451);
  if (r.status === 429) throw new IcaUnavailable('rate-limited', 429);
  if (r.status === 401 || r.status === 403) throw new IcaUnauthorized(r.status);
  if (r.status >= 500) throw new IcaUnavailable('server-error', r.status);
  if (r.status >= 400) throw new IcaRejected(r.status);
  return { status: r.status, json, headers: r.headers };
}

/** Parse an ICA answer; a mismatch becomes IcaUnavailable('unexpected-response') carrying issue paths and codes only. */
export function parseIca<S extends z.ZodType>(schema: S, json: unknown): z.output<S> {
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 10).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.code}`);
  throw new IcaUnavailable('unexpected-response', undefined, issues);
}

export async function icaJson<S extends z.ZodType>(f: Fetcher, url: string, schema: S, req: IcaRequest = {}): Promise<z.output<S>> {
  return parseIca(schema, (await icaRequest(f, url, req)).json);
}
