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
let sharedProfileId: string | null = null
let initPromise: Promise<void> | null = null
let subscriberCount = 0

export interface ServerUnreadTotals {
  messages: number
  mentions: number
}

/**
 * Per-server sums over every channel row, rebuilt once per unread change.
 * Readers do an O(1) lookup in place of scanning the whole map per server.
 */
export const serverUnreadTotals = computed(() => {
  const totals = new Map<string, ServerUnreadTotals>()
  sharedUnreadCounts.value.forEach((count) => {
    if (!count.server_id) return
    const messages = count.unread_messages > 0 ? count.unread_messages : 0
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

  /**
   * Generate a unique key for a context
   */
  const getContextKey = (context: {
    serverId?: string
    channelId?: string
    conversationId?: string
  }): string => {
    if (context.conversationId) {
      return `conv:${context.conversationId}`
    }
    if (context.channelId) {
      return `channel:${context.channelId}`
    }
    if (context.serverId) {
      return `server:${context.serverId}`
    }
    return 'unknown'
  }

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
   * Fetch unread counts from database
   */
  const fetchUnreadCounts = async (_userId?: string): Promise<void> => {
    sharedIsLoading.value = true
    try {
      const profileId = await getProfileId()
      if (!profileId) {
        debug.warn('Profile ID not available')
        return
      }

      const data = await fetchUnreadCountRows()
      sharedUnreadCounts.value.clear()
      data.forEach((count) => {
        const context = {
          serverId: count.server_id,
          channelId: count.channel_id,
          conversationId: count.conversation_id,
        }
        const key = getContextKey(context)
        sharedUnreadCounts.value.set(key, count)
      })

      debug.log('Fetched unread counts:', sharedUnreadCounts.value.size)
    } catch (error) {
      debug.error('Error fetching unread counts:', error)
    } finally {
      sharedIsLoading.value = false
    }
  }

  /**
   * Apply an unread count change to shared state (used by both broadcast and CDC paths).
   */
  const applyUnreadChange = (action: string, countData: Record<string, any>) => {
    const count: UnreadCount = {
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
    } as UnreadCount

    const context = {
      serverId: count.server_id,
      channelId: count.channel_id,
      conversationId: count.conversation_id,
    }

    if (action === 'delete') {
      sharedUnreadCounts.value.delete(getContextKey(context))
    } else {
      sharedUnreadCounts.value.set(getContextKey(context), count)
    }
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
      await fetchUnreadCounts()
      await setupRealtimeSubscription()
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

