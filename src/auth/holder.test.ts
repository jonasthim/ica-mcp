import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAudit } from '../audit.js';
import { loadConfig } from '../config.js';
import { createCipher } from '../crypto.js';
import { closeDb, openDb, schema } from '../db/index.js';
import { writeSetting } from '../settings/store.js';
import { resolveSettings } from '../settings/effective.js';
import { adminClient, captureLogs, connectClaude, mcpPing, startTestApp, TEST_PASSWORD, type TestCtx } from '../test-helpers.js';
import { AUTH_INIT_TIMEOUT_MS, createAuthHolder } from './holder.js';
import type * as AuthModule from './index.js';
import { createOidcRejections } from './oidc-policy.js';
import { startFakeOidc, type FakeOidc } from './test-fakes.js';

/** Makes the next `createAuth` calls throw while `when` says so (a build that fails outright, not just a skipped provider). */
const failBuild = vi.hoisted(() => ({ when: undefined as undefined | ((config: { oidc?: unknown }) => boolean) }));
vi.mock('./index.js', async (importOriginal) => {
  const m = await importOriginal<typeof AuthModule>();
  return {
    ...m,
    createAuth: (...args: Parameters<typeof m.createAuth>) => {
      if (failBuild.when?.(args[0])) throw new Error('build failed');
      return m.createAuth(...args);
    },
  };
});

let t: TestCtx; let idp: FakeOidc;
const saveOidc = (label: string, issuer = idp.issuer) => writeSetting(t.db, 'oidc', {
  issuerUrl: issuer, clientId: 'ica-hub', clientSecretEnc: t.cipher.encrypt('fake-secret'), label, linkByEmail: true,
}, null);
const formAction = (r: Response): string => /form-action ([^;]*)/.exec(r.headers.get('content-security-policy') ?? '')?.[1] ?? '';
beforeAll(async () => {
  idp = await startFakeOidc();
  t = await startTestApp({ TRUST_PROXY: '1' });
  await t.auth.api.createUser({ body: { email: 'owner@example.com', password: TEST_PASSWORD, name: 'Owner', role: 'admin' } });
});
afterAll(async () => { await t.close(); await idp.close(); });

