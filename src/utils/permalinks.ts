/**
 * Addresses of accounts, posts and hashtags in the app, as Mastodon's:
 *   /@user              an account of this instance
 *   /@user@domain       an account of another instance
 *   /@user/<id>         a post (`posts.id`), /@user@domain/<id> of a remote author
 *   /tags/<tag>         a hashtag
 * The ActivityPub ids, /users/<name> and /posts/<id>, are another set and do not change.
 * Without its author a post has /posts/<id>, which the federation backend answers.
 */
import { resolveHarmonyBaseUrl } from '@/utils/discordBridgeSetup'
import { handleParts, type HandleOwner } from '@/utils/handles'

/** The /@ segment of an account: `user` here, `user@domain` elsewhere. null without a username. */
export function profileHandleParam(account: HandleOwner | null | undefined): string | null {
  const p = handleParts(account)
  if (!p) return null
  return encodeURIComponent(p.domain ? `${p.username}@${p.domain}` : p.username).replace(/%40/g, '@')
}

/** /@user or /@user@domain; null without a username. */
export function profilePath(account: HandleOwner | null | undefined): string | null {
  const handle = profileHandleParam(account)
  return handle ? `/@${handle}` : null
}

interface PermalinkPost {
  id: string
  author?: HandleOwner | null
}

/** /@user/<id>, or /posts/<id> when the author is unknown. */
export function postPath(post: PermalinkPost): string {
  const handle = profileHandleParam(post.author)
  return handle ? `/@${handle}/${post.id}` : `/posts/${post.id}`
}

/** /tags/<tag>, the tag without its #. */
export function tagPath(tag: string): string {
  return `/tags/${encodeURIComponent(tag.replace(/^#/, ''))}`
}

function absolute(path: string, base: string): string {
  return `${base.replace(/\/$/, '')}${path}`
}

export function profileUrl(account: HandleOwner | null | undefined, base: string = resolveHarmonyBaseUrl()): string | null {
  const path = profilePath(account)
  return path ? absolute(path, base) : null
}

export function postUrl(post: PermalinkPost, base: string = resolveHarmonyBaseUrl()): string {
  return absolute(postPath(post), base)
}

export function tagUrl(tag: string, base: string = resolveHarmonyBaseUrl()): string {
  return absolute(tagPath(tag), base)
}

/** Paths SocialLayout serves: the /social views, posts, accounts and hashtags. */
export function isSocialPath(path: string): boolean {
  return /^\/(social(\/|$)|posts\/|@|tags\/)/.test(path)
}
