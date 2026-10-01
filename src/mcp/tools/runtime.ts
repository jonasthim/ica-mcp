import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Config } from '../../config.js';
import type { Db } from '../../db/index.js';
import type { Logger } from '../../logger.js';
import type { IcaUserSession, SessionKeeper } from '../../sessions/keeper.js';
import { IcaRejected, IcaUnavailable, sessionErrorText } from '../../sessions/errors.js';
import { userIdOf, type ToolCtx } from '../context.js';

/** Tools reach ICA only through `keeper.forUser` (called by runTool alone), so that is all they are given. */
export type ToolDeps = { config: Config; db: Db; keeper: Pick<SessionKeeper, 'forUser'>; log: Pick<Logger, 'info' | 'warn' | 'error'> };

/** Something about the tool input Claude can fix (unknown list, ambiguous store). Our own words, returned verbatim. */
export class ToolInputError extends Error { constructor(message: string) { super(message); this.name = 'ToolInputError'; } }

/**
 * A write whose outcome is unknown: something failed after the sync or create may have been sent (an ICA outage, a
 * refused or ended app session, the ICA budget on the re-read, anything). runTool reports the inner error as usual
 * and adds `MAYBE_APPLIED`, so Claude checks the list before trying again. The name stays the inner error's, for the
 * tool-call log line.
 */
export class WriteOutcomeUnknown extends Error {
  constructor(readonly inner: unknown) {
    super(inner instanceof Error ? inner.message : 'write outcome unknown');
    this.name = inner instanceof Error ? inner.name : 'unknown';
  }
}
export const MAYBE_APPLIED = 'The change may already have been applied — check with get_shopping_list before trying again.';

export const ok = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
export const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });
const INTERNAL = 'ica-hub hit an internal error; it has been logged for the hub operator. Try again, or check the ICA page in the ica-hub admin.';

/**
 * Every tool call goes through here: resolve the verified hub user, hand `fn` that user's ICA session, turn known
 * errors into actionable messages and anything else into a generic one, and log exactly one line
 * { tool, userId, status, ms, reason?, httpStatus? } (status: 'ok', 'error' for a result with `isError`, else the
 * thrown error's name). `reason` and `httpStatus` are our own codes and numbers — an `IcaUnavailable`'s reason (and
 * HTTP status, when known) or an `IcaRejected`'s HTTP status — never ICA content, and left out otherwise.
 * Tools report bad input by throwing `ToolInputError`, not by returning `fail(...)`. No ICA body, token or error message of unknown origin ever reaches the result or the
 * log.
 *
 * User binding is structural: the session comes from the bearer's user (`userIdOf(ctx)`), never from tool input, and
 * only this function calls `keeper.forUser` (a source-scan test enforces it). `userId` is for non-ICA uses (audit,
 * logs). The order is userId check → forUser (resolves nothing yet) → per call: ICA account (NotLinked) → budget
 * token (RateLimited) → ICA.
 */
export async function runTool(
  deps: ToolDeps, ctx: unknown, tool: string, fn: (session: IcaUserSession, userId: string) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const started = performance.now();
  let userId = 'unknown';
  let status = 'ok';
  let reason: string | undefined;
  let httpStatus: number | undefined;
  try {
    userId = userIdOf(ctx as ToolCtx);
    const result = await fn(deps.keeper.forUser(userId), userId);
    if (result.isError === true) status = 'error'; // a tool's own fail(...) is not an ok call
    return result;
  } catch (e) {
    status = e instanceof Error ? e.name : 'unknown';
    if (e instanceof ToolInputError) return fail(e.message);
    const maybe = e instanceof WriteOutcomeUnknown;
    const err = maybe ? e.inner : e;
    if (err instanceof IcaUnavailable) { reason = err.reason; httpStatus = err.status; } else if (err instanceof IcaRejected) { httpStatus = err.status; }
    const withAdvice = (text: string): string => (maybe ? `${text} ${MAYBE_APPLIED}` : text);
    const text = sessionErrorText(err, deps.config.publicUrl);
    if (text !== undefined) {
      if (err instanceof IcaUnavailable && err.issues.length > 0) deps.log.warn({ tool, issues: err.issues }, 'ica answer did not match the schema');
      return fail(withAdvice(text));
    }
    deps.log.error({ tool, userId, err: { name: status } }, 'tool failed');
    return fail(withAdvice(INTERNAL));
  } finally {
    deps.log.info({ tool, userId, status, ms: Math.round(performance.now() - started), ...(reason !== undefined ? { reason } : {}), ...(httpStatus !== undefined ? { httpStatus } : {}) }, 'tool call');
  }
}
