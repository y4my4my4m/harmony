/**
 * useTypingIndicator - Composable for typing indicators
 * 
 * Provides a simple, DRY way to:
 * - Track typing in channels, threads, or conversations
 * - Display typing indicators
 * - Automatically handle cleanup
 * 
 * Uses multiple mechanisms to ensure subscription works on direct page load:
 * 1. watchEffect for reactive tracking
 * 2. watch for auth changes
 * 3. Polling fallback for edge cases
 */

import { ref, onMounted, onUnmounted, watchEffect, watch } from 'vue'
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
  let retryInterval: ReturnType<typeof setInterval> | null = null
  let retryCount = 0
  const MAX_RETRIES = 10
  const RETRY_INTERVAL_MS = 500

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
  const subscribeToContext = async (ctx: TypingContext | null, key: string): Promise<boolean> => {
    // Skip if already subscribed to this exact context
    if (key === currentSubscribedKey && unsubscribe) {
      debug.log('📌 useTypingIndicator: Already subscribed to:', key)
      return true
    }
    
    // Prevent concurrent subscription attempts
    if (isSubscribing) {
      debug.log('⏳ useTypingIndicator: Already subscribing, skipping')
      return false
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
      return false
    }
    
    // Ensure we have auth before subscribing
    if (!authStore.session?.user?.id) {
      debug.log('⏳ useTypingIndicator: Waiting for auth before subscribing to:', key)
      return false
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
      return true
    } catch (err) {
      debug.error('❌ useTypingIndicator: Failed to subscribe:', err)
      return false
    } finally {
      isSubscribing = false
    }
  }

  // Try to subscribe - called from multiple mechanisms
  const trySubscribe = async () => {
    const ctx = getContext()
    const key = getContextKey(ctx)
    const userId = authStore.session?.user?.id
    
    if (ctx && key !== 'null' && userId && currentSubscribedKey !== key) {
      const success = await subscribeToContext(ctx, key)
      if (success) {
        // Stop retry interval if we succeeded
        if (retryInterval) {
          clearInterval(retryInterval)
          retryInterval = null
          retryCount = 0
        }
      }
      return success
    }
    return false
  }

  // Use watchEffect to automatically track ALL reactive dependencies
  watchEffect(async () => {
    // IMPORTANT: Access authStore.session BEFORE optional chaining to ensure Vue tracks it
    const session = authStore.session
    const userId = session?.user?.id
    
    // Access the context - this triggers Vue's reactivity tracking on any props accessed
    const ctx = getContext()
    const key = getContextKey(ctx)
    
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
  
  // Additional watch for auth changes
  watch(
    () => authStore.session,
    async () => {
      await trySubscribe()
    },
    { immediate: true }
  )
  
  // Polling fallback for direct page loads where reactivity might not work
  // This handles edge cases where Vue's reactivity doesn't detect changes
  onMounted(() => {
    // Start retry interval
    retryInterval = setInterval(async () => {
      if (currentSubscribedKey !== '' && currentSubscribedKey !== 'null') {
        // Already subscribed, stop retrying
        if (retryInterval) {
          clearInterval(retryInterval)
          retryInterval = null
        }
        return
      }
      
      retryCount++
      debug.log(`🔄 useTypingIndicator: Retry attempt ${retryCount}/${MAX_RETRIES}`)
      
      const success = await trySubscribe()
      
      if (success || retryCount >= MAX_RETRIES) {
        if (retryInterval) {
          clearInterval(retryInterval)
          retryInterval = null
        }
        if (!success && retryCount >= MAX_RETRIES) {
          debug.warn('⚠️ useTypingIndicator: Max retries reached, giving up')
        }
      }
    }, RETRY_INTERVAL_MS)
  })

  // Cleanup on unmount
  onUnmounted(() => {
    if (retryInterval) {
      clearInterval(retryInterval)
      retryInterval = null
    }
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
    currentSubscribedKey = ''
    isSubscribing = false
    retryCount = 0
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
