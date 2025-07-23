import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { services } from '@/services'
import type { ReactionGroup, Emoji } from '@/types'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'

export const useReactionsStore = defineStore('reactions', () => {
  // State - SIMPLE AND CLEAN
  const reactionsByMessage = ref(new Map<string, ReactionGroup[]>())
  const lastFetched = ref(new Map<string, number>())
  const isLoading = ref(new Set<string>())
  
  // Optimistic state - SEPARATE from computed properties
  const optimisticReactions = ref(new Map<string, ReactionGroup[]>()) // key: messageId
  const pendingToggleRequests = ref(new Set<string>())

  // Simple getters - NO MERGING, NO LOOPS
  const getMessageReactions = computed(() => (messageId: string): ReactionGroup[] => {
    if (!messageId) return []
    
    // Check if we have optimistic state for this message
    const optimistic = optimisticReactions.value.get(messageId)
    if (optimistic) {
      return optimistic // Show optimistic version
    }
    
    // Otherwise show real data
    return reactionsByMessage.value.get(messageId) || []
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
   * SIMPLE reaction toggle with instant UI feedback
   * emojiData is optional - if provided, uses it immediately for zero-delay rendering
   */
  async function toggleReaction(
    messageId: string, 
    emojiId: string, 
    userId: string, 
    emojiData?: Emoji
  ): Promise<{
    success: boolean;
    reason?: string;
  }> {
    const toggleKey = `${messageId}-${emojiId}-${userId}`
    
    // Prevent rapid clicking
    if (pendingToggleRequests.value.has(toggleKey)) {
      return { success: false, reason: 'Request already in progress' }
    }

    pendingToggleRequests.value.add(toggleKey)

    try {
      // 1. INSTANT UI UPDATE - Create optimistic version
      const currentReactions = reactionsByMessage.value.get(messageId) || []
      const currentlyHasReaction = hasUserReacted.value(messageId, emojiId, userId)
      const emojiCache = useEmojiCacheStore()
      
      const optimisticVersion = createOptimisticReactions(
        currentReactions, 
        emojiId, 
        userId, 
        currentlyHasReaction ? 'remove' : 'add',
        emojiData // Pass emoji data if available
      )
      
      // Show optimistic version immediately
      optimisticReactions.value.set(messageId, optimisticVersion)
      console.log(`⚡ Optimistic reaction ${currentlyHasReaction ? 'remove' : 'add'} applied instantly`)

      // 2. API CALL
      const result = await services.messages.toggleReaction(messageId, emojiId)
      console.log(`✅ Service layer reaction toggle: ${result.added ? 'added' : 'removed'}`)
      
      // 3. SUCCESS: Keep optimistic state! (No flash)  
      // Our optimistic state has real emoji data, so just keep it
      // Only update cache if emoji data was missing
      
      if (!emojiData && !emojiCache.getEmojiById(emojiId)) {
        // Only refresh if we used fallback emoji data
        setTimeout(() => {
          fetchMessageReactions(messageId, true)
        }, 1000) // Faster refresh if needed
      }
      
      return { success: true }
      
    } catch (error: any) {
      console.error('❌ Reaction toggle failed:', error)
      
      // ROLLBACK: Clear optimistic state immediately
      optimisticReactions.value.delete(messageId)
      
      return { success: false, reason: error.message }
    } finally {
      setTimeout(() => {
        pendingToggleRequests.value.delete(toggleKey)
      }, 100)
    }
  }

    /**
   * SMART realtime handling - works with optimistic state
   */
  async function handleRealtimeUpdate(payload: any): Promise<void> {
    const messageId = payload.new?.message_id || payload.old?.message_id
    
    if (!messageId) {
      console.warn('🎯 No message_id in realtime payload:', payload)
      return
    }

    console.log('🔄 Realtime reaction update for message:', messageId)
    
    // If we have fresh optimistic state, delay realtime to prevent flash
    if (optimisticReactions.value.has(messageId)) {
      console.log('🔄 Delaying realtime - optimistic update present')
      
      // Allow realtime updates after optimistic state has settled
      setTimeout(async () => {
        if (optimisticReactions.value.has(messageId)) {
          // Clear optimistic state and show real data
          optimisticReactions.value.delete(messageId)
        }
        lastFetched.value.delete(messageId)
        await fetchMessageReactions(messageId, true)
      }, 3000) // 3 second delay to let optimistic state be seen
      return
    }
    
    // No optimistic state - update immediately
    lastFetched.value.delete(messageId)
    await fetchMessageReactions(messageId, true)
  }

   /**
    * SIMPLE helper: Create optimistic reaction state
    */
   function createOptimisticReactions(
     baseReactions: ReactionGroup[], 
     emojiId: string, 
     userId: string, 
     operation: 'add' | 'remove',
     providedEmojiData?: Emoji
   ): ReactionGroup[] {
     // Deep clone to avoid mutations
     const result = JSON.parse(JSON.stringify(baseReactions)) as ReactionGroup[]
     
     if (operation === 'add') {
       const existingIndex = result.findIndex(r => r.emoji_id === emojiId)
       
       if (existingIndex >= 0) {
         // Add user to existing group
         const existing = result[existingIndex]
         if (!existing.reactions?.some(r => r.user_id === userId)) {
           existing.reactions = existing.reactions || []
           existing.reactions.push({ 
             reaction_id: 'temp-' + Date.now(), 
             user_id: userId 
           })
           existing.count = existing.reactions.length
         }
       } else {
         // Create new group with REAL emoji data (instant image!)
         let emoji: Emoji
         
         if (providedEmojiData) {
           // Use provided emoji data (fastest - zero lookup delay!)
           emoji = providedEmojiData
           console.log('⚡ Using provided emoji data:', emoji.name, emoji.url)
         } else {
           // Fallback to cache lookup
           const emojiCache = useEmojiCacheStore()
           const cachedEmojiData = emojiCache.getEmojiById(emojiId)
           
           if (cachedEmojiData) {
             emoji = cachedEmojiData
             console.log('✅ Found emoji in cache:', emoji.name, emoji.url)
           } else {
             emoji = {
               id: emojiId,
               name: 'unknown',
               url: '',
               server_id: '',
               uploader: '',
               created_at: '',
               updated_at: '',
               usage_count: 0,
               last_used: ''
             }
             console.warn('❌ Emoji not found in cache:', emojiId)
           }
         }
         
         result.push({
           emoji_id: emojiId,
           emoji: emoji,
           count: 1,
           reactions: [{ reaction_id: 'temp-' + Date.now(), user_id: userId }]
         })
       }
     } else if (operation === 'remove') {
       const existingIndex = result.findIndex(r => r.emoji_id === emojiId)
       
       if (existingIndex >= 0) {
         const existing = result[existingIndex]
         existing.reactions = existing.reactions?.filter(r => r.user_id !== userId) || []
         existing.count = existing.reactions.length
         
         // Remove group if empty
         if (existing.count === 0) {
           result.splice(existingIndex, 1)
         }
       }
     }
     
     return result
   }

   /**
    * SMART cleanup for optimistic state - let successful reactions stay
    */
   function cleanupOptimisticState(): void {
     // Only clean up very old optimistic state (30+ seconds)
     // Let successful reactions keep their optimistic state - no flash!
     const veryOldCutoff = Date.now() - 30000 // 30 seconds
     
     for (const [messageId] of optimisticReactions.value.entries()) {
       // For now, keep all optimistic state - only clear on error
       // This prevents any flashing and keeps the UI smooth
       // Real data will come via realtime naturally
     }
   }

   // Cleanup timer - much simpler
   setInterval(cleanupOptimisticState, 30000)

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
     handleRealtimeUpdate,
     
     // Utils
     clearOptimisticState: (messageId: string) => {
       optimisticReactions.value.delete(messageId)
     },
     
     // ✅ ARCHITECTURE FIX: Bulk set reactions from CoreMessageService batch loading
     bulkSetReactions: (reactionsData: Record<string, any[]>) => {
       const now = Date.now()
       Object.entries(reactionsData).forEach(([messageId, reactions]) => {
         reactionsByMessage.value.set(messageId, reactions)
         lastFetched.value.set(messageId, now)
       })
     }
   }
})
