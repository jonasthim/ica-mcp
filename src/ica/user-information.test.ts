import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WEB_SUBJECT_KEYS, fetchUserInformation } from './web-session.js';
import { appSubject } from './app-session.js';
import { fakeJwt, fakeLoggedInSession, startFakeIca, type FakeIca } from './test-fakes.js';

let fake: FakeIca;
beforeEach(async () => { fake = await startFakeIca({ pendingPolls: 0 }); });
afterEach(async () => { await fake.close(); });

describe('fetchUserInformation', () => {
  it('reads tokenExpires as an ISO string or epoch seconds, and tolerates its absence', async () => {
    const s = await fakeLoggedInSession(fake);
    fake.opts.webTokenExpires = '2026-09-29T12:15:00Z';
    expect((await fetchUserInformation(s, fake.endpoints)).tokenExpires).toBe('2026-09-29T12:15:00.000Z');
    fake.opts.webTokenExpires = 1_790_000_000;
    expect((await fetchUserInformation(s, fake.endpoints)).tokenExpires).toBe(new Date(1_790_000_000_000).toISOString());
    fake.opts.webTokenExpires = undefined;
    expect((await fetchUserInformation(s, fake.endpoints)).tokenExpires).toBeUndefined();
    expect(fake.seen.userInfoCalls).toBe(3); // fakeLoggedInSession itself never calls /api/user/information
  });

  it('defaults to a tokenExpires an hour from now', async () => {
    const info = await fetchUserInformation(await fakeLoggedInSession(fake), fake.endpoints);
    expect(Date.parse(info.tokenExpires!) - Date.now()).toBeGreaterThan(55 * 60_000);
  });
});

describe('the ICA subject', () => {
  it('reads customerId, a number in the live capture, as a string', async () => {
    expect(WEB_SUBJECT_KEYS).toEqual(['customerId']);
    const s = await fakeLoggedInSession(fake);
    expect((await fetchUserInformation(s, fake.endpoints)).subject).toBeUndefined();
    fake.opts.webSubject = 12345678;
    expect((await fetchUserInformation(s, fake.endpoints)).subject).toBe('12345678');
    fake.opts.webSubject = 'CUST-1001';
    expect((await fetchUserInformation(s, fake.endpoints)).subject).toBe('CUST-1001');
  });

  it('ignores a customerId that is neither a non-empty string nor a finite number', async () => {
    const s = await fakeLoggedInSession(fake);
    for (const customerId of [null, true, {}, '', [1]]) {
      fake.opts.userInfo = { status: 200, body: { accessToken: 'a', loginState: 1, customerId } };
      expect((await fetchUserInformation(s, fake.endpoints)).subject).toBeUndefined();
    }
  });

  it('reads no other key: a fallback holding another identifier would refuse the same person', async () => {
    const s = await fakeLoggedInSession(fake);
    fake.opts.userInfo = { status: 200, body: { accessToken: 'a', loginState: 1, customerNumber: 'N-1', personId: 'P-1', userId: 'U-1', sub: 'S-1' } };
    expect((await fetchUserInformation(s, fake.endpoints)).subject).toBeUndefined();
    fake.opts.userInfo = { status: 200, body: { accessToken: 'a', loginState: 1, customerId: 7, userId: 'U-1' } };
    expect((await fetchUserInformation(s, fake.endpoints)).subject).toBe('7');
  });

  it('appSubject reads the sub of a JWT-shaped token and nothing from an opaque one', () => {
    expect(appSubject(fakeJwt({ sub: 'SUB-1' }))).toBe('SUB-1');
    expect(appSubject(fakeJwt({ iss: 'ica' }))).toBeUndefined();
    expect(appSubject(fakeJwt({ sub: 42 }))).toBeUndefined();
    expect(appSubject('x'.repeat(45))).toBeUndefined(); // the live app token: opaque, 45 chars
    expect(appSubject('a.!!!.c')).toBeUndefined();
    expect(appSubject('a..c')).toBeUndefined();
  });
});