describe('AuthHolder', () => {
  it('picks up DB OIDC settings on reload without a restart', async () => {
    expect(await (await adminClient(t).get('/admin/login')).text()).not.toContain('Continue with');
    saveOidc('Authentik');
    const before = t.holder.snapshot().generation;
    await t.holder.reload();
    expect(t.holder.snapshot().generation).toBe(before + 1);
    expect(await (await adminClient(t).get('/admin/login')).text()).toContain('Continue with Authentik');
  });

  it('an OIDC flow started before a swap completes after it (state lives in the database)', async () => {
    saveOidc('Authentik'); await t.holder.reload();
    // The owner's IdP identity links to his existing account by email (rule c). The flow stops at the IdP redirect…
    const anon = adminClient(t, { forwardedFor: '198.51.100.8' });
    const start = await anon.post('/admin/login/oidc', { oauth_query: '' });
    expect(start.headers.get('location')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    saveOidc('Authentik (renamed)'); await t.holder.reload(); // …the instance is swapped while the browser is away…
    idp.next = { sub: 'sub-owner', email: 'owner@example.com', name: 'Owner' };
    const { url, res } = await anon.follow(start); // …and the callback lands on the new instance.
    expect(url).toBe(`${t.url}/admin`); expect(res.status).toBe(200);
    const owner = t.db.select().from(schema.user).where(eq(schema.user.email, 'owner@example.com')).get()!;
    expect(t.db.select().from(schema.account).where(eq(schema.account.userId, owner.id)).all().map((a) => a.providerId).sort()).toEqual(['credential', 'upstream']);
  });

  it('a request in flight during a swap completes on the instance it started with', async () => {
    saveOidc('Authentik'); await t.holder.reload();
    const anon = adminClient(t, { forwardedFor: '198.51.100.10' });
    const start = await anon.post('/admin/login/oidc', { oauth_query: '' });
    idp.next = { sub: 'sub-owner', email: 'owner@example.com', name: 'Owner' };
    // The callback request reaches the app, which calls the IdP's token endpoint: hold that call, so the callback is
    // in flight on the old instance while the new one is swapped in.
    const hold = idp.pause('/application/o/token/');
    const before = t.holder.snapshot();
    const flow = anon.follow(start);
    await hold.reached;
    saveOidc('Authentik (swapped mid-request)');
    const after = await t.holder.reload();
    expect(t.holder.snapshot()).toBe(after);
    expect(after.generation).toBe(before.generation + 1);
    hold.release();
    const { url, res } = await flow;
    expect(url).toBe(`${t.url}/admin`); expect(res.status).toBe(200);
    expect(await (await adminClient(t).get('/admin/login')).text()).toContain('Continue with Authentik (swapped mid-request)');
  });

  it('after a swap, new requests use the new provider (button, CSP form-action and the IdP redirect)', async () => {
    const idp2 = await startFakeOidc();
    try {
      saveOidc('Old IdP'); await t.holder.reload();
      const c = adminClient(t, { forwardedFor: '198.51.100.11' });
      expect(formAction(await c.get('/admin/login'))).toContain(idp.origin);
      saveOidc('New IdP', idp2.issuer); await t.holder.reload();
      const page = await c.get('/admin/login');
      expect(await page.text()).toContain('Continue with New IdP');
      expect(formAction(page)).toContain(idp2.origin);
      expect(formAction(page)).not.toContain(idp.origin);
      const start = await c.post('/admin/login/oidc', { oauth_query: '' });
      expect(start.headers.get('location')!.startsWith(`${idp2.origin}/`)).toBe(true);
    } finally {
      saveOidc('Authentik'); await t.holder.reload(); await idp2.close();
    }
  });

  it('sessions and /mcp tokens survive a swap (same database keys)', async () => {
    const c = adminClient(t, { forwardedFor: '198.51.100.9' }); await c.signIn('owner@example.com');
    const { accessToken } = await connectClaude(t, c, { email: 'owner@example.com' });
    await t.holder.reload();
    expect((await c.get('/admin/profile')).status).toBe(200);
    expect((await mcpPing(t, accessToken)).status).toBe(200);
  });

  it('a candidate whose provider does not load is refused and the old instance stays', async () => {
    const before = t.holder.snapshot();
    const candidate = { ...resolveSettings(t.config, t.db, t.cipher), oidc: { issuerUrl: 'http://127.0.0.1:9/nope/', clientId: 'x', clientSecret: 'y', label: 'Nope', linkByEmail: true } };
    let committed = false;
    expect(await t.holder.apply(candidate, () => { committed = true; })).toEqual({ ok: false, reason: 'oidc_unloadable' });
    expect(committed).toBe(false);
    expect(t.holder.snapshot()).toBe(before);
  });

  it('while a candidate is being built, requests keep using the old instance; a loaded candidate commits, then swaps', async () => {
    const before = t.holder.snapshot();
    const hold = idp.pause('/application/o/ica-hub/.well-known/openid-configuration');
    const candidate = { ...resolveSettings(t.config, t.db, t.cipher), oidc: { issuerUrl: idp.issuer, clientId: 'ica-hub', clientSecret: 'fake-secret', label: 'Applied', linkByEmail: true } };
    const order: string[] = [];
    const applying = t.holder.apply(candidate, () => { order.push(`commit@${t.holder.snapshot().generation}`); });
    await hold.reached; // the candidate's discovery is in flight
    expect(t.holder.snapshot()).toBe(before);
    expect(await (await adminClient(t).get('/admin/login')).text()).toContain('Continue with Authentik');
    hold.release();
    const out = await applying;
    expect(out.ok).toBe(true);
    expect(order).toEqual([`commit@${before.generation}`]); // committed before the swap
    expect(t.holder.snapshot().generation).toBe(before.generation + 1);
    expect(await (await adminClient(t).get('/admin/login')).text()).toContain('Continue with Applied');
    saveOidc('Authentik'); await t.holder.reload();
  });

  it('a build that throws leaves the old instance in place, and the next build still works', async () => {
    const before = t.holder.snapshot();
    failBuild.when = () => true;
    try {
      await expect(t.holder.reload()).rejects.toThrow('build failed');
      let committed = false;
      await expect(t.holder.apply(before.settings, () => { committed = true; })).rejects.toThrow('build failed');
      expect(committed).toBe(false);
      expect(t.holder.snapshot()).toBe(before);
      expect(t.holder.current).toBe(before.auth);
    } finally { failBuild.when = undefined; }
    const next = await t.holder.reload();
    expect(next.generation).toBe(before.generation + 1);
  });

  it('the sign-in page and the invite page both ask the holder to retry an unreachable IdP', async () => {
    const spy = vi.spyOn(t.holder, 'retryIfUnreachable');
    try {
      await adminClient(t).get('/admin/login');
      expect(spy).toHaveBeenCalledTimes(1);
      await adminClient(t).get(`/admin/invite/${'x'.repeat(43)}`);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });

  it('a rejecting auth handler answers 500 through the error handler, never an unhandled rejection', async () => {
    const snap = t.holder.snapshot();
    const spy = vi.spyOn(snap, 'handler').mockRejectedValueOnce(new Error('handler failed'));
    try {
      const r = await fetch(`${t.url}/auth/jwks`);
      expect(spy).toHaveBeenCalledOnce();
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: 'internal' });
      expect((await fetch(`${t.url}/auth/jwks`)).status).toBe(200); // the process and the mount are fine
    } finally { spy.mockRestore(); }
  });

  it('an unhandled route error is logged as { err: { name, message } } only: never the stack or other properties', async () => {
    const lines: string[] = [];
    const own = await startTestApp({}, { log: captureLogs(lines) });
    const snap = own.holder.snapshot();
    const boom = Object.assign(new Error('handler failed'), { token: 'SECRET-TOKEN-PROPERTY', cause: new Error('SECRET-CAUSE') });
    const spy = vi.spyOn(snap, 'handler').mockRejectedValueOnce(boom);
    try {
      expect((await fetch(`${own.url}/auth/jwks`)).status).toBe(500);
      const line = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'unhandled');
      // pino's err serializer adds `type` and an empty `stack` to any plain object under `err`.
      const err = (line?.err ?? {}) as Record<string, unknown>;
      expect(Object.keys(err).filter((k) => k !== 'type' && k !== 'stack').sort()).toEqual(['message', 'name']);
      expect(err).toMatchObject({ name: 'Error', message: 'handler failed' });
      expect(err.stack ?? '').toBe('');
      const all = lines.join('\n');
      for (const v of ['SECRET-TOKEN-PROPERTY', 'SECRET-CAUSE', 'holder.test.ts']) expect(all).not.toContain(v);
    } finally { spy.mockRestore(); await own.close(); }
  });

  it('concurrent reloads are serialised: each swap gets its own generation, the last one wins', async () => {
    const g = t.holder.snapshot().generation;
    const [a, b, c] = await Promise.all([t.holder.reload(), t.holder.reload(), t.holder.reload()]);
    expect([a.generation, b.generation, c.generation]).toEqual([g + 1, g + 2, g + 3]);
    expect(t.holder.snapshot()).toBe(c);
  });
});

