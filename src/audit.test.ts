import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb, openDb, schema } from './db/index.js';
import { AUDIT_ACTIONS, AUDIT_DETAILS, bindAudit, createAudit, listAuditEvents, pruneAuditEvents, startAuditPruning, type Audit, type BoundAudit } from './audit.js';

const silent = { warn: vi.fn() };

describe('audit', () => {
  it('stores only allow-listed detail keys, capped', () => {
    const db = openDb(':memory:'); const audit = createAudit(db, silent);
    audit.record({ action: 'auth.login_failed', actorUserId: null, outcome: 'failure', ip: '203.0.113.9', details: { method: 'local', reason: 'credentials', email: 'x@example.com', password: 'hunter2', token: 'abc' } as never });
    const row = db.select().from(schema.auditEvent).get()!;
    expect(JSON.parse(row.detailsJson)).toEqual({ method: 'local', reason: 'credentials', email: 'x@example.com' });
    expect(row.detailsJson).not.toContain('hunter2');
    audit.record({ action: 'user.removed', actorUserId: 'a', details: { email: 'e'.repeat(1000) } });
    expect(JSON.parse(db.select().from(schema.auditEvent).all()[1]!.detailsJson).email).toHaveLength(200);
    closeDb(db);
  });

  it('rejects disallowed detail keys and outcomes at the type level, and drops unknown keys and values at runtime', () => {
    const db = openDb(':memory:'); const audit = createAudit(db, silent);
    // @ts-expect-error `password` is not an allow-listed detail of auth.login
    audit.record({ action: 'auth.login', actorUserId: 'u', details: { method: 'local', password: 'hunter2' } });
    // @ts-expect-error `details` of an action with no allowed keys takes none
    audit.record({ action: 'auth.logout', actorUserId: 'u', details: { email: 'x@example.com' } });
    // @ts-expect-error outcome is 'success' | 'failure' only
    audit.record({ action: 'auth.logout', actorUserId: 'u', outcome: 'maybe' });
    audit.record({ action: 'oauth.consent_granted', actorUserId: 'u', details: { clientName: 'c', scopes: ['mcp', 7, ...Array.from({ length: 30 }, (_, i) => `s${i}`)] as never } });
    audit.record({ action: 'ica.diagnostics_run', actorUserId: 'u', details: { live: true, nested: { a: 1 } } as never });
    const rows = db.select().from(schema.auditEvent).all();
    expect(rows.map((r) => JSON.parse(r.detailsJson) as unknown)).toEqual([
      { method: 'local' }, {}, {},
      { clientName: 'c', scopes: ['mcp', ...Array.from({ length: 19 }, (_, i) => `s${i}`)] },
      { live: true },
    ]);
    // an invalid outcome at runtime is stored as a failure, never as free text
    expect(rows[2]!.outcome).toBe('failure');
    closeDb(db);
  });

  it('settings.changed keeps setting and changes (key names) and drops anything else', () => {
    const db = openDb(':memory:'); const a = createAudit(db, { warn: () => undefined });
    a.record({ action: 'settings.changed', actorUserId: null, details: { setting: 'oidc', changes: ['issuer_url', 'client_secret'], secret: 'x' } as never });
    expect(JSON.parse(db.select().from(schema.auditEvent).get()!.detailsJson)).toEqual({ setting: 'oidc', changes: ['issuer_url', 'client_secret'] });
  });
  it('user.email_changed keeps from/to', () => {
    const db = openDb(':memory:'); const a = createAudit(db, { warn: () => undefined });
    a.record({ action: 'user.email_changed', actorUserId: 'u1', target: { type: 'user', id: 'u1' }, details: { from: 'a@x.se', to: 'b@x.se' } });
    expect(JSON.parse(db.select().from(schema.auditEvent).get()!.detailsJson)).toEqual({ from: 'a@x.se', to: 'b@x.se' });
  });
  it('lists every action with an allow-list', () => {
    expect(AUDIT_ACTIONS).toEqual(Object.keys(AUDIT_DETAILS));
    expect(AUDIT_ACTIONS).toHaveLength(22);
    expect(AUDIT_DETAILS['user.provisioned']).toEqual(['role']);
  });

  it('truncates the user agent', () => {
    const db = openDb(':memory:'); const audit = createAudit(db, silent);
    audit.record({ action: 'auth.logout', actorUserId: 'u', userAgent: 'x'.repeat(1000) });
    expect(db.select().from(schema.auditEvent).get()!.userAgent).toHaveLength(300);
    closeDb(db);
  });

  it('never throws: a failing write is logged and swallowed', () => {
    const db = openDb(':memory:'); const log = { warn: vi.fn() };
    const audit = createAudit(db, log);
    closeDb(db);
    expect(() => audit.record({ action: 'auth.logout', actorUserId: 'u' })).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.logout' }), 'audit write failed');
  });

  it('lists newest first with filters, total and paging; members see events they did or that targeted them', () => {
    const db = openDb(':memory:'); const audit = createAudit(db, silent);
    const at = (d: string) => new Date(`2026-09-${d}T10:00:00Z`);
    audit.record({ action: 'auth.login', actorUserId: 'a', details: { method: 'local' }, at: at('01') });
    audit.record({ action: 'user.role_changed', actorUserId: 'a', target: { type: 'user', id: 'b' }, details: { from: 'member', to: 'admin', via: 'admin' }, at: at('02') });
    audit.record({ action: 'auth.login', actorUserId: 'b', details: { method: 'oidc' }, at: at('03') });
    expect(listAuditEvents(db, {}, { limit: 2, offset: 0 })).toMatchObject({ total: 3, rows: [{ actorUserId: 'b' }, { action: 'user.role_changed' }] });
    expect(listAuditEvents(db, { action: 'auth.login' }, { limit: 10, offset: 0 }).total).toBe(2);
    expect(listAuditEvents(db, { actorUserId: 'a', from: '2026-09-02', to: '2026-09-02' }, { limit: 10, offset: 0 }).rows.map((r) => r.action)).toEqual(['user.role_changed']);
    // atFrom/atTo are precise instants and take precedence over from/to when both are given
    expect(listAuditEvents(db, { atFrom: '2026-09-02T10:00:00.000Z', atTo: '2026-09-02T10:00:00.001Z' }, { limit: 10, offset: 0 }).rows.map((r) => r.action)).toEqual(['user.role_changed']);
    expect(listAuditEvents(db, { atFrom: '2026-09-02T10:00:00.001Z', from: '2026-09-02', to: '2026-09-02' }, { limit: 10, offset: 0 }).total).toBe(0);
    expect(listAuditEvents(db, { involvingUserId: 'b' }, { limit: 10, offset: 0 }).rows.map((r) => r.action)).toEqual(['auth.login', 'user.role_changed']);
    expect(listAuditEvents(db, {}, { limit: 2, offset: 2 }).rows.map((r) => r.actorUserId)).toEqual(['a']);
    closeDb(db);
  });

  it('prunes events older than the retention window', () => {
    const db = openDb(':memory:'); const audit = createAudit(db, silent);
    const now = new Date('2026-09-29T00:00:00Z');
    audit.record({ action: 'auth.logout', actorUserId: 'u', at: new Date('2025-09-28T00:00:00Z') });
    audit.record({ action: 'auth.logout', actorUserId: 'u', at: new Date('2026-09-01T00:00:00Z') });
    expect(pruneAuditEvents(db, now)).toBe(1);
    expect(db.select().from(schema.auditEvent).all()).toHaveLength(1);
    closeDb(db);
  });
});

