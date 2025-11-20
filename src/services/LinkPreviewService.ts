import type { EmbedPayload, TimelinePost } from '@/types';

class LinkPreviewService {
  async hydrateHarmonyPost(payload: EmbedPayload): Promise<TimelinePost | null> {
    if (!payload?.harmony?.postId) {
      return null;
    }
    const { useActivityPubStore } = await import('@/stores/useActivityPub');
    const store = useActivityPubStore();

    const existing = this.findPostInFeeds(store, payload.harmony.postId);
    if (existing) {
      return existing;
    }

    return await store.loadPostWithAuthor(payload.harmony.postId);
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
}

export const linkPreviewService = new LinkPreviewService();

