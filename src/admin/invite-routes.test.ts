import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/index.js';
import { createInvite, hashInviteToken } from '../users/invites.js';
import { adminClient, startTestApp, TEST_PASSWORD, type AdminClient, type TestCtx } from '../test-helpers.js';

let t: TestCtx; let owner: AdminClient;
const NEW_PW = 'a-long-household-passphrase';
beforeAll(async () => {
  t = await startTestApp();
  await t.auth.api.createUser({ body: { email: 'owner@example.com', password: TEST_PASSWORD, name: 'Owner', role: 'admin' } });
  owner = adminClient(t); await owner.signIn('owner@example.com');
});
afterAll(async () => { await t.close(); });

const invite = async (email: string, role = 'member'): Promise<string> => {
  const r = await owner.post('/admin/users/invites', { email, role });
  expect(r.status).toBe(303);
  const share = await (await owner.get(r.headers.get('location')!)).text();
  expect(share).toMatch(/<figure class="qr"[^>]*>\s*<svg/); // QR
  return /\/admin\/invite\/([A-Za-z0-9_-]{43})/.exec(share)![1]!;
};

describe('invites', () => {
  it('accepts with a local password: member created with the invite role, signed in, invite consumed', async () => {
    const token = await invite('Partner@Example.com');
    const p = adminClient(t);
    const page = await (await p.get(`/admin/invite/${token}`)).text();
    expect(page).toContain('partner@example.com');
    const r = await p.post(`/admin/invite/${token}/accept`, { name: 'Åsa', password: NEW_PW, confirm: NEW_PW });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/admin');
    expect((await p.get('/admin')).status).toBe(200);
    const u = t.db.select().from(schema.user).where(eq(schema.user.email, 'partner@example.com')).get()!;
    expect(u.role).toBe('member'); expect(u.name).toBe('Åsa');
    expect(t.db.select().from(schema.userProfile).where(eq(schema.userProfile.userId, u.id)).get()).toBeTruthy();
    expect((await adminClient(t).get(`/admin/invite/${token}`)).status).toBe(410);
    const acts = t.db.select({ a: schema.auditEvent.action }).from(schema.auditEvent).all().map((x) => x.a);
    expect(acts).toEqual(expect.arrayContaining(['user.invited', 'user.invite_accepted']));
  });

  it('invite opened while signed in as someone else never binds to that account', async () => { // Review Focus 1
    const token = await invite('kid@example.com');
    const page = await (await owner.get(`/admin/invite/${token}`)).text();
    expect(page).toContain('owner@example.com'); // "You are signed in as …"
    expect(page).toContain(`action="/admin/invite/${token}/switch"`);
    expect(page).not.toContain(`action="/admin/invite/${token}/accept"`);
    const sneaky = await owner.post(`/admin/invite/${token}/accept`, { name: 'X', password: NEW_PW, confirm: NEW_PW });
    expect(sneaky.status).toBe(303);
    expect(t.db.select().from(schema.user).where(eq(schema.user.email, 'kid@example.com')).get()).toBeUndefined();
    expect(t.db.select().from(schema.user).where(eq(schema.user.email, 'owner@example.com')).get()?.role).toBe('admin');
    // "Sign out and continue" on a separate client (keep `owner` signed in for later tests)
    const phone = adminClient(t); await phone.signIn('owner@example.com');
    const sw = await phone.post(`/admin/invite/${token}/switch`, {});
    expect(sw.headers.get('location')).toBe(`/admin/invite/${token}`);
    expect(await (await phone.get(`/admin/invite/${token}`)).text()).toContain(`action="/admin/invite/${token}/accept"`);
  });

  it('refuses mismatched or short passwords without consuming the invite', async () => {
    const token = await invite('short@example.com');
    const p = adminClient(t);
    await p.post(`/admin/invite/${token}/accept`, { name: 'S', password: 'short', confirm: 'short' });
    await p.post(`/admin/invite/${token}/accept`, { name: 'S', password: NEW_PW, confirm: `${NEW_PW}x` });
    expect((await p.get(`/admin/invite/${token}`)).status).toBe(200);
  });

  it('revoked, renewed-away and unknown tokens are 410 with the styled page', async () => {
    const token = await invite('gone@example.com');
    const id = t.db.select().from(schema.invite).where(eq(schema.invite.email, 'gone@example.com')).get()!.id;
    await owner.post(`/admin/users/invites/${id}/renew`, {});
    expect((await adminClient(t).get(`/admin/invite/${token}`)).status).toBe(410);
    await owner.post(`/admin/users/invites/${id}/revoke`, {});
    const r = await adminClient(t).get(`/admin/invite/${'x'.repeat(43)}`);
    expect(r.status).toBe(410);
    expect(await r.text()).toContain('This link is no longer valid.');
  });

  it('only admins create invites', async () => {
    const token = await invite('m2@example.com');
    const m = adminClient(t);
    await m.post(`/admin/invite/${token}/accept`, { name: 'M', password: NEW_PW, confirm: NEW_PW });
    expect((await m.post('/admin/users/invites', { email: 'x@example.com', role: 'admin' })).status).toBe(403);
  });

  it('two concurrent accepts create exactly one account', async () => {
    const token = await invite('race@example.com');
    const [a, b] = [adminClient(t), adminClient(t)];
    const rs = await Promise.all([a, b].map((c) => c.post(`/admin/invite/${token}/accept`, { name: 'R', password: NEW_PW, confirm: NEW_PW })));
    expect(rs.map((r) => r.status).sort()).toEqual([303, 410]);
    expect(t.db.select().from(schema.user).where(eq(schema.user.email, 'race@example.com')).all()).toHaveLength(1);
    expect(t.db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, 'user.invite_accepted')).all()
      .filter((e) => JSON.parse(e.detailsJson).email === 'race@example.com')).toHaveLength(1);
  });

  it('a failed account creation releases the invite for another try', async () => {
    const token = await invite('retry@example.com');
    const spy = vi.spyOn(t.auth.api, 'createUser').mockRejectedValueOnce(new Error('boom'));
    const p = adminClient(t);
    try {
      const r = await p.post(`/admin/invite/${token}/accept`, { name: 'R', password: NEW_PW, confirm: NEW_PW });
      expect(r.headers.get('location')).toBe(`/admin/invite/${token}`);
    } finally { spy.mockRestore(); }
    const page = await p.get(`/admin/invite/${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Your account could not be created');
  });

  it('shows the pending invite on the Users page, and duplicate or existing emails are refused', async () => {
    await invite('listed@example.com');
    const html = await (await owner.get('/admin/users')).text();
    expect(html).toContain('listed@example.com');
    expect(html).toMatch(/href="\/admin\/users\/invites\/[^"]+">Show link/);
    const dup = await owner.post('/admin/users/invites', { email: 'LISTED@example.com', role: 'member' });
    expect(dup.headers.get('location')).toBe('/admin/users');
    expect(await (await owner.get('/admin/users')).text()).toContain('already has a pending invite');
    await owner.post('/admin/users/invites', { email: 'Owner@Example.com', role: 'admin' });
    expect(await (await owner.get('/admin/users')).text()).toContain('That email already has an account.');
    expect(t.db.select().from(schema.invite).where(eq(schema.invite.email, 'owner@example.com')).get()).toBeUndefined();
  });

  it('the invitee already signed in with the invited email is told there is nothing to accept', async () => {
    const token = await invite('twice@example.com');
    const p = adminClient(t);
    await p.post(`/admin/invite/${token}/accept`, { name: 'T', password: NEW_PW, confirm: NEW_PW });
    const other = await invite('twice2@example.com');
    // same browser, same person, a second (different) invite: not theirs → the sign-out page; never accepted
    expect(await (await p.get(`/admin/invite/${other}`)).text()).toContain(`action="/admin/invite/${other}/switch"`);
    // an invite for their own email cannot be pending (already a user), so the same-user view only shows for a
    // leftover invite: simulate one created before the account existed
    const now = new Date();
    t.db.insert(schema.invite).values({
      id: 'leftover', email: 'twice@example.com', role: 'member', tokenHash: hashInviteToken('L'.repeat(43)),
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    }).run();
    const same = await (await p.get(`/admin/invite/${'L'.repeat(43)}`)).text();
    expect(same).toContain('You already have an account');
    expect(same).not.toContain('/accept"');
  });

  it('the invite page keeps the token out of the Referer but not the Origin (form POSTs need it)', async () => {
    const token = await invite('origin@example.com');
    const page = await adminClient(t).get(`/admin/invite/${token}`);
    // `no-referrer` would make browsers send `Origin: null` on the form POSTs, which the same-origin check refuses.
    expect(page.headers.get('referrer-policy')).toBe('strict-origin');
    expect((await adminClient(t).get(`/admin/invite/${'x'.repeat(43)}`)).headers.get('referrer-policy')).toBe('strict-origin');
  });

  it('refuses an accept POST that carries neither a real Origin nor a Referer', async () => {
    const token = await invite('nullorigin@example.com');
    const p = adminClient(t);
    expect((await p.post(`/admin/invite/${token}/accept`, { name: 'N', password: NEW_PW, confirm: NEW_PW }, { origin: 'null' })).status).toBe(403);
    expect((await p.post(`/admin/invite/${token}/accept`, { name: 'N', password: NEW_PW, confirm: NEW_PW }, { origin: null })).status).toBe(403);
    expect(t.db.select().from(schema.user).where(eq(schema.user.email, 'nullorigin@example.com')).get()).toBeUndefined();
  });
});

describe('invite acceptance rate limit', () => {
  let t2: TestCtx;
  beforeAll(async () => { t2 = await startTestApp(); });
  afterAll(async () => { await t2.close(); });
  it('audits a rate-limited accept as a failed invite acceptance, once per window however many 429s follow', async () => {
    const c = adminClient(t2);
    const token = 'y'.repeat(43);
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await c.post(`/admin/invite/${token}/accept`, { name: 'X', password: 'p', confirm: 'p' })).status;
    expect(last).toBe(429);
    const ev = t2.db.select().from(schema.auditEvent).where(eq(schema.auditEvent.action, 'user.invite_accepted')).all();
    expect(ev.map((e) => [e.outcome, e.actorUserId, JSON.parse(e.detailsJson)])).toEqual([['failure', null, { method: 'local', reason: 'rate' }]]);
  });
});

describe('the same display-name rule for invite acceptance and Profile', () => {
  let t3: TestCtx;
  beforeAll(async () => { t3 = await startTestApp(); });
  afterAll(async () => { await t3.close(); });
  const CASES: [string, string, string | undefined][] = [
    ['NFD, 200 code points before NFC and 100 after', 'e\u0301'.repeat(100), 'é'.repeat(100)],
    ['100 emoji: 200 UTF-16 units, 100 code points', '😀'.repeat(100), '😀'.repeat(100)],
    ['101 emoji', '😀'.repeat(101), undefined],
    ['spaces only', '   ', undefined],
  ];
  it.each(CASES)('%s: passes or fails both forms alike', async (_label, name, stored) => {
    const admin = (await t3.auth.api.createUser({ body: { email: `admin-${Math.random()}@example.com`, password: TEST_PASSWORD, name: 'A', role: 'admin' } })).user;
    const email = `new-${Math.random().toString(36).slice(2)}@example.com`;
    const { token } = createInvite(t3.db, { email, role: 'member', createdByUserId: admin.id });
    const p = adminClient(t3);
    const userName = () => t3.db.select().from(schema.user).where(eq(schema.user.email, email)).get()?.name;
    const r = await p.post(`/admin/invite/${token}/accept`, { name, password: NEW_PW, confirm: NEW_PW });
    expect(r.status).toBe(303);
    expect(userName()).toBe(stored);
    if (stored === undefined) {
      // Profile: accept with a plain name first, then try the same name there.
      await p.post(`/admin/invite/${token}/accept`, { name: 'Plain', password: NEW_PW, confirm: NEW_PW });
      expect(userName()).toBe('Plain');
    }
    await p.post('/admin/profile/name', { name: 'Reset' });
    expect(userName()).toBe('Reset');
    await p.post('/admin/profile/name', { name });
    expect(userName()).toBe(stored ?? 'Reset');
  });
});
