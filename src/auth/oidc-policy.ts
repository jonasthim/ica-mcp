import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { BetterAuthOptions } from 'better-auth';
import { schema, type Db } from '../db/index.js';
import type { Config } from '../config.js';
import type { Audit } from '../audit.js';
import type { Logger } from '../logger.js';
import { roleOf, type Role } from './roles.js';
import { claimInvite, pendingInviteForEmail } from '../users/invites.js';
import { promoteFirstAdmin, promoteFirstGroupAdmin, userCount } from '../users/first-admin.js';
import { syncGroupRole } from '../users/admins.js';
import { isMatchableEmail, isSelfChangedEmail } from '../users/email.js';
import type { SetupGate } from '../setup/state.js';
import type { SeenGroups } from './seen-groups.js';
import { CLIENT_IP_HEADER, OIDC_PROVIDER_ID } from './constants.js';

export { isMatchableEmail } from '../users/email.js';

/**
 * The OIDC error codes the sign-in page has a fixed message for (compared lowercased: Better Auth's own codes can be
 * upper case, e.g. `BANNED_USER`). Any other code shows the `failed` message.
 */
export const OIDC_ERROR_CODES = [
  'not_invited', 'email_not_verified', 'email_invalid', 'account_not_linked', 'banned_user', 'not_in_group', 'groups_missing', 'setup_incomplete',
  'state_not_found', 'state_mismatch', 'access_denied', 'failed',
] as const;
export type OidcErrorCode = (typeof OIDC_ERROR_CODES)[number];

/**
 * Where a failed OIDC sign-in lands: the sign-in page with the OAuth query it started from (so a Claude connection
 * can be retried) and our fixed `error=oidc` marker. Better Auth appends its own `error=<code>` after it.
 */
export const oidcErrorUrl = (oauthQuery: string): string => `/admin/login?${oauthQuery ? `${oauthQuery}&` : ''}error=oidc`;

/**
 * The email of a refused "no account" sign-in, for the sign-in page to name it. Only an opaque reference travels in
 * the redirect (never the email itself), usable once and for 5 minutes, in memory.
 */
export type OidcRejections = { put(email: string): string; take(ref: string): string | undefined };
export function createOidcRejections(o: { ttlMs?: number; now?: () => number } = {}): OidcRejections {
  const ttl = o.ttlMs ?? 5 * 60_000;
  const now = o.now ?? Date.now;
  const m = new Map<string, { email: string; at: number }>();
  return {
    put(email) {
      for (const [k, v] of m) if (now() - v.at > ttl) m.delete(k);
      const ref = randomBytes(12).toString('base64url');
      m.set(ref, { email, at: now() });
      return ref;
    },
    take(ref) {
      const v = m.get(ref);
      m.delete(ref);
      return v && now() - v.at <= ttl ? v.email : undefined;
    },
  };
}

type Validate = NonNullable<NonNullable<BetterAuthOptions['user']>['validateUserInfo']>;
/**
 * A creation `validateUserInfo` allowed, waiting for its user row: an invite, a setup-session claim, or a group
 * provisioning (rule d; `firstRun` while the user table was empty, see {@link promoteFirstGroupAdmin}).
 */
type Pending = { kind: 'invite'; inviteId: string; role: Role; at: number } | { kind: 'setup'; at: number }
  | { kind: 'group'; role: Role; firstRun: boolean; at: number };
/** What a sign-in's groups say (see groupVerdict). */
type Verdict = Role | 'none' | 'keep';
/** How long a validation's decision (invite, group role) waits for its user or session row (same request; generous). */
const PENDING_TTL_MS = 120_000;
const isOidcCallback = (ctx: { path?: string } | null | undefined): boolean => Boolean(ctx?.path?.startsWith('/callback/'));

/** The profile's `groups` claim when it is an array of strings; `undefined` when it is missing or anything else. */
export function groupsClaim(profile: Record<string, unknown> | undefined): string[] | undefined {
  const g = profile?.groups;
  if (!Array.isArray(g)) return undefined;
  return g.every((x): x is string => typeof x === 'string') ? g : [];
}

