import { Router, type Response } from 'express';
import { eq } from 'drizzle-orm';
import type { AuthSnapshot } from '../auth/holder.js';
import { OIDC_PROVIDER_ID } from '../auth/constants.js';
import type { BoundAudit } from '../audit.js';
import { DEFAULT_OIDC_LABEL, type Config } from '../config.js';
import type { Cipher } from '../crypto.js';
import { schema, type Db } from '../db/index.js';
import type { Logger } from '../logger.js';
import { adminAccess, type AdminAccess } from '../settings/guards.js';
import { checkOidcIssuer, type OidcReport } from '../settings/oidc-check.js';
import { oversizedField, parseOidcForm, removeOidc, saveOidc, saveSignIn, type SettingsDeps } from '../settings/service.js';
import { readSetting, StoredOidcSchema, StoredSignInSchema, type ReadResult, type StoredOidc } from '../settings/store.js';
import type { FlashCode, SeeOther } from './flash.js';
import { pageCtx } from './page-ctx.js';
import { createLoginLimiter } from './rate-limit.js';
import type { AdminSession } from './session.js';
import { settingsConfirmPage, settingsPage, type GroupsSeenView, type OidcFieldsView, type SettingsView } from './views/index.js';

const BACK = '/admin/settings';
const RESULT_MS = 10 * 60_000;
/** Test connection, Save and Reload each fetch the issuer: at most this many per admin in 10 minutes. */
export const SETTINGS_FETCH_LIMIT = 30;
/**
 * The form as typed, for showing it again after a redirect. Never the client secret: only whether one was typed, so
 * the page can ask for it again (it is not kept, and a blank Save would keep the stored one).
 */
type Draft = Omit<OidcFieldsView, 'secret'>;
type LastResult = { at: number; issuerUrl: string; report: OidcReport; draft: Draft };

/** A field as posted (trimmed). Lengths are checked before (`oversizedField`): nothing is cut short here. */
const str = (body: Record<string, unknown>, k: string): string => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
/** The posted form minus the secret's value. */
export const draftOf = (body: Record<string, unknown>): Draft => ({
  issuerUrl: str(body, 'issuer_url'), clientId: str(body, 'client_id'), label: str(body, 'label') || DEFAULT_OIDC_LABEL,
  linkByEmail: body.link_by_email === 'on', adminGroup: str(body, 'admin_group'), memberGroup: str(body, 'member_group'),
  secretTyped: typeof body.client_secret === 'string' && body.client_secret.length > 0,
});

/**
 * A POST that carries a field the environment decides (the page never renders one as an input): refused, never
 * silently applied. Shared by Settings and the setup wizard.
 */
export const envManagedPost = (env: Config['envManaged'], body: Record<string, unknown>): boolean => env.oidc
  || (env.linkByEmail && 'link_by_email' in body) || (env.adminGroup && 'admin_group' in body) || (env.memberGroup && 'member_group' in body);

/** What the page needs to know about the stored rows, besides the running snapshot. */
export type StoredView = {
  oidc: ReadResult<StoredOidc>; oidcUpdatedAt?: number;
  /** The stored secret decrypts with the current master key. */
  secretReadable: boolean;
  localLogin?: boolean;
};
export function storedView(db: Db, cipher: Cipher): StoredView {
  const oidc = readSetting(db, 'oidc', StoredOidcSchema);
  const at = db.select({ u: schema.appSetting.updatedAt }).from(schema.appSetting).where(eq(schema.appSetting.key, 'oidc')).get()?.u;
  let secretReadable = false;
  if (oidc.state === 'ok') { try { cipher.decrypt(oidc.value.clientSecretEnc); secretReadable = true; } catch { /* unreadable */ } }
  const signIn = readSetting(db, 'sign_in_methods', StoredSignInSchema);
  return { oidc, ...(at ? { oidcUpdatedAt: Date.parse(at) } : {}), secretReadable, ...(signIn.state === 'ok' ? { localLogin: signIn.value.localLogin } : {}) };
}
/** A test result is stale once the stored single sign-on changed after it (another admin saved): its draft would revert that. */
export const isStale = (last: LastResult, stored: StoredView): boolean => stored.oidcUpdatedAt !== undefined && stored.oidcUpdatedAt > last.at;

/**
 * Which configured group names the viewing admin's latest OIDC sign-in carried: `sent` per name (absent from a known
 * set is "not sent", whatever the prefix), `undefined` when the groups are unknown. Omitted when no group is configured.
 */
function groupsSeenView(f: OidcFieldsView, seen: readonly string[] | undefined, label: string): GroupsSeenView | undefined {
  const names = [f.adminGroup, f.memberGroup].filter(Boolean);
  if (!names.length) return undefined;
  return {
    label, known: Boolean(seen),
    configured: names.map((name) => ({ name, ...(seen ? { sent: seen.includes(name) } : {}) })),
  };
}

