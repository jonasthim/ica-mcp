// Used only by `pnpm auth:generate` (Better Auth CLI); the app builds its own instance in src/auth/index.ts.
import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { createAuth } from './index.js';
const config = loadConfig({ ICA_HUB_URL: 'http://127.0.0.1:3000', ICA_HUB_MASTER_KEY: Buffer.alloc(32).toString('base64'), ICA_HUB_AUTH_SECRET: 'x'.repeat(32), DATABASE_PATH: ':memory:', ...process.env });
export const auth = createAuth(config, openDb(':memory:'));
// The CLI only reads `auth.options`. Plugin init (oauth-provider resource seeding) runs eagerly and rejects while
// the Drizzle schema has no auth tables yet (first generation / new plugin models); that must not crash the CLI.
auth.$context.catch((err: unknown) => { console.warn(`[auth:generate] ignoring auth init error: ${err instanceof Error ? err.message : String(err)}`); });
