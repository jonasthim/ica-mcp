import { describe, expect, it } from 'vitest';
import { openDb, schema } from '../db/index.js';
import { deleteSetting, readSetting, StoredOidcSchema, StoredSignInSchema, writeSetting } from './store.js';

describe('settings store', () => {
  it('round-trips, reports absent and invalid rows, and deletes', () => {
    const db = openDb(':memory:');
    expect(readSetting(db, 'sign_in_methods', StoredSignInSchema)).toEqual({ state: 'absent' });
    writeSetting(db, 'sign_in_methods', { localLogin: false }, null, new Date('2026-09-30T10:00:00Z'));
    expect(readSetting(db, 'sign_in_methods', StoredSignInSchema)).toEqual({ state: 'ok', value: { localLogin: false } });
    writeSetting(db, 'sign_in_methods', { localLogin: true }, null); // upsert
    expect(db.select().from(schema.appSetting).all()).toHaveLength(1);
    db.update(schema.appSetting).set({ valueJson: '{"localLogin":"yes"}' }).run();
    expect(readSetting(db, 'sign_in_methods', StoredSignInSchema)).toEqual({ state: 'invalid' });
    db.update(schema.appSetting).set({ valueJson: 'not json' }).run();
    expect(readSetting(db, 'sign_in_methods', StoredSignInSchema)).toEqual({ state: 'invalid' });
    expect(deleteSetting(db, 'sign_in_methods')).toBe(true);
    expect(deleteSetting(db, 'sign_in_methods')).toBe(false);
  });
  it('an oidc row stored before the member group existed still parses (no migration needed)', () => {
    const db = openDb(':memory:');
    const old = { issuerUrl: 'https://auth.example.com/o/', clientId: 'c', clientSecretEnc: 'v1.x', label: 'Authentik', linkByEmail: true, adminGroup: 'ica-admins' };
    db.$client.prepare("insert into app_setting (key, value_json, updated_at) values ('oidc', ?, 'x')").run(JSON.stringify(old));
    expect(readSetting(db, 'oidc', StoredOidcSchema)).toEqual({ state: 'ok', value: old });
    writeSetting(db, 'oidc', { ...old, memberGroup: 'ica-users' }, null);
    expect(readSetting(db, 'oidc', StoredOidcSchema)).toEqual({ state: 'ok', value: { ...old, memberGroup: 'ica-users' } });
    db.update(schema.appSetting).set({ valueJson: JSON.stringify({ ...old, memberGroup: '' }) }).run();
    expect(readSetting(db, 'oidc', StoredOidcSchema)).toEqual({ state: 'invalid' });
  });
  it('writes and deletes inside a transaction (rolled back with it)', () => {
    const db = openDb(':memory:');
    expect(() => db.transaction((tx) => { writeSetting(tx, 'sign_in_methods', { localLogin: false }, null); throw new Error('rollback'); })).toThrow('rollback');
    expect(readSetting(db, 'sign_in_methods', StoredSignInSchema)).toEqual({ state: 'absent' });
    db.transaction((tx) => { writeSetting(tx, 'sign_in_methods', { localLogin: false }, null); });
    db.transaction((tx) => { expect(deleteSetting(tx, 'sign_in_methods')).toBe(true); });
    expect(readSetting(db, 'sign_in_methods', StoredSignInSchema)).toEqual({ state: 'absent' });
  });
});