describe('boot never fails on DB settings', () => {
  it.each([
    ['invalid row', 'oidc_invalid', (db: TestCtx['db']) => db.$client.prepare("insert into app_setting (key, value_json, updated_at) values ('oidc', 'nope', 'x')").run()],
    ['unreachable issuer', 'oidc_unreachable', (db: TestCtx['db'], c: TestCtx['cipher']) => writeSetting(db, 'oidc', { issuerUrl: 'http://127.0.0.1:9/o/', clientId: 'c', clientSecretEnc: c.encrypt('s'), label: 'X', linkByEmail: true }, null)],
  ] as const)('%s → starts, password login works, problem %s', async (_n, problem, seed) => {
    const o = await startTestApp({}, { seed });
    try {
      expect(o.holder.snapshot().settings.problems).toContain(problem);
      expect(o.holder.snapshot().config.oidc).toBeUndefined();
      await o.auth.api.createUser({ body: { email: 'a@example.com', password: TEST_PASSWORD, name: 'A', role: 'admin' } });
      const c = adminClient(o); const r = await c.signIn('a@example.com');
      expect(r.headers.get('location')).toBe('/admin');
      expect(await (await c.get('/admin')).text()).toContain(problem === 'oidc_invalid' ? 'could not be read' : 'could not be reached');
    } finally { await o.close(); }
  });

  it('password login switched off in the UI stays on while the provider is unreachable (local_login_forced)', async () => {
    const o = await startTestApp({}, {
      seed: (db, c) => {
        writeSetting(db, 'oidc', { issuerUrl: 'http://127.0.0.1:9/o/', clientId: 'c', clientSecretEnc: c.encrypt('s'), label: 'X', linkByEmail: true }, null);
        writeSetting(db, 'sign_in_methods', { localLogin: false }, null);
      },
    });
    try {
      const snap = o.holder.snapshot();
      expect(snap.settings.problems).toEqual(['oidc_unreachable', 'local_login_forced']);
      expect(snap.config.localLogin).toBe(true);
      expect(await (await adminClient(o).get('/admin/login')).text()).toContain('name="password"');
    } finally { await o.close(); }
  });

  it('a UI-managed configuration whose build throws starts without OIDC (oidc_invalid); the secret is never logged', async () => {
    failBuild.when = (config) => Boolean(config.oidc);
    try {
      const o = await startTestApp({}, { seed: (db, c) => writeSetting(db, 'oidc', { issuerUrl: 'https://idp.example.com/o/', clientId: 'c', clientSecretEnc: c.encrypt('s3cret-value'), label: 'X', linkByEmail: true }, null) });
      try {
        expect(o.holder.snapshot().settings.problems).toEqual(['oidc_invalid']);
        expect(o.holder.snapshot().config.oidc).toBeUndefined();
      } finally { await o.close(); }
    } finally { failBuild.when = undefined; }
  });

  it('an env-managed configuration whose build throws still fails the start (env fail-fast)', async () => {
    failBuild.when = (config) => Boolean(config.oidc);
    try {
      await expect(startTestApp({ OIDC_ISSUER_URL: 'https://idp.example.com/o/', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's' })).rejects.toThrow('build failed');
    } finally { failBuild.when = undefined; }
  });
});

