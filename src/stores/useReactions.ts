import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Emoji } from '@/types';

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
  }),

  getters: {
    /**
     * Get reactions for a specific message
     */
    getMessageReactions: (state) => (messageId: string): ReactionGroup[] => {
      return state.reactionsByMessage.get(messageId) || [];
    },

    /**
     * Check if user has reacted with specific emoji
     */
    hasUserReacted: (state) => (messageId: string, emojiId: string, userId: string): boolean => {
      const reactions = state.reactionsByMessage.get(messageId) || [];
      const emojiGroup = reactions.find(r => r.emoji.id === emojiId);
      return emojiGroup?.reactions.some(r => r.user_id === userId) || false;
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
        const { data: reactions, error } = await supabase
          .rpc('get_message_reactions', { message_id: messageId });

        if (error) {
          console.error('Error fetching reactions for message:', messageId, error);
          return [];
        }

        const reactionGroups = reactions || [];
        this.reactionsByMessage.set(messageId, reactionGroups);
        this.lastFetched.set(messageId, Date.now());
        
        return reactionGroups;
      } catch (error) {
        console.error('Error fetching reactions:', error);
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
        console.log('🎯 Reaction toggle already in progress, ignoring duplicate request');
        return { success: false, reason: 'duplicate_request', message: 'Toggle already in progress' };
      }

      this.reactionToggleInProgress.add(toggleKey);
      this.toggleLockTimestamps.set(toggleKey, Date.now());
      console.log('🎯 Toggle lock acquired for:', toggleKey);

      try {
        // Get current state before any operations
        await this.fetchMessageReactions(messageId, true);
        const hasReacted = this.hasUserReacted(messageId, emojiId, userId);
        const isAdding = !hasReacted;

        console.log('🎯 Toggle reaction - User has reacted:', hasReacted, 'Will add:', isAdding);

        // Apply optimistic update for immediate UI feedback
        this.optimisticallyUpdateReaction(messageId, emojiId, userId, isAdding);

        if (hasReacted) {
          // Remove reaction
          const { error } = await supabase
            .from('reactions')
            .delete()
            .match({ message_id: messageId, emoji_id: emojiId, user_id: userId });

          if (error) {
            console.error('🎯 Error removing reaction:', error);
            this.revertOptimisticUpdate(messageId);
            return { success: false, reason: 'error', message: `Error removing reaction: ${error.message}` };
          }
          console.log('🎯 Reaction removed successfully');
        } else {
          // Try to add reaction
          const { error } = await supabase
            .from('reactions')
            .insert([{ 
              message_id: messageId, 
              emoji_id: emojiId,
              user_id: userId,
            }]);

          if (error) {
            // If duplicate error, check if the reaction now exists (race condition)
            if (error.code === '23505') {
              console.log('🎯 Duplicate reaction detected (race condition)');
              // Refresh cache to get latest state and check if reaction actually exists
              await this.fetchMessageReactions(messageId, true);
              const nowHasReacted = this.hasUserReacted(messageId, emojiId, userId);
              
              if (nowHasReacted) {
                console.log('🎯 Reaction was added by another process, treating as success');
                return { success: true };
              } else {
                console.error('🎯 Unexpected duplicate error state');
                this.revertOptimisticUpdate(messageId);
                return { success: false, reason: 'race_condition', message: 'Unexpected duplicate error state' };
              }
            }
            console.error('🎯 Error adding reaction:', error);
            this.revertOptimisticUpdate(messageId);
            return { success: false, reason: 'error', message: `Error adding reaction: ${error.message}` };
          }
          console.log('🎯 Reaction added successfully');
        }

        // Refresh reactions for this message to get the final state from server
        // This will overwrite the optimistic update with real data
        await this.fetchMessageReactions(messageId, true);
        return { success: true };
      } catch (error) {
        console.error('🎯 Error toggling reaction:', error);
        this.revertOptimisticUpdate(messageId);
        return { success: false, reason: 'error', message: `Exception during toggle: ${error}` };
      } finally {
        // Always remove the toggle lock
        this.reactionToggleInProgress.delete(toggleKey);
        this.toggleLockTimestamps.delete(toggleKey);
        console.log('🎯 Toggle lock cleared for:', toggleKey);
      }
    },

    /**
     * Optimistically update reaction state while API call is in progress
     */
    optimisticallyUpdateReaction(messageId: string, emojiId: string, userId: string, isAdding: boolean) {
      console.log('🎯 Optimistic update:', { messageId, emojiId, userId, isAdding });
      
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
        }
        // Note: We can't add new emoji groups optimistically without emoji data
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
      console.log('🎯 Optimistic update applied, new reaction count:', updatedReactions.length);
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
    handleRealtimeUpdate(payload: any) {
      const messageId = payload.new?.message_id || payload.old?.message_id;
      
      if (!messageId) {
        console.warn('🎯 No message_id found in reaction realtime payload, payload:', payload);
        return;
      }

      console.log('🎯 Handling realtime reaction update for message:', messageId);
      
      // Invalidate cache for this message and refetch
      this.lastFetched.delete(messageId);
      this.fetchMessageReactions(messageId, true);
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
