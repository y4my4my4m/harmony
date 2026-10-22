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

interface Dated extends Identified {
  created_at: string
}

/** Newest first by (created_at, id): the order the feed queries read. */
export function newerFirst(a: Dated, b: Dated): number {
  const byTime = Date.parse(b.created_at) - Date.parse(a.created_at)
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime
  return b.id < a.id ? -1 : b.id > a.id ? 1 : 0
}

/**
 * Places a realtime post in a newest-first list at its date. An outbox backfill inserts an
 * account's posts newest first, so each arrives older than the last. With `olderMayExist` (the
 * list ends at a page boundary), a post older than the last listed one is left to the next page:
 * listing it would move that page's cursor past the stored posts in between.
 * Returns `posts` itself when the post is already listed or left out.
 */
export function placeByDate<T extends Dated>(posts: T[], post: T, olderMayExist: boolean): T[] {
  if (posts.some(p => p.id === post.id)) return posts
  const at = posts.findIndex(p => newerFirst(post, p) < 0)
  if (at === -1) return olderMayExist ? posts : [...posts, post]
  return [...posts.slice(0, at), post, ...posts.slice(at)]
}

/**
 * Posts `next` lists ahead of everything `previous` listed, when `next` is `previous` with posts
 * placed at its head (and its tail possibly cut by the cap); 0 for any other change.
 */
export function addedAtHead<T extends Identified>(previous: readonly T[], next: readonly T[]): number {
  if (previous.length === 0) return 0
  const at = next.findIndex(p => p.id === previous[0].id)
  if (at <= 0) return 0
  const listed = new Set(previous.map(p => p.id))
  for (let i = 0; i < at; i++) {
    if (listed.has(next[i].id)) return 0
  }
  const kept = Math.min(previous.length, next.length - at)
  for (let i = 1; i < kept; i++) {
    if (next[at + i].id !== previous[i].id) return 0
  }
  return at
}
