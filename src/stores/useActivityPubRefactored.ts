/**
 * ActivityPub Store - REFACTORED Example
 * 
 * This demonstrates how to migrate existing stores to use the new service layer.
 * Shows the clean patterns with local-first operations and optional federation.
 * 
 * Key Changes:
 * - Uses PostService instead of direct database calls
 * - Uses ChatService for message operations
 * - Uses RelationshipService for follows/blocks
 * - Clean error handling with federation status
 * - Local-first mentality
 */

import { defineStore } from 'pinia'
import { postService } from '@/services/core/PostService'
import { chatService } from '@/services/core/ChatService'
import { relationshipService } from '@/services/core/RelationshipService'
import { federationManager } from '@/services/federation/FederationManager'
import { supabase } from '@/supabase'
import router from '@/router'
import type { 
  TimelinePost, 
  PostComposerState, 
  MonyFeed,
  FederatedUser
} from '@/types'

interface ActivityPubStateRefactored {
  // Feed state
  homeFeed: MonyFeed
  publicFeed: MonyFeed
  localFeed: MonyFeed
  
  // UI state
  isComposerOpen: boolean
  composerState: PostComposerState
  currentView: 'home' | 'public' | 'local'
  
  // Loading states
  isLoadingFeed: boolean
  isPosting: boolean
  
  // Federation status
  federationStatus: {
    enabled: boolean
    health: 'healthy' | 'degraded' | 'offline'
    lastSync?: Date
  }
}

