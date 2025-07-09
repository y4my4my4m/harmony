/**
 * ActivityPub Store - Pinia store for managing federated content and state
 * Professional state management for the Monyverse
 */

import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { 
  Post, 
  TimelinePost, 
  PostComposerState, 
  MonyFeed,
  FederatedUser,
  Notification
} from '@/types';

interface ActivityPubState {
  // Feed state
  homeFeed: MonyFeed;
  publicFeed: MonyFeed;
  localFeed: MonyFeed;
  userFeeds: Map<string, MonyFeed>;
  
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
  
  // Loading states
  isLoadingFeed: boolean;
  isLoadingPost: boolean;
  isLoadingProfile: boolean;
  isPosting: boolean;
  
  // Realtime subscriptions
  realtimeSubscriptions: Map<string, any>;
  
  // Notification integration
  lastNotificationCheck: Date | null;
  unreadCount: number;
}

export const useActivityPubStore = defineStore('activitypub', {
  state: (): ActivityPubState => ({
    // Feed state
    homeFeed: {
      posts: [],
      has_more: true,
      cursor: null
    },
    publicFeed: {
      posts: [],
      has_more: true,
      cursor: null
    },
    localFeed: {
      posts: [],
      has_more: true,
      cursor: null
    },
    userFeeds: new Map(),
    
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
    
    // Loading states
    isLoadingFeed: false,
    isLoadingPost: false,
    isLoadingProfile: false,
    isPosting: false,
    
    // Realtime subscriptions
    realtimeSubscriptions: new Map(),
    
    // Notification integration
    lastNotificationCheck: null,
    unreadCount: 0
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
        console.log('🌐 Initializing ActivityPub store...');
        
        // Load user relationships and counts
        await this.loadFollowedUsers();
        await this.loadFollowCounts();
        await this.loadUserPreferences();
        
        // Setup comprehensive realtime subscriptions
        this.setupEnhancedRealtimeSubscriptions();
        
        console.log('✅ ActivityPub store initialized successfully');
      } catch (error) {
        console.error('❌ Failed to initialize ActivityPub store:', error);
      }
    },

    /**
     * Load follow counts for the current user
     */
    async loadFollowCounts() {
      try {
        const user = await supabase.auth.getUser();
        if (!user.data.user) return;

        // Get following count
        const { count: followingCount } = await supabase
          .from('follows')
          .select('*', { count: 'exact', head: true })
          .eq('follower_id', user.data.user.id)
          .eq('status', 'accepted');

        // Get followers count
        const { count: followersCount } = await supabase
          .from('follows')
          .select('*', { count: 'exact', head: true })
          .eq('following_id', user.data.user.id)
          .eq('status', 'accepted');

        this.followingCount = followingCount || 0;
        this.followersCount = followersCount || 0;

        console.log(`📊 Follow counts loaded: ${this.followingCount} following, ${this.followersCount} followers`);
      } catch (error) {
        console.error('❌ Failed to load follow counts:', error);
      }
    },

    /**
     * Load user preferences for ActivityPub
     */
    async loadUserPreferences() {
      try {
        const user = await supabase.auth.getUser();
        if (!user.data.user) return;

        const { data, error } = await supabase
          .from('profiles')
          .select('activitypub_preferences')
          .eq('id', user.data.user.id)
          .single();

        if (error) throw error;

        // Store preferences in state if needed
        console.log('⚙️ User preferences loaded');
      } catch (error) {
        console.error('❌ Failed to load user preferences:', error);
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

      // Subscribe to posts updates
      const postsChannel = supabase
        .channel('activitypub_posts_enhanced')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'posts' },
          (payload) => this.handleRealtimePostCreate(payload.new)
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'posts' },
          (payload) => this.handleRealtimePostUpdate(payload.new)
        )
        .on(
          'postgres_changes',
          { event: 'DELETE', schema: 'public', table: 'posts' },
          (payload) => this.handleRealtimePostDelete(payload.old)
        )
        .subscribe();

      // Subscribe to follow relationship updates
      const followsChannel = supabase
        .channel('activitypub_follows_enhanced')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'follows' },
          (payload) => this.handleRealtimeFollowCreate(payload.new)
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'follows' },
          (payload) => this.handleRealtimeFollowUpdate(payload.new)
        )
        .on(
          'postgres_changes',
          { event: 'DELETE', schema: 'public', table: 'follows' },
          (payload) => this.handleRealtimeFollowDelete(payload.old)
        )
        .subscribe();

      // Subscribe to post interactions
      const interactionsChannel = supabase
        .channel('activitypub_interactions_enhanced')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'post_interactions' },
          (payload) => this.handleRealtimeInteractionChange(payload)
        )
        .subscribe();

      // Store subscriptions for cleanup
      this.realtimeSubscriptions.set('posts', postsChannel);
      this.realtimeSubscriptions.set('follows', followsChannel);
      this.realtimeSubscriptions.set('interactions', interactionsChannel);

      console.log('🔔 Enhanced realtime subscriptions established');
    },

    /**
     * Handle realtime post creation
     */
    handleRealtimePostCreate(post: any) {
      console.log('📝 New post received:', post);
      
      const timelinePost = this.transformDatabasePostToTimelinePost(post);
      
      // Add to public feed if public
      if (post.visibility === 'public') {
        this.publicFeed.posts.unshift(timelinePost);
        // Limit feed size
        if (this.publicFeed.posts.length > 100) {
          this.publicFeed.posts = this.publicFeed.posts.slice(0, 100);
        }
      }
      
      // Add to local feed if local
      if (post.is_local && post.visibility === 'public') {
        this.localFeed.posts.unshift(timelinePost);
        if (this.localFeed.posts.length > 100) {
          this.localFeed.posts = this.localFeed.posts.slice(0, 100);
        }
      }
      
      // Add to home feed if following the author and increment unread count
      if (this.followedUsers.has(post.author_id)) {
        this.homeFeed.posts.unshift(timelinePost);
        this.unreadCount++;
        if (this.homeFeed.posts.length > 100) {
          this.homeFeed.posts = this.homeFeed.posts.slice(0, 100);
        }
      }
    },

    /**
     * Handle realtime post updates
     */
    handleRealtimePostUpdate(post: any) {
      console.log('📝 Post updated:', post);
      
      const timelinePost = this.transformDatabasePostToTimelinePost(post);
      this.updatePostInAllFeeds(timelinePost);
    },

    /**
     * Handle realtime post deletion
     */
    handleRealtimePostDelete(post: any) {
      console.log('🗑️ Post deleted:', post);
      
      this.removePostFromAllFeeds(post.id);
    },

    /**
     * Handle realtime follow creation
     */
    async handleRealtimeFollowCreate(follow: any) {
      console.log('👥 New follow relationship:', follow);
      
      const currentUser = await supabase.auth.getUser();
      if (!currentUser.data.user) return;

      // Update counts based on relationship
      if (follow.follower_id === currentUser.data.user.id) {
        // Current user started following someone
        this.followingCount++;
        this.followedUsers.add(follow.following_id);
      } else if (follow.following_id === currentUser.data.user.id) {
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
      console.log('👥 Follow relationship updated:', follow);
      
      const currentUser = await supabase.auth.getUser();
      if (!currentUser.data.user) return;

      // Handle status changes (accepted/rejected)
      if (follow.status === 'accepted') {
        if (follow.follower_id === currentUser.data.user.id) {
          this.followedUsers.add(follow.following_id);
        }
      } else if (follow.status === 'rejected') {
        if (follow.follower_id === currentUser.data.user.id) {
          this.followedUsers.delete(follow.following_id);
        }
      }
    },

    /**
     * Handle realtime follow deletion
     */
    async handleRealtimeFollowDelete(follow: any) {
      console.log('👥 Follow relationship deleted:', follow);
      
      const currentUser = await supabase.auth.getUser();
      if (!currentUser.data.user) return;

      // Update counts based on relationship
      if (follow.follower_id === currentUser.data.user.id) {
        // Current user unfollowed someone
        this.followingCount--;
        this.followedUsers.delete(follow.following_id);
      } else if (follow.following_id === currentUser.data.user.id) {
        // Someone unfollowed current user
        this.followersCount--;
      }
    },

    /**
     * Handle realtime interaction changes
     */
    handleRealtimeInteractionChange(payload: any) {
      console.log('💫 Interaction changed:', payload);
      
      const interaction = payload.new || payload.old;
      if (!interaction) return;

      // Update interaction counts in posts
      this.updatePostInteractionCounts(interaction.post_id, interaction.type, payload.eventType);
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
            title: 'New Follower',
            message: `${follower.display_name || follower.username} started following you`,
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

        console.log('🔔 Follow notification created');
      } catch (error) {
        console.error('❌ Failed to create follow notification:', error);
      }
    },

    /**
     * Update post interaction counts
     */
    updatePostInteractionCounts(postId: string, interactionType: string, eventType: string) {
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed];
      
      feeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          const delta = eventType === 'INSERT' ? 1 : eventType === 'DELETE' ? -1 : 0;
          
          switch (interactionType) {
            case 'favorite':
              post.favorites_count = Math.max(0, post.favorites_count + delta);
              break;
            case 'reblog':
              post.reblogs_count = Math.max(0, post.reblogs_count + delta);
              break;
            case 'reply':
              post.replies_count = Math.max(0, post.replies_count + delta);
              break;
          }
        }
      });
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
      
      console.log('🧹 Realtime subscriptions cleaned up');
    },

    /**
     * Load the user's home timeline
     */
    async loadHomeFeed(maxId?: string) {
      this.isLoadingFeed = true;
      try {
        const user = await supabase.auth.getUser();
        if (!user.data.user) throw new Error('User not authenticated');

        const { data, error } = await supabase.rpc('get_user_timeline', {
          p_user_id: user.data.user.id,
          p_timeline_type: 'home',
          p_limit: 20,
          p_max_id: maxId
        });

        if (error) throw error;

        const posts = data ? data.map(this.transformTimelineResultToTimelinePost) : [];
        
        // If no timeline data exists, fallback to direct post query for development
        if (posts.length === 0 && !maxId) {
          console.warn('No timeline entries found, falling back to direct post query');
          const { data: fallbackData, error: fallbackError } = await supabase
            .from('posts')
            .select(`
              *,
              author:profiles(*)
            `)
            .eq('visibility', 'public')
            .eq('is_deleted', false)
            .order('created_at', { ascending: false })
            .limit(10);
          
          if (!fallbackError && fallbackData) {
            posts.push(...fallbackData.map(this.transformDatabasePostToTimelinePost));
          }
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
        console.error('Failed to load home feed:', error);
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
        let query = supabase
          .from('posts')
          .select(`
            *,
            author:profiles(*)
          `)
          .eq('visibility', 'public')
          .eq('is_deleted', false)
          .order('created_at', { ascending: false })
          .limit(20);

        // Add pagination if maxId is provided
        if (maxId) {
          const { data: maxPost } = await supabase
            .from('posts')
            .select('created_at')
            .eq('id', maxId)
            .single();
          
          if (maxPost) {
            query = query.lt('created_at', maxPost.created_at);
          }
        }

        const { data, error } = await query;

        if (error) throw error;

        const posts = data ? data.map(this.transformDatabasePostToTimelinePost) : [];
        
        if (maxId) {
          this.publicFeed.posts.push(...posts);
        } else {
          this.publicFeed.posts = posts;
        }

        this.publicFeed.has_more = posts.length === 20;
        this.publicFeed.cursor = posts[posts.length - 1]?.id;

      } catch (error) {
        console.error('Failed to load public feed:', error);
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
        let query = supabase
          .from('posts')
          .select(`
            *,
            author:profiles(*)
          `)
          .eq('visibility', 'public')
          .eq('is_deleted', false)
          .eq('is_local', true) // Only local posts
          .order('created_at', { ascending: false })
          .limit(20);

        // Add pagination if maxId is provided
        if (maxId) {
          const { data: maxPost } = await supabase
            .from('posts')
            .select('created_at')
            .eq('id', maxId)
            .single();
          
          if (maxPost) {
            query = query.lt('created_at', maxPost.created_at);
          }
        }

        const { data, error } = await query;

        if (error) throw error;

        const posts = data ? data.map(this.transformDatabasePostToTimelinePost) : [];
        
        if (maxId) {
          this.localFeed.posts.push(...posts);
        } else {
          this.localFeed.posts = posts;
        }

        this.localFeed.has_more = posts.length === 20;
        this.localFeed.cursor = posts[posts.length - 1]?.id;

      } catch (error) {
        console.error('Failed to load local feed:', error);
      } finally {
        this.isLoadingFeed = false;
      }
    },

    /**
     * Create a new post (Mony)
     */
    async createPost(postData?: {
      content?: string;
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
        const user = await supabase.auth.getUser();
        if (!user.data.user) throw new Error('User not authenticated');

        // Use postData if provided, otherwise use composer state
        const content = postData?.content || this.composerState.content;
        const visibility = postData?.visibility || this.composerState.visibility;
        const contentWarning = postData?.content_warning || postData?.contentWarning || this.composerState.contentWarning;
        const replyTo = postData?.in_reply_to || postData?.replyTo || this.composerState.replyTo;
        const mediaAttachments = postData?.media_attachments || [];
        const sensitive = postData?.is_sensitive ?? postData?.sensitive ?? this.composerState.sensitive;

        // Upload media attachments if any
        const mediaUrls = await this.uploadMediaAttachments(mediaAttachments);

        // Create post in database
        const { data: post, error } = await supabase
          .from('posts')
          .insert({
            content: this.formatPostContent(content),
            content_warning: contentWarning,
            visibility: visibility,
            in_reply_to: replyTo,
            author_id: user.data.user.id,
            media_attachments: mediaUrls,
            is_sensitive: sensitive || false,
            language: 'en'
          })
          .select()
          .single();

        if (error) throw error;

        // Close composer
        this.closeComposer();

        // Add to local feed immediately for better UX
        const timelinePost = await this.loadPostWithAuthor(post.id);
        if (timelinePost) {
          this.homeFeed.posts.unshift(timelinePost);
          if (visibility === 'public') {
            this.publicFeed.posts.unshift(timelinePost);
          }
        }

        // Federation: Send to followers if needed
        if (post.visibility === 'public' || post.visibility === 'unlisted') {
          await this.federatePost(post.id);
        }

        return post;
      } catch (error) {
        console.error('Failed to create post:', error);
        throw error;
      } finally {
        this.isPosting = false;
      }
    },

    /**
     * Upload media attachments
     */
    async uploadMediaAttachments(files: File[]): Promise<any[]> {
      const uploadPromises = files.map(async (file) => {
        const fileExt = file.name.split('.').pop();
        const fileName = `${crypto.randomUUID()}.${fileExt}`;
        const filePath = `posts/${fileName}`;

        const { data, error } = await supabase.storage
          .from('user_media')
          .upload(filePath, file);

        if (error) throw error;

        return {
          type: file.type.startsWith('image/') ? 'Image' : 'Document',
          url: data.path,
          mediaType: file.type,
          name: file.name
        };
      });

      return Promise.all(uploadPromises);
    },

    /**
     * Format post content for storage
     */
    formatPostContent(content: string): any {
      // For now, store as simple text
      // TODO: Parse mentions, hashtags, etc.
      return content;
    },

    /**
     * Federate a post to remote instances
     */
    async federatePost(postId: string) {
      try {
        // This would be handled by a background job in production
        // For now, just log the federation intent
        console.log(`🌐 Federating post ${postId}`);
      } catch (error) {
        console.error('Failed to federate post:', error);
      }
    },

    /**
     * Load post with author information
     */
    async loadPostWithAuthor(postId: string): Promise<TimelinePost | null> {
      try {
        const { data, error } = await supabase
          .from('posts')
          .select(`
            *,
            author:profiles(*)
          `)
          .eq('id', postId)
          .single();

        if (error) throw error;

        return this.transformDatabasePostToTimelinePost(data);
      } catch (error) {
        console.error('Failed to load post with author:', error);
        return null;
      }
    },

    /**
     * Transform RPC timeline result to TimelinePost
     */
    transformTimelineResultToTimelinePost(result: any): TimelinePost {
      return {
        id: result.post_id,
        created_at: result.created_at,
        updated_at: result.created_at, // RPC doesn't return updated_at
        content: result.content,
        content_warning: undefined, // Not returned by RPC
        language: 'en', // Default
        author_id: result.author_id,
        ap_id: undefined, // Not returned by RPC
        ap_type: 'Note', // Default
        url: undefined, // Not returned by RPC
        in_reply_to: result.in_reply_to,
        conversation_id: undefined, // Not returned by RPC
        visibility: result.visibility,
        is_local: true, // Default for now
        is_federated: true, // Default for now
        replies_count: result.replies_count,
        reblogs_count: result.reblogs_count,
        favorites_count: result.favorites_count,
        media_attachments: result.media_attachments || [],
        metadata: {}, // Default
        is_sensitive: false, // Default
        is_deleted: false, // Default
        deleted_at: undefined,
        author: {
          id: result.author_id,
          username: result.author_username,
          display_name: result.author_display_name,
          avatar_url: result.author_avatar_url,
          domain: result.author_domain,
          handle: `@${result.author_username}${result.author_domain !== 'harmony.com' ? '@' + result.author_domain : ''}`
        },
        interactions: {
          is_favorited: result.is_favorited,
          is_reblogged: result.is_reblogged,
          is_bookmarked: false // Not returned by RPC
        }
      };
    },

    /**
     * Transform database post to TimelinePost
     */
    transformDatabasePostToTimelinePost(post: any): TimelinePost {
      return {
        id: post.id,
        created_at: post.created_at,
        updated_at: post.updated_at,
        content: post.content,
        content_warning: post.content_warning,
        language: post.language || 'en',
        author_id: post.author_id,
        ap_id: post.ap_id,
        ap_type: post.ap_type,
        url: post.url,
        in_reply_to: post.in_reply_to,
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
        author: post.author || {
          id: post.author_id,
          username: 'Unknown',
          display_name: 'Unknown User',
          avatar_url: '/default_avatar.png',
          domain: 'local',
          handle: '@unknown'
        },
        interactions: {
          is_favorited: false,
          is_reblogged: false,
          is_bookmarked: false
        }
      };
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
            post.interactions.is_favorited = isActive;
            post.favorites_count += isActive ? 1 : -1;
          } else if (type === 'reblog') {
            post.interactions.is_reblogged = isActive;
            post.reblogs_count += isActive ? 1 : -1;
          } else if (type === 'bookmark') {
            post.interactions.is_bookmarked = isActive;
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
            console.log('New post received:', payload.new);
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
            console.log('Post interaction update:', payload);
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
          (payload) => {
            console.log('Follow relationship update:', payload);
            // TODO: Update follow state
          }
        )
        .subscribe();
    },

    /**
     * Resolve a user handle to a user object
     */
    async resolveUserByHandle(handle: string): Promise<FederatedUser | null> {
      try {
        // Remove @ prefix if present
        const cleanHandle = handle.startsWith('@') ? handle.substring(1) : handle;
        
        // Parse handle - can be "username" or "username@domain"
        const parts = cleanHandle.split('@');
        const username = parts[0];
        const domain = parts[1] || 'har.mony.lol';
        
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('username', username)
          .eq('domain', domain)
          .single();
        
        if (error) {
          if (error.code === 'PGRST116') return null; // Not found
          throw error;
        }
        
        return {
          id: data.id,
          username: data.username,
          display_name: data.display_name,
          domain: data.domain,
          avatar_url: data.avatar_url,
          handle: domain === 'har.mony.lol' 
            ? `@${username}`
            : `@${username}@${domain}`,
          is_local: data.is_local,
          bio: data.about,
          verified: false,
          followers_count: 0,
          following_count: 0,
          posts_count: 0,
          created_at: data.created_at,
          updated_at: data.updated_at,
          about: data.about,
          federated_id: data.federated_id,
          public_key: data.public_key,
          inbox_url: data.inbox_url,
          outbox_url: data.outbox_url,
          followers_url: data.followers_url,
          following_url: data.following_url,
          featured_url: data.featured_url,
          last_synced_at: data.last_synced_at
        } as FederatedUser;
      } catch (error) {
        console.error('Failed to resolve user by handle:', error);
        return null;
      }
    },

    /**
     * Get user by ID (for navigation from UUIDs)
     */
    async getUserById(userId: string): Promise<FederatedUser | null> {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', userId)
          .single();
        
        if (error) {
          if (error.code === 'PGRST116') return null;
          throw error;
        }
        
        return {
          id: data.id,
          username: data.username,
          display_name: data.display_name,
          domain: data.domain,
          avatar_url: data.avatar_url,
          handle: data.domain === 'har.mony.lol' 
            ? `@${data.username}`
            : `@${data.username}@${data.domain}`,
          is_local: data.is_local,
          bio: data.about,
          verified: false,
          followers_count: 0,
          following_count: 0,
          posts_count: 0,
          created_at: data.created_at,
          updated_at: data.updated_at,
          about: data.about,
          federated_id: data.federated_id,
          public_key: data.public_key,
          inbox_url: data.inbox_url,
          outbox_url: data.outbox_url,
          followers_url: data.followers_url,
          following_url: data.following_url,
          featured_url: data.featured_url,
          last_synced_at: data.last_synced_at
        } as FederatedUser;
      } catch (error) {
        console.error('Failed to get user by ID:', error);
        return null;
      }
    },

    /**
     * Mute a user
     */
    async muteUser(userId: string) {
      try {
        // TODO: Implement mute API call
        console.log('Muting user:', userId);
        this.mutedUsers.add(userId);
      } catch (error) {
        console.error('Failed to mute user:', error);
        throw error;
      }
    },

    /**
     * Unmute a user
     */
    async unmuteUser(userId: string) {
      try {
        // TODO: Implement unmute API call
        console.log('Unmuting user:', userId);
        this.mutedUsers.delete(userId);
      } catch (error) {
        console.error('Failed to unmute user:', error);
        throw error;
      }
    },

    /**
     * Block a user
     */
    async blockUser(userId: string) {
      try {
        // TODO: Implement block API call
        console.log('Blocking user:', userId);
        this.blockedUsers.add(userId);
        
        // Also unfollow if following
        if (this.followedUsers.has(userId)) {
          await this.unfollowUser(userId);
        }
      } catch (error) {
        console.error('Failed to block user:', error);
        throw error;
      }
    },

    /**
     * Unblock a user
     */
    async unblockUser(userId: string) {
      try {
        // TODO: Implement unblock API call
        console.log('Unblocking user:', userId);
        this.blockedUsers.delete(userId);
      } catch (error) {
        console.error('Failed to unblock user:', error);
        throw error;
      }
    },

    /**
     * Toggle post favorite (like)
     */
    async toggleFavorite(postId: string) {
      try {
        const user = await supabase.auth.getUser();
        if (!user.data.user) throw new Error('User not authenticated');

        // Check if already favorited
        const { data: existing } = await supabase
          .from('post_interactions')
          .select('id')
          .eq('user_id', user.data.user.id)
          .eq('post_id', postId)
          .eq('interaction_type', 'favorite')
          .single();

        if (existing) {
          // Remove favorite
          await supabase
            .from('post_interactions')
            .delete()
            .eq('id', existing.id);
        } else {
          // Add favorite
          await supabase
            .from('post_interactions')
            .insert({
              user_id: user.data.user.id,
              post_id: postId,
              interaction_type: 'favorite'
            });
        }

        // Update local state
        this.updatePostInteraction(postId, 'favorite', !existing);

      } catch (error) {
        console.error('Failed to toggle favorite:', error);
        throw error;
      }
    },

    /**
     * Toggle post bookmark
     */
    async toggleBookmark(postId: string) {
      try {
        const user = await supabase.auth.getUser();
        if (!user.data.user) throw new Error('User not authenticated');

        // Check if already bookmarked
        const { data: existing } = await supabase
          .from('post_interactions')
          .select('id')
          .eq('user_id', user.data.user.id)
          .eq('post_id', postId)
          .eq('interaction_type', 'bookmark')
          .single();

        if (existing) {
          // Remove bookmark
          await supabase
            .from('post_interactions')
            .delete()
            .eq('id', existing.id);
        } else {
          // Add bookmark
          await supabase
            .from('post_interactions')
            .insert({
              user_id: user.data.user.id,
              post_id: postId,
              interaction_type: 'bookmark'
            });
        }

        // Update local state
        this.updatePostInteraction(postId, 'bookmark', !existing);

      } catch (error) {
        console.error('Failed to toggle bookmark:', error);
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

        const posts = data ? data.map(item => this.transformDatabasePostToTimelinePost(item.post)).filter(Boolean) : [];
        
        return {
          posts,
          cursor: posts.length > 0 ? data[data.length - 1].created_at : null,
          hasMore: posts.length === limit
        };
      } catch (error) {
        console.error('Failed to get bookmarks:', error);
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
      } catch (error) {
        console.error('Failed to clear bookmarks:', error);
        throw error;
      }
    },

    /**
     * Toggle post reblog
     */
    async toggleReblog(postId: string) {
      try {
        const user = await supabase.auth.getUser();
        if (!user.data.user) throw new Error('User not authenticated');

        // Check if already reblogged
        const { data: existing } = await supabase
          .from('post_interactions')
          .select('id')
          .eq('user_id', user.data.user.id)
          .eq('post_id', postId)
          .eq('interaction_type', 'reblog')
          .single();

        if (existing) {
          // Remove reblog
          await supabase
            .from('post_interactions')
            .delete()
            .eq('id', existing.id);
        } else {
          // Add reblog
          await supabase
            .from('post_interactions')
            .insert({
              user_id: user.data.user.id,
              post_id: postId,
              interaction_type: 'reblog'
            });
        }

        // Update local state
        this.updatePostInteraction(postId, 'reblog', !existing);

      } catch (error) {
        console.error('Failed to toggle reblog:', error);
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

        // Mark post as deleted
        const { error } = await supabase
          .from('posts')
          .update({ 
            is_deleted: true, 
            deleted_at: new Date().toISOString() 
          })
          .eq('id', postId)
          .eq('author_id', user.data.user.id);

        if (error) throw error;

        // Remove from local feeds
        this.removePostFromFeeds(postId);

      } catch (error) {
        console.error('Failed to delete post:', error);
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
      this.userFeeds.forEach(feed => {
        feed.posts = feed.posts.filter(p => p.id !== postId);
      });
    },

         /**
      * Load users that the current user follows
      */
     async loadFollowedUsers() {
       try {
         const user = await supabase.auth.getUser();
         if (!user.data.user) return;

         const { data, error } = await supabase
           .from('follows')
           .select('following_id')
           .eq('follower_id', user.data.user.id)
           .eq('status', 'accepted');

         if (error) throw error;

         this.followedUsers = new Set(data.map(f => f.following_id));
       } catch (error) {
         console.error('Failed to load followed users:', error);
       }
     },

     /**
      * Follow a user
      */
     async followUser(userId: string) {
       try {
         const user = await supabase.auth.getUser();
         if (!user.data.user) throw new Error('User not authenticated');

         const { data, error } = await supabase
           .from('follows')
           .insert({
             follower_id: user.data.user.id,
             following_id: userId,
             status: 'accepted',
             is_local: true
           })
           .select()
           .single();

         if (error) {
           if (error.code === '23505') {
             throw new Error('Already following this user');
           }
           throw error;
         }

         this.followedUsers.add(userId);
         this.followingCount++;

         // TODO: Send ActivityPub Follow activity for remote users
       } catch (error) {
         console.error('Failed to follow user:', error);
         throw error;
       }
     },

     /**
      * Unfollow a user
      */
     async unfollowUser(userId: string) {
       try {
         const user = await supabase.auth.getUser();
         if (!user.data.user) throw new Error('User not authenticated');

         const { error } = await supabase
           .from('follows')
           .delete()
           .eq('follower_id', user.data.user.id)
           .eq('following_id', userId);

         if (error) throw error;

         this.followedUsers.delete(userId);
         this.followingCount--;

         // TODO: Send ActivityPub Undo Follow activity for remote users
       } catch (error) {
         console.error('Failed to unfollow user:', error);
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
         console.error('Failed to get followers count:', error);
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
         console.error('Failed to get following count:', error);
         return 0;
       }
     },

     /**
      * Clear unread count manually
      */
     clearUnreadCount() {
       this.unreadCount = 0;
     },

     /**
      * Cleanup store
      */
     cleanup() {
       this.cleanupRealtimeSubscriptions();
       this.unreadCount = 0;
       console.log('🧹 ActivityPub store cleaned up');
     }
   }
 });
