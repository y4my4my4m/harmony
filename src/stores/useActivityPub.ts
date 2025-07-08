// ActivityPub Store - State management for federated social features
// Professional Pinia store for the Monyverse
import { defineStore } from 'pinia';
import { activityPubService } from '@/services/activityPubService';
import type { 
  Post, 
  TimelinePost, 
  FederatedUser, 
  PostComposerState,
  MonyFeed,
  TimelineOptions
} from '@/types';

export const useActivityPubStore = defineStore('activityPub', {
  state: () => ({
    // Feed state
    homeFeed: {
      posts: [],
      has_more: true,
      cursor: null
    } as MonyFeed,
    
    publicFeed: {
      posts: [],
      has_more: true,
      cursor: null
    } as MonyFeed,
    
    localFeed: {
      posts: [],
      has_more: true,
      cursor: null
    } as MonyFeed,
    
    userFeeds: new Map<string, MonyFeed>(),
    
    // User state
    followedUsers: new Set<string>(),
    searchResults: [] as FederatedUser[],
    
    // Post composer state
    isComposerOpen: false,
    composerState: {
      content: '',
      visibility: 'public' as const,
      content_warning: undefined,
      in_reply_to: undefined,
      media_attachments: [],
      is_sensitive: false,
      language: 'en'
    } as PostComposerState,
    
    // Selected content
    selectedPost: null as Post | null,
    selectedUser: null as FederatedUser | null,
    
    // Loading states
    isLoadingHomeFeed: false,
    isLoadingPublicFeed: false,
    isLoadingLocalFeed: false,
    isLoadingUserFeed: false,
    isLoadingPost: false,
    isLoadingProfile: false,
    isPosting: false,
    isSearching: false,
    
    // Real-time subscriptions
    feedSubscription: null as any,
    postsSubscription: null as any,
    followsSubscription: null as any,
    
    // UI state
    currentView: 'home' as 'home' | 'public' | 'local' | 'profile' | 'post',
    showSensitiveContent: false,
    
    // Error handling
    lastError: null as string | null,
  }),

  getters: {
    // Feed getters
    currentFeed: (state) => {
      switch (state.currentView) {
        case 'home': return state.homeFeed;
        case 'public': return state.publicFeed;
        case 'local': return state.localFeed;
        default: return state.homeFeed;
      }
    },
    
    // User interaction state
    isFollowingUser: (state) => (userId: string) => {
      return state.followedUsers.has(userId);
    },
    
    // Loading state combinators
    isLoadingAnyFeed: (state) => {
      return state.isLoadingHomeFeed || 
             state.isLoadingPublicFeed || 
             state.isLoadingLocalFeed || 
             state.isLoadingUserFeed;
    },
    
    // Post interaction helpers
    getPostById: (state) => (postId: string): TimelinePost | undefined => {
      // Search all feeds for the post
      const allPosts = [
        ...state.homeFeed.posts,
        ...state.publicFeed.posts,
        ...state.localFeed.posts,
        ...Array.from(state.userFeeds.values()).flatMap(feed => feed.posts)
      ];
      return allPosts.find(post => post.id === postId);
    },
    
    // Composer validation
    canPost: (state) => {
      return state.composerState.content.trim().length > 0 && 
             state.composerState.content.length <= 500 && // Character limit
             !state.isPosting;
    }
  },

  actions: {
    // =============================================
    // FEED MANAGEMENT
    // =============================================
    
    /**
     * Load home timeline (following + own posts)
     */
    async loadHomeFeed(refresh = false, options: TimelineOptions = {}) {
      if (this.isLoadingHomeFeed) return;
      
      try {
        this.isLoadingHomeFeed = true;
        this.lastError = null;
        
        if (refresh) {
          this.homeFeed.posts = [];
          this.homeFeed.cursor = null;
          this.homeFeed.has_more = true;
        }
        
        const posts = await activityPubService.getTimeline('home', {
          limit: options.limit || 20,
          max_id: refresh ? undefined : this.homeFeed.cursor || undefined
        });
        
        if (refresh) {
          this.homeFeed.posts = posts;
        } else {
          this.homeFeed.posts.push(...posts);
        }
        
        this.homeFeed.has_more = posts.length === (options.limit || 20);
        this.homeFeed.cursor = posts.length > 0 ? posts[posts.length - 1].created_at : null;
        
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to load home feed';
        console.error('Error loading home feed:', error);
      } finally {
        this.isLoadingHomeFeed = false;
      }
    },
    
    /**
     * Load public timeline (all public posts)
     */
    async loadPublicFeed(refresh = false, options: TimelineOptions = {}) {
      if (this.isLoadingPublicFeed) return;
      
      try {
        this.isLoadingPublicFeed = true;
        this.lastError = null;
        
        if (refresh) {
          this.publicFeed.posts = [];
          this.publicFeed.cursor = null;
          this.publicFeed.has_more = true;
        }
        
        const posts = await activityPubService.getPublicTimeline({
          limit: options.limit || 20,
          max_id: refresh ? undefined : this.publicFeed.cursor || undefined
        });
        
        if (refresh) {
          this.publicFeed.posts = posts;
        } else {
          this.publicFeed.posts.push(...posts);
        }
        
        this.publicFeed.has_more = posts.length === (options.limit || 20);
        this.publicFeed.cursor = posts.length > 0 ? posts[posts.length - 1].created_at : null;
        
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to load public feed';
        console.error('Error loading public feed:', error);
      } finally {
        this.isLoadingPublicFeed = false;
      }
    },
    
    /**
     * Load local timeline (this instance only)
     */
    async loadLocalFeed(refresh = false, options: TimelineOptions = {}) {
      if (this.isLoadingLocalFeed) return;
      
      try {
        this.isLoadingLocalFeed = true;
        this.lastError = null;
        
        if (refresh) {
          this.localFeed.posts = [];
          this.localFeed.cursor = null;
          this.localFeed.has_more = true;
        }
        
        const posts = await activityPubService.getLocalTimeline({
          limit: options.limit || 20,
          max_id: refresh ? undefined : this.localFeed.cursor || undefined
        });
        
        if (refresh) {
          this.localFeed.posts = posts;
        } else {
          this.localFeed.posts.push(...posts);
        }
        
        this.localFeed.has_more = posts.length === (options.limit || 20);
        this.localFeed.cursor = posts.length > 0 ? posts[posts.length - 1].created_at : null;
        
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to load local feed';
        console.error('Error loading local feed:', error);
      } finally {
        this.isLoadingLocalFeed = false;
      }
    },
    
    /**
     * Load user-specific feed
     */
    async loadUserFeed(userId: string, refresh = false, options: TimelineOptions = {}) {
      if (this.isLoadingUserFeed) return;
      
      try {
        this.isLoadingUserFeed = true;
        this.lastError = null;
        
        if (refresh || !this.userFeeds.has(userId)) {
          this.userFeeds.set(userId, {
            posts: [],
            has_more: true,
            cursor: null
          });
        }
        
        const userFeed = this.userFeeds.get(userId)!;
        
        const posts = await activityPubService.getUserPosts(userId, {
          limit: options.limit || 20,
          max_id: refresh ? undefined : userFeed.cursor || undefined
        });
        
        if (refresh) {
          userFeed.posts = posts;
        } else {
          userFeed.posts.push(...posts);
        }
        
        userFeed.has_more = posts.length === (options.limit || 20);
        userFeed.cursor = posts.length > 0 ? posts[posts.length - 1].created_at : null;
        
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to load user feed';
        console.error('Error loading user feed:', error);
      } finally {
        this.isLoadingUserFeed = false;
      }
    },
    
    // =============================================
    // POST MANAGEMENT
    // =============================================
    
    /**
     * Create a new post (Mony)
     */
    async createPost() {
      if (!this.canPost) return;
      
      try {
        this.isPosting = true;
        this.lastError = null;
        
        const post = await activityPubService.createPost({
          content: this.parseContentText(this.composerState.content),
          visibility: this.composerState.visibility,
          content_warning: this.composerState.content_warning,
          in_reply_to: this.composerState.in_reply_to,
          media_attachments: this.composerState.media_attachments,
          is_sensitive: this.composerState.is_sensitive,
          language: this.composerState.language
        });
        
        // Add to appropriate feeds
        this.addPostToFeeds(post);
        
        // Reset composer
        this.resetComposer();
        
        return post;
        
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to create post';
        console.error('Error creating post:', error);
        throw error;
      } finally {
        this.isPosting = false;
      }
    },
    
    /**
     * Delete a post
     */
    async deletePost(postId: string) {
      try {
        await activityPubService.deletePost(postId);
        this.removePostFromFeeds(postId);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to delete post';
        console.error('Error deleting post:', error);
        throw error;
      }
    },
    
    /**
     * Get a specific post
     */
    async getPost(postId: string): Promise<Post | null> {
      try {
        this.isLoadingPost = true;
        const post = await activityPubService.getPost(postId);
        if (post) {
          this.selectedPost = post;
        }
        return post;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to load post';
        console.error('Error loading post:', error);
        return null;
      } finally {
        this.isLoadingPost = false;
      }
    },
    
    // =============================================
    // POST INTERACTIONS
    // =============================================
    
    /**
     * Favorite/unfavorite a post
     */
    async toggleFavorite(postId: string) {
      try {
        const post = this.getPostById(postId);
        if (!post) return;
        
        if (post.is_favorited) {
          await activityPubService.unfavoritePost(postId);
          post.is_favorited = false;
          post.favorites_count = Math.max(0, post.favorites_count - 1);
        } else {
          await activityPubService.favoritePost(postId);
          post.is_favorited = true;
          post.favorites_count += 1;
        }
        
        this.updatePostInFeeds(post);
        
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to toggle favorite';
        console.error('Error toggling favorite:', error);
      }
    },
    
    /**
     * Reblog/unreblog a post
     */
    async toggleReblog(postId: string) {
      try {
        const post = this.getPostById(postId);
        if (!post) return;
        
        if (post.is_reblogged) {
          await activityPubService.unreblogPost(postId);
          post.is_reblogged = false;
          post.reblogs_count = Math.max(0, post.reblogs_count - 1);
        } else {
          await activityPubService.reblogPost(postId);
          post.is_reblogged = true;
          post.reblogs_count += 1;
        }
        
        this.updatePostInFeeds(post);
        
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to toggle reblog';
        console.error('Error toggling reblog:', error);
      }
    },
    
    /**
     * Bookmark/unbookmark a post
     */
    async toggleBookmark(postId: string) {
      try {
        const post = this.getPostById(postId);
        if (!post) return;
        
        if (post.is_bookmarked) {
          await activityPubService.unbookmarkPost(postId);
          post.is_bookmarked = false;
        } else {
          await activityPubService.bookmarkPost(postId);
          post.is_bookmarked = true;
        }
        
        this.updatePostInFeeds(post);
        
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to toggle bookmark';
        console.error('Error toggling bookmark:', error);
      }
    },
    
    // =============================================
    // USER MANAGEMENT
    // =============================================
    
    /**
     * Follow/unfollow a user
     */
    async toggleFollow(userId: string) {
      try {
        if (this.followedUsers.has(userId)) {
          await activityPubService.unfollowUser(userId);
          this.followedUsers.delete(userId);
        } else {
          await activityPubService.followUser(userId);
          this.followedUsers.add(userId);
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to toggle follow';
        console.error('Error toggling follow:', error);
      }
    },
    
    /**
     * Search for users
     */
    async searchUsers(query: string) {
      if (!query.trim()) {
        this.searchResults = [];
        return;
      }
      
      try {
        this.isSearching = true;
        this.searchResults = await activityPubService.searchUsers(query);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to search users';
        console.error('Error searching users:', error);
      } finally {
        this.isSearching = false;
      }
    },
    
    /**
     * Get user by handle
     */
    async getUserByHandle(handle: string): Promise<FederatedUser | null> {
      try {
        this.isLoadingProfile = true;
        const user = await activityPubService.getUserByHandle(handle);
        if (user) {
          this.selectedUser = user;
        }
        return user;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : 'Failed to load user';
        console.error('Error loading user:', error);
        return null;
      } finally {
        this.isLoadingProfile = false;
      }
    },
    
    // =============================================
    // COMPOSER MANAGEMENT
    // =============================================
    
    /**
     * Open post composer
     */
    openComposer(replyTo?: string) {
      this.isComposerOpen = true;
      if (replyTo) {
        this.composerState.in_reply_to = replyTo;
      }
    },
    
    /**
     * Close post composer
     */
    closeComposer() {
      this.isComposerOpen = false;
      this.resetComposer();
    },
    
    /**
     * Reset composer state
     */
    resetComposer() {
      this.composerState = {
        content: '',
        visibility: 'public',
        content_warning: undefined,
        in_reply_to: undefined,
        media_attachments: [],
        is_sensitive: false,
        language: 'en'
      };
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
    updateComposerVisibility(visibility: Post['visibility']) {
      this.composerState.visibility = visibility;
    },
    
    // =============================================
    // REAL-TIME SUBSCRIPTIONS
    // =============================================
    
    /**
     * Initialize real-time subscriptions
     */
    async initializeRealtime() {
      try {
        // Subscribe to posts for real-time updates
        this.postsSubscription = supabase
          .channel('posts_channel')
          .on('postgres_changes', 
            { event: 'INSERT', schema: 'public', table: 'posts' }, 
            (payload: any) => this.handleNewPost(payload.new)
          )
          .on('postgres_changes', 
            { event: 'UPDATE', schema: 'public', table: 'posts' }, 
            (payload: any) => this.handlePostUpdate(payload.new)
          )
          .on('postgres_changes', 
            { event: 'DELETE', schema: 'public', table: 'posts' }, 
            (payload: any) => this.handlePostDelete(payload.old)
          )
          .subscribe();
        
        // Subscribe to follows for real-time follow notifications
        this.followsSubscription = supabase
          .channel('follows_channel')
          .on('postgres_changes', 
            { event: 'INSERT', schema: 'public', table: 'follows' }, 
            (payload: any) => this.handleNewFollow(payload.new)
          )
          .subscribe();
          
        console.log('✅ ActivityPub real-time subscriptions initialized');
        
      } catch (error) {
        console.error('❌ Failed to initialize ActivityPub real-time:', error);
      }
    },
    
    /**
     * Cleanup real-time subscriptions
     */
    cleanupRealtime() {
      if (this.postsSubscription) {
        supabase.removeChannel(this.postsSubscription);
        this.postsSubscription = null;
      }
      
      if (this.followsSubscription) {
        supabase.removeChannel(this.followsSubscription);
        this.followsSubscription = null;
      }
      
      console.log('🧹 ActivityPub real-time subscriptions cleaned up');
    },
    
    // =============================================
    // REAL-TIME EVENT HANDLERS
    // =============================================
    
    /**
     * Handle new post real-time event
     */
    handleNewPost(post: Post) {
      // Add to appropriate feeds based on visibility and following status
      if (post.visibility === 'public') {
        this.publicFeed.posts.unshift(post as TimelinePost);
        if (post.is_local) {
          this.localFeed.posts.unshift(post as TimelinePost);
        }
      }
      
      // Add to home feed if following the author
      if (this.followedUsers.has(post.author_id)) {
        this.homeFeed.posts.unshift(post as TimelinePost);
      }
    },
    
    /**
     * Handle post update real-time event
     */
    handlePostUpdate(post: Post) {
      this.updatePostInFeeds(post as TimelinePost);
    },
    
    /**
     * Handle post delete real-time event
     */
    handlePostDelete(post: Post) {
      this.removePostFromFeeds(post.id);
    },
    
    /**
     * Handle new follow real-time event
     */
    handleNewFollow(follow: any) {
      // This could trigger a notification
      console.log('New follow:', follow);
    },
    
    // =============================================
    // UTILITY METHODS
    // =============================================
    
    /**
     * Parse content text into MessagePart array
     */
    parseContentText(content: string): any[] {
      // Basic implementation - can be enhanced for mentions, hashtags, etc.
      return [{ type: 'text', text: content }];
    },
    
    /**
     * Add post to relevant feeds
     */
    addPostToFeeds(post: Post) {
      const timelinePost = post as TimelinePost;
      
      // Add to home feed (always for own posts)
      this.homeFeed.posts.unshift(timelinePost);
      
      // Add to public feed if public
      if (post.visibility === 'public') {
        this.publicFeed.posts.unshift(timelinePost);
        
        // Add to local feed if local
        if (post.is_local) {
          this.localFeed.posts.unshift(timelinePost);
        }
      }
      
      // Add to user feed if exists
      if (this.userFeeds.has(post.author_id)) {
        this.userFeeds.get(post.author_id)!.posts.unshift(timelinePost);
      }
    },
    
    /**
     * Update post in all feeds
     */
    updatePostInFeeds(post: TimelinePost) {
      const updateInFeed = (feed: MonyFeed) => {
        const index = feed.posts.findIndex(p => p.id === post.id);
        if (index !== -1) {
          feed.posts[index] = { ...feed.posts[index], ...post };
        }
      };
      
      updateInFeed(this.homeFeed);
      updateInFeed(this.publicFeed);
      updateInFeed(this.localFeed);
      
      this.userFeeds.forEach(feed => updateInFeed(feed));
    },
    
    /**
     * Remove post from all feeds
     */
    removePostFromFeeds(postId: string) {
      const removeFromFeed = (feed: MonyFeed) => {
        feed.posts = feed.posts.filter(p => p.id !== postId);
      };
      
      removeFromFeed(this.homeFeed);
      removeFromFeed(this.publicFeed);
      removeFromFeed(this.localFeed);
      
      this.userFeeds.forEach(feed => removeFromFeed(feed));
    },
    
    /**
     * Switch current view
     */
    switchView(view: typeof this.currentView) {
      this.currentView = view;
    },
    
    /**
     * Clear error state
     */
    clearError() {
      this.lastError = null;
    }
  }
});

// Don't forget to import supabase
import { supabase } from '@/supabase';
