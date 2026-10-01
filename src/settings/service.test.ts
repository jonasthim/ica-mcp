import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../db/index.js';
import { startFakeOidc, type FakeOidc } from '../auth/test-fakes.js';
import { startTestApp, TEST_PASSWORD, type TestCtx } from '../test-helpers.js';
import { resolveSettings } from './effective.js';
import { writeSetting } from './store.js';
import { discoveryUrlFor } from './oidc-check.js';
import { oversizedField, parseOidcForm, removeOidc, saveOidc, saveSignIn, type OidcForm } from './service.js';

let t: TestCtx; let idp: FakeOidc; let adminId: string;
const deps = () => ({ db: t.db, config: t.config, cipher: t.cipher, holder: t.holder });
const form = (o: Partial<OidcForm> = {}): OidcForm => ({ issuerUrl: idp.issuer, clientId: 'ica-hub', clientSecret: 'fake-secret', label: 'Authentik', linkByEmail: true, adminGroup: '', memberGroup: '', ...o });
const eqProvider = (p: string) => eq(schema.account.providerId, p);
const link = (id: string) => t.db.insert(schema.account).values({ id, accountId: 'sub-owner', providerId: 'upstream', userId: adminId, createdAt: new Date(), updatedAt: new Date() }).run();
beforeAll(async () => {
  idp = await startFakeOidc(); t = await startTestApp();
  adminId = (await t.auth.api.createUser({ body: { email: 'owner@example.com', password: TEST_PASSWORD, name: 'Owner', role: 'admin' } })).user.id;
});
afterAll(async () => { await t.close(); await idp.close(); });
beforeEach(async () => { t.db.delete(schema.appSetting).run(); t.db.delete(schema.account).where(eqProvider('upstream')).run(); idp.patch = {}; await t.holder.reload(); });

