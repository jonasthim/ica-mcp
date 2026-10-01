import type { RequestHandler } from 'express';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Fail-closed same-origin check for state-changing admin requests: the Origin must equal the public URL, or, when a
 * browser sent no Origin, the Referer's origin must. A request with neither is refused (403), never waved through.
 */
export function requireSameOrigin(publicUrl: string): RequestHandler {
  return (req, res, next) => {
    if (SAFE.has(req.method)) { next(); return; }
    let origin = req.headers.origin;
    if (!origin && req.headers.referer) { try { origin = new URL(req.headers.referer).origin; } catch { origin = undefined; } }
    if (origin !== publicUrl) { res.status(403).type('text/plain').send('cross-site request rejected'); return; }
    next();
  };
}
