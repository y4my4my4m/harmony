/**
 * PostService - Professional post management using database functions
 * 
 * UPDATED: Now uses professional database functions for local-first operations
 * - create_post_professional(): Creates posts with automatic federation
 * - get_federation_status(): Gets comprehensive federation info in one call
 * 
 * PERFORMANCE BENEFITS:
 * - ✅ Single RPC call instead of multiple frontend calls
 * - ✅ Automatic federation handling in database triggers
 * - ✅ No manual federation checks or content conversion needed
 * - ✅ Professional DRY architecture
 */

import { supabase } from '@/supabase'
import type { Post, TimelinePost, MessagePart } from '@/types'

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
  visibility?: 'public' | 'unlisted' | 'followers' | 'direct'
  is_sensitive?: boolean
}

export class PostService {
  private static instance: PostService
  
  static getInstance(): PostService {
    if (!this.instance) {
      this.instance = new PostService()
    }
    return this.instance
  }

  // =====================================================
  // POST CREATION & MANAGEMENT (PROFESSIONAL DATABASE FUNCTIONS)
  // =====================================================

  /**
   * Create a new post (professional: single database call with automatic federation)
   */
  async createPost(data: CreatePostData): Promise<TimelinePost> {
    try {
      console.log(`🚀 Professional: Creating post with visibility: ${data.visibility}`)

      // Get current user
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Single RPC call handles everything: local creation + automatic federation
      const { data: postResult, error } = await supabase
        .rpc('create_post_professional', {
          p_user_id: profileId,
          p_content: data.content,
          p_visibility: data.visibility,
          p_content_warning: data.content_warning || null,
          p_in_reply_to: data.in_reply_to || null,
          p_conversation_id: null,
          p_media_attachments: data.media_attachments || []
        })

      if (error) throw this.createError('CREATE_FAILED', error.message, error)

      console.log(`✅ Professional: Post created successfully: ${postResult.id}`)
      
      // Transform database response to expected format
      return {
        id: postResult.id,
        content: postResult.content,
        created_at: postResult.created_at,
        updated_at: postResult.updated_at,
        visibility: postResult.visibility,
        content_warning: postResult.content_warning,
        in_reply_to: postResult.in_reply_to,
        conversation_id: postResult.conversation_id,
        replies_count: postResult.replies_count,
        reblogs_count: postResult.reblogs_count,
        favorites_count: postResult.favorites_count,
        is_favorited: postResult.is_favorited,
        is_reblogged: postResult.is_reblogged,
        is_bookmarked: postResult.is_bookmarked,
        author: postResult.author,
        media_attachments: postResult.media_attachments,
        is_local: true,
        ap_id: null, // Will be set by trigger if needed
        url: null // Will be set by trigger if needed
      } as TimelinePost

    } catch (error) {
      console.error('❌ Professional: Failed to create post:', error)
      throw error
    }
  }

  /**
   * Update an existing post (using existing logic for now)
   */
  async updatePost(postId: string, updates: UpdatePostData): Promise<TimelinePost> {
    try {
      console.log(`🚀 Professional: Updating post: ${postId}`)

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Verify ownership
      const { data: existingPost } = await supabase
        .from('posts')
        .select('author_id')
        .eq('id', postId)
        .single()

      if (existingPost?.author_id !== profileId) {
        throw this.createError('UNAUTHORIZED', 'Cannot edit post you do not own')
      }

      const updateData = {
        ...updates,
        updated_at: new Date().toISOString()
      }

      const { data: post, error } = await supabase
        .from('posts')
        .update(updateData)
        .eq('id', postId)
        .select(`
          *,
          author:profiles!posts_author_id_fkey(*)
        `)
        .single()

      if (error) throw this.createError('UPDATE_FAILED', error.message, error)

      console.log(`✅ Professional: Post updated successfully: ${postId}`)
      return this.formatTimelinePost(post)

    } catch (error) {
      console.error('❌ Professional: Failed to update post:', error)
      throw error
    }
  }

