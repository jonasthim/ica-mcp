import { IcaLoginRejected } from '../ica/web-session.js';

/**
 * Same-person check on (re-)enrolment: each ICA account row keeps a keyed hash (Cipher.mac) of a stable ICA id per
 * login kind, and a BankID login of another person is refused, so a partner scanning the QR on the wrong page cannot
 * silently put their ICA identity under this hub user. Only hashes are stored; neither the id nor its hash is logged.
 *
 * What is actually checked today (2026-09-30 live capture): the web side, on `customerId` of /api/user/information
 * (see WEB_SUBJECT_KEYS, including the open per-person/per-household question). ICA's app access token is opaque, so
 * `appSubject` gives nothing and the app side is not checked in production.
 */

/**
 * Compare web and app subjects with each other. // shape: from the 2026-09-30 live capture — false: the app token is
 * opaque (no `sub`), and the web `customerId` was never shown to be the same identifier as an app `sub`; each kind is
 * only checked against itself.
 */
export const CROSS_CHECK_WEB_APP = false;

export type SubjectHashes = { webSubjectHash: string | null; appSubjectHash: string | null };

/** A BankID login of another ICA person than the one already connected to this hub user. */
export class DifferentIcaPerson extends IcaLoginRejected {
  constructor(readonly kind: 'web' | 'app') {
    super(`This BankID login belongs to a different ICA account than the one already connected to your hub user${kind === 'app' ? ' (app access must be the same person as the web login)' : ''}. If you meant to switch accounts, choose "Disconnect ICA account" first.`);
    this.name = 'DifferentIcaPerson';
  }
}

/** Throws DifferentIcaPerson when `incoming` (a subject hash, or undefined when ICA gave no id) contradicts `stored`. */
export function assertSameIcaPerson(kind: 'web' | 'app', incoming: string | undefined, stored: SubjectHashes, crossCheck: boolean = CROSS_CHECK_WEB_APP): void {
  if (!incoming) return;
  const own = kind === 'web' ? stored.webSubjectHash : stored.appSubjectHash;
  const other = kind === 'web' ? stored.appSubjectHash : stored.webSubjectHash;
  if (own && own !== incoming) throw new DifferentIcaPerson(kind);
  if (crossCheck && other && other !== incoming) throw new DifferentIcaPerson(kind);
}

/** The stored fingerprint of an ICA subject (domain-separated), or undefined when ICA gave none. */
export const subjectHash = (mac: (v: string) => string, subject: string | undefined): string | undefined => (subject ? mac(`ica-subject:${subject}`) : undefined);
