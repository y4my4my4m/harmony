/**
 * The cookie that tells the reverse proxy this browser holds a session: with it, /@<name> and
 * /@<name>/<post id> serve the app instead of the public page (dev/nginx-harmony.template.conf
 * map $public_page_app, self-host/Caddyfile @publicPageApp). The public page's script reads and
 * sets the same cookie and hop key (federation-backend src/publicPages/layout.ts handOffScript).
 */

export const APP_SESSION_COOKIE = 'harmony_app'

/** sessionStorage: `<target path> <epoch ms>` of the last hop between the app and a public page. */
export const PUBLIC_PAGE_HOP_KEY = 'harmony:publicPageHop'

/** A second hop to the same target within this many ms is refused. */
export const PUBLIC_PAGE_HOP_WINDOW_MS = 10_000

/** 400 days, the longest lifetime browsers keep. */
const MAX_AGE_S = 34_560_000

export function hasAppSessionCookie(doc: Pick<Document, 'cookie'> = document): boolean {
  return new RegExp(`(?:^|;\\s*)${APP_SESSION_COOKIE}=1(?:;|$)`).test(doc.cookie)
}

/** Sets the cookie while signed in, clears it otherwise. Secure on https. */
export function setAppSessionCookie(
  signedIn: boolean,
  doc: Pick<Document, 'cookie'> = document,
  loc: Pick<Location, 'protocol'> = window.location,
): void {
  if (signedIn === hasAppSessionCookie(doc)) return
  const secure = loc.protocol === 'https:' ? '; Secure' : ''
  doc.cookie = signedIn
    ? `${APP_SESSION_COOKIE}=1; Path=/; Max-Age=${MAX_AGE_S}; SameSite=Lax${secure}`
    : `${APP_SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
}

/**
 * Whether a hop to `target` may go ahead, recording it when it may. A hop to the same target
 * within PUBLIC_PAGE_HOP_WINDOW_MS is refused: the proxy served the same answer again.
 */
export function claimPublicPageHop(
  target: string,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeSessionStorage(),
  now: number = Date.now(),
): boolean {
  if (!storage) return false
  try {
    const [last, at] = (storage.getItem(PUBLIC_PAGE_HOP_KEY) ?? '').split(' ')
    if (last === target && now - Number(at) < PUBLIC_PAGE_HOP_WINDOW_MS) {
      storage.removeItem(PUBLIC_PAGE_HOP_KEY)
      return false
    }
    storage.setItem(PUBLIC_PAGE_HOP_KEY, `${target} ${now}`)
    return true
  } catch {
    return false
  }
}

function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}
