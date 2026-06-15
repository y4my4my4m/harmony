import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { services } from '@/services'
import type { ReactionGroup, Emoji } from '@/types'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'
import { useProfileStore } from '@/stores/useProfile'
import { debug } from '@/utils/debug'
import { useUnifiedEmoji } from '@/services/unifiedEmojiService'

export const useReactionsStore = defineStore('reactions', () => {
  // State - SIMPLE AND CLEAN
  const reactionsByMessage = ref(new Map<string, ReactionGroup[]>())
  const lastFetched = ref(new Map<string, number>())
  const isLoading = ref(new Set<string>())
  
  // Optimistic state - SEPARATE from computed properties
  const optimisticReactions = ref(new Map<string, ReactionGroup[]>()) // key: messageId
  const pendingToggleRequests = ref(new Set<string>())
  const pendingReconcileTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

  const isUuid = (str: string): boolean =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str)

  function findReactionGroup(groups: ReactionGroup[], emojiId: string): ReactionGroup | undefined {
    if (isUuid(emojiId)) {
      return groups.find(r => r.emoji_id === emojiId)
    }
    return groups.find(r => !r.emoji_id && r.emoji?.name === emojiId)
  }

  function findReactionGroupIndex(groups: ReactionGroup[], emojiId: string): number {
    if (isUuid(emojiId)) {
      return groups.findIndex(r => r.emoji_id === emojiId)
    }
    return groups.findIndex(r => !r.emoji_id && r.emoji?.name === emojiId)
  }

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
    const reaction = findReactionGroup(reactions, emojiId)
    return reaction?.reactions?.some(r => r.user_id === userId) || false
  })

  const isLoadingReactions = computed(() => (messageId: string): boolean => {
    return isLoading.value.has(messageId)
  })

  // Actions
  async function fetchMessageReactions(messageId: string, force = false): Promise<void> {
    if (!messageId) return
    
    // Skip temp messages to avoid UUID errors
    if (messageId.startsWith('temp-')) {
      debug.log('⚠️ Skipping reaction fetch for temp message:', messageId)
      return
    }
    
    const now = Date.now()
    const lastFetch = lastFetched.value.get(messageId) || 0
    
    // Skip if recently fetched (unless forced)
    if (!force && now - lastFetch < 30000) return // 30 second cache
    
    if (isLoading.value.has(messageId)) return // Already loading

    try {
      isLoading.value.add(messageId)
      debug.log('🔄 Fetching reactions via service layer for message:', messageId)

      const reactions = await services.messages.getMessageReactions(messageId)

      // Store in cache. The service-layer return shape diverges slightly from
      // the legacy ReactionGroup the store consumes; cast to bridge the two
      // until the call sites are migrated to the new shape.
      reactionsByMessage.value.set(messageId, reactions as any)
      lastFetched.value.set(messageId, now)
      
      debug.log('✅ Successfully fetched reactions via service layer')
    } catch (error) {
      debug.error('❌ Failed to fetch reactions:', error)
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
      debug.log('✅ All message reactions already cached, skipping batch fetch')
      return
    }

    // Mark all as loading
    idsToFetch.forEach(id => isLoading.value.add(id))

    try {
      debug.log(`🔄 Batch fetching reactions for ${idsToFetch.length} messages via service layer`)

      // Use the core service directly for batch operations
      const batchReactions = await services.messages.getBatchMessageReactions(idsToFetch)
      
      // Store all results in cache. Same shape-bridge cast as `fetchMessageReactions`.
      for (const [messageId, reactions] of Object.entries(batchReactions)) {
        reactionsByMessage.value.set(messageId, reactions as any)
        lastFetched.value.set(messageId, now)
      }
      
      debug.log(`✅ Successfully batch fetched reactions for ${Object.keys(batchReactions).length} messages`)
    } catch (error) {
      debug.error('❌ Failed to batch fetch reactions:', error)
      
      // Fallback: fetch individually (graceful degradation)
      debug.log('🔄 Falling back to individual fetches...')
      const promises = idsToFetch.map(id => 
        fetchMessageReactions(id, force).catch(err => 
          debug.error(`❌ Failed individual fetch for ${id}:`, err)
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
    // You can only ever toggle your own reaction, so the actor is the current
    // user's profile id. Reactions are keyed on profiles.id; using the auth id
    // here made the highlight flicker off when optimistic state reconciled.
    const actorId = useProfileStore().profileId || userId
    const toggleKey = `${messageId}-${emojiId}-${actorId}`
    
    // Prevent rapid clicking
    if (pendingToggleRequests.value.has(toggleKey)) {
      return { success: false, reason: 'Request already in progress' }
    }

    pendingToggleRequests.value.add(toggleKey)

    try {
      // 1. INSTANT UI UPDATE - Create optimistic version
      const currentReactions = reactionsByMessage.value.get(messageId) || []
      const currentlyHasReaction = hasUserReacted.value(messageId, emojiId, actorId)
      
      const optimisticVersion = createOptimisticReactions(
        currentReactions, 
        emojiId, 
        actorId, 
        currentlyHasReaction ? 'remove' : 'add',
        emojiData // Pass emoji data if available
      )
      
      // Show optimistic version immediately
      optimisticReactions.value.set(messageId, optimisticVersion)
      debug.log(`⚡ Optimistic reaction ${currentlyHasReaction ? 'remove' : 'add'} applied instantly`)

      // 2. API CALL
      const result = await services.messages.toggleReaction(messageId, emojiId)
      debug.log(`✅ Service layer reaction toggle: ${result.added ? 'added' : 'removed'}`)
      
      // 3. SUCCESS: Schedule seamless transition from optimistic → real data
      // Fetch real data, THEN clear optimistic (no visual gap)
      scheduleReconcile(messageId, 1500)
      
      return { success: true }
      
    } catch (error: any) {
      debug.error('❌ Reaction toggle failed:', error)
      
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
   * Merge the latest server-side reaction data into the optimistic array
   * for `messageId` IN PLACE. This is the key trick that makes the
   * optimistic-to-real handover invisible: instead of replacing the
   * array (which can run leave/enter animations on Vue's `<TransitionGroup>`
   * if any key diverges between the optimistic and real shapes), we
   * mutate the existing groups so the same DOM nodes stay mounted and
   * only their inner counts/reactions arrays change.
   *
   * Returns true if the optimistic array was synced (and so the
   * computed will keep returning optimistic), false if there was no
   * optimistic state in the first place.
   */
  function getReactionGroupKey(g: ReactionGroup): string {
    return (g as any).emoji_id || (g as any).emoji?.name || (g as any).emoji?.content || 'unknown'
  }

  function syncOptimisticToReal(messageId: string): boolean {
    const optimistic = optimisticReactions.value.get(messageId)
    if (!optimistic) return false
    const real = reactionsByMessage.value.get(messageId) || []

    const realByKey = new Map<string, ReactionGroup>()
    for (const g of real) realByKey.set(getReactionGroupKey(g), g)

    // 1. Drop optimistic groups that no longer exist on the server.
    for (let i = optimistic.length - 1; i >= 0; i--) {
      if (!realByKey.has(getReactionGroupKey(optimistic[i]))) {
        optimistic.splice(i, 1)
      }
    }

    // 2. Update existing optimistic groups in place + append new ones.
    const optByKey = new Map<string, ReactionGroup>()
    for (const g of optimistic) optByKey.set(getReactionGroupKey(g), g)

    for (const realG of real) {
      const key = getReactionGroupKey(realG)
      const optG = optByKey.get(key)
      if (optG) {
        // Mutate: same object reference, same Vue-tracked identity.
        ;(optG as any).count = (realG as any).count
        ;(optG as any).reactions = (realG as any).reactions
        ;(optG as any).emoji = (realG as any).emoji
        ;(optG as any).emoji_id = (realG as any).emoji_id
      } else {
        optimistic.push(realG)
      }
    }
    return true
  }

  /**
   * Schedule a single reconcile (fetch real data + sync optimistic in place).
   * Deduplicates: if one is already pending for this message, skips.
   */
  function scheduleReconcile(messageId: string, delayMs: number): void {
    if (pendingReconcileTimeouts.has(messageId)) return

    const timeoutId = setTimeout(async () => {
      pendingReconcileTimeouts.delete(messageId)
      lastFetched.value.delete(messageId)
      await fetchMessageReactions(messageId, true)
      // Sync the latest server-side data INTO the existing optimistic
      // array (mutating in place) instead of replacing the array. This
      // keeps Vue's `<TransitionGroup>` from running leave→enter on
      // chips that already exist, eliminating the brief "disappear,
      // reappear" flicker users were seeing on every reaction toggle.
      const synced = syncOptimisticToReal(messageId)
      if (!synced) {
        // Defensive: nothing was optimistic, but the fetch above already
        // populated `reactionsByMessage`, so the computed already returns
        // the latest data. Nothing else to do.
      }
    }, delayMs)

    pendingReconcileTimeouts.set(messageId, timeoutId)
  }

  /**
   * Realtime handling - works with optimistic state.
   * If a reconcile is already scheduled (from toggleReaction), skip to avoid double-fetch.
   */
  async function handleRealtimeUpdate(payload: any): Promise<void> {
    const messageId = payload.new?.message_id || payload.old?.message_id
    
    if (!messageId) {
      debug.warn('🎯 No message_id in realtime payload:', payload)
      return
    }

    debug.log('🔄 Realtime reaction update for message:', messageId)
    
    if (pendingReconcileTimeouts.has(messageId)) {
      debug.log('🔄 Reconcile already scheduled, skipping realtime refetch')
      return
    }

    if (optimisticReactions.value.has(messageId)) {
      // Short reconcile so other users' reactions still appear quickly while
      // our own optimistic toggle is in flight.
      debug.log('🔄 Optimistic state present, scheduling reconcile from realtime')
      scheduleReconcile(messageId, 400)
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
       const existingIndex = findReactionGroupIndex(result, emojiId)
       
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
           debug.log('⚡ Using provided emoji data:', emoji.name, emoji.url)
         } else {
           // Fallback to cache lookup
           const emojiCache = useEmojiCacheStore()
           const cachedEmojiData = emojiCache.getEmojiById(emojiId)
           
           if (cachedEmojiData) {
             emoji = cachedEmojiData
             debug.log('✅ Found emoji in cache:', emoji.name, emoji.url)
           } else {
             // Check if this is a unicode/shortcode emoji (not a UUID)
             // UUIDs have format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
             const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(emojiId)
             
             if (!isUuid) {
               // Resolve via unifiedEmoji for the *display* fields (SVG URL or
               // unicode glyph), but keep `name` and `content` equal to the
               // raw `emojiId` so the optimistic group's identity matches what
               // the server stores in `custom_emoji_content`. MessageReactions'
               // `getReactionKey` falls back to `emoji.name` when `emoji_id`
               // is null - if optimistic uses the shortcode and the server
               // returns the raw content (or vice versa), the v-for keys
               // differ and TransitionGroup runs a leave→enter cycle that
               // looks like a reorder when the reconcile fires.
               const { resolveEmoji } = useUnifiedEmoji()
               const resolved = resolveEmoji(emojiId)
               
               debug.log('🎨 Resolving unicode/shortcode emoji:', emojiId, resolved)
               
               emoji = {
                 id: emojiId,
                 name: emojiId,
                 content: emojiId,
                 // For native pack, don't set URL (render as native).
                 // For twemoji pack, set the SVG URL so the chip renders the
                 // pack image instead of an empty span pre-reconcile.
                 url: resolved.display.type === 'svg' ? resolved.display.content : '',
                 native: resolved.unicode,
                 unicode: resolved.unicode,
                 server_id: '',
                 uploader: '',
                 usage_count: 0,
               } as any
             } else {
               // UUID emoji not found in cache
               emoji = {
                 id: emojiId,
                 name: 'unknown',
                 url: '',
                 server_id: '',
                 uploader: '',
                 usage_count: 0,
               } as any
               debug.warn('❌ Emoji not found in cache:', emojiId)
             }
           }
         }
         
        result.push({
          emoji_id: isUuid(emojiId) ? emojiId : null,
          emoji: emoji,
          count: 1,
          reactions: [{ reaction_id: 'temp-' + Date.now(), user_id: userId }]
        })
       }
    } else if (operation === 'remove') {
      const existingIndex = findReactionGroupIndex(result, emojiId)
       
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

  // NOTE: A 30 s `cleanupOptimisticState` interval used to run here. Its
  // body was a no-op loop ("real data will come via realtime naturally"),
  // so it produced no behavior but kept the event loop awake every 30 s
  // for the life of the tab. Removed - optimistic state is now cleared on
  // realtime confirmation or via the per-reaction reconcile timeout
  // tracked in `pendingReconcileTimeouts`.

  function $dispose() {
    // BUGS.md Pattern B / #4 v2: also wipe the data Maps/Sets so logout
    // doesn't leak the previous user's reactions across to the next user.
    for (const timeoutId of pendingReconcileTimeouts.values()) {
      clearTimeout(timeoutId)
    }
    pendingReconcileTimeouts.clear()
    reactionsByMessage.value.clear()
    lastFetched.value.clear()
    isLoading.value.clear()
    optimisticReactions.value.clear()
    pendingToggleRequests.value.clear()
  }

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
     
     // ARCHITECTURE FIX: Bulk set reactions from CoreMessageService batch loading
     bulkSetReactions: (reactionsData: Record<string, any[]>) => {
       const now = Date.now()
       Object.entries(reactionsData).forEach(([messageId, reactions]) => {
         reactionsByMessage.value.set(messageId, reactions)
         lastFetched.value.set(messageId, now)
       })
     },

     $dispose,
   }
})
