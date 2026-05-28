/**
 * useTypingIndicator - Composable for typing indicators
 * 
 * Provides a simple, DRY way to:
 * - Track typing in channels, threads, or conversations
 * - Display typing indicators
 * - Automatically handle cleanup
 */

import { ref, onUnmounted, watchEffect } from 'vue'
import { typingIndicatorService, type TypingContext, type TypingUser } from '@/services/TypingIndicatorService'
import { useAuthStore } from '@/stores/auth'

/**
 * Composable for tracking and displaying typing indicators
 */
export function useTypingIndicator(context: TypingContext | null | (() => TypingContext | null)) {
  const typingUsers = ref<TypingUser[]>([])
  const authStore = useAuthStore()
  let unsubscribe: (() => void) | null = null
  let currentSubscribedKey = ''
  let isSubscribing = false
  let pendingContextKey: string | null = null

  // Handle both computed refs and direct values
  const getContext = () => {
    if (typeof context === 'function') {
      return context()
    }
    return context
  }

  // Get serialized context key for comparison
  const getContextKey = (ctx: TypingContext | null): string => {
    if (!ctx) return 'null'
    if ('channelId' in ctx) return `channel:${ctx.channelId}`
    if ('threadId' in ctx) return `thread:${ctx.threadId}`
    if ('conversationId' in ctx) return `conversation:${ctx.conversationId}`
    return 'unknown'
  }

  // Subscribe to typing updates for a given context
  const subscribeToContext = async (ctx: TypingContext | null, key: string): Promise<void> => {
    // Skip if already subscribed to this exact context
    if (key === currentSubscribedKey && unsubscribe) {
      return
    }
    
    // Queue a follow-up if context changes mid-flight (common on channel switch).
    if (isSubscribing) {
      pendingContextKey = key
      return
    }
    
    // Cleanup previous subscription
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
      currentSubscribedKey = ''
    }
    
    if (!ctx) {
      typingUsers.value = []
      currentSubscribedKey = ''
      return
    }
    
    // Ensure we have auth before subscribing
    if (!authStore.session?.user?.id) {
      return
    }
    
    isSubscribing = true
    
    try {
      await typingIndicatorService.initialize()
      
      unsubscribe = typingIndicatorService.subscribeToTyping(ctx, (users) => {
        typingUsers.value = users
      })
      currentSubscribedKey = key
    } catch {
      // Silently fail - typing indicators are non-critical
    } finally {
      isSubscribing = false
      const queued = pendingContextKey
      pendingContextKey = null
      if (queued && queued !== currentSubscribedKey) {
        const queuedCtx = getContext()
        const queuedKey = getContextKey(queuedCtx)
        if (queuedCtx && queuedKey === queued) {
          void subscribeToContext(queuedCtx, queued)
        }
      }
    }
  }

  // Use watchEffect to automatically track reactive dependencies
  watchEffect(async () => {
    const session = authStore.session
    const userId = session?.user?.id
    const ctx = getContext()
    const key = getContextKey(ctx)
    
    if (ctx && key !== 'null' && userId) {
      await subscribeToContext(ctx, key)
    } else if (!ctx || key === 'null') {
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      typingUsers.value = []
      currentSubscribedKey = ''
    }
  })

  // Cleanup on unmount
  onUnmounted(() => {
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
    currentSubscribedKey = ''
    isSubscribing = false
  })

  /**
   * Start tracking typing (call when user types)
   */
  const startTyping = async () => {
    const ctx = getContext()
    if (ctx) {
      await typingIndicatorService.startTyping(ctx)
    }
  }

  /**
   * Stop tracking typing (call when user sends message or stops typing)
   */
  const stopTyping = async () => {
    await typingIndicatorService.stopTyping()
  }

  /**
   * Format typing indicator text
   */
  const formatTypingText = (users: TypingUser[], getUserDisplayName: (userId: string) => string): string => {
    if (users.length === 0) return ''
    if (users.length === 1) {
      const name = getUserDisplayName(users[0].user_id) || users[0].display_name || users[0].username || 'Someone'
      return `${name} is typing...`
    }
    if (users.length === 2) {
      const name1 = getUserDisplayName(users[0].user_id) || users[0].display_name || users[0].username || 'Someone'
      const name2 = getUserDisplayName(users[1].user_id) || users[1].display_name || users[1].username || 'Someone'
      return `${name1} and ${name2} are typing...`
    }
    const name = getUserDisplayName(users[0].user_id) || users[0].display_name || users[0].username || 'Someone'
    return `${name} and ${users.length - 1} others are typing...`
  }

  return {
    typingUsers,
    startTyping,
    stopTyping,
    formatTypingText
  }
}
