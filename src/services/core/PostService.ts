/**
 * PostService - Clean interface for all post operations
 * 
 * Local-first design: All operations work locally first, federation is optional.
 * This service replaces direct database calls with a unified interface.
 * 
 * Features:
 * - Local-first operations
 * - Optional federation
 * - Clean error handling
 * - Consistent API
 * - Federation status feedback
 */

import { supabase } from '@/supabase'
import { createOutgoingHandler } from '@/services/federation/OutgoingHandler'
import type { MessagePart, Post, TimelinePost } from '@/types'

export interface CreatePostOptions {
  content: string | MessagePart[]
  visibility?: 'public' | 'unlisted' | 'followers' | 'mentioned' | 'private'
  contentWarning?: string
  inReplyTo?: string
  mediaAttachments?: any[]
  isSensitive?: boolean
  language?: string
}

export interface PostResult {
  success: boolean
  post?: TimelinePost
  error?: string
  federationStatus?: {
    attempted: boolean
    success: boolean
    targets?: string[]
    error?: string
  }
}

export interface PostInteractionResult {
  success: boolean
  error?: string
  localSuccess: boolean
  federationStatus?: {
    attempted: boolean
    success: boolean
    error?: string
  }
}

export class PostService {
  private static instance: PostService
  
  static getInstance(): PostService {
    if (!PostService.instance) {
      PostService.instance = new PostService()
    }
    return PostService.instance
  }
  
  /**
   * Create a new post
   * Local-first: Creates locally, then optionally federates
   */
  async createPost(authorId: string, options: CreatePostOptions): Promise<PostResult> {
    console.log('📝 PostService: Creating post for user:', authorId)
    
    try {
      // Step 1: Process content into unified format
      const processedContent = await this.processContent(options.content)
      
      // Step 2: Create post locally first
      const localResult = await this.createLocalPost(authorId, {
        ...options,
        content: processedContent
      })
      
      if (!localResult.success) {
        return {
          success: false,
          error: localResult.error,
          federationStatus: { attempted: false, success: false }
        }
      }
      
      console.log('✅ Post created locally:', localResult.post?.id)
      
      // Step 3: Attempt federation (optional, non-blocking)
      const federationStatus = await this.attemptFederation(localResult.post!)
      
      return {
        success: true,
        post: localResult.post,
        federationStatus
      }
      
    } catch (error) {
      console.error('❌ PostService: Error creating post:', error)
      return {
        success: false,
        error: error.message,
        federationStatus: { attempted: false, success: false }
      }
    }
  }
  
  /**
   * Like a post
   * Local-first: Likes locally, then optionally federates
   */
  async likePost(userId: string, postId: string, emoji?: string): Promise<PostInteractionResult> {
    console.log('❤️ PostService: Liking post:', postId)
    
    try {
      // Step 1: Like locally first
      const localResult = await this.likePostLocal(userId, postId, emoji)
      
      if (!localResult.success) {
        return {
          success: false,
          localSuccess: false,
          error: localResult.error,
          federationStatus: { attempted: false, success: false }
        }
      }
      
      console.log('✅ Post liked locally')
      
      // Step 2: Attempt federation (optional)
      const federationStatus = await this.federateLike(userId, postId, emoji)
      
      return {
        success: true,
        localSuccess: true,
        federationStatus
      }
      
    } catch (error) {
      console.error('❌ PostService: Error liking post:', error)
      return {
        success: false,
        localSuccess: false,
        error: error.message,
        federationStatus: { attempted: false, success: false }
      }
    }
  }
  
  /**
   * Unlike a post
   */
  async unlikePost(userId: string, postId: string): Promise<PostInteractionResult> {
    console.log('💔 PostService: Unliking post:', postId)
    
    try {
      const localResult = await this.unlikePostLocal(userId, postId)
      
      if (!localResult.success) {
        return {
          success: false,
          localSuccess: false,
          error: localResult.error,
          federationStatus: { attempted: false, success: false }
        }
      }
      
      console.log('✅ Post unliked locally')
      
      // TODO: Implement federation for unlike (Undo activity)
      const federationStatus = { attempted: false, success: false }
      
      return {
        success: true,
        localSuccess: true,
        federationStatus
      }
      
    } catch (error) {
      console.error('❌ PostService: Error unliking post:', error)
      return {
        success: false,
        localSuccess: false,
        error: error.message,
        federationStatus: { attempted: false, success: false }
      }
    }
  }
  
