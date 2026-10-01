import { describe, expect, it } from 'vitest';
import { openDb, schema } from '../db/index.js';
import { seedUser } from '../test-helpers.js';
import { createInvite } from './invites.js';
import { changeUserEmail, isSelfChangedEmail, normaliseNewEmail } from './email.js';

describe('normaliseNewEmail — the OIDC policy rules', () => {
  it.each([
    ['Owner.New@Example.com', 'owner.new@example.com'], ['  a@b.se ', 'a@b.se'],
    ['ownerK@example.com', undefined], // KELVIN SIGN: changed by NFKC
    ['öwner@example.com', undefined], // non-ASCII local part
    ['not-an-email', undefined], [`${'a'.repeat(250)}@b.se`, undefined], [42, undefined],
  ])('%s → %s', (raw, want) => expect(normaliseNewEmail(raw)).toBe(want));
});

describe('changeUserEmail', () => {
  const setup = () => { const db = openDb(':memory:'); seedUser(db, 'owner', { email: 'owner@example.com', role: 'admin' }); seedUser(db, 'partner', { email: 'partner@example.com' }); return db; };
  it('changes only user.email (lowercased), never the account rows', () => {
    const db = setup();
    db.insert(schema.account).values({ id: 'c', accountId: 'owner', providerId: 'credential', userId: 'owner', password: 'h', createdAt: new Date(), updatedAt: new Date() }).run();
    expect(changeUserEmail(db, 'owner', 'Owner.New@Example.com', { vouched: true })).toEqual({ ok: true, from: 'owner@example.com', to: 'owner.new@example.com', confirmedOnly: false });
    expect(db.select({ a: schema.account.accountId }).from(schema.account).get()).toEqual({ a: 'owner' });
    expect(isSelfChangedEmail(db, 'owner')).toBe(false);
  });
  it('is case-insensitively unique and refuses an address with a pending invite', () => {
    const db = setup();
    expect(changeUserEmail(db, 'owner', 'PARTNER@EXAMPLE.COM', { vouched: true })).toEqual({ ok: false, error: 'email_taken' });
    createInvite(db, { email: 'new@example.com', role: 'member', createdByUserId: 'owner' });
    expect(changeUserEmail(db, 'owner', 'New@example.com', { vouched: true })).toEqual({ ok: false, error: 'email_invited' });
  });
  it('a member’s own change is marked unconfirmed until an admin saves it again', () => {
    const db = setup();
    expect(changeUserEmail(db, 'partner', 'c@example.com', { vouched: false })).toMatchObject({ ok: true });
    expect(isSelfChangedEmail(db, 'partner')).toBe(true);
    expect(changeUserEmail(db, 'partner', 'c@example.com', { vouched: false })).toEqual({ ok: false, error: 'email_unchanged' });
    expect(changeUserEmail(db, 'partner', 'c@example.com', { vouched: true })).toEqual({ ok: true, from: 'c@example.com', to: 'c@example.com', confirmedOnly: true });
    expect(isSelfChangedEmail(db, 'partner')).toBe(false);
  });
  it('rejects an invalid address without touching the row', () => {
    const db = setup();
    expect(changeUserEmail(db, 'owner', 'nope', { vouched: true })).toEqual({ ok: false, error: 'email_invalid' });
    expect(db.select({ e: schema.user.email }).from(schema.user).all().map((u) => u.e)).toContain('owner@example.com');
  });
  it('unknown user', () => expect(changeUserEmail(setup(), 'ghost', 'g@x.se', { vouched: true })).toEqual({ ok: false, error: 'user_missing' }));
});
