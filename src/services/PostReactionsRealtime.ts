import { userEventChannel } from '@/services/UserEventChannel';
import { usePostReactionsStore } from '@/stores/postReactions';
import { debug } from '@/utils/debug';

/**
 * Post reactions realtime service.
 *
 * Previously used a global CDC subscription on post_interactions,
 * which sent every interaction to every connected client.
 *
 * Now listens on the user:{id} broadcast channel for post:interaction
 * events, which are only delivered to the post author.
 * Non-author viewers get updated counts on next load/refetch.
 */
class PostReactionsRealtimeService {
  private subscribedPostIds = new Set<string>();
  private refCount = 0;
  private unsubscribeFn: (() => void) | null = null;

  subscribe(postId: string): void {
    this.subscribedPostIds.add(postId);
    this.refCount++;
    this.ensureHandler();
  }

  unsubscribe(postId: string): void {
    this.subscribedPostIds.delete(postId);
    this.refCount--;
    if (this.refCount <= 0) {
      this.teardown();
    }
  }

  private ensureHandler(): void {
    if (this.unsubscribeFn) return;

    this.unsubscribeFn = userEventChannel.on('post:interaction', (data) => {
      const postId = data.post_id;
      if (!postId || !this.subscribedPostIds.has(postId)) return;

      if (data.interaction_type !== 'emoji_reaction') return;

      debug.log('Post reaction via broadcast for post:', postId);
      const store = usePostReactionsStore();

      if (data.op === 'INSERT') {
        store.handleRealtimeUpdate({
          eventType: 'INSERT',
          new: { post_id: postId, interaction_type: data.interaction_type, user_id: data.user_id, emoji_id: data.emoji_id },
          old: {}
        });
      } else if (data.op === 'DELETE') {
        store.handleRealtimeUpdate({
          eventType: 'DELETE',
          old: { post_id: postId, interaction_type: data.interaction_type, user_id: data.user_id, emoji_id: data.emoji_id },
          new: {}
        });
      }
    });
  }

  private teardown(): void {
    if (this.unsubscribeFn) {
      this.unsubscribeFn();
      this.unsubscribeFn = null;
    }
    this.subscribedPostIds.clear();
    this.refCount = 0;
  }
}

export const postReactionsRealtime = new PostReactionsRealtimeService();
