/**
 * CorePostService - Pure local post operations
 * 
 * Contains ONLY local database operations with NO federation logic:
 * - Post CRUD operations (create, read, update, delete)
 * - Post interactions (like, share, bookmark, reactions)
 * - Timeline loading and pagination
 * - Validation and error handling
 * 
 * NO FEDERATION CONCERNS:
 * - No ap_activities insertions
 * - No federation condition checks
 * - No ActivityPub protocol handling
 * - Pure local Supabase operations only
 */

import { supabase } from '@/supabase'
import type { Post, TimelinePost, MessagePart } from '@/types'
import { debug } from '@/utils/debug'
import { authContextService } from '@/services/AuthContextService'
import {
  DEFAULT_MAX_POST_TEXT_LENGTH,
  MESSAGE_TEXT_HARD_CEILING,
  messageTextLength,
} from '@/utils/messageContentUtils'

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

export interface CorePostServiceError {
  code: string
  message: string
  details?: any
}

export class CorePostService {
  private static instance: CorePostService
  
  static getInstance(): CorePostService {
    if (!this.instance) {
      this.instance = new CorePostService()
    }
    return this.instance
  }

  // =====================================================
  // POST CREATION & MANAGEMENT (PURE LOCAL)
  // =====================================================

  /**
   * Create a post (pure local database operation)
   */
  async createPost(data: CreatePostData): Promise<TimelinePost> {
    try {
      debug.log('🚀 Core: createPost starting...')
      
      // OPTIMIZED: Use AuthContextService for auth check (cached)
      const authUser = await authContextService.getCurrentAuthUser()
      if (!authUser) throw this.createError('AUTH_REQUIRED', 'User not authenticated')
      debug.log('✅ Core: Auth user verified')

      const profileId = await this.getCurrentUserProfileId()
      debug.log('✅ Core: Profile ID retrieved:', profileId)

      // Enterprise-grade content validation
      if (!Array.isArray(data.content)) {
        throw this.createError('INVALID_CONTENT', 'Content must be an array of MessageParts')
      }

      if (data.content.length === 0) {
        throw this.createError('EMPTY_CONTENT', 'Content cannot be empty')
      }

      // Validate each MessagePart
      for (const part of data.content) {
        if (!part || typeof part !== 'object' || !part.type) {
          throw this.createError('INVALID_MESSAGE_PART', 'Each content part must be a valid MessagePart object')
        }
      }

      // Enforce per-post text length using the admin-configurable soft
      // limit (`instance_config.max_post_length`). The DB CHECK constraint
      // on `posts.content` enforces the absolute hard ceiling
      // (`MESSAGE_TEXT_HARD_CEILING`) — this check fires first so the
      // user sees a friendly error.
      const maxPostLength = await this.getMaxPostLength()
      const textLen = messageTextLength(data.content)
      if (textLen > maxPostLength) {
        throw this.createError(
          'POST_TOO_LONG',
          `Post is too long (${textLen.toLocaleString()} / ${maxPostLength.toLocaleString()} characters).`,
        )
      }

      debug.log('✅ Core: Content validation passed')

      // Enforce max media attachments per post (instance config, default 20)
      let mediaAttachments = data.media_attachments || []
      const { data: limitRow } = await supabase
        .from('instance_config')
        .select('config_value')
        .eq('config_key', 'max_media_attachments_per_post')
        .maybeSingle()
      const maxMedia = (() => {
        const v = limitRow?.config_value
        if (typeof v === 'number' && v >= 1) return v
        const parsed = typeof v === 'string' ? parseInt(String(v), 10) : NaN
        return !isNaN(parsed) && parsed >= 1 ? parsed : 20
      })()
      if (mediaAttachments.length > maxMedia) {
        mediaAttachments = mediaAttachments.slice(0, maxMedia)
        debug.warn(`Core: Truncated media_attachments to ${maxMedia} (instance limit)`)
      }

      const postData = {
        author_id: profileId,
        content: data.content, // Direct JSONB insertion - Supabase handles serialization
        visibility: data.visibility,
        content_warning: data.content_warning || null,
        in_reply_to: data.in_reply_to || null,
        media_attachments: mediaAttachments,
        is_sensitive: data.is_sensitive || false,
        language: data.language || 'en',
        is_local: true,
        is_federated: true, // Keep for compatibility, federation handled by orchestrator
        metadata: { created_via: 'harmony_client', content_format: 'message_parts_v1' }
      }

      debug.log('🔄 Core: Inserting post into database...')
      
      // Simple query - trust Supabase to handle connection
      const { data: post, error } = await supabase
        .from('posts')
        .insert(postData)
        .select(`
          *,
          author:profiles!posts_author_id_fkey(*)
        `)
        .single()

      if (error) {
        debug.error('❌ Core: Insert failed:', error)
        throw this.createError('INSERT_FAILED', error.message, error)
      }

      debug.log('✅ Core: Post created successfully (local only), id:', post?.id)
      
      return this.formatTimelinePost(post)
    } catch (error: any) {
      debug.error('❌ Core: Failed to create post:', error)
      throw error
    }
  }

