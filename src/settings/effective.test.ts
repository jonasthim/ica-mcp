import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createCipher } from '../crypto.js';
import { openDb } from '../db/index.js';
import { writeSetting } from './store.js';
import { effectiveConfig, resolveSettings } from './effective.js';

const KEY = Buffer.alloc(32, 1).toString('base64');
const base = { ICA_HUB_URL: 'https://ica.example.com', ICA_HUB_MASTER_KEY: KEY, ICA_HUB_AUTH_SECRET: 'x'.repeat(32), DATABASE_PATH: ':memory:' };
const cipher = createCipher(Buffer.alloc(32, 1));
const uiOidc = (o: Partial<Record<string, unknown>> = {}) => ({
  issuerUrl: 'https://auth.example.com/application/o/ica-hub/', clientId: 'ica-hub', clientSecretEnc: cipher.encrypt('s3cret'), label: 'Authentik', linkByEmail: true, ...o,
});

describe('resolveSettings', () => {
  it('defaults: no OIDC, password login on', () => {
    const s = resolveSettings(loadConfig(base), openDb(':memory:'), cipher);
    expect(s).toEqual({ localLogin: true, source: { oidc: 'default', localLogin: 'default', linkByEmail: 'default', adminGroup: 'default', memberGroup: 'default' }, problems: [] });
  });
  it('uses the DB row (secret decrypted) when env does not manage OIDC', () => {
    const db = openDb(':memory:');
    writeSetting(db, 'oidc', uiOidc({ adminGroup: 'ica-admins', memberGroup: 'ica-users' }), null);
    writeSetting(db, 'sign_in_methods', { localLogin: false }, null);
    const s = resolveSettings(loadConfig(base), db, cipher);
    expect(s.oidc).toEqual({ issuerUrl: 'https://auth.example.com/application/o/ica-hub/', clientId: 'ica-hub', clientSecret: 's3cret', label: 'Authentik', linkByEmail: true, adminGroup: 'ica-admins', memberGroup: 'ica-users' });
    expect(s.localLogin).toBe(false);
    expect(s.source).toEqual({ oidc: 'ui', localLogin: 'ui', linkByEmail: 'ui', adminGroup: 'ui', memberGroup: 'ui' });
  });
  it('env wins over a DB row, field by field', () => {
    const db = openDb(':memory:');
    writeSetting(db, 'oidc', uiOidc(), null);
    const env = loadConfig({ ...base, OIDC_ISSUER_URL: 'https://env.example.com/o/', OIDC_CLIENT_ID: 'env', OIDC_CLIENT_SECRET: 'env-secret' });
    expect(resolveSettings(env, db, cipher).oidc).toMatchObject({ issuerUrl: 'https://env.example.com/o/', clientSecret: 'env-secret' });
    const linkOnly = resolveSettings(loadConfig({ ...base, OIDC_LINK_BY_EMAIL: 'false' }), db, cipher);
    expect(linkOnly.oidc).toMatchObject({ issuerUrl: 'https://auth.example.com/application/o/ica-hub/', linkByEmail: false });
    expect(linkOnly.source).toMatchObject({ oidc: 'ui', linkByEmail: 'env' });
    // OIDC_MEMBER_GROUP alone overrides only the member group of a UI-managed connection.
    writeSetting(db, 'oidc', uiOidc({ memberGroup: 'ui-users' }), null);
    const memberOnly = resolveSettings(loadConfig({ ...base, OIDC_MEMBER_GROUP: 'env-users' }), db, cipher);
    expect(memberOnly.oidc).toMatchObject({ issuerUrl: 'https://auth.example.com/application/o/ica-hub/', memberGroup: 'env-users' });
    expect(memberOnly.source).toMatchObject({ oidc: 'ui', memberGroup: 'env', adminGroup: 'ui' });
    expect(resolveSettings(loadConfig(base), db, cipher).oidc?.memberGroup).toBe('ui-users');
  });
  it('an invalid row disables OIDC with a problem, never throws', () => {
    const db = openDb(':memory:');
    db.$client.prepare("insert into app_setting (key, value_json, updated_at) values ('oidc', '{\"issuerUrl\":42}', 'x')").run();
    const s = resolveSettings(loadConfig(base), db, cipher);
    expect(s.oidc).toBeUndefined(); expect(s.problems).toEqual(['oidc_invalid']);
  });
  it('a secret encrypted under another master key disables OIDC (oidc_undecryptable)', () => {
    const db = openDb(':memory:');
    writeSetting(db, 'oidc', uiOidc({ clientSecretEnc: createCipher(Buffer.alloc(32, 2)).encrypt('x') }), null);
    const s = resolveSettings(loadConfig(base), db, cipher);
    expect(s.oidc).toBeUndefined(); expect(s.problems).toEqual(['oidc_undecryptable']);
  });
  it('forces password login on when it is off by UI but no OIDC is usable', () => {
    const db = openDb(':memory:');
    writeSetting(db, 'sign_in_methods', { localLogin: false }, null);
    const s = resolveSettings(loadConfig(base), db, cipher);
    expect(s.localLogin).toBe(true); expect(s.problems).toEqual(['local_login_forced']);
  });
  it('pending rows replace the stored ones (null = deleted), for a candidate before committing', () => {
    const db = openDb(':memory:');
    writeSetting(db, 'oidc', uiOidc(), null);
    const c = loadConfig(base);
    expect(resolveSettings(c, db, cipher, { oidc: null }).oidc).toBeUndefined();
    expect(resolveSettings(c, db, cipher, { oidc: uiOidc({ label: 'Pending' }) as never }).oidc?.label).toBe('Pending');
    const off = resolveSettings(c, db, cipher, { signIn: { localLogin: false } });
    expect(off.localLogin).toBe(false); expect(off.source.localLogin).toBe('ui');
    expect(resolveSettings(c, db, cipher).localLogin).toBe(true); // nothing was written
  });
  it('effectiveConfig overlays oidc and localLogin only', () => {
    const c = loadConfig(base);
    const e = effectiveConfig(c, { localLogin: false, oidc: { issuerUrl: 'https://i/', clientId: 'c', clientSecret: 's', label: 'L', linkByEmail: true }, source: { oidc: 'ui', localLogin: 'ui', linkByEmail: 'ui', adminGroup: 'default', memberGroup: 'default' }, problems: [] });
    expect(e).toEqual({ ...c, localLogin: false, oidc: { issuerUrl: 'https://i/', clientId: 'c', clientSecret: 's', label: 'L', linkByEmail: true } });
  });
});
