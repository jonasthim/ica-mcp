import { count, eq } from 'drizzle-orm';
import type { ApplyPlan, ApplyResult, AuthHolder } from '../auth/holder.js';
import { OIDC_PROVIDER_ID } from '../auth/constants.js';
import { DEFAULT_OIDC_LABEL, type Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Cipher } from '../crypto.js';
import { schema, type Db } from '../db/index.js';
import { resolveSettings } from './effective.js';
import { adminAccess, guardAdminGroup, guardOidcRemove, guardOidcSave, guardOidcSetupSave, guardSignIn, type GuardReason } from './guards.js';
import { userCount } from '../users/first-admin.js';
import { checkOidcIssuer, normaliseIssuer, type OidcReport } from './oidc-check.js';
import { deleteSetting, readSetting, StoredOidcSchema, writeSetting, type StoredOidc } from './store.js';

export type OidcForm = { issuerUrl: string; clientId: string; clientSecret: string; label: string; linkByEmail: boolean; adminGroup: string; memberGroup: string };
export type FormError = 'oidc_issuer_invalid' | 'oidc_client_id_invalid' | 'oidc_secret_required' | 'oidc_secret_too_long' | 'oidc_label_invalid' | 'oidc_group_invalid';
export type Outcome = { ok: true; changes: string[]; report?: OidcReport } | { ok: false; reason: GuardReason | FormError; report?: OidcReport };
/** `log` receives internal failures by error name only (a message could carry configuration). */
export type SettingsDeps = { db: Db; config: Config; cipher: Cipher; holder: AuthHolder; check?: typeof checkOidcIssuer; log?: Pick<Logger, 'error'> };
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** The issuer as stored: parsed (lowercase host), without credentials, query or fragment, ending in exactly one slash. */
export const storedIssuer = (u: string): string => `${normaliseIssuer(new URL(u).href)}/`;

const MAX: Record<string, [number, FormError]> = {
  issuer_url: [500, 'oidc_issuer_invalid'], client_id: [200, 'oidc_client_id_invalid'], client_secret: [500, 'oidc_secret_too_long'],
  label: [40, 'oidc_label_invalid'], admin_group: [100, 'oidc_group_invalid'], member_group: [100, 'oidc_group_invalid'],
};
/** The first over-long field's error (the secret counted as typed, the rest trimmed): input is refused, never cut short. */
export function oversizedField(body: Record<string, unknown>): FormError | undefined {
  for (const [k, [max, error]] of Object.entries(MAX)) {
    const v = body[k];
    if (typeof v === 'string' && (k === 'client_secret' ? v : v.trim()).length > max) return error;
  }
  return undefined;
}

/** The Single sign-on form. The secret is kept exactly as typed (never trimmed); blank means "keep the stored one". */
export function parseOidcForm(body: Record<string, unknown>): { ok: true; value: OidcForm } | { ok: false; error: FormError } {
  const str = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  const raw = str('issuer_url');
  let u: URL | undefined; try { u = new URL(raw); } catch { /* invalid */ }
  if (!u || raw.length > 500 || u.username || u.password || u.search || u.hash
    || !(u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.test(u.hostname)))) return { ok: false, error: 'oidc_issuer_invalid' };
  const clientId = str('client_id');
  if (!clientId || clientId.length > 200 || /\s/.test(clientId)) return { ok: false, error: 'oidc_client_id_invalid' };
  const clientSecret = typeof body.client_secret === 'string' ? body.client_secret : '';
  if (clientSecret.length > 500) return { ok: false, error: 'oidc_secret_too_long' };
  const label = str('label') || DEFAULT_OIDC_LABEL;
  if (label.length > 40) return { ok: false, error: 'oidc_label_invalid' };
  const adminGroup = str('admin_group');
  const memberGroup = str('member_group');
  if (adminGroup.length > 100 || memberGroup.length > 100) return { ok: false, error: 'oidc_group_invalid' };
  return { ok: true, value: { issuerUrl: storedIssuer(raw), clientId, clientSecret, label, linkByEmail: body.link_by_email === 'on', adminGroup, memberGroup } };
}

/** The names (never the values) of what a save changes, for the audit row. */
const changedKeys = (prev: StoredOidc | undefined, next: StoredOidc, newSecret: boolean): string[] => [
  ...(prev?.issuerUrl !== next.issuerUrl ? ['issuer_url'] : []), ...(prev?.clientId !== next.clientId ? ['client_id'] : []),
  ...(newSecret ? ['client_secret'] : []), ...(prev?.label !== next.label ? ['label'] : []),
  ...(prev?.linkByEmail !== next.linkByEmail ? ['link_by_email'] : []), ...((prev?.adminGroup ?? '') !== (next.adminGroup ?? '') ? ['admin_group'] : []),
  ...((prev?.memberGroup ?? '') !== (next.memberGroup ?? '') ? ['member_group'] : []),
];

