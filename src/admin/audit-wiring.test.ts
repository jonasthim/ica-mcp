import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/index.js';
import { adminClient, startTestApp, TEST_PASSWORD, type TestCtx } from '../test-helpers.js';

let t: TestCtx;
beforeAll(async () => {
  t = await startTestApp();
  await t.auth.api.createUser({ body: { email: 'admin@example.com', password: TEST_PASSWORD, name: 'Admin', role: 'admin' } });
});
afterAll(async () => { await t.close(); });
const events = () => t.db.select().from(schema.auditEvent).all().map((e) => ({ ...e, details: JSON.parse(e.detailsJson) as Record<string, unknown> }));

describe('audit wiring', () => {
  it('records local sign-in, failed sign-in and sign-out with actor, IP and method', async () => {
    const c = adminClient(t);
    await c.signIn('admin@example.com', 'wrong-password-123');
    await c.signIn('admin@example.com');
    await c.post('/admin/logout', {});
    const e = events();
    expect(e.map((x) => [x.action, x.outcome])).toEqual([['auth.login_failed', 'failure'], ['auth.login', 'success'], ['auth.logout', 'success']]);
    expect(e[0]!.details).toEqual({ method: 'local', reason: 'credentials', email: 'admin@example.com' });
    expect(e[1]!.actorUserId).toBeTruthy();
    expect(e[1]!.ip).toBe('127.0.0.1');
    expect(JSON.stringify(e)).not.toContain(TEST_PASSWORD);
  });

  it('records a successful sign-in against the user, lowercasing the typed email, and the sign-out by the same actor', async () => {
    const before = events().length;
    const c = adminClient(t);
    await c.signIn('Admin@Example.COM');
    await c.post('/admin/logout', {});
    const [login, logout] = events().slice(before);
    const id = t.db.select().from(schema.user).get()!.id;
    expect(login).toMatchObject({ action: 'auth.login', actorUserId: id, targetType: 'user', targetId: id, details: { method: 'local' } });
    expect(logout).toMatchObject({ action: 'auth.logout', actorUserId: id });
  });

  it('records a rate-limited sign-in as a failure with reason rate', async () => {
    const c = adminClient(t);
    let r: Response;
    let n = 0;
    do { r = await c.signIn('Nobody@Example.com', 'wrong-password-123'); n++; } while (r.status !== 429 && n < 20);
    expect(r.status).toBe(429);
    expect(events().at(-1)).toMatchObject({ action: 'auth.login_failed', outcome: 'failure', actorUserId: null, details: { method: 'local', reason: 'rate', email: 'nobody@example.com' } });
  });

  it('writes one rate row per limiter key per window, however many 429s follow', async () => {
    const c = adminClient(t);
    const rateRows = () => events().filter((e) => e.details.reason === 'rate').length;
    const before = rateRows(); // the IP was limited (and reported) by the test above, in this same window
    for (let i = 0; i < 30; i++) expect((await c.signIn('Nobody@Example.com', 'wrong-password-123')).status).toBe(429);
    expect(rateRows()).toBe(before);
  });
});
