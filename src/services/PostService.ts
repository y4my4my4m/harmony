/**
 * PostService - Simplified post management (TRUSTS DATABASE TRIGGERS)
 * 
 * OPTIMIZATION: Simplified to trust your excellent database federation triggers
 * - CorePostService: Pure local database operations
 * - Database triggers: handle_post_federation() / handle_unified_content_federation()
 * - NO manual federation decisions or activity creation needed
 * 
 * PRESERVED APIs: 
 * - ✅ Same method signatures as before
 * - ✅ Same return types and error formats
 * - ✅ Same loading patterns and pagination
 * - ✅ Same local-first design (immediate UI updates)
 * 
 * SIMPLIFIED ARCHITECTURE:
 * - Trust database triggers for all federation
 * - Eliminate unnecessary federation service calls
 * - Reduce database round trips significantly
 */

import { supabase } from '@/supabase'
import type { Post, TimelinePost, MessagePart } from '@/types'

// Import only core service - database handles federation
import { corePostService } from './core'

export interface CreatePostData {
  content: MessagePart[]
  visibility: 'public' | 'unlisted' | 'followers' | 'direct'
  content_warning?: string
  in_reply_to?: string
  media_attachments?: any[]
  is_sensitive?: boolean
  language?: string
}

export interface UpdatePostData {
  content?: MessagePart[]
  content_warning?: string
  is_sensitive?: boolean
}

export class PostService {
  private static instance: PostService

  static getInstance(): PostService {
    if (!PostService.instance) {
      PostService.instance = new PostService()
    }
    return PostService.instance
  }

  // =====================================================
  // POST CREATION & MANAGEMENT (SIMPLIFIED: TRUST DATABASE)
  // =====================================================

  /**
   * Create a new post (simplified: database triggers handle federation)
   */
  async createPost(data: CreatePostData): Promise<TimelinePost> {
    try {
      console.log(`🚀 Simplified: Creating post with visibility: ${data.visibility}`)

      // Just create the post - database triggers handle federation automatically
      const post = await corePostService.createPost(data)

      console.log(`✅ Simplified: Post created successfully - database handling federation: ${post.id}`)
      return post

    } catch (error) {
      console.error('❌ Simplified: Failed to create post:', error)
      throw error
    }
  }

  /**
   * Update an existing post (simplified: database triggers handle federation)
   */
  async updatePost(postId: string, updates: UpdatePostData): Promise<TimelinePost> {
    try {
      console.log(`🚀 Simplified: Updating post: ${postId}`)

      // Just update the post - database triggers handle federation automatically
      const post = await corePostService.updatePost(postId, updates)

      console.log(`✅ Simplified: Post updated successfully - database handling federation: ${postId}`)
      return post

    } catch (error) {
      console.error('❌ Simplified: Failed to update post:', error)
      throw error
    }
  }

  /**
   * Delete a post (simplified: database triggers handle federation)
   */
  async deletePost(postId: string): Promise<void> {
    try {
      console.log(`🚀 Simplified: Deleting post: ${postId}`)

      // Just delete the post - database triggers handle federation automatically
      await corePostService.deletePost(postId)

      console.log(`✅ Simplified: Post deleted successfully - database handling federation: ${postId}`)

    } catch (error) {
      console.error('❌ Simplified: Failed to delete post:', error)
      throw error
    }
  }

  // =====================================================
  // POST INTERACTIONS (SIMPLIFIED: TRUST DATABASE)
  // =====================================================

  /**
   * Toggle like on a post (simplified: database triggers handle federation)
   * PRESERVES: Exact same API and return type
   */
  async toggleLike(postId: string): Promise<{ liked: boolean; newCount: number }> {
    try {
      console.log(`🚀 Simplified: Toggling like for post: ${postId}`)

      // Just toggle the like - database triggers handle federation automatically
      const result = await corePostService.toggleLike(postId)

      console.log(`✅ Simplified: Post like toggled - database handling federation: ${result.liked ? 'liked' : 'unliked'}`)
      return result

    } catch (error) {
      console.error('❌ Simplified: Failed to toggle like:', error)
      throw error
    }
  }

  /**
   * Toggle share/reblog on a post (simplified: database triggers handle federation)
   * PRESERVES: Exact same API and return type
   */
  async toggleShare(postId: string): Promise<{ shared: boolean; newCount: number }> {
    try {
      console.log(`🚀 Simplified: Toggling share for post: ${postId}`)

      // Just toggle the share - database triggers handle federation automatically
      const result = await corePostService.toggleShare(postId)

      console.log(`✅ Simplified: Post share toggled - database handling federation: ${result.shared ? 'shared' : 'unshared'}`)
      return result

    } catch (error) {
      console.error('❌ Simplified: Failed to toggle share:', error)
      throw error
    }
  }