describe('retryIfUnreachable', () => {
  it('retries an IdP that was down at boot, at most once a minute, and loads it once it is back', async () => {
    const down = await startFakeOidc(); down.down = true;
    const db = openDb(':memory:');
    const config = loadConfig({ ICA_HUB_URL: 'http://127.0.0.1:1', ICA_HUB_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'), ICA_HUB_AUTH_SECRET: 's'.repeat(32), LOG_LEVEL: 'silent' });
    const cipher = createCipher(config.masterKey);
    writeSetting(db, 'oidc', { issuerUrl: down.issuer, clientId: 'ica-hub', clientSecretEnc: cipher.encrypt('fake-secret'), label: 'Later', linkByEmail: true }, null);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let clock = 1_000_000;
    try {
      const holder = await createAuthHolder({ config, db, cipher, audit: createAudit(db, log), oidcRejections: createOidcRejections(), log, now: () => clock });
      const g = holder.snapshot().generation;
      expect(holder.snapshot().settings.problems).toEqual(['oidc_unreachable']);
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain('fake-secret');
      down.down = false;
      clock += 30_000; holder.retryIfUnreachable(); // too soon after boot
      await new Promise((r) => setTimeout(r, 50));
      expect(holder.snapshot().generation).toBe(g);
      clock += 31_000; holder.retryIfUnreachable();
      await vi.waitFor(() => { expect(holder.snapshot().generation).toBe(g + 1); });
      expect(holder.snapshot().settings.problems).toEqual([]);
      expect(holder.snapshot().config.oidc?.label).toBe('Later');
      clock += 120_000; holder.retryIfUnreachable(); // nothing to retry any more
      await new Promise((r) => setTimeout(r, 50));
      expect(holder.snapshot().generation).toBe(g + 1);
    } finally { closeDb(db); await down.close(); }
  });
});

describe('init timeout (an IdP that accepts the connection and never answers)', () => {
  const DISCOVERY = '/application/o/ica-hub/.well-known/openid-configuration';
  const TIMEOUT = 200;
  const direct = async (o: { issuer?: string; now?: () => number } = {}) => {
    const db = openDb(':memory:');
    const config = loadConfig({ ICA_HUB_URL: 'http://127.0.0.1:1', ICA_HUB_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'), ICA_HUB_AUTH_SECRET: 's'.repeat(32), LOG_LEVEL: 'silent' });
    const cipher = createCipher(config.masterKey);
    if (o.issuer) writeSetting(db, 'oidc', { issuerUrl: o.issuer, clientId: 'ica-hub', clientSecretEnc: cipher.encrypt('fake-secret'), label: 'Stuck', linkByEmail: true }, null);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const holder = await createAuthHolder({ config, db, cipher, audit: createAudit(db, log), oidcRejections: createOidcRejections(), log, now: o.now, initTimeoutMs: TIMEOUT });
    return { holder, db, cipher };
  };

  it('defaults to 5 seconds', () => { expect(AUTH_INIT_TIMEOUT_MS).toBe(5_000); });

  it('boot completes within the timeout, without OIDC, on an instance that answers at once', async () => {
    const stuck = await startFakeOidc();
    const hold = stuck.pause(DISCOVERY);
    try {
      const t0 = Date.now();
      const { holder, db } = await direct({ issuer: stuck.issuer });
      expect(Date.now() - t0).toBeLessThan(TIMEOUT + 2_000);
      await hold.reached;
      expect(holder.snapshot().settings.problems).toEqual(['oidc_unreachable']);
      expect(holder.snapshot().config.oidc).toBeUndefined();
      expect(holder.snapshot().settings.oidc?.label).toBe('Stuck'); // what was configured, for the Settings page
      // The swapped-in instance does not wait on the stuck discovery.
      expect(await Promise.race([holder.current.api.getSession({ headers: new Headers() }), new Promise((r) => setTimeout(() => r('hung'), 1_000))])).toBeNull();
      closeDb(db);
    } finally { hold.release(); await stuck.close(); }
  });

  it('a save against a stuck IdP resolves as oidc_unloadable within the timeout; nothing is committed or swapped', async () => {
    const stuck = await startFakeOidc();
    const { holder, db, cipher } = await direct();
    const before = holder.snapshot();
    const hold = stuck.pause(DISCOVERY);
    try {
      let committed = false;
      const t0 = Date.now();
      const out = await holder.apply({ ...resolveSettings(before.config, db, cipher), oidc: { issuerUrl: stuck.issuer, clientId: 'ica-hub', clientSecret: 'fake-secret', label: 'Stuck', linkByEmail: true } }, () => { committed = true; });
      expect(out).toEqual({ ok: false, reason: 'oidc_unloadable' });
      expect(Date.now() - t0).toBeLessThan(TIMEOUT + 2_000);
      expect(committed).toBe(false);
      expect(holder.snapshot()).toBe(before);
      closeDb(db);
    } finally { hold.release(); await stuck.close(); }
  });

  it('retries do not pile up while a reload is queued or running', async () => {
    const idp3 = await startFakeOidc(); idp3.down = true;
    let clock = 1_000_000;
    const { holder, db } = await direct({ issuer: idp3.issuer, now: () => clock });
    const g = holder.snapshot().generation;
    expect(holder.snapshot().settings.problems).toEqual(['oidc_unreachable']);
    idp3.down = false;
    const hold = idp3.pause(DISCOVERY);
    try {
      clock += 61_000; holder.retryIfUnreachable(); // starts a reload, which sticks on discovery
      await hold.reached;
      clock += 61_000; holder.retryIfUnreachable(); // a reload is running: skipped
      await vi.waitFor(() => { expect(holder.snapshot().generation).toBe(g + 1); });
      await new Promise((r) => setTimeout(r, TIMEOUT * 2));
      expect(holder.snapshot().generation).toBe(g + 1); // only the one reload ran
      expect(holder.snapshot().settings.problems).toEqual(['oidc_unreachable']);
      closeDb(db);
    } finally { hold.release(); await idp3.close(); }
  });
});
