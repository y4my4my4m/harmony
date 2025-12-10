/**
 * useTypingIndicator - Composable for typing indicators
 * 
 * Provides a simple, DRY way to:
 * - Track typing in channels, threads, or conversations
 * - Display typing indicators
 * - Automatically handle cleanup
 */

import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
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
  let retryTimeout: ReturnType<typeof setTimeout> | null = null

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

  // Create a computed that Vue can properly track for reactivity
  const contextKey = computed(() => getContextKey(getContext()))

  // Subscribe to typing updates for a given context
  const subscribeToContext = async (ctx: TypingContext | null, key: string) => {
    // Skip if already subscribed to this exact context
    if (key === currentSubscribedKey && unsubscribe) {
      debug.log('📌 useTypingIndicator: Already subscribed to:', key)
      return
    }
    
    // Cleanup previous subscription
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
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
    }
  }

  // Watch the computed context key for changes - this properly tracks reactive deps
  watch(
    contextKey,
    async (newKey, oldKey) => {
      // Clear any pending retry
      if (retryTimeout) {
        clearTimeout(retryTimeout)
        retryTimeout = null
      }
      
      debug.log('🔄 useTypingIndicator: Context key changed:', oldKey, '->', newKey)
      const ctx = getContext()
      await subscribeToContext(ctx, newKey)
    },
    { immediate: true }
  )

  // Watch for auth session changes - subscribe when user logs in
  watch(
    () => authStore.session?.user?.id,
    async (userId) => {
      const ctx = getContext()
      const key = contextKey.value
      
      // If we have a valid context but haven't subscribed yet, subscribe now
      if (userId && ctx && key !== 'null' && currentSubscribedKey !== key) {
        debug.log('🔄 useTypingIndicator: Auth ready, subscribing to context:', key)
        await subscribeToContext(ctx, key)
      }
    },
    { immediate: true }
  )

  // Ensure subscription on mount with retry for direct page loads
  onMounted(async () => {
    // For direct page loads, props might not be immediately available
    // Retry a few times with increasing delays
    const trySubscribe = async (attempt: number) => {
      const ctx = getContext()
      const key = getContextKey(ctx)
      
      if (ctx && key !== 'null' && currentSubscribedKey !== key) {
        debug.log(`🔄 useTypingIndicator: onMounted attempt ${attempt} - subscribing to:`, key)
        await subscribeToContext(ctx, key)
      } else if (attempt < 5 && key === 'null') {
        // Context not yet available, retry with exponential backoff
        const delay = Math.min(100 * Math.pow(2, attempt), 1000)
        debug.log(`⏳ useTypingIndicator: Context not ready, retrying in ${delay}ms (attempt ${attempt})`)
        retryTimeout = setTimeout(() => trySubscribe(attempt + 1), delay)
      }
    }
    
    // Start with a small delay to allow props to settle
    await new Promise(resolve => setTimeout(resolve, 50))
    await trySubscribe(1)
  })

  // Cleanup on unmount
  onUnmounted(() => {
    if (retryTimeout) {
      clearTimeout(retryTimeout)
      retryTimeout = null
    }
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
    currentSubscribedKey = ''
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
