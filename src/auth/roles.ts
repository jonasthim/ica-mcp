import { adminAc, defaultAc, userAc } from 'better-auth/plugins/admin/access';
import type { AccessControl } from 'better-auth/plugins/access';

export const ROLES = ['admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

/** Better Auth's `user.role` is the single source of truth (Phase 1.5); anything but 'admin' is a member. */
export const roleOf = (user: { role?: string | null }): Role => (user.role === 'admin' ? 'admin' : 'member');

/**
 * Wired into the admin plugin (`admin({ ...accessControl })`): `roles` restricts settable roles to `admin` and
 * `member` (Better Auth rejects any other value at `createUser`/`setRole`); `ac` is only consumed by the client
 * plugin (we don't use it server-side), whose default generic is too wide for `defaultAc`'s inferred statements.
 */
export const accessControl = { ac: defaultAc as unknown as AccessControl, roles: { admin: adminAc, member: userAc } };