/** Thrown inside a setup save's commit when a user appeared during the build: rolls back, nothing is swapped. */
class SetupClosedError extends Error { override name = 'SetupClosedError'; }

/** The error's name only: never its message, which could carry configuration. */
const errName = (err: unknown): string => (err instanceof Error ? err.name : 'unknown');
/**
 * Runs `holder.apply`; a throw (a DB error in the commit, a failing plan or build) is not the provider failing to
 * load: it is `not_saved`, logged by error name. Nothing was committed or swapped (apply guarantees that).
 */
async function applySafely<R extends string>(d: SettingsDeps, plan: () => ApplyPlan<R>): Promise<ApplyResult<R> | { ok: false; reason: 'not_saved' | 'setup_closed' }> {
  try { return await d.holder.apply(plan); } catch (err) {
    if (err instanceof SetupClosedError) return { ok: false, reason: 'setup_closed' };
    d.log?.error({ err: { name: errName(err) } }, 'sign-in settings not saved: internal error');
    return { ok: false, reason: 'not_saved' };
  }
}

const storedOidc = (d: SettingsDeps): StoredOidc | undefined => {
  const row = readSetting(d.db, 'oidc', StoredOidcSchema);
  return row.state === 'ok' ? row.value : undefined;
};
/** The stored secret envelope when it can still be decrypted (a changed master key makes it useless). */
const usableSecret = (d: SettingsDeps, prev: StoredOidc | undefined): string | undefined => {
  if (!prev) return undefined;
  try { d.cipher.decrypt(prev.clientSecretEnc); return prev.clientSecretEnc; } catch { return undefined; }
};

/**
 * Save the single sign-on settings: re-run the connection checks (a previous Test is never trusted), then — inside the
 * AuthHolder's queue, against the state at that moment — apply the lockout guard, build a candidate instance, and
 * only if its provider loaded commit the row (and, for an acknowledged issuer change, delete the stale links) and
 * swap. Warnings (e.g. `jwks: warn:other_host`, keys on another host that the check does not fetch) do not block a
 * save on purpose: the report says so on the page, and Better Auth fetches the keys where discovery points anyway.
 * Env-managed switches keep their stored value (the env value wins in resolveSettings regardless).
 *
 * `setup` (first-run setup only, never the Settings page): the lockout guard protects admins who exist, and during
 * setup nobody exists, so it is replaced by {@link guardOidcSetupSave} — save only while the `user` table is still
 * empty, decided in the same queue. Otherwise a leftover "password sign-in off" row would refuse every SSO-first save.
 */
export async function saveOidc(d: SettingsDeps, form: OidcForm, o: { actorUserId: string | null; unlinkAck: boolean; setup?: boolean }): Promise<Outcome> {
  if (d.config.envManaged.oidc) return { ok: false, reason: 'env_managed' };
  if (!form.clientSecret && !usableSecret(d, storedOidc(d))) return { ok: false, reason: 'oidc_secret_required' };
  // Settings only (setup has no saving admin): never save an admin group the saving admin is known not to be in.
  if (!o.setup && o.actorUserId && !d.config.envManaged.adminGroup) {
    const refused = guardAdminGroup(form.adminGroup || undefined, d.holder.seenGroups.get(o.actorUserId));
    if (refused) return { ok: false, reason: refused };
  }
  const report = await (d.check ?? checkOidcIssuer)(form.issuerUrl, { groups: Boolean(form.adminGroup || form.memberGroup) });
  if (!report.ok) return { ok: false, reason: 'oidc_checks_failed', report };
  const issuerUrl = storedIssuer(form.issuerUrl);
  const secretEnc = form.clientSecret ? d.cipher.encrypt(form.clientSecret) : undefined;
  let decided: { prev: StoredOidc | undefined; next: StoredOidc; unlink: boolean } | undefined;
  const plan = (): ApplyPlan<GuardReason | FormError> => {
    const prev = storedOidc(d);
    const clientSecretEnc = secretEnc ?? usableSecret(d, prev);
    if (!clientSecretEnc) return { refused: 'oidc_secret_required' };
    const adminGroup = d.config.envManaged.adminGroup ? prev?.adminGroup : form.adminGroup || undefined;
    const memberGroup = d.config.envManaged.memberGroup ? prev?.memberGroup : form.memberGroup || undefined;
    const next: StoredOidc = {
      issuerUrl, clientId: form.clientId, clientSecretEnc, label: form.label,
      linkByEmail: d.config.envManaged.linkByEmail ? (prev?.linkByEmail ?? true) : form.linkByEmail,
      ...(adminGroup ? { adminGroup } : {}),
      ...(memberGroup ? { memberGroup } : {}),
    };
    const settings = resolveSettings(d.config, d.db, d.cipher, { oidc: next });
    const issuerChanged = prev !== undefined && normaliseIssuer(prev.issuerUrl) !== normaliseIssuer(next.issuerUrl);
    const credentialsChanged = !prev || issuerChanged || prev.clientId !== next.clientId || secretEnc !== undefined;
    const access = adminAccess(d.db);
    const refused = o.setup ? guardOidcSetupSave(userCount(d.db)) : guardOidcSave(access, {
      localLogin: settings.localLogin, linkByEmail: settings.oidc?.linkByEmail ?? true, issuerChanged, credentialsChanged, unlinkAck: o.unlinkAck,
    });
    if (refused) return { refused };
    const unlink = issuerChanged && access.oidcLinks > 0;
    decided = { prev, next, unlink };
    return {
      settings,
      commit: () => d.db.transaction((tx) => {
        // Setup: re-checked in the commit itself — the build (discovery) ran between the plan's check and here, and the
        // password path may have created the admin meanwhile. Throwing rolls back and the holder does not swap.
        if (o.setup && (tx.select({ n: count() }).from(schema.user).get()?.n ?? 0) > 0) throw new SetupClosedError();
        writeSetting(tx, 'oidc', next, o.actorUserId);
        if (unlink) tx.delete(schema.account).where(eq(schema.account.providerId, OIDC_PROVIDER_ID)).run();
      }, { behavior: 'immediate' }),
    };
  };
  const applied = await applySafely(d, plan);
  if (!applied.ok || !decided) return { ok: false, reason: applied.ok ? 'not_saved' : applied.reason, report };
  return { ok: true, changes: [...changedKeys(decided.prev, decided.next, Boolean(secretEnc)), ...(decided.unlink ? ['unlinked'] : [])], report };
}

