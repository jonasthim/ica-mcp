import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IcaUnavailable } from '../../ica/errors.js';
import { IcaRejected, NotLinked, RateLimited } from '../../sessions/errors.js';
import type { IcaUserSession } from '../../sessions/keeper.js';
import { MAYBE_APPLIED, ToolInputError, WriteOutcomeUnknown, fail, ok, runTool, type ToolDeps } from './runtime.js';

const lines: { level: string; obj: Record<string, unknown> }[] = [];
const sink = (level: string) => (obj: object) => { lines.push({ level, obj: obj as Record<string, unknown> }); };
/** The keeper stub records whom forUser was asked for; its sessions never reach ICA. */
const forUserCalls: string[] = [];
const keeper = { forUser: (userId: string): IcaUserSession => { forUserCalls.push(userId); return { userId, app: () => Promise.reject(new Error('no ICA in unit tests')), web: () => Promise.reject(new Error('no ICA in unit tests')), purchases: () => Promise.reject(new Error('no ICA in unit tests')), status: () => Promise.reject(new Error('no ICA in unit tests')), handla: () => Promise.reject(new Error('no ICA in unit tests')) }; } };
const deps = { config: { publicUrl: 'https://ica.example.com' }, db: {}, keeper, log: { info: sink('info'), warn: sink('warn'), error: sink('error') } } as unknown as ToolDeps;
const ctx = { http: { authInfo: { extra: { userId: 'u1' } } } };
const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

