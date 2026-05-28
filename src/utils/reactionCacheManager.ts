import { useReactionsStore } from '@/stores/useReactions';
import { debug } from '@/utils/debug'

const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_AGE = 10 * 60 * 1000; // 10 minutes

export class ReactionCacheManager {
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  clearOptimisticState(messageId: string) {
    const reactionsStore = useReactionsStore();
    reactionsStore.clearOptimisticState(messageId);
  }

  clearAllCache() {
    const reactionsStore = useReactionsStore();
    const map = reactionsStore.reactionsByMessage;
    if (map instanceof Map) {
      map.clear();
    }
    debug.log('🧹 Cleared all reaction cache data');
  }

  startCleanup() {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => {
      this.pruneStaleEntries();
    }, CLEANUP_INTERVAL);
  }

  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  private pruneStaleEntries() {
    try {
      const reactionsStore = useReactionsStore();
      const lastFetched = (reactionsStore as any).lastFetched;
      const reactionsByMessage = reactionsStore.reactionsByMessage;
      const now = Date.now();
      let pruned = 0;

      if (lastFetched instanceof Map && reactionsByMessage instanceof Map) {
        for (const [messageId, fetchedAt] of lastFetched) {
          if (now - fetchedAt > MAX_CACHE_AGE) {
            reactionsByMessage.delete(messageId);
            lastFetched.delete(messageId);
            pruned++;
          }
        }
      }

      if (pruned > 0) {
        debug.log(`🧹 Pruned ${pruned} stale reaction cache entries`);
      }
    } catch (e) {
      debug.error('Reaction cache cleanup error:', e);
    }
  }
}

export const reactionCacheManager = new ReactionCacheManager();
