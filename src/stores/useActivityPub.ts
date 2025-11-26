/**
 * ActivityPub Store - Pinia store for managing federated content and state
 * Professional state management for the Monyverse
 */

import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import { activityPubService } from '@/services/activityPubService';
import { services } from '@/services';
import router from '@/router';
import { usePostReactionsStore } from '@/stores/postReactions';
import { debug } from '@/utils/debug';
// InteractionService removed - using direct database operations
import type { 
  Post, 
  TimelinePost, 
  PostComposerState, 
  MonyFeed,
  FederatedUser,
  Notification,
  ConversationThread,
  ConversationContext,
  ReplyContext,
  PostWithContext,
  PostContextOptions,
  MessagePart
} from '@/types';

interface ActivityPubState {
  // Feed state
  homeFeed: MonyFeed;
  publicFeed: MonyFeed;
  localFeed: MonyFeed;
  userFeeds: Map<string, MonyFeed>;
  
  // Conversation state
  conversations: Map<string, ConversationThread>;
  conversationContexts: Map<string, ConversationContext>;
  
  // User state
  followedUsers: Set<string>;
  blockedUsers: Set<string>;
  mutedUsers: Set<string>;
  
  // Count tracking for realtime updates
  followingCount: number;
  followersCount: number;
  
  // Instance state
  knownInstances: any[];
  blockedInstances: Set<string>;
  
  // UI state
  isComposerOpen: boolean;
  composerState: PostComposerState;
  selectedPost?: Post;
  currentView: 'home' | 'public' | 'local';
  
  // Loading states
  isLoadingFeed: boolean;
  isLoadingPost: boolean;
  isLoadingProfile: boolean;
  isPosting: boolean;
  isLoadingConversation: boolean;
  
  // Realtime subscriptions
  realtimeSubscriptions: Map<string, any>;
  
  // Notification integration
  lastNotificationCheck: Date | null;
  unreadCount: number;
  
  // Bookmarks state
  bookmarks: TimelinePost[];
  hasMoreBookmarks: boolean;
  bookmarksCursor: string | null;
}

