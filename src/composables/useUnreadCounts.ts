import { ref, computed, onMounted, onUnmounted } from 'vue'
import { authContextService } from '@/services/AuthContextService'
import { fetchUnreadCounts as fetchUnreadCountRows } from '@/services/readState'
import { userEventChannel } from '@/services/UserEventChannel'
import type { UnreadCount } from '@/types'
import { debug } from '@/utils/debug'

// Module-level shared state so multiple components share one fetch/subscription
const sharedUnreadCounts = ref<Map<string, UnreadCount>>(new Map())
const sharedIsLoading = ref(false)
let sharedUnsubscribe: (() => void) | null = null
let sharedReconnectUnsub: (() => void) | null = null
let detachRefetchTriggers: (() => void) | null = null
let sharedProfileId: string | null = null
let initPromise: Promise<void> | null = null
let subscriberCount = 0

// Events received while a fetch is in flight, latest per context key. Applied over
// the fetched snapshot: they may postdate it. Null while no fetch is in flight.
let changesDuringFetch: Map<string, { action: string; count: UnreadCount }> | null = null
let fetchSeq = 0
let lastFetchAt = 0

// Events can be missed without a reconnect (a sleeping tab, a dropped broadcast).
const REFETCH_MIN_MS = 30_000
const POLL_MS = 5 * 60_000

export interface ServerUnreadTotals {
  messages: number
  mentions: number
}

/**
 * Per-server sums over every channel row, rebuilt once per unread change.
 * Readers do an O(1) lookup in place of scanning the whole map per server.
 * A muted channel adds its mentions only: the channel list hides its messages.
 */
export const serverUnreadTotals = computed(() => {
  const totals = new Map<string, ServerUnreadTotals>()
  sharedUnreadCounts.value.forEach((count) => {
    if (!count.server_id) return
    const messages = !count.muted && count.unread_messages > 0 ? count.unread_messages : 0
    const mentions = count.unread_mentions > 0 ? count.unread_mentions : 0
    if (!messages && !mentions) return
    const t = totals.get(count.server_id)
    if (t) {
      t.messages += messages
      t.mentions += mentions
    } else {
      totals.set(count.server_id, { messages, mentions })
    }
  })
  return totals
})

/** Drops every channel row of the given servers; mirrors mark_server_as_read locally. */
export function clearServerUnread(serverIds: Iterable<string>): void {
  const ids = new Set(serverIds)
  const doomed: string[] = []
  sharedUnreadCounts.value.forEach((count, key) => {
    if (count.server_id && ids.has(count.server_id)) doomed.push(key)
  })
  for (const key of doomed) sharedUnreadCounts.value.delete(key)
}

function contextKey(context: { serverId?: string; channelId?: string; conversationId?: string }): string {
  if (context.conversationId) return `conv:${context.conversationId}`
  if (context.channelId) return `channel:${context.channelId}`
  if (context.serverId) return `server:${context.serverId}`
  return 'unknown'
}

function rowKey(count: Pick<UnreadCount, 'server_id' | 'channel_id' | 'conversation_id'>): string {
  return contextKey({ serverId: count.server_id, channelId: count.channel_id, conversationId: count.conversation_id })
}

function applyTo(map: Map<string, UnreadCount>, action: string, count: UnreadCount): void {
  if (action === 'delete') map.delete(rowKey(count))
  else map.set(rowKey(count), count)
}

/** The row an unread:change payload describes. */
export function unreadCountFromChange(countData: Record<string, any>): UnreadCount {
  return {
    id: countData.id,
    user_id: countData.user_id,
    server_id: countData.server_id,
    channel_id: countData.channel_id,
    conversation_id: countData.conversation_id,
    unread_messages: countData.unread_messages ?? 0,
    unread_mentions: countData.unread_mentions ?? 0,
    // Preserve the read boundary so the "NEW messages" divider can be
    // positioned on next open even after a realtime count update.
    last_read_message_id: countData.last_read_message_id,
    last_read_at: countData.last_read_at,
    muted: countData.muted === true,
  } as UnreadCount
}

/**
 * Composable for managing unread message and mention counts
 * Tracks unread counts per channel, server, and conversation
 * 
 * Uses module-level shared state: multiple component instances share one
 * fetch + realtime subscription to prevent duplicate queries.
 */
