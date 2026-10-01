import { IcaRejected, IcaUnavailable } from '../ica/errors.js';

export { IcaUnavailable, IcaRejected };

/** The hub user has no ICA account linked yet. */
export class NotLinked extends Error { constructor() { super('no ICA account linked'); this.name = 'NotLinked'; } }
/** The stored web session is gone or no longer logged in: only a new BankID scan helps. */
export class NeedsWebReconnect extends Error { constructor() { super('ICA web session ended'); this.name = 'NeedsWebReconnect'; } }
export type AppReconnectWhy = 'not-connected' | 'expired' | 'rejected' | 'unreadable';
/** App access is missing, expired, refused by ICA, or cannot be decrypted. */
export class NeedsAppReconnect extends Error {
  constructor(readonly why: AppReconnectWhy) { super(`ICA app access needs a reconnect (${why})`); this.name = 'NeedsAppReconnect'; }
}
/**
 * Why purchase history needs a fresh web BankID login: `level` — ICA reports a loginState below 2; `refused-at-level` —
 * ICA refused `/api/cpa/*` (403) although it reports the needed level.
 */
export type FreshBankIdReason = 'level' | 'refused-at-level';
/** Purchase history needs loginState 2 (a recent web BankID login); `loginState` is what ICA reports now, if known. */
export class NeedsFreshBankId extends Error {
  constructor(readonly loginState: number | undefined, readonly reason: FreshBankIdReason = 'level') {
    super(`purchase history needs loginState 2 (now ${String(loginState)}; ${reason})`);
    this.name = 'NeedsFreshBankId';
  }
}
/** The per-user ICA call budget is used up. */
export class RateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) { super(`rate limited for ${retryAfterSeconds} s`); this.name = 'RateLimited'; }
}

/**
 * Why an ICA session cannot do what was asked: `needs-rescan` (only a new BankID scan helps), `needs-step-up` (the
 * web session works, but purchase history needs a fresh web BankID login: loginState below 2), `transient` (ICA
 * could not be asked; try again later).
 */
export type SessionProblem =
  | { kind: 'needs-rescan'; detail: string }
  | { kind: 'needs-step-up'; loginState: number | undefined }
  | { kind: 'transient'; detail: string };

export const adminUrlOf = (publicUrl: string): string => `${publicUrl}/admin/ica`;

/** The actionable message a tool returns for a known session/ICA error, or undefined for anything else. */
export function sessionErrorText(err: unknown, publicUrl: string): string | undefined {
  const admin = adminUrlOf(publicUrl);
  if (err instanceof NotLinked) return `No ICA account is connected to your ica-hub user yet. Open ${admin}, choose "Connect with BankID", then "Connect app access with BankID".`;
  if (err instanceof NeedsWebReconnect) return `The ICA web session has ended. Open ${admin} and choose "Reconnect with BankID", then ask again.`;
  if (err instanceof NeedsAppReconnect) {
    if (err.why === 'not-connected') return `ICA app access is not connected. Shopping lists, stores, offers, bonus and products need it (ICA refuses the web login there). Open ${admin} and choose "Connect app access with BankID".`;
    return `ICA app access has ended${err.why === 'unreadable' ? ' (the stored session cannot be decrypted)' : ''}. Open ${admin} and choose "Reconnect app access with BankID", then ask again.`;
  }
  if (err instanceof NeedsFreshBankId && err.reason === 'refused-at-level') {
    return `ICA refused purchase history although the session reports the right login level. Try a fresh BankID login once: open ${admin} and choose "Reconnect with BankID", then ask again. If it keeps failing, tell the hub operator.`;
  }
  if (err instanceof NeedsFreshBankId) {
    const level = err.loginState !== undefined ? ` (ICA reports login level ${err.loginState}; 2 is needed)` : '';
    return `ICA shows purchase history only for a while after a web BankID login${level}. It ends on its own after somewhere between half an hour and a few hours, and at once when app access is connected with BankID. Open ${admin} and choose "Reconnect with BankID" (after any app access reconnect), then ask again.`;
  }
  if (err instanceof RateLimited) return `ica-hub limits ICA requests per user to protect your ICA account. Try again in ${err.retryAfterSeconds} s.`;
  if (err instanceof IcaUnavailable) {
    switch (err.reason) {
      case 'geo-blocked': return 'ICA refused the request because ica-hub is not reaching it from a Swedish IP address (HTTP 451). The hub operator has to fix the network.';
      case 'network':
      case 'timeout': return 'ICA did not answer in time. Try again in a minute.';
      case 'rate-limited': return `ICA is limiting requests from ica-hub right now (HTTP ${err.status ?? 429}). Try again in a few minutes.`;
      case 'server-error': return `ICA's servers answered with an error (HTTP ${err.status ?? '5xx'}). Try again later.`;
      case 'unexpected-response': return 'ICA answered in a format ica-hub does not understand (ICA may have changed its app). The details were logged for the hub operator.';
      case 'shutting-down': return 'ica-hub is restarting; try again in a moment.';
      case 'not-ready': return 'Handla is still preparing results; try again in a moment.';
    }
  }
  if (err instanceof IcaRejected) return `ICA rejected the request (HTTP ${err.status}).`;
  return undefined;
}

/**
 * The session problem an error stands for (get_session_status). Any other 4xx from ICA (IcaRejected) is transient: it
 * says nothing about the session. Undefined only for an error that is not ICA's or the session's (a programming error).
 */
export function problemOf(err: unknown): SessionProblem | undefined {
  if (err instanceof NotLinked) return { kind: 'needs-rescan', detail: 'no ICA account linked' };
  if (err instanceof NeedsWebReconnect) return { kind: 'needs-rescan', detail: 'web session ended' };
  if (err instanceof NeedsAppReconnect) return { kind: 'needs-rescan', detail: err.why === 'not-connected' ? 'app access not connected' : `app access ${err.why}` };
  if (err instanceof NeedsFreshBankId) return { kind: 'needs-step-up', loginState: err.loginState };
  if (err instanceof IcaUnavailable) return { kind: 'transient', detail: err.reason === 'geo-blocked' ? 'geo-blocked (451)' : err.status !== undefined ? `${err.reason} (HTTP ${err.status})` : err.reason };
  if (err instanceof IcaRejected) return { kind: 'transient', detail: `could not check (HTTP ${err.status})` };
  return undefined;
}
