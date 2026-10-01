import * as z from 'zod/v4';
import { DEFAULT_ICA_APP_DCR_CLIENT_SECRET } from './ica/endpoints.js';

export class ConfigError extends Error {}

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

function publicUrl(raw: string | undefined): string {
  if (!raw) throw new ConfigError('ICA_HUB_URL is required (e.g. https://ica.example.com)');
  if (raw.endsWith('/')) throw new ConfigError('ICA_HUB_URL must not have a trailing slash');
  let u: URL;
  try { u = new URL(raw); } catch { throw new ConfigError('ICA_HUB_URL is not a valid URL'); }
  if (u.pathname !== '/' || u.search || u.hash) throw new ConfigError('ICA_HUB_URL must be an origin only (no path, query or fragment)');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.test(u.hostname))) throw new ConfigError('ICA_HUB_URL must use https (http is allowed only for localhost)');
  return u.origin;
}

function masterKey(raw: string | undefined): Buffer {
  if (!raw) throw new ConfigError('ICA_HUB_MASTER_KEY is required: 32 random bytes, base64 (openssl rand -base64 32)');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new ConfigError('ICA_HUB_MASTER_KEY must decode to exactly 32 bytes');
  return buf;
}

function trustProxy(raw: string | undefined): boolean | number {
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true') return true;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n;
  throw new ConfigError('TRUST_PROXY must be true, false or a hop count');
}

function port(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 3000;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1 || n > 65535) throw new ConfigError('PORT must be an integer from 1 to 65535');
  return n;
}

/** A true/false switch: unset or empty is `dflt`; `true`/`1` and `false`/`0` are accepted, anything else is a ConfigError. */
function bool(name: string, raw: string | undefined, dflt: boolean): boolean {
  if (raw === undefined || raw === '') return dflt;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new ConfigError(`${name} must be true or false`);
}

const OidcSchema = z.object({
  OIDC_ISSUER_URL: z.url(), OIDC_CLIENT_ID: z.string().min(1), OIDC_CLIENT_SECRET: z.string().min(1),
});
/** The sign-in button label when no label was set: OIDC_LABEL empty/unset in env, or the Settings/setup form's label
 * field left blank. The one constant for both, so an env-managed and a UI-managed connection default to the same text. */
export const DEFAULT_OIDC_LABEL = 'Single sign-on';

export type Config = {
  publicUrl: string; mcpResource: string; authIssuer: string; authSecret: string; masterKey: Buffer; databasePath: string;
  trustProxy: boolean | number; logLevel: string; port: number; host: string;
  /** Serve Prometheus metrics at /metrics (METRICS_ENABLED, default true). */
  metricsEnabled: boolean;
  adminBootstrap?: { email: string; password: string };
  /** OAuth client ids the admin has vouched for (ICA_HUB_TRUSTED_CLIENT_IDS, comma-separated); all others show as unverified on consent. */
  trustedClientIds: string[];
  /**
   * OIDC sign-in (Authentik). `linkByEmail` (OIDC_LINK_BY_EMAIL, default true): an existing user whose email the IdP
   * verifies is linked on the first OIDC sign-in. `adminGroup` (OIDC_ADMIN_GROUP) and `memberGroup` (OIDC_MEMBER_GROUP):
   * values of the `groups` claim that map to a role (see the group rules in auth/oidc-policy.ts). With neither set,
   * the claim is ignored.
   */
  oidc?: { issuerUrl: string; clientId: string; clientSecret: string; label: string; linkByEmail: boolean; adminGroup?: string; memberGroup?: string };
  /** The email + password sign-in (AUTH_LOCAL_LOGIN, default true). False needs OIDC, or nobody could sign in. */
  localLogin: boolean;
  /** Which sign-in settings the environment decides (shown read-only in Settings). The OIDC core counts as set when
   * OIDC_ISSUER_URL, OIDC_CLIENT_ID or OIDC_CLIENT_SECRET is non-empty; the switches each when non-empty. */
  envManaged: { oidc: boolean; localLogin: boolean; linkByEmail: boolean; adminGroup: boolean; memberGroup: boolean };
  /** OIDC_LINK_BY_EMAIL / OIDC_ADMIN_GROUP / OIDC_MEMBER_GROUP as set in env (undefined when unset), whether or not the OIDC core is in env. */
  oidcSwitches: { linkByEmail?: boolean; adminGroup?: string; memberGroup?: string };
  /** ICA_HUB_SETUP_CODE, normalised (uppercase, no dashes/spaces): accepted by first-run setup besides the logged code. */
  setupCode?: string;
  /** The ICA app's public DCR registration secret (see ica/endpoints.ts); ICA_APP_DCR_CLIENT_SECRET overrides it. */
  icaAppDcrClientSecret: string;
  /**
   * Who may use the shopping-list write tools (ICA_HUB_LIST_WRITES): 'off' (default: the tools are not registered at
   * all), 'all', or the hub user emails allowed (lower-cased), matched against the user's current email at call time.
   */
  listWrites: ListWrites;
  /**
   * The app-token upkeep (ICA_HUB_APP_UPKEEP): 'interval' (default: every connected app session is refreshed about
   * every 10 minutes, like the ICA app) or 'on-demand' (no scheduled refresh; tokens are refreshed only when a tool
   * uses them). 'on-demand' is the R-C5 fallback if an app refresh turns out to end web purchase history.
   */
  appUpkeep: AppUpkeepMode;
};

