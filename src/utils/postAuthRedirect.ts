/**
 * Destination a signed-out visitor was headed to (e.g. an invite link), held
 * through login, registration and profile creation.
 *
 * sessionStorage: survives the OAuth round trip and the /new-profile detour,
 * dies with the tab.
 */
const KEY = 'harmony:post-auth-redirect'

/** In-app paths only: "/x", never "//host" or "https://host". */
export function isSafeRedirect(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\')
}

export function rememberPostAuthRedirect(path: unknown): void {
  if (!isSafeRedirect(path)) return
  if (path === '/' || path.startsWith('/login') || path.startsWith('/register') || path.startsWith('/new-profile')) return
  try {
    sessionStorage.setItem(KEY, path)
  } catch {
    /* storage unavailable */
  }
}

export function peekPostAuthRedirect(): string | null {
  try {
    const value = sessionStorage.getItem(KEY)
    return isSafeRedirect(value) ? value : null
  } catch {
    return null
  }
}

export function consumePostAuthRedirect(fallback = '/chat'): string {
  const value = peekPostAuthRedirect()
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* storage unavailable */
  }
  return value ?? fallback
}
