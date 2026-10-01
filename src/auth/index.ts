import { betterAuth } from 'better-auth';
import { admin, genericOAuth, jwt } from 'better-auth/plugins';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import * as z from 'zod/v4';
import { ConfigError, type Config } from '../config.js';
import { schema, type Db } from '../db/index.js';
import { accessControl } from './roles.js';
import { createAudit, type Audit } from '../audit.js';
import { createLogger } from '../logger.js';
import { CLIENT_IP_HEADER, OIDC_PROVIDER_ID } from './constants.js';
import { createOidcPolicy, createOidcRejections, type OidcRejections } from './oidc-policy.js';
import { insertFirstAdmin, userCount } from '../users/first-admin.js';
import { discoveryUrlFor } from '../settings/oidc-check.js';
import type { SetupGate } from '../setup/state.js';
import type { SeenGroups } from './seen-groups.js';

export const AUTH_BASE_PATH = '/auth';
export const LOGIN_PAGE = '/admin/login';
export const CONSENT_PAGE = '/admin/consent';
export const MCP_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'mcp'] as const;
export { CLIENT_IP_HEADER, OIDC_PROVIDER_ID };

/** The longest user agent kept on a session row (the Profile page's device label only reads this much). */
export const SESSION_USER_AGENT_MAX = 512;

/**
 * Collaborators Better Auth hooks use: `audit` records sign-in events that happen inside Better Auth (OIDC),
 * `oidcRejections` hands the "no account for <email>" email to the sign-in page (shared with the app, see createApp),
 * `setup` lets the first OIDC sign-in of a live setup session create the first admin (OIDC-first setup), and
 * `seenGroups` remembers admins' groups claims for the Settings page.
 */
export type AuthOptions = { audit?: Audit; oidcRejections?: OidcRejections; setup?: SetupGate; seenGroups?: SeenGroups };

