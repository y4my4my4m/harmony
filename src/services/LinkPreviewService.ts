import type { EmbedPayload, TimelinePost } from '@/types';

export class LinkPreviewService {
  async hydrateHarmonyPost(payload: EmbedPayload): Promise<TimelinePost | null> {
    if (!payload?.harmony?.postId) {
      return null;
    }
    const { useActivityPubStore } = await import('@/stores/useActivityPub');
    const store = useActivityPubStore();

    const existing = this.findPostInFeeds(store, payload.harmony.postId);
    if (existing) {
      this.ensurePostReactions(existing.id).catch((error) => {
        console.warn('Failed to preload reactions for Harmony embed:', error);
      });
      return existing;
    }

    const post = await store.loadPostWithAuthor(payload.harmony.postId);
    if (post) {
      this.ensurePostReactions(post.id).catch((error) => {
        console.warn('Failed to preload reactions for Harmony embed:', error);
      });
    }
    return post;
  }

  private findPostInFeeds(store: any, postId: string): TimelinePost | null {
    const feeds = [store.homeFeed, store.publicFeed, store.localFeed];
    for (const feed of feeds) {
      const found = feed.posts.find((post) => post.id === postId);
      if (found) {
        return found;
      }
    }
    return null;
  }

  private async ensurePostReactions(postId: string): Promise<void> {
    try {
      const { usePostReactionsStore } = await import('@/stores/postReactions');
      const reactionsStore = usePostReactionsStore();
      const existing = reactionsStore.getPostReactions(postId);
      if (Array.isArray(existing) && existing.length > 0) {
        return;
      }
      if (reactionsStore.isLoadingReactions(postId)) {
        return;
      }
      await reactionsStore.fetchPostReactions(postId);
    } catch (error) {
      console.warn('Failed to ensure post reactions:', error);
    }
  }
}

export const linkPreviewService = new LinkPreviewService();

