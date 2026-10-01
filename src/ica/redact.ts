/**
 * Redaction for anything ICA returns that we log or render (ported from spike/lib/http.ts, extended). Two layers:
 * keys that name a secret or personal field are replaced wholesale, and string/number values that *look* like a
 * personnummer, card number, JWT or email are replaced whatever their key. Over-redaction is fine; leaks are not.
 */
export const SECRET_KEY = /token|secret|password|cookie|personnummer|ssn|pnr|civic|username|code|state|card|address|firstName|lastName|fullName|givenName|surname|familyName|email|phone|session|authorization|bearer|(owner|member|customer|contact|display|nick|user)name|nickname|owner|member|customer|contact|person|profile|participant|sharedWith|household|birth|street|city|zip|postal|createdBy|modifiedBy|updatedBy|author/i;
/** Keys that match SECRET_KEY but are known to be harmless and useful for diagnostics. */
const SAFE_KEY = /^loginState$/;
const REDACTED = '<redacted>';

const PNR = /^(?:19|20)?\d{6}[-+]?\d{4}$/;
const CARD = /^\d{14,19}$/;
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const secretValue = (s: string): boolean => PNR.test(s) || CARD.test(s) || JWT.test(s) || EMAIL.test(s);

const secretKey = (k: string): boolean => SECRET_KEY.test(k) && !SAFE_KEY.test(k);

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'string') return secretValue(value.trim()) ? REDACTED : redactText(value);
  if (typeof value === 'number') return Number.isInteger(value) && secretValue(String(value)) ? REDACTED : value;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, secretKey(k) ? REDACTED : redact(v)]));
  }
  return value;
}

/** Scrub secret-looking substrings from free text (an HTML error page, a non-JSON body). */
export const redactText = (text: string): string =>
  text
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, REDACTED)
    .replace(/[^\s@"'<>(){}[\],;:]+@[^\s@"'<>(){}[\],;:]+\.[a-z]{2,}/gi, REDACTED)
    .replace(/\b\d{14,19}\b/g, REDACTED)
    .replace(/\b(?:19|20)?\d{6}[-+]?\d{4}\b/g, REDACTED);

/** Redact query/fragment parameters whose key matches SECRET_KEY or is a signature/expiry. */
export const redactUrl = (u: string): string =>
  u.replace(/[?&#]([^=&\s#]+)=([^&\s#]*)/g, (match, key: string) =>
    SECRET_KEY.test(key) || /^(sig|exp)$/i.test(key) ? `${match.charAt(0)}${key}=${REDACTED}` : match);