  /**
   * Reblog/share a post
   */
  async reblogPost(userId: string, postId: string, comment?: string): Promise<PostInteractionResult> {
    console.log('🔄 PostService: Reblogging post:', postId)
    
    try {
      const localResult = await this.reblogPostLocal(userId, postId, comment)
      
      if (!localResult.success) {
        return {
          success: false,
          localSuccess: false,
          error: localResult.error,
          federationStatus: { attempted: false, success: false }
        }
      }
      
      console.log('✅ Post reblogged locally')
      
      // TODO: Implement federation for reblog (Announce activity)
      const federationStatus = { attempted: false, success: false }
      
      return {
        success: true,
        localSuccess: true,
        federationStatus
      }
      
    } catch (error) {
      console.error('❌ PostService: Error reblogging post:', error)
      return {
        success: false,
        localSuccess: false,
        error: error.message,
        federationStatus: { attempted: false, success: false }
      }
    }
  }
  
  /**
   * Delete a post
   */
  async deletePost(postId: string, userId: string): Promise<PostInteractionResult> {
    console.log('🗑️ PostService: Deleting post:', postId)
    
    try {
      // Verify ownership
      const { data: post, error: fetchError } = await supabase
        .from('posts')
        .select('author_id, is_local')
        .eq('id', postId)
        .single()
      
      if (fetchError || !post) {
        return {
          success: false,
          localSuccess: false,
          error: 'Post not found',
          federationStatus: { attempted: false, success: false }
        }
      }
      
      if (post.author_id !== userId) {
        return {
          success: false,
          localSuccess: false,
          error: 'Not authorized to delete this post',
          federationStatus: { attempted: false, success: false }
        }
      }
      
      // Delete locally
      const { error: deleteError } = await supabase
        .from('posts')
        .delete()
        .eq('id', postId)
        .eq('author_id', userId)
      
      if (deleteError) {
        throw deleteError
      }
      
      console.log('✅ Post deleted locally')
      
      // TODO: Implement federation for delete (Delete activity)
      const federationStatus = { attempted: false, success: false }
      
      return {
        success: true,
        localSuccess: true,
        federationStatus
      }
      
    } catch (error) {
      console.error('❌ PostService: Error deleting post:', error)
      return {
        success: false,
        localSuccess: false,
        error: error.message,
        federationStatus: { attempted: false, success: false }
      }
    }
  }
  
  /**
   * Get a single post by ID
   */
  async getPost(postId: string): Promise<{ success: boolean; post?: TimelinePost; error?: string }> {
    try {
      // Use existing ActivityPub service for consistent timeline format
      const { activityPubService } = await import('@/services/activityPubService')
      const post = await activityPubService.loadPostWithAuthor(postId)
      
      if (!post) {
        return { success: false, error: 'Post not found' }
      }
      
      return { success: true, post }
      
    } catch (error) {
      console.error('❌ PostService: Error fetching post:', error)
      return { success: false, error: error.message }
    }
  }
  
  /**
   * Get thread/conversation for a post
   */
  async getThread(postId: string): Promise<{ success: boolean; posts?: TimelinePost[]; error?: string }> {
    try {
      // Use existing conversation service
      const { ConversationService } = await import('@/services/ConversationService')
      const thread = await ConversationService.getFullThread(postId)
      
      return { success: true, posts: thread }
      
    } catch (error) {
      console.error('❌ PostService: Error fetching thread:', error)
      return { success: false, error: error.message }
    }
  }
  
  // =============================================
  // PRIVATE METHODS
  // =============================================
  
  /**
   * Process content into unified MessagePart[] format
   */
  private async processContent(content: string | MessagePart[]): Promise<MessagePart[]> {
    if (Array.isArray(content)) {
      return content // Already in correct format
    }
    
    // Convert string to MessagePart[] using existing utility
    const { parseContentToMessageParts, resolveMentionsUserData, resolveEmojisData, resolveHashtagsData } = 
      await import('@/utils/unifiedContentProcessing')
    
    const [usernameToUserDataMap, emojiDataMap, hashtagDataMap] = await Promise.all([
      resolveMentionsUserData(content),
      resolveEmojisData(content),
      resolveHashtagsData(content)
    ])
    
    return parseContentToMessageParts(content, usernameToUserDataMap, emojiDataMap, hashtagDataMap)
  }
  