describe('startAuditPruning', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('prunes at once and then every interval against the injected clock, until stopped', () => {
    vi.useFakeTimers();
    const db = openDb(':memory:'); const audit = createAudit(db, silent);
    const log = { info: vi.fn(), warn: vi.fn() };
    let now = new Date('2026-09-29T00:00:00Z');
    audit.record({ action: 'auth.logout', actorUserId: 'u', at: new Date('2025-01-01T00:00:00Z') });
    audit.record({ action: 'auth.logout', actorUserId: 'u', at: new Date('2025-10-15T00:00:00Z') });
    const stop = startAuditPruning(db, log, 1000, () => now);
    expect(db.select().from(schema.auditEvent).all()).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith({ pruned: 1 }, 'audit retention');
    now = new Date('2026-11-01T00:00:00Z');
    vi.advanceTimersByTime(1000);
    expect(db.select().from(schema.auditEvent).all()).toHaveLength(0);
    stop();
    audit.record({ action: 'auth.logout', actorUserId: 'u', at: new Date('2020-01-01T00:00:00Z') });
    vi.advanceTimersByTime(5000);
    expect(db.select().from(schema.auditEvent).all()).toHaveLength(1);
    closeDb(db);
  });

  it('does not keep the process alive, and a failing prune is logged, not thrown', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const db = openDb(':memory:'); closeDb(db);
    const log = { info: vi.fn(), warn: vi.fn() };
    const stop = startAuditPruning(db, log);
    expect(log.warn).toHaveBeenCalledWith({ err: { name: expect.any(String) as unknown } }, 'audit prune failed');
    const handle = spy.mock.results[0]!.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    stop();
  });
});

describe('bindAudit', () => {
  const run = (locals: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const record = vi.fn();
    const res = { locals };
    const next = vi.fn();
    bindAudit({ record } as Audit)({ ip: '198.51.100.7', headers } as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    return { record, audit: res.locals.audit as BoundAudit };
  };

  it('defaults the actor to the session user and takes IP and user agent from the request', () => {
    const { record, audit } = run({ session: { user: { id: 'u1' } } }, { 'user-agent': 'y'.repeat(500) });
    audit('auth.logout');
    expect(record).toHaveBeenCalledWith({ action: 'auth.logout', actorUserId: 'u1', ip: '198.51.100.7', userAgent: 'y'.repeat(300) });
  });

  it('lets the caller name the actor (also null) and passes target, outcome and details through', () => {
    const { record, audit } = run({ session: null });
    audit('auth.login_failed', { actorUserId: null, outcome: 'failure', details: { method: 'local', reason: 'rate' } });
    audit('auth.login', { actorUserId: 'u2', target: { type: 'user', id: 'u2' }, details: { method: 'local' } });
    audit('auth.logout');
    expect(record.mock.calls.map((c) => c[0] as unknown)).toEqual([
      { action: 'auth.login_failed', actorUserId: null, ip: '198.51.100.7', userAgent: null, outcome: 'failure', details: { method: 'local', reason: 'rate' } },
      { action: 'auth.login', actorUserId: 'u2', ip: '198.51.100.7', userAgent: null, target: { type: 'user', id: 'u2' }, details: { method: 'local' } },
      { action: 'auth.logout', actorUserId: null, ip: '198.51.100.7', userAgent: null },
    ]);
  });
});