export const useActivityPubRefactoredStore = defineStore('activitypub-refactored', {
  state: (): ActivityPubStateRefactored => ({
    // Feed state
    homeFeed: {
      posts: [],
      has_more: true,
      cursor: undefined
    },
    publicFeed: {
      posts: [],
      has_more: true,
      cursor: undefined
    },
    localFeed: {
      posts: [],
      has_more: true,
      cursor: undefined
    },
    
    // UI state
    isComposerOpen: false,
    composerState: {
      content: '',
      visibility: 'public',
      contentWarning: undefined,
      sensitive: false,
      language: 'en',
      replyTo: undefined,
      mediaAttachments: []
    },
    currentView: 'public',
    
    // Loading states
    isLoadingFeed: false,
    isPosting: false,
    
    // Federation status
    federationStatus: {
      enabled: false,
      health: 'offline'
    }
  }),

  actions: {
    /**
     * Initialize the store and federation
     */
    async initialize() {
      console.log('🚀 Initializing ActivityPub store (refactored)')
      
      // Initialize federation manager
      const initResult = await federationManager.initialize()
      if (!initResult.success) {
        console.error('❌ Failed to initialize federation:', initResult.error)
      }
      
      // Update federation status
      await this.updateFederationStatus()
      
      console.log('✅ ActivityPub store initialized')
    },

    /**
     * Create a post using the new PostService
     * LOCAL-FIRST: Works even if federation is disabled
     */
    async createPost(postData: {
      content: string
      visibility?: 'public' | 'unlisted' | 'followers' | 'mentioned' | 'private'
      contentWarning?: string
      inReplyTo?: string
      isSensitive?: boolean
    }) {
      this.isPosting = true
      
      try {
        const user = await supabase.auth.getUser()
        if (!user.data.user) {
          throw new Error('User not authenticated')
        }

        console.log('📝 Creating post using PostService...')
        
        // Use PostService for clean, local-first operation
        const result = await postService.createPost(user.data.user.id, {
          content: postData.content,
          visibility: postData.visibility || 'public',
          contentWarning: postData.contentWarning,
          inReplyTo: postData.inReplyTo,
          isSensitive: postData.isSensitive || false
        })

        if (!result.success) {
          throw new Error(result.error || 'Failed to create post')
        }

        console.log('✅ Post created locally:', result.post?.id)
        
        // Add to feeds immediately (local-first UX)
        if (result.post) {
          this.addPostToFeeds(result.post)
        }

        // Show federation status to user
        if (result.federationStatus?.attempted) {
          if (result.federationStatus.success) {
            console.log(`🌐 Post federated to ${result.federationStatus.targets?.length || 0} instances`)
          } else {
            console.warn('⚠️ Federation failed:', result.federationStatus.error)
            // Could show user notification about federation failure
          }
        }

        // Close composer
        this.closeComposer()
        
        return result.post

      } catch (error) {
        console.error('❌ Failed to create post:', error)
        throw error
      } finally {
        this.isPosting = false
      }
    },

    /**
     * Like a post using the new PostService
     * LOCAL-FIRST: Likes locally immediately, federation happens in background
     */
    async likePost(postId: string, emoji?: string) {
      try {
        const user = await supabase.auth.getUser()
        if (!user.data.user) {
          throw new Error('User not authenticated')
        }

        console.log('❤️ Liking post using PostService...')

        // Optimistically update UI first (local-first UX)
        this.updatePostLikeStateOptimistic(postId, true)

        // Use PostService for clean operation
        const result = await postService.likePost(user.data.user.id, postId, emoji)

        if (!result.success) {
          // Revert optimistic update on failure
          this.updatePostLikeStateOptimistic(postId, false)
          throw new Error(result.error || 'Failed to like post')
        }

        console.log('✅ Post liked locally')

        // Federation happens automatically in background
        // No need to block user experience

        return true

      } catch (error) {
        console.error('❌ Failed to like post:', error)
        throw error
      }
    },

    /**
     * Follow a user using the new RelationshipService
     * LOCAL-FIRST: Creates relationship locally, federates if remote user
     */
    async followUser(userId: string) {
      try {
        const user = await supabase.auth.getUser()
        if (!user.data.user) {
          throw new Error('User not authenticated')
        }

        console.log('👥 Following user using RelationshipService...')

        const result = await relationshipService.followUser(user.data.user.id, userId)

        if (!result.success) {
          throw new Error(result.error || 'Failed to follow user')
        }

        console.log('✅ Follow created locally')

        // Show appropriate feedback to user
        if (result.requiresApproval) {
          console.log('⏳ Follow request sent (requires approval)')
          // Could show user notification about pending request
        }

        // Federation status (non-blocking)
        if (result.federationStatus?.attempted) {
          if (result.federationStatus.success) {
            console.log('🌐 Follow request federated successfully')
          } else {
            console.warn('⚠️ Federation failed:', result.federationStatus.error)
          }
        }

        return result

      } catch (error) {
        console.error('❌ Failed to follow user:', error)
        throw error
      }
    },

    /**
     * Send a message using the new ChatService
     * Automatically detects channel vs DM and handles federation
     */
    async sendMessage(options: {
      content: string
      channelId?: string
      recipientId?: string
      replyTo?: string
    }) {
      try {
        const user = await supabase.auth.getUser()
        if (!user.data.user) {
          throw new Error('User not authenticated')
        }

        console.log('💬 Sending message using ChatService...')

        const result = await chatService.sendMessage(user.data.user.id, {
          content: options.content,
          channelId: options.channelId,
          recipientId: options.recipientId,
          replyTo: options.replyTo
        })

        if (!result.success) {
          throw new Error(result.error || 'Failed to send message')
        }

        console.log('✅ Message sent locally:', result.message?.id)

        // Federation happens automatically based on recipient
        if (result.federationStatus?.attempted) {
          if (result.federationStatus.success) {
            console.log(`🌐 Message federated to ${result.federationStatus.targets?.length || 0} instances`)
          } else {
            console.warn('⚠️ Message federation failed:', result.federationStatus.error)
          }
        }

        return result.message

      } catch (error) {
        console.error('❌ Failed to send message:', error)
        throw error
      }
    },

    /**
     * Update federation status
     */
    async updateFederationStatus() {
      try {
        const status = await federationManager.getFederationStatus()
        this.federationStatus = {
          enabled: status.enabled,
          health: status.health,
          lastSync: status.lastActivity
        }
      } catch (error) {
        console.error('❌ Failed to update federation status:', error)
        this.federationStatus = {
          enabled: false,
          health: 'offline'
        }
      }
    },

    /**
     * Toggle federation (admin action)
     */
    async toggleFederation(enabled: boolean) {
      try {
        const result = enabled 
          ? await federationManager.enableFederation()
          : await federationManager.disableFederation()

        if (!result.success) {
          throw new Error(result.error)
        }

        await this.updateFederationStatus()
        
        console.log(`${enabled ? '✅' : '🚫'} Federation ${enabled ? 'enabled' : 'disabled'}`)
        
      } catch (error) {
        console.error('❌ Failed to toggle federation:', error)
        throw error
      }
    },

    // =============================================
    // UI HELPER METHODS
    // =============================================

    openComposer() {
      this.isComposerOpen = true
    },

    closeComposer() {
      this.isComposerOpen = false
      this.composerState = {
        content: '',
        visibility: 'public',
        contentWarning: undefined,
        sensitive: false,
        language: 'en',
        replyTo: undefined,
        mediaAttachments: []
      }
    },

    /**
     * Add post to appropriate feeds
     */
    addPostToFeeds(post: TimelinePost) {
      // Add to public feed if public
      if (post.visibility === 'public') {
        this.publicFeed.posts.unshift(post)
        if (this.publicFeed.posts.length > 100) {
          this.publicFeed.posts = this.publicFeed.posts.slice(0, 100)
        }
      }

      // Add to local feed if local
      if (post.is_local && post.visibility === 'public') {
        this.localFeed.posts.unshift(post)
        if (this.localFeed.posts.length > 100) {
          this.localFeed.posts = this.localFeed.posts.slice(0, 100)
        }
      }

      // Add to home feed (simplified logic)
      this.homeFeed.posts.unshift(post)
      if (this.homeFeed.posts.length > 100) {
        this.homeFeed.posts = this.homeFeed.posts.slice(0, 100)
      }
    },

    /**
     * Optimistically update like state for immediate UI feedback
     */
    updatePostLikeStateOptimistic(postId: string, isLiked: boolean) {
      const updatePost = (posts: TimelinePost[]) => {
        const post = posts.find(p => p.id === postId)
        if (post) {
          post.is_favorited = isLiked
          post.favorite_count += isLiked ? 1 : -1
        }
      }

      updatePost(this.homeFeed.posts)
      updatePost(this.publicFeed.posts)
      updatePost(this.localFeed.posts)
    }
  }
})

/**
 * Usage Examples:
 * 
 * // Create post (works locally even if federation fails)
 * await store.createPost({
 *   content: "Hello world!",
 *   visibility: "public"
 * })
 * 
 * // Like post (immediate UI feedback, federation in background)
 * await store.likePost(postId)
 * 
 * // Follow user (handles local vs remote automatically)
 * await store.followUser(userId)
 * 
 * // Send message (auto-detects channel vs DM, federates if needed)
 * await store.sendMessage({
 *   content: "Hello!",
 *   recipientId: "user-id" // Will create DM and federate if remote
 * })
 * 
 * // Admin: Toggle federation
 * await store.toggleFederation(false) // Disable federation entirely
 */