export function createAuth(config: Config, db: Db, o: AuthOptions = {}) {
  const log = createLogger(config.logLevel);
  const audit = o.audit ?? createAudit(db, log);
  const policy = createOidcPolicy({
    db, config, audit, rejections: o.oidcRejections ?? createOidcRejections(), log, ...(o.setup ? { setup: o.setup } : {}), ...(o.seenGroups ? { seenGroups: o.seenGroups } : {}),
  });
  return betterAuth({
    baseURL: config.publicUrl,
    basePath: AUTH_BASE_PATH,
    secret: config.authSecret,
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    trustedOrigins: [config.publicUrl],
    // Better Auth's own log lines (e.g. an OIDC provider skipped after a failed discovery) go through our logger, so
    // LOG_LEVEL applies and they are JSON like the rest. Only the message and error names are kept: the other arguments
    // may be objects carrying request or configuration data (never log the client secret).
    logger: {
      log: (level, message, ...args: unknown[]) => {
        const errors = args.filter((a): a is Error => a instanceof Error).map((a) => a.name);
        log[level]({ component: 'better-auth', ...(errors.length ? { errors } : {}) }, message);
      },
    },
    // 7-day sessions, refreshed (sliding) at most once a day: the admin router's session lookup (admin/session.ts)
    // forwards the re-issued cookie, so the browser's expiry slides with the database row.
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    // The user agent is client-chosen: store at most SESSION_USER_AGENT_MAX characters of it on the session row.
    databaseHooks: {
      // OIDC: an invited user created at the callback claims its invite and gets its role (see oidc-policy.ts).
      user: { create: { after: policy.afterUserCreate } },
      session: {
        create: {
          before: async (session) => {
            const ua = session.userAgent;
            return typeof ua === 'string' && ua.length > SESSION_USER_AGENT_MAX ? { data: { ...session, userAgent: ua.slice(0, SESSION_USER_AGENT_MAX) } } : true;
          },
          // Audits OIDC sign-ins (the local ones are audited by the admin router, which sees the outcome).
          after: policy.afterSessionCreate,
        },
      },
    },
    // The OIDC sign-in rules: invite, linked subject, link by email, email_verified, disabled users, admin group.
    user: { validateUserInfo: policy.validateUserInfo },
    account: {
      accountLinking: {
        enabled: true,
        // Linking by email is decided by validateUserInfo (OIDC_LINK_BY_EMAIL), so a refusal is audited with its reason.
        disableImplicitLinking: false,
        // Local accounts are created only by an admin (invite or bootstrap), never by self sign-up (/sign-up/email is
        // not on the public allow-list), so their email is admin-vouched; the IdP side must still assert
        // email_verified, which validateUserInfo enforces on every OIDC action.
        requireLocalEmailVerified: false,
        // Trusting the provider only skips Better Auth's own email_verified check before linking, which would refuse
        // with a generic "account not linked" before our gate runs; validateUserInfo refuses email_verified !== true
        // for every action (create, link, sign-in) and fails closed if it throws.
        trustedProviders: config.oidc ? [OIDC_PROVIDER_ID] : [],
      },
    },
    // Better Auth's own error redirects (e.g. a failed OIDC callback) land on our sign-in page with a fixed code.
    onAPIError: { errorURL: `${config.publicUrl}${LOGIN_PAGE}?error=oidc` },
    advanced: {
      // Explicit, so the origin/CSRF check also runs under vitest (Better Auth skips it by default when isTest()).
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      useSecureCookies: config.publicUrl.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
    },
    plugins: [
      jwt(),
      admin({ defaultRole: 'member', adminRoles: ['admin'], ...accessControl }),
      mcp({
        loginPage: LOGIN_PAGE,
        consentPage: CONSENT_PAGE,
        resource: config.mcpResource,
        scopes: [...MCP_SCOPES],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: ['mcp', 'offline_access'],
        clientRegistrationRequirePKCE: true,
        refreshTokenReuseInterval: 30,
        refreshTokenExpiresIn: 60 * 60 * 24 * 90,
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
      ...(config.oidc
        ? [genericOAuth({ config: [{
          providerId: OIDC_PROVIDER_ID, clientId: config.oidc.clientId, clientSecret: config.oidc.clientSecret,
          discoveryUrl: discoveryUrlFor(config.oidc.issuerUrl),
          // Without the groups scope an IdP may leave the claim out: asked for whenever a group mapping is configured.
          scopes: ['openid', 'email', 'profile', ...(config.oidc.adminGroup || config.oidc.memberGroup ? ['groups'] : [])],
          // A bare callback never creates a user: our two start points ask for sign-up, and validateUserInfo gates it on an invite.
          pkce: true, disableImplicitSignUp: true,
        }] })]
        : []),
    ],
  });
}
export type Auth = ReturnType<typeof createAuth>;

const BOOTSTRAP_EMAIL = z.email();

/**
 * Env bootstrap (ICA_HUB_ADMIN_EMAIL/PASSWORD), first start only: runs only while the `user` table is empty, so an
 * admin that was removed, renamed or re-emailed is never recreated. Docker/automation keep working; everyone else uses
 * the first-run setup page instead.
 *
 * `configuredOidc` is the OIDC settings as *configured* — `snapshot().settings.oidc`, not `config.oidc`
 * (`snapshot().config.oidc`): the AuthHolder strips the latter to `undefined` whenever the provider failed to load
 * (e.g. discovery unreachable at boot), so basing the lockout check below on `config.oidc` would wrongly claim
 * `OIDC_LINK_BY_EMAIL=false` — and refuse to bootstrap — for a perfectly valid `linkByEmail: true` configuration that
 * merely hasn't loaded yet. Required (no default): a caller passing a *built* `Config` (`snapshot().config`) without
 * also passing `snapshot().settings.oidc` here would silently reintroduce that bug, so every caller — including tests
 * that pass the raw env `Config` directly, where the two are the same value — must say so explicitly.
 */
export async function ensureBootstrapAdmin(auth: Auth, db: Db, config: Config, configuredOidc: Config['oidc']): Promise<'created' | 'skipped'> {
  if (!config.adminBootstrap || userCount(db) > 0) return 'skipped';
  // Password sign-in off and no linking by email: the bootstrap admin could never sign in (env fail-fast, unchanged).
  if (!config.localLogin && !configuredOidc?.linkByEmail) {
    throw new ConfigError('AUTH_LOCAL_LOGIN=false with OIDC_LINK_BY_EMAIL=false would lock out the bootstrap admin (ICA_HUB_ADMIN_EMAIL): '
      + 'set OIDC_LINK_BY_EMAIL=true for the first sign-in, or enable AUTH_LOCAL_LOGIN until the admin has signed in with OIDC');
  }
  const { password } = config.adminBootstrap;
  if (password.length < 12 || password.length > 128) throw new ConfigError('ICA_HUB_ADMIN_PASSWORD must be 12 to 128 characters');
  const email = config.adminBootstrap.email.trim().toLowerCase();
  // Better Auth's own createUser (z.email() under the hood) would have rejected a malformed ICA_HUB_ADMIN_EMAIL; the
  // hand-rolled insert must reject it the same way, or a typo'd env value creates an admin nobody can ever sign in as
  // (signInEmail returns 400 INVALID_EMAIL), and — the table no longer being empty — first-run setup never offers
  // to fix it: a permanent lockout. No value in the message: it may be attacker-controlled in a hosted setup.
  if (!BOOTSTRAP_EMAIL.safeParse(email).success) throw new ConfigError('ICA_HUB_ADMIN_EMAIL must be a valid email address');
  const passwordHash = await (await auth.$context).password.hash(password);
  const userId = insertFirstAdmin(db, { email, name: email.split('@')[0] || 'admin', passwordHash });
  if (!userId) return 'skipped';
  createLogger(config.logLevel).info({ userId }, 'bootstrap admin created');
  return 'created';
}
