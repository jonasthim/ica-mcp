import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { seedUser } from '../test-helpers.js';
import { createSetup, formatSetupCode, normaliseSetupCode } from './state.js';

const cfg = { publicUrl: 'https://ica.example.com', setupCode: undefined as string | undefined };
const logger = () => { const lines: string[] = []; return { lines, log: { warn: (m: unknown) => { lines.push(String(m)); } } }; };
const cookieOf = (setCookie: string) => setCookie.split(';')[0]!;

describe('setup state', () => {
  it('logs one 12-char base32 code, once, only while the table is empty', () => {
    const db = openDb(':memory:'); const { lines, log } = logger();
    const s = createSetup({ db, config: cfg, log });
    s.announce(); s.announce();
    const codes = lines.filter((l) => l.startsWith('setup code: '));
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatch(/^setup code: [A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    const other = logger(); seedUser(db, 'u1');
    createSetup({ db, config: cfg, log: other.log }).announce();
    expect(other.lines).toEqual([]);
  });
  it('accepts the logged code in any case/format and the env code; nothing else', () => {
    const db = openDb(':memory:'); const { lines, log } = logger();
    const s = createSetup({ db, config: { ...cfg, setupCode: 'ENVCODE12345' }, log });
    s.announce();
    const code = lines[0]!.slice('setup code: '.length);
    expect(s.checkCode(code.toLowerCase())).toBe(true);
    expect(s.checkCode(normaliseSetupCode(code))).toBe(true);
    expect(s.checkCode('envc-ode1-2345')).toBe(true);
    expect(s.checkCode('AAAA-AAAA-AAAA')).toBe(false);
    expect(s.checkCode(undefined)).toBe(false);
  });
  it('closes for good once a user exists: no code, no session, no claim', () => {
    const db = openDb(':memory:'); const s = createSetup({ db, config: { ...cfg, setupCode: 'ENVCODE12345' }, log: logger().log });
    const cookie = cookieOf(s.startSession());
    expect(s.hasSession(cookie)).toBe(true);
    seedUser(db, 'u1');
    expect(s.isOpen()).toBe(false);
    expect(s.hasSession(cookie)).toBe(false);
    expect(s.checkCode('ENVCODE12345')).toBe(false);
    expect(s.claimFirstAdmin(cookie)).toBe(false);
    db.$client.prepare('delete from user').run();
    expect(s.isOpen()).toBe(false); // latched until the next start
  });
  it('the session cookie is HttpOnly, Lax, Path=/ (the OIDC callback must carry it), 30 minutes', () => {
    const s = createSetup({ db: openDb(':memory:'), config: cfg, log: logger().log });
    expect(s.startSession()).toMatch(/^ica-hub\.setup=[A-Za-z0-9_-]{43}; Max-Age=1800; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
  });
  it('sessions expire; one first-admin claim per 2 minutes, only with a session', () => {
    let t = 0; const s = createSetup({ db: openDb(':memory:'), config: cfg, log: logger().log, now: () => t });
    const c = cookieOf(s.startSession());
    expect(s.claimFirstAdmin(undefined)).toBe(false);
    expect(s.claimFirstAdmin(c)).toBe(true);
    expect(s.claimFirstAdmin(c)).toBe(false);
    t += 120_001; expect(s.claimFirstAdmin(c)).toBe(true);
    t += 30 * 60_000; expect(s.hasSession(c)).toBe(false);
  });
  it('formats', () => { expect(formatSetupCode('ABCDEFGHJKLM')).toBe('ABCD-EFGH-JKLM'); });
});
