import type { Config } from '../config.js';
import type { Cipher } from '../crypto.js';
import type { Db } from '../db/index.js';
import { readSetting, StoredOidcSchema, StoredSignInSchema, type ReadResult, type StoredOidc, type StoredSignIn } from './store.js';

export type OidcSettings = NonNullable<Config['oidc']>;
export type SettingsProblem = 'oidc_invalid' | 'oidc_undecryptable' | 'oidc_unreachable' | 'local_login_forced';
export type Source = 'env' | 'ui' | 'default';
/** Rows about to be committed: each replaces the stored row (`null` = deleted), to build a candidate before the commit. */
export type PendingSettings = { oidc?: StoredOidc | null; signIn?: StoredSignIn };
export type EffectiveSettings = {
  oidc?: OidcSettings; localLogin: boolean;
  source: { oidc: Source; localLogin: Source; linkByEmail: Source; adminGroup: Source; memberGroup: Source };
  problems: SettingsProblem[];
};

/**
 * The sign-in settings in force: environment first (field by field, see Config.envManaged), then the admin UI's rows,
 * then defaults. Never throws: a row that cannot be parsed or decrypted disables OIDC and names the problem, and
 * password login switched off by the UI is forced back on when no OIDC is usable (nobody could sign in otherwise).
 * `oidc_unreachable` is added later by the AuthHolder, which is the one that knows whether Better Auth loaded the provider.
 * `pending` rows replace the stored ones (see {@link PendingSettings}).
 */
export function resolveSettings(config: Config, db: Db, cipher: Cipher, pending: PendingSettings = {}): EffectiveSettings {
  const problems: SettingsProblem[] = [];
  const source: EffectiveSettings['source'] = { oidc: 'default', localLogin: 'default', linkByEmail: 'default', adminGroup: 'default', memberGroup: 'default' };
  let oidc: OidcSettings | undefined;
  if (config.envManaged.oidc) {
    oidc = config.oidc;
    Object.assign(source, { oidc: 'env', linkByEmail: 'env', adminGroup: 'env', memberGroup: 'env' });
  } else {
    const row: ReadResult<StoredOidc> = pending.oidc === null ? { state: 'absent' } : pending.oidc ? { state: 'ok', value: pending.oidc } : readSetting(db, 'oidc', StoredOidcSchema);
    if (row.state === 'invalid') problems.push('oidc_invalid');
    if (row.state === 'ok') {
      let clientSecret: string | undefined;
      try { clientSecret = cipher.decrypt(row.value.clientSecretEnc); } catch { problems.push('oidc_undecryptable'); }
      if (clientSecret !== undefined) {
        const sw = config.oidcSwitches;
        oidc = {
          issuerUrl: row.value.issuerUrl, clientId: row.value.clientId, clientSecret, label: row.value.label,
          linkByEmail: sw.linkByEmail ?? row.value.linkByEmail, adminGroup: sw.adminGroup ?? row.value.adminGroup,
          memberGroup: sw.memberGroup ?? row.value.memberGroup,
        };
        const env = config.envManaged;
        Object.assign(source, {
          oidc: 'ui', linkByEmail: env.linkByEmail ? 'env' : 'ui', adminGroup: env.adminGroup ? 'env' : 'ui', memberGroup: env.memberGroup ? 'env' : 'ui',
        });
      }
    }
  }
  let localLogin = true;
  if (config.envManaged.localLogin) { localLogin = config.localLogin; source.localLogin = 'env'; }
  else {
    const row: ReadResult<StoredSignIn> = pending.signIn ? { state: 'ok', value: pending.signIn } : readSetting(db, 'sign_in_methods', StoredSignInSchema);
    if (row.state === 'ok') { localLogin = row.value.localLogin; source.localLogin = 'ui'; }
  }
  if (!localLogin && !oidc && source.localLogin === 'ui') { localLogin = true; problems.push('local_login_forced'); }
  return { ...(oidc ? { oidc } : {}), localLogin, source, problems };
}

/** The env config with the effective sign-in settings laid over it (nothing else changes). */
export function effectiveConfig(config: Config, s: EffectiveSettings): Config {
  return { ...config, oidc: s.oidc, localLogin: s.localLogin };
}
