/**
 * The `uri` of /authorize_interaction, the OStatus remote-follow template this instance's
 * WebFinger publishes (http://ostatus.org/schema/1.0/subscribe). Mastodon fills it with an
 * account's or a status's URI; people paste handles: `user@domain`, `@user@domain`,
 * `acct:user@domain`, and Lemmy's `!community@domain`.
 */

export type InteractionTarget =
  | { kind: 'handle'; username: string; domain: string }
  | { kind: 'local-profile'; username: string }
  | { kind: 'local-post'; postId: string }
  | { kind: 'url'; url: string }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const LOCAL_POST = new RegExp(`^/(?:social/post|posts)/(${UUID})/?$`, 'i')
const LOCAL_PROFILE = /^\/(?:social\/profile|users|@)\/?([A-Za-z0-9_]+)\/?$/

/** What `raw` names; null when it is neither a handle nor an http(s) URL. */
export function parseInteractionUri(raw: unknown, instanceDomain: string | undefined): InteractionTarget | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null

  const handle = /^(?:acct:)?[@!]?([^@\s/:!]+)@([a-z0-9.-]+(?::\d+)?)$/i.exec(value)
  if (handle) {
    const domain = handle[2].toLowerCase()
    return instanceDomain && domain === instanceDomain.toLowerCase()
      ? { kind: 'local-profile', username: handle[1] }
      : { kind: 'handle', username: handle[1], domain }
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

  if (instanceDomain && url.host.toLowerCase() === instanceDomain.toLowerCase()) {
    const post = LOCAL_POST.exec(url.pathname)
    if (post) return { kind: 'local-post', postId: post[1].toLowerCase() }
    const profile = LOCAL_PROFILE.exec(url.pathname)
    if (profile) return { kind: 'local-profile', username: profile[1] }
  }
  return { kind: 'url', url: url.href }
}

/** The /social/profile/:handle segment of an account: `user` here, `user@domain` elsewhere. */
export function profileRouteHandle(user: { username?: string | null; domain?: string | null; is_local?: boolean | null }): string | null {
  if (!user?.username) return null
  const handle = user.domain && user.is_local !== true ? `${user.username}@${user.domain}` : user.username
  return encodeURIComponent(handle).replace(/%40/g, '@')
}

/** The text of a post's content parts, for a preview. */
export function postPreviewText(content: unknown, max = 280): string {
  const parts = Array.isArray(content) ? content : []
  const text = parts
    .map((part: any) => {
      if (part?.type === 'text' && typeof part.text === 'string') return part.text
      if (part?.type === 'mention' && part.username) return `@${part.username}`
      if (part?.type === 'hashtag' && part.name) return `#${part.name}`
      if (part?.type === 'link' && typeof part.url === 'string') return part.url
      return ''
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
