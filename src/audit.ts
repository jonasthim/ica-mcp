import type { RequestHandler } from 'express';
import { and, count, desc, eq, gte, lt, or, type SQL } from 'drizzle-orm';
import { schema, type Db } from './db/index.js';
import type { Logger } from './logger.js';

/**
 * Every audited action and the only detail keys it may carry (spec "Audit"). `details_json` never holds secrets or
 * ICA data: keys outside an action's list are rejected by the type and dropped at runtime, values are capped.
 */
export const AUDIT_DETAILS = {
  'auth.login': ['method'], // 'local' | 'oidc'
  'auth.login_failed': ['method', 'reason', 'email'],
  'auth.logout': [],
  'auth.session_revoked': ['scope'], // 'one' | 'others' | 'everywhere'
  'oauth.consent_granted': ['clientName', 'scopes'],
  'oauth.consent_denied': ['clientName'],
  'oauth.client_revoked': ['clientName', 'reason'], // 'user' | 'sign_out_everywhere' | 'user_disabled'
  'user.invited': ['email', 'role', 'renewed'], // renewed: true when a new link replaced the old one
  'user.invite_revoked': ['email'],
  'user.invite_accepted': ['email', 'role', 'method', 'reason'], // reason (failures only): 'rate'
  'user.role_changed': ['from', 'to', 'via'], // via: 'admin' | 'oidc_group'
  'user.provisioned': ['role'], // an OIDC sign-in created the account from its groups (no invite); actor null (system)
  'user.disabled': [],
  'user.enabled': [],
  'user.removed': ['email', 'stage'], // stage: 'intent' (before any change) | 'done' | 'partial' (failed part-way)
  'ica.web_connected': [],
  'ica.app_connected': [],
  'ica.disconnected': ['by', 'mode'], // by: 'self' | 'admin'; mode: 'deleted' | 'unlinked' (a shared account is kept)
  'ica.diagnostics_run': ['live'],
  'ica.identity_refused': ['kind'], // kind: 'web' | 'app'; a BankID login of another ICA person was refused (never the id or its hash)
  'settings.changed': ['setting', 'changes'], // setting: 'name' | 'password' | 'theme' | 'oidc' | 'sign_in_methods' | 'setup'; changes: key names only, never values
  'user.email_changed': ['from', 'to'],
} as const;

export type AuditAction = keyof typeof AUDIT_DETAILS;
export const AUDIT_ACTIONS = Object.keys(AUDIT_DETAILS) as readonly AuditAction[];
type DetailKey<A extends AuditAction> = (typeof AUDIT_DETAILS)[A][number];
/** An action without detail keys takes an empty object only (`Partial<Record<never, …>>` would be `{}`, which accepts anything). */
export type AuditDetails<A extends AuditAction> = [DetailKey<A>] extends [never]
  ? Record<string, never>
  : Partial<Record<DetailKey<A>, string | number | boolean | string[]>>;
export type AuditOutcome = 'success' | 'failure';
export type AuditTargetType = 'user' | 'invite' | 'session' | 'oauth_client' | 'ica_account';
export type AuditInput<A extends AuditAction> = {
  action: A; actorUserId: string | null; target?: { type: AuditTargetType; id: string }; ip?: string | null;
  userAgent?: string | null; outcome?: AuditOutcome; details?: AuditDetails<A>; at?: Date;
};
export type Audit = { record<A extends AuditAction>(e: AuditInput<A>): void };
/** `res.locals.audit`: actor defaults to the session user, IP and user agent come from the request. */
export type BoundAudit = <A extends AuditAction>(
  action: A, o?: Omit<AuditInput<A>, 'action' | 'actorUserId' | 'ip' | 'userAgent'> & { actorUserId?: string | null },
) => void;

const MAX_STR = 200;
const MAX_ITEMS = 20;
const MAX_USER_AGENT = 300;

/** The allow-listed, capped details as JSON: unknown keys and non-scalar values are dropped. */
function sanitize(action: AuditAction, details: Record<string, unknown> | undefined): string {
  const allowed = new Set<string>(AUDIT_DETAILS[action]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details ?? {})) {
    if (!allowed.has(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, MAX_STR);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string').slice(0, MAX_ITEMS).map((x) => x.slice(0, MAX_STR));
  }
  return JSON.stringify(out);
}

/** The audit writer. `record` never throws: a failed write is logged (action and error name only) and the action goes on. */
export function createAudit(db: Db, log: Pick<Logger, 'warn'>): Audit {
  return {
    record(e) {
      try {
        db.insert(schema.auditEvent).values({
          at: (e.at ?? new Date()).toISOString(),
          actorUserId: e.actorUserId,
          action: e.action,
          targetType: e.target?.type ?? null,
          targetId: e.target?.id ?? null,
          ip: e.ip ?? null,
          userAgent: e.userAgent?.slice(0, MAX_USER_AGENT) ?? null,
          // There is no SQL CHECK on outcome: anything but an explicit (or defaulted) success is stored as a failure.
          outcome: e.outcome === undefined || e.outcome === 'success' ? 'success' : 'failure',
          detailsJson: sanitize(e.action, e.details as Record<string, unknown> | undefined),
        }).run();
      } catch (err) {
        log.warn({ action: e.action, err: { name: err instanceof Error ? err.name : 'unknown' } }, 'audit write failed');
      }
    },
  };
}