/**
 * Remove the UI-managed single sign-on. Existing links are kept: re-adding the same issuer later makes them work again.
 * When password sign-in is only on because it was forced (the stored row still says off, `local_login_forced` in the
 * running snapshot), the stored row is brought in line with reality in the same commit — otherwise removing the only
 * working sign-in method would leave a stored "off" that the next build immediately forces on again, banner and all.
 */
export async function removeOidc(d: SettingsDeps, o: { actorUserId: string }): Promise<Outcome> {
  if (d.config.envManaged.oidc) return { ok: false, reason: 'env_managed' };
  let forced = false;
  const applied = await applySafely(d, (): ApplyPlan<GuardReason> => {
    // Effective password sign-in (the running snapshot): forced on while the stored provider is unusable counts as on.
    const snap = d.holder.snapshot();
    const refused = guardOidcRemove(adminAccess(d.db), snap.config.localLogin);
    if (refused) return { refused };
    forced = snap.settings.problems.includes('local_login_forced');
    // Feed the fixed-up row into the candidate build too, or the freshly swapped snapshot would still show the banner
    // (built from the not-yet-committed stored row) until the next reload.
    const settings = resolveSettings(d.config, d.db, d.cipher, { oidc: null, ...(forced ? { signIn: { localLogin: true } } : {}) });
    return {
      settings,
      commit: () => d.db.transaction((tx) => {
        deleteSetting(tx, 'oidc');
        if (forced) writeSetting(tx, 'sign_in_methods', { localLogin: true }, o.actorUserId);
      }, { behavior: 'immediate' }),
    };
  });
  return applied.ok ? { ok: true, changes: ['removed', ...(forced ? ['local_login'] : [])] } : { ok: false, reason: applied.reason };
}

/** Password login on or off. Off needs single sign-on that works now (loaded) and admins who can use it. */
export async function saveSignIn(d: SettingsDeps, localLogin: boolean, o: { actorUserId: string }): Promise<Outcome> {
  if (d.config.envManaged.localLogin) return { ok: false, reason: 'env_managed' };
  const applied = await applySafely(d, (): ApplyPlan<GuardReason> => {
    const snap = d.holder.snapshot();
    const refused = guardSignIn(adminAccess(d.db), { localLogin, oidcUsable: Boolean(snap.config.oidc), linkByEmail: snap.config.oidc?.linkByEmail ?? false });
    if (refused) return { refused };
    return {
      settings: resolveSettings(d.config, d.db, d.cipher, { signIn: { localLogin } }),
      commit: () => { writeSetting(d.db, 'sign_in_methods', { localLogin }, o.actorUserId); },
    };
  });
  return applied.ok ? { ok: true, changes: ['local_login'] } : { ok: false, reason: applied.reason };
}
