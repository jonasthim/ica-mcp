/** The generic OAuth provider id of the upstream IdP (Authentik): the callback is `/auth/callback/upstream`. */
export const OIDC_PROVIDER_ID = 'upstream';
/**
 * The only header Better Auth reads the client IP from (rate limiting, session rows). The app overwrites it on every
 * request with Express's `req.ip`, which honours TRUST_PROXY, so a client-sent X-Forwarded-For is never trusted
 * beyond what TRUST_PROXY allows (see createApp and the admin router's authHeaders).
 */
export const CLIENT_IP_HEADER = 'x-ica-hub-client-ip';