export type AppUpkeepMode = 'interval' | 'on-demand';

function appUpkeep(raw: string | undefined): AppUpkeepMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'interval') return 'interval';
  if (v === 'on-demand') return 'on-demand';
  throw new ConfigError('ICA_HUB_APP_UPKEEP must be interval or on-demand');
}

export type ListWrites = 'off' | 'all' | readonly string[];

function listWrites(raw: string | undefined): ListWrites {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return 'off';
  if (v === 'all') return 'all';
  const emails = v.split(',').map((e) => e.trim()).filter(Boolean);
  if (emails.length === 0 || emails.some((e) => !/^[^@\s,]+@[^@\s,]+$/.test(e))) {
    throw new ConfigError('ICA_HUB_LIST_WRITES must be off, all, or a comma-separated list of hub user emails');
  }
  return emails;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const url = publicUrl(env.ICA_HUB_URL);
  const authSecret = env.ICA_HUB_AUTH_SECRET;
  if (!authSecret || authSecret.length < 32) throw new ConfigError('ICA_HUB_AUTH_SECRET is required (≥ 32 chars; openssl rand -base64 32)');
  const anyOidc = ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'].some((k) => env[k]);
  let oidc: Config['oidc'];
  if (anyOidc) {
    const parsed = OidcSchema.safeParse(env);
    if (!parsed.success) throw new ConfigError(`OIDC settings are all-or-nothing: OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET (${parsed.error.issues.map((i) => i.path.join('.')).join(', ')})`);
    oidc = {
      issuerUrl: parsed.data.OIDC_ISSUER_URL, clientId: parsed.data.OIDC_CLIENT_ID, clientSecret: parsed.data.OIDC_CLIENT_SECRET, label: env.OIDC_LABEL?.trim() || DEFAULT_OIDC_LABEL,
      linkByEmail: bool('OIDC_LINK_BY_EMAIL', env.OIDC_LINK_BY_EMAIL, true), adminGroup: env.OIDC_ADMIN_GROUP?.trim() || undefined,
      memberGroup: env.OIDC_MEMBER_GROUP?.trim() || undefined,
    };
  }
  const localLogin = bool('AUTH_LOCAL_LOGIN', env.AUTH_LOCAL_LOGIN, true);
  if (!localLogin && !oidc) throw new ConfigError('AUTH_LOCAL_LOGIN=false needs OIDC (OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET): otherwise nobody can sign in');
  const set = (k: string): boolean => Boolean(env[k]?.trim());
  const envManaged = {
    oidc: anyOidc,
    localLogin: set('AUTH_LOCAL_LOGIN'),
    linkByEmail: anyOidc || set('OIDC_LINK_BY_EMAIL'),
    adminGroup: anyOidc || set('OIDC_ADMIN_GROUP'),
    memberGroup: anyOidc || set('OIDC_MEMBER_GROUP'),
  };
  const oidcSwitches = {
    linkByEmail: set('OIDC_LINK_BY_EMAIL') ? bool('OIDC_LINK_BY_EMAIL', env.OIDC_LINK_BY_EMAIL, true) : undefined,
    adminGroup: env.OIDC_ADMIN_GROUP?.trim() || undefined,
    memberGroup: env.OIDC_MEMBER_GROUP?.trim() || undefined,
  };
  let setupCode: string | undefined;
  if (set('ICA_HUB_SETUP_CODE')) {
    setupCode = env.ICA_HUB_SETUP_CODE!.toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z0-9]{12,64}$/.test(setupCode)) throw new ConfigError('ICA_HUB_SETUP_CODE must be 12 to 64 letters or digits (dashes and spaces are ignored)');
  }
  const adminBootstrap = env.ICA_HUB_ADMIN_EMAIL && env.ICA_HUB_ADMIN_PASSWORD ? { email: env.ICA_HUB_ADMIN_EMAIL.trim().toLowerCase(), password: env.ICA_HUB_ADMIN_PASSWORD } : undefined;
  return {
    publicUrl: url, mcpResource: `${url}/mcp`, authIssuer: `${url}/auth`, authSecret,
    masterKey: masterKey(env.ICA_HUB_MASTER_KEY), databasePath: env.DATABASE_PATH ?? 'data/ica-hub.db',
    trustProxy: trustProxy(env.TRUST_PROXY), logLevel: env.LOG_LEVEL ?? 'info',
    port: port(env.PORT), host: env.HOST ?? '0.0.0.0', metricsEnabled: bool('METRICS_ENABLED', env.METRICS_ENABLED, true), adminBootstrap, oidc, localLogin,
    envManaged, oidcSwitches, setupCode,
    trustedClientIds: (env.ICA_HUB_TRUSTED_CLIENT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    icaAppDcrClientSecret: env.ICA_APP_DCR_CLIENT_SECRET || DEFAULT_ICA_APP_DCR_CLIENT_SECRET,
    listWrites: listWrites(env.ICA_HUB_LIST_WRITES),
    appUpkeep: appUpkeep(env.ICA_HUB_APP_UPKEEP),
  };
}
