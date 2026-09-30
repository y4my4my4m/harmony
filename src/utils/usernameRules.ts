/** Local usernames: lowercase a-z, 0-9 and underscore, 3-24 characters. */
export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 24

export function normalizeUsernameInput(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, USERNAME_MAX_LENGTH)
}
