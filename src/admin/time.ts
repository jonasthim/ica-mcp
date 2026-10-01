/**
 * Stockholm-local calendar-day boundaries, as UTC instants — for filtering by a date the household typed (e.g. the
 * Activity page's `from`/`to`), where the stored `audit_event.at` is UTC and the page itself shows Stockholm time.
 * A plain UTC day boundary would be off by 1–2 hours around local midnight (Sweden is UTC+1 or UTC+2, DST-dependent).
 */

const STOCKHOLM = 'Europe/Stockholm';

/** The wall-clock Stockholm reads at a given instant, as its own components (for the offset trick below). */
const WALL_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: STOCKHOLM, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/**
 * Stockholm's offset from UTC (ms, positive = ahead of UTC — e.g. +2h in Swedish summer time) at the instant `at`.
 * No timezone-conversion library is used: formatting `at` in Stockholm gives its wall-clock there; re-reading those
 * same numbers as if they were UTC gives an instant whose distance from `at` is exactly the offset.
 */
function stockholmOffsetMs(at: number): number {
  const parts = Object.fromEntries(WALL_FORMAT.formatToParts(new Date(at)).map((p) => [p.type, p.value])) as Record<string, string>;
  const hour = parts.hour === '24' ? 0 : Number(parts.hour); // midnight can format as "24:00" depending on the ICU version
  const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  return asIfUtc - at;
}

/**
 * The UTC instant of local midnight (00:00) on `dateStr` (`YYYY-MM-DD`) in Stockholm. Correct across the DST
 * transition: Sweden's clocks change at 02:00/03:00 local, so midnight itself is never ambiguous or skipped.
 */
function stockholmMidnightUtc(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  return new Date(utcGuess - stockholmOffsetMs(utcGuess));
}

/** `dateStr`'s calendar date plus one day, as `YYYY-MM-DD` (pure calendar arithmetic — no timezone involved). */
function nextDateStr(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** 00:00 local on `dateStr`, as a UTC instant (ISO) — the inclusive lower bound of that Stockholm calendar day. */
export const stockholmDayStartUtc = (dateStr: string): string => stockholmMidnightUtc(dateStr).toISOString();

/**
 * 00:00 local on the day *after* `dateStr`, as a UTC instant (ISO) — the exclusive upper bound of that Stockholm
 * calendar day. On a DST-transition day this span is 23 or 25 hours long, which is correct: that is how long the
 * calendar day actually lasted in Stockholm.
 */
export const stockholmDayEndUtc = (dateStr: string): string => stockholmMidnightUtc(nextDateStr(dateStr)).toISOString();
