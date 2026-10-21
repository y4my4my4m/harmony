/**
 * The links a post menu offers, each with the host it points at: the post on this instance
 * (`/posts/:id`, served to browsers and crawlers alike), and for a post from another server the
 * page on that server (its `url`, else its ActivityPub id).
 */

export interface PostLink {
  url: string
  host: string
}

export interface PostLinks {
  here: PostLink
  /** Absent for a local post, or when the post names no page of its own. */
  original: PostLink | null
}

interface LinkablePost {
  id: string
  /** Absent from a boost's `reblog` snapshot; the host of `url || ap_id` decides then. */
  is_local?: boolean | null
  url?: string | null
  ap_id?: string | null
}

interface BoostWrapper extends LinkablePost {
  reblog?: LinkablePost | null
  metadata?: { reblog_of?: string | null; reblog_of_ap_url?: string | null } | null
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    return /^https?:$/.test(parsed.protocol) ? parsed.host : null
  } catch {
    return null
  }
}

/**
 * The post a pure boost's links name: the boosted post's snapshot, else (unhydrated) the boosted
 * post's id and address from the wrapper's metadata, else the wrapper itself.
 */
export function boostLinkTarget(wrapper: BoostWrapper): LinkablePost {
  if (wrapper.reblog) return wrapper.reblog
  return {
    id: wrapper.metadata?.reblog_of || wrapper.id,
    url: wrapper.metadata?.reblog_of_ap_url || null,
  }
}

/** `post` is the post shown: for a pure boost, `boostLinkTarget` of the wrapper. */
export function postLinks(post: LinkablePost, harmonyBase: string): PostLinks {
  const base = harmonyBase.replace(/\/$/, '')
  const here = { url: `${base}/posts/${post.id}`, host: hostOf(base) ?? base }
  if (post.is_local === true) return { here, original: null }
  const url = post.url || post.ap_id
  const host = url ? hostOf(url) : null
  if (!url || !host || host === here.host) return { here, original: null }
  return { here, original: { url, host } }
}