  /**
   * Delete a post (using existing logic for now)
   */
  async deletePost(postId: string): Promise<void> {
    try {
      console.log(`🚀 Professional: Deleting post: ${postId}`)

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Verify ownership
      const { data: existingPost } = await supabase
        .from('posts')
        .select('author_id')
        .eq('id', postId)
        .single()

      if (existingPost?.author_id !== profileId) {
        throw this.createError('UNAUTHORIZED', 'Cannot delete post you do not own')
      }

      // Soft delete
      const { error } = await supabase
        .from('posts')
        .update({ is_deleted: true, deleted_at: new Date().toISOString() })
        .eq('id', postId)

      if (error) throw this.createError('DELETE_FAILED', error.message, error)

      console.log(`✅ Professional: Post deleted successfully: ${postId}`)

    } catch (error) {
      console.error('❌ Professional: Failed to delete post:', error)
      throw error
    }
  }

  // =====================================================
  // POST INTERACTIONS (EXISTING LOGIC FOR NOW)
  // =====================================================

  /**
   * Toggle like on a post (preserves existing API)
   */
  async toggleLike(postId: string): Promise<{ liked: boolean; newCount: number }> {
    try {
      console.log(`🚀 Professional: Toggling like for post: ${postId}`)

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Check current like status
      const { data: existingLike } = await supabase
        .from('post_interactions')
        .select('id')
        .eq('post_id', postId)
        .eq('user_id', profileId)
        .eq('interaction_type', 'like')
        .single()

      let liked: boolean
      if (existingLike) {
        // Remove like
        const { error } = await supabase
          .from('post_interactions')
          .delete()
          .eq('id', existingLike.id)

        if (error) throw this.createError('UNLIKE_FAILED', error.message, error)
        liked = false
      } else {
        // Add like
        const { error } = await supabase
          .from('post_interactions')
          .insert({
            post_id: postId,
            user_id: profileId,
            interaction_type: 'like'
          })

        if (error) throw this.createError('LIKE_FAILED', error.message, error)
        liked = true
      }

      // Get new count
      const { count } = await supabase
        .from('post_interactions')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', postId)
        .eq('interaction_type', 'like')

      const newCount = count || 0

      console.log(`✅ Professional: Post like toggled successfully: ${liked ? 'liked' : 'unliked'}`)
      return { liked, newCount }

    } catch (error) {
      console.error('❌ Professional: Failed to toggle like:', error)
      throw error
    }
  }

  /**
   * Toggle share/reblog on a post (preserves existing API)
   */
  async toggleShare(postId: string): Promise<{ shared: boolean; newCount: number }> {
    try {
      console.log(`🚀 Professional: Toggling share for post: ${postId}`)

      // For now, return placeholder values
      // TODO: Implement actual reblog logic
      return { shared: false, newCount: 0 }

    } catch (error) {
      console.error('❌ Professional: Failed to toggle share:', error)
      throw error
    }
  }

  /**
   * Toggle bookmark on a post (preserves existing API)
   */
  async toggleBookmark(postId: string): Promise<{ bookmarked: boolean }> {
    try {
      console.log(`🚀 Professional: Toggling bookmark for post: ${postId}`)

      // For now, return placeholder values
      // TODO: Implement actual bookmark logic
      return { bookmarked: false }

    } catch (error) {
      console.error('❌ Professional: Failed to toggle bookmark:', error)
      throw error
    }
  }

  /**
   * Toggle reaction on a post (new method for post emoji reactions)
   */
  async toggleReaction(postId: string, emojiId: string): Promise<{ added: boolean; newCount: number }> {
    try {
      console.log(`🚀 Professional: Toggling reaction for post: ${postId}, emoji: ${emojiId}`)

      // For now, return placeholder values
      // TODO: Implement actual post reaction logic
      return { added: false, newCount: 0 }

    } catch (error) {
      console.error('❌ Professional: Failed to toggle reaction:', error)
      throw error
    }
  }

