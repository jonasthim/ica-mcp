import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, startTestApp, TEST_PASSWORD, type TestCtx } from '../test-helpers.js';

let t: TestCtx;
const EMAIL = 'admin@example.com';
beforeAll(async () => {
  t = await startTestApp();
  await t.auth.api.createUser({ body: { email: EMAIL, password: TEST_PASSWORD, name: 'Admin', role: 'admin' } });
});
afterAll(async () => { await t.close(); });

const tokenIn = (html: string): string => /name="_csrf" value="([^"]+)"/.exec(html)![1]!;

describe('same-origin check (fail-closed)', () => {
  it('rejects a POST with neither Origin nor Referer', async () => {
    const c = adminClient(t);
    expect((await c.post('/admin/login', { email: EMAIL, password: TEST_PASSWORD }, { origin: null })).status).toBe(403);
  });
  it('rejects a foreign Origin and a foreign Referer', async () => {
    const c = adminClient(t);
    expect((await c.post('/admin/login', { email: EMAIL, password: TEST_PASSWORD }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await c.post('/admin/login', { email: EMAIL, password: TEST_PASSWORD }, { origin: null, referer: 'https://evil.example/x' })).status).toBe(403);
  });
  it('accepts a same-origin Referer when Origin is absent', async () => {
    const c = adminClient(t);
    const r = await c.post('/admin/login', { email: EMAIL, password: TEST_PASSWORD, next: '/admin' }, { origin: null, referer: `${t.url}/admin/login` });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/admin');
  });
});

describe('CSRF synchronizer token', () => {
  it('rejects a POST without the token and one with a token from another browser', async () => {
    const a = adminClient(t); const b = adminClient(t);
    await a.signIn(EMAIL);
    const noToken = await a.post('/admin/logout', {}, { csrf: null });
    expect(noToken.status).toBe(303);
    expect((await a.get('/admin')).status).toBe(200); // still signed in
    await b.get('/admin/login');
    const foreign = await a.post('/admin/logout', {}, { csrf: tokenIn(await (await b.get('/admin/login')).text()) });
    expect(foreign.status).toBe(303);
    expect((await a.get('/admin')).status).toBe(200);
  });
  it('binds the token to the session: a pre-login token is refused after sign-in', async () => {
    const c = adminClient(t);
    const before = tokenIn(await (await c.get('/admin/login')).text());
    await c.signIn(EMAIL);
    const r = await c.post('/admin/logout', {}, { csrf: before });
    expect(r.status).toBe(303);
    expect((await c.get('/admin')).status).toBe(200);
  });
  it('sends an HTML form back with the csrf flash, and answers a non-HTML client 403', async () => {
    const c = adminClient(t);
    await c.signIn(EMAIL);
    const r = await c.post('/admin/logout', {}, { csrf: 'x', referer: `${t.url}/admin/ica` });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/admin/ica');
    const page = await (await c.get('/admin')).text();
    expect(page).toContain('The form expired. Please try again.');
    const offsite = await c.post('/admin/logout', {}, { csrf: 'x', referer: `${t.url}/elsewhere` });
    expect(offsite.headers.get('location')).toBe('/admin');
    const plain = await fetch(`${t.url}/admin/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: c.cookie(), origin: t.url, 'content-type': 'application/x-www-form-urlencoded' }, body: '_csrf=x' });
    expect(plain.status).toBe(403);
    expect(await plain.text()).toBe('invalid CSRF token'); // the CSRF check, not the origin check, refused it
    expect((await c.get('/admin')).status).toBe(200);
  });
  it('accepts the right token (sign-out works)', async () => {
    const c = adminClient(t);
    await c.signIn(EMAIL);
    const r = await c.post('/admin/logout', {});
    expect(r.status).toBe(302);
    expect((await c.get('/admin')).status).toBe(302);
  });
  it('issues the random cookie HttpOnly, SameSite=Lax, on /admin only', async () => {
    const r = await fetch(`${t.url}/admin/login`);
    const sc = r.headers.getSetCookie().find((x) => x.startsWith('ica-hub.csrf='))!;
    expect(sc).toMatch(/^ica-hub\.csrf=[A-Za-z0-9_-]{43}; Path=\/admin; HttpOnly; SameSite=Lax$/);
  });
});

describe('flash + PRG', () => {
  it('shows a flash once after a redirect, then never again', async () => {
    const c = adminClient(t);
    await c.signIn(EMAIL);
    await c.post('/admin/theme', { theme: 'dark', next: '/admin' });
    const first = await (await c.get('/admin')).text();
    expect(first).toContain('role="status"');
    expect(first).toContain('Theme saved.');
    const second = await (await c.get('/admin')).text();
    expect(second).not.toContain('role="status"');
  });
  it('ignores a forged flash cookie', async () => {
    const r = await fetch(`${t.url}/admin/login`, { headers: { cookie: 'ica-hub.flash=eyJraW5kIjoiZXJyb3IiLCJjb2RlIjoieCJ9.forged' } });
    expect(await r.text()).not.toContain('role="status"');
  });
});

describe('session cookie', () => {
  it('is HttpOnly, SameSite=Lax, 7 days', async () => {
    const c = adminClient(t);
    const r = await c.signIn(EMAIL);
    const sc = r.headers.getSetCookie().find((x) => x.includes('session_token='))!;
    expect(sc).toMatch(/HttpOnly/i); expect(sc).toMatch(/SameSite=Lax/i); expect(sc).toMatch(/Max-Age=604800/);
  });
  it('is Secure for an https public URL', async () => {
    const { createAuth } = await import('../auth/index.js');
    const auth = createAuth({ ...t.config, publicUrl: 'https://ica.example.com', authIssuer: 'https://ica.example.com/auth', mcpResource: 'https://ica.example.com/mcp' }, t.db);
    const ctx = await auth.$context;
    expect(ctx.authCookies.sessionToken.attributes.secure).toBe(true);
    expect(ctx.sessionConfig.expiresIn).toBe(60 * 60 * 24 * 7);
    expect(ctx.sessionConfig.updateAge).toBe(60 * 60 * 24);
  });
});

describe('roles', () => {
  it('answers 403 with the styled page for a member on an admin route', async () => {
    await t.auth.api.createUser({ body: { email: 'm@example.com', password: TEST_PASSWORD, name: 'M', role: 'member' } });
    const c = adminClient(t); await c.signIn('m@example.com');
    const r = await c.get('/admin/users');
    expect(r.status).toBe(403);
    expect(await r.text()).toContain('You do not have access to this page.');
  });
});

describe('admin error pages', () => {
  it('renders a styled 404 for an unknown /admin path, JSON elsewhere', async () => {
    const r = await fetch(`${t.url}/admin/nope`);
    expect(r.status).toBe(404);
    expect(await r.text()).toContain('This page does not exist.');
    const j = await fetch(`${t.url}/nope`);
    expect(j.status).toBe(404);
    expect(await j.json()).toEqual({ error: 'not_found' });
  });
});
