/**
 * The posts, followers and following figures a profile shows.
 *
 * A remote account carries two sets: the local counters (follows and posts this instance
 * holds) and its origin's collection totals, read by the federation backend into the
 * remote_*_count columns (migration 20261011500001). Mastodon shows a remote account's
 * origin totals the same way. Once a read happened, a NULL total is one the origin withholds
 * (private collection, no totalItems) and shows as hidden rather than as the local counter.
 */

export type ProfileCountKind = 'posts' | 'followers' | 'following'

export interface ProfileCountSource {
  is_local?: boolean | null
  posts_count?: number | null
  followers_count?: number | null
  following_count?: number | null
  remote_posts_count?: number | null
  remote_followers_count?: number | null
  remote_following_count?: number | null
  remote_counts_fetched_at?: string | null
}

/** profiles columns behind the remote figures. */
export const REMOTE_COUNT_COLUMNS = [
  'remote_posts_count',
  'remote_followers_count',
  'remote_following_count',
  'remote_counts_fetched_at',
] as const

const LOCAL_FIELD = {
  posts: 'posts_count',
  followers: 'followers_count',
  following: 'following_count',
} as const

const REMOTE_FIELD = {
  posts: 'remote_posts_count',
  followers: 'remote_followers_count',
  following: 'remote_following_count',
} as const

export function isRemoteProfile(user: ProfileCountSource | null | undefined): boolean {
  return !!user && user.is_local === false
}

/** The figure to show; null when the account's server withholds it. */
export function profileCount(user: ProfileCountSource | null | undefined, kind: ProfileCountKind): number | null {
  if (!user) return null
  const local = user[LOCAL_FIELD[kind]]
  if (!isRemoteProfile(user)) return typeof local === 'number' ? local : 0
  const remote = user[REMOTE_FIELD[kind]]
  if (typeof remote === 'number') return remote
  if (user.remote_counts_fetched_at) return null
  return typeof local === 'number' ? local : 0
}

export type RemoteCountFields = Partial<Pick<ProfileCountSource, typeof REMOTE_COUNT_COLUMNS[number]>>

/** The remote figures of a profiles row, for merging into a loaded profile. */
export function remoteCountFields(row: ProfileCountSource | null | undefined): RemoteCountFields {
  const fields: RemoteCountFields = {}
  if (!row) return fields
  for (const column of REMOTE_COUNT_COLUMNS) {
    if (column in row) (fields as Record<string, unknown>)[column] = row[column] ?? null
  }
  return fields
}
