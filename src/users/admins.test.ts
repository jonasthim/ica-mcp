import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { closeDb, openDb, schema, type Db } from '../db/index.js';
import { seedUser } from '../test-helpers.js';
import { activeAdminCount, syncGroupRole } from './admins.js';

const roleOf = (db: Db, id: string) => db.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, id)).get()?.role;

describe('syncGroupRole', () => {
  it('promotes and demotes, and reports the change', () => {
    const db = openDb(':memory:');
    seedUser(db, 'a', { role: 'admin' }); seedUser(db, 'b', { role: 'admin' }); seedUser(db, 'm', { role: 'member' });
    expect(syncGroupRole(db, 'm', 'admin')).toEqual({ changed: true, from: 'member', to: 'admin' });
    expect(syncGroupRole(db, 'm', 'admin')).toEqual({ changed: false });
    expect(syncGroupRole(db, 'b', 'member')).toEqual({ changed: true, from: 'admin', to: 'member' });
    expect(roleOf(db, 'b')).toBe('member');
    expect(syncGroupRole(db, 'gone', 'admin')).toEqual({ changed: false });
  });
  it('never demotes the last active admin; a disabled admin does not count', () => {
    const db = openDb(':memory:');
    seedUser(db, 'a', { role: 'admin' }); seedUser(db, 'banned', { role: 'admin' });
    db.update(schema.user).set({ banned: true }).where(eq(schema.user.id, 'banned')).run();
    expect(activeAdminCount(db)).toBe(1);
    expect(syncGroupRole(db, 'a', 'member')).toEqual({ changed: false, keptLastAdmin: true });
    expect(roleOf(db, 'a')).toBe('admin');
    // A disabled admin is not "the last active admin": it can be demoted.
    expect(syncGroupRole(db, 'banned', 'member')).toEqual({ changed: true, from: 'admin', to: 'member' });
  });
  it('a user without a role (null) counts as a member', () => {
    const db = openDb(':memory:');
    seedUser(db, 'n');
    expect(syncGroupRole(db, 'n', 'member')).toEqual({ changed: false });
  });

  /**
   * The last two admins sign in at the same moment, both only in the member group. The count and the update are one
   * `BEGIN IMMEDIATE` transaction, so the second connection waits for the first one's commit and then sees one admin
   * left: it keeps it. The main thread plays the first sign-in (demoting A inside an open IMMEDIATE transaction), the
   * worker the second (B), blocked on A's lock until A commits.
   */
  it('two concurrent sign-ins of the last two admins leave one admin (separate connections)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ica-hub-admins-')), 'db.sqlite');
    const a = openDb(file);
    try {
      seedUser(a, 'A', { role: 'admin' }); seedUser(a, 'B', { role: 'admin' });
      a.$client.prepare('BEGIN IMMEDIATE').run();
      a.$client.prepare("update user set role = 'member' where id = 'A'").run(); // A's demotion, not committed yet
      const worker = new Worker(new URL('./admins.lock-worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'], workerData: { file, busyTimeoutMs: 3000, userId: 'B' } });
      try {
        const result = await new Promise<{ ok: boolean; outcome?: unknown; error?: string }>((resolve, reject) => {
          worker.on('message', (m: { type: string; ok: boolean; outcome?: unknown; error?: string }) => {
            if (m.type === 'result') { resolve({ ok: m.ok, outcome: m.outcome, error: m.error }); return; }
            setTimeout(() => { a.$client.prepare('COMMIT').run(); }, 50);
          });
          worker.once('error', reject);
        });
        expect(result).toEqual({ ok: true, outcome: { changed: false, keptLastAdmin: true } });
      } finally { await worker.terminate(); }
      expect(activeAdminCount(a)).toBe(1);
      expect(roleOf(a, 'B')).toBe('admin');
    } finally { closeDb(a); }
  });
});
