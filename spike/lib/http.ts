import { mkdirSync, writeFileSync } from 'node:fs';
import { CookieJar } from 'tough-cookie';
import makeFetchCookie from 'fetch-cookie';

export const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
export const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type Session = { jar: CookieJar; fetch: (url: string, init?: RequestInit) => Promise<Response> };

/** A fetch bound to its own cookie jar and User-Agent. Pass `redirect: 'manual'` to read Location. */
export function newSession(userAgent: string, jar: CookieJar = new CookieJar()): Session {
  const fetchWithCookies = makeFetchCookie(fetch, jar);
  return {
    jar,
    fetch: (url, init = {}) =>
      fetchWithCookies(url, {
        ...init,
        headers: { 'User-Agent': userAgent, 'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8', ...(init.headers as Record<string, string> | undefined) },
      }),
  };
}

export function qs(url: string, key: string): string {
  const m = new RegExp(`[?&#]${key}=([^&\\s#]+)`).exec(url);
  if (!m?.[1]) throw new Error(`missing '${key}' in redirect: ${redactUrl(url)}`);
  return decodeURIComponent(m[1]);
}

export function hidden(html: string, name: string): string {
  const m =
    new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(html) ??
    new RegExp(`value="([^"]*)"[^>]*name="${name}"`).exec(html);
  if (!m?.[1]) throw new Error(`hidden field '${name}' not found — wrong credentials, BankID-only account, or form changed`);
  return m[1];
}

export const form = (data: Record<string, string>): string => new URLSearchParams(data).toString();
export const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' } as const;
export const JSONH = { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' } as const;

export async function expectJson<T = unknown>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text) as T; } catch { throw new Error(`${what}: not JSON: ${text.slice(0, 200)}`); }
}

const SECRET_KEY = /token|secret|password|cookie|personnummer|ssn|username|userName|code|state|cardNumber|address|firstName|lastName|email|phone/i;
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? '<redacted>' : redact(v)]),
    ) as T;
  }
  return value;
}

/** Redact query/fragment parameters whose key matches SECRET_KEY or is in the fixed list. */
export const redactUrl = (u: string): string =>
  u.replace(/[?&#]([^=&\s#]+)=([^&\s#]*)/g, (match, key) => {
    const isSensitive = SECRET_KEY.test(key) || /^(sig|exp)$/i.test(key);
    return isSensitive ? `${match.charAt(0)}${key}=<redacted>` : match;
  });

export function save(name: string, data: unknown): void {
  mkdirSync('spike/out', { recursive: true });
  writeFileSync(`spike/out/${name}.json`, JSON.stringify(data, null, 2));
  console.log(`saved spike/out/${name}.json`);
}
export const now = (): string => new Date().toISOString();