export const useActivityPubStore = defineStore('activitypub', {
  state: (): ActivityPubState => ({
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
    userFeeds: new Map(),
    
    // Conversation state
    conversations: new Map(),
    conversationContexts: new Map(),
    
    // User state
    followedUsers: new Set(),
    blockedUsers: new Set(),
    mutedUsers: new Set(),
    
    // Count tracking
    followingCount: 0,
    followersCount: 0,
    
    // Instance state
    knownInstances: [],
    blockedInstances: new Set(),
    
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
    selectedPost: undefined,
    currentView: 'public',
    
    // Loading states
    isLoadingFeed: false,
    isLoadingPost: false,
    isLoadingProfile: false,
    isPosting: false,
    isLoadingConversation: false,
    
    // Realtime subscriptions
    realtimeSubscriptions: new Map(),
    
    // Notification integration
    lastNotificationCheck: null,
    unreadCount: 0,
    
    // Bookmarks state
    bookmarks: [],
    hasMoreBookmarks: true,
    bookmarksCursor: null
  }),

  getters: {
    /**
     * Get formatted following count
     */
    formattedFollowingCount(): string {
      return this.followingCount > 999 ? `${(this.followingCount / 1000).toFixed(1)}K` : this.followingCount.toString();
    },

    /**
     * Get formatted followers count
     */
    formattedFollowersCount(): string {
      return this.followersCount > 999 ? `${(this.followersCount / 1000).toFixed(1)}K` : this.followersCount.toString();
    },

    /**
     * Check if user is following another user
     */
    isFollowing: (state) => (userId: string) => {
      return state.followedUsers.has(userId);
    },

    /**
     * Check if user is blocked
     */
    isBlocked: (state) => (userId: string) => {
      return state.blockedUsers.has(userId);
    },

    /**
     * Check if user is muted
     */
    isMuted: (state) => (userId: string) => {
      return state.mutedUsers.has(userId);
    },

    /**
     * Get current user's federated stats
     */
    currentUserStats: (state) => ({
      following: state.followingCount,
      followers: state.followersCount,
      posts: state.homeFeed.posts.filter(p => p.author_id === state.followedUsers.values().next().value).length
    }),

    /**
     * Get timeline posts by feed type
     */
    getTimelinePosts: (state) => (timeline: 'home' | 'public' | 'local') => {
      switch (timeline) {
        case 'home': return state.homeFeed.posts;
        case 'public': return state.publicFeed.posts;
        case 'local': return state.localFeed.posts;
        default: return [];
      }
    }
  },

  actions: {
    /**
     * Initialize the ActivityPub store with enhanced realtime
     */
    async initialize() {
      try {
        debug.log('🌐 Initializing ActivityPub store...');
        
        // Initialize post reactions store for batch loading
        const postReactionsStore = usePostReactionsStore();
        
        // Load user relationships and counts
        await this.loadFollowedUsers();
        await this.loadFollowCounts();
        await this.loadUserPreferences();
        
        // Setup comprehensive realtime subscriptions
              this.setupEnhancedRealtimeSubscriptions();
        
        // Debug methods removed - no longer needed
        // getTimelineStats, createTestFederatedPost, and exposeDebugMethods removed
        
        debug.log('✅ ActivityPub store initialized successfully');
      } catch (error) {
        debug.error('❌ Failed to initialize ActivityPub store:', error);
        throw error;
      }
    },

    /**
     * Load follow counts for the current user
     */
    async loadFollowCounts() {
      try {
        // Get current user PROFILE ID (not auth.uid!)
        const { userDataService } = await import('@/services/userDataService');
        const currentUser = userDataService.getCurrentUser();
        if (!currentUser?.id) return;

        // Get following count
        const { count: followingCount } = await supabase
          .from('follows')
          .select('*', { count: 'exact', head: true })
          .eq('follower_id', currentUser.id)
          .eq('status', 'accepted');

        // Get followers count
        const { count: followersCount } = await supabase
          .from('follows')
          .select('*', { count: 'exact', head: true })
          .eq('following_id', currentUser.id)
          .eq('status', 'accepted');

        this.followingCount = followingCount || 0;
        this.followersCount = followersCount || 0;

        debug.log(`📊 Follow counts loaded: ${this.followingCount} following, ${this.followersCount} followers`);
      } catch (error) {
        debug.error('❌ Failed to load follow counts:', error);
      }
    },

    /**
     * Load user preferences for ActivityPub
     */
    async loadUserPreferences() {
      try {
        // const user = await supabase.auth.getUser();
        // if (!user.data.user) return;

        // const { data, error } = await supabase
        //   .from('profiles')
        //   .select('activitypub_preferences')
        //   .eq('id', user.data.user.id)
        //   .single();

        // if (error) throw error;

        // Store preferences in state if needed
        // debug.log('⚙️ User preferences loaded');

        // TODO: were currently storing everything in notificaiton_preferences i believe? all preferences are separates columns in the database.
      } catch (error) {
        debug.error('❌ Failed to load user preferences:', error);
      }
    },

    /**
     * Setup enhanced realtime subscriptions for ActivityPub
     */
    setupEnhancedRealtimeSubscriptions() {
      const user = supabase.auth.getUser();
      if (!user) return;

      // Clean up existing subscriptions
      this.cleanupRealtimeSubscriptions();

      // Use activityPubService for realtime subscriptions
      const postsChannel = activityPubService.subscribeToPostUpdates(
        (post) => this.handleRealtimePostCreate(post), // This is now async but that's okay
        (post) => this.handleRealtimePostUpdate(post),
        (post) => this.handleRealtimePostDelete(post)
      );

      const followsChannel = activityPubService.subscribeToFollowUpdates(
        (follow) => this.handleRealtimeFollowCreate(follow),
        (follow) => this.handleRealtimeFollowUpdate(follow),
        (follow) => this.handleRealtimeFollowDelete(follow)
      );

      const interactionsChannel = activityPubService.subscribeToInteractionUpdates(
        (interaction) => {
          debug.log('🔔 REALTIME: Interaction CREATE received:', interaction);
          this.handleRealtimeInteractionChange({ event: 'INSERT', new: interaction });
        },
        (interaction) => {
          debug.log('🔔 REALTIME: Interaction DELETE received:', interaction);
          this.handleRealtimeInteractionChange({ event: 'DELETE', old: interaction });
        }
      );

      // Store subscriptions for cleanup
      this.realtimeSubscriptions.set('posts', postsChannel);
      this.realtimeSubscriptions.set('follows', followsChannel);
      this.realtimeSubscriptions.set('interactions', interactionsChannel);

      debug.log('🔔 Enhanced realtime subscriptions established using ActivityPub service');
    },



    /**
     * Handle realtime post creation
     */
    async handleRealtimePostCreate(post: any) {
      debug.log('📝 New post received via realtime:', post);
      
      try {
        // Realtime data NEVER has author joins, always fetch complete data
        debug.log('🔄 Fetching complete post data with author information...');
        const completePost = await activityPubService.loadPostWithAuthor(post.id);
        
        if (!completePost) {
          debug.warn('❌ Could not load complete post data for:', post.id);
          return;
        }
        
        debug.log('📝 Complete post data:', {
          id: completePost.id,
          author: completePost.author?.username,
          display_name: completePost.author?.display_name,
          domain: completePost.author?.domain,
          is_local: completePost.is_local
        });
        
        // Add to public feed if public
        if (completePost.visibility === 'public') {
          this.publicFeed.posts.unshift(completePost);
          // Limit feed size
          if (this.publicFeed.posts.length > 100) {
            this.publicFeed.posts = this.publicFeed.posts.slice(0, 100);
          }
        }
        
        // Add to local feed if local
        if (completePost.is_local && completePost.visibility === 'public') {
          this.localFeed.posts.unshift(completePost);
          if (this.localFeed.posts.length > 100) {
            this.localFeed.posts = this.localFeed.posts.slice(0, 100);
          }
        }
        
        // Add to home feed if following the author and increment unread count
        if (this.followedUsers.has(completePost.author_id)) {
          this.homeFeed.posts.unshift(completePost);
          this.unreadCount++;
          if (this.homeFeed.posts.length > 100) {
            this.homeFeed.posts = this.homeFeed.posts.slice(0, 100);
          }
        }
      } catch (error) {
        debug.error('❌ Failed to handle realtime post creation:', error);
        // Fallback: use post data directly (now in timeline format)
        if (post.visibility === 'public') {
          this.publicFeed.posts.unshift(post);
        }
        if (post.is_local && post.visibility === 'public') {
          this.localFeed.posts.unshift(post);
        }
        if (this.followedUsers.has(post.author_id)) {
          this.homeFeed.posts.unshift(post);
          this.unreadCount++;
        }
      }
    },

    /**
     * Handle realtime post updates (ignore count-only updates to prevent loops)
     */
    handleRealtimePostUpdate(post: any) {
      debug.log('📝 Post updated:', post);
      
      // Ignore updates that are likely just count changes from interaction triggers
      // These updates have updated_at very close to now and no content changes
      const now = new Date();
      const updatedAt = new Date(post.updated_at);
      const timeDiff = now.getTime() - updatedAt.getTime();
      
      // If updated less than 3 seconds ago, likely a trigger update - ignore it
      if (timeDiff < 3000) {
        debug.log('🚫 Ignoring likely count-only post update');
        return;
      }
      
      // Post is already in timeline format
      this.updatePostInAllFeeds(post);
    },

    /**
     * Handle realtime post deletion
     */
    handleRealtimePostDelete(post: any) {
      debug.log('🗑️ Post deleted:', post);
      
      this.removePostFromAllFeeds(post.id);
    },

    /**
     * Handle realtime follow creation
     */
    async handleRealtimeFollowCreate(follow: any) {
      debug.log('👥 New follow relationship:', follow);
      
      // Get current user PROFILE ID
      const { userDataService } = await import('@/services/userDataService');
      const currentUser = userDataService.getCurrentUser();
      if (!currentUser?.id) return;

      // Update counts based on relationship
      if (follow.follower_id === currentUser.id) {
        // Current user started following someone
        this.followingCount++;
        this.followedUsers.add(follow.following_id);
      } else if (follow.following_id === currentUser.id) {
        // Someone started following current user
        this.followersCount++;
        
        // Create notification for new follower
        this.createFollowNotification(follow);
      }
    },

    /**
     * Handle realtime follow updates (status changes)
     */
    async handleRealtimeFollowUpdate(follow: any) {
      debug.log('👥 Follow relationship updated:', follow);
      
      // Get current user PROFILE ID
      const { userDataService } = await import('@/services/userDataService');
      const currentUser = userDataService.getCurrentUser();
      if (!currentUser?.id) return;

      // Handle status changes (accepted/rejected)
      if (follow.status === 'accepted') {
        if (follow.follower_id === currentUser.id) {
          this.followedUsers.add(follow.following_id);
        }
      } else if (follow.status === 'rejected') {
        if (follow.follower_id === currentUser.id) {
          this.followedUsers.delete(follow.following_id);
        }
      }
    },

    /**
     * Handle realtime follow deletion
     */
    async handleRealtimeFollowDelete(follow: any) {
      debug.log('👥 Follow relationship deleted:', follow);
      
      // Get current user PROFILE ID
      const { userDataService } = await import('@/services/userDataService');
      const currentUser = userDataService.getCurrentUser();
      if (!currentUser?.id) return;

      // Update counts based on relationship
      if (follow.follower_id === currentUser.id) {
        // Current user unfollowed someone
        this.followingCount--;
        this.followedUsers.delete(follow.following_id);
      } else if (follow.following_id === currentUser.id) {
        // Someone unfollowed current user
        this.followersCount--;
      }
    },

    /**
     * Handle realtime interaction changes - clean and direct
     */
    handleRealtimeInteractionChange(payload: any) {
      debug.log('💫💫💫 REALTIME INTERACTION TRIGGER 💫💫💫');
      debug.log('💫 Raw payload:', payload);
      debug.log('💫 DETAILED Interaction payload:', JSON.stringify(payload, null, 2));
      
      // Also log current user info for debugging
      supabase.auth.getUser().then(user => {
        debug.log('💫 Current user receiving realtime event:', user.data.user?.id);
      });
      
      const interaction = payload.new || payload.old;
      if (!interaction) {
        debug.error('❌ No interaction data in realtime payload:', payload);
        return;
      }

      // Check event type first and handle DELETE events early
      debug.log('💫 Event type check:', payload.event, 'interaction data:', interaction);
      
      // For DELETE events, we only get minimal data (usually just ID)
      // Skip processing if we don't have enough information
      if (payload.event === 'DELETE') {
        debug.log('💫 DELETE event detected, skipping detailed processing (insufficient data in payload.old)');
        debug.log('💫 This is normal behavior - DELETE events only provide minimal data');
        return;
      }

      // Validate required fields (only for non-DELETE events)
      if (!interaction.post_id) {
        debug.error('❌ Missing post_id in interaction:', interaction);
        return;
      }
      
      if (!interaction.interaction_type) {
        debug.error('❌ Missing interaction_type in interaction:', interaction);
        return;
      }
      
      if (!interaction.user_id) {
        debug.error('❌ Missing user_id in interaction:', interaction);
        return;
      }

      const eventType = payload.event || payload.eventType;
      // Update both counts AND interaction state based on realtime events
      this.updatePostInteractionFromRealtime(
        interaction.post_id,
        interaction.interaction_type,
        eventType,
        interaction.user_id
      );
    },

    /**
     * Create notification for new follower
     */
    async createFollowNotification(follow: any) {
      try {
        // Get follower profile
        const { data: follower } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', follow.follower_id)
          .single();

        if (!follower) return;

        // Create notification
        await supabase
          .from('notifications')
          .insert({
            user_id: follow.following_id,
            type: 'activitypub_follow',
            data: {
              follower_id: follow.follower_id,
              follower_username: follower.username,
              follower_display_name: follower.display_name,
              follower_avatar_url: follower.avatar_url,
              follow_id: follow.id,
              timestamp: new Date().toISOString()
            },
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
          });

        debug.log('🔔 Follow notification created');
      } catch (error) {
        debug.error('❌ Failed to create follow notification:', error);
      }
    },

    /**
     * Update post interaction counts - now uses server sync for consistency
     */
    async updatePostInteractionCounts(postId: string, interactionType: string, eventType: string) {
      // Get accurate server counts instead of guessing with delta
      const { data: postCounts, error: countsError } = await supabase
        .from('posts')
        .select('favorites_count, reblogs_count, replies_count')
        .eq('id', postId)
        .single();

      if (countsError) {
        debug.error('❌ Failed to get server counts:', countsError);
        return;
      }

      const feeds = [this.homeFeed, this.publicFeed, this.localFeed];
      
      feeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          // Update with server-accurate counts
          post.favorites_count = postCounts.favorites_count;
          post.reblogs_count = postCounts.reblogs_count;
          post.replies_count = postCounts.replies_count;
          
          debug.log(`📊 Updated post ${postId} counts from server (${interactionType} ${eventType}):`, {
            favorites_count: post.favorites_count,
            reblogs_count: post.reblogs_count,
            replies_count: post.replies_count
          });
        }
      });

      // Update timeline cache in background
      this.updateTimelineCache();
    },

    /**
     * Update post interaction from realtime - handles both counts and user state (now with server sync)
     */
    async updatePostInteractionFromRealtime(postId: string, interactionType: string, eventType: string, userId: string) {
      // Early validation to prevent undefined errors
      if (!postId || postId === 'undefined') {
        debug.error('❌ Invalid postId in realtime update:', postId);
        return;
      }

      if (!interactionType) {
        debug.error('❌ Invalid interactionType in realtime update:', interactionType);
        return;
      }

      if (!userId || userId === 'undefined') {
        debug.error('❌ Invalid userId in realtime update:', userId);
        return;
      }

      const currentUser = await supabase.auth.getUser();
      const isCurrentUser = currentUser.data.user?.id === userId;

      // For realtime updates, we need to get accurate server state instead of guessing
      // This prevents conflicts between manual actions and realtime updates
      const { data: postCounts, error: countsError } = await supabase
        .from('posts')
        .select('favorites_count, reblogs_count, replies_count')
        .eq('id', postId)
        .single();

      if (countsError) {
        debug.error('❌ Failed to get server counts for realtime update:', countsError);
        return;
      }

      debug.log(`📊 Realtime: Server counts for post ${postId}:`, {
        favorites_count: postCounts.favorites_count,
        reblogs_count: postCounts.reblogs_count,
        replies_count: postCounts.replies_count,
        interaction_type: interactionType,
        event_type: eventType,
        is_current_user: isCurrentUser
      });

      const feeds = [this.homeFeed, this.publicFeed, this.localFeed];
      
      feeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          // Always update with server-accurate counts
          post.favorites_count = postCounts.favorites_count;
          post.reblogs_count = postCounts.reblogs_count;
          post.replies_count = postCounts.replies_count;
          
          // IMPORTANT: For reblogs, also update the nested reblog object
          // This ensures displayInteractionCounts computed property gets updated
          const postWithReblog = post as any;
          if (postWithReblog.reblog) {
            postWithReblog.reblog.favorites_count = postCounts.favorites_count;
            postWithReblog.reblog.reblogs_count = postCounts.reblogs_count;
            postWithReblog.reblog.replies_count = postCounts.replies_count;
            
            // Update reblog user interaction state
            if (isCurrentUser) {
              switch (interactionType) {
                case 'favorite':
                  postWithReblog.reblog.is_favorited = eventType === 'INSERT';
                  break;
                case 'reblog':
                  postWithReblog.reblog.is_reblogged = eventType === 'INSERT';
                  break;
                case 'bookmark':
                  postWithReblog.reblog.is_bookmarked = eventType === 'INSERT';
                  break;
              }
            }
          }
          
          // Update interaction state only for current user based on event
          // Force Vue reactivity by creating new object reference
          if (isCurrentUser) {
            const updates: any = {};
            switch (interactionType) {
              case 'favorite':
                updates.is_favorited = eventType === 'INSERT';
                break;
              case 'reblog':
                updates.is_reblogged = eventType === 'INSERT';
                break;
              case 'bookmark':
                updates.is_bookmarked = eventType === 'INSERT';
                break;
            }
            // Apply updates by creating new object (triggers reactivity!)
            Object.assign(post, updates);
            
            debug.log(`✅ Updated post.is_${interactionType === 'favorite' ? 'favorited' : interactionType === 'bookmark' ? 'bookmarked' : 'reblogged'}:`, updates);
          }

          debug.log(`🔍 DEBUG: Realtime update complete:`, {
            postId: post.id,
            favorites_count: post.favorites_count,
            is_favorited: post.is_favorited,
            reblog_favorites_count: postWithReblog.reblog?.favorites_count,
            reblog_is_favorited: postWithReblog.reblog?.is_favorited,
            isCurrentUser
          });
        } else {
          debug.log(`🔍 DEBUG: Post not found in feed for postId: ${postId}`);
        }
      });

      // Update in user feeds
      this.userFeeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          post.favorites_count = postCounts.favorites_count;
          post.reblogs_count = postCounts.reblogs_count;
          post.replies_count = postCounts.replies_count;
          
          // Also update reblog object if this is a reblog
          const postWithReblog = post as any;
          if (postWithReblog.reblog) {
            postWithReblog.reblog.favorites_count = postCounts.favorites_count;
            postWithReblog.reblog.reblogs_count = postCounts.reblogs_count;
            postWithReblog.reblog.replies_count = postCounts.replies_count;
            
            if (isCurrentUser) {
              switch (interactionType) {
                case 'favorite':
                  postWithReblog.reblog.is_favorited = eventType === 'INSERT';
                  break;
                case 'reblog':
                  postWithReblog.reblog.is_reblogged = eventType === 'INSERT';
                  break;
                case 'bookmark':
                  postWithReblog.reblog.is_bookmarked = eventType === 'INSERT';
                  break;
              }
            }
          }
          
          if (isCurrentUser) {
            switch (interactionType) {
              case 'favorite':
                post.is_favorited = eventType === 'INSERT';
                break;
              case 'reblog':
                post.is_reblogged = eventType === 'INSERT';
                break;
              case 'bookmark':
                post.is_bookmarked = eventType === 'INSERT';
                break;
            }
          }
        }
      });

      debug.log(`💫 Realtime interaction update with server sync: ${interactionType} ${eventType} for post ${postId} (user: ${userId}, current: ${isCurrentUser})`);
    },

    /**
     * Update timeline cache when data changes
     */
    async updateTimelineCache() {
      // Skip RPC calls that have database schema issues
      // Client-side post updates in updatePostInteractionCounts are sufficient
      debug.log('📋 Timeline cache update skipped - using client-side updates for better stability');
      return;
    },

    /**
     * Update post in all feeds
     */
    updatePostInAllFeeds(post: TimelinePost) {
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed];
      
      feeds.forEach(feed => {
        const index = feed.posts.findIndex(p => p.id === post.id);
        if (index !== -1) {
          feed.posts[index] = post;
        }
      });
      
      // Update in user feeds
      this.userFeeds.forEach(feed => {
        const index = feed.posts.findIndex(p => p.id === post.id);
        if (index !== -1) {
          feed.posts[index] = post;
        }
      });
    },

    /**
     * Update post interaction state across all feeds (UI state only, counts handled by realtime)
     */
    updatePostInteractionState(postId: string, interactionType: 'favorite' | 'reblog' | 'bookmark', state: boolean) {
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed];
      
      feeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          switch (interactionType) {
            case 'favorite': {
              post.is_favorited = state;
              break;
            }
            case 'reblog': {
              post.is_reblogged = state;
              break;
            }
            case 'bookmark': {
              post.is_bookmarked = state;
              break;
            }
          }
        }
      });
      
      // Update in user feeds
      this.userFeeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          switch (interactionType) {
            case 'favorite': {
              post.is_favorited = state;
              break;
            }
            case 'reblog': {
              post.is_reblogged = state;
              break;
            }
            case 'bookmark': {
              post.is_bookmarked = state;
              break;
            }
          }
        }
      });

      debug.log(`📍 Updated ${interactionType} state to ${state} for post ${postId} across all feeds (counts handled by realtime)`);
    },

    /**
     * Remove post from all feeds
     */
    removePostFromAllFeeds(postId: string) {
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed];
      
      feeds.forEach(feed => {
        feed.posts = feed.posts.filter(p => p.id !== postId);
      });
      
      // Remove from user feeds
      this.userFeeds.forEach(feed => {
        feed.posts = feed.posts.filter(p => p.id !== postId);
      });
    },

    /**
     * Clean up realtime subscriptions
     */
    cleanupRealtimeSubscriptions() {
      this.realtimeSubscriptions.forEach((channel, key) => {
        supabase.removeChannel(channel);
      });
      this.realtimeSubscriptions.clear();
      
      debug.log('🧹 Realtime subscriptions cleaned up');
    },

    /**
     * Load the user's home timeline
     */
    async loadHomeFeed(maxId?: string) {
      this.isLoadingFeed = true;
      try {
        const user = await supabase.auth.getUser();
        if (!user.data.user) throw new Error('User not authenticated');

        // Use activityPubService for timeline loading
        const posts = await activityPubService.getUserTimeline(
          user.data.user.id,
          'home',
          { 
            limit: 20,
            max_id: maxId 
          }
        );
        
        // BATCH LOAD REACTIONS for all posts to prevent N+1 queries
        if (posts.length > 0) {
          const postReactionsStore = usePostReactionsStore();
          const postIds = posts.map(p => p.id)
          debug.log(`🔄 Batch loading reactions for ${postIds.length} home timeline posts`)
          // Force batch fetch to ensure reactions load before components render
          await postReactionsStore.fetchMultiplePostReactions(postIds, true)
        }
        
        if (maxId) {
          this.homeFeed.posts.push(...posts);
        } else {
          this.homeFeed.posts = posts;
          // Clear unread count when refreshing home feed
          this.unreadCount = 0;
        }

        this.homeFeed.has_more = posts.length === 20;
        this.homeFeed.cursor = posts[posts.length - 1]?.id;

      } catch (error) {
        debug.error('Failed to load home feed:', error);
      } finally {
        this.isLoadingFeed = false;
      }
    },

    /**
     * Load the public timeline
     */
    async loadPublicFeed(maxId?: string) {
      this.isLoadingFeed = true;
      try {
        // Use enhanced public timeline to ensure federated posts are included
        const posts = await activityPubService.getEnhancedPublicTimeline({
          limit: 20,
          max_id: maxId
        });
        
        // BATCH LOAD REACTIONS for all posts to prevent N+1 queries
        if (posts.length > 0) {
          const postReactionsStore = usePostReactionsStore();
          const postIds = posts.map(p => p.id)
          debug.log(`🔄 Batch loading reactions for ${postIds.length} public timeline posts`)
          // Force batch fetch to ensure reactions load before components render
          await postReactionsStore.fetchMultiplePostReactions(postIds, true)
        }
        
        if (maxId) {
          this.publicFeed.posts.push(...posts);
        } else {
          this.publicFeed.posts = posts;
        }

        // DEBUG: Log the problematic post's data when loaded
        const debugPost = posts.find(p => p.id === '968f8b30-8de1-4e0f-b9bb-87d8085330a7');
        if (debugPost) {
          debug.log(`🔍 DEBUG - Timeline loaded post ${debugPost.id}:`, {
            is_favorited: debugPost.is_favorited,
            favorites_count: debugPost.favorites_count,
            typeof_is_favorited: typeof debugPost.is_favorited,
            full_post: debugPost
          });
        }

        // DEBUG: Check the post data after store assignment
        const storePost = this.publicFeed.posts.find(p => p.id === '968f8b30-8de1-4e0f-b9bb-87d8085330a7');
        if (storePost) {
          debug.log(`🔍 DEBUG - Post in store after assignment:`, {
            is_favorited: storePost.is_favorited,
            favorites_count: storePost.favorites_count,
            typeof_is_favorited: typeof storePost.is_favorited,
            keys: Object.keys(storePost)
          });
        }

        this.publicFeed.has_more = posts.length === 20;
        this.publicFeed.cursor = posts[posts.length - 1]?.id;

        // Debug logging for federated content
        const localCount = posts.filter(p => p.is_local).length;
        const federatedCount = posts.filter(p => !p.is_local).length;
        debug.log(`🌐 Public feed updated: ${localCount} local + ${federatedCount} federated = ${posts.length} total posts`);

      } catch (error) {
        debug.error('Failed to load public feed:', error);
      } finally {
        this.isLoadingFeed = false;
      }
    },

    /**
     * Load the local timeline
     */
    async loadLocalFeed(maxId?: string) {
      this.isLoadingFeed = true;
      try {
        // Use activityPubService for local timeline
        const posts = await activityPubService.getLocalTimeline({
          limit: 20,
          max_id: maxId
        });
        
        // BATCH LOAD REACTIONS for all posts to prevent N+1 queries
        if (posts.length > 0) {
          const postReactionsStore = usePostReactionsStore();
          const postIds = posts.map(p => p.id)
          debug.log(`🔄 Batch loading reactions for ${postIds.length} local timeline posts`)
          // Force batch fetch to ensure reactions load before components render
          await postReactionsStore.fetchMultiplePostReactions(postIds, true)
        }
        
        if (maxId) {
          this.localFeed.posts.push(...posts);
        } else {
          this.localFeed.posts = posts;
        }

        this.localFeed.has_more = posts.length === 20;
        this.localFeed.cursor = posts[posts.length - 1]?.id;

        debug.log(`📍 Local feed loaded: ${posts.length} posts`);

      } catch (error) {
        debug.error('Failed to load local feed:', error);
      } finally {
        this.isLoadingFeed = false;
      }
    },

    /**
     * Create a new post (Mony)
     */
    async createPost(postData?: {
      content?: string | MessagePart[];
      visibility?: Post['visibility'];
      content_warning?: string;
      contentWarning?: string;
      in_reply_to?: string;
      replyTo?: string;
      media_attachments?: File[];
      mediaAttachments?: any[];
      is_sensitive?: boolean;
      sensitive?: boolean;
    }) {
      this.isPosting = true;
      try {
        // Use postData if provided, otherwise use composer state
        const content = postData?.content || this.composerState.content;
        const visibility = postData?.visibility || this.composerState.visibility;
        const contentWarning = postData?.content_warning || postData?.contentWarning || this.composerState.contentWarning;
        const replyTo = postData?.in_reply_to || postData?.replyTo || this.composerState.replyTo;
        // Handle both snake_case and camelCase media attachments
        const mediaAttachments = postData?.media_attachments || postData?.mediaAttachments || [];
        const sensitive = postData?.is_sensitive ?? postData?.sensitive ?? this.composerState.sensitive;

        // Upload media attachments if any
        const mediaUrls = await this.uploadMediaAttachments(mediaAttachments);

        // Handle content format - content should already be MessagePart[] from component
        let finalContent: MessagePart[];
        if (Array.isArray(content)) {
          // Content is already parsed MessagePart[] from component
          finalContent = content;
        } else if (typeof content === 'string') {
          // Fallback: parse string content (legacy support)
          finalContent = await this.formatPostContent(content);
        } else {
          throw new Error('Invalid content format - must be MessagePart[] or string');
        }
        
        // Add media attachments to content as MessageParts with type 'file'
        if (mediaUrls && mediaUrls.length > 0) {
          const mediaParts: MessagePart[] = mediaUrls.map(media => ({
            type: 'file',
            fileType: media.type === 'Image' ? 'image' : 
                      media.type === 'Video' ? 'video' : 
                      media.type === 'Audio' ? 'audio' : 'file',
            url: media.url,
            fileName: media.name
          }));
          
          // Append media parts to content
          finalContent = [...finalContent, ...mediaParts];
        }
        
        const post = await services.posts.createPost({
          content: finalContent,
          visibility: visibility,
          content_warning: contentWarning,
          in_reply_to: replyTo,
          media_attachments: mediaUrls,
          is_sensitive: sensitive || false,
          language: 'en'
        });

        // Close composer
        this.closeComposer();

        // Don't add to feeds manually - let realtime handle it to avoid duplicates
        // The database triggers will create timeline_entries, and realtime will update the UI
        // This prevents the double-post issue

        return post;
      } catch (error) {
        debug.error('Failed to create post:', error);
        throw error;
      } finally {
        this.isPosting = false;
      }
    },

    /**
     * Convert MediaAttachment with blob URL to File
     */
    async convertMediaAttachmentToFile(attachment: any): Promise<File> {
      // If it's already a File, return it
      if (attachment instanceof File) {
        return attachment;
      }

      // If it has a blob URL, fetch and convert to File
      if (attachment.url && attachment.url.startsWith('blob:')) {
        const response = await fetch(attachment.url);
        const blob = await response.blob();
        const fileName = attachment.filename || `file.${blob.type.split('/')[1] || 'bin'}`;
        // attachment.type might be 'image'/'video'/'audio', but we need MIME type
        // Use blob.type if available, otherwise infer from attachment.type
        let mimeType = blob.type;
        if (!mimeType && attachment.type) {
          if (attachment.type === 'image') mimeType = 'image/jpeg';
          else if (attachment.type === 'video') mimeType = 'video/mp4';
          else if (attachment.type === 'audio') mimeType = 'audio/mpeg';
        }
        return new File([blob], fileName, { type: mimeType || 'application/octet-stream' });
      }

      // If it's a MediaAttachment with a file property
      if (attachment.file instanceof File) {
        return attachment.file;
      }

      throw new Error('Cannot convert MediaAttachment to File: invalid attachment format');
    },

    /**
     * Upload media attachments (handles both File[] and MediaAttachment[])
     */
    async uploadMediaAttachments(attachments: (File | any)[]): Promise<any[]> {
      if (!attachments || attachments.length === 0) {
        return [];
      }

      const uploadPromises = attachments.map(async (attachment) => {
        // Convert to File if needed
        const file = await this.convertMediaAttachmentToFile(attachment);
        
        const fileExt = file.name.split('.').pop() || 'bin';
        const fileName = `${crypto.randomUUID()}.${fileExt}`;
        const filePath = `posts/${fileName}`;

        try {
          const { data, error } = await supabase.storage
            .from('user_media')
            .upload(filePath, file, {
              cacheControl: '3600',
              upsert: false
            });

          if (error) {
            debug.error('Upload error:', error);
            // Provide more helpful error messages
            if (error.message?.includes('413') || error.message?.includes('too large')) {
              throw new Error(`File "${file.name}" is too large. Maximum file size is 50MB.`);
            }
            if (error.message?.includes('CORS')) {
              throw new Error('CORS error: Please check Supabase storage CORS configuration.');
            }
            throw error;
          }

          return {
            type: file.type.startsWith('image/') ? 'Image' : 
                  file.type.startsWith('video/') ? 'Video' : 
                  file.type.startsWith('audio/') ? 'Audio' : 'Document',
            url: data.path,
            mediaType: file.type,
            name: file.name
          };
        } catch (error: any) {
          debug.error(`Failed to upload file "${file.name}":`, error);
          throw error;
        }
      });

      const uploadedMedia = await Promise.all(uploadPromises);
      
      // Get public URLs for uploaded media
      const mediaWithPublicUrls = uploadedMedia.map(media => {
        const { data: { publicUrl } } = supabase.storage
          .from('user_media')
          .getPublicUrl(media.url);
        
        return {
          ...media,
          url: publicUrl
        };
      });
      
      return mediaWithPublicUrls;
    },

    /**
     * Format post content for storage with mention detection and unified format
     */
    async formatPostContent(content: string): Promise<MessagePart[]> {
      // Use the centralized unified content processing utility
      const { parseContentToMessageParts, resolveMentionsUserData, resolveEmojisData, resolveHashtagsData } = await import('@/utils/unifiedContentProcessing');
      
      // Efficiently resolve all mention, emoji, and hashtag data in batch
      const [usernameToUserDataMap, emojiDataMap, hashtagDataMap] = await Promise.all([
        resolveMentionsUserData(content),
        resolveEmojisData(content),
        resolveHashtagsData(content)
      ]);
      
      return await parseContentToMessageParts(content, usernameToUserDataMap, emojiDataMap, hashtagDataMap);
    },

    /**
     * Load post with author information - migrated to service layer
     */
    async loadPostWithAuthor(postId: string): Promise<TimelinePost | null> {
      try {
        debug.log('🔄 Loading post via PostService:', postId);
        
        // Use services.posts for consistent loading with service layer
        const post = await services.posts.loadPost(postId);
        
        debug.log('✅ Post loaded via service layer:', post ? 'found' : 'not found');
        return post;
      } catch (error) {
        debug.error('❌ Failed to load post via service:', error);
        return null;
      }
    },





    /**
     * Update post interaction in local state
     */
    updatePostInteraction(postId: string, type: 'favorite' | 'reblog' | 'bookmark', isActive: boolean) {
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed];
      
      feeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          if (type === 'favorite') {
            post.is_favorited = isActive;
            post.favorites_count += isActive ? 1 : -1;
          } else if (type === 'reblog') {
            post.is_reblogged = isActive;
            post.reblogs_count += isActive ? 1 : -1;
          } else if (type === 'bookmark') {
            // Bookmark state would be tracked separately if needed
            debug.log(`Bookmark ${isActive ? 'added' : 'removed'} for post ${postId}`);
          }
        }
      });
    },

    /**
     * Open composer
     */
    openComposer(options: Partial<PostComposerState> = {}) {
      this.composerState = { ...this.composerState, ...options };
      this.isComposerOpen = true;
    },

    /**
     * Close composer
     */
         closeComposer() {
       this.isComposerOpen = false;
       this.composerState = {
         content: '',
         visibility: 'public',
         contentWarning: undefined,
         sensitive: false,
         language: 'en',
         replyTo: undefined,
         mediaAttachments: []
       };
     },

    /**
     * Update composer state
     */
    updateComposer(updates: Partial<PostComposerState>) {
      this.composerState = { ...this.composerState, ...updates };
    },

    /**
     * Update composer content  
     */
    updateComposerContent(content: string) {
      this.composerState.content = content;
    },

    /**
     * Update composer visibility
     */
    updateComposerVisibility(visibility: PostComposerState['visibility']) {
      this.composerState.visibility = visibility;
    },

    /**
     * Subscribe to real-time updates
     */
    subscribeToRealtimeUpdates() {
      // Subscribe to new posts
      supabase
        .channel('activitypub_posts')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'posts' },
          (payload) => {
            debug.log('New post received:', payload.new);
            // TODO: Add to appropriate timelines based on visibility and following
          }
        )
        .subscribe();

      // Subscribe to post interactions
      supabase
        .channel('activitypub_interactions')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'post_interactions' },
          (payload) => {
            debug.log('Post interaction update:', payload);
            // TODO: Update post interaction counts
          }
        )
        .subscribe();

      // Subscribe to follow relationships
      supabase
        .channel('activitypub_follows')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'follows' },
          async (payload) => {
            debug.log('👥 Follow relationship update:', payload);
            
            // Get current user PROFILE ID (not auth.uid!)
            const { userDataService } = await import('@/services/userDataService');
            const currentUser = userDataService.getCurrentUser();
            if (!currentUser?.id) return;
            
            const follow = payload.new as any;
            const oldFollow = payload.old as any;
            
            // Only update if this affects the current user's PROFILE
            if (payload.eventType === 'INSERT' && follow.follower_id === currentUser.id) {
              debug.log('👥 New follow relationship:', follow);
              this.followedUsers.add(follow.following_id);
            } else if (payload.eventType === 'DELETE' && oldFollow.follower_id === currentUser.id) {
              debug.log('👥 Follow relationship deleted:', oldFollow);
              this.followedUsers.delete(oldFollow.following_id);
            } else if (payload.eventType === 'UPDATE') {
              const isCurrentUserFollower = follow.follower_id === currentUser.id;
              if (isCurrentUserFollower) {
                if (follow.status === 'accepted') {
                  this.followedUsers.add(follow.following_id);
                } else {
                  this.followedUsers.delete(follow.following_id);
                }
              }
            }
          }
        )
        .subscribe();
    },

    /**
     * Resolve a user handle to a user object
     */
    async resolveUserByHandle(handle: string): Promise<FederatedUser | null> {
      return await activityPubService.resolveUserByHandle(handle);
    },

    /**
     * Get user by ID (for navigation from UUIDs)
     */
    async getUserById(userId: string): Promise<FederatedUser | null> {
      return await activityPubService.getUserById(userId);
    },

    /**
     * Mute a user
     */
    async muteUser(userId: string) {
      try {
        // TODO: Implement mute API call
        debug.log('Muting user:', userId);
        this.mutedUsers.add(userId);
      } catch (error) {
        debug.error('Failed to mute user:', error);
        throw error;
      }
    },

    /**
     * Unmute a user
     */
    async unmuteUser(userId: string) {
      try {
        // TODO: Implement unmute API call
        debug.log('Unmuting user:', userId);
        this.mutedUsers.delete(userId);
      } catch (error) {
        debug.error('Failed to unmute user:', error);
        throw error;
      }
    },

    /**
     * Block a user
     */
    async blockUser(userId: string) {
      try {
        // TODO: Implement block API call
        debug.log('Blocking user:', userId);
        this.blockedUsers.add(userId);
        
        // Also unfollow if following
        if (this.followedUsers.has(userId)) {
          await this.unfollowUser(userId);
        }
      } catch (error) {
        debug.error('Failed to block user:', error);
        throw error;
      }
    },

    /**
     * Unblock a user
     */
    async unblockUser(userId: string) {
      try {
        // TODO: Implement unblock API call
        debug.log('Unblocking user:', userId);
        this.blockedUsers.delete(userId);
      } catch (error) {
        debug.error('Failed to unblock user:', error);
        throw error;
      }
    },

    /**
     * Toggle post favorite (like) with optimistic UI updates
     */
    async toggleFavorite(postId: string) {
      debug.log(`🔍 DEBUG: toggleFavorite called for post ${postId}`);
      
      try {
        const user = await supabase.auth.getUser();
        if (!user.data.user) throw new Error('User not authenticated');

        debug.log(`🔍 DEBUG: User authenticated: ${user.data.user.id}`);

        // Check current state first
        const { data: existing, error: existingError } = await supabase
          .from('post_interactions')
          .select('id')
          .eq('user_id', user.data.user.id)
          .eq('post_id', postId)
          .eq('interaction_type', 'favorite')
          .maybeSingle();

        if (existingError && existingError.code !== 'PGRST116') {
          throw existingError;
        }

        const isFavorited = !!existing;
        debug.log(`🔍 DEBUG: Current favorite state: ${isFavorited} (existing: ${JSON.stringify(existing)})`);

        // Step 1: Handle local database state FIRST
        if (existing) {
          // Remove favorite
          debug.log(`🔍 DEBUG: Removing favorite with id: ${existing.id}`);
          await activityPubService.unfavoritePost(postId);
        } else {
          // Add favorite
          debug.log(`🔍 DEBUG: Adding new favorite`);
          await activityPubService.favoritePost(postId);
        }

        // Step 2: Immediate UI feedback (state only, no count changes)
        const newFavoriteState = !isFavorited;
        this.updatePostInteractionInAllFeeds(postId, 'favorite', newFavoriteState);

        // Step 3: Get the updated post state from server (with correct counts)
        debug.log(`🔄 Refreshing post data after ${newFavoriteState ? 'favoriting' : 'unfavoriting'}`);
        
        // Get fresh counts from the posts table (more reliable than timeline RPC)
        const { data: postCounts, error: countsError } = await supabase
          .from('posts')
          .select('favorites_count, reblogs_count, replies_count')
          .eq('id', postId)
          .single();

        if (!countsError && postCounts) {
          debug.log(`📊 Server counts for post ${postId}:`, {
            favorites_count: postCounts.favorites_count,
            reblogs_count: postCounts.reblogs_count,
            replies_count: postCounts.replies_count,
            is_favorited: newFavoriteState,
            before_action: isFavorited,
            after_action: newFavoriteState
          });
          
          // Update UI with correct server state - only update counts, keep user state consistent
          this.updatePostCountsFromServer(postId, postCounts, newFavoriteState);
        } else {
          debug.error('❌ Failed to get server counts:', countsError);
          // State is already updated from step 2, no need for fallback
        }
        
        // Step 4: Federation is handled automatically by database triggers
        // No need for manual federation calls

        debug.log(`✅ Toggled favorite for post ${postId}: ${isFavorited} -> ${newFavoriteState} (synced with server state)`);

      } catch (error) {
        debug.error('Failed to toggle favorite:', error);
        throw error;
      }
    },

    /**
     * Update post interaction state in all feeds immediately (state only, counts handled by server refresh)
     */
    updatePostInteractionInAllFeeds(postId: string, interactionType: 'favorite' | 'reblog' | 'bookmark', isActive: boolean) {
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed];
      
      feeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          switch (interactionType) {
            case 'favorite':
              post.is_favorited = isActive;
              // Don't update count - server will provide accurate count
              break;
            case 'reblog':
              post.is_reblogged = isActive;
              // Don't update count - server will provide accurate count
              break;
            case 'bookmark':
              post.is_bookmarked = isActive;
              break;
          }
          debug.log(`🔄 Updated ${interactionType} state for post ${postId} in feed: ${isActive} (counts will be synced from server)`);
        }
      });
    },

    /**
     * Update post with fresh server state (accurate counts and states)
     */
    updatePostWithServerState(postId: string, serverPost: any) {
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed];
      
      feeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          // Update with server-accurate values
          post.is_favorited = serverPost.is_favorited;
          post.is_reblogged = serverPost.is_reblogged;
          post.is_bookmarked = serverPost.is_bookmarked;
          post.favorites_count = serverPost.favorites_count;
          post.reblogs_count = serverPost.reblogs_count;
          post.replies_count = serverPost.replies_count;
          
          debug.log(`🔄 Updated post ${postId} with server state:`, {
            is_favorited: post.is_favorited,
            favorites_count: post.favorites_count,
            is_reblogged: post.is_reblogged,
            reblogs_count: post.reblogs_count
          });
        }
      });
    },

    /**
     * Update post counts from server while preserving user interaction state
     */
    updatePostCountsFromServer(postId: string, serverCounts: any, userFavoriteState: boolean) {
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed];
      
      feeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          // Update with server-accurate counts but keep user state
          post.favorites_count = serverCounts.favorites_count;
          post.reblogs_count = serverCounts.reblogs_count;
          post.replies_count = serverCounts.replies_count;
          post.is_favorited = userFavoriteState; // User state from our action
          
          debug.log(`🔄 Updated post ${postId} counts from server:`, {
            favorites_count: post.favorites_count,
            is_favorited: post.is_favorited,
            reblogs_count: post.reblogs_count
          });
        }
      });

      // Update in user feeds too
      this.userFeeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          post.favorites_count = serverCounts.favorites_count;
          post.reblogs_count = serverCounts.reblogs_count;
          post.replies_count = serverCounts.replies_count;
          post.is_favorited = userFavoriteState;
        }
      });
    },

    /**
     * Toggle post bookmark - clean and professional
     */
    async toggleBookmark(postId: string) {
      try {
        const user = await supabase.auth.getUser();
        if (!user.data.user) throw new Error('User not authenticated');

        // Check current state
        const { data: existing, error: existingError } = await supabase
          .from('post_interactions')
          .select('id')
          .eq('user_id', user.data.user.id)
          .eq('post_id', postId)
          .eq('interaction_type', 'bookmark')
          .maybeSingle();

        if (existingError && existingError.code !== 'PGRST116') {
          throw existingError;
        }

        const isBookmarked = !!existing;

        if (existing) {
          // Remove bookmark
          await activityPubService.unbookmarkPost(postId);
        } else {
          // Add bookmark
          await activityPubService.bookmarkPost(postId);
        }

        // Don't update UI state here - let realtime handle it to avoid double updates
        debug.log(`📍 Toggled bookmark for post ${postId}: ${isBookmarked} -> ${!isBookmarked} (realtime will update UI)`);

      } catch (error) {
        debug.error('Failed to toggle bookmark:', error);
        throw error;
      }
    },

    /**
     * Get bookmarked posts
     */
    async getBookmarks(options: { limit?: number; cursor?: string | null } = {}) {
      try {
        const user = await supabase.auth.getUser();
        if (!user.data.user) throw new Error('User not authenticated');

        const limit = options.limit || 20;
        
        let query = supabase
          .from('post_interactions')
          .select(`
            created_at,
            post:posts(
              *,
              author:profiles(*)
            )
          `)
          .eq('user_id', user.data.user.id)
          .eq('interaction_type', 'bookmark')
          .order('created_at', { ascending: false })
          .limit(limit);

        if (options.cursor) {
          query = query.lt('created_at', options.cursor);
        }

        const { data, error } = await query;
        if (error) throw error;

        const posts = data ? data.map(item => item.post).filter(Boolean) : [];
        
        return {
          posts,
          cursor: posts.length > 0 ? data[data.length - 1].created_at : null,
          hasMore: posts.length === limit
        };
      } catch (error) {
        debug.error('Failed to get bookmarks:', error);
        throw error;
      }
    },

    /**
     * Load bookmarks for the current user
     */
    async loadBookmarks() {
      try {
        const result = await this.getBookmarks({ limit: 20 });
        this.bookmarks = result.posts as TimelinePost[];
        this.bookmarksCursor = result.cursor;
        this.hasMoreBookmarks = result.hasMore;
        debug.log('📚 Bookmarks loaded:', this.bookmarks.length);
      } catch (error) {
        debug.error('Failed to load bookmarks:', error);
        throw error;
      }
    },

    /**
     * Load more bookmarks
     */
    async loadMoreBookmarks() {
      if (!this.hasMoreBookmarks) return;
      
      try {
        const result = await this.getBookmarks({ 
          limit: 20, 
          cursor: this.bookmarksCursor 
        });
        
        this.bookmarks.push(...(result.posts as TimelinePost[]));
        this.bookmarksCursor = result.cursor;
        this.hasMoreBookmarks = result.hasMore;
        debug.log('📚 More bookmarks loaded:', result.posts.length);
      } catch (error) {
        debug.error('Failed to load more bookmarks:', error);
        throw error;
      }
    },

    /**
     * Clear all bookmarks
     */
    async clearAllBookmarks() {
      try {
        const user = await supabase.auth.getUser();
        if (!user.data.user) throw new Error('User not authenticated');

        const { error } = await supabase
          .from('post_interactions')
          .delete()
          .eq('user_id', user.data.user.id)
          .eq('interaction_type', 'bookmark');

        if (error) throw error;
        
        // Clear local bookmarks state
        this.bookmarks = [];
        this.hasMoreBookmarks = true;
        this.bookmarksCursor = null;
      } catch (error) {
        debug.error('Failed to clear bookmarks:', error);
        throw error;
      }
    },

    /**
     * Toggle post reblog - creates actual reblog posts for timeline display
     */
    async toggleReblog(postId: string) {
      try {
        const user = await supabase.auth.getUser();
        if (!user.data.user) throw new Error('User not authenticated');

        // Check if we already have a reblog interaction for this post
        const { data: existingInteraction, error: interactionError } = await supabase
          .from('post_interactions')
          .select('id')
          .eq('user_id', user.data.user.id)
          .eq('post_id', postId)
          .eq('interaction_type', 'reblog')
          .maybeSingle();

        if (interactionError && interactionError.code !== 'PGRST116') {
          throw interactionError;
        }

        const isReblogged = !!existingInteraction;

        if (existingInteraction) {
          // Remove reblog interaction and reblog post using service method
          const { data: reblogPost } = await supabase
            .from('posts')
            .select('id')
            .eq('author_id', user.data.user.id)
            .eq('metadata->>reblog_of', postId)
            .maybeSingle();

          if (reblogPost) {
            await activityPubService.unreblogPost(reblogPost.id);
            // Remove reblog from our feeds
            this.removePostFromFeeds(reblogPost.id);
          }

          // Remove the interaction record
          await supabase
            .from('post_interactions')
            .delete()
            .eq('id', existingInteraction.id);

          // Federation is handled automatically by database triggers
        } else {
          // Use service method for reblog (which creates both interaction and reblog post)
          const result = await activityPubService.toggleReblog(postId);
          
          // Don't add to feeds immediately - let realtime handle it
          // This prevents showing both the original post and reblog immediately
          // The realtime system will properly add the reblog post to feeds

          // Federation is handled automatically by database triggers
        }

        // Don't update UI state here - let realtime handle it to avoid double updates
        debug.log(`📍 Toggled reblog for post ${postId}: ${isReblogged} -> ${!isReblogged} (realtime will update UI)`);

      } catch (error) {
        debug.error('Failed to toggle reblog:', error);
        throw error;
      }
    },

    /**
     * Delete a post
     */
    async deletePost(postId: string) {
      try {
        const user = await supabase.auth.getUser();
        if (!user.data.user) throw new Error('User not authenticated');

        // Get the post to verify ownership
        const { data: postData, error: fetchError } = await supabase
          .from('posts')
          .select(`
            *,
            author:profiles (
              id, username, display_name, domain, avatar_url, is_local
            )
          `)
          .eq('id', postId)
          .eq('author_id', user.data.user.id)
          .single();

        if (fetchError) throw fetchError;
        if (!postData) throw new Error('Post not found or you do not have permission to delete it');

        // Mark post as deleted in database
        const { error: deleteError } = await supabase
          .from('posts')
          .update({ 
            is_deleted: true, 
            deleted_at: new Date().toISOString() 
          })
          .eq('id', postId)
          .eq('author_id', user.data.user.id);

        if (deleteError) throw deleteError;

        // Federation is handled automatically by database triggers

        // Remove from local feeds
        this.removePostFromFeeds(postId);

      } catch (error) {
        debug.error('Failed to delete post:', error);
        throw error;
      }
    },

    /**
     * Remove post from all feeds
     */
    removePostFromFeeds(postId: string) {
      // Remove from home feed
      this.homeFeed.posts = this.homeFeed.posts.filter(p => p.id !== postId);
      
      // Remove from public feed
      this.publicFeed.posts = this.publicFeed.posts.filter(p => p.id !== postId);
      
      // Remove from local feed
      this.localFeed.posts = this.localFeed.posts.filter(p => p.id !== postId);
      
      // Remove from user feeds
      this.userFeeds.forEach(feed => feed.posts.filter(p => p.id !== postId));
    },

         /**
      * Load users that the current user follows
      */
     async loadFollowedUsers() {
       try {
         debug.log('🔄 Loading followed users via InteractionService');
         
         // Get current user PROFILE ID (not auth_user_id!)
        const { userDataService } = await import('@/services/userDataService');
        const currentUser = userDataService.getCurrentUser();
        if (!currentUser?.id) {
          debug.log('ℹ️ No current user available, skipping followed users loading');
          return;
        }
        
        debug.log('🔄 Current user PROFILE ID for loading followed users:', currentUser.id);
         
         // Use InteractionService with PROFILE ID
        const result = await services.interactions.getFollowing(currentUser.id);
         debug.log('🔄 Service result:', result);
         
         this.followedUsers = new Set(result.users.map(user => user.id));
         
         debug.log(`✅ Loaded ${this.followedUsers.size} followed users via service layer`);
         debug.log('✅ followedUsers Set contents:', Array.from(this.followedUsers));
       } catch (error) {
         debug.error('❌ Failed to load followed users via service:', error);
         
         // Fallback to direct query if service fails
         try {
           debug.log('🔄 Trying fallback method...');
           await this._loadFollowedUsersFallback();
           debug.log(`✅ Fallback loaded ${this.followedUsers.size} followed users`);
           debug.log('✅ Fallback followedUsers Set contents:', Array.from(this.followedUsers));
         } catch (fallbackError) {
           debug.error('❌ Fallback loading also failed:', fallbackError);
         }
       }
     },

     /**
      * Fallback method for loading followed users
      */
    async _loadFollowedUsersFallback() {
      // Get current user PROFILE ID
      const { userDataService } = await import('@/services/userDataService');
      const currentUser = userDataService.getCurrentUser();
      if (!currentUser?.id) return;

      const { data, error } = await supabase
        .from('follows')
        .select('following_id')
        .eq('follower_id', currentUser.id)
        .eq('status', 'accepted');

      if (error) throw error;
      
      // Add all followed users (both local and federated)
      this.followedUsers = new Set(data.map(f => f.following_id));
    },

     /**
      * Follow a user via InteractionService
      */
     async followUser(userId: string) {
       try {
         debug.log('🔄 Following user via InteractionService:', userId);
         
         // Use InteractionService for optimistic follow with federation
         const result = await services.interactions.toggleFollow(userId);
         
         if (result.following) {
           this.followedUsers.add(userId);
           this.followingCount++;
           debug.log('✅ User followed successfully via service layer');
         }
         
         return result;
       } catch (error) {
         debug.error('❌ Failed to follow user via service:', error);
         throw error;
       }
     },

     /**
      * Unfollow a user via InteractionService
      */
     async unfollowUser(userId: string) {
       try {
         debug.log('🔄 Unfollowing user via InteractionService:', userId);
         
         // Use InteractionService for optimistic unfollow with federation
         const result = await services.interactions.toggleFollow(userId);
         
         if (!result.following) {
           this.followedUsers.delete(userId);
           this.followingCount--;
           debug.log('✅ User unfollowed successfully via service layer');
         }
         
         return result;
       } catch (error) {
         debug.error('❌ Failed to unfollow user via service:', error);
         throw error;
       }
     },

     /**
      * Toggle follow status via InteractionService (recommended method)
      */
     async toggleFollow(userId: string): Promise<{ following: boolean }> {
       try {
         debug.log('🔄 Toggling follow via InteractionService:', userId);
         
         // Use InteractionService for optimistic toggle with federation
         const result = await services.interactions.toggleFollow(userId);
         
         // Update local state based on result
         if (result.following) {
           this.followedUsers.add(userId);
           if (!this.followedUsers.has(userId)) this.followingCount++;
         } else {
           this.followedUsers.delete(userId);
           this.followingCount--;
         }
         
         debug.log(`✅ Follow toggled via service: ${result.following ? 'following' : 'unfollowed'}`);
         return result;
       } catch (error) {
         debug.error('❌ Failed to toggle follow via service:', error);
         throw error;
       }
     },

     /**
      * Get followers count for a user
      */
     async getFollowersCount(userId: string): Promise<number> {
       try {
         const { count, error } = await supabase
           .from('follows')
           .select('*', { count: 'exact', head: true })
           .eq('following_id', userId)
           .eq('status', 'accepted');

         if (error) throw error;
         return count || 0;
       } catch (error) {
         debug.error('Failed to get followers count:', error);
         return 0;
       }
     },

     /**
      * Get following count for a user
      */
     async getFollowingCount(userId: string): Promise<number> {
       try {
         const { count, error } = await supabase
           .from('follows')
           .select('*', { count: 'exact', head: true })
           .eq('follower_id', userId)
           .eq('status', 'accepted');

         if (error) throw error;
         return count || 0;
       } catch (error) {
         debug.error('Failed to get following count:', error);
         return 0;
       }
     },

     /**
      * Clear unread count manually
      */
     clearUnreadCount() {
       this.unreadCount = 0;
     },

     async loadNotifications() {
      try {
        const user = await supabase.auth.getUser();
        if (!user.data.user) throw new Error('User not authenticated');

        const { data, error } = await supabase
          .from('notifications')
          .select('*')
          .eq('user_id', user.data.user.id)
          .order('created_at', { ascending: false })
          .limit(20);

        if (error) throw error;

        debug.log('🔔 Notifications loaded:', data);
        this.notifications = data;
      } catch (error) {
        debug.error('Failed to load notifications:', error);
        throw error;
      }
     },
     /**
      * Cleanup store - clean and simple
      */
     // =============================================
     // CONVERSATION MANAGEMENT
     // =============================================

     /**
      * Get conversation context for a post
      */
     async getConversationContext(postId: string): Promise<ConversationContext | null> {
       try {
         this.isLoadingConversation = true;
         
         // Check cache first
         if (this.conversationContexts.has(postId)) {
           return this.conversationContexts.get(postId)!;
         }

         const context = await activityPubService.getConversationContext(postId);
         this.conversationContexts.set(postId, context);
         
         return context;
       } catch (error) {
         debug.error('Failed to get conversation context:', error);
         return null;
       } finally {
         this.isLoadingConversation = false;
       }
     },

     /**
      * Get full conversation thread
      */
     async getConversationThread(conversationId: string): Promise<ConversationThread | null> {
       try {
         this.isLoadingConversation = true;
         
         // Check cache first
         if (this.conversations.has(conversationId)) {
           return this.conversations.get(conversationId)!;
         }

         const thread = await activityPubService.getConversationThread(conversationId);
         this.conversations.set(conversationId, thread);
         
         return thread;
       } catch (error) {
         debug.error('Failed to get conversation thread:', error);
         return null;
       } finally {
         this.isLoadingConversation = false;
       }
     },

     /**
      * Get replies to a specific post
      */
     async getPostReplies(postId: string, options: { limit?: number; max_id?: string } = {}) {
       try {
         return await activityPubService.getPostReplies(postId, options);
       } catch (error) {
         debug.error('Failed to get post replies:', error);
         return [];
       }
     },

     /**
      * Reply to a post
      */
     async replyToPost(postId: string, content: string, options: {
       visibility?: 'public' | 'unlisted' | 'followers' | 'direct';
       content_warning?: string;
       is_sensitive?: boolean;
     } = {}) {
       try {
         const replyData = {
           content: await this.formatPostContent(content),
           visibility: options.visibility || 'public',
           content_warning: options.content_warning,
           in_reply_to: postId,
           is_sensitive: options.is_sensitive || false,
           language: 'en'
         };

         const reply = await services.posts.createPost(replyData);
         
         // Clear conversation cache to force refresh
         this.conversationContexts.clear();
         this.conversations.clear();
         
         return reply;
       } catch (error) {
         debug.error('Failed to reply to post:', error);
         throw error;
       }
     },

     /**
      * Navigate to conversation view
      */
     showConversation(postId: string) {
       debug.log(`🏪 Store showConversation called with postId: ${postId}`);
       
       try {
         // Navigate to post detail view
         debug.log(`🧭 Attempting to navigate to PostView route`);
         router.push({
           name: 'PostView',
           params: { postId }
         });
         debug.log(`✅ Navigation initiated successfully`);
       } catch (error) {
         debug.error(`❌ Navigation failed:`, error);
         // Fallback: try using window.location
         debug.log(`🔄 Trying fallback navigation method`);
         window.location.href = `/social/post/${postId}`;
       }
     },

     /**
      * Get all posts from all feeds (helper method)
      */
     getAllPosts(): TimelinePost[] {
       return [
         ...this.homeFeed.posts,
         ...this.publicFeed.posts,
         ...this.localFeed.posts,
         ...Array.from(this.userFeeds.values()).flatMap(feed => feed.posts)
       ].filter((post, index, array) => 
         array.findIndex(p => p.id === post.id) === index // Remove duplicates
       );
     },

     /**
      * Switch current timeline view
      */
     switchView(view: 'home' | 'public' | 'local') {
       this.currentView = view;
       debug.log(`🔄 Switched to ${view} timeline`);
     },

     cleanup() {
       this.cleanupRealtimeSubscriptions();
       this.conversations.clear();
       this.conversationContexts.clear();
       this.unreadCount = 0;
       debug.log('🧹 ActivityPub store cleaned up');
     },


     /**
      * Get post with configurable context - main method for new architecture
      * Supports all context scenarios: minimal, full thread, ancestors only, descendants only
      */
     async getPostWithContext(
       postId: string, 
       options: PostContextOptions = {}
     ): Promise<PostWithContext> {
       try {
         debug.log(`🔄 Store: Loading post ${postId} with context: ${options.context || 'minimal'}`);
         
         const result = await activityPubService.getPostWithContext(postId, options);
         
         debug.log(`✅ Store: Post with context loaded successfully`);
         return result;
       } catch (error) {
         debug.error('❌ Store: Failed to get post with context:', error);
         throw error;
       }
     },
  }
});
