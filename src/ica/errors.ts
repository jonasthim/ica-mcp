/** Errors of the ICA HTTP layer. Messages are our own words plus an HTTP status: never an ICA response body. */
/**
 * `shutting-down`: ica-hub itself is restarting and refuses to start a token refresh or web jar use (not ICA's answer).
 * `not-ready`: Handla still answered 202 ("preparing results") after the retry.
 */
export type UnavailableReason = 'network' | 'timeout' | 'geo-blocked' | 'rate-limited' | 'server-error' | 'unexpected-response' | 'shutting-down' | 'not-ready';

/** ICA could not be asked, or gave an answer we cannot use. Try again later; no reconnect needed. */
export class IcaUnavailable extends Error {
  constructor(readonly reason: UnavailableReason, readonly status?: number, readonly issues: readonly string[] = []) {
    super(`ICA unavailable: ${reason}${status !== undefined ? ` (HTTP ${status})` : ''}`);
    this.name = 'IcaUnavailable';
  }
}

/** 401/403: ICA did not accept the credential. The session layer decides what that means. */
export class IcaUnauthorized extends Error {
  constructor(readonly status: 401 | 403) { super(`ICA refused the credential (HTTP ${status})`); this.name = 'IcaUnauthorized'; }
}

/** Any other 4xx (an unknown product, a list that does not exist). */
export class IcaRejected extends Error {
  constructor(readonly status: number) { super(`ICA rejected the request (HTTP ${status})`); this.name = 'IcaRejected'; }
}

export const errorCategory = (e: unknown): 'timeout' | 'network' => (e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'network');
