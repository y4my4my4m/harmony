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
     */
    async toggleReaction(messageId: string, emojiId: string, userId: string): Promise<boolean> {
      try {
        const hasReacted = this.hasUserReacted(messageId, emojiId, userId);

        if (hasReacted) {
          // Remove reaction
          const { error } = await supabase
            .from('reactions')
            .delete()
            .match({ message_id: messageId, emoji_id: emojiId, user_id: userId });

          if (error) {
            console.error('Error removing reaction:', error);
            return false;
          }
        } else {
          // Add reaction
          const { error } = await supabase
            .from('reactions')
            .insert([{ 
              message_id: messageId, 
              emoji_id: emojiId,
              user_id: userId,
            }]);

          if (error) {
            console.error('Error adding reaction:', error);
            return false;
          }
        }

        // Refresh reactions for this message
        await this.fetchMessageReactions(messageId, true);
        return true;
      } catch (error) {
        console.error('Error toggling reaction:', error);
        return false;
      }
    },

    /**
     * Handle real-time reaction updates
     */
    handleRealtimeUpdate(payload: any) {
      const messageId = payload.new?.message_id || payload.old?.message_id;
      
      if (!messageId) {
        console.warn('No message_id found in reaction realtime payload');
        return;
      }

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
    },

    /**
     * Update reactions cache when message is updated
     */
    updateMessageReactionsCache(messageId: string, reactions: ReactionGroup[]) {
      this.reactionsByMessage.set(messageId, reactions);
      this.lastFetched.set(messageId, Date.now());
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
