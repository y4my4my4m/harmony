import { supabase } from '@/supabase';
import type { EmbedPayload, TimelinePost } from '@/types';
import { normalizeEmbedUrl } from '@/utils/embedDetection';

interface LinkPreviewResponse {
  data?: EmbedPayload;
  cached?: boolean;
  error?: { message: string };
}

interface FetchOptions {
  forceRefresh?: boolean;
}

export class LinkPreviewService {
  private cache = new Map<string, EmbedPayload>();
  private inflight = new Map<string, Promise<EmbedPayload>>();
  private readonly cleanupInterval = 5 * 60 * 1000; // 5 minutes
  private lastCleanup = 0;

  async getPreview(url: string, options: FetchOptions = {}): Promise<EmbedPayload> {
    const cacheKey = this.getCacheKey(url);
    if (!cacheKey) {
      throw new Error('Invalid URL');
    }

    this.cleanupCacheIfNeeded();

    if (!options.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && !this.isExpired(cached)) {
        return cached;
      }
    }

    if (this.inflight.has(cacheKey)) {
      return this.inflight.get(cacheKey)!;
    }

    const request = this.invokeEdgeFunction(url)
      .then((payload) => {
        this.cache.set(cacheKey, payload);
        return payload;
      })
      .finally(() => {
        this.inflight.delete(cacheKey);
      });

    this.inflight.set(cacheKey, request);
    return request;
  }

  primeCache(payload: EmbedPayload): void {
    const key = payload.normalizedUrl || payload.url;
    if (key) {
      this.cache.set(key, payload);
    }
  }

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

  private async invokeEdgeFunction(url: string): Promise<EmbedPayload> {
    const { data, error } = await supabase.functions.invoke<LinkPreviewResponse>('link-preview', {
      body: { url },
    });

    if (error) {
      throw new Error(error.message || 'Failed to fetch link preview');
    }

    if (!data?.data) {
      throw new Error('Link preview payload missing');
    }

    return data.data;
  }

  private getCacheKey(url: string): string | null {
    return normalizeEmbedUrl(url);
  }

  private isExpired(payload: EmbedPayload): boolean {
    if (!payload?.expiresAt) {
      return true;
    }
    return Date.now() >= new Date(payload.expiresAt).getTime();
  }

  private cleanupCacheIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastCleanup < this.cleanupInterval) {
      return;
    }
    for (const [key, payload] of this.cache.entries()) {
      if (this.isExpired(payload)) {
        this.cache.delete(key);
      }
    }
    this.lastCleanup = now;
  }
}

export const linkPreviewService = new LinkPreviewService();