describe('settings service', () => {
  it('saves: encrypted secret, applied at once, changes named without values', async () => {
    const out = await saveOidc(deps(), form(), { actorUserId: adminId, unlinkAck: false });
    expect(out).toMatchObject({ ok: true, changes: ['issuer_url', 'client_id', 'client_secret', 'label', 'link_by_email'] });
    const row = t.db.select().from(schema.appSetting).get()!;
    expect(row.valueJson).not.toContain('fake-secret'); expect(JSON.parse(row.valueJson).clientSecretEnc).toMatch(/^v1\./);
    expect(row.updatedBy).toBe(adminId);
    expect(t.holder.snapshot().config.oidc?.label).toBe('Authentik');
  });
  it('stores the issuer normalised (one trailing slash)', async () => {
    await saveOidc(deps(), form({ issuerUrl: idp.issuer.replace(/\/$/, '///') }), { actorUserId: adminId, unlinkAck: false });
    expect(JSON.parse(t.db.select().from(schema.appSetting).get()!.valueJson).issuerUrl).toBe(idp.issuer);
    // The same issuer typed differently is not an issuer change.
    link('l0');
    expect(await saveOidc(deps(), form({ issuerUrl: idp.issuer.replace(/\/$/, ''), label: 'SSO' }), { actorUserId: adminId, unlinkAck: false })).toMatchObject({ ok: true, changes: ['client_secret', 'label'] });
  });
  it('a blank secret keeps the stored one; blank with none stored is refused', async () => {
    expect(await saveOidc(deps(), form({ clientSecret: '' }), { actorUserId: adminId, unlinkAck: false })).toEqual({ ok: false, reason: 'oidc_secret_required' });
    await saveOidc(deps(), form(), { actorUserId: adminId, unlinkAck: false });
    const out = await saveOidc(deps(), form({ clientSecret: '', label: 'SSO' }), { actorUserId: adminId, unlinkAck: false });
    expect(out).toMatchObject({ ok: true, changes: ['label'] });
    expect(t.holder.snapshot().config.oidc?.clientSecret).toBe('fake-secret');
  });
  it('oidc_checks_failed: nothing saved, report returned', async () => {
    idp.patch = { issuer: 'https://evil.example/' };
    const out = await saveOidc(deps(), form(), { actorUserId: adminId, unlinkAck: false });
    expect(out).toMatchObject({ ok: false, reason: 'oidc_checks_failed', report: { ok: false } });
    expect(t.db.select().from(schema.appSetting).all()).toEqual([]);
  });
  it('a warning is not a failure: keys on another host (warn:other_host) still save, and the warning is reported', async () => {
    const report = { ok: true, checks: [{ id: 'jwks' as const, status: 'warn' as const, code: 'other_host' }] };
    const out = await saveOidc({ ...deps(), check: async () => report }, form(), { actorUserId: adminId, unlinkAck: false });
    expect(out).toMatchObject({ ok: true, report });
  });
  it('oidc_unloadable: checks pass but Better Auth cannot load the provider → nothing saved, old instance kept', async () => {
    const before = t.holder.snapshot();
    const out = await saveOidc({ ...deps(), check: async () => ({ ok: true, checks: [] }) }, form({ issuerUrl: 'http://127.0.0.1:9/o/' }), { actorUserId: adminId, unlinkAck: false });
    expect(out).toEqual({ ok: false, reason: 'oidc_unloadable', report: { ok: true, checks: [] } });
    expect(t.db.select().from(schema.appSetting).all()).toEqual([]);
    expect(t.holder.snapshot()).toBe(before);
  });
  it('env_managed: refused when env manages OIDC or password login', async () => {
    const e = await startTestApp({ OIDC_ISSUER_URL: idp.issuer, OIDC_CLIENT_ID: 'ica-hub', OIDC_CLIENT_SECRET: 'fake-secret', AUTH_LOCAL_LOGIN: 'true' });
    try {
      const d = { db: e.db, config: e.config, cipher: e.cipher, holder: e.holder };
      expect(await saveOidc(d, form(), { actorUserId: null, unlinkAck: false })).toEqual({ ok: false, reason: 'env_managed' });
      expect(await saveSignIn(d, false, { actorUserId: 'x' })).toEqual({ ok: false, reason: 'env_managed' });
      expect(await removeOidc(d, { actorUserId: 'x' })).toEqual({ ok: false, reason: 'env_managed' });
      expect(e.db.select().from(schema.appSetting).all()).toEqual([]);
    } finally { await e.close(); }
  });
  it('password off: refused until an admin is linked, then allowed; the forced-on rule never hides it', async () => {
    await saveOidc(deps(), form(), { actorUserId: adminId, unlinkAck: false });
    expect(await saveSignIn(deps(), false, { actorUserId: adminId })).toEqual({ ok: false, reason: 'no_oidc_admin' });
    link('l1');
    expect(await saveSignIn(deps(), false, { actorUserId: adminId })).toMatchObject({ ok: true, changes: ['local_login'] });
    expect(t.holder.snapshot().config.localLogin).toBe(false);
    expect(await removeOidc(deps(), { actorUserId: adminId })).toEqual({ ok: false, reason: 'no_sign_in_method' });
    await saveSignIn(deps(), true, { actorUserId: adminId });
  });
  it('password off without working single sign-on is refused (no_sign_in_method)', async () => {
    expect(await saveSignIn(deps(), false, { actorUserId: adminId })).toEqual({ ok: false, reason: 'no_sign_in_method' });
  });
  it('removing OIDC keeps the links and goes back to password only', async () => {
    await saveOidc(deps(), form(), { actorUserId: adminId, unlinkAck: false });
    link('l3');
    expect(await removeOidc(deps(), { actorUserId: adminId })).toEqual({ ok: true, changes: ['removed'] });
    expect(t.holder.snapshot().config.oidc).toBeUndefined();
    expect(t.db.select().from(schema.account).where(eqProvider('upstream')).all()).toHaveLength(1);
  });
  it('issuer change with links needs the acknowledgement and then unlinks', async () => {
    await saveOidc(deps(), form(), { actorUserId: adminId, unlinkAck: false });
    link('l2');
    const other = await startFakeOidc();
    try {
      expect(await saveOidc(deps(), form({ issuerUrl: other.issuer }), { actorUserId: adminId, unlinkAck: false })).toMatchObject({ ok: false, reason: 'issuer_change_ack' });
      expect(await saveOidc(deps(), form({ issuerUrl: other.issuer }), { actorUserId: adminId, unlinkAck: true })).toMatchObject({ ok: true, changes: expect.arrayContaining(['issuer_url', 'unlinked']) });
      expect(t.db.select().from(schema.account).all().filter((x) => x.providerId === 'upstream')).toEqual([]);
    } finally { await other.close(); }
  });
  it('probe: an issuer change that unlinks is refused when no admin has a password and linking by email is off', async () => {
    await saveOidc(deps(), form({ linkByEmail: false }), { actorUserId: adminId, unlinkAck: false });
    link('p1');
    const cred = t.db.select().from(schema.account).where(eqProvider('credential')).all();
    t.db.delete(schema.account).where(eqProvider('credential')).run();
    const other = await startFakeOidc();
    try {
      expect(await saveOidc(deps(), form({ issuerUrl: other.issuer, linkByEmail: false }), { actorUserId: adminId, unlinkAck: true })).toMatchObject({ ok: false, reason: 'unlink_locks_out' });
      expect(t.db.select().from(schema.account).where(eqProvider('upstream')).all()).toHaveLength(1);
      expect(t.holder.snapshot().config.oidc?.issuerUrl).toBe(idp.issuer);
      // With linking by email on, the admin can be linked again: allowed.
      expect(await saveOidc(deps(), form({ issuerUrl: other.issuer, linkByEmail: true }), { actorUserId: adminId, unlinkAck: true })).toMatchObject({ ok: true });
    } finally { await other.close(); for (const row of cred) t.db.insert(schema.account).values(row).run(); }
  });
  it('password_login_required: while password sign-in is off, the connection cannot change; the label and switches can', async () => {
    await saveOidc(deps(), form(), { actorUserId: adminId, unlinkAck: false });
    link('p2');
    expect(await saveSignIn(deps(), false, { actorUserId: adminId })).toMatchObject({ ok: true });
    const keep = { actorUserId: adminId, unlinkAck: false };
    expect(await saveOidc(deps(), form({ clientId: 'other' }), keep)).toMatchObject({ ok: false, reason: 'password_login_required' });
    expect(await saveOidc(deps(), form({ clientSecret: 'new-secret' }), keep)).toMatchObject({ ok: false, reason: 'password_login_required' });
    const other = await startFakeOidc();
    try {
      expect(await saveOidc(deps(), form({ issuerUrl: other.issuer, clientSecret: '' }), { ...keep, unlinkAck: true })).toMatchObject({ ok: false, reason: 'password_login_required' });
    } finally { await other.close(); }
    expect(await saveOidc(deps(), form({ clientSecret: '', label: 'SSO', adminGroup: 'ica-admins' }), keep)).toMatchObject({ ok: true, changes: ['label', 'admin_group'] });
    expect(t.holder.snapshot().config.oidc).toMatchObject({ clientId: 'ica-hub', clientSecret: 'fake-secret', label: 'SSO' });
    await saveSignIn(deps(), true, { actorUserId: adminId });
  });
  it('saves the member group next to the admin group, and names it in the changes', async () => {
    const keep = { actorUserId: adminId, unlinkAck: false };
    expect(await saveOidc(deps(), form(), keep)).toMatchObject({ ok: true });
    expect(await saveOidc(deps(), form({ clientSecret: '', adminGroup: 'ica-hub-admins', memberGroup: 'ica-hub-users' }), keep)).toMatchObject({ ok: true, changes: ['admin_group', 'member_group'] });
    expect(JSON.parse(t.db.select().from(schema.appSetting).get()!.valueJson)).toMatchObject({ adminGroup: 'ica-hub-admins', memberGroup: 'ica-hub-users' });
    expect(t.holder.snapshot().config.oidc).toMatchObject({ adminGroup: 'ica-hub-admins', memberGroup: 'ica-hub-users' });
    expect(await saveOidc(deps(), form({ clientSecret: '', adminGroup: 'ica-hub-admins' }), keep)).toMatchObject({ ok: true, changes: ['member_group'] });
    expect(JSON.parse(t.db.select().from(schema.appSetting).get()!.valueJson).memberGroup).toBeUndefined();
  });
  it('admin_group_not_yours: an admin group the saving admin\'s last sign-in did not carry is refused; unknown is allowed', async () => {
    const keep = { actorUserId: adminId, unlinkAck: false };
    expect(await saveOidc(deps(), form(), keep)).toMatchObject({ ok: true });
    // Unknown (a password sign-in, no OIDC groups seen): allowed, the page warns instead.
    expect(await saveOidc(deps(), form({ clientSecret: '', adminGroup: 'ica-hub-admins' }), keep)).toMatchObject({ ok: true });
    t.holder.seenGroups.set(adminId, ['ica-hub-admins', 'ica-hub-users']);
    try {
      expect(await saveOidc(deps(), form({ clientSecret: '', adminGroup: 'ica-hub-admin' }), keep)).toEqual({ ok: false, reason: 'admin_group_not_yours' });
      expect(JSON.parse(t.db.select().from(schema.appSetting).get()!.valueJson).adminGroup).toBe('ica-hub-admins');
      expect(await saveOidc(deps(), form({ clientSecret: '', adminGroup: 'ica-hub-admins', memberGroup: 'ica-hub-users' }), keep)).toMatchObject({ ok: true });
      // Known groups without the name: not yours, whatever the name looks like.
      expect(await saveOidc(deps(), form({ clientSecret: '', adminGroup: 'household-admins' }), keep)).toEqual({ ok: false, reason: 'admin_group_not_yours' });
      expect(await saveOidc(deps(), form({ clientSecret: '', adminGroup: 'admins' }), keep)).toEqual({ ok: false, reason: 'admin_group_not_yours' });
      // No prefix needed: an unfiltered IdP mapping's `admins`, when the admin's sign-in carried it, saves.
      t.holder.seenGroups.set(adminId, ['admins', 'other-admins', 'ica-hub-users']);
      expect(await saveOidc(deps(), form({ clientSecret: '', adminGroup: 'admins', memberGroup: 'ica-hub-users' }), keep)).toMatchObject({ ok: true, changes: ['admin_group'] });
      expect(JSON.parse(t.db.select().from(schema.appSetting).get()!.valueJson).adminGroup).toBe('admins');
      // First-run setup has no saving admin: never checked.
      expect(await saveOidc(deps(), form({ clientSecret: '', adminGroup: 'ica-hub-other' }), { actorUserId: null, unlinkAck: false })).toMatchObject({ ok: true });
    } finally { t.holder.seenGroups.set(adminId, undefined); }
  });
  it('the connection test is asked for the groups check when either group is set', async () => {
    const seen: unknown[] = [];
    const check = async (_u: string, o?: unknown) => { seen.push(o); return { ok: true, checks: [] }; };
    const keep = { actorUserId: adminId, unlinkAck: false };
    await saveOidc({ ...deps(), check }, form(), keep);
    await saveOidc({ ...deps(), check }, form({ clientSecret: '', memberGroup: 'ica-hub-users' }), keep);
    await saveOidc({ ...deps(), check }, form({ clientSecret: '', adminGroup: 'ica-hub-admins' }), keep);
    expect(seen).toEqual([{ groups: false }, { groups: true }, { groups: true }]);
  });
  it('not_saved: an internal failure (not the provider) has its own reason and is logged by name, for all three saves', async () => {
    const logged: unknown[] = [];
    const broken = { ...deps(), log: { error: (o: unknown) => { logged.push(o); } }, holder: { ...t.holder, apply: async () => { throw new TypeError('disk on fire fake-secret'); } } } as never;
    const keep = { actorUserId: adminId, unlinkAck: false };
    expect(await saveOidc({ ...(broken as object), check: async () => ({ ok: true, checks: [] }) } as never, form(), keep)).toMatchObject({ ok: false, reason: 'not_saved' });
    expect(await removeOidc(broken, { actorUserId: adminId })).toEqual({ ok: false, reason: 'not_saved' });
    expect(await saveSignIn(broken, true, { actorUserId: adminId })).toEqual({ ok: false, reason: 'not_saved' });
    expect(logged).toEqual([{ err: { name: 'TypeError' } }, { err: { name: 'TypeError' } }, { err: { name: 'TypeError' } }]);
  });
  it('Remove is decided on effective password sign-in: forced on (stored single sign-on unreachable) is not a refusal, and the forced-on row is fixed up in the same commit', async () => {
    writeSetting(t.db, 'oidc', { issuerUrl: 'http://127.0.0.1:9/o/', clientId: 'x', clientSecretEnc: t.cipher.encrypt('y'), label: 'Down', linkByEmail: true }, null);
    writeSetting(t.db, 'sign_in_methods', { localLogin: false }, null);
    await t.holder.reload();
    expect(t.holder.snapshot().config.localLogin).toBe(true);
    expect(t.holder.snapshot().settings.problems).toContain('local_login_forced');
    expect(await removeOidc(deps(), { actorUserId: adminId })).toEqual({ ok: true, changes: ['removed', 'local_login'] });
    // The stored row now says what is actually true: password sign-in is on, not merely forced on.
    expect(t.db.select().from(schema.appSetting).where(eq(schema.appSetting.key, 'sign_in_methods')).get()).toMatchObject({ valueJson: JSON.stringify({ localLogin: true }), updatedBy: adminId });
    expect(t.holder.snapshot().settings.problems).not.toContain('local_login_forced');
  });
  it('two concurrent saves of different sections: the running instance ends up equal to the database', async () => {
    // Save 1 (single sign-on) is held in its build (discovery); save 2 (sign-in methods) is started meanwhile. Its
    // candidate must be resolved after save 1 committed, or it would swap in an instance without single sign-on.
    const hold = idp.pause(new URL(discoveryUrlFor(idp.issuer)).pathname);
    // The check is stubbed so the only discovery request is the build's.
    const first = saveOidc({ ...deps(), check: async () => ({ ok: true, checks: [] }) }, form(), { actorUserId: adminId, unlinkAck: false });
    await hold.reached;
    const second = saveSignIn(deps(), true, { actorUserId: adminId });
    hold.release();
    expect((await first).ok).toBe(true); expect((await second).ok).toBe(true);
    const fromDb = resolveSettings(t.config, t.db, t.cipher);
    const { settings } = t.holder.snapshot();
    expect({ oidc: settings.oidc, localLogin: settings.localLogin, source: settings.source }).toEqual({ oidc: fromDb.oidc, localLogin: fromDb.localLogin, source: fromDb.source });
    expect(settings.oidc?.label).toBe('Authentik');
  });
  it('the guard is evaluated in the queue: removing single sign-on while password login is being switched off cannot lock everyone out', async () => {
    await saveOidc(deps(), form(), { actorUserId: adminId, unlinkAck: false });
    link('l4');
    const hold = idp.pause(new URL(discoveryUrlFor(idp.issuer)).pathname);
    const off = saveSignIn(deps(), false, { actorUserId: adminId });
    await hold.reached;
    const remove = removeOidc(deps(), { actorUserId: adminId });
    hold.release();
    expect(await off).toMatchObject({ ok: true });
    expect(await remove).toEqual({ ok: false, reason: 'no_sign_in_method' });
    expect(t.holder.snapshot().config.oidc).toBeDefined();
    await saveSignIn(deps(), true, { actorUserId: adminId });
  });
  it('parseOidcForm validates', () => {
    expect(parseOidcForm({ issuer_url: 'http://auth.example.com/o/', client_id: 'c', client_secret: 's', label: 'L' })).toEqual({ ok: false, error: 'oidc_issuer_invalid' });
    expect(parseOidcForm({ issuer_url: 'https://u:p@auth.example.com/o/', client_id: 'c', label: 'L' })).toEqual({ ok: false, error: 'oidc_issuer_invalid' });
    expect(parseOidcForm({ issuer_url: 'https://auth.example.com/o/', client_id: ' ', label: 'L' })).toEqual({ ok: false, error: 'oidc_client_id_invalid' });
    expect(parseOidcForm({ issuer_url: 'https://auth.example.com/o/', client_id: 'c', label: 'x'.repeat(41) })).toEqual({ ok: false, error: 'oidc_label_invalid' });
    expect(parseOidcForm({ issuer_url: 'https://auth.example.com/o/', client_id: 'c', admin_group: 'g'.repeat(101) })).toEqual({ ok: false, error: 'oidc_group_invalid' });
    expect(parseOidcForm({ issuer_url: 'https://auth.example.com/o/', client_id: 'c', member_group: 'g'.repeat(101) })).toEqual({ ok: false, error: 'oidc_group_invalid' });
    expect(oversizedField({ member_group: 'g'.repeat(101) })).toBe('oidc_group_invalid');
    expect(parseOidcForm({ issuer_url: 'https://auth.example.com/o/', client_id: 'c', label: '', link_by_email: 'on' })).toEqual({
      ok: true, value: { issuerUrl: 'https://auth.example.com/o/', clientId: 'c', clientSecret: '', label: 'Single sign-on', linkByEmail: true, adminGroup: '', memberGroup: '' },
    });
    expect(parseOidcForm({ issuer_url: 'https://auth.example.com/o/', client_id: 'c', admin_group: ' ica-hub-admins ', member_group: ' ica-hub-users ' }))
      .toMatchObject({ ok: true, value: { adminGroup: 'ica-hub-admins', memberGroup: 'ica-hub-users' } });
    expect(parseOidcForm({ issuer_url: 'https://Auth.Example.com/o', client_id: 'c' })).toMatchObject({ ok: true, value: { issuerUrl: 'https://auth.example.com/o/' } });
  });
  it('an over-long secret has its own error, not "enter the client secret"', () => {
    const body = { issuer_url: 'https://auth.example.com/o/', client_id: 'c', client_secret: 's'.repeat(501) };
    expect(parseOidcForm(body)).toEqual({ ok: false, error: 'oidc_secret_too_long' });
    expect(oversizedField(body)).toBe('oidc_secret_too_long');
    expect(parseOidcForm({ ...body, client_secret: 's'.repeat(500) })).toMatchObject({ ok: true });
  });
});