/**
 * The OIDC sign-in rules (spec "OIDC linking"), as Better Auth hooks. `validateUserInfo` is the single gate for every
 * OIDC sign-in, whichever way Better Auth resolved the user, so each refusal is audited with its real reason:
 * - every action needs `email_verified === true` (Better Auth's own check is bypassed by trusting the provider, see createAuth);
 * - the raw email claim must be matchable ({@link isMatchableEmail}), else `email_invalid`;
 * - `sign-in` (a) — the subject is already linked — and `link-account` (c) — an existing user with the verified email,
 *   only when OIDC_LINK_BY_EMAIL, only for the user's first OIDC identity, and never into an email a member set
 *   themselves and no admin has confirmed — are refused for a disabled user;
 * - `create-user` (b) with a pending invite for the verified email; `afterUserCreate` then claims it and applies its
 *   role. (d) Without one, a member of the admin or member group is provisioned with that role (admin wins).
 *   Otherwise `not_invited`, with an opaque reference to the email for the friendly "No ICA-MCP account for <email>" page.
 * First-run setup (spec 1.6, `setup`): while no user exists, the one browser holding a live setup session may create
 * the first admin without an invite (`afterUserCreate` promotes it with promoteFirstAdmin and closes setup). With OIDC
 * in env and an admin group, the first admin-group sign-in does the same without the setup code; a member-group
 * sign-in on the empty table creates nobody (`setup_incomplete`), since it would close setup with no admin.
 *
 * Group mapping (OIDC_ADMIN_GROUP / OIDC_MEMBER_GROUP, see {@link groupVerdict}): with either set, the `groups` claim
 * decides the role at every sign-in, applied in `afterSessionCreate` (i.e. only once the sign-in succeeded) with
 * {@link syncGroupRole}, which never demotes the last active admin. In neither group (member group set) the OIDC
 * sign-in is refused: `not_in_group`, or `groups_missing` when the claim is absent altogether (an IdP without a groups
 * mapping), which is also logged with the user id only. With only the admin group set it only ever promotes, as before.
 */