  // =====================================================
  // POST LOADING (DELEGATED TO EXISTING FUNCTIONS)
  // =====================================================

  /**
   * Load timeline posts (using existing RPC functions)
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
      console.log(`🚀 Professional: Loading ${timelineType} timeline posts`)
      
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const limit = options.limit || 20

      // Use existing RPC function
      const { data, error } = await supabase.rpc('get_timeline_posts_with_interactions', {
        p_user_id: user.id,
        p_timeline_type: timelineType === 'federated' ? 'public' : timelineType,
        p_limit: limit,
        p_max_id: options.before || null
      })

      if (error) throw this.createError('LOAD_FAILED', error.message, error)

      const posts = data || []
      const hasMore = posts.length === limit
      const nextCursor = hasMore ? posts[posts.length - 1]?.created_at : undefined
      
      console.log(`✅ Professional: Loaded ${posts.length} timeline posts`)
      return { posts, hasMore, nextCursor }

    } catch (error) {
      console.error('❌ Professional: Failed to load timeline posts:', error)
      throw error
    }
  }

  /**
   * Load a single post by ID
   */
  async loadPost(postId: string): Promise<TimelinePost | null> {
    try {
      console.log(`🚀 Professional: Loading post: ${postId}`)

      const { data: post, error } = await supabase
        .from('posts')
        .select(`
          *,
          author:profiles!posts_author_id_fkey(*)
        `)
        .eq('id', postId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') {
          console.log(`ℹ️ Professional: Post not found: ${postId}`)
          return null
        }
        throw this.createError('LOAD_FAILED', error.message, error)
      }

      console.log(`✅ Professional: Loaded post: ${postId}`)
      return this.formatTimelinePost(post)

    } catch (error) {
      console.error('❌ Professional: Failed to load post:', error)
      throw error
    }
  }

  // =====================================================
  // FEDERATION STATUS (PROFESSIONAL SINGLE CALL)
  // =====================================================

  /**
   * Get comprehensive federation status (replaces multiple frontend calls)
   */
  async getFederationStatus(): Promise<any> {
    try {
      console.log(`🚀 Professional: Getting federation status (single call)`)

      const { data: { user } } = await supabase.auth.getUser()
      
      const { data: status, error } = await supabase
        .rpc('get_federation_status', {
          p_user_id: user?.id || null
        })

      if (error) throw this.createError('FEDERATION_STATUS_FAILED', error.message, error)

      console.log(`✅ Professional: Federation status retrieved:`, status)
      return status

    } catch (error) {
      console.error('❌ Professional: Failed to get federation status:', error)
      throw error
    }
  }

  // =====================================================
  // HELPER METHODS
  // =====================================================

  private async getCurrentUserProfileId(): Promise<string> {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single()

    if (!profile) throw this.createError('PROFILE_NOT_FOUND', 'User profile not found')
    return profile.id
  }

  private formatTimelinePost(post: any): TimelinePost {
    return {
      id: post.id,
      content: post.content,
      created_at: post.created_at,
      updated_at: post.updated_at,
      visibility: post.visibility,
      content_warning: post.content_warning,
      in_reply_to: post.in_reply_to,
      conversation_id: post.conversation_id,
      replies_count: post.replies_count || 0,
      reblogs_count: post.reblogs_count || 0,
      favorites_count: post.favorites_count || 0,
      is_favorited: post.is_favorited || false,
      is_reblogged: post.is_reblogged || false,
      is_bookmarked: post.is_bookmarked || false,
      author: post.author,
      media_attachments: post.media_attachments || [],
      is_local: post.is_local || true,
      ap_id: post.ap_id,
      url: post.url
    }
  }

  private createError(code: string, message: string, details?: any): Error {
    const error = new Error(message)
    error.name = code
    if (details) {
      (error as any).details = details
    }
    return error
  }
}

// Export singleton instance
export const postService = PostService.getInstance()