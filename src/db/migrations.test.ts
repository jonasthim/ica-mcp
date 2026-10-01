import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { closeDb, openDb, schema } from './index.js';

const ROOT = new URL('../../drizzle/', import.meta.url);

/** A migrations folder containing only the first `n` journal entries. */
function migrationsUpTo(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'ica-hub-mig-'));
  cpSync(ROOT, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const j = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
  j.entries = j.entries.slice(0, n);
  writeFileSync(journalPath, JSON.stringify(j));
  return dir;
}

describe('Phase 1.5 migrations on a Phase 1 database', () => {
  it('moves roles to user.role, deletes orphan profiles, adds the FK, drops user_profile.role', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ica-hub-db-')), 'db.sqlite');
    const raw = new Database(file); raw.pragma('foreign_keys = ON');
    migrate(drizzle({ client: raw }), { migrationsFolder: migrationsUpTo(3) });
    const now = new Date().toISOString(); const ms = Date.now();
    for (const [id, role] of [['owner', 'admin'], ['partner', 'user'], ['legacy', null]] as const) {
      raw.prepare('insert into user (id, name, email, email_verified, created_at, updated_at, role) values (?, ?, ?, 0, ?, ?, ?)').run(id, id, `${id}@example.test`, ms, ms, role);
    }
    raw.prepare("insert into user_profile (user_id, role, created_at) values ('owner', 'admin', ?), ('partner', 'member', ?), ('legacy', 'admin', ?), ('ghost', 'member', ?)").run(now, now, now, now);
    raw.close();

    const db = openDb(file); // applies 0003 + 0004
    const roles = Object.fromEntries(db.select({ id: schema.user.id, role: schema.user.role }).from(schema.user).all().map((u) => [u.id, u.role]));
    expect(roles).toEqual({ owner: 'admin', partner: 'member', legacy: 'admin' }); // profile admin wins; 'user'/null → member
    expect(db.select().from(schema.userProfile).all().map((p) => p.userId).sort()).toEqual(['legacy', 'owner', 'partner']);
    const cols = (db.$client.prepare('pragma table_info(user_profile)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('role');
    closeDb(db);
  });

  it('cascades a removed user to its profile; keeps audit rows; nulls invite references', () => {
    const db = openDb(':memory:');
    const now = new Date().toISOString();
    db.insert(schema.user).values([{ id: 'a', name: 'A', email: 'a@example.test', role: 'admin' }, { id: 'b', name: 'B', email: 'b@example.test', role: 'member' }]).run();
    db.insert(schema.userProfile).values({ userId: 'b', createdAt: now }).run();
    db.insert(schema.auditEvent).values({ at: now, actorUserId: 'b', action: 'auth.login', outcome: 'success', detailsJson: '{"method":"local"}' }).run();
    db.insert(schema.invite).values({ id: 'i1', email: 'c@example.test', role: 'member', tokenHash: 'h', createdByUserId: 'b', createdAt: now, expiresAt: now }).run();
    db.delete(schema.user).where(eq(schema.user.id, 'b')).run();
    expect(db.select().from(schema.userProfile).all()).toEqual([]);
    expect(db.select().from(schema.auditEvent).all()).toHaveLength(1); // audit trail survives, actor id kept as text
    expect(db.select().from(schema.invite).get()?.createdByUserId).toBeNull();
    expect(() => db.insert(schema.userProfile).values({ userId: 'nobody', createdAt: now }).run()).toThrow(/FOREIGN KEY/);
    closeDb(db);
  });

  it('rejects a duplicate invite token hash', () => {
    const db = openDb(':memory:');
    const now = new Date().toISOString();
    db.insert(schema.invite).values({ id: 'i1', email: 'x@example.test', role: 'member', tokenHash: 'h', createdAt: now, expiresAt: now }).run();
    expect(() => db.insert(schema.invite).values({ id: 'i2', email: 'y@example.test', role: 'member', tokenHash: 'h', createdAt: now, expiresAt: now }).run()).toThrow(/UNIQUE/);
    closeDb(db);
  });
});

describe('Phase 1.6 migration on a Phase 1.5 database', () => {
  it('adds app_setting and a nullable user_profile column without touching existing rows', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ica-hub-db-')), 'db.sqlite');
    const raw = new Database(file); raw.pragma('foreign_keys = ON');
    migrate(drizzle({ client: raw }), { migrationsFolder: migrationsUpTo(5) });
    const ms = Date.now();
    raw.prepare("insert into user (id, name, email, email_verified, created_at, updated_at, role) values ('owner', 'Owner', 'owner@example.com', 0, ?, ?, 'admin')").run(ms, ms);
    raw.prepare("insert into user_profile (user_id, created_at) values ('owner', ?)").run(new Date().toISOString());
    raw.close();
    const db = openDb(file); // applies 0005
    expect(db.select().from(schema.user).all()).toEqual([expect.objectContaining({ id: 'owner', email: 'owner@example.com', role: 'admin' })]);
    expect(db.select().from(schema.userProfile).all()).toEqual([expect.objectContaining({ userId: 'owner', emailSelfChangedAt: null })]);
    expect(db.select().from(schema.appSetting).all()).toEqual([]);
    closeDb(db);
  });
});

