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
import type { TimelinePost, MessagePart } from '@/types'

// Import only core service - database handles federation
import { corePostService } from './core'
import { debug } from '@/utils/debug'

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
      debug.log(`🚀 Simplified: Creating post with visibility: ${data.visibility}`)

      // Just create the post - database triggers handle federation automatically
      const post = await corePostService.createPost(data)

      debug.log(`✅ Simplified: Post created successfully - database handling federation: ${post.id}`)
      return post

    } catch (error) {
      debug.error('❌ Simplified: Failed to create post:', error)
      throw error
    }
  }

  /**
   * Update an existing post (simplified: database triggers handle federation)
   */
  async updatePost(postId: string, updates: UpdatePostData): Promise<TimelinePost> {
    try {
      debug.log(`🚀 Simplified: Updating post: ${postId}`)

      // Just update the post - database triggers handle federation automatically
      const post = await corePostService.updatePost(postId, updates)

      debug.log(`✅ Simplified: Post updated successfully - database handling federation: ${postId}`)
      return post

    } catch (error) {
      debug.error('❌ Simplified: Failed to update post:', error)
      throw error
    }
  }

  /**
   * Delete a post (simplified: database triggers handle federation)
   */
  async deletePost(postId: string): Promise<void> {
    try {
      debug.log(`🚀 Simplified: Deleting post: ${postId}`)

      // Just delete the post - database triggers handle federation automatically
      await corePostService.deletePost(postId)

      debug.log(`✅ Simplified: Post deleted successfully - database handling federation: ${postId}`)

    } catch (error) {
      debug.error('❌ Simplified: Failed to delete post:', error)
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
      debug.log(`🚀 Simplified: Toggling like for post: ${postId}`)

      // Just toggle the like - database triggers handle federation automatically
      const result = await corePostService.toggleLike(postId)

      debug.log(`✅ Simplified: Post like toggled - database handling federation: ${result.liked ? 'liked' : 'unliked'}`)
      return result

    } catch (error) {
      debug.error('❌ Simplified: Failed to toggle like:', error)
      throw error
    }
  }

  /**
   * Toggle share/reblog on a post - delegates to ActivityPub service for proper implementation
   * @deprecated Use services.activityPub.toggleReblog() directly for new code
   */
  async toggleShare(postId: string): Promise<{ shared: boolean; newCount: number }> {
    try {
      debug.log(`🚀 PostService: Delegating reblog to ActivityPub service for post: ${postId}`)

      // Import ActivityPub service dynamically to avoid circular dependencies
      const { activityPubService } = await import('./activityPubService')
      const result = await activityPubService.toggleReblog(postId)

      debug.log(`✅ PostService: Reblog delegated to ActivityPub service: ${result.reblogged ? 'reblogged' : 'unreblogged'}`)
      
      // Return in the expected format for backward compatibility
      return { 
        shared: result.reblogged, 
        newCount: 0 // TODO: Get actual count from database if needed
      }

    } catch (error) {
      debug.error('❌ PostService: Failed to toggle reblog via ActivityPub service:', error)
      throw error
    }
  }

  /**
   * Toggle reblog/boost on a post (ActivityPub Announce activity)
   * PRESERVES: Exact same API and return type
   */
  async toggleReblog(postId: string): Promise<{ reblogged: boolean; newCount: number }> {
    try {
      debug.log(`🚀 PostService: Toggling reblog for post: ${postId}`)

      // Import ActivityPub service dynamically to avoid circular dependencies
      const { activityPubService } = await import('./activityPubService')
      const result = await activityPubService.toggleReblog(postId)

      debug.log(`✅ PostService: Reblog toggled: ${result.reblogged ? 'reblogged' : 'unreblogged'}`)
      
      // Return in the expected format for the UI
      return { 
        reblogged: result.reblogged, 
        newCount: 0 // TODO: Get actual count from database if needed
      }

    } catch (error) {
      debug.error('❌ PostService: Failed to toggle reblog:', error)
      throw error
    }
  }

  /**
   * Toggle bookmark on a post (simplified: no federation needed)
   * PRESERVES: Exact same API and return type
   */
  async toggleBookmark(postId: string): Promise<{ bookmarked: boolean }> {
    try {
      debug.log(`🚀 Simplified: Toggling bookmark for post: ${postId}`)

      // Bookmarks are always local-only (no federation)
      const result = await corePostService.toggleBookmark(postId)

      debug.log(`✅ Simplified: Post bookmark toggled: ${result.bookmarked ? 'bookmarked' : 'unbookmarked'}`)
      return result

    } catch (error) {
      debug.error('❌ Simplified: Failed to toggle bookmark:', error)
      throw error
    }
  }

  /**
   * Toggle pin on a post (pin/unpin to profile).
   * DB trigger handles federation of the pin change.
   */
  async togglePinPost(postId: string): Promise<{ pinned: boolean }> {
    try {
      debug.log(`📌 PostService: Toggling pin for post: ${postId}`)
      const result = await corePostService.togglePinPost(postId)
      debug.log(`✅ PostService: Post ${result.pinned ? 'pinned' : 'unpinned'}`)
      return result
    } catch (error) {
      debug.error('❌ PostService: Failed to toggle pin:', error)
      throw error
    }
  }

  /**
   * Get pinned posts for a user profile
   */
  async getPinnedPosts(authorId: string): Promise<any[]> {
    return corePostService.getPinnedPosts(authorId)
  }

  /**
   * Toggle reaction on a post (simplified: database triggers handle federation)
   * PRESERVES: Exact same API and return type
   */
  async toggleReaction(postId: string, emojiId: string): Promise<{ added: boolean; newCount: number }> {
    try {
      debug.log(`🚀 Simplified: Toggling reaction for post: ${postId}, emoji: ${emojiId}`)

      // Just toggle the reaction - database triggers handle federation automatically
      const coreResult = await corePostService.toggleReaction(postId, emojiId)

      // Check if this is a native/mutant emoji (not a UUID)
      const isNativeEmoji = !this.isValidUUID(emojiId)

      // Get reaction count for the API response - query by correct field
      let countQuery = supabase
        .from('post_interactions')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', postId)
        .eq('interaction_type', 'reaction')
      
      if (isNativeEmoji) {
        countQuery = countQuery.eq('custom_emoji_content', emojiId)
      } else {
        countQuery = countQuery.eq('emoji_id', emojiId)
      }

      const { count } = await countQuery

      const result = {
        added: coreResult.added,
        newCount: count || 0
      }

      debug.log(`✅ Simplified: Post reaction toggled - database handling federation: ${result.added ? 'added' : 'removed'}`)
      return result

    } catch (error) {
      debug.error('❌ Simplified: Failed to toggle post reaction:', error)
      throw error
    }
  }

  /**
   * Check if a string is a valid UUID
   * Uses permissive regex to handle Supabase-generated UUIDs which may not strictly follow RFC 4122
   */
  private isValidUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    return uuidRegex.test(str)
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
      debug.log(`🚀 Simplified: Loading ${timelineType} timeline posts`)
      
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
      
      debug.log(`✅ Simplified: Loaded ${posts.length} timeline posts`)
      return result

    } catch (error) {
      debug.error('❌ Simplified: Failed to load timeline posts:', error)
      throw error
    }
  }

  /**
   * Load a single post (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async loadPost(postId: string): Promise<TimelinePost> {
    try {
      debug.log(`🚀 Simplified: Loading post: ${postId}`)
      
      // Delegate to core service (no federation needed for reads)
      const post = await corePostService.loadPost(postId)
      
      if (!post) {
        throw this.createError('POST_NOT_FOUND', `Post not found: ${postId}`)
      }
      
      debug.log(`✅ Simplified: Post loaded successfully`)
      return post

    } catch (error) {
      debug.error('❌ Simplified: Failed to load post:', error)
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
      debug.log(`🚀 Simplified: Loading reactions for post: ${postId}`)
      
      // Delegate to core service (no federation needed for reads)
      const reactions = await corePostService.getPostReactions(postId)
      
      debug.log(`✅ Simplified: Loaded ${reactions.length} reaction groups`)
      return reactions

    } catch (error) {
      debug.error('❌ Simplified: Failed to load post reactions:', error)
      throw error
    }
  }

  // =====================================================
  // UTILITY METHODS (PRESERVED)
  // =====================================================

  /**
   * OPTIMIZED: Uses AuthContextService for cached profile ID lookup
   */
  private async getCurrentUserProfileId(): Promise<string> {
    const { authContextService } = await import('@/services/AuthContextService')
    
    try {
      return await authContextService.getCurrentProfileId()
    } catch {
      throw this.createError('AUTH_REQUIRED', 'User not authenticated')
    }
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