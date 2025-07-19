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
  
  // Realtime debouncing
  const realtimeDebounceTimers = ref(new Map<string, NodeJS.Timeout>())

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
    // FIXED: Use 'reactions' array with user_id, not 'users' array with id
    return reaction?.reactions?.some(r => r.user_id === userId) || false
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
   * CRITICAL: Batch fetch reactions for multiple messages to avoid N+1 queries
   * This is essential for performance when loading chat history
   */
  async function fetchMultipleMessageReactions(messageIds: string[], force = false): Promise<void> {
    if (!messageIds.length) return

    const now = Date.now()
    
    // Filter out messages that are already cached (unless forced)
    const idsToFetch = force 
      ? messageIds 
      : messageIds.filter(id => {
          const lastFetch = lastFetched.value.get(id) || 0
          return now - lastFetch >= 30000 // 30 second cache
        })

    if (!idsToFetch.length) {
      console.log('✅ All message reactions already cached, skipping batch fetch')
      return
    }

    // Mark all as loading
    idsToFetch.forEach(id => isLoading.value.add(id))

    try {
      console.log(`🔄 Batch fetching reactions for ${idsToFetch.length} messages via service layer`)

      // Use the core service directly for batch operations
      const batchReactions = await services.messages.getBatchMessageReactions(idsToFetch)
      
      // Store all results in cache
      for (const [messageId, reactions] of Object.entries(batchReactions)) {
        reactionsByMessage.value.set(messageId, reactions)
        lastFetched.value.set(messageId, now)
      }
      
      console.log(`✅ Successfully batch fetched reactions for ${Object.keys(batchReactions).length} messages`)
    } catch (error) {
      console.error('❌ Failed to batch fetch reactions:', error)
      
      // Fallback: fetch individually (graceful degradation)
      console.log('🔄 Falling back to individual fetches...')
      const promises = idsToFetch.map(id => 
        fetchMessageReactions(id, force).catch(err => 
          console.error(`❌ Failed individual fetch for ${id}:`, err)
        )
      )
      await Promise.allSettled(promises)
    } finally {
      // Clear loading state for all
      idsToFetch.forEach(id => isLoading.value.delete(id))
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
   * Handle realtime updates (Discord-style with smart debouncing)
   */
  async function handleRealtimeUpdate(payload: any): Promise<void> {
    const messageId = payload.new?.message_id || payload.old?.message_id
    
    if (!messageId) {
      console.warn('🎯 No message_id in realtime payload:', payload)
      return
    }

    console.log('🔄 Realtime reaction update for message:', messageId)
    
    // PERFORMANCE: Check if we have a recent optimistic update for this message
    const recentOptimistic = Array.from(optimisticOperations.value.values())
      .some(op => op.messageId === messageId && (Date.now() - op.timestamp) < 2000) // 2 seconds
    
    if (recentOptimistic) {
      console.log('🔄 Skipping realtime fetch - recent optimistic update detected')
      // Clear optimistic operation after a delay to let it settle
      setTimeout(() => {
        const keysToDelete = Array.from(optimisticOperations.value.entries())
          .filter(([_, op]) => op.messageId === messageId)
          .map(([key, _]) => key)
        
        keysToDelete.forEach(key => optimisticOperations.value.delete(key))
        
        // Now do a single refresh
        lastFetched.value.delete(messageId)
        fetchMessageReactions(messageId, true)
      }, 1000)
      return
    }
    
    // DEBOUNCED: Prevent multiple rapid fetches for the same message
    const debounceKey = `realtime-${messageId}`
    const existingTimer = realtimeDebounceTimers.get(debounceKey)
    
    if (existingTimer) {
      clearTimeout(existingTimer)
    }
    
    const timer = setTimeout(() => {
      lastFetched.value.delete(messageId) // Force refresh
      fetchMessageReactions(messageId, true)
      realtimeDebounceTimers.delete(debounceKey)
    }, 300) // 300ms debounce
    
    realtimeDebounceTimers.set(debounceKey, timer)
  }

     /**
    * Apply optimistic operation to reaction list
    * FIXED: Use correct data structure matching CoreMessageService output
    */
   function applyOptimisticOperation(reactions: ReactionGroup[], op: OptimisticOperation): ReactionGroup[] {
     const { emojiId, userId, operation } = op
     
     // Find existing reaction group
     const existingIndex = reactions.findIndex(r => r.emoji_id === emojiId)
     
     if (operation === 'add') {
       if (existingIndex >= 0) {
         // Add user to existing group
         const existing = reactions[existingIndex]
         // FIXED: Use 'reactions' array, not 'users'
         if (!existing.reactions?.some(r => r.user_id === userId)) {
           if (!existing.reactions) existing.reactions = []
           existing.reactions.push({ 
             reaction_id: 'optimistic-' + Date.now(),
             user_id: userId
           })
           existing.count = existing.reactions.length
         }
       } else {
         // Create new reaction group
         reactions.push({
           emoji_id: emojiId,
           emoji: { id: emojiId, name: 'unknown', url: '' } as Emoji, // Placeholder
           count: 1,
           reactions: [{ 
             reaction_id: 'optimistic-' + Date.now(),
             user_id: userId 
           }]
         })
       }
     } else if (operation === 'remove') {
       if (existingIndex >= 0) {
         const existing = reactions[existingIndex]
         // FIXED: Use 'reactions' array, not 'users'
         if (existing.reactions) {
           existing.reactions = existing.reactions.filter(r => r.user_id !== userId)
           existing.count = existing.reactions.length
           
           // Remove group if no reactions left
           if (existing.count === 0) {
             reactions.splice(existingIndex, 1)
           }
         }
       }
     }
     
     return reactions
   }

     /**
    * Clean up old optimistic operations and timers (prevent memory leaks)
    */
   function cleanupStaleOptimisticOps(): void {
     const now = Date.now()
     const STALE_THRESHOLD = 10000 // 10 seconds
     
     // Clean up stale optimistic operations
     for (const [key, op] of optimisticOperations.value.entries()) {
       if (now - op.timestamp > STALE_THRESHOLD) {
         optimisticOperations.value.delete(key)
         console.log('🧹 Cleaned up stale optimistic operation:', key)
       }
     }
     
     // Clean up stale realtime debounce timers
     for (const [key, timer] of realtimeDebounceTimers.value.entries()) {
       // Clear very old timers (shouldn't happen but safety)
       if (key.includes('realtime-')) {
         clearTimeout(timer)
         realtimeDebounceTimers.value.delete(key)
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
     fetchMultipleMessageReactions, // CRITICAL: Batch fetch to avoid N+1
     toggleReaction,
     handleRealtimeUpdate
   }
})