export function useUnreadCounts() {
  const unreadCounts = sharedUnreadCounts
  const isLoading = sharedIsLoading

  /**
   * Get unread count for a specific context
   */
  const getUnreadCount = (context: {
    serverId?: string
    channelId?: string
    conversationId?: string
  }): UnreadCount | null => {
    const key = getContextKey(context)
    return unreadCounts.value.get(key) || null
  }

  /**
   * Get unread mentions count for a specific context
   */
  const getUnreadMentions = (context: {
    serverId?: string
    channelId?: string
    conversationId?: string
  }): number => {
    const count = getUnreadCount(context)
    return count?.unread_mentions || 0
  }

  /**
   * Get unread messages count for a specific context
   */
  const getUnreadMessages = (context: {
    serverId?: string
    channelId?: string
    conversationId?: string
  }): number => {
    const count = getUnreadCount(context)
    return count?.unread_messages || 0
  }

  /**
   * Get total unread mentions for a server (sum across all channels)
   */
  const getServerUnreadMentions = (serverId: string): number =>
    serverUnreadTotals.value.get(serverId)?.mentions ?? 0

  /**
   * Get total unread messages for a server (sum across all channels)
   */
  const getServerUnreadMessages = (serverId: string): number =>
    serverUnreadTotals.value.get(serverId)?.messages ?? 0

  const getContextKey = contextKey

  /**
   * Get profile ID (uses cached AuthContextService)
   */
  const getProfileId = async (): Promise<string | null> => {
    if (sharedProfileId) return sharedProfileId
    
    try {
      const context = await authContextService.getCurrentContext()
      if (context.isAuthenticated) {
        sharedProfileId = context.profileId
        return sharedProfileId
      }
    } catch (error) {
      debug.error('Failed to get profile ID:', error)
    }
    return null
  }

  /**
   * Replaces the shared map with a fresh snapshot, then reapplies the events that
   * arrived while it was in flight. A fetch overtaken by a later one is dropped.
   */
  const fetchUnreadCounts = async (_userId?: string): Promise<void> => {
    const seq = ++fetchSeq
    if (!changesDuringFetch) changesDuringFetch = new Map()
    lastFetchAt = Date.now()
    sharedIsLoading.value = true
    try {
      const profileId = await getProfileId()
      if (!profileId) {
        debug.warn('Profile ID not available')
        return
      }

      const data = await fetchUnreadCountRows()
      if (seq !== fetchSeq) return
      const next = new Map<string, UnreadCount>()
      data.forEach((count) => next.set(rowKey(count), count))
      changesDuringFetch.forEach(({ action, count }) => applyTo(next, action, count))
      sharedUnreadCounts.value = next

      debug.log('Fetched unread counts:', next.size)
    } catch (error) {
      debug.error('Error fetching unread counts:', error)
    } finally {
      if (seq === fetchSeq) {
        changesDuringFetch = null
        sharedIsLoading.value = false
      }
    }
  }

  const refetchIfStale = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (Date.now() - lastFetchAt < REFETCH_MIN_MS) return
    void fetchUnreadCounts()
  }

  /**
   * Apply an unread count change to shared state (used by both broadcast and CDC paths).
   */
  const applyUnreadChange = (action: string, countData: Record<string, any>) => {
    const count = unreadCountFromChange(countData)
    applyTo(sharedUnreadCounts.value, action, count)
    changesDuringFetch?.set(rowKey(count), { action, count })
  }

  /**
   * Dual-mode subscription for unread count changes:
   *
   * 1. Broadcast - via UserEventChannel (realtime.send() from DB triggers).
   * 2. postgres_changes fallback - classic CDC, always works.
   *
   * Both paths call applyUnreadChange which is naturally idempotent
   * (same key → same value overwrite), so dedup is implicit.
   */
  const setupRealtimeSubscription = async (): Promise<void> => {
    if (sharedUnsubscribe) return

    const profileId = await getProfileId()
    if (!profileId) return

    // ---- 1. Broadcast handler (best-effort, low latency) ----
    if (!sharedUnsubscribe) {
      userEventChannel.connect(profileId)

      sharedUnsubscribe = userEventChannel.on('unread:change', (data) => {
        const action = data.action as string
        const countData = data.count as Record<string, any> | undefined
        if (!countData) return
        debug.log('Broadcast unread:change →', action)
        applyUnreadChange(action, countData)
      })

      sharedReconnectUnsub = userEventChannel.on('_reconnected', async () => {
        debug.log('UserEventChannel reconnected - gap-filling unread counts')
        await fetchUnreadCounts()
      })

      if (typeof window !== 'undefined' && !detachRefetchTriggers) {
        const onVisibility = () => {
          if (document.visibilityState === 'visible') refetchIfStale()
        }
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('focus', refetchIfStale)
        const poll = setInterval(refetchIfStale, POLL_MS)
        detachRefetchTriggers = () => {
          document.removeEventListener('visibilitychange', onVisibility)
          window.removeEventListener('focus', refetchIfStale)
          clearInterval(poll)
        }
      }

      debug.log('Unread counts broadcast handler registered')
    }

  }

  /**
   * Cleanup: decrement subscriber count, tear down when last subscriber unmounts
   */
  const cleanup = (): void => {
    subscriberCount--
    if (subscriberCount <= 0) {
      subscriberCount = 0
      if (sharedUnsubscribe) {
        sharedUnsubscribe()
        sharedUnsubscribe = null
      }
      if (sharedReconnectUnsub) {
        sharedReconnectUnsub()
        sharedReconnectUnsub = null
      }
      if (detachRefetchTriggers) {
        detachRefetchTriggers()
        detachRefetchTriggers = null
      }
      sharedProfileId = null
      initPromise = null
      debug.log('Cleaned up unread counts subscriptions')
    }
  }

  /**
   * Initialize (deduplicated: multiple components share one fetch + subscription)
   */
  const initialize = async (): Promise<void> => {
    subscriberCount++
    if (initPromise) return initPromise

    initPromise = (async () => {
      const context = await authContextService.getCurrentContext()
      if (!context.isAuthenticated) return

      sharedProfileId = context.profileId
      // Handlers first: an event arriving during the fetch is applied over its snapshot.
      await setupRealtimeSubscription()
      await fetchUnreadCounts()
    })()

    return initPromise
  }

  onMounted(async () => {
    await initialize()
  })

  onUnmounted(() => {
    cleanup()
  })

  return {
    unreadCounts: computed(() => unreadCounts.value),
    isLoading: computed(() => isLoading.value),
    getUnreadCount,
    getUnreadMentions,
    getUnreadMessages,
    getServerUnreadMentions,
    getServerUnreadMessages,
    fetchUnreadCounts,
    initialize,
    cleanup,
  }
}

