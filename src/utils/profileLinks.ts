/**
 * The account a link to this instance names:
 *   /@user, /@user@domain                         the account's page (utils/permalinks.ts)
 *   /social/profile/<handle>, /profile/<handle>   earlier addresses of the same page
 *   /users/<name>                                 a local account's ActivityPub id
 * /@user/<id> is a post. Query and fragment are ignored.
 */
import { isHarmonyHost } from '@/utils/embedDetection'
import { localDomain } from '@/utils/handles'

export interface ProfileLink {
  username: string
  /** null: an account of this instance. */
  domain: string | null
}

const LOCAL_NAME = '[A-Za-z0-9_]{1,64}'
const REMOTE_NAME = '[A-Za-z0-9_.~-]{1,64}'
const HOST = '[A-Za-z0-9.-]+(?::\\d{1,5})?'
const HANDLE = `(${REMOTE_NAME})(?:@(${HOST}))?`
const PATHS = [
  new RegExp(`^/@${HANDLE}/?$`),
  new RegExp(`^/(?:social/)?profile/@?${HANDLE}/?$`),
  new RegExp(`^/users/(${LOCAL_NAME})/?$`),
]

/** The account `path` names, or null. */
export function profileLinkFromPath(path: string): ProfileLink | null {
  let pathname = path.split(/[?#]/)[0]
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    return null
  }
  for (const pattern of PATHS) {
    const m = pattern.exec(pathname)
    if (!m) continue
    const username = m[1]
    const domain = m[2]?.toLowerCase() || null
    if (!domain || domain === localDomain()) {
      return new RegExp(`^${LOCAL_NAME}$`).test(username) ? { username, domain: null } : null
    }
    return { username, domain }
  }
  return null
}

/** The account a URL of this instance names, or null for another host or path. */
export function profileLinkFromUrl(href: string): ProfileLink | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol) || !isHarmonyHost(url)) return null
  return profileLinkFromPath(url.pathname)
}