describe('Phase 2 migration 0006 on a Phase 1.6 database', () => {
  it('adds connected_at and refreshed_at to ica_session, null on existing rows', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ica-hub-db-')), 'db.sqlite');
    const raw = new Database(file); raw.pragma('foreign_keys = ON');
    migrate(drizzle({ client: raw }), { migrationsFolder: migrationsUpTo(6) });
    const t = new Date().toISOString();
    raw.prepare("insert into ica_account (id, display_name, created_at, updated_at) values ('acc', 'A', ?, ?)").run(t, t);
    raw.prepare("insert into ica_session (id, ica_account_id, kind, state_enc, updated_at) values ('s1', 'acc', 'app', 'v1.x', ?)").run(t);
    raw.close();
    const db = openDb(file); // applies 0006
    expect(db.select().from(schema.icaSession).all()).toEqual([expect.objectContaining({ id: 's1', kind: 'app', connectedAt: null, refreshedAt: null })]);
    closeDb(db);
  });
});

describe('Phase 2 migration 0007', () => {
  it('adds login_state and login_state_at to ica_session, null on existing rows', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ica-hub-db-')), 'db.sqlite');
    const raw = new Database(file); raw.pragma('foreign_keys = ON');
    migrate(drizzle({ client: raw }), { migrationsFolder: migrationsUpTo(7) });
    const t = new Date().toISOString();
    raw.prepare("insert into ica_account (id, display_name, created_at, updated_at) values ('acc', 'A', ?, ?)").run(t, t);
    raw.prepare("insert into ica_session (id, ica_account_id, kind, state_enc, updated_at, connected_at) values ('w1', 'acc', 'web', 'v1.x', ?, ?)").run(t, t);
    raw.close();
    const db = openDb(file); // applies 0007
    expect(db.select().from(schema.icaSession).all()).toEqual([expect.objectContaining({ id: 'w1', connectedAt: t, loginState: null, loginStateAt: null })]);
    closeDb(db);
  });
});

describe('Phase 2 migration 0008', () => {
  it('adds the subject hash columns to ica_account, null on existing rows', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ica-hub-db-')), 'db.sqlite');
    const raw = new Database(file); raw.pragma('foreign_keys = ON');
    migrate(drizzle({ client: raw }), { migrationsFolder: migrationsUpTo(8) });
    const t = new Date().toISOString();
    raw.prepare("insert into ica_account (id, display_name, created_at, updated_at) values ('acc', 'A', ?, ?)").run(t, t);
    raw.close();
    const db = openDb(file); // applies 0008
    expect(db.select().from(schema.icaAccount).all()).toEqual([expect.objectContaining({ id: 'acc', webSubjectHash: null, appSubjectHash: null })]);
    closeDb(db);
  });
});
