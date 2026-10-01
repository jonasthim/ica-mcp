import { ConfigError } from '../config.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../db/index.js';
import { adminClient, rawFetch, startTestApp, TEST_PASSWORD, type TestCtx } from '../test-helpers.js';
import { ensureBootstrapAdmin } from './index.js';

let t: TestCtx;
beforeAll(async () => { t = await startTestApp(); });
afterAll(async () => { await t.close(); });

describe('OAuth discovery', () => {
  it('serves protected resource metadata for /mcp', async () => {
    const r = await fetch(`${t.url}/.well-known/oauth-protected-resource/mcp`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { resource: string; authorization_servers: string[] };
    expect(j.resource).toBe(`${t.url}/mcp`);
    expect(j.authorization_servers).toEqual([`${t.url}/auth`]);
  });
  it('serves authorization server metadata with PKCE, DCR and CIMD', async () => {
    const r = await fetch(`${t.url}/.well-known/oauth-authorization-server/auth`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.issuer).toBe(`${t.url}/auth`);
    expect(j.authorization_endpoint).toBe(`${t.url}/auth/oauth2/authorize`);
    expect(j.token_endpoint).toBe(`${t.url}/auth/oauth2/token`);
    expect(j.registration_endpoint).toBe(`${t.url}/auth/oauth2/register`);
    expect(j.code_challenge_methods_supported).toContain('S256');
    expect(j.client_id_metadata_document_supported).toBe(true);
    expect(j.token_endpoint_auth_methods_supported).toContain('none');
  });
  it('derives metadata from config, never from the request Host header (Review Focus 3)', async () => {
    // A wrong Host never reaches Better Auth (421, as for /mcp) …
    expect((await rawFetch(`${t.url}/.well-known/oauth-protected-resource/mcp`, { headers: { host: 'spoofed.example' } })).status).toBe(421);
    // … and forwarding headers are ignored: the metadata is the configured public URL.
    const r = await rawFetch(`${t.url}/.well-known/oauth-protected-resource/mcp`, { headers: { 'x-forwarded-host': 'spoofed.example', 'x-forwarded-proto': 'https' } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { resource: string }).resource).toBe(`${t.url}/mcp`);
  });
  it('accepts anonymous dynamic client registration', async () => {
    const r = await fetch(`${t.url}/auth/oauth2/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'test', application_type: 'native', redirect_uris: ['http://127.0.0.1/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    expect([200, 201]).toContain(r.status);
    const j = (await r.json()) as { client_id: string };
    expect(j.client_id).toBeTruthy();
  });
});

describe('ensureBootstrapAdmin (first start only)', () => {
  const boot = { email: 'owner@example.com', password: TEST_PASSWORD };
  it('creates the admin on an empty table, and the password signs in', async () => {
    const o = await startTestApp();
    try {
      expect(await ensureBootstrapAdmin(o.auth, o.db, { ...o.config, adminBootstrap: boot }, o.config.oidc)).toBe('created');
      expect(o.db.select().from(schema.user).all()).toEqual([expect.objectContaining({ email: 'owner@example.com', role: 'admin' })]);
      expect((await adminClient(o).signIn('owner@example.com')).headers.get('location')).toBe('/admin');
    } finally { await o.close(); }
  });
  it('never runs when any user exists: a removed or renamed bootstrap admin is not recreated', async () => {
    const o = await startTestApp();
    try {
      await ensureBootstrapAdmin(o.auth, o.db, { ...o.config, adminBootstrap: boot }, o.config.oidc);
      o.db.update(schema.user).set({ email: 'owner.new@example.com' }).run(); // the owner changed their email (Task 8)
      expect(await ensureBootstrapAdmin(o.auth, o.db, { ...o.config, adminBootstrap: boot }, o.config.oidc)).toBe('skipped');
      expect(o.db.select({ e: schema.user.email }).from(schema.user).all()).toEqual([{ e: 'owner.new@example.com' }]);
    } finally { await o.close(); }
  });
  it('refuses a short env password at startup', async () => {
    const o = await startTestApp();
    try { await expect(ensureBootstrapAdmin(o.auth, o.db, { ...o.config, adminBootstrap: { email: 'a@example.com', password: 'short' } }, o.config.oidc)).rejects.toThrow(/ICA_HUB_ADMIN_PASSWORD/); }
    finally { await o.close(); }
  });
  // A malformed ICA_HUB_ADMIN_EMAIL (e.g. "owner", no @) must never create a user: signInEmail would refuse it with
  // 400 INVALID_EMAIL, and the table would no longer be empty for first-run setup to take over — a permanent lockout.
  it('refuses a malformed env email and inserts nothing', async () => {
    const o = await startTestApp();
    try {
      await expect(ensureBootstrapAdmin(o.auth, o.db, { ...o.config, adminBootstrap: { email: 'owner', password: TEST_PASSWORD } }, o.config.oidc)).rejects.toThrow(/ICA_HUB_ADMIN_EMAIL/);
      expect(o.db.select().from(schema.user).all()).toEqual([]);
    } finally { await o.close(); }
  });
});

describe('ensureBootstrapAdmin (AUTH_LOCAL_LOGIN=false and OIDC_LINK_BY_EMAIL=false)', () => {
  it('refuses to bootstrap an admin who could never sign in (local login off, no linking by email)', async () => {
    const o = await startTestApp({
      AUTH_LOCAL_LOGIN: 'false', OIDC_LINK_BY_EMAIL: 'false',
      OIDC_ISSUER_URL: 'https://idp.example.com/application/o/ica-hub/', OIDC_CLIENT_ID: 'ica-hub', OIDC_CLIENT_SECRET: 's',
    });
    try {
      const boot = { ...o.config, adminBootstrap: { email: 'boot@example.com', password: 'correct-horse-battery' } };
      await expect(ensureBootstrapAdmin(o.auth, o.db, boot, boot.oidc)).rejects.toThrow(ConfigError);
      await expect(ensureBootstrapAdmin(o.auth, o.db, boot, boot.oidc)).rejects.toThrow(/OIDC_LINK_BY_EMAIL=true/);
      expect(o.db.select().from(schema.user).all()).toEqual([]);
      await ensureBootstrapAdmin(o.auth, o.db, { ...o.config, adminBootstrap: undefined }, o.config.oidc); // nothing to bootstrap: fine
    } finally { await o.close(); }
  });
});

describe('ensureBootstrapAdmin (OIDC configured but unreachable at boot)', () => {
  it('does not mistake "not loaded yet" for OIDC_LINK_BY_EMAIL=false', async () => {
    const o = await startTestApp({
      AUTH_LOCAL_LOGIN: 'false', OIDC_LINK_BY_EMAIL: 'true',
      OIDC_ISSUER_URL: 'http://127.0.0.1:9/o/', OIDC_CLIENT_ID: 'ica-hub', OIDC_CLIENT_SECRET: 's', // nothing listens on 9: discovery fails fast
    });
    try {
      const snap = o.holder.snapshot();
      // The provider never loaded, so `config.oidc` (what Better Auth actually built) is stripped to undefined …
      expect(snap.config.oidc).toBeUndefined();
      // … but it *is* configured, with linkByEmail true — the lockout check must see this, not the stripped value.
      expect(snap.settings.oidc?.linkByEmail).toBe(true);
      const boot = { ...snap.config, adminBootstrap: { email: 'boot@example.com', password: TEST_PASSWORD } };
      expect(await ensureBootstrapAdmin(snap.auth, o.db, boot, snap.settings.oidc)).toBe('created');
      expect(o.db.select().from(schema.user).all()).toEqual([expect.objectContaining({ email: 'boot@example.com', role: 'admin' })]);
    } finally { await o.close(); }
  });
});
