import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { closeDb, openDb, schema } from '../db/index.js';
import { seedUser } from '../test-helpers.js';
import { ensureProfiles, insertFirstAdmin, promoteFirstAdmin, promoteFirstGroupAdmin, userCount } from './first-admin.js';

type LockWorkerResult = { ok: boolean; id?: string | null; error?: string };
type LockWorkerMessage = { type: 'ready' } | ({ type: 'result' } & LockWorkerResult);

describe('insertFirstAdmin', () => {
  it('creates admin + credential account + profile in one go', () => {
    const db = openDb(':memory:');
    const id = insertFirstAdmin(db, { email: 'owner@example.com', name: 'Owner', passwordHash: 'h' })!;
    expect(db.select().from(schema.user).all()).toEqual([expect.objectContaining({ id, email: 'owner@example.com', role: 'admin', emailVerified: false })]);
    expect(db.select().from(schema.account).all()).toEqual([expect.objectContaining({ userId: id, accountId: id, providerId: 'credential', password: 'h' })]);
    expect(db.select().from(schema.userProfile).all()).toEqual([expect.objectContaining({ userId: id })]);
  });

  /**
   * `behavior: 'immediate'` takes SQLite's write lock at `BEGIN`, before the count is even read, so a second
   * connection can never read a stale (pre-commit) count. A sequential "call A, then call B" test can't pin that —
   * A always finishes before B starts, so there is no lock contention to race. This test runs B in a real worker
   * thread (better-sqlite3 is synchronous, so a single thread can't interleave two calls) and lets it block on A's
   * still-open transaction, then has A actually create the admin and commit while B is waiting. Verified by hand:
   * switching insertFirstAdmin's behavior to 'deferred' turns the assertion below into
   * `{ ok: false, error: 'database is locked' }` — B's read succeeds before A's commit, and its later write then
   * conflicts with A's now-newer commit and throws, instead of cleanly seeing the committed admin and returning null.
   */
  it('serializes against a concurrent writer: a second connection never reads a stale count', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ica-hub-lock-')), 'db.sqlite');
    const a = openDb(file);
    try {
      a.$client.prepare('BEGIN IMMEDIATE').run(); // holds SQLite's write lock; A has not written anything yet
      const worker = new Worker(new URL('./first-admin.lock-worker.ts', import.meta.url), {
        execArgv: ['--import', 'tsx'],
        workerData: { file, busyTimeoutMs: 3000 },
      });
      try {
        const result = await new Promise<LockWorkerResult>((resolve, reject) => {
          worker.on('message', (m: LockWorkerMessage) => {
            if (m.type === 'result') { const { ok, id, error } = m; resolve({ ok, id, error }); return; }
            // The worker is about to call insertFirstAdmin and block on A's lock: give it a moment to actually reach
            // and start that SQLite call before A commits and releases the lock.
            setTimeout(() => {
              const now = new Date();
              a.$client.prepare('insert into user (id, name, email, email_verified, role, created_at, updated_at) values (?,?,?,0,?,?,?)')
                .run('a-id', 'A', 'a@example.com', 'admin', now.getTime(), now.getTime());
              a.$client.prepare('COMMIT').run();
            }, 50);
          });
          worker.once('error', reject);
        });
        expect(result).toEqual({ ok: true, id: null });
      } finally { await worker.terminate(); }
      expect(userCount(a)).toBe(1);
    } finally { closeDb(a); }
  });
});

describe('promoteFirstGroupAdmin', () => {
  it('promotes whichever admin-group user gets there first while no admin exists, and nobody after', () => {
    const db = openDb(':memory:');
    // Created in this order, but the later user's hook runs first: it still wins (it is in the admin group).
    db.insert(schema.user).values({ id: 'early', name: 'e', email: 'e@example.com', createdAt: new Date(1_000) }).run();
    db.insert(schema.user).values({ id: 'late', name: 'l', email: 'l@example.com', createdAt: new Date(2_000) }).run();
    expect(promoteFirstGroupAdmin(db, 'late')).toBe(true);
    expect(promoteFirstGroupAdmin(db, 'early')).toBe(false);
    expect(db.select({ id: schema.user.id, role: schema.user.role }).from(schema.user).all()).toEqual(expect.arrayContaining([{ id: 'late', role: 'admin' }, { id: 'early', role: null }]));
    expect(db.select({ userId: schema.userProfile.userId }).from(schema.userProfile).all()).toEqual([{ userId: 'late' }]);
    expect(promoteFirstGroupAdmin(db, 'missing')).toBe(false);
  });
});

describe('promoteFirstAdmin', () => {
  it('promotes only the only user', () => {
    const db = openDb(':memory:');
    seedUser(db, 'first');
    expect(promoteFirstAdmin(db, 'first')).toBe(true);
    expect(db.select({ role: schema.user.role }).from(schema.user).get()!.role).toBe('admin');
    seedUser(db, 'second');
    expect(promoteFirstAdmin(db, 'second')).toBe(false);
  });
  it('with no admin yet, promotes the earliest-created user only (a second setup user never leaves nobody admin)', () => {
    const db = openDb(':memory:');
    db.insert(schema.user).values({ id: 'early', name: 'e', email: 'e@example.com', createdAt: new Date(1_000) }).run();
    db.insert(schema.user).values({ id: 'late', name: 'l', email: 'l@example.com', createdAt: new Date(2_000) }).run();
    expect(promoteFirstAdmin(db, 'late')).toBe(false);
    expect(promoteFirstAdmin(db, 'early')).toBe(true);
    expect(promoteFirstAdmin(db, 'early')).toBe(false); // an admin exists now
    expect(db.select({ id: schema.user.id, role: schema.user.role }).from(schema.user).all()).toEqual(expect.arrayContaining([{ id: 'early', role: 'admin' }, { id: 'late', role: null }]));
    expect(db.select({ userId: schema.userProfile.userId }).from(schema.userProfile).all()).toEqual([{ userId: 'early' }]);
  });
  it('never promotes once an admin exists', () => {
    const db = openDb(':memory:');
    db.insert(schema.user).values({ id: 'oidc', name: 'o', email: 'o@example.com', createdAt: new Date(1_000) }).run();
    db.insert(schema.user).values({ id: 'pw', name: 'p', email: 'p@example.com', role: 'admin', createdAt: new Date(2_000) }).run();
    expect(promoteFirstAdmin(db, 'oidc')).toBe(false);
  });
});

it('ensureProfiles adds only the missing profile rows', () => {
  const db = openDb(':memory:');
  seedUser(db, 'u1'); seedUser(db, 'u2');
  db.insert(schema.userProfile).values({ userId: 'u1', createdAt: 'x' }).run();
  expect(ensureProfiles(db)).toBe(1);
  expect(ensureProfiles(db)).toBe(0);
});