describe('OIDC_MEMBER_GROUP in env with a UI-managed connection', () => {
  let e: TestCtx; let eAdmin: string;
  beforeAll(async () => {
    e = await startTestApp({ OIDC_MEMBER_GROUP: 'env-users' });
    eAdmin = (await e.auth.api.createUser({ body: { email: 'owner@example.com', password: TEST_PASSWORD, name: 'Owner', role: 'admin' } })).user.id;
  });
  afterAll(async () => { await e.close(); });
  it('env wins: a posted member group is not stored, the env value is in force', async () => {
    const d = { db: e.db, config: e.config, cipher: e.cipher, holder: e.holder };
    expect(await saveOidc(d, form({ memberGroup: 'from-form', adminGroup: 'ica-hub-admins' }), { actorUserId: eAdmin, unlinkAck: false })).toMatchObject({ ok: true });
    const row = JSON.parse(e.db.select().from(schema.appSetting).get()!.valueJson);
    expect(row.memberGroup).toBeUndefined();
    expect(row.adminGroup).toBe('ica-hub-admins');
    expect(e.holder.snapshot().config.oidc).toMatchObject({ memberGroup: 'env-users', adminGroup: 'ica-hub-admins' });
    expect(e.holder.snapshot().settings.source.memberGroup).toBe('env');
  });
});

