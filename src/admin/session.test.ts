import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/index.js';
import { adminClient, startTestApp, TEST_PASSWORD, type TestCtx } from '../test-helpers.js';
import { loadSession, requireSession } from './session.js';

let t: TestCtx;
const EMAIL = 'slide@example.com';
beforeAll(async () => {
  t = await startTestApp();
  await t.auth.api.createUser({ body: { email: EMAIL, password: TEST_PASSWORD, name: 'Slide', role: 'member' } });
});
afterAll(async () => { await t.close(); });

const DAY = 86_400_000;
const sessionCookies = (r: Response) => r.headers.getSetCookie().filter((c) => /session_token=/.test(c));

describe('sliding sessions reach the browser', () => {
  it('a session past its update age is extended and its cookie re-sent; a fresh one sends no session cookie', async () => {
    const c = adminClient(t); await c.signIn(EMAIL);
    const fresh = await c.get('/admin');
    expect(fresh.status).toBe(200);
    expect(sessionCookies(fresh)).toEqual([]);

    const row = () => t.db.select().from(schema.session).where(eq(schema.session.userId, t.db.select().from(schema.user).where(eq(schema.user.email, EMAIL)).get()!.id)).get()!;
    // Two days old: 5 days left of 7, past the 1-day update age.
    t.db.update(schema.session).set({ expiresAt: new Date(Date.now() + 5 * DAY) }).where(eq(schema.session.id, row().id)).run();
    const aged = await c.get('/admin');
    expect(aged.status).toBe(200);
    const [cookie] = sessionCookies(aged);
    expect(cookie).toMatch(/Max-Age=604800/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(row().expiresAt.getTime()).toBeGreaterThan(Date.now() + 6.9 * DAY);
    // The re-sent cookie still signs in.
    expect((await c.get('/admin')).status).toBe(200);
  });
});

describe('requireSession without loadSession', () => {
  it('forwards the Set-Cookie Better Auth returns with the session', async () => {
    const session = { user: { id: 'u' }, session: { id: 's' } };
    const headers = new Headers(); headers.append('set-cookie', 'better-auth.session_token=new; Max-Age=604800; Path=/; HttpOnly');
    const getSession = vi.fn().mockResolvedValue({ headers, response: session });
    const res = { locals: {} as Record<string, unknown>, append: vi.fn() };
    const next = vi.fn();
    await requireSession({ current: { api: { getSession } } } as never)({ headers: {}, originalUrl: '/admin' } as never, res as never, next);
    expect(getSession).toHaveBeenCalledWith(expect.objectContaining({ returnHeaders: true }));
    expect(res.append).toHaveBeenCalledWith('Set-Cookie', 'better-auth.session_token=new; Max-Age=604800; Path=/; HttpOnly');
    expect(res.locals.session).toBe(session);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('loadSession over an AuthRef', () => {
  it('reads the instance from the ref on every request, so a swapped instance is used at once', async () => {
    const none = { headers: new Headers(), response: null };
    const first = vi.fn().mockResolvedValue(none); const second = vi.fn().mockResolvedValue(none);
    const ref = { current: { api: { getSession: first } } };
    const mw = loadSession(ref as never);
    const run = () => mw({ headers: {} } as never, { locals: {}, append: vi.fn() } as never, vi.fn());
    await run();
    ref.current = { api: { getSession: second } };
    await run();
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
  });
});
