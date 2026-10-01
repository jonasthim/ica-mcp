/**
 * The `groups` claim of each admin's latest OIDC sign-in, in memory only (never persisted, logged or audited), so
 * Settings can tell whether the identity provider actually sends each configured group name, and refuse an admin group
 * the saving admin is not in (a typo, or a name the IdP's groups mapping filters out, would otherwise demote admins at
 * their next sign-in). Every name is kept, whatever it looks like — the page only ever shows the configured names —
 * at most {@link SEEN_GROUPS_MAX} of them, each at most {@link SEEN_GROUP_MAX_LENGTH} characters (longer ones are
 * dropped: no configurable group name is that long). Keyed by user id; shared by every Better Auth instance the
 * AuthHolder builds.
 */
export const SEEN_GROUPS_MAX = 50;
export const SEEN_GROUP_MAX_LENGTH = 100;

export type SeenGroups = {
  /** Remember `groups` for the user (capped), or forget the user when `undefined` (unknown). */
  set(userId: string, groups: readonly string[] | undefined): void;
  /** The remembered groups, or `undefined` when unknown (no OIDC sign-in with a groups claim since the start). */
  get(userId: string): readonly string[] | undefined;
};

export function createSeenGroups(): SeenGroups {
  const m = new Map<string, readonly string[]>();
  return {
    set(userId, groups) {
      if (!groups) { m.delete(userId); return; }
      m.set(userId, Object.freeze([...new Set(groups.filter((g) => g.length <= SEEN_GROUP_MAX_LENGTH))].slice(0, SEEN_GROUPS_MAX)));
    },
    get: (userId) => m.get(userId),
  };
}