describe('runTool', () => {
  it('returns the tool result and logs one line', async () => {
    lines.length = 0;
    const r = await runTool(deps, ctx, 't', async (session, userId) => ok({ userId, sessionUser: session.userId, n: 1 }));
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(text(r))).toEqual({ userId: 'u1', sessionUser: 'u1', n: 1 });
    expect(lines).toEqual([{ level: 'info', obj: { tool: 't', userId: 'u1', status: 'ok', ms: expect.any(Number) } }]);
  });
  it('hands the tool the verified user\'s session: keeper.forUser(userIdOf(ctx)), nobody else', async () => {
    forUserCalls.length = 0;
    let seen: IcaUserSession | undefined;
    await runTool(deps, { http: { authInfo: { extra: { userId: 'u2' } } } }, 't', async (session) => { seen = session; return ok(null); });
    expect(forUserCalls).toEqual(['u2']);
    expect(seen?.userId).toBe('u2');
  });
  it('logs a result the tool itself marked isError as status "error", not ok, and returns it unchanged', async () => {
    lines.length = 0;
    const r = await runTool(deps, ctx, 't', async () => fail('nope'));
    expect(r).toEqual(fail('nope'));
    expect(lines).toEqual([{ level: 'info', obj: { tool: 't', userId: 'u1', status: 'error', ms: expect.any(Number) } }]);
  });
  it('turns session errors into actionable text and input errors into their own words', async () => {
    const r = await runTool(deps, ctx, 't', async () => { throw new NotLinked(); });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('https://ica.example.com/admin/ica');
    expect(text(await runTool(deps, ctx, 't', async () => { throw new ToolInputError('No list called "x".'); }))).toBe('No list called "x".');
  });
  it('a write whose outcome is unknown gets the inner error\'s text plus the "check first" advice, logged under the inner name', async () => {
    lines.length = 0;
    const r = await runTool(deps, ctx, 't', async () => { throw new WriteOutcomeUnknown(new IcaUnavailable('server-error', 502)); });
    expect(text(r)).toBe(`ICA's servers answered with an error (HTTP 502). Try again later. ${MAYBE_APPLIED}`);
    expect(lines.at(-1)!.obj).toMatchObject({ status: 'IcaUnavailable' });
    expect(text(await runTool(deps, ctx, 't', async () => { throw new IcaUnavailable('server-error', 502); }))).not.toContain(MAYBE_APPLIED);
    const internal = await runTool(deps, ctx, 't', async () => { throw new WriteOutcomeUnknown(new Error('secret detail')); });
    expect(text(internal)).toContain('internal error');
    expect(text(internal)).toContain(MAYBE_APPLIED);
    expect(text(internal)).not.toContain('secret detail');
  });
  it('never returns or logs the message of an unknown error', async () => {
    lines.length = 0;
    const r = await runTool(deps, ctx, 't', async () => { throw new Error('ICA said: personnummer 199001011234'); });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain('199001011234');
    expect(JSON.stringify(lines)).not.toContain('199001011234');
    expect(lines.find((l) => l.level === 'error')?.obj).toEqual({ tool: 't', userId: 'u1', err: { name: 'Error' } });
  });
  it('logs schema-mismatch paths for the operator, not values', async () => {
    lines.length = 0;
    const r = await runTool(deps, ctx, 't', async () => { throw new IcaUnavailable('unexpected-response', undefined, ['offers.0.name: invalid_type']); });
    expect(text(r)).toContain('does not understand');
    expect(lines.find((l) => l.level === 'warn')?.obj).toEqual({ tool: 't', issues: ['offers.0.name: invalid_type'] });
  });
  it('fails closed without a verified user', async () => {
    const r = await runTool(deps, {}, 't', async () => ok('never'));
    expect(r.isError).toBe(true);
  });

  it('without a verified user neither forUser nor fn runs, and the failure is logged by name only', async () => {
    lines.length = 0; forUserCalls.length = 0;
    let ran = false;
    const r = await runTool(deps, { http: { authInfo: { extra: { userId: '' } } } }, 't', async () => { ran = true; return ok(null); });
    expect(ran).toBe(false);
    expect(forUserCalls).toEqual([]);
    expect(text(r)).toContain('internal error');
    expect(lines.map((l) => l.obj)).toEqual([
      { tool: 't', userId: 'unknown', err: { name: 'Error' } },
      { tool: 't', userId: 'unknown', status: 'Error', ms: expect.any(Number) },
    ]);
  });
  it('a rate limit tells Claude when to retry and is logged as its error name', async () => {
    lines.length = 0;
    const r = await runTool(deps, ctx, 't', async () => { throw new RateLimited(7); });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/7/);
    expect(lines).toEqual([{ level: 'info', obj: { tool: 't', userId: 'u1', status: 'RateLimited', ms: expect.any(Number) } }]);
  });
  it('an IcaUnavailable without issues logs no warn line', async () => {
    lines.length = 0;
    await runTool(deps, ctx, 't', async () => { throw new IcaUnavailable('network'); });
    expect(lines.map((l) => l.level)).toEqual(['info']);
  });
  it('logs the IcaUnavailable reason and HTTP status (when known), so the operator can tell a 202-not-ready from a 429 or a 5xx', async () => {
    lines.length = 0;
    await runTool(deps, ctx, 't', async () => { throw new IcaUnavailable('not-ready'); });
    await runTool(deps, ctx, 't', async () => { throw new IcaUnavailable('rate-limited', 429); });
    await runTool(deps, ctx, 't', async () => { throw new IcaUnavailable('server-error', 503); });
    expect(lines.map((l) => l.obj)).toEqual([
      { tool: 't', userId: 'u1', status: 'IcaUnavailable', ms: expect.any(Number), reason: 'not-ready' },
      { tool: 't', userId: 'u1', status: 'IcaUnavailable', ms: expect.any(Number), reason: 'rate-limited', httpStatus: 429 },
      { tool: 't', userId: 'u1', status: 'IcaUnavailable', ms: expect.any(Number), reason: 'server-error', httpStatus: 503 },
    ]);
  });
  it('logs an IcaRejected\'s HTTP status, with no reason (it has none) and nothing from the ICA body', async () => {
    lines.length = 0;
    await runTool(deps, ctx, 't', async () => { throw new IcaRejected(404); });
    expect(lines).toEqual([{ level: 'info', obj: { tool: 't', userId: 'u1', status: 'IcaRejected', ms: expect.any(Number), httpStatus: 404 } }]);
  });
  it('an error result carries neither the stack nor the thrown value', async () => {
    const secret = 'Bearer APP-ACCESS-TOKEN-SECRET-7a8b';
    for (const thrown of [new TypeError(secret), secret, { token: secret }]) {
      const r = await runTool(deps, ctx, 't', async () => { throw thrown; });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).not.toContain('APP-ACCESS-TOKEN');
      expect(JSON.stringify(r)).not.toMatch(/at .*\.ts:\d+/);
    }
  });
});

describe('user binding is structural', () => {
  const SRC = fileURLToPath(new URL('../..', import.meta.url));
  const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? sources(join(dir, d.name)) : d.name.endsWith('.ts') && !d.name.endsWith('.test.ts') ? [join(dir, d.name)] : []);

  it('only runTool asks the keeper for a user session (tools get it handed in; no tool input picks the user)', () => {
    const callers = sources(SRC).filter((f) => readFileSync(f, 'utf8').includes('forUser(')).map((f) => relative(SRC, f)).sort();
    expect(callers).toEqual(['mcp/tools/runtime.ts', 'sessions/keeper.ts']);
  });
});
