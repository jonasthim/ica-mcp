import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { SessionKeeper } from '../sessions/keeper.js';
import { userIdOf, type ToolCtx } from './context.js';
import { registerCatalogTools } from './tools/catalog.js';
import { registerHandlaTools } from './tools/handla.js';
import { registerHistoryTools } from './tools/history.js';
import { registerListTools } from './tools/lists.js';
import { registerMetaTools } from './tools/meta.js';
import { registerStoreTools } from './tools/stores.js';
import type { ToolDeps } from './tools/runtime.js';

/** `keeper` is the process's one SessionKeeper (`appKeeper(app)`); tools reach ICA only through it. */
export type McpDeps = { config: Config; db: Db; version: string; log: Logger; keeper: SessionKeeper };
export { userIdOf, type ToolCtx } from './context.js';

export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'ica-hub', version: deps.version });
  server.registerTool(
    'ping',
    { description: 'Check that ica-hub is reachable and which user you are signed in as.', inputSchema: z.object({}) },
    async (_args, ctx) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, userId: userIdOf(ctx as ToolCtx), server: 'ica-hub', version: deps.version }) }] }),
  );
  const toolDeps: ToolDeps = { config: deps.config, db: deps.db, keeper: deps.keeper, log: deps.log };
  registerMetaTools(server, toolDeps);
  registerListTools(server, toolDeps);
  registerStoreTools(server, toolDeps);
  registerCatalogTools(server, toolDeps);
  registerHandlaTools(server, toolDeps);
  registerHistoryTools(server, toolDeps);
  return server;
}

/** How much of an error's own message is ever logged; a raw message could otherwise run to the whole request body. */
const MAX_LOGGED_ERROR_MESSAGE = 200;

/**
 * Out-of-band MCP errors (rejected requests, adapter failures) are logged by name and message; never the stack.
 * A `SyntaxError` (the SDK forwards `JSON.parse`'s own thrown error for a malformed body) gets a fixed, safe message
 * instead of its own: V8's message for a bad `JSON.parse` embeds a snippet of the offending text, i.e. the request
 * body, which must never reach the logs. Every other error's message is capped, not trusted to be short.
 */
export const mcpErrorLogger = (log: Pick<Logger, 'warn'>) => (error: Error): void => {
  const message = error.name === 'SyntaxError' ? 'invalid JSON body' : error.message.slice(0, MAX_LOGGED_ERROR_MESSAGE);
  log.warn({ err: { name: error.name, message } }, 'mcp error');
};

/** A fresh McpServer per request (stateless); authInfo flows in from req.auth via the node adapter. */
export function createMcpHttpHandler(deps: McpDeps) {
  return createMcpHandler(() => buildMcpServer(deps), { legacy: 'stateless', onerror: mcpErrorLogger(deps.log) });
}
