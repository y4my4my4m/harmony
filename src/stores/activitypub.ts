/**
 * ActivityPub Store - Pinia store for managing federated content and state
 * Professional state management for the Monyverse
 */

import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import { federationService } from '@/services/activitypub/federationService';
import type { 
  Post, 
  TimelinePost, 
  PostComposerState, 
  MonyFeed
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
}

export const useActivityPubStore = defineStore('activitypub', {
  state: (): ActivityPubState => ({
    // Feed state
    homeFeed: { posts: [], has_more: true, cursor: undefined },
    publicFeed: { posts: [], has_more: true, cursor: undefined },
    localFeed: { posts: [], has_more: true, cursor: undefined },
    userFeeds: new Map(),
    
    // User state
    followedUsers: new Set(),
    blockedUsers: new Set(),
    mutedUsers: new Set(),
    
    // Instance state
    knownInstances: [],
    blockedInstances: new Set(),
    
    // UI state
    isComposerOpen: false,
    composerState: {
      content: '',
      visibility: 'public',
      content_warning: '',
      in_reply_to: undefined,
      media_attachments: [],
      is_sensitive: false,
      language: 'en'
    },
    selectedPost: undefined,
    
    // Loading states
    isLoadingFeed: false,
    isLoadingPost: false,
    isLoadingProfile: false,
    isPosting: false
  }),

  getters: {
    /**
     * Get posts for a specific timeline
     */
    getTimelinePosts: (state) => (timeline: 'home' | 'public' | 'local') => {
      switch (timeline) {
        case 'home':
          return state.homeFeed.posts;
        case 'public':
          return state.publicFeed.posts;
        case 'local':
          return state.localFeed.posts;
        default:
          return [];
      }
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
     * Get unread count for notifications/new posts
     */
    unreadCount: () => {
      // For now, return 0 - this will be implemented with notifications
      return 0;
    }
  },

  actions: {
    /**
     * Initialize the ActivityPub store
     */
    async initialize() {
      try {
        await federationService.initialize();
        await this.loadFollowedUsers();
        console.log('🌐 ActivityPub store initialized');
      } catch (error) {
        console.error('❌ Failed to initialize ActivityPub store:', error);
      }
    },

    /**
     * Load the user's home timeline
     */
    async loadHomeFeed(maxId?: string) {
      this.isLoadingFeed = true;
      try {
        const { data, error } = await supabase.rpc('get_user_timeline', {
          p_user_id: supabase.auth.getUser().then(u => u.data.user?.id),
          p_timeline_type: 'home',
          p_limit: 20,
          p_max_id: maxId
        });

        if (error) throw error;

        const posts = data.map(this.transformDatabasePostToTimelinePost);
        
        if (maxId) {
          this.homeFeed.posts.push(...posts);
        } else {
          this.homeFeed.posts = posts;
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
        const { data, error } = await supabase
          .from('posts')
          .select(`
            *,
            author:profiles(*)
          `)
          .eq('visibility', 'public')
          .eq('is_deleted', false)
          .order('created_at', { ascending: false })
          .limit(20);

        if (error) throw error;

        const posts = data.map(this.transformDatabasePostToTimelinePost);
        
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
     * Create a new post (Mony)
     */
    async createPost(postData: {
      content: string;
      visibility: Post['visibility'];
      content_warning?: string;
      in_reply_to?: string;
      media_attachments?: File[];
      is_sensitive?: boolean;
    }) {
      this.isPosting = true;
      try {
        const user = await supabase.auth.getUser();
        if (!user.data.user) throw new Error('User not authenticated');

        // Upload media attachments if any
        const mediaUrls = await this.uploadMediaAttachments(postData.media_attachments || []);

        // Create post in database
        const { data: post, error } = await supabase
          .from('posts')
          .insert({
            content: this.formatPostContent(postData.content),
            content_warning: postData.content_warning,
            visibility: postData.visibility,
            in_reply_to: postData.in_reply_to,
            author_id: user.data.user.id,
            media_attachments: mediaUrls,
            is_sensitive: postData.is_sensitive || false,
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
          if (postData.visibility === 'public') {
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
     * Transform database post to timeline post
     */
    transformDatabasePostToTimelinePost(dbPost: any): TimelinePost {
      return {
        id: dbPost.id,
        created_at: dbPost.created_at,
        updated_at: dbPost.updated_at,
        content: dbPost.content,
        content_warning: dbPost.content_warning,
        language: dbPost.language,
        author_id: dbPost.author_id,
        ap_id: dbPost.ap_id,
        ap_type: dbPost.ap_type,
        url: dbPost.url,
        in_reply_to: dbPost.in_reply_to,
        conversation_id: dbPost.conversation_id,
        visibility: dbPost.visibility,
        is_local: dbPost.is_local,
        is_federated: dbPost.is_federated,
        replies_count: dbPost.replies_count,
        reblogs_count: dbPost.reblogs_count,
        favorites_count: dbPost.favorites_count,
        media_attachments: dbPost.media_attachments,
        metadata: dbPost.metadata,
        is_sensitive: dbPost.is_sensitive,
        is_deleted: dbPost.is_deleted,
        deleted_at: dbPost.deleted_at,
        author: {
          id: dbPost.author.id,
          username: dbPost.author.username,
          display_name: dbPost.author.display_name,
          avatar_url: dbPost.author.avatar_url,
          domain: dbPost.author.domain,
          handle: `@${dbPost.author.username}${dbPost.author.domain !== 'harmony.com' ? '@' + dbPost.author.domain : ''}`
        },
        interactions: {
          is_favorited: false,
          is_reblogged: false,
          is_bookmarked: false
        }
      };
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

        const { error } = await supabase
          .from('follows')
          .insert({
            follower_id: user.data.user.id,
            following_id: userId,
            status: 'pending' // Will be 'accepted' for local users
          });

        if (error) throw error;

        this.followedUsers.add(userId);

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

        // TODO: Send ActivityPub Undo Follow activity for remote users
      } catch (error) {
        console.error('Failed to unfollow user:', error);
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
     * Update post interaction in local state
     */
    updatePostInteraction(postId: string, type: 'favorite' | 'reblog', isActive: boolean) {
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
          }
        }
      });
    },

    /**
     * Open the post composer
     */
    openComposer(options?: {
      in_reply_to?: string;
      content?: string;
      visibility?: Post['visibility'];
    }) {
      this.isComposerOpen = true;
      this.composerState = {
        content: options?.content || '',
        visibility: options?.visibility || 'public',
        content_warning: '',
        in_reply_to: options?.in_reply_to,
        media_attachments: [],
        is_sensitive: false,
        language: 'en'
      };
    },

    /**
     * Close the post composer
     */
    closeComposer() {
      this.isComposerOpen = false;
      this.composerState = {
        content: '',
        visibility: 'public',
        content_warning: '',
        in_reply_to: undefined,
        media_attachments: [],
        is_sensitive: false,
        language: 'en'
      };
    },

    /**
     * Update composer state
     */
    updateComposer(updates: Partial<PostComposerState>) {
      this.composerState = { ...this.composerState, ...updates };
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
    }
  }
});