describe('saving single sign-on during first-run setup (no users)', () => {
  let e: TestCtx;
  const d = () => ({ db: e.db, config: e.config, cipher: e.cipher, holder: e.holder });
  beforeAll(async () => { e = await startTestApp({}, { firstRun: true }); });
  afterAll(async () => { await e.close(); });
  beforeEach(async () => { e.db.delete(schema.appSetting).run(); e.db.delete(schema.user).run(); await e.holder.reload(); });

  it('with password sign-in on (the default), both the Settings and the setup path save on an empty database', async () => {
    expect(await saveOidc(d(), form(), { actorUserId: null, unlinkAck: false, setup: true })).toMatchObject({ ok: true });
    expect(e.db.select().from(schema.appSetting).get()).toMatchObject({ key: 'oidc', updatedBy: null });
    expect(await saveOidc(d(), form({ clientSecret: 'other' }), { actorUserId: null, unlinkAck: false, setup: true })).toMatchObject({ ok: true, changes: ['client_secret'] });
  });
  it('a stored "password sign-in off" row: the Settings guard still refuses, setup (nobody to lock out) saves', async () => {
    writeSetting(e.db, 'sign_in_methods', { localLogin: false }, null);
    await e.holder.reload();
    expect(await saveOidc(d(), form(), { actorUserId: null, unlinkAck: false })).toMatchObject({ ok: false, reason: 'password_login_required' });
    expect(await saveOidc(d(), form(), { actorUserId: null, unlinkAck: false, setup: true })).toMatchObject({ ok: true });
    expect(e.holder.snapshot().config.oidc?.label).toBe('Authentik');
  });
  it('setup_closed: a user created while the provider loads (after the plan\'s check) → nothing written, nothing swapped', async () => {
    const before = e.holder.snapshot();
    // The connection check is stubbed, so the one discovery request is the candidate build's.
    const held = idp.pause('/application/o/ica-hub/.well-known/openid-configuration');
    const saving = saveOidc({ ...d(), check: async () => ({ ok: true, checks: [] }) }, form(), { actorUserId: null, unlinkAck: false, setup: true });
    await held.reached;
    e.db.insert(schema.user).values({ id: 'pw', name: 'pw', email: 'pw@example.com', role: 'admin' }).run();
    held.release();
    expect(await saving).toMatchObject({ ok: false, reason: 'setup_closed' });
    expect(e.db.select().from(schema.appSetting).all()).toEqual([]);
    expect(e.holder.snapshot()).toBe(before);
  });
  it('setup_closed: once any user exists, the setup path saves nothing (decided in the queue)', async () => {
    e.db.insert(schema.user).values({ id: 'u1', name: 'u', email: 'u@example.com' }).run();
    expect(await saveOidc(d(), form(), { actorUserId: null, unlinkAck: false, setup: true })).toMatchObject({ ok: false, reason: 'setup_closed' });
    expect(e.db.select().from(schema.appSetting).all()).toEqual([]);
  });
});
