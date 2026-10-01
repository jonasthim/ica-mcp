import { readFileSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { ensureBootstrapAdmin } from './auth/index.js';
import { AUTH_INIT_TIMEOUT_MS, createAuthHolder } from './auth/holder.js';
import { createMcpKeySet, holderJwksSource } from './auth/verifier.js';
import { ensureProfiles } from './users/first-admin.js';
import { createCipher } from './crypto.js';
import { createOidcRejections } from './auth/oidc-policy.js';
import { appKeeper, createApp } from './server.js';
import { createLogger } from './logger.js';
import { createAudit, startAuditPruning } from './audit.js';
import { createSetup } from './setup/state.js';
import { startAppUpkeep } from './sessions/upkeep.js';
import { createShutdown } from './shutdown.js';

const config = loadConfig(process.env);
const log = createLogger(config.logLevel);
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const db = openDb(config.databasePath);
const audit = createAudit(db, log);
const oidcRejections = createOidcRejections();
const cipher = createCipher(config.masterKey);
const setup = createSetup({ db, config, log });
const holder = await createAuthHolder({ config, db, cipher, audit, oidcRejections, log, setup });
const boot = holder.snapshot();
await ensureBootstrapAdmin(boot.auth, db, boot.config, boot.settings.oidc);
ensureProfiles(db);
// While no user exists (no env bootstrap admin either): log the one-time setup code for /admin/setup.
setup.announce();
const stopAuditPruning = startAuditPruning(db, log);
// The /mcp token key set, loaded once before listening: adds at most AUTH_INIT_TIMEOUT_MS (5 s) on top of the holder
// init. A failure or timeout is logged, never fatal; the first /mcp request retries the load.
const mcpKeys = createMcpKeySet(holderJwksSource(holder), log);
await mcpKeys.warm(AUTH_INIT_TIMEOUT_MS);
const app = createApp({ config, db, auth: holder, cipher, audit, version, oidcRejections, setup, mcpKeys });
// createApp owns the process's one SessionKeeper. Anything else that needs ICA credentials (the upkeep job) takes it
// with appKeeper(app): a second keeper would have its own in-flight map and break the single-flight refresh.
// The app-token upkeep (every connected app session about every 10 minutes, like the ICA app; ICA_HUB_APP_UPKEEP).
const keeper = appKeeper(app);
const stopUpkeep = startAppUpkeep({ db, keeper, log, mode: config.appUpkeep });
const server = app.listen(config.port, config.host, () => log.info({ url: config.publicUrl, port: config.port, version }, 'ica-hub listening'));
// SIGINT/SIGTERM: close HTTP, drain the upkeep and the keeper's in-flight refreshes (a rotated refresh token must reach
// the database), close the database; bounded at 20 s. A second signal exits at once.
const shutdown = createShutdown({ server, stopUpkeep, keeper, db, log, stopTimers: [stopAuditPruning] });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => shutdown(sig));
