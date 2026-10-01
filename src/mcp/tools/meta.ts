import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { adminUrlOf } from '../../sessions/errors.js';
import { ok, runTool, type ToolDeps } from './runtime.js';

/*
 * get_session_status is the one tool Claude calls when another tool says to reconnect, or when the user asks whether
 * ica-hub still reaches their ICA account. Every field comes from `IcaUserSession.status` (keeper.ts): a live web
 * check plus the stored session health, never a token, cookie, personnummer, customerId or account id (R-C12: no
 * hourly probe — the status is always a live check made on demand).
 */
export function registerMetaTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool('get_session_status', {
    description: 'Check whether ica-hub can reach your ICA account: whether one is connected, whether the ICA web and app sessions work, and whether purchase history is available right now (checked live). For the web and app sections, connected = linked; working = checked OK just now. Use it when another ICA tool says to reconnect, or when the user asks whether the ICA connection works. Returns no secrets.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async (_args, ctx) => runTool(deps, ctx, 'get_session_status', async (session) => {
    const adminUrl = adminUrlOf(deps.config.publicUrl);
    return ok({ ...(await session.status(adminUrl)), adminUrl });
  }));
}
