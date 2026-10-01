import { Router, type Response } from 'express';
import type { BoundAudit } from '../audit.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { listConnectedApps, revokeOAuthGrants } from '../users/grants.js';
import { capName } from './display-name.js';
import type { SeeOther } from './flash.js';
import { pageCtx } from './page-ctx.js';
import type { AdminSession } from './session.js';
import { appConfirmPage, appsPage } from './views/index.js';

const LIST = '/admin/apps';
// A client name is self-chosen at registration (open DCR) and unbounded: capped (capName) where it goes into the flash
// cookie and the audit details.

/**
 * /admin/apps (mounted behind `requireSession`): the OAuth clients the signed-in user allowed, and revoking one. Every
 * lookup and change is scoped to the current user, so a client id of someone else's app finds nothing ("not found"),
 * shows nothing, and revokes nothing. Revoking deletes the consent and marks the refresh tokens revoked. The access
 * tokens are JWTs that are never looked up, so they are stopped by `/mcp`'s per-request consent check
 * (`createVerifier`): no consent, or one newer than the token, and it is refused.
 *
 * The client id travels in a form field (`client_id`), not the path: a CIMD client id is a URL, full of `/`.
 */
export function appsRouter(deps: { db: Db; config: Config }): Router {
  const { db, config } = deps;
  const r = Router();
  const me = (res: Response): string => (res.locals.session as AdminSession).user.id;
  const see = (res: Response): SeeOther => res.locals.seeOther as SeeOther;

  r.get('/', (_req, res) => {
    const apps = listConnectedApps(db, me(res)).map((a) => ({ ...a, verified: config.trustedClientIds.includes(a.clientId) }));
    res.set('Cache-Control', 'no-store').type('html').send(appsPage(pageCtx(res), { apps, mcpUrl: config.mcpResource }));
  });

  r.post('/revoke', (req, res) => {
    const userId = me(res);
    const raw = (req.body as Record<string, unknown> | undefined)?.client_id;
    const clientId = typeof raw === 'string' ? raw : '';
    const app = listConnectedApps(db, userId).find((a) => a.clientId === clientId);
    if (!app) { see(res)(res, LIST, { kind: 'error', code: 'app_not_found' }); return; }
    // Without JS the dialog never ran: ask on a page first (the JS dialog adds confirm=yes).
    if ((req.body as Record<string, unknown> | undefined)?.confirm !== 'yes') {
      res.set('Cache-Control', 'no-store').type('html').send(appConfirmPage(pageCtx(res), { clientId, name: app.name, redirectHost: app.redirectHost }));
      return;
    }
    if (!revokeOAuthGrants(db, userId, clientId).length) { see(res)(res, LIST, { kind: 'error', code: 'app_not_found' }); return; }
    (res.locals.audit as BoundAudit)('oauth.client_revoked', { target: { type: 'oauth_client', id: clientId }, details: { clientName: capName(app.name), reason: 'user' } });
    see(res)(res, LIST, { kind: 'success', code: 'app_revoked', params: { name: capName(app.name) } });
  });
  return r;
}
