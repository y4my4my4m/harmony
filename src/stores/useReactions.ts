import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { services } from '@/services'
import type { ReactionGroup, Emoji } from '@/types'

interface OptimisticOperation {
  messageId: string
  emojiId: string
  userId: string
  operation: 'add' | 'remove'
  timestamp: number
}

export const useReactionsStore = defineStore('reactions', () => {
  // State
  const reactionsByMessage = ref(new Map<string, ReactionGroup[]>())
  const lastFetched = ref(new Map<string, number>())
  const isLoading = ref(new Set<string>())
  
  // Discord-style optimistic updates
  const optimisticOperations = ref(new Map<string, OptimisticOperation>()) // key: `${messageId}-${emojiId}-${userId}`
  const pendingToggleRequests = ref(new Set<string>()) // Prevent double-clicks

  // Getters
  const getMessageReactions = computed(() => (messageId: string): ReactionGroup[] => {
    if (!messageId) return []
    
    let reactions = reactionsByMessage.value.get(messageId) || []
    
    // Apply optimistic updates (Discord-style instant feedback)
    const optimisticOps = Array.from(optimisticOperations.value.values())
      .filter(op => op.messageId === messageId)
    
    // Clone reactions to avoid mutating store data
    reactions = JSON.parse(JSON.stringify(reactions))
    
    for (const op of optimisticOps) {
      reactions = applyOptimisticOperation(reactions, op)
    }
    
    return reactions || []
  })

  const hasUserReacted = computed(() => (messageId: string, emojiId: string, userId: string): boolean => {
    const reactions = getMessageReactions.value(messageId)
    const reaction = reactions.find(r => r.emoji_id === emojiId)
    return reaction?.users?.some(u => u.id === userId) || false
  })

  const isLoadingReactions = computed(() => (messageId: string): boolean => {
    return isLoading.value.has(messageId)
  })

  // Actions
  async function fetchMessageReactions(messageId: string, force = false): Promise<void> {
    if (!messageId) return

    const now = Date.now()
    const lastFetch = lastFetched.value.get(messageId) || 0
    
    // Skip if recently fetched (unless forced)
    if (!force && now - lastFetch < 30000) return // 30 second cache
    
    if (isLoading.value.has(messageId)) return // Already loading

    try {
      isLoading.value.add(messageId)
      console.log('🔄 Fetching reactions via service layer for message:', messageId)

      const reactions = await services.messages.getMessageReactions(messageId)
      
      // Store in cache
      reactionsByMessage.value.set(messageId, reactions)
      lastFetched.value.set(messageId, now)
      
      console.log('✅ Successfully fetched reactions via service layer')
    } catch (error) {
      console.error('❌ Failed to fetch reactions:', error)
    } finally {
      isLoading.value.delete(messageId)
    }
  }

  /**
   * Discord-style reaction toggle: Instant UI feedback with graceful rollback
   */
  async function toggleReaction(messageId: string, emojiId: string, userId: string): Promise<{
    success: boolean;
    reason?: string;
  }> {
    const toggleKey = `${messageId}-${emojiId}-${userId}`
    
    // Prevent rapid double-clicking (Discord behavior)
    if (pendingToggleRequests.value.has(toggleKey)) {
      return { success: false, reason: 'Request already in progress' }
    }

    pendingToggleRequests.value.add(toggleKey)

    try {
      // 1. INSTANT UI UPDATE (Discord-style)
      const currentlyHasReaction = hasUserReacted.value(messageId, emojiId, userId)
      const operation = currentlyHasReaction ? 'remove' : 'add'
      
      // Apply optimistic update immediately
      const optimisticOp: OptimisticOperation = {
        messageId,
        emojiId, 
        userId,
        operation,
        timestamp: Date.now()
      }
      
      optimisticOperations.value.set(toggleKey, optimisticOp)
      console.log(`⚡ Optimistic reaction ${operation} applied instantly`)

      // 2. BACKGROUND API CALL
      try {
        const result = await services.messages.toggleReaction(messageId, emojiId)
        console.log(`✅ Service layer reaction toggle: ${result.added ? 'added' : 'removed'}`)
        
        // 3. SUCCESS: Remove optimistic operation (let realtime handle final state)
        optimisticOperations.value.delete(toggleKey)
        
        // Refresh to get authoritative state from server
        setTimeout(() => {
          fetchMessageReactions(messageId, true)
        }, 100) // Small delay to let DB settle
        
        return { success: true }
        
      } catch (apiError: any) {
        console.error('❌ Service layer reaction toggle failed:', apiError)
        
        // 4. FAILURE: Rollback optimistic update (Discord-style)
        optimisticOperations.value.delete(toggleKey)
        console.log('🔄 Rolled back optimistic update due to API failure')
        
        return { success: false, reason: `API error: ${apiError.message}` }
      }
      
    } catch (error: any) {
      console.error('❌ Reaction toggle error:', error)
      
      // Rollback on any error
      optimisticOperations.value.delete(toggleKey)
      
      return { success: false, reason: `Toggle error: ${error.message}` }
    } finally {
      // Always clear the pending request lock
      pendingToggleRequests.value.delete(toggleKey)
    }
  }

  /**
   * Handle realtime updates (simplified)
   */
  async function handleRealtimeUpdate(payload: any): Promise<void> {
    const messageId = payload.new?.message_id || payload.old?.message_id
    
    if (!messageId) {
      console.warn('🎯 No message_id in realtime payload:', payload)
      return
    }

    console.log('🔄 Realtime reaction update for message:', messageId)
    
    // Simple approach: Just refresh the affected message's reactions
    // This will overwrite any stale optimistic updates with server truth
    lastFetched.value.delete(messageId) // Force refresh
    await fetchMessageReactions(messageId, true)
  }

  /**
   * Apply optimistic operation to reaction list
   */
  function applyOptimisticOperation(reactions: ReactionGroup[], op: OptimisticOperation): ReactionGroup[] {
    const { emojiId, userId, operation } = op
    
    // Find existing reaction group
    const existingIndex = reactions.findIndex(r => r.emoji_id === emojiId)
    
    if (operation === 'add') {
      if (existingIndex >= 0) {
        // Add user to existing group
        const existing = reactions[existingIndex]
        if (!existing.users.some(u => u.id === userId)) {
          existing.users.push({ 
            id: userId, 
            username: 'You', // Placeholder for current user
            avatar_url: '' 
          })
          existing.count = existing.users.length
        }
      } else {
        // Create new reaction group
        reactions.push({
          emoji_id: emojiId,
          emoji: { id: emojiId, name: 'unknown', url: '' } as Emoji, // Placeholder
          count: 1,
          users: [{ id: userId, username: 'You', avatar_url: '' }]
        })
      }
    } else if (operation === 'remove') {
      if (existingIndex >= 0) {
        const existing = reactions[existingIndex]
        existing.users = existing.users.filter(u => u.id !== userId)
        existing.count = existing.users.length
        
        // Remove group if no users left
        if (existing.count === 0) {
          reactions.splice(existingIndex, 1)
        }
      }
    }
    
    return reactions
  }

  /**
   * Clean up old optimistic operations (prevent memory leaks)
   */
  function cleanupStaleOptimisticOps(): void {
    const now = Date.now()
    const STALE_THRESHOLD = 10000 // 10 seconds
    
    for (const [key, op] of optimisticOperations.value.entries()) {
      if (now - op.timestamp > STALE_THRESHOLD) {
        optimisticOperations.value.delete(key)
        console.log('🧹 Cleaned up stale optimistic operation:', key)
      }
    }
  }

  // Cleanup timer
  setInterval(cleanupStaleOptimisticOps, 30000) // Every 30 seconds

  return {
    // State
    reactionsByMessage,
    
    // Getters
    getMessageReactions,
    hasUserReacted,
    isLoadingReactions,
    
    // Actions
    fetchMessageReactions,
    toggleReaction,
    handleRealtimeUpdate
  }
})
