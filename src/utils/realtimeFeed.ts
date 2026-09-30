/** Realtime inserts never grow a live feed past this many posts. */
export const REALTIME_FEED_CAP = 100

interface Identified {
  id: string
}

export interface RealtimeInsertResult<T> {
  posts: T[]
  pending: T[]
  /** True when the cap dropped the loaded tail; pagination must reopen. */
  trimmed: boolean
}

/**
 * Places a realtime post. A live feed (viewer at the top, or feed off-screen)
 * takes it at the head and is capped. A feed the viewer has scrolled into keeps
 * its loaded list untouched and queues the post, newest first.
 */
export function insertRealtimePost<T extends Identified>(
  posts: T[],
  pending: T[],
  post: T,
  live: boolean,
  cap = REALTIME_FEED_CAP,
): RealtimeInsertResult<T> {
  if (posts.some(p => p.id === post.id) || pending.some(p => p.id === post.id)) {
    return { posts, pending, trimmed: false }
  }
  if (!live) {
    return { posts, pending: [post, ...pending], trimmed: false }
  }
  const next = [post, ...posts]
  if (next.length > cap) {
    return { posts: next.slice(0, cap), pending, trimmed: true }
  }
  return { posts: next, pending, trimmed: false }
}

/** Prepends queued posts (newest first) ahead of the loaded list, dropping duplicates. */
export function flushPendingPosts<T extends Identified>(posts: T[], pending: T[]): T[] {
  if (pending.length === 0) return posts
  const loaded = new Set(posts.map(p => p.id))
  const seen = new Set<string>()
  const head: T[] = []
  for (const p of pending) {
    if (loaded.has(p.id) || seen.has(p.id)) continue
    seen.add(p.id)
    head.push(p)
  }
  return head.length ? [...head, ...posts] : posts
}
