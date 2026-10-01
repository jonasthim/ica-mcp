import { Router } from 'express';
import { AUDIT_ACTIONS, listAuditEvents, type AuditAction } from '../audit.js';
import { schema, type Db } from '../db/index.js';
import { s } from './i18n.js';
import { pageCtx } from './page-ctx.js';
import { stockholmDayEndUtc, stockholmDayStartUtc } from './time.js';
import { activityPage, type ActivityView } from './views/index.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_RE = /^\d+$/;
const PAGE_SIZE = 50;

const isAuditAction = (v: string): v is AuditAction => (AUDIT_ACTIONS as readonly string[]).includes(v);
const isDate = (v: string): boolean => DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`));
/** A positive integer page number, strictly digits only (no sign, no decimal, no trailing garbage); anything else
 * (missing, non-numeric, `0`, `-4`, `2abc`, …) defaults to 1. */
const parsePage = (v: string | undefined): number => {
  if (v === undefined || !PAGE_RE.test(v)) return 1;
  const n = Number.parseInt(v, 10);
  return n >= 1 ? n : 1;
};

/**
 * /admin/activity: the audit log, admin-only (mounted behind `requireSession` + `requireAdmin`). Filter values come
 * from the query string and are validated before they ever reach Drizzle: an unknown action, a malformed date, a
 * user id nobody has, or a bogus page number is silently dropped rather than applied or rejected.
 */
export function activityRouter(deps: { db: Db }): Router {
  const { db } = deps;
  const r = Router();

  r.get('/', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    // One query serves both the filter <select> and the per-row actor/target labels below.
    const users = db.select({ id: schema.user.id, name: schema.user.name, email: schema.user.email }).from(schema.user).all();
    const usersById = new Map(users.map((u) => [u.id, u]));
    const userLabel = (u: { name: string; email: string } | undefined): string => (u ? u.name || u.email : s.activity.removedUser);

    const userId = q.user && usersById.has(q.user) ? q.user : undefined;
    const action = q.action && isAuditAction(q.action) ? q.action : undefined;
    const from = q.from && isDate(q.from) ? q.from : undefined;
    const to = q.to && isDate(q.to) ? q.to : undefined;
    const page = parsePage(q.page);

    // The stored `at` is UTC, but the page shows and the household thinks in Stockholm time: `from`/`to` are
    // converted to their Stockholm-local calendar-day boundaries (as UTC instants) before they reach the query.
    const atFrom = from ? stockholmDayStartUtc(from) : undefined;
    const atTo = to ? stockholmDayEndUtc(to) : undefined;
    const { rows, total } = listAuditEvents(db, { actorUserId: userId, action, atFrom, atTo }, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });

    const view: ActivityView = {
      rows: rows.map((row) => ({
        ...row,
        actorLabel: row.actorUserId === null ? s.activity.system : userLabel(usersById.get(row.actorUserId)),
        targetLabel: row.targetType === 'user'
          ? userLabel(row.targetId ? usersById.get(row.targetId) : undefined)
          : row.targetType ? ((s.activity.targets as Record<string, string>)[row.targetType] ?? row.targetType) : '',
      })),
      total, page, pageSize: PAGE_SIZE,
      filter: { ...(userId ? { user: userId } : {}), ...(action ? { action } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) },
      users: users.map((u) => ({ id: u.id, label: u.name || u.email })).sort((a, b) => a.label.localeCompare(b.label)),
    };
    res.type('html').send(activityPage(pageCtx(res), view));
  });

  return r;
}