/** The Settings page's view from the running snapshot, the stored rows, the last test and the admins' sign-in methods. */
export function buildSettingsView(
  config: Config, snap: AuthSnapshot, stored: StoredView, last: LastResult | undefined, access: AdminAccess,
  /** Settings only: the groups the viewing admin's latest OIDC sign-in sent (`undefined`: unknown). */
  viewer?: { seenGroups: readonly string[] | undefined },
): SettingsView {
  const env = config.envManaged;
  const switchesEnv = { linkByEmail: env.linkByEmail, adminGroup: env.adminGroup, memberGroup: env.memberGroup };
  const sw = config.oidcSwitches;
  let fields: OidcFieldsView;
  if (env.oidc) {
    const o = snap.settings.oidc;
    fields = { issuerUrl: o?.issuerUrl ?? '', clientId: o?.clientId ?? '', label: o?.label ?? '', linkByEmail: o?.linkByEmail ?? true, adminGroup: o?.adminGroup ?? '', memberGroup: o?.memberGroup ?? '', secret: 'stored' };
  } else {
    const row = stored.oidc.state === 'ok' ? stored.oidc.value : undefined;
    const base: Draft = last?.draft ?? {
      issuerUrl: row?.issuerUrl ?? '', clientId: row?.clientId ?? '', label: row?.label ?? DEFAULT_OIDC_LABEL,
      linkByEmail: row?.linkByEmail ?? true, adminGroup: row?.adminGroup ?? '', memberGroup: row?.memberGroup ?? '',
    };
    // An env-managed switch shows the value in force, whatever was posted or stored.
    fields = {
      ...base, secret: stored.secretReadable ? 'stored' : row ? 'unreadable' : 'none',
      ...(env.linkByEmail ? { linkByEmail: sw.linkByEmail ?? base.linkByEmail } : {}),
      ...(env.adminGroup ? { adminGroup: sw.adminGroup ?? '' } : {}),
      ...(env.memberGroup ? { memberGroup: sw.memberGroup ?? '' } : {}),
    };
  }
  return {
    problems: snap.settings.problems,
    callbackUrl: `${config.publicUrl}/auth/callback/${OIDC_PROVIDER_ID}`,
    oidc: {
      managed: env.oidc ? 'env' : 'ui', fields, switchesEnv, active: Boolean(snap.config.oidc),
      configured: env.oidc || stored.oidc.state !== 'absent', hasLinks: access.oidcLinks > 0,
    },
    ...(last ? { check: { issuerUrl: last.issuerUrl, ok: last.report.ok, rows: last.report.checks } } : {}),
    ...(viewer ? { groupsSeen: groupsSeenView(fields, viewer.seenGroups, snap.config.oidc?.label ?? snap.settings.oidc?.label ?? DEFAULT_OIDC_LABEL) } : {}),
    signIn: {
      managed: env.localLogin ? 'env' : 'ui', localLogin: env.localLogin ? config.localLogin : stored.localLogin ?? snap.settings.localLogin,
      activeAdmins: access.activeAdmins, adminsWithOidc: access.adminsWithOidc,
    },
  };
}

/**
 * /admin/settings (mounted behind requireSession + requireAdmin, and the admin router's same-origin and CSRF checks).
 * PRG throughout. The last connection test per admin session is kept in memory for 10 minutes, so the page can show
 * it (and the form as typed) after the redirect — never the secret. Test connection and Save fetch the issuer the
 * admin typed with no private-address filter (household IdPs are private): admin-only access is that boundary, and
 * both are rate-limited per admin. Only fixed codes and key names reach flashes, logs and the audit log.
 */
