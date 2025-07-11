/**
 * Professional Post Interaction Service
 * Handles favorites, reblogs, bookmarks with optimistic updates and race condition prevention
 */

import { supabase } from '@/supabase';
import { federationService } from './FederationService';
import type { PostInteraction } from '@/types';

interface PendingInteraction {
  type: 'favorite' | 'reblog' | 'bookmark';
  postId: string;
  isActive: boolean;
  timestamp: number;
  promise: Promise<any>;
}

interface InteractionState {
  is_favorited: boolean;
  is_reblogged: boolean;
  is_bookmarked: boolean;
  favorites_count: number;
  reblogs_count: number;
}

export class InteractionService {
  private static instance: InteractionService;
  private pendingInteractions = new Map<string, PendingInteraction>();
  private interactionStates = new Map<string, InteractionState>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  
  static getInstance(): InteractionService {
    if (!InteractionService.instance) {
      InteractionService.instance = new InteractionService();
    }
    return InteractionService.instance;
  }

  /**
   * Toggle post interaction with optimistic updates and race condition prevention
   */
  async toggleInteraction(
    postId: string, 
    type: 'favorite' | 'reblog' | 'bookmark'
  ): Promise<{ success: boolean; newState: boolean; error?: string }> {
    const interactionKey = `${postId}_${type}`;
    
    // Check if there's already a pending interaction
    if (this.pendingInteractions.has(interactionKey)) {
      console.log(`⏳ Interaction ${type} for post ${postId} already pending, waiting...`);
      try {
        await this.pendingInteractions.get(interactionKey)?.promise;
      } catch (error) {
        console.warn('Previous interaction failed:', error);
      }
    }

    // Clear any existing debounce timer
    if (this.debounceTimers.has(interactionKey)) {
      clearTimeout(this.debounceTimers.get(interactionKey)!);
    }

    // Get current state
    const currentState = await this.getPostInteractionState(postId);
    const currentValue = this.getInteractionValue(currentState, type);
    const newValue = !currentValue;

    // Apply optimistic update
    this.applyOptimisticUpdate(postId, type, newValue);

    // Create debounced operation
    const operation = this.createDebouncedOperation(postId, type, newValue);
    this.pendingInteractions.set(interactionKey, {
      type,
      postId,
      isActive: newValue,
      timestamp: Date.now(),
      promise: operation
    });

    try {
      const result = await operation;
      this.pendingInteractions.delete(interactionKey);
      return { success: true, newState: newValue };
    } catch (error) {
      // Rollback optimistic update on failure
      this.rollbackOptimisticUpdate(postId, type, currentValue);
      this.pendingInteractions.delete(interactionKey);
      
      console.error(`Failed to toggle ${type} for post ${postId}:`, error);
      return { 
        success: false, 
        newState: currentValue, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * Get current interaction state for a post
   */
  async getPostInteractionState(postId: string): Promise<InteractionState> {
    // Check cache first
    if (this.interactionStates.has(postId)) {
      return this.interactionStates.get(postId)!;
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return this.getDefaultInteractionState();
    }

    // Get post data and user interactions
    const [postData, interactionsData] = await Promise.all([
      supabase
        .from('posts')
        .select('favorites_count, reblogs_count')
        .eq('id', postId)
        .single(),
      supabase
        .from('post_interactions')
        .select('interaction_type')
        .eq('user_id', user.id)
        .eq('post_id', postId)
    ]);

    const interactions = interactionsData.data || [];
    const post = postData.data;

    const state: InteractionState = {
      is_favorited: interactions.some(i => i.interaction_type === 'favorite'),
      is_reblogged: interactions.some(i => i.interaction_type === 'reblog'),
      is_bookmarked: interactions.some(i => i.interaction_type === 'bookmark'),
      favorites_count: post?.favorites_count || 0,
      reblogs_count: post?.reblogs_count || 0
    };

    // Cache the state
    this.interactionStates.set(postId, state);
    return state;
  }

  /**
   * Apply optimistic update to cached state
   */
  private applyOptimisticUpdate(postId: string, type: 'favorite' | 'reblog' | 'bookmark', isActive: boolean) {
    const state = this.interactionStates.get(postId);
    if (!state) return;

    const newState = { ...state };
    
    if (type === 'favorite') {
      newState.is_favorited = isActive;
      newState.favorites_count += isActive ? 1 : -1;
    } else if (type === 'reblog') {
      newState.is_reblogged = isActive;
      newState.reblogs_count += isActive ? 1 : -1;
    } else if (type === 'bookmark') {
      newState.is_bookmarked = isActive;
    }

    this.interactionStates.set(postId, newState);
    
    // Emit state change event for UI updates
    this.emitStateChange(postId, newState);
  }

  /**
   * Rollback optimistic update on failure
   */
  private rollbackOptimisticUpdate(postId: string, type: 'favorite' | 'reblog' | 'bookmark', originalValue: boolean) {
    this.applyOptimisticUpdate(postId, type, originalValue);
  }

  /**
   * Create debounced database operation
   */
  private createDebouncedOperation(postId: string, type: 'favorite' | 'reblog' | 'bookmark', isActive: boolean): Promise<any> {
    return new Promise((resolve, reject) => {
      const interactionKey = `${postId}_${type}`;
      
      // Set debounce timer
      const timer = setTimeout(async () => {
        try {
          this.debounceTimers.delete(interactionKey);
          const result = await this.performDatabaseOperation(postId, type, isActive);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }, 300); // 300ms debounce

      this.debounceTimers.set(interactionKey, timer);
    });
  }

  /**
   * Perform the actual database operation
   */
  private async performDatabaseOperation(
    postId: string, 
    type: 'favorite' | 'reblog' | 'bookmark', 
    isActive: boolean
  ): Promise<PostInteraction | null> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    if (isActive) {
      // Add interaction
      const interaction = {
        user_id: user.id,
        post_id: postId,
        interaction_type: type,
        is_local: true,
        metadata: {}
      };

      const { data, error } = await supabase
        .from('post_interactions')
        .insert(interaction)
        .select()
        .single();

      if (error) {
        if (error.code === '23505') {
          // Already exists, this is fine - just return success
          console.log(`Interaction ${type} for post ${postId} already exists`);
          return null;
        }
        throw error;
      }

      // Handle federation for favorites and reblogs
      if (type === 'favorite' || type === 'reblog') {
        this.handleFederation(postId, type, isActive, user.id);
      }

      return data as PostInteraction;
    } else {
      // Remove interaction
      const { error } = await supabase
        .from('post_interactions')
        .delete()
        .eq('user_id', user.id)
        .eq('post_id', postId)
        .eq('interaction_type', type);

      if (error) throw error;

      // Handle federation for favorites and reblogs
      if (type === 'favorite' || type === 'reblog') {
        this.handleFederation(postId, type, isActive, user.id);
      }

      return null;
    }
  }

  /**
   * Handle ActivityPub federation asynchronously
   */
  private async handleFederation(postId: string, type: 'favorite' | 'reblog', isActive: boolean, userId: string) {
    try {
      if (type === 'favorite') {
        await federationService.federateLike(postId, userId, isActive);
      } else if (type === 'reblog') {
        await federationService.federateAnnounce(postId, userId, isActive);
      }
    } catch (federationError) {
      console.error(`❌ Federation failed for ${type}:`, federationError);
      // Don't throw - federation failures shouldn't break local interactions
    }
  }

  /**
   * Get interaction value from state
   */
  private getInteractionValue(state: InteractionState, type: 'favorite' | 'reblog' | 'bookmark'): boolean {
    switch (type) {
      case 'favorite': return state.is_favorited;
      case 'reblog': return state.is_reblogged;
      case 'bookmark': return state.is_bookmarked;
    }
  }

  /**
   * Get default interaction state
   */
  private getDefaultInteractionState(): InteractionState {
    return {
      is_favorited: false,
      is_reblogged: false,
      is_bookmarked: false,
      favorites_count: 0,
      reblogs_count: 0
    };
  }

  /**
   * Emit state change event for reactive updates
   */
  private emitStateChange(postId: string, state: InteractionState) {
    // Create custom event for components to listen to
    const event = new CustomEvent('post-interaction-change', {
      detail: { postId, state }
    });
    document.dispatchEvent(event);
  }

  /**
   * Subscribe to interaction state changes
   */
  onInteractionChange(callback: (postId: string, state: InteractionState) => void): () => void {
    const handler = (event: any) => {
      callback(event.detail.postId, event.detail.state);
    };

    document.addEventListener('post-interaction-change', handler);
    
    // Return cleanup function
    return () => {
      document.removeEventListener('post-interaction-change', handler);
    };
  }

  /**
   * Update interaction state from realtime events (prevents double-updates)
   */
  updateFromRealtime(postId: string, type: 'favorite' | 'reblog' | 'bookmark', delta: number) {
    const interactionKey = `${postId}_${type}`;
    
    // Don't apply realtime updates for pending interactions
    if (this.pendingInteractions.has(interactionKey)) {
      console.log(`🚫 Ignoring realtime update for pending interaction ${type} on post ${postId}`);
      return;
    }

    const state = this.interactionStates.get(postId);
    if (!state) return;

    const newState = { ...state };
    
    if (type === 'favorite') {
      newState.favorites_count += delta;
    } else if (type === 'reblog') {
      newState.reblogs_count += delta;
    }

    this.interactionStates.set(postId, newState);
    this.emitStateChange(postId, newState);
  }

  /**
   * Invalidate cached state for a post
   */
  invalidateCache(postId: string) {
    this.interactionStates.delete(postId);
  }

  /**
   * Clear all pending interactions (useful for cleanup)
   */
  clearPendingInteractions() {
    // Clear all debounce timers
    this.debounceTimers.forEach(timer => clearTimeout(timer));
    this.debounceTimers.clear();
    
    // Clear pending interactions
    this.pendingInteractions.clear();
    
    console.log('🧹 Cleared all pending interactions');
  }
}

// Export singleton instance
export const interactionService = InteractionService.getInstance();