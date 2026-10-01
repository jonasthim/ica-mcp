import { describe, expect, it } from 'vitest';
import { closeDb, openDb, schema } from './index.js';
import { seedUser } from '../test-helpers.js';

describe('openDb', () => {
  it('migrates an in-memory database and enforces foreign keys', () => {
    const db = openDb(':memory:');
    const now = new Date().toISOString();
    seedUser(db, 'u1');
    db.insert(schema.icaAccount).values({ id: 'acc1', displayName: 'A', createdAt: now, updatedAt: now }).run();
    db.insert(schema.userProfile).values({ userId: 'u1', icaAccountId: 'acc1', createdAt: now }).run();
    expect(db.select().from(schema.userProfile).all()).toHaveLength(1);
    expect(() => db.insert(schema.icaSession).values({ id: 's', icaAccountId: 'missing', kind: 'app', stateEnc: 'v1.z', updatedAt: now }).run()).toThrow(/FOREIGN KEY/);
    closeDb(db);
  });
});
