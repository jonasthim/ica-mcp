import { s } from '../i18n.js';

/** Only this much of a user agent is looked at: real ones are far shorter, and it bounds the regex work per session. */
export const UA_MAX = 512;

/**
 * Browser checks, most specific first: Edge and Samsung carry "Chrome", Chrome carries "Safari". Each is one or more
 * independent single-token regexes (no `.*` between tokens), so matching stays linear in the input.
 */
const BROWSERS: [RegExp[], string][] = [
  [[/\bEdg(?:e|A|iOS)?\//], 'Edge'],
  [[/\bSamsungBrowser\//], 'Samsung Internet'],
  [[/\bOPR\//], 'Opera'],
  [[/\b(?:Firefox|FxiOS)\//], 'Firefox'],
  [[/\b(?:Chrome|CriOS|Chromium)\//], 'Chrome'],
  [[/\bVersion\/\d/, /\bSafari\//], 'Safari'],
];
/** Platforms, most specific first: iPhone/iPad/Android UAs also say "like Mac OS X" or "Linux". */
const PLATFORMS: [RegExp[], string][] = [
  [[/\biPhone\b/], 'iPhone'],
  [[/\biPad\b/], 'iPad'],
  [[/\bAndroid\b/], 'Android'],
  [[/\bCrOS\b/], 'ChromeOS'],
  [[/\bWindows\b/], 'Windows'],
  [[/\bMac OS X\b|\bMacintosh\b/], 'Mac'],
  [[/\bLinux\b/], 'Linux'],
];
const first = (ua: string, table: [RegExp[], string][]): string | undefined => table.find(([res]) => res.every((re) => re.test(ua)))?.[1];

/**
 * A short, human label for a session's user agent ("Firefox on Android", "Safari on iPhone"), for the Profile page's
 * session list. Deliberately coarse (no versions) and dependency-free; anything unrecognised is "Unknown device".
 */
export function describeUserAgent(raw: string | null | undefined): string {
  if (!raw) return s.profile.unknownDevice;
  const ua = raw.slice(0, UA_MAX);
  if (/Claude/.test(ua)) return 'Claude';
  const browser = first(ua, BROWSERS);
  const platform = first(ua, PLATFORMS);
  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? platform ?? s.profile.unknownDevice;
}