  /**
   * Update a post (pure local update)
   * Uses AuthContextService for efficient auth lookup
   */
  async updatePost(postId: string, updates: UpdatePostData): Promise<TimelinePost> {
    try {
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

      // Enforce post length on edits too — otherwise edits could push a
      // tiny post past the limit. Only check when content is actually
      // changing.
      if (updates.content) {
        const maxPostLength = await this.getMaxPostLength()
        const textLen = messageTextLength(updates.content)
        if (textLen > maxPostLength) {
          throw this.createError(
            'POST_TOO_LONG',
            `Post is too long (${textLen.toLocaleString()} / ${maxPostLength.toLocaleString()} characters).`,
          )
        }
      }

      const updateData = {
        ...updates,
        updated_at: new Date().toISOString(),
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

      debug.log('✅ Core: Post updated successfully (local only)')
      return this.formatTimelinePost(post)
    } catch (error) {
      debug.error('❌ Core: Failed to update post:', error)
      throw error
    }
  }

  /**
   * Delete a post (soft delete, pure local)
   * Uses AuthContextService for efficient auth lookup
   */
  async deletePost(postId: string): Promise<void> {
    try {
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

      const { error } = await supabase
        .from('posts')
        .update({ 
          content: [{ type: 'text', text: '[deleted]' }] as MessagePart[],
          is_deleted: true,
        })
        .eq('id', postId)

      if (error) throw this.createError('DELETE_FAILED', error.message, error)

      debug.log('✅ Core: Post deleted successfully (local only)')
    } catch (error) {
      debug.error('❌ Core: Failed to delete post:', error)
      throw error
    }
  }

  // =====================================================
  // POST INTERACTIONS (PURE LOCAL)
  // =====================================================

  /**
   * Toggle like on a post (pure local)
   * Uses AuthContextService for efficient auth lookup
   */
  async toggleLike(postId: string): Promise<{ liked: boolean; newCount: number }> {
    try {
      const profileId = await this.getCurrentUserProfileId()

      debug.log(`🔄 Core: Toggling like: post=${postId}, user=${profileId}`)

      // Check if already liked
      const { data: existingLike } = await supabase
        .from('post_interactions')
        .select('id')
        .match({ 
          post_id: postId, 
          user_id: profileId, 
          interaction_type: 'favorite' 
        })
        .maybeSingle()

      let liked: boolean

      if (existingLike) {
        // Remove like
        const { error } = await supabase
          .from('post_interactions')
          .delete()
          .match({ 
            post_id: postId, 
            user_id: profileId, 
            interaction_type: 'favorite' 
          })

        if (error) throw this.createError('REMOVE_LIKE_FAILED', error.message, error)
        liked = false
      } else {
        // Add like
        const { error } = await supabase
          .from('post_interactions')
          .insert({
            post_id: postId,
            user_id: profileId,
            interaction_type: 'favorite',
            is_local: true
          })

        if (error) throw this.createError('ADD_LIKE_FAILED', error.message, error)
        liked = true
      }

      // Get updated count
      const { count: newCount } = await supabase
        .from('post_interactions')
        .select('*', { count: 'exact', head: true })
        .match({ post_id: postId, interaction_type: 'favorite' })

      debug.log(`✅ Core: Like ${liked ? 'added' : 'removed'} successfully`)
      return { liked, newCount: newCount || 0 }
    } catch (error) {
      debug.error('❌ Core: Failed to toggle like:', error)
      throw error
    }
  }

  /**
   * Toggle share/reblog on a post (pure local)
   * Uses AuthContextService for efficient auth lookup
   */
  async toggleShare(postId: string): Promise<{ shared: boolean; newCount: number }> {
    try {
      const profileId = await this.getCurrentUserProfileId()

      debug.log(`🔄 Core: Toggling share: post=${postId}, user=${profileId}`)

      // Check if already shared
      const { data: existingShare } = await supabase
        .from('post_interactions')
        .select('id')
        .match({ 
          post_id: postId, 
          user_id: profileId, 
          interaction_type: 'reblog' 
        })
        .maybeSingle()

      let shared: boolean

      if (existingShare) {
        // Remove share
        const { error } = await supabase
          .from('post_interactions')
          .delete()
          .match({ 
            post_id: postId, 
            user_id: profileId, 
            interaction_type: 'reblog' 
          })

        if (error) throw this.createError('REMOVE_SHARE_FAILED', error.message, error)
        shared = false
      } else {
        // Add share
        const { error } = await supabase
          .from('post_interactions')
          .insert({
            post_id: postId,
            user_id: profileId,
            interaction_type: 'reblog',
            is_local: true
          })

        if (error) throw this.createError('ADD_SHARE_FAILED', error.message, error)
        shared = true
      }

      // Get updated count
      const { count: newCount } = await supabase
        .from('post_interactions')
        .select('*', { count: 'exact', head: true })
        .match({ post_id: postId, interaction_type: 'reblog' })

      debug.log(`✅ Core: Share ${shared ? 'added' : 'removed'} successfully`)
      return { shared, newCount: newCount || 0 }
    } catch (error) {
      debug.error('❌ Core: Failed to toggle share:', error)
      throw error
    }
  }

  /**
   * Toggle bookmark on a post (pure local)
   * Uses AuthContextService for efficient auth lookup
   */
  async toggleBookmark(postId: string): Promise<{ bookmarked: boolean }> {
    try {
      const profileId = await this.getCurrentUserProfileId()

      debug.log(`🔄 Core: Toggling bookmark: post=${postId}, user=${profileId}`)

      // Check if already bookmarked
      const { data: existingBookmark } = await supabase
        .from('post_interactions')
        .select('id')
        .match({ 
          post_id: postId, 
          user_id: profileId, 
          interaction_type: 'bookmark' 
        })
        .maybeSingle()

      let bookmarked: boolean

      if (existingBookmark) {
        // Remove bookmark
        const { error } = await supabase
          .from('post_interactions')
          .delete()
          .match({ 
            post_id: postId, 
            user_id: profileId, 
            interaction_type: 'bookmark' 
          })

        if (error) throw this.createError('REMOVE_BOOKMARK_FAILED', error.message, error)
        bookmarked = false
      } else {
        // Add bookmark
        const { error } = await supabase
          .from('post_interactions')
          .insert({
            post_id: postId,
            user_id: profileId,
            interaction_type: 'bookmark',
            is_local: true
          })

        if (error) throw this.createError('ADD_BOOKMARK_FAILED', error.message, error)
        bookmarked = true
      }

      debug.log(`✅ Core: Bookmark ${bookmarked ? 'added' : 'removed'} successfully`)
      return { bookmarked }
    } catch (error) {
      debug.error('❌ Core: Failed to toggle bookmark:', error)
      throw error
    }
  }

  private static readonly MAX_PINNED_POSTS = 5

  /**
   * Toggle pin on a post (pin/unpin to profile).
   * Only the author can pin their own public/unlisted posts, up to MAX_PINNED_POSTS.
   */
  async togglePinPost(postId: string): Promise<{ pinned: boolean }> {
    try {
      const profileId = await this.getCurrentUserProfileId()

      const { data: post, error: fetchError } = await supabase
        .from('posts')
        .select('id, author_id, is_pinned, visibility')
        .eq('id', postId)
        .single()

      if (fetchError || !post) {
        throw this.createError('POST_NOT_FOUND', 'Post not found')
      }

      if (post.author_id !== profileId) {
        throw this.createError('NOT_AUTHOR', 'Only the author can pin their own posts')
      }

      const targetState = !post.is_pinned

      if (targetState) {
        if (post.visibility !== 'public' && post.visibility !== 'unlisted') {
          throw this.createError('VISIBILITY_RESTRICTED', 'Only public or unlisted posts can be pinned')
        }

        const { count, error: countError } = await supabase
          .from('posts')
          .select('id', { count: 'exact', head: true })
          .eq('author_id', profileId)
          .eq('is_pinned', true)
          .eq('is_deleted', false)

        if (countError) throw this.createError('COUNT_FAILED', countError.message, countError)

        if ((count ?? 0) >= CorePostService.MAX_PINNED_POSTS) {
          throw this.createError(
            'PIN_LIMIT_REACHED',
            `You can pin at most ${CorePostService.MAX_PINNED_POSTS} posts`
          )
        }
      }

      const { error: updateError } = await supabase
        .from('posts')
        .update({ is_pinned: targetState })
        .eq('id', postId)

      if (updateError) throw this.createError('PIN_UPDATE_FAILED', updateError.message, updateError)

      debug.log(`📌 Core: Post ${postId} ${targetState ? 'pinned' : 'unpinned'}`)
      return { pinned: targetState }
    } catch (error) {
      debug.error('❌ Core: Failed to toggle pin:', error)
      throw error
    }
  }

  /**
   * Get pinned posts for a user profile (includes author join for display)
   */
  async getPinnedPosts(authorId: string): Promise<any[]> {
    try {
      const { data, error } = await supabase
        .from('posts')
        .select('*, author:profiles!posts_author_id_fkey (id, username, display_name, domain, avatar_url, is_local)')
        .eq('author_id', authorId)
        .eq('is_pinned', true)
        .eq('is_deleted', false)
        .in('visibility', ['public', 'unlisted'])
        .order('created_at', { ascending: false })
        .limit(CorePostService.MAX_PINNED_POSTS)

      if (error) throw this.createError('FETCH_PINNED_FAILED', error.message, error)
      return data || []
    } catch (error) {
      debug.error('❌ Core: Failed to fetch pinned posts:', error)
      throw error
    }
  }

  /**
   * Toggle reaction on a post
   * Uses AuthContextService for efficient auth lookup
   */
  async toggleReaction(
    postId: string, 
    emojiId: string
  ): Promise<{ added: boolean; hadRaceCondition?: boolean }> {
    try {
      const profileId = await this.getCurrentUserProfileId()

      debug.log(`🔄 Core: Toggling post reaction: post=${postId}, emoji=${emojiId}, user=${profileId}`)

      // Check if reaction already exists
      const { data: existingReaction } = await supabase
        .from('post_interactions')
        .select('id')
        .match({ 
          post_id: postId, 
          user_id: profileId, 
          interaction_type: 'emoji_reaction',
          emoji_id: emojiId 
        })
        .maybeSingle()

      if (existingReaction) {
        // Remove reaction
        const { error } = await supabase
          .from('post_interactions')
          .delete()
          .match({ 
            post_id: postId, 
            user_id: profileId, 
            interaction_type: 'emoji_reaction',
            emoji_id: emojiId 
          })

        if (error) throw this.createError('REMOVE_REACTION_FAILED', error.message, error)
        
        debug.log('✅ Core: Post reaction removed successfully')
        return { added: false }
      } else {
        // Add reaction
        const { error } = await supabase
          .from('post_interactions')
          .insert({
            post_id: postId,
            user_id: profileId,
            interaction_type: 'emoji_reaction',
            emoji_id: emojiId,
            is_local: true
          })

        if (error) {
          // Handle race condition (duplicate constraint violation)
          if (error.code === '23505') {
            debug.log('🎯 Core: Race condition detected in post reaction toggle')
            
            // Double-check current state after race condition
            const { data: nowExists } = await supabase
              .from('post_interactions')
              .select('id')
              .match({ 
                post_id: postId, 
                user_id: profileId, 
                interaction_type: 'emoji_reaction',
                emoji_id: emojiId 
              })
              .maybeSingle()

            if (nowExists) {
              debug.log('✅ Core: Post reaction was added by another process, treating as success')
              return { added: true, hadRaceCondition: true }
            } else {
              throw this.createError('RACE_CONDITION_ERROR', 'Unexpected duplicate error state')
            }
          }
          throw this.createError('ADD_REACTION_FAILED', error.message, error)
        }
        
        debug.log('✅ Core: Post reaction added successfully')
        return { added: true }
      }
    } catch (error) {
      debug.error('❌ Core: Failed to toggle post reaction:', error)
      throw error
    }
  }

  /**
   * Get reactions for a post using database function (pure local)
   */
  async getPostReactions(postId: string): Promise<any[]> {
    try {
      debug.log(`🔄 Core: Fetching reactions for post: ${postId}`)
      
      const { data: reactions, error } = await supabase
        .rpc('get_post_emoji_reactions', { p_post_id: postId })

      if (error) {
        debug.error('❌ Core: Failed to fetch post reactions:', error)
        throw this.createError('FETCH_REACTIONS_FAILED', error.message, error)
      }

      debug.log(`✅ Core: Fetched ${reactions?.length || 0} reaction groups for post: ${postId}`)
      return reactions || []
    } catch (error) {
      debug.error('❌ Core: Error in getPostReactions:', error)
      throw error
    }
  }

  // =====================================================
  // POST LOADING (PURE LOCAL)
  // =====================================================

  /**
   * Get reactions for multiple posts using optimized database function (pure local)
   * PERFORMANCE: Uses database function to eliminate N+1 query problem
   */
  private async getBatchPostReactions(postIds: string[]): Promise<Record<string, any[]>> {
    try {
      if (postIds.length === 0) {
        return {}
      }

      debug.log(`🔄 Core: Batch fetching reactions for ${postIds.length} posts`)
      
      // Use the optimized database function
      const { data: reactions, error } = await supabase
        .rpc('get_batch_post_reactions', { post_ids: postIds })

      if (error) {
        debug.error('❌ Core: Failed to batch fetch post reactions:', error)
        throw this.createError('BATCH_FETCH_POST_REACTIONS_FAILED', error.message, error)
      }

      // Group reactions by post_id
      const groupedReactions: Record<string, any[]> = {}
      
      // Initialize all post IDs with empty arrays
      postIds.forEach(postId => {
        groupedReactions[postId] = []
      })

      // Group reactions by post
      reactions?.forEach((reaction: any) => {
        const postId = reaction.post_id
        
        if (!groupedReactions[postId]) {
          groupedReactions[postId] = []
        }
        
        groupedReactions[postId].push({
          emoji_id: reaction.emoji_id,
          emoji: {
            id: reaction.emoji_id,
            name: reaction.emoji_name,
            url: reaction.emoji_url
          },
          count: reaction.reaction_count,
          users: reaction.users
        })
      })

      debug.log(`✅ Core: Batch fetched reactions for ${postIds.length} posts (${reactions?.length || 0} reaction groups)`)
      return groupedReactions
    } catch (error) {
      debug.error('❌ Core: Error in getBatchPostReactions:', error)
      throw error
    }
  }

  /**
   * Load timeline posts with pagination (pure local)
   */
  async loadTimelinePosts(
    timeline: 'public' | 'home' | 'local',
    options: {
      limit?: number
      before?: string
      after?: string
      signal?: AbortSignal
    } = {}
  ): Promise<TimelinePost[]> {
    try {
      const { limit = 20, before, after, signal } = options

      debug.log(`🔄 Core: Loading ${timeline} timeline posts`)

      let query = supabase
        .from('timeline_posts')
        .select('*')
        .eq('timeline_type', timeline)
        .or('is_deleted.is.null,is_deleted.eq.false')
        .order('created_at', { ascending: false })
        .limit(limit)

      if (before) {
        query = query.lt('created_at', before)
      }
      if (after) {
        query = query.gt('created_at', after)
      }

      if (signal?.aborted) {
        throw this.createError('ABORTED', 'Request was aborted')
      }

      const { data: posts, error } = await query

      if (error) throw this.createError('LOAD_POSTS_FAILED', error.message, error)

      const postList = posts || []

      // PERFORMANCE OPTIMIZATION: Batch load reactions for all posts
      if (postList.length > 0) {
        const postIds = postList.map(p => p.id)
        const reactionsByPost = await this.getBatchPostReactions(postIds)
        
        // Attach reactions to each post
        postList.forEach(post => {
          post.reactions = reactionsByPost[post.id] || []
        })
      }

      debug.log(`✅ Core: Loaded ${postList.length} posts with reactions for ${timeline} timeline`)
      return postList
    } catch (error) {
      debug.error('❌ Core: Failed to load timeline posts:', error)
      throw error
    }
  }

  /**
   * Load a single post by ID (pure local)
   */
  async loadPost(postId: string): Promise<TimelinePost | null> {
    try {
      debug.log(`🔄 Core: Loading post: ${postId}`)

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
          debug.log(`ℹ️ Core: Post not found: ${postId}`)
          return null
        }
        throw this.createError('LOAD_POST_FAILED', error.message, error)
      }

      const formatted = this.formatTimelinePost(post)

      // Fetch current user's interactions for timeline/embed (favorite + emoji_reaction light up heart)
      try {
        const profileId = await authContextService.getCurrentProfileId()
        if (profileId) {
          const { data: interactions } = await supabase
            .from('post_interactions')
            .select('interaction_type')
            .eq('post_id', postId)
            .eq('user_id', profileId)
            .in('interaction_type', ['favorite', 'emoji_reaction', 'reblog', 'bookmark'])

          const types = new Set(interactions?.map((i) => i.interaction_type) || [])
          formatted.is_favorited = types.has('favorite') || types.has('emoji_reaction')
          formatted.is_reblogged = types.has('reblog')
          formatted.is_bookmarked = types.has('bookmark')
        }
      } catch {
        // User not logged in or profile not found – keep defaults
      }

      debug.log(`✅ Core: Loaded post: ${postId}`)
      return formatted
    } catch (error) {
      debug.error('❌ Core: Failed to load post:', error)
      throw error
    }
  }

  // =====================================================
  // HELPER METHODS (PURE LOCAL)
  // =====================================================

  private async getCurrentUserProfileId(): Promise<string> {
    try {
      debug.log('🔍 Core: Getting current user profile ID...')
      
      // OPTIMIZED: Use cached profile ID from AuthContextService
      const profileId = await authContextService.getCurrentProfileId()
      
      if (!profileId) {
        throw this.createError('PROFILE_NOT_FOUND', 'User profile not found')
      }
      
      debug.log('✅ Core: Got profile ID:', profileId)
      return profileId
    } catch (error) {
      debug.error('❌ Core: Failed to get current user profile ID:', error)
      throw error
    }
  }

  private formatTimelinePost(post: any): TimelinePost {
    return {
      id: post.id,
      user_id: post.user_id,
      content: post.content,
      visibility: post.visibility,
      created_at: post.created_at,
      updated_at: post.updated_at,
      reply_context: post.reply_context,
      is_local: post.is_local,
      is_federated: post.is_federated,
      author: post.author,
      author_id: post.author_id,
      ap_id: post.ap_id,
      ap_type: post.ap_type,
      url: post.url,
      in_reply_to: post.in_reply_to,
      conversation_id: post.conversation_id,
      is_deleted: post.is_deleted,
      is_pinned: post.is_pinned ?? false,
      metadata: post.metadata,
      favorites_count: post.favorites_count || 0,
      reblogs_count: post.reblogs_count || 0,
      replies_count: post.replies_count || 0,
      is_favorited: false, // Will be set by orchestrator
      is_reblogged: false, // Will be set by orchestrator
      is_bookmarked: false, // Will be set by orchestrator
      content_warning: post.content_warning,
      is_sensitive: post.is_sensitive,
      language: post.language,
      media_attachments: post.media_attachments || [],
      reblog: post.reblog || undefined,
      reblog_author: post.reblog_author || undefined
    } as TimelinePost
  }

  private createError(code: string, message: string, details?: any): CorePostServiceError {
    return { code, message, details }
  }

  /**
   * Fetch the admin-configured max post length from `instance_config`.
   * Falls back to `DEFAULT_MAX_POST_TEXT_LENGTH` if the row is missing
   * or unparseable, and clamps to the DB-side hard ceiling so a
   * misconfigured admin value can't push a row into a state the CHECK
   * constraint will reject.
   */
  private async getMaxPostLength(): Promise<number> {
    const { data } = await supabase
      .from('instance_config')
      .select('config_value')
      .eq('config_key', 'max_post_length')
      .maybeSingle()
    const raw = data?.config_value
    const parsed =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? parseInt(raw, 10)
          : NaN
    const value = !Number.isNaN(parsed) && parsed >= 1
      ? parsed
      : DEFAULT_MAX_POST_TEXT_LENGTH
    return Math.min(value, MESSAGE_TEXT_HARD_CEILING)
  }
}

// Export singleton instance
export const corePostService = CorePostService.getInstance()