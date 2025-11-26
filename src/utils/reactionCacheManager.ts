import { useReactionsStore } from '@/stores/useReactions';
import { debug } from '@/utils/debug'

/**
 * Utility to manage reaction cache cleanup
 * Note: The reactions store handles its own internal cleanup automatically
 */
export class ReactionCacheManager {
  /**
   * Clear optimistic state for a specific message
   * This is useful when you know a message has been deleted or needs fresh data
   */
  clearOptimisticState(messageId: string) {
    const reactionsStore = useReactionsStore();
    reactionsStore.clearOptimisticState(messageId);
    debug.log(`🧹 Cleared optimistic state for message ${messageId}`);
  }

  /**
   * Clear all cached reactions data
   * Only use this in extreme cases (user logout, data corruption, etc.)
   */
  clearAllCache() {
    const reactionsStore = useReactionsStore();
    // Force clear all cached data
    Object.keys(reactionsStore.reactionsByMessage).forEach(messageId => {
      reactionsStore.clearOptimisticState(messageId);
    });
    debug.log('🧹 Cleared all reaction cache data');
  }
}

// Export singleton instance
export const reactionCacheManager = new ReactionCacheManager();
