import { ref, computed, onMounted, onUnmounted } from 'vue'
import { supabase } from '@/supabase'
import { useAuthStore } from '@/stores/useAuth'
import type { UnreadCount } from '@/types'

/**
 * Composable for managing unread message and mention counts
 * Tracks unread counts per channel, server, and conversation
 */
export function useUnreadCounts() {
  const authStore = useAuthStore()
  const unreadCounts = ref<Map<string, UnreadCount>>(new Map())
  const isLoading = ref(false)
  let realtimeSubscription: any = null

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
   * Fetch unread counts from database
   */
  const fetchUnreadCounts = async (userId: string): Promise<void> => {
    if (!userId) return

    isLoading.value = true
    try {
      // Get profile ID
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', userId)
        .single()

      if (!profile) {
        console.warn('Profile not found for user:', userId)
        return
      }

      // Fetch all unread counts for this user
      const { data, error } = await supabase
        .from('unread_counts')
        .select('*')
        .eq('user_id', profile.id)
        .or('unread_mentions.gt.0,unread_messages.gt.0') // Fetch where there are unread mentions or messages

      if (error) {
        console.error('Failed to fetch unread counts:', error)
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

      console.log('✅ Fetched unread counts:', unreadCounts.value.size)
    } catch (error) {
      console.error('❌ Error fetching unread counts:', error)
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Setup real-time subscription for unread counts
   */
  const setupRealtimeSubscription = (userId: string): void => {
    if (!userId || realtimeSubscription) return

    // Get profile ID
    supabase
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .single()
      .then(({ data: profile }) => {
        if (!profile) return

        realtimeSubscription = supabase
          .channel(`unread-counts-${profile.id}`)
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'unread_counts',
              filter: `user_id=eq.${profile.id}`,
            },
            (payload: any) => {
              console.log('🔄 Unread count update:', payload)

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

        console.log('✅ Real-time subscription for unread counts established')
      })
  }

  /**
   * Cleanup real-time subscription
   */
  const cleanup = (): void => {
    if (realtimeSubscription) {
      supabase.removeChannel(realtimeSubscription)
      realtimeSubscription = null
      console.log('🧹 Cleaned up unread counts real-time subscription')
    }
  }

  /**
   * Initialize - fetch counts and setup real-time
   */
  const initialize = async (): Promise<void> => {
    const userId = authStore.session?.user?.id
    if (!userId) return

    await fetchUnreadCounts(userId)
    setupRealtimeSubscription(userId)
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

