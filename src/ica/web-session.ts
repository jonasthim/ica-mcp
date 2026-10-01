import type { IcaEndpoints } from './endpoints.js';
import { readBody, type IcaSession } from './http.js';
import { shapeOf } from './shape.js';
import { isRecord, str } from './json.js';

/** ICA did not accept the login (no web session cookie, no accessToken, or `loginState: 0`). */
export class IcaLoginRejected extends Error {}

export type UserInformation = {
  status: number; accessToken: string | undefined; loginState: number | undefined; firstName: string | undefined; tokenExpires: string | undefined;
  /** A stable id of the ICA person (see WEB_SUBJECT_KEYS), as a string; only ever hashed (Cipher.mac), never stored or logged. */
  subject: string | undefined;
  shape: string;
};

/**
 * Keys of /api/user/information that hold a stable id of the ICA person. // shape: from the 2026-09-30 live capture
 * Only `customerId` (a number): no guessed fallbacks, since a fallback key holding another identifier (e.g. when
 * ICA drops `customerId` from one answer) would hash differently and refuse the same person. An empty list would
 * disable the web check.
 *
 * `customerId` is per person, not per household (verified live 2026-09-30: two household members' hashes differ), so
 * the check tells partners apart. Each hub user has their own ica_account row with its own hash.
 */
export const WEB_SUBJECT_KEYS: readonly string[] = ['customerId'];

/** A non-empty string, or a finite number as its decimal string (the live `customerId` is a number); else undefined. */
const idOf = (v: unknown): string | undefined => (typeof v === 'number' ? (Number.isFinite(v) ? String(v) : undefined) : str(v));

/** An ISO timestamp from ICA's `tokenExpires` (ISO string, or epoch seconds/milliseconds), else undefined. */
function isoOf(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? undefined : new Date(t).toISOString(); }
  return undefined;
}

/** GET www.ica.se /api/user/information with the jar's `thSessionId`. Only the fields we use are kept. */
export async function fetchUserInformation(session: IcaSession, endpoints: IcaEndpoints): Promise<UserInformation> {
  const r = await session.fetch(`${endpoints.web}/api/user/information`, { headers: { Accept: 'application/json' } });
  const { json } = await readBody(r);
  const o = isRecord(json) ? json : {};
  return {
    status: r.status,
    accessToken: str(o.accessToken),
    loginState: typeof o.loginState === 'number' ? o.loginState : undefined,
    firstName: str(o.firstName) ?? str(o.firstname) ?? str(o.givenName),
    tokenExpires: isoOf(o.tokenExpires),
    subject: WEB_SUBJECT_KEYS.map((k) => idOf(o[k])).find((v) => v !== undefined),
    shape: shapeOf(json),
  };
}

/** The error recorded on a web session ICA no longer accepts (diagnostics found it logged out). */
export const WEB_SESSION_LOGGED_OUT = 'ICA session is no longer logged in';
/** The error recorded on a web session row that cannot be decrypted (wrong or changed master key). */
export const WEB_SESSION_UNREADABLE = 'the stored ICA session cannot be decrypted — reconnect';
