import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';
import { DEFAULT_ICA_APP_DCR_CLIENT_SECRET } from './ica/endpoints.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const base = { ICA_HUB_URL: 'https://ica.example.com', ICA_HUB_MASTER_KEY: KEY, ICA_HUB_AUTH_SECRET: 'x'.repeat(32), DATABASE_PATH: ':memory:' };
const oidcEnv = { OIDC_ISSUER_URL: 'https://idp.example.com/application/o/ica-hub/', OIDC_CLIENT_ID: 'id', OIDC_CLIENT_SECRET: 's' };

describe('loadConfig', () => {
  it('derives resource and issuer from the public URL', () => {
    const c = loadConfig(base);
    expect(c.mcpResource).toBe('https://ica.example.com/mcp');
    expect(c.authIssuer).toBe('https://ica.example.com/auth');
    expect(c.masterKey).toHaveLength(32);
  });
  it('rejects a trailing slash', () => {
    expect(() => loadConfig({ ...base, ICA_HUB_URL: 'https://ica.example.com/' })).toThrow(/ICA_HUB_URL.*trailing/);
  });
  it('rejects a path', () => {
    expect(() => loadConfig({ ...base, ICA_HUB_URL: 'https://ica.example.com/hub' })).toThrow(/ICA_HUB_URL/);
  });
  it('rejects http on a non-loopback host', () => {
    expect(() => loadConfig({ ...base, ICA_HUB_URL: 'http://ica.example.com' })).toThrow(/https/);
  });
  it('allows http on loopback', () => {
    expect(loadConfig({ ...base, ICA_HUB_URL: 'http://127.0.0.1:3000' }).mcpResource).toBe('http://127.0.0.1:3000/mcp');
  });
  it('rejects a master key that is not 32 bytes', () => {
    expect(() => loadConfig({ ...base, ICA_HUB_MASTER_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/ICA_HUB_MASTER_KEY.*32/);
  });
  it('requires the auth secret', () => {
    expect(() => loadConfig({ ...base, ICA_HUB_AUTH_SECRET: '' })).toThrow(/ICA_HUB_AUTH_SECRET/);
  });
  it('treats OIDC as all-or-nothing', () => {
    expect(() => loadConfig({ ...base, OIDC_ISSUER_URL: 'https://idp' })).toThrow(/OIDC_CLIENT_ID/);
    const c = loadConfig({ ...base, OIDC_ISSUER_URL: 'https://idp', OIDC_CLIENT_ID: 'id', OIDC_CLIENT_SECRET: 's' });
    expect(c.oidc).toEqual({ issuerUrl: 'https://idp', clientId: 'id', clientSecret: 's', label: 'Single sign-on', linkByEmail: true, adminGroup: undefined, memberGroup: undefined });
  });
  it('AUTH_LOCAL_LOGIN defaults to true and cannot be false without OIDC', () => {
    expect(loadConfig(base).localLogin).toBe(true);
    expect(() => loadConfig({ ...base, AUTH_LOCAL_LOGIN: 'false' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, AUTH_LOCAL_LOGIN: 'false' })).toThrow(/AUTH_LOCAL_LOGIN=false needs OIDC/);
    expect(loadConfig({ ...base, ...oidcEnv, AUTH_LOCAL_LOGIN: 'false' }).localLogin).toBe(false);
    expect(loadConfig({ ...base, ...oidcEnv, AUTH_LOCAL_LOGIN: 'true' }).localLogin).toBe(true);
    expect(() => loadConfig({ ...base, AUTH_LOCAL_LOGIN: 'nope' })).toThrow(/AUTH_LOCAL_LOGIN must be true or false/);
  });
  it('OIDC_LINK_BY_EMAIL defaults to true; OIDC_ADMIN_GROUP is optional', () => {
    expect(loadConfig({ ...base, ...oidcEnv }).oidc).toMatchObject({ linkByEmail: true, adminGroup: undefined });
    expect(loadConfig({ ...base, ...oidcEnv, OIDC_LINK_BY_EMAIL: 'false', OIDC_ADMIN_GROUP: 'ica-admins' }).oidc).toMatchObject({ linkByEmail: false, adminGroup: 'ica-admins' });
    expect(loadConfig({ ...base, ...oidcEnv, OIDC_ADMIN_GROUP: ' ' }).oidc?.adminGroup).toBeUndefined();
  });
  it('OIDC_MEMBER_GROUP is optional, trimmed, and env-managed like the admin group', () => {
    expect(loadConfig({ ...base, ...oidcEnv, OIDC_MEMBER_GROUP: ' ica-hub-users ' }).oidc?.memberGroup).toBe('ica-hub-users');
    expect(loadConfig({ ...base, ...oidcEnv, OIDC_MEMBER_GROUP: ' ' }).oidc?.memberGroup).toBeUndefined();
    expect(loadConfig({ ...base, ...oidcEnv }).envManaged.memberGroup).toBe(true);
    expect(loadConfig({ ...base, OIDC_MEMBER_GROUP: 'ica-hub-users' }).envManaged).toMatchObject({ oidc: false, memberGroup: true, adminGroup: false });
    expect(loadConfig({ ...base, OIDC_MEMBER_GROUP: 'ica-hub-users' }).oidcSwitches.memberGroup).toBe('ica-hub-users');
    expect(() => loadConfig({ ...base, ...oidcEnv, OIDC_LINK_BY_EMAIL: 'maybe' })).toThrow(/OIDC_LINK_BY_EMAIL must be true or false/);
  });
  it('defaults PORT to 3000 and accepts 1-65535', () => {
    expect(loadConfig(base).port).toBe(3000);
    expect(loadConfig({ ...base, PORT: '' }).port).toBe(3000);
    expect(loadConfig({ ...base, PORT: '1' }).port).toBe(1);
    expect(loadConfig({ ...base, PORT: '65535' }).port).toBe(65535);
  });
  it.each(['0', '65536', '-1', '80.5', 'abc', '3000x', ' 3000', '1e3', '0x50'])('rejects PORT=%j', (p) => {
    expect(() => loadConfig({ ...base, PORT: p })).toThrow(/PORT must be an integer from 1 to 65535/);
  });
  it('reads METRICS_ENABLED (default on)', () => {
    expect(loadConfig(base).metricsEnabled).toBe(true);
    expect(loadConfig({ ...base, METRICS_ENABLED: 'true' }).metricsEnabled).toBe(true);
    expect(loadConfig({ ...base, METRICS_ENABLED: 'false' }).metricsEnabled).toBe(false);
    expect(loadConfig({ ...base, METRICS_ENABLED: '0' }).metricsEnabled).toBe(false);
    expect(() => loadConfig({ ...base, METRICS_ENABLED: 'no' })).toThrow(/METRICS_ENABLED/);
  });
  it('parses trust proxy', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig(base).trustProxy).toBe(false);
  });
  it('reads the admin bootstrap pair only when both are set', () => {
    expect(loadConfig({ ...base, ICA_HUB_ADMIN_EMAIL: 'a@b.se' }).adminBootstrap).toBeUndefined();
    expect(loadConfig({ ...base, ICA_HUB_ADMIN_EMAIL: 'a@b.se', ICA_HUB_ADMIN_PASSWORD: 'pw' }).adminBootstrap).toEqual({ email: 'a@b.se', password: 'pw' });
    expect(loadConfig({ ...base, ICA_HUB_ADMIN_EMAIL: ' Owner@Example.com ', ICA_HUB_ADMIN_PASSWORD: 'pw' }).adminBootstrap).toEqual({ email: 'owner@example.com', password: 'pw' });
  });
  it('reads the trusted client allowlist', () => {
    expect(loadConfig(base).trustedClientIds).toEqual([]);
    expect(loadConfig({ ...base, ICA_HUB_TRUSTED_CLIENT_IDS: ' a , b,,' }).trustedClientIds).toEqual(['a', 'b']);
  });
  it('reads the list-write gate: off by default, all, or a list of emails (lower-cased)', () => {
    expect(loadConfig(base).listWrites).toBe('off');
    expect(loadConfig({ ...base, ICA_HUB_LIST_WRITES: '' }).listWrites).toBe('off');
    expect(loadConfig({ ...base, ICA_HUB_LIST_WRITES: ' OFF ' }).listWrites).toBe('off');
    expect(loadConfig({ ...base, ICA_HUB_LIST_WRITES: 'All' }).listWrites).toBe('all');
    expect(loadConfig({ ...base, ICA_HUB_LIST_WRITES: ' Owner@Example.com, partner@example.com ,' }).listWrites).toEqual(['owner@example.com', 'partner@example.com']);
    for (const bad of ['yes', 'owner', ',', 'a@b.se, nope']) expect(() => loadConfig({ ...base, ICA_HUB_LIST_WRITES: bad }), bad).toThrow(ConfigError);
  });
  it('reads the app upkeep mode: interval by default, or on-demand (R-C5 fallback)', () => {
    expect(loadConfig(base).appUpkeep).toBe('interval');
    expect(loadConfig({ ...base, ICA_HUB_APP_UPKEEP: '' }).appUpkeep).toBe('interval');
    expect(loadConfig({ ...base, ICA_HUB_APP_UPKEEP: ' Interval ' }).appUpkeep).toBe('interval');
    expect(loadConfig({ ...base, ICA_HUB_APP_UPKEEP: 'on-demand' }).appUpkeep).toBe('on-demand');
    for (const bad of ['off', 'ondemand', 'true', '10m']) expect(() => loadConfig({ ...base, ICA_HUB_APP_UPKEEP: bad }), bad).toThrow(/ICA_HUB_APP_UPKEEP/);
  });
  it('reads the Handla guard settings: cooldown 10 min, gap 2500 ms, cache 15 min by default; validates each', () => {
    expect(loadConfig(base).handla).toEqual({ cooldownMinutes: 10, minGapMs: 2500, cacheMinutes: 15 });
    expect(loadConfig({ ...base, ICA_HUB_HANDLA_COOLDOWN_MINUTES: '30', ICA_HUB_HANDLA_MIN_GAP_MS: '0', ICA_HUB_HANDLA_CACHE_MINUTES: '0' }).handla).toEqual({ cooldownMinutes: 30, minGapMs: 0, cacheMinutes: 0 });
    expect(loadConfig({ ...base, ICA_HUB_HANDLA_COOLDOWN_MINUTES: ' ', ICA_HUB_HANDLA_MIN_GAP_MS: '' }).handla).toMatchObject({ cooldownMinutes: 10, minGapMs: 2500 });
    for (const bad of ['0', '-1', '61', '1.5', 'ten']) expect(() => loadConfig({ ...base, ICA_HUB_HANDLA_COOLDOWN_MINUTES: bad }), bad).toThrow(/ICA_HUB_HANDLA_COOLDOWN_MINUTES/);
    for (const bad of ['-1', '60001', '2.5', 'x']) expect(() => loadConfig({ ...base, ICA_HUB_HANDLA_MIN_GAP_MS: bad }), bad).toThrow(/ICA_HUB_HANDLA_MIN_GAP_MS/);
    for (const bad of ['-1', '1441', 'abc']) expect(() => loadConfig({ ...base, ICA_HUB_HANDLA_CACHE_MINUTES: bad }), bad).toThrow(/ICA_HUB_HANDLA_CACHE_MINUTES/);
  });
  it('uses the ICA app DCR registration secret unless ICA_APP_DCR_CLIENT_SECRET overrides it', () => {
    expect(loadConfig(base).icaAppDcrClientSecret).toBe(DEFAULT_ICA_APP_DCR_CLIENT_SECRET);
    expect(loadConfig({ ...base, ICA_APP_DCR_CLIENT_SECRET: 'rotated' }).icaAppDcrClientSecret).toBe('rotated');
    expect(loadConfig({ ...base, ICA_APP_DCR_CLIENT_SECRET: '' }).icaAppDcrClientSecret).toBe(DEFAULT_ICA_APP_DCR_CLIENT_SECRET);
  });
  it('throws ConfigError', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });
});

