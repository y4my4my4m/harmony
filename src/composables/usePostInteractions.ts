/**
 * Composable for managing post interactions with optimistic updates
 * Provides reactive state and handles interaction toggling
 */

import { ref, reactive, onMounted, onUnmounted, watch } from 'vue';
import { interactionService } from '@/services/InteractionService';
import type { TimelinePost } from '@/types';

interface PostInteractionState {
  is_favorited: boolean;
  is_reblogged: boolean;
  is_bookmarked: boolean;
  favorites_count: number;
  reblogs_count: number;
  loading: {
    favorite: boolean;
    reblog: boolean;
    bookmark: boolean;
  };
}

export function usePostInteractions(post: TimelinePost) {
  // Reactive state for this specific post
  const state = reactive<PostInteractionState>({
    is_favorited: post.is_favorited || false,
    is_reblogged: post.is_reblogged || false,
    is_bookmarked: false, // This will be loaded from the service
    favorites_count: post.favorites_count || 0,
    reblogs_count: post.reblogs_count || 0,
    loading: {
      favorite: false,
      reblog: false,
      bookmark: false
    }
  });

  const error = ref<string | null>(null);
  let unsubscribe: (() => void) | null = null;

  /**
   * Load interaction state from the service
   */
  const loadInteractionState = async () => {
    try {
      const serviceState = await interactionService.getPostInteractionState(post.id);
      
      // Update reactive state
      state.is_favorited = serviceState.is_favorited;
      state.is_reblogged = serviceState.is_reblogged;
      state.is_bookmarked = serviceState.is_bookmarked;
      state.favorites_count = serviceState.favorites_count;
      state.reblogs_count = serviceState.reblogs_count;
    } catch (err) {
      console.error('Failed to load interaction state:', err);
      error.value = err instanceof Error ? err.message : 'Unknown error';
    }
  };

  /**
   * Toggle favorite (like) interaction
   */
  const toggleFavorite = async () => {
    if (state.loading.favorite) return;
    
    state.loading.favorite = true;
    error.value = null;

    try {
      const result = await interactionService.toggleInteraction(post.id, 'favorite');
      
      if (!result.success && result.error) {
        error.value = result.error;
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to toggle favorite';
    } finally {
      state.loading.favorite = false;
    }
  };

  /**
   * Toggle reblog (share) interaction
   */
  const toggleReblog = async () => {
    if (state.loading.reblog) return;
    
    state.loading.reblog = true;
    error.value = null;

    try {
      const result = await interactionService.toggleInteraction(post.id, 'reblog');
      
      if (!result.success && result.error) {
        error.value = result.error;
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to toggle reblog';
    } finally {
      state.loading.reblog = false;
    }
  };

  /**
   * Toggle bookmark interaction
   */
  const toggleBookmark = async () => {
    if (state.loading.bookmark) return;
    
    state.loading.bookmark = true;
    error.value = null;

    try {
      const result = await interactionService.toggleInteraction(post.id, 'bookmark');
      
      if (!result.success && result.error) {
        error.value = result.error;
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to toggle bookmark';
    } finally {
      state.loading.bookmark = false;
    }
  };

  /**
   * Setup lifecycle hooks
   */
  onMounted(async () => {
    // Subscribe to interaction changes for this post
    unsubscribe = interactionService.onInteractionChange((postId, serviceState) => {
      if (postId === post.id) {
        state.is_favorited = serviceState.is_favorited;
        state.is_reblogged = serviceState.is_reblogged;
        state.is_bookmarked = serviceState.is_bookmarked;
        state.favorites_count = serviceState.favorites_count;
        state.reblogs_count = serviceState.reblogs_count;
      }
    });

    // Load initial interaction state
    await loadInteractionState();
  });

  onUnmounted(() => {
    if (unsubscribe) {
      unsubscribe();
    }
  });

  // Watch for post prop changes and reload state
  watch(() => post.id, async () => {
    await loadInteractionState();
  });

  return {
    state,
    error,
    toggleFavorite,
    toggleReblog,
    toggleBookmark,
    loadInteractionState
  };
}