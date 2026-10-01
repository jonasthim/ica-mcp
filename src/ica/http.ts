import { CookieJar } from 'tough-cookie';
import makeFetchCookie from 'fetch-cookie';

export const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15_000;

/** A fetch bound to one cookie jar (ported from spike/lib/http.ts). Pass `redirect: 'manual'` to read Location. */
export type IcaSession = { jar: CookieJar; fetch: (url: string, init?: RequestInit) => Promise<Response> };

/**
 * Run `doFetch` with a signal that aborts on the 15 s timeout or on the caller's `init.signal`, whichever comes first.
 * The listener on the caller's signal is removed once the response (or error) is in, so a long-lived caller signal
 * does not collect one listener per request.
 */
export async function withTimeout(init: RequestInit, doFetch: (init: RequestInit) => Promise<Response>): Promise<Response> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const caller = init.signal;
  if (!caller) return doFetch({ ...init, signal: timeout });
  const c = new AbortController();
  const onTimeout = (): void => { c.abort(timeout.reason); };
  const onCaller = (): void => { c.abort(caller.reason); };
  if (timeout.aborted) onTimeout(); else timeout.addEventListener('abort', onTimeout, { once: true });
  if (caller.aborted) onCaller(); else caller.addEventListener('abort', onCaller, { once: true });
  try { return await doFetch({ ...init, signal: c.signal }); } finally { caller.removeEventListener('abort', onCaller); }
}

export function newSession(jar: CookieJar = new CookieJar(), userAgent: string = CHROME_UA): IcaSession {
  const fetchWithCookies = makeFetchCookie(fetch, jar);
  return {
    jar,
    fetch: (url, init = {}) => withTimeout(init, (i) => fetchWithCookies(url, {
      ...i,
      headers: { 'User-Agent': userAgent, 'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8', ...(i.headers as Record<string, string> | undefined) },
    })),
  };
}

/** The value of a hidden form input, in either attribute order. */
export function hidden(html: string, name: string): string | undefined {
  const m = new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(html) ?? new RegExp(`value="([^"]*)"[^>]*name="${name}"`).exec(html);
  return m?.[1] || undefined;
}

export const form = (data: Record<string, string>): string => new URLSearchParams(data).toString();
export const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' } as const;

/** Read a response body as JSON if it is JSON, else keep the text. Never throws. */
export async function readBody(res: Response): Promise<{ json: unknown; text: string }> {
  const text = await res.text().catch(() => '');
  try { return { json: text ? (JSON.parse(text) as unknown) : null, text }; } catch { return { json: null, text }; }
}
