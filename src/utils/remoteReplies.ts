import type { RemoteRepliesResult } from '@/services/activityPubService'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** Status reads while a crawl runs. */
export const REPLIES_POLL_INTERVAL_MS = 2000
/** A crawl is given up on after this long; the backend's own deadline is 30 s. */
export const REPLIES_POLL_TIMEOUT_MS = 60_000
/** The backend's FORCED_REPLY_CRAWL_COOLDOWN_MS. */
export const FORCED_REPLIES_COOLDOWN_MS = 60_000

/**
 * Minimum time between two crawls of a post's replies; mirrors replyCrawlInterval in the
 * federation backend.
 */
export function repliesCrawlInterval(createdAt: string | null | undefined, now: number): number {
  const published = createdAt ? Date.parse(createdAt) : NaN
  const age = Number.isFinite(published) ? now - published : 24 * HOUR_MS
  if (age < HOUR_MS) return 2 * MINUTE_MS
  if (age < 24 * HOUR_MS) return 15 * MINUTE_MS
  return 6 * HOUR_MS
}

/** A crawl of the post's replies is due: never run, or older than repliesCrawlInterval. */
export function repliesFetchDue(
  post: { created_at?: string | null; replies_fetched_at?: string | null },
  now: number = Date.now(),
): boolean {
  const last = post.replies_fetched_at ? Date.parse(post.replies_fetched_at) : NaN
  if (!Number.isFinite(last)) return true
  return now - last >= repliesCrawlInterval(post.created_at, now)
}

const forcedRefreshes = new Map<string, number>()

/** Milliseconds until the reader may force another crawl of `apId`; 0 when allowed. */
export function forcedRepliesRefreshWait(apId: string, now: number = Date.now()): number {
  const last = forcedRefreshes.get(apId)
  return last === undefined ? 0 : Math.max(0, last + FORCED_REPLIES_COOLDOWN_MS - now)
}

export function noteForcedRepliesRefresh(apId: string, now: number = Date.now()): void {
  forcedRefreshes.set(apId, now)
  if (forcedRefreshes.size > 500) {
    for (const [key, at] of forcedRefreshes) {
      if (now - at >= FORCED_REPLIES_COOLDOWN_MS) forcedRefreshes.delete(key)
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Starts a crawl and reads its status until it ends. Answers the last status read: 'done' or
 * 'idle' once the crawl ended, the start answer when no crawl ran, or a 'failed' answer after
 * REPLIES_POLL_TIMEOUT_MS. Null when `cancelled` turns true.
 */
export async function followRepliesFetch(
  start: () => Promise<RemoteRepliesResult>,
  poll: () => Promise<RemoteRepliesResult>,
  options: {
    cancelled?: () => boolean
    intervalMs?: number
    timeoutMs?: number
    wait?: (ms: number) => Promise<void>
    now?: () => number
  } = {},
): Promise<RemoteRepliesResult | null> {
  const {
    cancelled = () => false,
    intervalMs = REPLIES_POLL_INTERVAL_MS,
    timeoutMs = REPLIES_POLL_TIMEOUT_MS,
    wait = sleep,
    now = Date.now,
  } = options
  const began = now()
  let answer = await start()
  while (answer.status === 'started' || answer.status === 'running') {
    if (cancelled()) return null
    if (now() - began >= timeoutMs) return { success: false, status: 'failed' }
    await wait(intervalMs)
    if (cancelled()) return null
    const next = await poll()
    // A refused status read leaves the crawl running; the next read decides.
    if (next.status !== 'rate_limited' && next.status !== 'busy' && next.status !== 'failed') answer = next
  }
  return cancelled() ? null : answer
}

/** What the reader is told about a reply crawl. */
export type RepliesFetchView =
  | { kind: 'fetching' }
  /** Replies listed and held; the thread shows them. */
  | { kind: 'fetched'; count: number }
  /** No crawl was due. */
  | { kind: 'recent' }
  /** The crawl ended without a result this client can read. */
  | { kind: 'finished' }
  | { kind: 'none' }
  /** `shown` of the listed replies are held here; `total` when known and larger. */
  | { kind: 'partial'; shown: number; total: number | null }
  | { kind: 'rate_limited'; seconds: number }
  | { kind: 'unreachable' }
  | { kind: 'unauthorized' }
  | { kind: 'failed' }

/** The view of a crawl's last answer. `knownTotal` is the post's replies_count. */
export function repliesFetchView(answer: RemoteRepliesResult, knownTotal = 0): RepliesFetchView {
  switch (answer.status) {
    case 'started':
    case 'running':
      return { kind: 'fetching' }
    case 'rate_limited':
    case 'busy':
      return { kind: 'rate_limited', seconds: Math.max(1, answer.retry_after ?? 60) }
    case 'failed':
      return { kind: 'failed' }
  }
  const crawl = answer.result
  if (!crawl) return answer.status === 'recent' ? { kind: 'recent' } : { kind: 'finished' }
  switch (crawl.outcome) {
    case 'unavailable':
      return { kind: 'unreachable' }
    case 'unauthorized':
      return { kind: 'unauthorized' }
    case 'no_collection':
      return { kind: 'none' }
  }
  const shown = crawl.stored + crawl.existing
  if (crawl.truncated || !crawl.complete || crawl.found > shown) {
    const total = Math.max(crawl.found, knownTotal, answer.replies_count ?? 0)
    return { kind: 'partial', shown, total: total > shown ? total : null }
  }
  return crawl.found === 0 ? { kind: 'none' } : { kind: 'fetched', count: crawl.found }
}

/** A view as a toast kind and its locale key. Null for 'fetching'. */
export interface RepliesFetchNotice {
  kind: 'success' | 'info' | 'error'
  key: string
  params: Record<string, string | number>
  /** Plural selector. */
  count?: number
}

export function repliesFetchNotice(view: RepliesFetchView, domain: string): RepliesFetchNotice | null {
  switch (view.kind) {
    case 'fetching':
      return null
    case 'fetched':
      return { kind: 'success', key: 'activitypub.repliesFetched', params: { count: view.count, domain }, count: view.count }
    case 'finished':
      return { kind: 'success', key: 'activitypub.repliesRefreshed', params: { domain } }
    case 'recent':
      return { kind: 'info', key: 'activitypub.repliesFetchedRecently', params: { domain } }
    case 'none':
      return { kind: 'info', key: 'activitypub.noRepliesFromSource', params: { domain } }
    case 'partial':
      return view.total !== null
        ? { kind: 'info', key: 'activitypub.repliesPartial', params: { shown: view.shown, total: view.total, domain }, count: view.total }
        : { kind: 'info', key: 'activitypub.repliesMoreOnOrigin', params: { domain } }
    case 'rate_limited':
      return { kind: 'error', key: 'activitypub.repliesRateLimited', params: { seconds: view.seconds }, count: view.seconds }
    case 'unreachable':
      return { kind: 'error', key: 'activitypub.fetchOlderFailed', params: { domain } }
    case 'unauthorized':
      return { kind: 'error', key: 'activitypub.repliesUnauthorized', params: { domain } }
    case 'failed':
      return { kind: 'error', key: 'activitypub.repliesFetchFailed', params: { domain } }
  }
}

/** The origin host of a post's AP id, else `fallback`. */
export function originDomain(apId: string | null | undefined, fallback = ''): string {
  try {
    return apId ? new URL(apId).hostname || fallback : fallback
  } catch {
    return fallback
  }
}
