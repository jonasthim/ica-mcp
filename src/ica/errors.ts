/** Errors of the ICA HTTP layer. Messages are our own words plus an HTTP status: never an ICA response body. */
/**
 * `shutting-down`: ica-hub itself is restarting and refuses to start a token refresh or web jar use (not ICA's answer).
 * `not-ready`: Handla still answered a plain 202 (no WAF header) after its two short retries.
 * `blocked`: Handla's CloudFront + AWS WAF refused the request (a 202 with `x-amzn-waf-action`, or a CloudFront 403
 * "Request blocked"), or ica-hub's Handla circuit breaker is open after one; `retryAfterSeconds` says for how long.
 * `queue-full`: too many Handla requests are already waiting for their turn in ica-hub's pacing queue.
 * `cancelled`: the caller gave up (its abort signal fired) before or while ICA was asked; nobody reads the answer.
 * `rate-limited` is also used, with `retryAfterSeconds` and no HTTP status, for ica-hub's own Handla pacing
 * (HandlaPaced below), when a call would wait too long for its turn.
 */
export type UnavailableReason = 'network' | 'timeout' | 'geo-blocked' | 'rate-limited' | 'server-error' | 'unexpected-response' | 'shutting-down' | 'not-ready' | 'blocked' | 'queue-full' | 'cancelled';

/** ICA could not be asked, or gave an answer we cannot use. Try again later; no reconnect needed. */
export class IcaUnavailable extends Error {
  constructor(readonly reason: UnavailableReason, readonly status?: number, readonly issues: readonly string[] = [], readonly retryAfterSeconds?: number) {
    super(`ICA unavailable: ${reason}${status !== undefined ? ` (HTTP ${status})` : ''}`);
    this.name = 'IcaUnavailable';
  }
}

/**
 * ica-hub's own Handla pacing refused a call that would wait more than the queue limit for its turn: at most
 * `perMinute` Handla requests start per rolling minute. `cacheMinutes` is how long earlier answers stay cached (0 = no
 * cache). The name stays IcaUnavailable, so the tool-call log line reads `reason: 'rate-limited'` as for ICA's 429.
 */
export class HandlaPaced extends IcaUnavailable {
  constructor(retryAfterSeconds: number, readonly perMinute: number, readonly cacheMinutes: number) {
    super('rate-limited', undefined, [], retryAfterSeconds);
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
