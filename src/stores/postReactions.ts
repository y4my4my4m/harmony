import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

export interface PostReactionGroup {
  emoji_id: string | null
  emoji_name: string | null
  emoji_url: string | null
  custom_emoji_content: string | null
  reaction_count: number
  user_reactions: Array<{
    user_id: string
    username: string
    display_name: string
    avatar_url: string
    created_at: string
  }>
  current_user_reacted: boolean
}

/**
 * Post Reactions Store - Professional Architecture
 * 
 * Follows the same pattern as useReactions.ts for chat messages
 * Key principles:
 * 1. Batch loading to prevent N+1 queries
 * 2. Optimistic updates for instant UI feedback using REAL user data
 * 3. Limited user data (5 users max) for scalability
 * 4. Centralized state management
 * 5. Real-time subscription support
 * 
 * IMPROVEMENT: Follows exact same pattern as useReactions.ts for chat messages
 * - Minimal optimistic state (no user data in optimistic updates)
 * - Real user data comes from actual fetch after database update
 * - Prevents tooltip flashing by keeping user_reactions arrays stable
 */
export const usePostReactionsStore = defineStore('postReactions', () => {
  // State - Simple and clean
  const reactionsByPost = ref(new Map<string, PostReactionGroup[]>())
  const lastFetched = ref(new Map<string, number>())
  const isLoading = ref(new Set<string>())
  
  // Optimistic state - separate from computed properties
  const optimisticReactions = ref(new Map<string, PostReactionGroup[]>())
  const pendingToggleRequests = ref(new Set<string>())
  const pendingReconcileTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

  // Simple getters - no merging, no loops
  const getPostReactions = computed(() => (postId: string): PostReactionGroup[] => {
    if (!postId) return []
    
    // Check if we have optimistic state for this post
    const optimistic = optimisticReactions.value.get(postId)
    if (optimistic) {
      return optimistic
    }
    
    // Otherwise show real data
    return reactionsByPost.value.get(postId) || []
  })

  const hasUserReacted = computed(() => (postId: string, emojiId: string | null, customContent: string | null): boolean => {
    const reactions = getPostReactions.value(postId)
    const reaction = reactions.find(r => 
      (emojiId && r.emoji_id === emojiId) || 
      (customContent && r.custom_emoji_content === customContent)
    )
    return reaction?.current_user_reacted || false
  })

  const isLoadingReactions = computed(() => (postId: string): boolean => {
    return isLoading.value.has(postId)
  })

  // Actions
  async function fetchPostReactions(postId: string, force = false): Promise<void> {
    if (!postId) return

    const now = Date.now()
    const lastFetch = lastFetched.value.get(postId) || 0
    
    // Skip if recently fetched (unless forced)
    if (!force && now - lastFetch < 30000) return
    
    if (isLoading.value.has(postId)) return

    try {
      isLoading.value.add(postId)
      
      const { data, error } = await supabase.rpc('get_post_emoji_reactions', {
        p_post_id: postId,
        p_user_limit: 5 // Professional limit for scalability
      })

      if (error) {
        debug.error('❌ Failed to fetch post reactions:', error)
        return
      }

      reactionsByPost.value.set(postId, data || [])
      lastFetched.value.set(postId, now)
      
      debug.log(`✅ Fetched ${data?.length || 0} reaction groups for post ${postId}`)
    } catch (error) {
      debug.error('❌ Error fetching post reactions:', error)
    } finally {
      isLoading.value.delete(postId)
    }
  }

  /**
   * CRITICAL: Batch fetch reactions for multiple posts to avoid N+1 queries
   * This is essential for performance when loading timelines
   */
  let batchFetchInFlight: Promise<void> | null = null

  async function fetchMultiplePostReactions(postIds: string[], force = false): Promise<void> {
    if (!postIds.length) return

    // Deduplicate concurrent batch calls - return existing promise if in-flight
    if (batchFetchInFlight) {
      debug.log('📊 Batch fetch already in-flight, awaiting existing request')
      return batchFetchInFlight
    }

    const now = Date.now()
    
    // Filter out posts that are already cached (unless forced)
    const idsToFetch = force 
      ? postIds 
      : postIds.filter(id => {
          const lastFetch = lastFetched.value.get(id) || 0
          return now - lastFetch >= 30000
        })

    if (!idsToFetch.length) {
      debug.log('📊 All post reactions already cached, skipping fetch')
      return
    }

    // Mark all as loading
    idsToFetch.forEach(id => isLoading.value.add(id))

    const fetchPromise = (async () => {
      try {
        debug.log(`🔄 Batch fetching reactions for ${idsToFetch.length} posts`)
        
        const { data, error } = await supabase.rpc('get_batch_post_emoji_reactions', {
          p_post_ids: idsToFetch,
          p_user_limit: 5
        })

        if (error) {
          debug.error('❌ Failed to batch fetch post reactions:', error)
          return
        }

        // Group reactions by post_id
        const groupedReactions: Record<string, PostReactionGroup[]> = {}
        
        data?.forEach((reaction: any) => {
          const postId = reaction.post_id
          if (!groupedReactions[postId]) {
            groupedReactions[postId] = []
          }
          groupedReactions[postId].push({
            emoji_id: reaction.emoji_id,
            emoji_name: reaction.emoji_name,
            emoji_url: reaction.emoji_url,
            custom_emoji_content: reaction.custom_emoji_content,
            reaction_count: reaction.reaction_count,
            user_reactions: reaction.user_reactions || [],
            current_user_reacted: reaction.current_user_reacted
          })
        })

        // Update store with batched data
        Object.entries(groupedReactions).forEach(([postId, reactions]) => {
          reactionsByPost.value.set(postId, reactions)
          lastFetched.value.set(postId, now)
        })

        // Set empty arrays for posts with no reactions
        idsToFetch.forEach(postId => {
          if (!groupedReactions[postId]) {
            reactionsByPost.value.set(postId, [])
            lastFetched.value.set(postId, now)
          }
        })

        debug.log(`✅ Batch fetched reactions for ${idsToFetch.length} posts`)
      } catch (error) {
        debug.error('❌ Error in batch fetch:', error)
      } finally {
        idsToFetch.forEach(id => isLoading.value.delete(id))
        batchFetchInFlight = null
      }
    })()

    batchFetchInFlight = fetchPromise
    return fetchPromise
  }

  /**
   * Simple reaction toggle with instant UI feedback
   */
  async function toggleReaction(
    postId: string, 
    emoji: { id?: string; native?: string; name?: string; url?: string },
    userId: string
  ): Promise<{ success: boolean; reason?: string }> {
    const emojiKey = emoji.id || emoji.native || emoji.name
    const toggleKey = `${postId}-${emojiKey}-${userId}`
    
    // Prevent rapid clicking
    if (pendingToggleRequests.value.has(toggleKey)) {
      return { success: false, reason: 'duplicate_request' }
    }

    pendingToggleRequests.value.add(toggleKey)

    try {
      // Optimistic update
      const currentReactions = getPostReactions.value(postId)
      const existingReaction = currentReactions.find(r => 
        (emoji.id && r.emoji_id === emoji.id) || 
        (emoji.native && r.custom_emoji_content === emoji.native)
      )

      const operation = existingReaction?.current_user_reacted ? 'remove' : 'add'
      const newReactions = createOptimisticReactions(currentReactions, emoji, userId, operation)
      optimisticReactions.value.set(postId, newReactions)

      // Actual database update
      // Check if emoji.id is a valid UUID (server custom emoji) or native unicode
      const isUuid = emoji.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(emoji.id);
      const emojiId = isUuid ? emoji.id : null;
      const customContent = emoji.native || (!isUuid ? (emoji.id || emoji.name) : null);
      
      if (operation === 'remove') {
        const { error } = await supabase.rpc('remove_post_emoji_reaction', {
          p_user_id: userId,
          p_post_id: postId,
          p_emoji_id: emojiId,
          p_custom_emoji_content: customContent
        })
        if (error) throw error
      } else {
        const { error } = await supabase.rpc('add_post_emoji_reaction', {
          p_user_id: userId,
          p_post_id: postId,
          p_emoji_id: emojiId,
          p_custom_emoji_content: customContent
        })
        if (error) throw error
      }

      // Trigger federation for the reaction (async, don't block UI)
      try {
        const { FederationActivityService } = await import('@/services/federation/FederationActivityService')
        const federationService = FederationActivityService.getInstance()
        await federationService.createPostReactionActivity(
          postId, 
          emoji.id || emoji.native || emoji.name || 'unknown', // Handle different emoji types
          userId, 
          operation
        )
        debug.log(`✅ Federation: Post reaction ${operation} activity created for post ${postId}`)
      } catch (federationError) {
        debug.warn('⚠️ Federation failed, but local reaction succeeded:', federationError)
        // Don't fail the entire operation if federation fails - user experience first!
      }

      scheduleReconcile(postId, 1500)

      return { success: true }
    } catch (error: any) {
      debug.error('❌ Failed to toggle post reaction:', error)
      // Remove optimistic state on error
      optimisticReactions.value.delete(postId)
      return { success: false, reason: error.message }
    } finally {
      pendingToggleRequests.value.delete(toggleKey)
    }
  }

  /**
   * Create optimistic reaction state with real user data
   */
  function createOptimisticReactions(
    baseReactions: PostReactionGroup[], 
    emoji: { id?: string; native?: string; name?: string },
    userId: string, 
    operation: 'add' | 'remove'
  ): PostReactionGroup[] {
    const emojiId = emoji.id || null
    const customContent = emoji.native || null
    
    const reactions = [...baseReactions]
    const existingIndex = reactions.findIndex(r => 
      (emojiId && r.emoji_id === emojiId) || 
      (customContent && r.custom_emoji_content === customContent)
    )

    if (operation === 'remove' && existingIndex >= 0) {
      const existing = reactions[existingIndex]
      // Remove user from user_reactions array
      existing.user_reactions = existing.user_reactions?.filter(r => r.user_id !== userId) || []
      existing.reaction_count = existing.user_reactions.length
      existing.current_user_reacted = false
      
      // Remove group if empty
      if (existing.reaction_count === 0) {
        reactions.splice(existingIndex, 1)
      }
    } else if (operation === 'add') {
      if (existingIndex >= 0) {
        const existing = reactions[existingIndex]
        // SIMPLE: Just update count and user state, don't touch user_reactions
        // This prevents tooltip flashing and keeps tooltips accurate
        reactions[existingIndex] = {
          ...existing,
          reaction_count: existing.reaction_count + 1,
          current_user_reacted: true
          // Keep user_reactions unchanged - let real fetch handle user data
        }
      } else {
        // SIMPLE: Create minimal reaction group without user_reactions data
        // This prevents tooltips from showing during optimistic state
        reactions.push({
          emoji_id: emojiId,
          emoji_name: emoji.name || null,
          emoji_url: (emoji as any).url || null,
          custom_emoji_content: customContent,
          reaction_count: 1,
          user_reactions: [], // Empty - will be populated by real fetch  
          current_user_reacted: true
        })
      }
    }

    return reactions
  }

  /**
   * Schedule a reconcile fetch, deduplicating per post.
   * If one is already pending for this post, skips.
   */
  function scheduleReconcile(postId: string, delayMs: number): void {
    if (pendingReconcileTimeouts.has(postId)) return

    const timeoutId = setTimeout(async () => {
      pendingReconcileTimeouts.delete(postId)
      lastFetched.value.delete(postId)
      await fetchPostReactions(postId, true)
      optimisticReactions.value.delete(postId)
    }, delayMs)

    pendingReconcileTimeouts.set(postId, timeoutId)
  }

  /**
   * Real-time update handler - works with optimistic state.
   * If a reconcile is already scheduled (from toggleReaction), skip to avoid double-fetch.
   */
  async function handleRealtimeUpdate(payload: any): Promise<void> {
    const postId = payload.new?.post_id || payload.old?.post_id
    
    if (!postId) return

    debug.log('🔄 Realtime reaction update for post:', postId)
    
    if (pendingReconcileTimeouts.has(postId)) {
      debug.log('🔄 Reconcile already scheduled, skipping realtime refetch')
      return
    }

    if (optimisticReactions.value.has(postId)) {
      debug.log('🔄 Optimistic state present, scheduling reconcile')
      scheduleReconcile(postId, 1500)
      return
    }
    
    // No optimistic state - update immediately
    lastFetched.value.delete(postId)
    await fetchPostReactions(postId, true)
  }

  function $dispose() {
    // BUGS.md Pattern B / #4 v2: also wipe the Maps/Sets so we don't leak
    // the previous user's reactions / loading state across logout. Without
    // these, only the pending reconcile timeouts were cleared and the
    // actual reaction data + optimistic state survived into the next session.
    for (const timeoutId of pendingReconcileTimeouts.values()) {
      clearTimeout(timeoutId)
    }
    pendingReconcileTimeouts.clear()
    reactionsByPost.value.clear()
    lastFetched.value.clear()
    isLoading.value.clear()
    optimisticReactions.value.clear()
    pendingToggleRequests.value.clear()
  }

  return {
    reactionsByPost,
    getPostReactions,
    hasUserReacted,
    isLoadingReactions,
    fetchPostReactions,
    fetchMultiplePostReactions,
    toggleReaction,
    handleRealtimeUpdate,
    $dispose,
    clearOptimisticState: (postId: string) => optimisticReactions.value.delete(postId),
    bulkSetReactions: (reactionsData: Record<string, PostReactionGroup[]>) => {
      Object.entries(reactionsData).forEach(([postId, reactions]) => {
        reactionsByPost.value.set(postId, reactions)
        lastFetched.value.set(postId, Date.now())
      })
    }
  }
})
