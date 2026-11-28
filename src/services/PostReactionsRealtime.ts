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
  /** Post id to the number of mounted views showing it. */
  private viewsByPost = new Map<string, number>();
  private unsubscribeFn: (() => void) | null = null;

  subscribe(postId: string): void {
    this.viewsByPost.set(postId, (this.viewsByPost.get(postId) ?? 0) + 1);
    this.ensureHandler();
  }

  unsubscribe(postId: string): void {
    const views = this.viewsByPost.get(postId);
    if (views === undefined) return;
    if (views > 1) this.viewsByPost.set(postId, views - 1);
    else this.viewsByPost.delete(postId);
    if (this.viewsByPost.size === 0) {
      this.teardown();
    }
  }

  private ensureHandler(): void {
    if (this.unsubscribeFn) return;

    this.unsubscribeFn = userEventChannel.on('post:interaction', (data) => {
      const postId = data.post_id;
      if (!postId || !this.viewsByPost.has(postId)) return;

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
    this.viewsByPost.clear();
  }
}

export const postReactionsRealtime = new PostReactionsRealtimeService();
