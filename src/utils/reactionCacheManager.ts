import { useReactionsStore } from '@/stores/useReactions';

/**
 * Utility to manage reaction cache cleanup
 */
export class ReactionCacheManager {
  private cleanupInterval: number | null = null;
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

  /**
   * Start periodic cache cleanup
   */
  startCleanup() {
    if (this.cleanupInterval) return;

    this.cleanupInterval = window.setInterval(() => {
      const reactionsStore = useReactionsStore();
      reactionsStore.cleanupCache();
      console.log('🧹 Reaction cache cleanup completed');
    }, this.CLEANUP_INTERVAL);

    console.log('🧹 Reaction cache cleanup started');
  }

  /**
   * Stop periodic cache cleanup
   */
  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      console.log('🧹 Reaction cache cleanup stopped');
    }
  }

  /**
   * Manually trigger cache cleanup
   */
  cleanupNow() {
    const reactionsStore = useReactionsStore();
    reactionsStore.cleanupCache();
    console.log('🧹 Manual reaction cache cleanup completed');
  }
}

// Export singleton instance
export const reactionCacheManager = new ReactionCacheManager();
