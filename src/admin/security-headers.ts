import { randomBytes } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import type { Config } from '../config.js';

/** The policy from the spec's "Security headers" row. `formAction` extends form-action for OAuth-continuing pages. */
export function cspHeader(nonce: string, formAction: readonly string[] = []): string {
  return [
    "default-src 'self'", `script-src 'self' 'nonce-${nonce}'`, "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
    "frame-ancestors 'none'", ["form-action 'self'", ...formAction].join(' '), "base-uri 'none'", "object-src 'none'",
  ].join('; ');
}

const CSP_SAFE_HOST = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;

/**
 * The CSP source that allows a form POST whose response redirects to `uri`. Chromium enforces form-action on the
 * redirect that follows the POST, so the consent page (and the login page while an OAuth authorize is pending, and any
 * page with a "Continue with <IdP>" form) must allow that origin. http(s) → origin; other schemes (native apps) → scheme.
 */
export function formActionSourceFor(uri: string | null | undefined): string | undefined {
  if (!uri) return undefined;
  let u: URL;
  try { u = new URL(uri); } catch { return undefined; }
  // WHATWG URL lets `;` and `,` through in special-scheme hosts: only a plain DNS name / IPv4 or a bracketed IPv6
  // literal (with an optional port) may become a CSP source, so nothing can inject another directive.
  if (u.protocol === 'https:' || u.protocol === 'http:') return CSP_SAFE_HOST.test(u.host) ? u.origin : undefined;
  if (['javascript:', 'data:', 'blob:', 'file:', 'about:'].includes(u.protocol)) return undefined;
  return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) ? u.protocol : undefined;
}

export function allowFormAction(res: Response, sources: readonly string[]): void {
  const nonce = res.locals.cspNonce as string;
  res.setHeader('Content-Security-Policy', cspHeader(nonce, [...new Set(sources)]));
}

/**
 * The pages of the OAuth connect flow: Better Auth's authorize/token/callback endpoints and our sign-in, consent and
 * invite pages (an invitee may arrive mid-connect). claude.ai may run its web "Connect" in a popup and learn the
 * outcome through `window.opener`; `Cross-Origin-Opener-Policy: same-origin` on any page the popup visits puts it in a
 * new browsing context group and severs that link, so the connect would never complete. These paths therefore send
 * `unsafe-none`; every other response keeps `same-origin`.
 */
const OAUTH_FLOW_PATH = /^(?:\/auth\/oauth2\/|\/auth\/callback\/|\/admin\/invite\/|\/admin\/login(?:\/oidc)?\/?$|\/admin\/consent\/?$)/i; // case-insensitive, like Express routing
export const isOAuthFlowPath = (path: string): boolean => OAUTH_FLOW_PATH.test(path);

export function securityHeaders(config: Pick<Config, 'publicUrl'>): RequestHandler {
  const https = config.publicUrl.startsWith('https:');
  return (req, res, next) => {
    const nonce = randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;
    res.setHeader('Content-Security-Policy', cspHeader(nonce));
    if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', isOAuthFlowPath(req.path ?? '') ? 'unsafe-none' : 'same-origin');
    next();
  };
}