  /**
   * Toggle bookmark on a post (simplified: no federation needed)
   * PRESERVES: Exact same API and return type
   */
  async toggleBookmark(postId: string): Promise<{ bookmarked: boolean }> {
    try {
      console.log(`🚀 Simplified: Toggling bookmark for post: ${postId}`)

      // Bookmarks are always local-only (no federation)
      const result = await corePostService.toggleBookmark(postId)

      console.log(`✅ Simplified: Post bookmark toggled: ${result.bookmarked ? 'bookmarked' : 'unbookmarked'}`)
      return result

    } catch (error) {
      console.error('❌ Simplified: Failed to toggle bookmark:', error)
      throw error
    }
  }

  /**
   * Toggle reaction on a post (simplified: database triggers handle federation)
   * PRESERVES: Exact same API and return type
   */
  async toggleReaction(postId: string, emojiId: string): Promise<{ added: boolean; newCount: number }> {
    try {
      console.log(`🚀 Simplified: Toggling reaction for post: ${postId}, emoji: ${emojiId}`)

      // Just toggle the reaction - database triggers handle federation automatically
      const coreResult = await corePostService.toggleReaction(postId, emojiId)

      // Get reaction count for the API response
      const { count } = await supabase
        .from('post_interactions')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', postId)
        .eq('interaction_type', 'reaction')
        .eq('emoji_id', emojiId)

      const result = {
        added: coreResult.added,
        newCount: count || 0
      }

      console.log(`✅ Simplified: Post reaction toggled - database handling federation: ${result.added ? 'added' : 'removed'}`)
      return result

    } catch (error) {
      console.error('❌ Simplified: Failed to toggle post reaction:', error)
      throw error
    }
  }

  // =====================================================
  // POST LOADING (DELEGATED TO CORE SERVICE)
  // =====================================================

  /**
   * Load timeline posts (delegated to core service)
   * PRESERVES: Exact same API, pagination, and performance
   */
  async loadTimelinePosts(
    timelineType: 'public' | 'home' | 'local' | 'federated' = 'public',
    options: {
      limit?: number;
      before?: string;
      after?: string;
      signal?: AbortSignal;
    } = {}
  ): Promise<{
    posts: TimelinePost[];
    hasMore: boolean;
    nextCursor?: string;
  }> {
    try {
      console.log(`🚀 Simplified: Loading ${timelineType} timeline posts`)
      
      // Map federated to public for core service (core doesn't distinguish federated)
      const coreTimelineType = timelineType === 'federated' ? 'public' : timelineType
      
      // Delegate to core service (no federation needed for reads)
      const posts = await corePostService.loadTimelinePosts(coreTimelineType, options)
      
      // Transform core service response to match expected API
      const { limit = 20 } = options
      const hasMore = posts.length === limit
      const nextCursor = hasMore ? posts[posts.length - 1]?.created_at : undefined
      
      const result = {
        posts,
        hasMore,
        nextCursor
      }
      
      console.log(`✅ Simplified: Loaded ${posts.length} timeline posts`)
      return result

    } catch (error) {
      console.error('❌ Simplified: Failed to load timeline posts:', error)
      throw error
    }
  }

  /**
   * Load a single post (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async loadPost(postId: string): Promise<TimelinePost> {
    try {
      console.log(`🚀 Simplified: Loading post: ${postId}`)
      
      // Delegate to core service (no federation needed for reads)
      const post = await corePostService.loadPost(postId)
      
      console.log(`✅ Simplified: Post loaded successfully`)
      return post

    } catch (error) {
      console.error('❌ Simplified: Failed to load post:', error)
      throw error
    }
  }

  // =====================================================
  // REACTION LOADING (DELEGATED TO CORE SERVICE)
  // =====================================================

  /**
   * Get post reactions (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async getPostReactions(postId: string): Promise<Array<{
    emoji_id: string;
    emoji_name: string;
    count: number;
    users: Array<{ id: string; username: string; display_name?: string }>;
  }>> {
    try {
      console.log(`🚀 Simplified: Loading reactions for post: ${postId}`)
      
      // Delegate to core service (no federation needed for reads)
      const reactions = await corePostService.getPostReactions(postId)
      
      console.log(`✅ Simplified: Loaded ${reactions.length} reaction groups`)
      return reactions

    } catch (error) {
      console.error('❌ Simplified: Failed to load post reactions:', error)
      throw error
    }
  }

  // =====================================================
  // UTILITY METHODS (PRESERVED)
  // =====================================================

  private async getCurrentUserProfileId(): Promise<string> {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single()

    if (error || !profile) {
      throw this.createError('PROFILE_NOT_FOUND', 'User profile not found')
    }

    return profile.id
  }

  private createError(code: string, message: string, details?: any): Error {
    const error = new Error(message) as any
    error.code = code
    error.details = details
    return error
  }
}

// Export singleton instance
export const postService = PostService.getInstance()