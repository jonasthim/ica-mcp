import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '../logger.js';
import { withBearerOutcome, type BearerOutcome, type BearerRejectReason } from '../auth/verifier.js';

/** Longest method/tool name logged (both come from the client). */
const MAX_NAME = 100;
/** A client-supplied name made safe for a log line: only `[\w./:-]` (anything else, e.g. newlines, ESC, U+2028, is `_`), capped. */
export const logSafeName = (s: string): string => s.replace(/[^\w./:-]/g, '_').slice(0, MAX_NAME);

type Rpc = { method?: string; tool?: string };

/** The JSON-RPC method, and the tool name of a `tools/call`, from a parsed body; never arguments. */
function rpcOf(body: unknown): Rpc {
  if (Array.isArray(body)) return { method: 'batch' };
  if (typeof body !== 'object' || body === null) return {};
  const b = body as { method?: unknown; params?: { name?: unknown } };
  const raw = typeof b.method === 'string' ? b.method : undefined;
  const name = raw === 'tools/call' && typeof b.params === 'object' && b.params !== null ? b.params.name : undefined;
  return { ...(raw !== undefined ? { method: logSafeName(raw) } : {}), ...(typeof name === 'string' ? { tool: logSafeName(name) } : {}) };
}

/** The rejection reason for a finished bearer 401/403 the verifier did not name itself. */
function fallbackReason(req: Request, status: number): BearerRejectReason {
  if (status === 403) return 'insufficient_scope';
  return /^bearer\s+\S/i.test(req.headers.authorization ?? '') ? 'invalid_token' : 'missing_token';
}

/**
 * The /mcp request log, in two parts around the route's bearer middleware and body parser.
 *
 * `begin` (first on the route) times the request, runs the rest of the chain with a {@link BearerOutcome} record the
 * verifier fills in, and logs exactly one `{ mcp: 'request', method, tool, http, status, ms }` (info) line: on
 * `finish`, or on `close` with `aborted: true` when the client went away first. A 401/403 — or a
 * verifier-reported key-set outage — also gets `{ mcp: 'rejected', reason, status, clientId?, userId? }` (warn).
 * `started` (after the body parser, so only for authenticated requests) logs the start line with the JSON-RPC method.
 * Nothing here logs a header, token or tool argument.
 */
export function mcpRequestLog(log: Pick<Logger, 'info' | 'warn'>) {
  const RPC = Symbol('mcpRpc');
  type WithRpc = Request & { [RPC]?: Rpc };
  return {
    begin(req: Request, res: Response, next: NextFunction): void {
      const t0 = performance.now();
      const outcome: BearerOutcome = {};
      let logged = false;
      // Exactly one finish line per request: 'finish' when the response was sent, else 'close' (client aborted).
      const done = (): void => {
        if (logged) return;
        logged = true;
        const aborted = !res.writableFinished;
        const status = res.headersSent ? res.statusCode : undefined;
        const rpc = (req as WithRpc)[RPC] ?? {};
        log.info({ mcp: 'request', ...rpc, http: req.method, status, ms: Math.round(performance.now() - t0), ...(aborted ? { aborted: true } : {}) }, 'mcp request finish');
        if (aborted || status === undefined) return;
        const rejected = status === 401 || status === 403;
        if (rejected || outcome.reason === 'jwks_unavailable') {
          const reason = outcome.reason ?? fallbackReason(req, status);
          log.warn({
            mcp: 'rejected', reason, status,
            ...(outcome.clientId ? { clientId: outcome.clientId } : {}), ...(outcome.userId ? { userId: outcome.userId } : {}),
          }, 'mcp request rejected');
        }
      };
      res.on('finish', done);
      res.on('close', done);
      withBearerOutcome(outcome, next);
    },
    started(req: Request, _res: Response, next: NextFunction): void {
      const rpc = rpcOf(req.body);
      (req as WithRpc)[RPC] = rpc;
      log.info({ mcp: 'request', ...rpc, http: req.method }, 'mcp request start');
      next();
    },
  };
}
