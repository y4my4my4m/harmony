/** Post operations; delegates to CorePostService. */
import { supabase } from '@/supabase'
import type { TimelinePost, MessagePart } from '@/types'

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

  async createPost(data: CreatePostData): Promise<TimelinePost> {
    try {

      const post = await corePostService.createPost(data)

      return post

    } catch (error) {
      throw error
    }
  }

  async updatePost(postId: string, updates: UpdatePostData): Promise<TimelinePost> {
    try {

      const post = await corePostService.updatePost(postId, updates)

      return post

    } catch (error) {
      throw error
    }
  }

  async deletePost(postId: string): Promise<void> {
    try {

      await corePostService.deletePost(postId)

    } catch (error) {
      throw error
    }
  }

  async toggleLike(postId: string): Promise<{ liked: boolean; newCount: number }> {
    try {

      const result = await corePostService.toggleLike(postId)

      return result

    } catch (error) {
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

    async toggleBookmark(postId: string): Promise<{ bookmarked: boolean }> {
    try {

      // Bookmarks are always local-only (no federation)
      const result = await corePostService.toggleBookmark(postId)

      return result

    } catch (error) {
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

  async toggleReaction(postId: string, emojiId: string): Promise<{ added: boolean; newCount: number }> {
    try {

      const coreResult = await corePostService.toggleReaction(postId, emojiId)

      // Check if this is a unicode/shortcode emoji (not a UUID)
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

      return result

    } catch (error) {
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
      
      // Map federated to public for core service (core doesn't distinguish federated)
      const coreTimelineType = timelineType === 'federated' ? 'public' : timelineType
      
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
      
      return result

    } catch (error) {
      throw error
    }
  }

  async loadPost(postId: string): Promise<TimelinePost> {
    try {
      
      const post = await corePostService.loadPost(postId)
      
      if (!post) {
        throw this.createError('POST_NOT_FOUND', `Post not found: ${postId}`)
      }
      
      return post

    } catch (error) {
      throw error
    }
  }

  async getPostReactions(postId: string): Promise<Array<{
    emoji_id: string;
    emoji_name: string;
    count: number;
    users: Array<{ id: string; username: string; display_name?: string }>;
  }>> {
    try {
      
      const reactions = await corePostService.getPostReactions(postId)
      
      return reactions

    } catch (error) {
      throw error
    }
  }

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

export const postService = PostService.getInstance()