import { ref, computed, onMounted, onUnmounted } from 'vue'
import { supabase } from '@/supabase'
import { authContextService } from '@/services/AuthContextService'
import type { UnreadCount } from '@/types'
import { debug } from '@/utils/debug'

/**
 * Composable for managing unread message and mention counts
 * Tracks unread counts per channel, server, and conversation
 * 
 * OPTIMIZED: Uses AuthContextService for cached profile ID lookup
 */
export function useUnreadCounts() {
  const unreadCounts = ref<Map<string, UnreadCount>>(new Map())
  const isLoading = ref(false)
  let realtimeSubscription: any = null
  let cachedProfileId: string | null = null

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
  const getServerUnreadMentions = (serverId: string): number => {
    let total = 0
    unreadCounts.value.forEach((count) => {
      if (count.server_id === serverId && count.unread_mentions > 0) {
        total += count.unread_mentions
      }
    })
    return total
  }

  /**
   * Get total unread messages for a server (sum across all channels)
   */
  const getServerUnreadMessages = (serverId: string): number => {
    let total = 0
    unreadCounts.value.forEach((count) => {
      if (count.server_id === serverId && count.unread_messages > 0) {
        total += count.unread_messages
      }
    })
    return total
  }

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
    if (cachedProfileId) return cachedProfileId
    
    try {
      const context = await authContextService.getCurrentContext()
      if (context.isAuthenticated) {
        cachedProfileId = context.profileId
        return cachedProfileId
      }
    } catch (error) {
      debug.error('Failed to get profile ID:', error)
    }
    return null
  }

  /**
   * Fetch unread counts from database
   * OPTIMIZED: Uses AuthContextService for cached profile ID lookup
   */
  const fetchUnreadCounts = async (_userId?: string): Promise<void> => {
    isLoading.value = true
    try {
      // Use cached profile ID from AuthContextService
      const profileId = await getProfileId()
      if (!profileId) {
        debug.warn('Profile ID not available')
        return
      }

      // Fetch all unread counts for this user
      const { data, error } = await supabase
        .from('unread_counts')
        .select('*')
        .eq('user_id', profileId)
        .or('unread_mentions.gt.0,unread_messages.gt.0') // Fetch where there are unread mentions or messages

      if (error) {
        debug.error('Failed to fetch unread counts:', error)
        return
      }

      // Update the map
      if (data) {
        unreadCounts.value.clear()
        data.forEach((count) => {
          const context = {
            serverId: count.server_id,
            channelId: count.channel_id,
            conversationId: count.conversation_id,
          }
          const key = getContextKey(context)
          unreadCounts.value.set(key, count as UnreadCount)
        })
      }

      debug.log('✅ Fetched unread counts:', unreadCounts.value.size)
    } catch (error) {
      debug.error('❌ Error fetching unread counts:', error)
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Setup real-time subscription for unread counts
   * OPTIMIZED: Uses cached profile ID from AuthContextService
   */
  const setupRealtimeSubscription = async (): Promise<void> => {
    if (realtimeSubscription) return

    // Use cached profile ID from AuthContextService
    const profileId = await getProfileId()
    if (!profileId) return

    realtimeSubscription = supabase
      .channel(`unread-counts-${profileId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'unread_counts',
          filter: `user_id=eq.${profileId}`,
        },
        (payload: any) => {
          debug.log('🔄 Unread count update:', payload)

          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const count = payload.new as UnreadCount
            const context = {
              serverId: count.server_id,
              channelId: count.channel_id,
              conversationId: count.conversation_id,
            }
            const key = getContextKey(context)
            unreadCounts.value.set(key, count)
          } else if (payload.eventType === 'DELETE') {
            const count = payload.old as UnreadCount
            const context = {
              serverId: count.server_id,
              channelId: count.channel_id,
              conversationId: count.conversation_id,
            }
            const key = getContextKey(context)
            unreadCounts.value.delete(key)
          }
        }
      )
      .subscribe()

    debug.log('✅ Real-time subscription for unread counts established')
  }

  /**
   * Cleanup real-time subscription
   */
  const cleanup = (): void => {
    if (realtimeSubscription) {
      supabase.removeChannel(realtimeSubscription)
      realtimeSubscription = null
      debug.log('🧹 Cleaned up unread counts real-time subscription')
    }
    cachedProfileId = null
  }

  /**
   * Initialize - fetch counts and setup real-time
   * OPTIMIZED: Uses AuthContextService for cached auth lookup
   */
  const initialize = async (): Promise<void> => {
    const context = await authContextService.getCurrentContext()
    if (!context.isAuthenticated) return

    cachedProfileId = context.profileId
    await fetchUnreadCounts()
    await setupRealtimeSubscription()
  }

  // Auto-initialize when composable is used
  onMounted(() => {
    initialize()
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