describe('envManaged and setup code (1.6)', () => {
  it('marks nothing env-managed by default', () => {
    expect(loadConfig(base).envManaged).toEqual({ oidc: false, localLogin: false, linkByEmail: false, adminGroup: false, memberGroup: false });
  });
  it('OIDC core is env-managed by issuer/id/secret; OIDC_LABEL alone does not count (compose always sets it)', () => {
    expect(loadConfig({ ...base, OIDC_LABEL: 'Single sign-on' }).envManaged.oidc).toBe(false);
    expect(loadConfig({ ...base, ...oidcEnv }).envManaged).toMatchObject({ oidc: true, linkByEmail: true, adminGroup: true });
    expect(loadConfig({ ...base, OIDC_ISSUER_URL: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '' }).envManaged.oidc).toBe(false);
  });
  it('each switch is env-managed when set, independently', () => {
    expect(loadConfig({ ...base, OIDC_LINK_BY_EMAIL: 'false' }).envManaged).toMatchObject({ oidc: false, linkByEmail: true, adminGroup: false });
    expect(loadConfig({ ...base, OIDC_ADMIN_GROUP: 'ica-admins' }).envManaged.adminGroup).toBe(true);
    expect(loadConfig({ ...base, AUTH_LOCAL_LOGIN: 'true' }).envManaged.localLogin).toBe(true);
  });
  it('reads the OIDC switches from env even when the OIDC core is not in env; a typo still fails fast', () => {
    expect(loadConfig(base).oidcSwitches).toEqual({ linkByEmail: undefined, adminGroup: undefined, memberGroup: undefined });
    expect(loadConfig({ ...base, OIDC_LINK_BY_EMAIL: 'false', OIDC_ADMIN_GROUP: ' ica-admins ' }).oidcSwitches).toEqual({ linkByEmail: false, adminGroup: 'ica-admins', memberGroup: undefined });
    expect(() => loadConfig({ ...base, OIDC_LINK_BY_EMAIL: 'maybe' })).toThrow(/OIDC_LINK_BY_EMAIL must be true or false/);
  });
  it('an empty OIDC_LABEL (compose passes it through empty) falls back to the default label', () => {
    expect(loadConfig({ ...base, ...oidcEnv, OIDC_LABEL: '' }).oidc?.label).toBe('Single sign-on');
    expect(loadConfig({ ...base, ...oidcEnv, OIDC_LABEL: 'Authentik' }).oidc?.label).toBe('Authentik');
  });
  it('keeps the env fail-fast rules exactly', () => {
    expect(() => loadConfig({ ...base, AUTH_LOCAL_LOGIN: 'false' })).toThrow(/AUTH_LOCAL_LOGIN=false needs OIDC/);
    expect(() => loadConfig({ ...base, OIDC_ISSUER_URL: 'https://idp.example.com/' })).toThrow(/all-or-nothing/);
  });
  it('normalises ICA_HUB_SETUP_CODE and refuses a short or odd one', () => {
    expect(loadConfig({ ...base, ICA_HUB_SETUP_CODE: 'abcd-efgh-2345' }).setupCode).toBe('ABCDEFGH2345');
    expect(loadConfig(base).setupCode).toBeUndefined();
    expect(() => loadConfig({ ...base, ICA_HUB_SETUP_CODE: 'short' })).toThrow(/ICA_HUB_SETUP_CODE/);
    expect(() => loadConfig({ ...base, ICA_HUB_SETUP_CODE: 'ÅÄÖÅÄÖÅÄÖÅÄÖ' })).toThrow(/ICA_HUB_SETUP_CODE/);
  });
});