  /**
   * Create post in local database
   */
  private async createLocalPost(authorId: string, options: CreatePostOptions & { content: MessagePart[] }): Promise<{
    success: boolean
    post?: TimelinePost
    error?: string
  }> {
    const { data: post, error } = await supabase
      .from('posts')
      .insert([{
        author_id: authorId,
        content: options.content,
        visibility: options.visibility || 'public',
        content_warning: options.contentWarning,
        in_reply_to: options.inReplyTo,
        is_sensitive: options.isSensitive || false,
        language: options.language || 'en',
        is_local: true
      }])
      .select(`
        *,
        author:profiles!posts_author_id_fkey (
          id, username, display_name, avatar_url, domain, is_local
        )
      `)
      .single()
    
    if (error) {
      console.error('Failed to create post locally:', error)
      return { success: false, error: error.message }
    }
    
    // Transform to timeline format
    const timelinePost: TimelinePost = {
      ...post,
      favorite_count: 0,
      reblog_count: 0,
      reply_count: 0,
      is_favorited: false,
      is_reblogged: false,
      is_bookmarked: false,
      created_at: post.created_at,
      conversation_root_id: post.conversation_root_id
    }
    
    return { success: true, post: timelinePost }
  }
  
  /**
   * Like post locally
   */
  private async likePostLocal(userId: string, postId: string, emoji?: string): Promise<{
    success: boolean
    error?: string
  }> {
    const { error } = await supabase
      .from('post_interactions')
      .insert([{
        user_id: userId,
        post_id: postId,
        interaction_type: 'favorite',
        emoji_reaction: emoji
      }])
    
    if (error) {
      // Handle duplicate likes gracefully
      if (error.code === '23505') {
        return { success: true } // Already liked
      }
      return { success: false, error: error.message }
    }
    
    return { success: true }
  }
  
  /**
   * Unlike post locally
   */
  private async unlikePostLocal(userId: string, postId: string): Promise<{
    success: boolean
    error?: string
  }> {
    const { error } = await supabase
      .from('post_interactions')
      .delete()
      .eq('user_id', userId)
      .eq('post_id', postId)
      .eq('interaction_type', 'favorite')
    
    if (error) {
      return { success: false, error: error.message }
    }
    
    return { success: true }
  }
  
  /**
   * Reblog post locally
   */
  private async reblogPostLocal(userId: string, postId: string, comment?: string): Promise<{
    success: boolean
    error?: string
  }> {
    const { error } = await supabase
      .from('post_interactions')
      .insert([{
        user_id: userId,
        post_id: postId,
        interaction_type: 'reblog',
        comment: comment
      }])
    
    if (error) {
      if (error.code === '23505') {
        return { success: true } // Already reblogged
      }
      return { success: false, error: error.message }
    }
    
    return { success: true }
  }
  
  /**
   * Attempt federation for a post
   */
  private async attemptFederation(post: TimelinePost): Promise<{
    attempted: boolean
    success: boolean
    targets?: string[]
    error?: string
  }> {
    try {
      const outgoingHandler = await createOutgoingHandler()
      
      const result = await outgoingHandler.federatePost({
        id: post.id,
        content: post.content,
        visibility: post.visibility,
        author_id: post.author_id,
        in_reply_to: post.in_reply_to,
        content_warning: post.content_warning
      })
      
      return {
        attempted: true,
        success: result.success,
        targets: result.targets,
        error: result.error
      }
      
    } catch (error) {
      console.error('❌ Federation attempt failed:', error)
      return {
        attempted: true,
        success: false,
        error: error.message
      }
    }
  }
  
  /**
   * Federate a like
   */
  private async federateLike(userId: string, postId: string, emoji?: string): Promise<{
    attempted: boolean
    success: boolean
    error?: string
  }> {
    try {
      const outgoingHandler = await createOutgoingHandler()
      
      const result = await outgoingHandler.federateLike({
        user_id: userId,
        post_id: postId,
        emoji
      })
      
      return {
        attempted: true,
        success: result.success,
        error: result.error
      }
      
    } catch (error) {
      console.error('❌ Like federation failed:', error)
      return {
        attempted: true,
        success: false,
        error: error.message
      }
    }
  }
}

// Export singleton instance
export const postService = PostService.getInstance()