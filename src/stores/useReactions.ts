import { defineStore } from 'pinia';
import { services } from '@/services';
import type { Emoji } from '@/types';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';

export interface ReactionGroup {
  id: string;
  count: number;
  emoji: Emoji;
  reactions: Array<{
    reaction_id: string;
    user_id: string;
  }>;
  message_id: string;
}

export const useReactionsStore = defineStore('reactions', {
  state: () => ({
    // Cache reactions by message ID for efficient lookups
    reactionsByMessage: new Map<string, ReactionGroup[]>(),
    
    // Track loading states
    loadingReactions: new Set<string>(),
    
    // Cache validation
    cacheValidityDuration: 5 * 60 * 1000, // 5 minutes
    lastFetched: new Map<string, number>(),
    
    // Prevent rapid clicking/race conditions
    reactionToggleInProgress: new Set<string>(),
    
    // Track toggle lock timestamps for cleanup
    toggleLockTimestamps: new Map<string, number>(),
    
    // FIXED: Add realtime debouncing and optimistic update tracking
    realtimeDebounceTimers: new Map<string, NodeJS.Timeout>(),
    recentOptimisticUpdates: new Set<string>(),
  }),

  getters: {
    /**
     * Get reactions for a specific message
     */
    getMessageReactions: (state) => (messageId: string): ReactionGroup[] => {
      try {
        const reactions = state.reactionsByMessage.get(messageId) || [];
        // FIXED: Ensure we return valid reaction groups
        return reactions.filter(r => r && r.emoji && r.emoji.id);
      } catch (error) {
        console.error('❌ Error in getMessageReactions:', error, { messageId });
        return [];
      }
    },

    /**
     * Check if user has reacted with specific emoji
     */
    hasUserReacted: (state) => (messageId: string, emojiId: string, userId: string): boolean => {
      try {
        const reactions = state.reactionsByMessage.get(messageId) || [];
        const emojiGroup = reactions.find(r => r?.emoji?.id === emojiId);
        
        // FIXED: Add defensive checks for data structure
        if (!emojiGroup || !emojiGroup.reactions || !Array.isArray(emojiGroup.reactions)) {
          return false;
        }
        
        return emojiGroup.reactions.some(r => r?.user_id === userId) || false;
      } catch (error) {
        console.error('❌ Error in hasUserReacted:', error, { messageId, emojiId, userId });
        return false;
      }
    },

    /**
     * Check if reactions are currently loading for a message
     */
    isLoadingReactions: (state) => (messageId: string): boolean => {
      return state.loadingReactions.has(messageId);
    },

    /**
     * Check if cached reactions are still valid
     */
    isCacheValid: (state) => (messageId: string): boolean => {
      const lastFetch = state.lastFetched.get(messageId);
      if (!lastFetch) return false;
      return Date.now() - lastFetch < state.cacheValidityDuration;
    },
  },

  actions: {
    /**
     * Fetch reactions for a single message
     */
    async fetchMessageReactions(messageId: string, forceRefresh = false): Promise<ReactionGroup[]> {
      // Return cached data if valid and not forcing refresh
      if (!forceRefresh && this.isCacheValid(messageId)) {
        return this.getMessageReactions(messageId);
      }

      // Prevent duplicate requests
      if (this.loadingReactions.has(messageId)) {
        return new Promise((resolve) => {
          const checkLoading = () => {
            if (!this.loadingReactions.has(messageId)) {
              resolve(this.getMessageReactions(messageId));
            } else {
              setTimeout(checkLoading, 50);
            }
          };
          checkLoading();
        });
      }

      this.loadingReactions.add(messageId);

      try {
        console.log('🔄 Fetching reactions via service layer for message:', messageId);
        
        const reactionGroups = await services.messages.getMessageReactions(messageId);
        
        this.reactionsByMessage.set(messageId, reactionGroups);
        this.lastFetched.set(messageId, Date.now());
        
        console.log('✅ Successfully fetched reactions via service layer');
        return reactionGroups;
      } catch (error) {
        console.error('❌ Error fetching reactions via service layer:', error);
        return [];
      } finally {
        this.loadingReactions.delete(messageId);
      }
    },

    /**
     * Batch fetch reactions for multiple messages
     */
    async fetchMultipleMessageReactions(messageIds: string[], forceRefresh = false): Promise<void> {
      const idsToFetch = forceRefresh 
        ? messageIds 
        : messageIds.filter(id => !this.isCacheValid(id));

      if (idsToFetch.length === 0) return;

      // Use Promise.allSettled to prevent one failure from affecting others
      const promises = idsToFetch.map(id => this.fetchMessageReactions(id, forceRefresh));
      await Promise.allSettled(promises);
    },

    /**
     * Add or remove a reaction
     * @returns Object with success status and reason for failure
     */
    async toggleReaction(messageId: string, emojiId: string, userId: string): Promise<{
      success: boolean;
      reason?: 'duplicate_request' | 'error' | 'race_condition';
      message?: string;
    }> {
      const toggleKey = `${messageId}-${emojiId}-${userId}`;
      
      // Clean up old stuck locks first
      this.cleanupStuckLocks();
      
      // Prevent rapid double-clicking
      if (this.reactionToggleInProgress.has(toggleKey)) {
        // console.log('🎯 Reaction toggle already in progress, ignoring duplicate request');
        return { success: false, reason: 'duplicate_request', message: 'Toggle already in progress' };
      }

      this.reactionToggleInProgress.add(toggleKey);
      this.toggleLockTimestamps.set(toggleKey, Date.now());
      // console.log('🎯 Toggle lock acquired for:', toggleKey);

      try {
        // Get current state before any operations
        await this.fetchMessageReactions(messageId, true);
        const hasReacted = this.hasUserReacted(messageId, emojiId, userId);
        const isAdding = !hasReacted;

        // console.log('🎯 Toggle reaction - User has reacted:', hasReacted, 'Will add:', isAdding);

        // Apply optimistic update for immediate UI feedback
        this.optimisticallyUpdateReaction(messageId, emojiId, userId, isAdding);

        // FIXED: Mark this message as having a recent optimistic update
        this.recentOptimisticUpdates.add(messageId);

        // Use service layer for reaction toggle with race condition handling
        try {
          console.log('🔄 Using service layer for reaction toggle');
          const result = await services.messages.toggleReaction(messageId, emojiId);
          
          if (result.hadRaceCondition) {
            console.log('🎯 Service layer handled race condition successfully');
          }
          
          console.log(`✅ Service layer reaction toggle: ${result.added ? 'added' : 'removed'}`);
        } catch (error: any) {
          console.error('❌ Service layer reaction toggle failed:', error);
          this.revertOptimisticUpdate(messageId);
          
          // FIXED: Clear optimistic flag on service error too
          this.recentOptimisticUpdates.delete(messageId);
          
          return { success: false, reason: 'error', message: `Service layer error: ${error.message}` };
        }

        // Refresh reactions for this message to get the final state from server
        // This will overwrite the optimistic update with real data
        await this.fetchMessageReactions(messageId, true);
        
        // FIXED: Clear optimistic flag after successful completion
        setTimeout(() => {
          this.recentOptimisticUpdates.delete(messageId);
        }, 500);
        
        return { success: true };
      } catch (error) {
        console.error('🎯 Error toggling reaction:', error);
        this.revertOptimisticUpdate(messageId);
        
        // FIXED: Clear optimistic flag on error too
        this.recentOptimisticUpdates.delete(messageId);
        
        return { success: false, reason: 'error', message: `Exception during toggle: ${error}` };
      } finally {
        // Always remove the toggle lock
        this.reactionToggleInProgress.delete(toggleKey);
        this.toggleLockTimestamps.delete(toggleKey);
        // console.log('🎯 Toggle lock cleared for:', toggleKey);
      }
    },

    /**
     * Optimistically update reaction state while API call is in progress
     */
    optimisticallyUpdateReaction(messageId: string, emojiId: string, userId: string, isAdding: boolean) {
      // console.log('🎯 Optimistic update:', { messageId, emojiId, userId, isAdding });
      
      const currentReactions = this.getMessageReactions(messageId);
      const updatedReactions = [...currentReactions];
      
      const existingGroupIndex = updatedReactions.findIndex(r => r.emoji.id === emojiId);
      
      if (isAdding) {
        if (existingGroupIndex >= 0) {
          // Add user to existing group
          const existingGroup = updatedReactions[existingGroupIndex];
          if (!existingGroup.reactions.some(r => r.user_id === userId)) {
            updatedReactions[existingGroupIndex] = {
              ...existingGroup,
              count: existingGroup.count + 1,
              reactions: [...existingGroup.reactions, { reaction_id: 'temp', user_id: userId }]
            };
          }
        } else {
          // Create new reaction group for first reaction
          // Try to get emoji data from the emoji cache
          const emojiCacheStore = useEmojiCacheStore();
          const emojiData = emojiCacheStore.getEmojiById(emojiId);
          
          if (emojiData) {
            const newReactionGroup: ReactionGroup = {
              id: `temp-${emojiId}`, // Temporary ID for optimistic update
              count: 1,
              emoji: emojiData,
              reactions: [{ reaction_id: 'temp', user_id: userId }],
              message_id: messageId
            };
            updatedReactions.push(newReactionGroup);
            // console.log('🎯 Created new reaction group optimistically:', emojiData.name);
          } else {
            console.log('🎯 Could not create new reaction group optimistically - emoji data not cached');
          }
        }
      } else {
        if (existingGroupIndex >= 0) {
          // Remove user from existing group
          const existingGroup = updatedReactions[existingGroupIndex];
          const userReactionIndex = existingGroup.reactions.findIndex(r => r.user_id === userId);
          
          if (userReactionIndex >= 0) {
            const newReactions = existingGroup.reactions.filter((_, index) => index !== userReactionIndex);
            
            if (newReactions.length === 0) {
              // Remove the entire group if no reactions left
              updatedReactions.splice(existingGroupIndex, 1);
            } else {
              // Update the group
              updatedReactions[existingGroupIndex] = {
                ...existingGroup,
                count: existingGroup.count - 1,
                reactions: newReactions
              };
            }
          }
        }
      }
      
      // Update cache with optimistic state
      this.reactionsByMessage.set(messageId, updatedReactions);
      // console.log('🎯 Optimistic update applied, new reaction count:', updatedReactions.length);
    },

    /**
     * Revert optimistic update if API call fails
     */
    revertOptimisticUpdate(messageId: string) {
      // Force refresh from server to get true state
      this.fetchMessageReactions(messageId, true);
    },

    /**
     * Handle real-time reaction updates
     */
    async handleRealtimeUpdate(payload: any) {
      const messageId = payload.new?.message_id || payload.old?.message_id;
      
      if (!messageId) {
        console.warn('🎯 No message_id found in reaction realtime payload, payload:', payload);
        
        // WORKAROUND: For DELETE events that only have reaction.id due to REPLICA IDENTITY issues
        if (payload.eventType === 'DELETE' && payload.old?.id) {
          console.log('🎯 Using fallback: refreshing all cached reactions due to missing message_id in DELETE event');
          
          // Refresh all cached reactions as fallback
          // This is not ideal but ensures consistency until REPLICA IDENTITY FULL works properly
          const messageIds = Array.from(this.reactionsByMessage.keys());
          for (const msgId of messageIds) {
            this.lastFetched.delete(msgId);
            this.fetchMessageReactions(msgId, true);
          }
        }
        return;
      }

      console.log('🎯 Handling realtime reaction update for message:', messageId);
      
      // FIXED: Add debouncing to prevent rapid successive fetches that conflict with optimistic updates
      const debounceKey = `realtime_${messageId}`;
      
      // Clear any existing timer for this message
      if (this.realtimeDebounceTimers.has(debounceKey)) {
        clearTimeout(this.realtimeDebounceTimers.get(debounceKey));
      }
      
      // Set a debounced fetch
      const timer = setTimeout(() => {
        // Only fetch if this wasn't our own optimistic update
        if (!this.recentOptimisticUpdates.has(messageId)) {
          console.log('🔄 Fetching reactions from realtime update');
          this.lastFetched.delete(messageId);
          this.fetchMessageReactions(messageId, true);
        } else {
          console.log('🔄 Skipping realtime fetch - was our own optimistic update');
          // Clear the optimistic flag after a delay
          setTimeout(() => {
            this.recentOptimisticUpdates.delete(messageId);
          }, 1000);
        }
        this.realtimeDebounceTimers.delete(debounceKey);
      }, 300); // 300ms debounce
      
      this.realtimeDebounceTimers.set(debounceKey, timer);
    },

    /**
     * Clear reactions cache for a specific message
     */
    clearMessageReactions(messageId: string) {
      this.reactionsByMessage.delete(messageId);
      this.lastFetched.delete(messageId);
    },

    /**
     * Clear all cached reactions
     */
    clearAllReactions() {
      this.reactionsByMessage.clear();
      this.lastFetched.clear();
      this.loadingReactions.clear();
      this.reactionToggleInProgress.clear();
      this.toggleLockTimestamps.clear();
    },

    /**
     * Clear stuck toggle locks (for debugging)
     */
    clearToggleLocks() {
      const size = this.reactionToggleInProgress.size;
      this.reactionToggleInProgress.clear();
      this.toggleLockTimestamps.clear();
      console.log(`🎯 Cleared ${size} stuck toggle locks`);
    },

    /**
     * Clean up toggle locks that are older than 10 seconds
     */
    cleanupStuckLocks() {
      const cutoff = Date.now() - 10000; // 10 seconds
      let cleaned = 0;
      
      for (const [toggleKey, timestamp] of this.toggleLockTimestamps.entries()) {
        if (timestamp < cutoff) {
          this.reactionToggleInProgress.delete(toggleKey);
          this.toggleLockTimestamps.delete(toggleKey);
          cleaned++;
        }
      }
      
      if (cleaned > 0) {
        console.log(`🎯 Cleaned up ${cleaned} stuck toggle locks`);
      }
    },

    /**
     * Get debug info about current state
     */
    getDebugInfo() {
      return {
        cachedMessages: Array.from(this.reactionsByMessage.keys()),
        loadingMessages: Array.from(this.loadingReactions),
        activeLocks: Array.from(this.reactionToggleInProgress),
        lockTimestamps: Object.fromEntries(this.toggleLockTimestamps),
        cacheCount: this.reactionsByMessage.size
      };
    },

    /**
     * Clean up old cache entries to prevent memory leaks
     */
    cleanupCache() {
      const cutoff = Date.now() - (this.cacheValidityDuration * 2); // Keep for 2x validity duration
      
      for (const [messageId, timestamp] of this.lastFetched.entries()) {
        if (timestamp < cutoff) {
          this.reactionsByMessage.delete(messageId);
          this.lastFetched.delete(messageId);
        }
      }
    },
  },
});