export function settingsRouter(deps: SettingsDeps & { log: Pick<Logger, 'warn' | 'error'>; fetchLimit?: number }): Router {
  const r = Router();
  const limiter = createLoginLimiter({ max: deps.fetchLimit ?? SETTINGS_FETCH_LIMIT, windowMs: 10 * 60_000 });
  const results = new Map<string, LastResult>();
  const session = (res: Response): AdminSession => res.locals.session as AdminSession;
  const see = (res: Response): SeeOther => res.locals.seeOther as SeeOther;
  const audit = (res: Response): BoundAudit => res.locals.audit as BoundAudit;
  const prune = (): void => { for (const [k, v] of results) if (Date.now() - v.at > RESULT_MS) results.delete(k); };
  const remember = (res: Response, issuerUrl: string, report: OidcReport, draft: Draft): void => {
    prune(); results.set(session(res).session.id, { at: Date.now(), issuerUrl, report, draft });
  };
  /** Outbound fetches (test, save, reload) per admin: false means the flash was sent. */
  const allowed = (res: Response): boolean => {
    if (limiter.attempt([`settings:${session(res).user.id}`]).ok) return true;
    see(res)(res, `${BACK}#sso`, { kind: 'error', code: 'settings_rate' });
    return false;
  };

  r.get('/', (_req, res) => {
    prune();
    const { db, config } = deps;
    const stored = storedView(db, deps.cipher);
    const key = session(res).session.id;
    let last = results.get(key);
    // Another admin saved after this test: showing its draft would silently revert their change on the next Save.
    if (last && isStale(last, stored)) { results.delete(key); last = undefined; }
    const view = buildSettingsView(config, deps.holder.snapshot(), stored, last, adminAccess(db), { seenGroups: deps.holder.seenGroups.get(session(res).user.id) });
    res.set('Cache-Control', 'no-store').type('html').send(settingsPage(pageCtx(res), view));
  });

  r.post('/oidc/test', async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const tooLong = oversizedField(body);
    if (tooLong) { see(res)(res, `${BACK}#sso`, { kind: 'error', code: `settings_${tooLong}` }); return; }
    if (!allowed(res)) return;
    const draft = draftOf(body);
    // Always the default timeout: the page's "no answer within N seconds" is built from it.
    const report = await (deps.check ?? checkOidcIssuer)(draft.issuerUrl, { groups: Boolean(draft.adminGroup || draft.memberGroup) });
    remember(res, draft.issuerUrl, report, draft);
    see(res)(res, `${BACK}#sso`);
  });

  r.post('/oidc', async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const refuse = (code: FlashCode, reason: string): void => {
      audit(res)('settings.changed', { outcome: 'failure', details: { setting: 'oidc', changes: [reason] } });
      see(res)(res, `${BACK}#sso`, { kind: 'error', code });
    };
    // An env-managed switch is never an input on the page: a POST that carries one is refused, not silently applied.
    if (envManagedPost(deps.config.envManaged, body)) { refuse('settings_env_managed', 'env_managed'); return; }
    const parsed = parseOidcForm(body);
    if (!parsed.ok) { see(res)(res, `${BACK}#sso`, { kind: 'error', code: `settings_${parsed.error}` }); return; }
    if (!allowed(res)) return;
    const out = await saveOidc(deps, parsed.value, { actorUserId: session(res).user.id, unlinkAck: body.unlink_ack === 'on' });
    // A secret typed into a Save that went through is stored: no need to ask for it again.
    if (out.report) remember(res, parsed.value.issuerUrl, out.report, { ...draftOf(body), issuerUrl: parsed.value.issuerUrl, ...(out.ok ? { secretTyped: false } : {}) });
    if (!out.ok) {
      if (out.reason !== 'oidc_checks_failed') deps.log.warn({ reason: out.reason }, 'single sign-on settings not saved');
      refuse(`settings_${out.reason}`, out.reason); return;
    }
    audit(res)('settings.changed', { details: { setting: 'oidc', changes: out.changes } });
    see(res)(res, BACK, { kind: 'success', code: 'settings_saved' });
  });

  r.post('/oidc/remove', async (req, res) => {
    // Without JS the dialog never ran: ask on a page first (the dialog adds confirm=yes).
    if ((req.body as Record<string, unknown>).confirm !== 'yes') {
      res.set('Cache-Control', 'no-store').type('html').send(settingsConfirmPage(pageCtx(res))); return;
    }
    const out = await removeOidc(deps, { actorUserId: session(res).user.id });
    if (!out.ok) {
      audit(res)('settings.changed', { outcome: 'failure', details: { setting: 'oidc', changes: [out.reason] } });
      see(res)(res, BACK, { kind: 'error', code: `settings_${out.reason}` }); return;
    }
    results.delete(session(res).session.id);
    audit(res)('settings.changed', { details: { setting: 'oidc', changes: out.changes } });
    see(res)(res, BACK, { kind: 'success', code: 'settings_removed' });
  });

  r.post('/sign-in', async (req, res) => {
    const out = await saveSignIn(deps, (req.body as Record<string, unknown>).local_login === 'on', { actorUserId: session(res).user.id });
    if (!out.ok) {
      audit(res)('settings.changed', { outcome: 'failure', details: { setting: 'sign_in_methods', changes: [out.reason] } });
      see(res)(res, BACK, { kind: 'error', code: `settings_${out.reason}` }); return;
    }
    audit(res)('settings.changed', { details: { setting: 'sign_in_methods', changes: out.changes } });
    see(res)(res, BACK, { kind: 'success', code: 'settings_sign_in_saved' });
  });

  r.post('/reload', async (_req, res) => {
    if (!allowed(res)) return;
    await deps.holder.reload();
    see(res)(res, BACK, { kind: 'info', code: 'settings_reloaded' });
  });
  return r;
}
