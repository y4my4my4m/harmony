import { supabase } from '@/supabase';
import { usePostReactionsStore } from '@/stores/postReactions';
import { debug } from '@/utils/debug';
import type { RealtimeChannel } from '@supabase/supabase-js';

/**
 * Shared realtime subscription for post_interactions.
 * Instead of each PostReactions component creating its own channel,
 * this service manages a single channel and filters client-side.
 */
class PostReactionsRealtimeService {
  private channel: RealtimeChannel | null = null;
  private subscribedPostIds = new Set<string>();
  private refCount = 0;

  subscribe(postId: string): void {
    this.subscribedPostIds.add(postId);
    this.refCount++;
    this.ensureChannel();
  }

  unsubscribe(postId: string): void {
    this.subscribedPostIds.delete(postId);
    this.refCount--;
    if (this.refCount <= 0) {
      this.teardown();
    }
  }

  private ensureChannel(): void {
    if (this.channel) return;

    this.channel = supabase
      .channel('post_reactions_shared')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'post_interactions',
        },
        (payload) => {
          const postId = (payload.new as any)?.post_id || (payload.old as any)?.post_id;
          if (!postId || !this.subscribedPostIds.has(postId)) return;

          const interactionType =
            (payload.new as any)?.interaction_type || (payload.old as any)?.interaction_type;
          if (interactionType !== 'emoji_reaction') return;

          debug.log('🔔 Shared realtime reaction update for post:', postId);
          const store = usePostReactionsStore();
          store.handleRealtimeUpdate(payload);
        }
      )
      .subscribe();
  }

  private teardown(): void {
    if (this.channel) {
      supabase.removeChannel(this.channel);
      this.channel = null;
    }
    this.subscribedPostIds.clear();
    this.refCount = 0;
  }
}

export const postReactionsRealtime = new PostReactionsRealtimeService();
