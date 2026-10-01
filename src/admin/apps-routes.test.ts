import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/index.js';
import { escapeHtml } from './views/index.js';
import { s } from './i18n.js';
import { adminClient, connectClaude, mcpPing, startTestApp, TEST_PASSWORD, type TestCtx } from '../test-helpers.js';

let t: TestCtx;
beforeAll(async () => {
  t = await startTestApp();
  for (const e of ['owner@example.com', 'partner@example.com']) await t.auth.api.createUser({ body: { email: e, password: TEST_PASSWORD, name: e.split('@')[0]!, role: 'member' } });
});
afterAll(async () => { await t.close(); });

describe('/admin/apps', () => {
  it('lists the apps the user allowed, with scopes in plain language and last use', async () => {
    const c = adminClient(t);
    await connectClaude(t, c, { email: 'owner@example.com' });
    const html = await (await c.get('/admin/apps')).text();
    // The consent page's own description of the `mcp` scope (Task 4 wording), reused verbatim.
    expect(html).toContain(escapeHtml(s.consent.scope.mcp));
    expect(html).toContain('127.0.0.1');
    expect(html).toMatch(/<time datetime="\d{4}-\d{2}-\d{2}T/);
  });

  it('a revoked grant is refused by /mcp at once, and its refresh token is dead', async () => { // Review Focus 4
    const c = adminClient(t);
    const g = await connectClaude(t, c, { email: 'owner@example.com' });
    expect((await mcpPing(t, g.accessToken)).status).toBe(200);
    const r = await c.post('/admin/apps/revoke', { client_id: g.clientId, confirm: 'yes' });
    expect(r.status).toBe(303);
    const denied = await mcpPing(t, g.accessToken);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain('resource_metadata');
    expect(denied.headers.get('www-authenticate')).toContain('invalid_token');
    const refresh = await fetch(`${t.url}/auth/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: g.refreshToken, client_id: g.clientId, resource: `${t.url}/mcp` }) });
    expect(refresh.status).toBe(400);
    expect(t.db.select().from(schema.auditEvent).all().some((e) => e.action === 'oauth.client_revoked')).toBe(true);
    // connecting again (new consent) works
    const again = await connectClaude(t, c, { email: 'owner@example.com' });
    expect((await mcpPing(t, again.accessToken)).status).toBe(200);
  });

  // The positive side of Review Focus 4, for the live connector after a deploy: an unrevoked grant keeps working
  // across refreshes (the refreshed access token still carries a consent /mcp accepts), including a rotated one.
  it('after a full connect, a refresh-token grant returns an access token /mcp accepts', async () => {
    const g = await connectClaude(t, adminClient(t), { email: 'owner@example.com' });
    const refresh = async (refreshToken: string) => {
      const r = await fetch(`${t.url}/auth/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: g.clientId, resource: `${t.url}/mcp` }) });
      expect(r.status).toBe(200);
      return (await r.json()) as { access_token: string; refresh_token?: string };
    };
    const first = await refresh(g.refreshToken);
    expect(first.access_token).not.toBe(g.accessToken);
    expect((await mcpPing(t, first.access_token)).status).toBe(200);
    const second = await refresh(first.refresh_token ?? g.refreshToken);
    expect((await mcpPing(t, second.access_token)).status).toBe(200);
  });

  it('cannot revoke someone else\'s grant', async () => {
    const owner = adminClient(t); const g = await connectClaude(t, owner, { email: 'owner@example.com' });
    const partner = adminClient(t); await partner.signIn('partner@example.com');
    const r = await partner.post('/admin/apps/revoke', { client_id: g.clientId, confirm: 'yes' });
    expect(r.status).toBe(303);
    expect(await (await partner.get('/admin/apps')).text()).toContain(escapeHtml(s.flash.app_not_found));
    expect((await mcpPing(t, g.accessToken)).status).toBe(200);
    // an unconfirmed POST does not show the other user's app on a confirmation page either
    const ask = await partner.post('/admin/apps/revoke', { client_id: g.clientId });
    expect(ask.status).toBe(303);
    expect((await mcpPing(t, g.accessToken)).status).toBe(200);
  });

  it('sign out everywhere stops /mcp at once', async () => {
    const c = adminClient(t); const g = await connectClaude(t, c, { email: 'owner@example.com' });
    await c.post('/admin/profile/sessions/revoke-all', {});
    expect((await mcpPing(t, g.accessToken)).status).toBe(401);
  });

  it('a disabled user\'s existing access token stops working', async () => {
    const c = adminClient(t); const g = await connectClaude(t, c, { email: 'partner@example.com' });
    t.db.update(schema.user).set({ banned: true }).where(eq(schema.user.email, 'partner@example.com')).run();
    expect((await mcpPing(t, g.accessToken)).status).toBe(401);
  });
});

