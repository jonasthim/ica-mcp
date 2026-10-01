import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import { userCount } from '../users/first-admin.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32: no 0/1/8/9, no look-alikes
export const SETUP_COOKIE = 'ica-hub.setup';
const SESSION_MS = 30 * 60_000;
const CLAIM_MS = 120_000;

export const normaliseSetupCode = (s: string): string => s.toUpperCase().replace(/[\s-]/g, '');
export const formatSetupCode = (code: string): string => code.match(/.{1,4}/g)!.join('-');
const digest = (s: string): Buffer => createHash('sha256').update(s).digest();
const hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export type SetupGate = { claimFirstAdmin(cookieHeader: string | undefined): boolean; close(): void };
export type Setup = SetupGate & {
  isOpen(): boolean; announce(): void; checkCode(input: unknown): boolean; startSession(): string;
  hasSession(cookieHeader: string | undefined): boolean; sessionKey(cookieHeader: string | undefined): string | undefined; clearCookie(): string;
};

/**
 * First-run setup (spec 1.6): open only while the `user` table is empty, latched closed for the life of the process
 * once any user exists (`closed: true` starts it closed — the test default). The code exists only in memory and in
 * the log line; a correct code starts a 30-minute setup session held in a cookie whose SHA-256 is kept here.
 */
export function createSetup(o: { db: Db; config: Pick<Config, 'setupCode' | 'publicUrl'>; log: Pick<Logger, 'warn'>; closed?: boolean; now?: () => number }): Setup {
  const now = o.now ?? Date.now;
  let closed = o.closed ?? false;
  let code: string | undefined;
  let announced = false;
  let claimedAt = Number.NEGATIVE_INFINITY;
  const sessions = new Map<string, number>(); // sha256(cookie value) → expiry
  const attrs = `Path=/; HttpOnly; SameSite=Lax${o.config.publicUrl.startsWith('https:') ? '; Secure' : ''}`;

  function close(): void { closed = true; code = undefined; sessions.clear(); }
  function isOpen(): boolean {
    if (closed) return false;
    if (userCount(o.db) > 0) { close(); return false; }
    return true;
  }
  const keyOf = (h: string | undefined): string | undefined => {
    const v = /(?:^|;\s*)ica-hub\.setup=([A-Za-z0-9_-]{43})(?:;|$)/.exec(h ?? '')?.[1];
    return v && hex(v);
  };
  function hasSession(h: string | undefined): boolean {
    if (!isOpen()) return false;
    const k = keyOf(h); const exp = k ? sessions.get(k) : undefined;
    if (exp !== undefined && exp <= now()) sessions.delete(k!);
    return exp !== undefined && exp > now();
  }
  function announce(): void {
    if (announced || !isOpen()) return;
    code ??= Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    announced = true;
    // The only secret ICA-MCP ever logs, and only while nobody can sign in yet.
    o.log.warn(`setup code: ${formatSetupCode(code)}`);
    o.log.warn(`open ${o.config.publicUrl}/admin/setup and enter the setup code to create the first admin`);
  }
  return {
    isOpen, announce, hasSession, close,
    checkCode(input) {
      if (typeof input !== 'string' || !isOpen()) return false;
      announce(); // a code exists from here on
      const given = digest(normaliseSetupCode(input));
      let ok = false;
      for (const c of [code, o.config.setupCode]) if (c && timingSafeEqual(given, digest(c))) ok = true; // no early exit
      return ok;
    },
    startSession() {
      const v = randomBytes(32).toString('base64url');
      sessions.set(hex(v), now() + SESSION_MS);
      return `${SETUP_COOKIE}=${v}; Max-Age=${SESSION_MS / 1000}; ${attrs}`;
    },
    sessionKey: (h) => (hasSession(h) ? keyOf(h) : undefined),
    clearCookie: () => `${SETUP_COOKIE}=; Max-Age=0; ${attrs}`,
    /** OIDC-first setup: the first callback that validates with a live setup session wins; others wait out CLAIM_MS. */
    claimFirstAdmin(h) {
      if (!hasSession(h) || now() - claimedAt < CLAIM_MS) return false;
      claimedAt = now();
      return true;
    },
  };
}