export function createOidcPolicy(deps: {
  db: Db; config: Config; audit: Audit; rejections: OidcRejections; log: Pick<Logger, 'warn'>; setup?: SetupGate; seenGroups?: SeenGroups;
}): {
  validateUserInfo: Validate;
  afterUserCreate(user: { id: string; email: string }, ctx: { path?: string } | null | undefined): Promise<void>;
  afterSessionCreate(session: { userId: string; ipAddress?: string | null; userAgent?: string | null }, ctx: { path?: string } | null | undefined): Promise<void>;
} {
  const { db, config, audit, rejections, log } = deps;
  const pending = new Map<string, Pending>(); // lowercased email → the creation chosen at create-user, consumed in afterUserCreate
  // User id → the role its latest OIDC validation's groups decided (and the groups themselves); consumed by that
  // sign-in's session. Keyed by id, never by email: at `sign-in` the IdP's current email may differ from the stored
  // one (and belong to someone else). Every validation of the user sets or clears it, so a failed flow's entry never
  // changes a later sign-in.
  type Sync = { role?: Role; groups?: string[]; at: number };
  const syncs = new Map<string, Sync>();
  // Same for `create-user`, which has no id yet: keyed by the (lowercased) email the user is created with, and moved
  // under the new id by afterUserCreate once that user's stored email is this key.
  const newUserSyncs = new Map<string, Sync>();
  const adminGroup = config.oidc?.adminGroup;
  const memberGroup = config.oidc?.memberGroup;
  /**
   * The role the groups give: the admin group → admin, else the member group → member, else (member group set) `none`
   * — refused. `keep` leaves the role alone: no group configured, or only the admin group and not in it (promote-only).
   */
  const groupVerdict = (groups: string[] | undefined): Verdict => {
    if (!adminGroup && !memberGroup) return 'keep';
    if (adminGroup && groups?.includes(adminGroup)) return 'admin';
    if (memberGroup && groups?.includes(memberGroup)) return 'member';
    return memberGroup ? 'none' : 'keep';
  };
  /** The role a sign-in's session applies: a member verdict demotes only when an admin group exists to be in. */
  const syncRole = (v: Verdict): Role | undefined => (v === 'admin' ? 'admin' : v === 'member' && adminGroup ? 'member' : undefined);
  const applySync = (userId: string, role: Role): void => {
    const out = syncGroupRole(db, userId, role);
    if (out.changed) {
      audit.record({ action: 'user.role_changed', actorUserId: null, target: { type: 'user', id: userId }, details: { from: out.from, to: out.to, via: 'oidc_group' } });
    } else if (out.keptLastAdmin) {
      log.warn({ userId }, 'oidc group mapping: the last active admin is not in the admin group; kept as admin');
    }
  };
  /** Whether the user already has an OIDC identity (rule c links only the first one). */
  const hasOidcAccount = (userId: string): boolean => Boolean(db.select({ id: schema.account.id }).from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, OIDC_PROVIDER_ID))).get());
  /** Disabled as the admin plugin sees it: banned, and the ban has not lapsed. */
  const isDisabled = (userId: string): boolean => {
    const u = db.select({ banned: schema.user.banned, banExpires: schema.user.banExpires }).from(schema.user).where(eq(schema.user.id, userId)).get();
    return Boolean(u?.banned) && !(u?.banExpires && u.banExpires.getTime() < Date.now());
  };
  /** Some user already has this (lowercased) email: rule (d) never creates a second account with it. */
  const emailTaken = (email: string): boolean => Boolean(db.select({ id: schema.user.id }).from(schema.user)
    .where(sql`lower(${schema.user.email}) = ${email}`).get());

  const validateUserInfo: Validate = async ({ user, source }, ctx) => {
    if (source.method !== 'oauth' || source.oauth?.providerId !== OIDC_PROVIDER_ID) return;
    const email = String(user.email ?? '').trim().toLowerCase();
    // Reason codes and the (lowercased) email only: never tokens or claims.
    const fail = (reason: OidcErrorCode, errorDescription?: string) => {
      audit.record({
        action: 'auth.login_failed', actorUserId: null, outcome: 'failure', details: { method: 'oidc', reason, email },
        ip: ctx?.headers?.get(CLIENT_IP_HEADER) ?? null, userAgent: ctx?.headers?.get('user-agent') ?? null,
      });
      return errorDescription ? { error: reason, errorDescription } : { error: reason };
    };
    for (const m of [syncs, newUserSyncs]) for (const [k, v] of m) if (Date.now() - v.at > PENDING_TTL_MS) m.delete(k);
    if (typeof user.id === 'string') syncs.delete(user.id);
    if (source.action === 'create-user') newUserSyncs.delete(email);
    const profile = source.oauth.profile;
    const claim = profile?.email;
    if (!isMatchableEmail(typeof claim === 'string' ? claim.trim() : String(user.email ?? '').trim())) return fail('email_invalid');
    if (user.emailVerified !== true) return fail('email_not_verified');
    const groups = groupsClaim(profile);
    const verdict = groupVerdict(groups);
    const mapped = Boolean(adminGroup || memberGroup);
    // A group mapping without any groups claim is an IdP problem (no groups scope mapping), not a membership one.
    const missing = mapped && groups === undefined;
    if (missing) log.warn(typeof user.id === 'string' ? { userId: user.id } : {}, 'oidc group mapping is configured, but the sign-in carried no groups claim');
    const notInGroup = () => fail(missing ? 'groups_missing' : 'not_in_group');
    const seen: Sync = { ...(groups ? { groups } : {}), at: Date.now() };
    const role = syncRole(verdict);
    if (source.action === 'create-user') {
      if (verdict === 'none') return notInGroup();
      // First-run setup (spec 1.6): while no user exists, the one browser holding a live setup session may create the
      // first admin without an invite. The claim is check-and-set, so a second concurrent callback falls through.
      if (deps.setup?.claimFirstAdmin(ctx?.headers?.get('cookie') ?? undefined)) {
        pending.set(email, { kind: 'setup', at: Date.now() });
        return;
      }
      const inv = pendingInviteForEmail(db, email);
      if (inv) {
        // With a member group set, roles follow the groups both ways: the invite is created with the role its groups give
        // (else its second sign-in would flip an admin invite to member). With only the admin group, the invite keeps
        // its role and the admin group still promotes it (promote-only, as before).
        const inviteRole = memberGroup && (verdict === 'admin' || verdict === 'member') ? verdict : inv.role;
        pending.set(email, { kind: 'invite', inviteId: inv.id, role: inviteRole, at: Date.now() });
        newUserSyncs.set(email, verdict === 'admin' ? { ...seen, role: 'admin' } : seen);
        return;
      }
      if (verdict === 'admin' || verdict === 'member') {
        // (d) Never a second account with an existing email: that user could not be linked (rule c refused it).
        if (emailTaken(email)) return fail('account_not_linked');
        if (userCount(db) === 0) {
          // An empty table is first-run setup. Only env-managed OIDC opens it this way (a UI-managed connection can only
          // exist through the setup code, whose session path is above); a member would close setup with no admin.
          if (config.envManaged.oidc && verdict === 'admin') {
            pending.set(email, { kind: 'group', role: 'admin', firstRun: true, at: Date.now() });
            return;
          }
          if (config.envManaged.oidc) return fail('setup_incomplete');
        } else {
          pending.set(email, { kind: 'group', role: verdict, firstRun: false, at: Date.now() });
          newUserSyncs.set(email, seen); // the role is set at creation; the session only remembers the groups
          return;
        }
      }
      return fail('not_invited', rejections.put(email));
    }
    if (typeof user.id !== 'string') return fail('failed');
    // Rule (c) is for the first OIDC sign-in only (a second IdP identity with the same email is never linked), and never
    // into an account whose email a member set themselves (an admin must confirm it first: otherwise a member could
    // pre-claim someone else's future IdP identity).
    if (source.action === 'link-account' && (!config.oidc?.linkByEmail || hasOidcAccount(user.id) || isSelfChangedEmail(db, user.id))) return fail('account_not_linked');
    if (isDisabled(user.id)) return fail('banned_user');
    if (verdict === 'none') return notInGroup();
    syncs.set(user.id, role ? { ...seen, role } : seen);
  };

  async function afterUserCreate(user: { id: string; email: string }, ctx: { path?: string } | null | undefined): Promise<void> {
    if (!isOidcCallback(ctx)) return;
    const email = user.email.toLowerCase();
    const p = pending.get(email);
    pending.delete(email);
    const next = newUserSyncs.get(email);
    newUserSyncs.delete(email);
    // A setup entry has no TTL: promoteFirstAdmin itself decides (no admin yet, and this is the earliest user), so a
    // slow callback still gets the right answer instead of the invite fail-safe below.
    if (p?.kind === 'setup') {
      if (!promoteFirstAdmin(db, user.id)) {
        // Someone else finished setup meanwhile (the password path, or an earlier setup sign-in): no role, disabled.
        log.warn({ userId: user.id }, 'setup: oidc user was not the first user; disabled');
        db.update(schema.user).set({ banned: true, banReason: 'Setup was completed by someone else' }).where(eq(schema.user.id, user.id)).run();
        return;
      }
      deps.setup?.close();
      audit.record({ action: 'settings.changed', actorUserId: user.id, target: { type: 'user', id: user.id }, details: { setting: 'setup', changes: ['first_admin', 'oidc'] } });
      return;
    }
    // First run with an admin group: no TTL either (promoteFirstGroupAdmin decides against the table, like setup). Of
    // two concurrent first sign-ins one becomes the admin; the other stays a member (its groups make it admin at its
    // next sign-in), never disabled.
    if (p?.kind === 'group' && p.firstRun) {
      const first = promoteFirstGroupAdmin(db, user.id);
      if (first) {
        deps.setup?.close();
        audit.record({ action: 'settings.changed', actorUserId: user.id, target: { type: 'user', id: user.id }, details: { setting: 'setup', changes: ['first_admin', 'oidc_group'] } });
      } else {
        log.warn({ userId: user.id }, 'first run: another admin-group sign-in became the first admin; this user is a member until its next sign-in');
        db.insert(schema.userProfile).values({ userId: user.id, createdAt: new Date().toISOString() }).onConflictDoNothing().run();
      }
      audit.record({ action: 'user.provisioned', actorUserId: null, target: { type: 'user', id: user.id }, details: { role: first ? 'admin' : 'member' } });
      if (first && next?.groups) syncs.set(user.id, { groups: next.groups, at: Date.now() });
      return;
    }
    if (!p || Date.now() - p.at > PENDING_TTL_MS || (p.kind === 'invite' && !claimInvite(db, p.inviteId, user.id))) {
      // Not expected (validateUserInfo just decided, and emails are unique): fail safe — no elevated role, the account
      // disabled — and make it visible in the log.
      log.warn({ userId: user.id }, 'oidc user created without a claimable invite or group');
      db.update(schema.user).set({ banned: true, banReason: 'Invite could not be claimed' }).where(eq(schema.user.id, user.id)).run();
      return;
    }
    db.update(schema.user).set({ role: p.role }).where(eq(schema.user.id, user.id)).run();
    if (next) syncs.set(user.id, next); // this user's session (next) applies it
    db.insert(schema.userProfile).values({ userId: user.id, createdAt: new Date().toISOString() }).onConflictDoNothing().run();
    if (p.kind === 'group') {
      audit.record({ action: 'user.provisioned', actorUserId: null, target: { type: 'user', id: user.id }, details: { role: p.role } });
      return;
    }
    audit.record({
      action: 'user.invite_accepted', actorUserId: user.id, target: { type: 'invite', id: p.inviteId }, details: { email, role: p.role, method: 'oidc' },
    });
  }

  async function afterSessionCreate(session: { userId: string; ipAddress?: string | null; userAgent?: string | null }, ctx: { path?: string } | null | undefined): Promise<void> {
    if (!isOidcCallback(ctx)) return;
    const s = syncs.get(session.userId);
    syncs.delete(session.userId);
    const fresh = s !== undefined && Date.now() - s.at <= PENDING_TTL_MS;
    if (fresh && s.role) applySync(session.userId, s.role);
    if (deps.seenGroups) {
      // Only admins' groups are remembered (for the Settings page's group-name check); anyone else's are forgotten.
      const u = db.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, session.userId)).get();
      deps.seenGroups.set(session.userId, u && roleOf(u) === 'admin' && fresh ? s.groups : undefined);
    }
    audit.record({
      action: 'auth.login', actorUserId: session.userId, target: { type: 'user', id: session.userId },
      ip: session.ipAddress ?? null, userAgent: session.userAgent ?? null, details: { method: 'oidc' },
    });
  }

  return { validateUserInfo, afterUserCreate, afterSessionCreate };
}
