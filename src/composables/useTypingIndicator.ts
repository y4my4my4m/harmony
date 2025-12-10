/**
 * useTypingIndicator - Composable for typing indicators
 * 
 * Provides a simple, DRY way to:
 * - Track typing in channels, threads, or conversations
 * - Display typing indicators
 * - Automatically handle cleanup
 * 
 * Uses watchEffect to properly track reactive props accessed inside getter functions
 */

import { ref, onUnmounted, watchEffect, watch } from 'vue'
import { typingIndicatorService, type TypingContext, type TypingUser } from '@/services/TypingIndicatorService'
import { useAuthStore } from '@/stores/auth'
import { debug } from '@/utils/debug'

/**
 * Composable for tracking and displaying typing indicators
 */
export function useTypingIndicator(context: TypingContext | null | (() => TypingContext | null)) {
  const typingUsers = ref<TypingUser[]>([])
  const authStore = useAuthStore()
  let unsubscribe: (() => void) | null = null
  let currentSubscribedKey = '' // Track what we're currently subscribed to
  let isSubscribing = false // Prevent concurrent subscription attempts

  // Handle both computed refs and direct values
  const getContext = () => {
    if (typeof context === 'function') {
      return context()
    }
    return context
  }

  // Get serialized context key for comparison (handles Vue reactive objects)
  const getContextKey = (ctx: TypingContext | null): string => {
    if (!ctx) return 'null'
    // Extract plain values to avoid circular reference issues with Vue reactivity
    if ('channelId' in ctx) return `channel:${ctx.channelId}`
    if ('threadId' in ctx) return `thread:${ctx.threadId}`
    if ('conversationId' in ctx) return `conversation:${ctx.conversationId}`
    return 'unknown'
  }

  // Subscribe to typing updates for a given context
  const subscribeToContext = async (ctx: TypingContext | null, key: string) => {
    // Skip if already subscribed to this exact context
    if (key === currentSubscribedKey && unsubscribe) {
      debug.log('📌 useTypingIndicator: Already subscribed to:', key)
      return
    }
    
    // Prevent concurrent subscription attempts
    if (isSubscribing) {
      debug.log('⏳ useTypingIndicator: Already subscribing, skipping')
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
      debug.log('⏳ useTypingIndicator: Waiting for auth before subscribing to:', key)
      return
    }
    
    isSubscribing = true
    debug.log('✅ useTypingIndicator: Subscribing to context:', ctx, 'key:', key)
    
    try {
      // Initialize service (will wait for auth if needed)
      await typingIndicatorService.initialize()
      
      // Subscribe to typing updates
      unsubscribe = typingIndicatorService.subscribeToTyping(ctx, (users) => {
        debug.log('📝 useTypingIndicator: Typing users updated:', users.length)
        typingUsers.value = users
      })
      currentSubscribedKey = key
    } catch (err) {
      debug.error('❌ useTypingIndicator: Failed to subscribe:', err)
    } finally {
      isSubscribing = false
    }
  }

  // Use watchEffect to automatically track ALL reactive dependencies
  // This includes props.channelId, props.conversationId, props.threadId accessed inside the getter
  // watchEffect runs immediately and re-runs whenever any tracked dependency changes
  watchEffect(async () => {
    // Access the context - this triggers Vue's reactivity tracking on any props accessed
    const ctx = getContext()
    const key = getContextKey(ctx)
    
    // Also track auth state
    const userId = authStore.session?.user?.id
    
    debug.log('🔄 useTypingIndicator watchEffect: context=', key, 'auth=', !!userId)
    
    // Only subscribe if we have both context and auth
    if (ctx && key !== 'null' && userId) {
      await subscribeToContext(ctx, key)
    } else if (!ctx || key === 'null') {
      // Clear subscription if no context
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      typingUsers.value = []
      currentSubscribedKey = ''
    }
  })
  
  // Additional watch for auth changes to retry subscription
  watch(
    () => authStore.session?.user?.id,
    async (userId, oldUserId) => {
      if (userId && !oldUserId) {
        // User just logged in, try to subscribe
        const ctx = getContext()
        const key = getContextKey(ctx)
        if (ctx && key !== 'null' && currentSubscribedKey !== key) {
          debug.log('🔄 useTypingIndicator: Auth ready, subscribing to context:', key)
          await subscribeToContext(ctx, key)
        }
      }
    }
  )

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
      debug.log('⌨️ useTypingIndicator: Starting typing for context:', ctx)
      await typingIndicatorService.startTyping(ctx)
    } else {
      debug.warn('⚠️ useTypingIndicator: Cannot start typing, no context')
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
   * Returns formatted string like "John is typing..." or "John and 2 others are typing..."
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
