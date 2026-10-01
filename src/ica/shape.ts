/**
 * The shape of an ICA JSON answer — keys and value types, never values — for the diagnostics page. Strings, numbers
 * and booleans become their type name, arrays their length plus the shape of the first element, objects their keys.
 * Containers nest at most three levels deep; below that only `object{…}` / `array[n]` is shown. A key that does not
 * look like an identifier (a date, an email, an id used as a map key) is shown as `<key>`, so data never leaks
 * through key names either. This deliberately does not rely on redaction key lists. Two further shapes never show
 * their own name either, since a map can be keyed by an identifier-looking value: a key with 6 or more digits in it
 * (a personnummer, however prefixed, e.g. `x199001011234`), and a key of 12+ characters made only of hex digits or
 * only of base64url characters with at least one digit (`a3f9c2e1b7d04411`, a token or id used as a map key).
 */
const MAX_DEPTH = 3;
const MAX_KEYS = 40;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const MANY_DIGITS = 6;
const IDENTIFIER_ID_LEN = 12;
const HEX_RUN = /^[0-9a-fA-F]+$/;
const BASE64URL_RUN = /^[A-Za-z0-9_-]+$/;

function looksLikeAnId(k: string): boolean {
  if (((k.match(/\d/g) ?? []).length) >= MANY_DIGITS) return true;
  if (k.length < IDENTIFIER_ID_LEN) return false;
  if (HEX_RUN.test(k)) return true;
  return BASE64URL_RUN.test(k) && /\d/.test(k);
}

const keyLabel = (k: string): string => (k.length <= 64 && IDENTIFIER.test(k) && !looksLikeAnId(k) ? k : '<key>');

export function shapeOf(value: unknown, depth = 1): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const head = `array[${value.length}]`;
    return depth > MAX_DEPTH || value.length === 0 ? head : `${head} of ${shapeOf(value[0], depth + 1)}`;
  }
  if (typeof value === 'object') {
    if (depth > MAX_DEPTH) return 'object{…}';
    const entries = Object.entries(value as Record<string, unknown>);
    const shown = entries.slice(0, MAX_KEYS).map(([k, v]) => `${keyLabel(k)}: ${shapeOf(v, depth + 1)}`);
    if (entries.length > MAX_KEYS) shown.push(`… ${entries.length - MAX_KEYS} more keys`);
    return `object{${shown.join(', ')}}`;
  }
  return typeof value;
}
