/** ICA is Swedish: a purchase "happened on" its date in Stockholm, whatever zone ICA writes the time in. */
const STOCKHOLM = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' });

/** `YYYY-MM-DD` of an instant in Europe/Stockholm, or undefined for an invalid date. */
export function stockholmDay(d: Date): string | undefined {
  if (Number.isNaN(d.getTime())) return undefined;
  const p = Object.fromEntries(STOCKHOLM.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** A date-time string that names its zone (`Z` or `±hh:mm` / `±hhmm` after a time). */
const ZONED = /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:?\d\d)$/i;

/**
 * `YYYY-MM-DD` of an ICA timestamp: a zoned string or an epoch (seconds or milliseconds) is converted to the
 * Stockholm date; a string without a zone is ICA's local time and keeps its written date. Else undefined.
 */
export function icaDay(v: string | number | null | undefined): string | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? stockholmDay(new Date(Math.abs(v) < 1e11 ? v * 1000 : v)) : undefined;
  if (!v) return undefined;
  if (ZONED.test(v)) return stockholmDay(new Date(v));
  return /^\d{4}-\d\d-\d\d/.test(v) ? v.slice(0, 10) : undefined;
}
