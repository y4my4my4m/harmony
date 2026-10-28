// An account GoTrue manages through its sign-in provider (auth.users.is_sso_user): one made by a
// first sign-in through a provider with a linking domain of its own. GoTrue refuses its password,
// address and phone changes with error_code user_sso_managed (api.UserUpdate) and never reports
// the flag otherwise, so a refusal is remembered per account on this device.

const STORAGE_KEY = 'harmony.security.providerManaged'

export function isProviderManagedError(error: unknown): boolean {
  const err = (error ?? {}) as { code?: unknown; error_code?: unknown }
  return err.code === 'user_sso_managed' || err.error_code === 'user_sso_managed'
}

function storedIds(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** True once GoTrue refused a password change of this account here. */
export function knownProviderManaged(userId: string | null | undefined): boolean {
  return !!userId && storedIds().includes(userId)
}

export function rememberProviderManaged(userId: string | null | undefined): void {
  if (!userId) return
  const ids = storedIds()
  if (ids.includes(userId)) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids, userId]))
  } catch {
    /* storage blocked: the next attempt is refused again */
  }
}
