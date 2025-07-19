/**
 * PostService - Orchestrated post management
 * 
 * ORCHESTRATION PATTERN: Combines Core + Federation services
 * - CorePostService: Pure local database operations
 * - FederationDecisionService: Federation decision logic
 * - FederationActivityService: ActivityPub activity creation
 * 
 * PRESERVED APIs: 
 * - ✅ Same method signatures as before
 * - ✅ Same return types and error formats
 * - ✅ Same loading patterns and pagination
 * - ✅ Same local-first design (immediate UI updates)
 * 
 * ENHANCED ARCHITECTURE:
 * - Clean separation of concerns
 * - Testable service components
 * - Professional orchestration patterns
 */

import { supabase } from '@/supabase'
import type { Post, TimelinePost, MessagePart } from '@/types'

// Import core and federation services
import { corePostService } from './core'
import { federationDecisionService, federationActivityService } from './federation'

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
  // POST CREATION & MANAGEMENT (ORCHESTRATED: CORE + FEDERATION)
  // =====================================================

  /**
   * Create a new post (orchestrated: local-first + conditional federation)
   */
  async createPost(data: CreatePostData): Promise<TimelinePost> {
    try {
      console.log(`🎭 Orchestration: Creating post with visibility: ${data.visibility}`)

      // 1. Core operation: Pure local post creation (always first)
      const post = await corePostService.createPost(data)

      // 2. Federation decision: Should this post federate?
      const decision = await federationDecisionService.shouldFederatePost(post.id, 'create')
      
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: Post eligible for federation: ${decision.reason}`)
        
        // 3. Federation operation: Create ActivityPub activity
        const activityResult = await federationActivityService.createPostActivity(post.id, 'create')
        
        if (activityResult.success) {
          console.log(`✅ Orchestration: Post federation activity created: ${activityResult.activityId}`)
        } else {
          console.warn(`⚠️ Orchestration: Post federation failed (post still created locally): ${activityResult.error}`)
        }
      } else {
        console.log(`ℹ️ Orchestration: Post federation skipped: ${decision.reason}`)
      }

      console.log(`✅ Orchestration: Post created successfully: ${post.id}`)
      return post

    } catch (error) {
      console.error('❌ Orchestration: Failed to create post:', error)
      throw error
    }
  }

  /**
   * Update an existing post (orchestrated: local-first + conditional federation)
   */
  async updatePost(postId: string, updates: UpdatePostData): Promise<TimelinePost> {
    try {
      console.log(`🎭 Orchestration: Updating post: ${postId}`)

      // 1. Core operation: Pure local post update
      const post = await corePostService.updatePost(postId, updates)

      // 2. Federation decision: Should this update federate?
      const decision = await federationDecisionService.shouldFederatePost(postId, 'update')
      
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: Post update eligible for federation: ${decision.reason}`)
        
        // 3. Federation operation: Create ActivityPub Update activity
        const activityResult = await federationActivityService.createPostActivity(postId, 'update')
        
        if (activityResult.success) {
          console.log(`✅ Orchestration: Post update federation activity created: ${activityResult.activityId}`)
        } else {
          console.warn(`⚠️ Orchestration: Post update federation failed (update still applied locally): ${activityResult.error}`)
        }
      } else {
        console.log(`ℹ️ Orchestration: Post update federation skipped: ${decision.reason}`)
      }

      console.log(`✅ Orchestration: Post updated successfully: ${postId}`)
      return post

    } catch (error) {
      console.error('❌ Orchestration: Failed to update post:', error)
      throw error
    }
  }

  /**
   * Delete a post (orchestrated: local-first + conditional federation)
   */
  async deletePost(postId: string): Promise<void> {
    try {
      console.log(`🎭 Orchestration: Deleting post: ${postId}`)

      // Check federation before deletion (need post data)
      const decision = await federationDecisionService.shouldFederatePost(postId, 'delete')

      // 1. Core operation: Pure local post deletion
      await corePostService.deletePost(postId)

      // 2. Federation operation: Create Delete activity if needed
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: Post deletion eligible for federation: ${decision.reason}`)
        
        const activityResult = await federationActivityService.createPostActivity(postId, 'delete')
        
        if (activityResult.success) {
          console.log(`✅ Orchestration: Post deletion federation activity created: ${activityResult.activityId}`)
        } else {
          console.warn(`⚠️ Orchestration: Post deletion federation failed (post still deleted locally): ${activityResult.error}`)
        }
      } else {
        console.log(`ℹ️ Orchestration: Post deletion federation skipped: ${decision.reason}`)
      }

      console.log(`✅ Orchestration: Post deleted successfully: ${postId}`)

    } catch (error) {
      console.error('❌ Orchestration: Failed to delete post:', error)
      throw error
    }
  }

  // =====================================================
  // POST INTERACTIONS (ORCHESTRATED: CORE + FEDERATION)
  // =====================================================

  /**
   * Toggle like on a post (orchestrated: local-first + conditional federation)
   * PRESERVES: Exact same API and return type
   */
  async toggleLike(postId: string): Promise<{ liked: boolean; newCount: number }> {
    try {
      console.log(`🎭 Orchestration: Toggling like for post: ${postId}`)

      // 1. Core operation: Pure local like toggle
      const result = await corePostService.toggleLike(postId)

      // 2. Get current user for federation decision
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // 3. Federation decision: Should this like federate?
      const decision = await federationDecisionService.shouldFederatePost(postId, 'create')
      
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: Post like eligible for federation: ${decision.reason}`)
        
        // 4. Federation operation: Create Like/Undo activity
        // Note: We'll need to enhance FederationActivityService to handle likes
        // For now, we'll use the post activity pattern
        console.log(`ℹ️ Orchestration: Like federation not yet implemented (like still applied locally)`)
      } else {
        console.log(`ℹ️ Orchestration: Post like federation skipped: ${decision.reason}`)
      }

      console.log(`✅ Orchestration: Post like toggled successfully: ${result.liked ? 'liked' : 'unliked'}`)
      return result

    } catch (error) {
      console.error('❌ Orchestration: Failed to toggle like:', error)
      throw error
    }
  }

  /**
   * Toggle share/reblog on a post (orchestrated: local-first + conditional federation)
   * PRESERVES: Exact same API and return type
   */
  async toggleShare(postId: string): Promise<{ shared: boolean; newCount: number }> {
    try {
      console.log(`🎭 Orchestration: Toggling share for post: ${postId}`)

      // 1. Core operation: Pure local share toggle
      const result = await corePostService.toggleShare(postId)

      // 2. Get current user for federation decision
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      // 3. Federation decision: Should this share federate?
      const decision = await federationDecisionService.shouldFederatePost(postId, 'create')
      
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: Post share eligible for federation: ${decision.reason}`)
        
        // 4. Federation operation: Create Announce/Undo activity
        // Note: We'll need to enhance FederationActivityService to handle shares
        console.log(`ℹ️ Orchestration: Share federation not yet implemented (share still applied locally)`)
      } else {
        console.log(`ℹ️ Orchestration: Post share federation skipped: ${decision.reason}`)
      }

      console.log(`✅ Orchestration: Post share toggled successfully: ${result.shared ? 'shared' : 'unshared'}`)
      return result

    } catch (error) {
      console.error('❌ Orchestration: Failed to toggle share:', error)
      throw error
    }
  }

  /**
   * Toggle bookmark on a post (delegated to core service - local-only)
   * PRESERVES: Exact same API and return type
   */
  async toggleBookmark(postId: string): Promise<{ bookmarked: boolean }> {
    try {
      console.log(`🎭 Orchestration: Toggling bookmark for post: ${postId}`)

      // Delegate to core service (bookmarks are local-only, no federation)
      const result = await corePostService.toggleBookmark(postId)

      console.log(`✅ Orchestration: Post bookmark toggled successfully: ${result.bookmarked ? 'bookmarked' : 'unbookmarked'}`)
      return result

    } catch (error) {
      console.error('❌ Orchestration: Failed to toggle bookmark:', error)
      throw error
    }
  }

  /**
   * Toggle reaction on a post (orchestrated: local-first + conditional federation)
   * NEW METHOD: For post emoji reactions
   */
  async toggleReaction(postId: string, emojiId: string): Promise<{ added: boolean; newCount: number }> {
    try {
      console.log(`🎭 Orchestration: Toggling reaction for post: ${postId}, emoji: ${emojiId}`)

      // 1. Core operation: Pure local reaction toggle
      const coreResult = await corePostService.toggleReaction(postId, emojiId)

      // 2. Get reaction count for the API response
      const { count } = await supabase
        .from('post_interactions')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', postId)
        .eq('interaction_type', 'reaction')
        .eq('emoji_id', emojiId)

      // 3. Get current user for federation decision
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const profileId = await this.getCurrentUserProfileId()

      // 4. Federation decision: Should this reaction federate?
      const decision = await federationDecisionService.shouldFederatePostReaction(postId, profileId)
      
      if (decision.shouldFederate) {
        console.log(`📤 Orchestration: Post reaction eligible for federation: ${decision.reason}`)
        
        // 5. Federation operation: Create reaction activity
        const operation = coreResult.added ? 'add' : 'remove'
        const activityResult = await federationActivityService.createPostReactionActivity(
          postId, 
          emojiId, 
          profileId, 
          operation
        )
        
        if (activityResult.success) {
          console.log(`✅ Orchestration: Post reaction federation activity created: ${activityResult.activityId}`)
        } else {
          console.warn(`⚠️ Orchestration: Post reaction federation failed (reaction still applied locally): ${activityResult.error}`)
        }
      } else {
        console.log(`ℹ️ Orchestration: Post reaction federation skipped: ${decision.reason}`)
      }

      // 6. Return API-compatible result
      const result = {
        added: coreResult.added,
        newCount: count || 0
      }

      console.log(`✅ Orchestration: Post reaction toggled successfully: ${result.added ? 'added' : 'removed'}`)
      return result

    } catch (error) {
      console.error('❌ Orchestration: Failed to toggle post reaction:', error)
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
      console.log(`🎭 Orchestration: Loading ${timelineType} timeline posts`)
      
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
      
      console.log(`✅ Orchestration: Loaded ${posts.length} timeline posts`)
      return result

    } catch (error) {
      console.error('❌ Orchestration: Failed to load timeline posts:', error)
      throw error
    }
  }

  /**
   * Load single post (delegated to core service)
   * PRESERVES: Exact same API and return type
   */
  async loadPost(postId: string): Promise<TimelinePost | null> {
    try {
      console.log(`🎭 Orchestration: Loading post: ${postId}`)
      
      // Delegate to core service (no federation needed for reads)
      const post = await corePostService.loadPost(postId)
      
      if (post) {
        console.log(`✅ Orchestration: Post loaded successfully: ${postId}`)
      } else {
        console.log(`ℹ️ Orchestration: Post not found: ${postId}`)
      }
      
      return post

    } catch (error) {
      console.error('❌ Orchestration: Failed to load post:', error)
      throw error
    }
  }

  // =====================================================
  // HELPER METHODS (PRESERVED)
  // =====================================================

  private async getCurrentUserProfileId(): Promise<string> {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw this.createError('AUTH_REQUIRED', 'User not authenticated')

      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('auth_user_id', user.id)
        .single()

      if (!profile) throw this.createError('PROFILE_NOT_FOUND', 'User profile not found')

      return profile.id
    } catch (error) {
      console.error('❌ Orchestration: Failed to get current user profile ID:', error)
      throw error
    }
  }

  private createError(code: string, message: string, details?: any): PostServiceError {
    const secureDetails = process.env.NODE_ENV === 'development' ? details : undefined
    return { code, message, details: secureDetails }
  }
}

// Export singleton instance
export const postService = PostService.getInstance()