describe('/admin/apps: confirmation, flash, home count, removed user', () => {
  let u: TestCtx;
  beforeAll(async () => {
    u = await startTestApp();
    for (const e of ['owner@example.com', 'admin@example.com']) {
      await u.auth.api.createUser({ body: { email: e, password: TEST_PASSWORD, name: e.split('@')[0]!, role: e.startsWith('admin') ? 'admin' : 'member' } });
    }
  });
  afterAll(async () => { await u.close(); });

  it('without JS, Revoke first asks on a confirmation page and changes nothing; confirmed, it revokes and says so', async () => {
    const c = adminClient(u); const g = await connectClaude(u, c, { email: 'owner@example.com' });
    const home = await (await c.get('/admin')).text();
    expect(home).toContain(escapeHtml(s.home.claudeApps(1)));
    const list = await (await c.get('/admin/apps')).text();
    expect(list).toContain('action="/admin/apps/revoke"');
    expect(list).toContain(`name="client_id" value="${g.clientId}"`);
    expect(list).toContain('data-confirm-field="confirm"');
    const ask = await c.post('/admin/apps/revoke', { client_id: g.clientId });
    expect(ask.status).toBe(200);
    expect(ask.headers.get('cache-control')).toBe('no-store');
    const page = await ask.text();
    expect(page).toContain('name="confirm" value="yes"');
    expect(page).toContain(escapeHtml(s.apps.confirm.title('test')));
    expect((await mcpPing(u, g.accessToken)).status).toBe(200);
    const done = await c.post('/admin/apps/revoke', { client_id: g.clientId, confirm: 'yes' });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/admin/apps');
    const after = await (await c.get('/admin/apps')).text();
    expect(after).toContain(escapeHtml(s.flash.app_revoked({ name: 'test' })));
    expect(after).toContain(escapeHtml(s.apps.emptyTitle));
    expect(await (await c.get('/admin')).text()).toContain(escapeHtml(s.home.claudeNone));
    const ev = u.db.select().from(schema.auditEvent).all().filter((e) => e.action === 'oauth.client_revoked').at(-1)!;
    expect(ev.targetType).toBe('oauth_client');
    expect(ev.targetId).toBe(g.clientId);
    expect(JSON.parse(ev.detailsJson)).toEqual({ clientName: 'test', reason: 'user' });
  });

  it('a URL client id (CIMD) with a huge name: revoked at once, capped in flash and audit, and its old token stays dead after re-consent', async () => {
    const cid = 'https://claude.example/oauth/client.json';
    const name = 'Å'.repeat(5000);
    const userId = u.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, 'owner@example.com')).get()!.id;
    const sec = Math.floor(Date.now() / 1000);
    const consent = (id: string, at: Date) => u.db.insert(schema.oauthConsent).values({ id, clientId: cid, userId, scopes: ['mcp'], createdAt: at, updatedAt: at }).run();
    const sign = async (iat: number) => (await u.auth.api.signJWT({ body: { payload: { sub: userId, azp: cid, scope: 'mcp', iat, iss: `${u.url}/auth`, aud: `${u.url}/mcp` } } })).token;
    u.db.insert(schema.oauthClient).values({ id: 'cimd', clientId: cid, name, redirectUris: ['https://claude.example/cb'] }).run();
    consent('cimd-1', new Date((sec - 60) * 1000));
    const old = await sign(sec - 5);
    expect((await mcpPing(u, old)).status).toBe(200);
    const c = adminClient(u); await c.signIn('owner@example.com');
    const done = await c.post('/admin/apps/revoke', { client_id: cid, confirm: 'yes' });
    expect(done.status).toBe(303);
    expect(await (await c.get('/admin/apps')).text()).toContain(escapeHtml(s.flash.app_revoked({ name: 'Å'.repeat(100) })));
    const ev = u.db.select().from(schema.auditEvent).all().filter((x) => x.action === 'oauth.client_revoked' && x.targetId === cid);
    expect(ev).toHaveLength(1);
    expect((JSON.parse(ev[0]!.detailsJson) as { clientName: string }).clientName).toBe('Å'.repeat(100));
    expect((await mcpPing(u, old)).status).toBe(401);
    // The user allows the same client id again (a new consent row, as Better Auth writes it: to the second).
    consent('cimd-2', new Date(sec * 1000));
    expect((await mcpPing(u, old)).status).toBe(401);
    expect((await mcpPing(u, await sign(sec))).status).toBe(200);
  });

  it('a removed user\'s access token stops working', async () => {
    const c = adminClient(u); const g = await connectClaude(u, c, { email: 'owner@example.com' });
    expect((await mcpPing(u, g.accessToken)).status).toBe(200);
    const admin = adminClient(u); await admin.signIn('admin@example.com');
    const id = u.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, 'owner@example.com')).get()!.id;
    const r = await admin.post(`/admin/users/${id}/remove`, { confirm: 'yes' });
    expect(r.status).toBe(303);
    expect(u.db.select().from(schema.user).where(eq(schema.user.id, id)).get()).toBeUndefined();
    expect((await mcpPing(u, g.accessToken)).status).toBe(401);
  });

  it('needs a session', async () => {
    const r = await adminClient(u).get('/admin/apps');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toContain('/admin/login');
  });
});
