// Shared message-cache primitives used by both useChat (channels) and
// useDM (conversations). Both stores keep a Map<contextId, cache-entry>
// and a created_at-sorted message array; these helpers encode the rules
// once so the two sides can't drift.

import type { Message } from '@/types'
import { debug } from '@/utils/debug'

export interface MessageCacheEntry {
  messages: Message[]
  lastFetchedAt: Date
  allMessagesLoaded: boolean
  lastModified?: Date
}

// Sorted insert by created_at. Realtime messages are usually newest, so
// append is the O(1) fast path; out-of-order arrivals binary-insert.
export function insertMessageSorted(arr: Message[], msg: Message): void {
  const msgTime = new Date(msg.created_at).getTime()
  if (arr.length === 0 || new Date(arr[arr.length - 1].created_at).getTime() <= msgTime) {
    arr.push(msg)
    return
  }
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (new Date(arr[mid].created_at).getTime() <= msgTime) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  arr.splice(lo, 0, msg)
}

export function isCacheEntryFresh(
  entry: Pick<MessageCacheEntry, 'lastFetchedAt'> | undefined,
  validityMs: number
): boolean {
  if (!entry) return false
  return Date.now() - entry.lastFetchedAt.getTime() < validityMs
}

// Drops the least-recently-fetched entry once the cache exceeds maxSize.
export function evictOldestCacheEntry(
  cache: Map<string, Pick<MessageCacheEntry, 'lastFetchedAt'>>,
  maxSize: number
): void {
  if (cache.size <= maxSize) return

  let oldestTime = new Date()
  let oldestKey = ''
  cache.forEach((entry, key) => {
    if (entry.lastFetchedAt < oldestTime) {
      oldestTime = entry.lastFetchedAt
      oldestKey = key
    }
  })

  if (oldestKey) {
    cache.delete(oldestKey)
    debug.log(`Evicted message cache entry: ${oldestKey}`)
  }
}

// Waits for a concurrent fetch of the same reply message to land in the
// cache (50ms poll), resolving null if the other fetch gave up.
export function waitForPendingReplyFetch(
  messageId: string,
  replyCache: Map<string, Message>,
  inFlight: Set<string>
): Promise<Message | null> {
  return new Promise((resolve) => {
    const checkCache = () => {
      if (replyCache.has(messageId)) {
        resolve(replyCache.get(messageId)!)
      } else if (!inFlight.has(messageId)) {
        resolve(null)
      } else {
        setTimeout(checkCache, 50)
      }
    }
    checkCache()
  })
}