/** Sets `res.locals.audit` (a {@link BoundAudit}); `req.ip` honours TRUST_PROXY. Mount after `loadSession`. */
export function bindAudit(audit: Audit): RequestHandler {
  return (req, res, next) => {
    const bound: BoundAudit = (action, o = {}) => {
      const session = res.locals.session as { user: { id: string } } | null | undefined;
      const ua = req.headers['user-agent'];
      audit.record({
        ...o,
        action,
        actorUserId: o.actorUserId !== undefined ? o.actorUserId : session?.user.id ?? null,
        ip: req.ip ?? null,
        userAgent: typeof ua === 'string' ? ua.slice(0, MAX_USER_AGENT) : null,
      } as AuditInput<typeof action>);
    };
    res.locals.audit = bound;
    next();
  };
}

export type AuditFilter = {
  actorUserId?: string; action?: AuditAction; involvingUserId?: string;
  /** Inclusive UTC dates (YYYY-MM-DD); a plain UTC day window for callers with no timezone of their own to honour. */
  from?: string; to?: string;
  /**
   * Precise UTC instant boundaries (ISO), for a caller that needs a non-UTC local day window (e.g. the admin
   * Activity page's Stockholm-local `from`/`to`, converted by `admin/time.ts`). Take precedence over `from`/`to`
   * when given. `atFrom` is inclusive, `atTo` exclusive.
   */
  atFrom?: string; atTo?: string;
};
export type AuditRow = {
  id: number; at: string; actorUserId: string | null; action: string; targetType: string | null; targetId: string | null;
  ip: string | null; userAgent: string | null; outcome: AuditOutcome; details: Record<string, unknown>;
};

const DAY_MS = 86_400_000;

/**
 * Newest first. `from`/`to` are inclusive UTC dates (YYYY-MM-DD); `atFrom`/`atTo` are precise UTC instants and win
 * when given. `involvingUserId` matches events the user did or that targeted them (a member's own activity).
 */
export function listAuditEvents(db: Db, f: AuditFilter, page: { limit: number; offset: number }): { rows: AuditRow[]; total: number } {
  const e = schema.auditEvent;
  const where: SQL[] = [];
  if (f.actorUserId) where.push(eq(e.actorUserId, f.actorUserId));
  if (f.action) where.push(eq(e.action, f.action));
  if (f.atFrom) where.push(gte(e.at, f.atFrom));
  else if (f.from) where.push(gte(e.at, `${f.from}T00:00:00.000Z`));
  if (f.atTo) where.push(lt(e.at, f.atTo));
  else if (f.to) where.push(lt(e.at, new Date(Date.parse(`${f.to}T00:00:00.000Z`) + DAY_MS).toISOString()));
  if (f.involvingUserId) where.push(or(eq(e.actorUserId, f.involvingUserId), and(eq(e.targetType, 'user'), eq(e.targetId, f.involvingUserId)))!);
  const cond = where.length ? and(...where) : undefined;
  const total = db.select({ n: count() }).from(e).where(cond).get()?.n ?? 0;
  const rows = db.select().from(e).where(cond).orderBy(desc(e.at), desc(e.id)).limit(page.limit).offset(page.offset).all()
    .map(({ detailsJson, ...r }) => ({ ...r, details: JSON.parse(detailsJson) as Record<string, unknown> }));
  return { rows, total };
}

export const AUDIT_RETENTION_DAYS = 365;

/** Deletes events older than `days` before `now`; returns how many. */
export function pruneAuditEvents(db: Db, now: Date = new Date(), days: number = AUDIT_RETENTION_DAYS): number {
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  return db.delete(schema.auditEvent).where(lt(schema.auditEvent.at, cutoff)).run().changes;
}

/**
 * Prunes now and then every `everyMs` (daily) against `now()`. The timer is unref'd so it never holds the process
 * (or a test run) open; the returned function stops it. A failed prune is logged and retried on the next tick.
 */
export function startAuditPruning(db: Db, log: Pick<Logger, 'info' | 'warn'>, everyMs = DAY_MS, now: () => Date = () => new Date()): () => void {
  const run = () => {
    try {
      const n = pruneAuditEvents(db, now());
      if (n) log.info({ pruned: n }, 'audit retention');
    } catch (err) {
      log.warn({ err: { name: err instanceof Error ? err.name : 'unknown' } }, 'audit prune failed');
    }
  };
  run();
  const h = setInterval(run, everyMs);
  h.unref();
  return () => { clearInterval(h); };
}
