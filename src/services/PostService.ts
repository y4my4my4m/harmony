/**
 * PostService - Local-first post management
 * 
 * Handles all post-related operations with local-first design:
 * - Operations work immediately (optimistic updates)
 * - Federation happens asynchronously in background
 * - Consistent error handling and loading states
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
  is_sensitive?: boolean
  media_attachments?: any[]
}

export interface PostServiceError {
  code: string
  message: string
  details?: any
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
  // POST CREATION & MANAGEMENT
  // =====================================================

  /**
   * Create a new post (local-first)
   */
  async createPost(data: CreatePostData): Promise<TimelinePost> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      // Get user's profile ID
      const profileId = await this.getCurrentUserProfileId()

      const postData = {
        author_id: profileId,
        content: data.content,
        visibility: data.visibility,
        content_warning: data.content_warning,
        in_reply_to: data.in_reply_to,
        media_attachments: data.media_attachments || [],
        is_sensitive: data.is_sensitive || false,
        language: data.language || 'en',
        ap_type: 'Note',
        is_local: true,
        is_federated: true,
        metadata: {}
      }

      // Insert post - triggers will handle federation and notifications
      const { data: insertedPost, error } = await supabase
        .from('posts')
        .insert(postData)
        .select(`
          *,
          author:profiles!author_id (
            id, username, display_name, avatar_url, domain, is_local,
            bio, created_at, updated_at
          )
        `)
        .single()

      if (error) throw this.createError('INSERT_FAILED', error.message, error)

      return this.transformDatabasePostToTimelinePost(insertedPost)
    } catch (error) {
      console.error('Failed to create post:', error)
      throw error
    }
  }

  /**
   * Update an existing post (local-first)
   */
  async updatePost(postId: string, updates: UpdatePostData): Promise<TimelinePost> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Verify ownership
      const { data: existingPost, error: fetchError } = await supabase
        .from('posts')
        .select('author_id')
        .eq('id', postId)
        .single()

      if (fetchError || !existingPost) {
        throw this.createError('POST_NOT_FOUND', 'Post not found')
      }

      if (existingPost.author_id !== profileId) {
        throw this.createError('NOT_AUTHORIZED', 'You can only edit your own posts')
      }

      // Prepare update data
      const updateData: any = {
        updated_at: new Date().toISOString()
      }

      if (updates.content !== undefined) updateData.content = updates.content
      if (updates.content_warning !== undefined) updateData.content_warning = updates.content_warning
      if (updates.is_sensitive !== undefined) updateData.is_sensitive = updates.is_sensitive
      if (updates.media_attachments !== undefined) updateData.media_attachments = updates.media_attachments

      // Update post - triggers will handle federation
      const { data: updatedPost, error } = await supabase
        .from('posts')
        .update(updateData)
        .eq('id', postId)
        .select(`
          *,
          author:profiles!author_id (
            id, username, display_name, avatar_url, domain, is_local,
            bio, created_at, updated_at
          )
        `)
        .single()

      if (error) throw this.createError('UPDATE_FAILED', error.message, error)

      return this.transformDatabasePostToTimelinePost(updatedPost)
    } catch (error) {
      console.error('Failed to update post:', error)
      throw error
    }
  }

  /**
   * Delete a post (local-first)
   */
  async deletePost(postId: string): Promise<void> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Verify ownership
      const { data: existingPost, error: fetchError } = await supabase
        .from('posts')
        .select('author_id')
        .eq('id', postId)
        .single()

      if (fetchError || !existingPost) {
        throw this.createError('POST_NOT_FOUND', 'Post not found')
      }

      if (existingPost.author_id !== profileId) {
        throw this.createError('NOT_AUTHORIZED', 'You can only delete your own posts')
      }

      // Soft delete - triggers will handle federation
      const { error } = await supabase
        .from('posts')
        .update({
          is_deleted: true,
          deleted_at: new Date().toISOString()
        })
        .eq('id', postId)

      if (error) throw this.createError('DELETE_FAILED', error.message, error)
    } catch (error) {
      console.error('Failed to delete post:', error)
      throw error
    }
  }

  // =====================================================
  // POST INTERACTIONS (LOCAL-FIRST)
  // =====================================================

  /**
   * Like/unlike a post (local-first with optimistic updates)
   */
  async toggleLike(postId: string): Promise<{ liked: boolean; newCount: number }> {
    try {
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
        .maybeSingle()

      let liked: boolean
      let newCount: number

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

      // Get updated count
      const { count } = await supabase
        .from('post_interactions')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', postId)
        .eq('interaction_type', 'like')

      newCount = count || 0

      return { liked, newCount }
    } catch (error) {
      console.error('Failed to toggle like:', error)
      throw error
    }
  }

  /**
   * Share/unshare a post (reblog/boost)
   */
  async toggleShare(postId: string): Promise<{ shared: boolean; newCount: number }> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Check current share status
      const { data: existingShare } = await supabase
        .from('post_interactions')
        .select('id')
        .eq('post_id', postId)
        .eq('user_id', profileId)
        .eq('interaction_type', 'share')
        .maybeSingle()

      let shared: boolean
      let newCount: number

      if (existingShare) {
        // Remove share
        const { error } = await supabase
          .from('post_interactions')
          .delete()
          .eq('id', existingShare.id)

        if (error) throw this.createError('UNSHARE_FAILED', error.message, error)
        shared = false
      } else {
        // Add share
        const { error } = await supabase
          .from('post_interactions')
          .insert({
            post_id: postId,
            user_id: profileId,
            interaction_type: 'share'
          })

        if (error) throw this.createError('SHARE_FAILED', error.message, error)
        shared = true
      }

      // Get updated count
      const { count } = await supabase
        .from('post_interactions')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', postId)
        .eq('interaction_type', 'share')

      newCount = count || 0

      return { shared, newCount }
    } catch (error) {
      console.error('Failed to toggle share:', error)
      throw error
    }
  }

  /**
   * Bookmark/unbookmark a post
   */
  async toggleBookmark(postId: string): Promise<{ bookmarked: boolean }> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // Check current bookmark status
      const { data: existingBookmark } = await supabase
        .from('bookmarks')
        .select('id')
        .eq('post_id', postId)
        .eq('user_id', profileId)
        .maybeSingle()

      let bookmarked: boolean

      if (existingBookmark) {
        // Remove bookmark
        const { error } = await supabase
          .from('bookmarks')
          .delete()
          .eq('id', existingBookmark.id)

        if (error) throw this.createError('UNBOOKMARK_FAILED', error.message, error)
        bookmarked = false
      } else {
        // Add bookmark
        const { error } = await supabase
          .from('bookmarks')
          .insert({
            post_id: postId,
            user_id: profileId
          })

        if (error) throw this.createError('BOOKMARK_FAILED', error.message, error)
        bookmarked = true
      }

      return { bookmarked }
    } catch (error) {
      console.error('Failed to toggle bookmark:', error)
      throw error
    }
  }

  // =====================================================
  // POST LOADING & QUERIES
  // =====================================================

  /**
   * Load posts for timeline with pagination
   */
  async loadTimelinePosts(
    timeline: 'home' | 'local' | 'public',
    limit: number = 20,
    cursor?: string
  ): Promise<{ posts: TimelinePost[]; hasMore: boolean; nextCursor?: string }> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const profileId = user ? await this.getCurrentUserProfileId() : null

      let query = supabase
        .from('posts')
        .select(`
          *,
          author:profiles!author_id (
            id, username, display_name, avatar_url, domain, is_local,
            bio, created_at, updated_at
          )
        `)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .limit(limit + 1) // +1 to check if there are more

      // Apply timeline filters
      switch (timeline) {
        case 'local':
          query = query.eq('is_local', true).eq('visibility', 'public')
          break
        case 'public':
          query = query.eq('visibility', 'public')
          break
        case 'home':
          if (profileId) {
            // TODO: Filter by followed users - for now show all public
            query = query.eq('visibility', 'public')
          } else {
            query = query.eq('visibility', 'public')
          }
          break
      }

      // Apply cursor pagination
      if (cursor) {
        query = query.lt('created_at', cursor)
      }

      const { data: posts, error } = await query

      if (error) throw this.createError('LOAD_FAILED', error.message, error)

      const hasMore = posts.length > limit
      const resultPosts = hasMore ? posts.slice(0, limit) : posts
      const nextCursor = hasMore ? posts[limit - 1].created_at : undefined

      return {
        posts: resultPosts.map(post => this.transformDatabasePostToTimelinePost(post)),
        hasMore,
        nextCursor
      }
    } catch (error) {
      console.error('Failed to load timeline posts:', error)
      throw error
    }
  }

  /**
   * Load a single post with context
   */
  async loadPost(postId: string): Promise<TimelinePost | null> {
    try {
      const { data: post, error } = await supabase
        .from('posts')
        .select(`
          *,
          author:profiles!author_id (
            id, username, display_name, avatar_url, domain, is_local,
            bio, created_at, updated_at
          )
        `)
        .eq('id', postId)
        .eq('is_deleted', false)
        .single()

      if (error) {
        if (error.code === 'PGRST116') return null // Not found
        throw this.createError('LOAD_FAILED', error.message, error)
      }

      return this.transformDatabasePostToTimelinePost(post)
    } catch (error) {
      console.error('Failed to load post:', error)
      throw error
    }
  }

  // =====================================================
  // HELPER METHODS
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

  private transformDatabasePostToTimelinePost(post: any): TimelinePost {
    // Ensure content is properly formatted
    let processedContent = post.content
    if (typeof post.content === 'string') {
      try {
        const parsed = JSON.parse(post.content)
        if (Array.isArray(parsed)) {
          processedContent = parsed
        } else {
          processedContent = [{ type: 'text', text: post.content }]
        }
      } catch {
        processedContent = [{ type: 'text', text: post.content }]
      }
    } else if (!Array.isArray(post.content)) {
      processedContent = [{ type: 'text', text: '' }]
    }

    return {
      id: post.id,
      created_at: post.created_at,
      updated_at: post.updated_at,
      content: processedContent,
      content_warning: post.content_warning,
      language: post.language || 'en',
      author_id: post.author_id,
      ap_id: post.ap_id,
      ap_type: post.ap_type,
      url: post.url,
      reply_context: post.reply_context,
      conversation_id: post.conversation_id,
      visibility: post.visibility,
      is_local: post.is_local,
      is_federated: post.is_federated,
      replies_count: post.replies_count || 0,
      reblogs_count: post.reblogs_count || 0,
      favorites_count: post.favorites_count || 0,
      media_attachments: post.media_attachments || [],
      metadata: post.metadata || {},
      is_sensitive: post.is_sensitive,
      is_deleted: post.is_deleted,
      deleted_at: post.deleted_at,
      author: post.author ? {
        id: post.author.id,
        username: post.author.username,
        display_name: post.author.display_name || post.author.username,
        avatar_url: post.author.avatar_url || '/default_avatar.png',
        domain: post.author.domain || 'har.mony.lol',
        bio: post.author.bio || '',
        is_local: post.author.is_local !== false,
        followers_count: 0,
        following_count: 0,
        posts_count: 0,
        created_at: post.author.created_at,
        updated_at: post.author.updated_at || post.author.created_at
      } : {
        id: post.author_id,
        username: 'Unknown',
        display_name: 'Unknown User',
        avatar_url: '/default_avatar.png',
        domain: 'har.mony.lol',
        bio: '',
        is_local: true,
        followers_count: 0,
        following_count: 0,
        posts_count: 0,
        created_at: post.created_at,
        updated_at: post.created_at
      },
      is_favorited: post.is_favorited || false,
      is_reblogged: post.is_reblogged || false,
      is_bookmarked: post.is_bookmarked || false
    }
  }

  private createError(code: string, message: string, details?: any): PostServiceError {
    return { code, message, details }
  }
}

// Export singleton instance
export const postService = PostService.getInstance()