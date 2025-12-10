/**
 * useTypingIndicator - Composable for typing indicators
 * 
 * Provides a simple, DRY way to:
 * - Track typing in channels, threads, or conversations
 * - Display typing indicators
 * - Automatically handle cleanup
 */

import { ref, onMounted, onUnmounted, watch } from 'vue'
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
  let hasSubscribed = false

  // Handle both computed refs and direct values
  const getContext = () => {
    if (typeof context === 'function') {
      return context()
    }
    return context
  }

  // Subscribe to typing updates for a given context
  const subscribeToContext = async (ctx: TypingContext | null) => {
    // Cleanup previous subscription
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
    
    if (!ctx) {
      typingUsers.value = []
      return
    }
    
    debug.log('✅ useTypingIndicator: Subscribing to context:', ctx)
    
    try {
      // Initialize service (will wait for auth if needed)
      await typingIndicatorService.initialize()
      
      // Subscribe to typing updates
      unsubscribe = typingIndicatorService.subscribeToTyping(ctx, (users) => {
        debug.log('📝 useTypingIndicator: Typing users updated:', users.length)
        typingUsers.value = users
      })
      hasSubscribed = true
    } catch (err) {
      debug.error('❌ useTypingIndicator: Failed to subscribe:', err)
    }
  }

  // Get serialized context for comparison
  const getContextKey = (ctx: TypingContext | null) => {
    if (!ctx) return 'null'
    return JSON.stringify(ctx)
  }

  let lastContextKey = ''

  // Watch for context changes
  watch(
    getContext,
    async (newContext) => {
      const newKey = getContextKey(newContext)
      
      // Skip if context hasn't actually changed
      if (newKey === lastContextKey) {
        return
      }
      
      lastContextKey = newKey
      debug.log('🔄 useTypingIndicator: Context changed:', newContext)
      await subscribeToContext(newContext)
    },
    { immediate: true, deep: true }
  )

  // Also watch for auth session changes - re-subscribe when user logs in
  watch(
    () => authStore.session?.user?.id,
    async (userId) => {
      if (userId && !hasSubscribed) {
        const ctx = getContext()
        if (ctx) {
          debug.log('🔄 useTypingIndicator: Auth ready, subscribing to context:', ctx)
          await subscribeToContext(ctx)
        }
      }
    },
    { immediate: true }
  )

  // Ensure subscription on mount (handles case where props are already set)
  onMounted(async () => {
    // Small delay to ensure props are available
    await new Promise(resolve => setTimeout(resolve, 100))
    
    const ctx = getContext()
    if (ctx && !hasSubscribed) {
      debug.log('🔄 useTypingIndicator: onMounted - subscribing to context:', ctx)
      await subscribeToContext(ctx)
    }
  })

  // Cleanup on unmount
  onUnmounted(() => {
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
    hasSubscribed = false
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
