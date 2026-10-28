/** Local usernames: lowercase a-z, 0-9 and underscore, 3-24 characters. */
export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 24

/**
 * Names no new local account takes: mass mentions, the instance and its staff. Mirrors
 * guard_local_username (20261031900001_reserved_usernames.sql) and self-host/admin.sh
 * reserved_username.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'everyone', 'here', 'system', 'harmony',
  'admin', 'admins', 'administrator',
  'mod', 'mods', 'moderator', 'moderators',
  'staff', 'root',
])

export function normalizeUsernameInput(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, USERNAME_MAX_LENGTH)
}

/** Labels of `domain` before its last, port dropped; a single-label host is its own label. */
function domainLabels(domain: string | null | undefined): string[] {
  const host = (domain || '').toLowerCase().split(':')[0]
  if (!host) return []
  const labels = host.split('.')
  return labels.length > 1 ? labels.slice(0, -1) : labels
}

/** True when a new local account cannot take `username` on the instance at `domain`. */
export function isReservedUsername(username: string, domain?: string | null): boolean {
  const name = username.toLowerCase()
  return RESERVED_USERNAMES.has(name) || domainLabels(domain).includes(name)
}
