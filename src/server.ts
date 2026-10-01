import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { requireBearerAuth, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/express';
import { toNodeHandler as mcpToNode } from '@modelcontextprotocol/node';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { CLIENT_IP_HEADER } from './auth/index.js';
import type { AuthHolder } from './auth/holder.js';
import type { Cipher } from './crypto.js';
import { createVerifier, checkJwksReachable, createMcpKeySet, holderJwksSource, type McpKeySet } from './auth/verifier.js';
import { mcpRequestLog } from './mcp/request-log.js';
import { createMcpHttpHandler, mcpErrorLogger } from './mcp/server.js';
import { createLogger, type Logger } from './logger.js';
import { adminRouter } from './admin/router.js';
import { publicAuthSurface } from './auth/public-surface.js';
import { securityHeaders } from './admin/security-headers.js';
import { loadAssets, type AssetManifest } from './admin/assets.js';
import { errorPage } from './admin/views/index.js';
import { pageCtx } from './admin/page-ctx.js';
import { createMetrics } from './metrics.js';
import { registerSessionMetrics } from './sessions/metrics.js';
import { DEFAULT_ICA_ENDPOINTS, type IcaEndpoints } from './ica/endpoints.js';
import { createSessionKeeper, type SessionKeeper } from './sessions/keeper.js';
import { createTokenBucket } from './sessions/rate-limit.js';
import type { Audit } from './audit.js';
import type { OidcRejections } from './auth/oidc-policy.js';
import type { Setup } from './setup/state.js';

/**
 * `icaEndpoints` defaults to the real ICA hosts; tests point it at a local fake. `assets` defaults to the hashed
 * manifest over `src|dist/admin/assets/`; tests may inject one over a temp folder. `audit` records security events.
 * `oidcRejections` is the instance `createAuth` got, so the sign-in page can name the email of a refused OIDC sign-in.
 * `auth` is the AuthHolder: every consumer reads the Better Auth instance from it per request, never at mount time.
 * `cipher` is `createCipher(config.masterKey)`. `config` is the environment's config (public URL, host, proxy); the
 * sign-in settings in force (OIDC, password login) are `auth.snapshot().config`. `setup` is the first-run setup state
 * (open only while no user exists).
 */
export type AppDeps = {
  config: Config; db: Db; auth: AuthHolder; cipher: Cipher; audit: Audit; version?: string; icaEndpoints?: IcaEndpoints;
  assets?: AssetManifest; oidcRejections: OidcRejections; setup: Setup;
  /** The app's logger; defaults to `createLogger(config.logLevel)` (tests hand in a capturing one). */
  log?: Logger;
  /** Settings' Test connection / Save / Reload per admin in 10 minutes (default SETTINGS_FETCH_LIMIT); tests raise it. */
  settingsFetchLimit?: number;
  /** The process-wide ICA session keeper (src/index.ts creates it for the upkeep job); created here when absent. */
  keeper?: SessionKeeper;
  /**
   * Per-user ICA call budget (default 60 at once, 1 per second); tests tighten it. Used when createApp creates the
   * keeper; an injected keeper brings its own limiter (default 60/min).
   */
  icaRateLimit?: { capacity: number; refillPerSecond: number };
  /**
   * The /mcp token key set (src/index.ts creates and warms it before listening, adding at most 5 s on top of the
   * holder init); created here from `auth` when absent,
   * then loaded on the first /mcp request.
   */
  mcpKeys?: McpKeySet;
  /** Handla's 202-poll waits, when createApp creates the keeper (default real timers); tests inject an instant one. */
  handlaSleep?: (ms: number) => Promise<void>;
};

function allowedHost(config: Config) {
  const expected = new URL(config.publicUrl).host;
  return (req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host ?? '';
    if (host !== expected) { res.status(421).json({ error: 'misdirected_request', expected }); return; }
    next();
  };
}

/**
 * Better Auth's node adapter (better-call) builds the URL it routes on from `X-Forwarded-Proto` / `:authority` / `Host`
 * plus `req.url`, all client-controlled: a Host like `h/auth/sign-in/email#` would route an allow-listed path to any
 * endpoint. So right before the handoff, after the allow-list check, the URL-building headers are pinned to the public
 * URL. Runs after the client-IP middleware and never touches X-Forwarded-For, so `req.ip`/TRUST_PROXY are unaffected.
 */
function pinPublicOrigin(config: Config) {
  const u = new URL(config.publicUrl);
  const proto = u.protocol.slice(0, -1);
  return (req: Request, _res: Response, next: NextFunction) => {
    req.headers.host = u.host;
    req.headers['x-forwarded-proto'] = proto;
    delete req.headers['x-forwarded-host'];
    delete req.headers[':authority'];
    next();
  };
}

/** The 4xx status carried by an error (body-parser/http-errors set `status`/`statusCode` and `expose`), if any. */
function clientErrorStatus(err: Error): number | undefined {
  const e = err as Error & { status?: unknown; statusCode?: unknown };
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : undefined;
  return status !== undefined && status >= 400 && status < 500 ? status : undefined;
}

/**
 * A bounded metrics label for a request's route: never the raw request path, which is attacker-controlled on a
 * public host (scanner probes like `/wp-login.php` would otherwise each mint a new `ica_hub_http_requests_total`
 * label, i.e. unbounded cardinality). A matched Express route reports its own pattern, prefixed by `baseUrl` so
 * admin routes read `/admin/login` rather than `/login`. The two wildcard-mounted subtrees (Better Auth's OAuth
 * surface) collapse to one label per subtree rather than their literal `/auth/*splat` pattern, since the whole
 * point is not distinguishing every path under them. Anything else reaches the catch-all 404 below, which is a
 * plain middleware (no Express `Route`, so `req.route` is never set) and collapses to `unmatched`.
 */
function routeLabel(req: Request): string {
  if (req.path.startsWith('/auth/')) return '/auth/*';
  if (req.path.startsWith('/.well-known/')) return '/.well-known/*';
  if (req.route?.path) return `${req.baseUrl}${req.route.path}`;
  return 'unmatched';
}

const isAdminPath = (req: Request): boolean => req.path === '/admin' || req.path.startsWith('/admin/');

/** The process's one SessionKeeper: the instance createApp's routes use (injected via `deps.keeper` or created there). */
export function appKeeper(app: Express): SessionKeeper {
  return app.locals.keeper as SessionKeeper;
}

export function createApp(deps: AppDeps): Express {
  const { config } = deps;
  const log = deps.log ?? createLogger(config.logLevel);
  const version = deps.version ?? '0.0.0';
  const metrics = createMetrics(version);
  registerSessionMetrics(metrics.registry, deps.db, { appUpkeep: deps.config.appUpkeep });
  const keeper = deps.keeper ?? createSessionKeeper({ db: deps.db, cipher: deps.cipher, endpoints: deps.icaEndpoints ?? DEFAULT_ICA_ENDPOINTS, log, limiter: createTokenBucket(deps.icaRateLimit), handlaSleep: deps.handlaSleep });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.locals.metrics = metrics;
  // One keeper per process: its in-flight refresh map is only single-flight if every caller shares it. The upkeep job
  // (src/index.ts) must take this one through appKeeper(app), never create a second.
  app.locals.keeper = keeper;

  // 00. Security headers + a fresh CSP nonce (res.locals.cspNonce) on every response, before anything can answer.
  app.use(securityHeaders(config));
  const assets = deps.assets ?? loadAssets();
  app.locals.assets = assets;

  // 0. Track every request's method/route/status for /metrics, first so nothing below is missed.
  app.use((req, res, next) => {
    res.on('finish', () => {
      metrics.httpRequests.inc({ method: req.method, route: routeLabel(req), status: String(res.statusCode) });
    });
    next();
  });

  // 1. Better Auth: OAuth AS + discovery — before any body parser.
  //    A wrong Host never reaches it (421, as for /mcp).
  app.use(['/auth', '/.well-known'], allowedHost(config));
  //    Its client IP comes only from CLIENT_IP_HEADER, which is always overwritten here with Express's `req.ip`
  //    (honouring TRUST_PROXY), so a spoofed X-Forwarded-For cannot pick a fresh rate-limit bucket per request.
  app.use(['/auth', '/.well-known'], (req, _res, next) => {
    if (req.ip) req.headers[CLIENT_IP_HEADER] = req.ip; else delete req.headers[CLIENT_IP_HEADER];
    next();
  });
  //    Only the allow-listed OAuth AS / JWKS / OIDC-callback endpoints and discovery documents are reachable over
  //    HTTP; everything else under /auth (sign-in/up, admin plugin, session and account management) is called
  //    server-side by the admin UI only. One guard for both mounts, so a /.well-known/../auth/… path cannot skip it.
  app.use(['/auth', '/.well-known'], publicAuthSurface(config.publicUrl), pinPublicOrigin(config));
  //    The handler is read from the holder per request (a mount-time handler would pin the first instance forever); a
  //    request keeps the instance it started on even when a settings save swaps in a new one meanwhile.
  //    A rejected handler goes to the error handler (500), never an unhandled rejection.
  const authHandler = (req: Request, res: Response, next: NextFunction): void => { deps.auth.snapshot().handler(req, res).catch(next); };
  app.all('/auth/*splat', authHandler);
  app.all('/.well-known/*splat', authHandler);

  // 2. Liveness (no auth, no host check — the load balancer may use an IP). A JWKS outage is a warning, not an
  //    outage: the reverse proxy/tunnel may block hairpin traffic to our own public URL even when we're fine.
  app.get('/healthz', (_req, res) => {
    void (async () => {
      try {
        deps.db.$client.prepare('select 1').get();
        const jwks = await checkJwksReachable(config);
        res.json({ ok: true, version, db: 'ok', jwks: jwks.ok ? 'ok' : 'unreachable' });
      } catch (err) {
        log.error({ err }, 'healthz db check failed');
        res.status(503).json({ ok: false, version, db: 'error' });
      }
    })();
  });

  // 2b. Prometheus scrape target: unauthenticated but only served when METRICS_ENABLED=true (the default).
  if (config.metricsEnabled) {
    app.get('/metrics', (_req, res, next) => {
      (async () => { res.type(metrics.registry.contentType).send(await metrics.registry.metrics()); })().catch(next);
    });
  }

  // 3. Admin pages (login/consent for the OAuth flow, household admin), server-rendered. The hashed, immutable
  //    assets are mounted first so they need no session.
  app.use('/admin/assets', assets.router);
  app.use('/admin', adminRouter(deps, log, keeper));
  app.get('/', (_req, res) => { res.redirect(302, '/admin'); });

  // 4. MCP: host check → bearer (reads only the Authorization header) → body parser → handler.
  //    Bearer runs before express.json so an unauthenticated junk body still gets 401 + the resource-metadata challenge.
  const mcp = mcpToNode(createMcpHttpHandler({ config, db: deps.db, version: deps.version ?? '0.0.0', log, keeper }), { onerror: mcpErrorLogger(log) });
  //    Tokens are verified in process against Better Auth's own key set (never over our public JWKS URL).
  //    The request log wraps it all: a start line once authenticated, a finish line and any rejection reason always.
  const mcpKeys = deps.mcpKeys ?? createMcpKeySet(holderJwksSource(deps.auth), log);
  const bearer = requireBearerAuth({ verifier: createVerifier(config, log, deps.db, mcpKeys), requiredScopes: ['mcp'], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(config.mcpResource)) });
  const mcpLog = mcpRequestLog(log);
  app.all('/mcp', allowedHost(config), mcpLog.begin, bearer, express.json({ limit: '1mb' }), mcpLog.started, (req, res, next) => { mcp(req, res, req.body).catch(next); });

  // 5. Anything else is genuinely unmatched (scanner probes, typos): a bounded 404, not a fall-through into the
  //    error handler, and not a fresh metrics label per path — see routeLabel.
  //    Under /admin it is the styled page (the admin router's locals — nonce, theme, user — are already set).
  app.use((req, res) => {
    if (isAdminPath(req)) { res.status(404).type('html').send(errorPage(pageCtx(res), { status: 404, code: 'not_found' })); return; }
    res.status(404).json({ error: 'not_found' });
  });

  // Express recognises error handlers by arity, so the unused 4th parameter must stay.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const status = clientErrorStatus(err);
    if (status) {
      log.warn({ err: { name: err.name, message: err.message }, status }, 'client error');
      // A browser posting an admin form (e.g. over the 16 kB body limit) gets a page, never the parser's JSON.
      if (isAdminPath(req)) {
        res.status(status).type('html').send(errorPage(pageCtx(res), status === 413 ? { status: 413, code: 'too_large' } : { status: 400, code: 'bad_request' }));
        return;
      }
      res.status(status).json({ error: 'bad_request', ...((err as { expose?: unknown }).expose === true ? { message: err.message } : {}) });
      return;
    }
    // Name and message only: never the stack, a cause or any other property (an error object can carry anything).
    log.error({ err: { name: err.name, message: err.message } }, 'unhandled');
    // Never the error's message or stack: a fixed page under /admin, a fixed JSON body elsewhere.
    if (isAdminPath(req)) { res.status(500).type('html').send(errorPage(pageCtx(res), { status: 500, code: 'internal' })); return; }
    res.status(500).json({ error: 'internal' });
  });
  return app;
}
