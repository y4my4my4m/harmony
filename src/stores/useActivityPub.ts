/**
 * ActivityPub Store - Pinia store for managing federated content and state
 * Professional state management for the Monyverse
 */

import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import { activityPubService } from '@/services/activityPubService';
import { authContextService } from '@/services/AuthContextService';
import { services } from '@/services';
import router from '@/router';
import { usePostReactionsStore } from '@/stores/postReactions';
import { debug } from '@/utils/debug';
import { userStorage } from '@/utils/userScopedStorage';
import { userDataService } from '@/services/userDataService';
import { fetchedReactionsThisSession } from '@/composables/useRemotePostSync';
// InteractionService removed - using direct database operations
import type { 
  Post, 
  TimelinePost, 
  PostComposerState, 
  MonyFeed,
  FederatedUser,
  ConversationThread,
  ConversationContext,
  PostWithContext,
  PostContextOptions,
  MessagePart
} from '@/types';

// User List type for Mastodon-compatible Lists feature
export interface UserList {
  id: string;
  created_at: string;
  updated_at: string | null;
  user_id: string;
  title: string;
  description: string | null;
  replies_policy: 'followed' | 'list' | 'none';
  is_exclusive: boolean;
  is_public: boolean;
  is_local: boolean;
  federated_id: string | null;
  ap_id: string | null;
  // Computed/joined fields
  members_count?: number;
}

export interface UserListMember {
  id: string;
  created_at: string;
  list_id: string;
  account_id: string;
  // Joined profile data
  account?: {
    id: string;
    username: string;
    display_name: string | null;
    avatar_url: string | null;
    domain: string | null;
    is_local: boolean;
  };
}

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
  instanceDomain: string;
  instanceUserCount: number;
  instancePostCount: number;
  instanceStatsFetchedAt: number | null;
  federationApiUrl: string;
  
  // Timeline cache state
  hasEverLoadedTimeline: boolean;
  timelineCacheTimestamp: number | null;
  
  // Suggested follows cache
  suggestedUsers: any[];
  suggestedUsersFetchedAt: number | null;
  
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
  _broadcastUnsubs: Array<() => void>;

  // Post IDs that handleRealtimePostCreate is currently fetching via
  // loadPostWithAuthor(). Two concurrent realtime events (e.g. `post:new`
  // and `home_feed:new_post` both delivered to the author's user channel
  // when they create a post) race past the dedup-by-id check before either
  // call finishes its async fetch + unshift — the in-flight Set bridges
  // that window so the second handler call bails immediately.
  _inFlightPostIds: Set<string>;

  // Notification integration
  lastNotificationCheck: Date | null;
  unreadCount: number;
  
  // Mentions feed state
  mentionsFeed: MonyFeed;
  
  // Bookmarks state
  bookmarks: TimelinePost[];
  hasMoreBookmarks: boolean;
  bookmarksCursor: string | null;
  
  // Lists state
  lists: UserList[];
  hasMoreLists: boolean;
  listsCursor: string | null;
  listsLoaded: boolean;
  currentListMembers: Map<string, UserListMember[]>;
  
  // Cache flags for preventing duplicate queries
  followsLoaded: boolean;
  followCountsLoaded: boolean;
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
    instanceDomain: import.meta.env.VITE_DOMAIN || window.location.hostname,
    instanceUserCount: 0,
    instancePostCount: 0,
    instanceStatsFetchedAt: null,
    federationApiUrl: '/api/federation', // Default, can be overridden from instance_config
    
    // Timeline cache state
    hasEverLoadedTimeline: false,
    timelineCacheTimestamp: null,
    
    // Suggested follows cache
    suggestedUsers: [],
    suggestedUsersFetchedAt: null,
    
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
    _broadcastUnsubs: [] as Array<() => void>,
    _inFlightPostIds: new Set<string>(),

    // Notification integration
    lastNotificationCheck: null,
    unreadCount: 0,
    
    // Mentions feed state
    mentionsFeed: {
      posts: [],
      has_more: true,
      cursor: undefined
    },
    
    // Bookmarks state
    bookmarks: [],
    hasMoreBookmarks: true,
    bookmarksCursor: null,
    
    // Lists state
    lists: [],
    hasMoreLists: true,
    listsCursor: null,
    listsLoaded: false,
    currentListMembers: new Map(),
    
    // Cache flags for preventing duplicate queries
    followsLoaded: false,
    followCountsLoaded: false,
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
     * Check if instance stats cache is still valid (5 minutes)
     */
    isInstanceStatsCacheValid(): boolean {
      if (!this.instanceStatsFetchedAt) return false;
      const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
      return Date.now() - this.instanceStatsFetchedAt < CACHE_DURATION;
    },

    /**
     * Check if suggested users cache is still valid (10 minutes)
     */
    isSuggestedUsersCacheValid(): boolean {
      if (!this.suggestedUsersFetchedAt) return false;
      const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
      return Date.now() - this.suggestedUsersFetchedAt < CACHE_DURATION;
    },

    /**
     * Get suggested users filtered by followed status
     */
    filteredSuggestedUsers(): any[] {
      return this.suggestedUsers.filter(user => !this.followedUsers.has(user.id));
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
     * Load just the essential blocking/muting data
     * Can be called independently of full store initialization
     */
    async loadBlockingData() {
      debug.log('🚫 Loading blocking/muting data...');

      // BUGS.md Pattern A: the previous version passed the Supabase
      // auth.users UUID into queries that filter on
      // `user_blocks.blocker_id` / `user_mutes.muter_id`, which reference
      // `profiles(id)`. Those queries always returned 0 rows, so
      // `blockedUsers` / `mutedUsers` stayed empty and blocked content
      // kept showing. Resolve via `authContextService` (auth UUID →
      // profile UUID) before the load.
      const { useAuthStore } = await import('@/stores/auth');
      const authStore = useAuthStore();
      if (!authStore.session?.user?.id) {
        debug.log('ℹ️ No authenticated user, skipping blocking/muting data loading');
        return;
      }
      let profileId: string;
      try {
        const { authContextService } = await import('@/services/AuthContextService');
        profileId = await authContextService.getCurrentProfileId();
      } catch (err) {
        debug.warn('⚠️ Could not resolve profile id for blocking data load:', err);
        return;
      }

      // Reset Sets first so account switches don't leak the previous
      // user's relationships into the new user's load.
      this.blockedUsers.clear();
      this.mutedUsers.clear();

      await Promise.all([
        this.loadBlockedUsers(profileId),
        this.loadMutedUsers(profileId)
      ]);
      debug.log(`🚫 Blocking data loaded: ${this.blockedUsers.size} blocked, ${this.mutedUsers.size} muted`);
    },
    
    /**
     * Initialize the ActivityPub store. Idempotent: safe to call after
     * session restore, after manual refresh, or repeatedly during dev HMR.
     * Resolves profileId via authContextService, so does NOT depend on
     * userDataService being initialized.
     */
    async initialize() {
      try {
        let profileId: string;
        try {
          profileId = await authContextService.getCurrentProfileId();
        } catch {
          debug.warn('⚠️ ActivityPub initialize: no profile id (not authenticated)');
          return;
        }

        debug.log('🌐 Initializing ActivityPub store for profile', profileId);
        await this.loadBlockingData();
        await Promise.all([
          this.loadFollowCounts(true, profileId),
          this.loadFollowedUsers(true, profileId),
          this.setupRealtimeSubscriptions(profileId),
        ]);
        debug.log(`📊 Relationships loaded: ${this.followedUsers.size} following, ${this.blockedUsers.size} blocked, ${this.mutedUsers.size} muted`);
      } catch (error) {
        debug.error('❌ Failed to initialize ActivityPub store:', error);
        throw error;
      }
    },

    /**
     * Fetch instance stats (user count, post count) and config with caching
     */
    async fetchInstanceStats(force = false) {
      // Skip if cache is valid and not forcing
      if (this.isInstanceStatsCacheValid && !force) {
        debug.log('📊 Instance stats: using cached values');
        return;
      }

      try {
        debug.log('🔄 Fetching instance stats and config from database...');
        
        const [usersResult, postsResult, configResult] = await Promise.all([
          supabase
            .from('profiles')
            .select('*', { count: 'exact', head: true })
            .eq('is_local', true),
          supabase
            .from('posts')
            .select('*', { count: 'exact', head: true })
            .eq('is_local', true)
            .eq('is_deleted', false),
          supabase
            .from('instance_config')
            .select('config_key, config_value')
            .in('config_key', ['domain', 'federation_settings', 'federation_backend_url'])
        ]);
        
        this.instanceUserCount = usersResult.count || 0;
        this.instancePostCount = postsResult.count || 0;
        
        // Parse instance config
        if (configResult.data) {
          for (const config of configResult.data) {
            // Helper to safely parse config values (may be string JSON or already parsed object)
            const parseValue = (val: any) => {
              if (typeof val === 'string') {
                try {
                  return JSON.parse(val);
                } catch {
                  return val; // Return as-is if not valid JSON
                }
              }
              return val; // Already an object
            };
            
            if (config.config_key === 'domain') {
              const domain = parseValue(config.config_value);
              if (domain) this.instanceDomain = domain;
            }
            if (config.config_key === 'federation_backend_url') {
              const url = parseValue(config.config_value);
              if (url) this.federationApiUrl = url;
            }
            if (config.config_key === 'federation_settings') {
              const settings = parseValue(config.config_value);
              // Allow federation_backend_url to be in federation_settings too
              if (settings?.federation_backend_url) {
                this.federationApiUrl = settings.federation_backend_url;
              }
            }
          }
        }
        
        this.instanceStatsFetchedAt = Date.now();
        
        debug.log('✅ Instance stats cached:', {
          users: this.instanceUserCount,
          posts: this.instancePostCount,
          domain: this.instanceDomain,
          federationApiUrl: this.federationApiUrl
        });
      } catch (error) {
        debug.error('Failed to fetch instance stats:', error);
      }
    },

    /**
     * Fetch suggested users with caching (filters out already-followed users)
     */
    async fetchSuggestedUsers(force = false) {
      // Skip if cache is valid and not forcing
      if (this.isSuggestedUsersCacheValid && !force) {
        debug.log('👥 Suggested users: using cached values');
        return this.filteredSuggestedUsers;
      }

      try {
        debug.log('🔄 Fetching suggested users...');
        
        const { trendingService } = await import('@/services/TrendingService');
        const trendingUserResults = await trendingService.getTrendingUsers({ limit: 10 }); // Fetch more to account for filtering
        
        this.suggestedUsers = trendingUserResults.map(result => result.user);
        this.suggestedUsersFetchedAt = Date.now();
        
        debug.log(`✅ Cached ${this.suggestedUsers.length} suggested users`);
        return this.filteredSuggestedUsers;
      } catch (error) {
        debug.error('Failed to fetch suggested users:', error);
        return [];
      }
    },

    /**
     * Load timeline from localStorage cache (instant display)
     */
    loadTimelineFromCache() {
      try {
        const cached = userStorage.getItem('timeline-cache');
        if (!cached) return false;
        
        const { posts, timestamp, hasEverLoaded } = JSON.parse(cached);
        const CACHE_MAX_AGE = 30 * 60 * 1000; // 30 minutes
        
        if (Date.now() - timestamp > CACHE_MAX_AGE) {
          debug.log('📋 Timeline cache expired, will fetch fresh');
          this.hasEverLoadedTimeline = hasEverLoaded || false;
          return false;
        }
        
        if (posts && posts.length > 0) {
          this.homeFeed.posts = posts;
          this.hasEverLoadedTimeline = true;
          this.timelineCacheTimestamp = timestamp;
          debug.log(`📋 Loaded ${posts.length} posts from cache`);
          return true;
        }
        
        this.hasEverLoadedTimeline = hasEverLoaded || false;
        return false;
      } catch (error) {
        debug.warn('Failed to load timeline from cache:', error);
        return false;
      }
    },

    /**
     * Save timeline to localStorage cache (for instant loading next time)
     */
    saveTimelineToCache() {
      try {
        const postsToCache = this.homeFeed.posts.slice(0, 30); // Only cache first 30 posts
        
        // Strip heavy data to reduce storage size
        const lightPosts = postsToCache.map(post => ({
          ...post,
          // Remove any embedded blobs or heavy content
          author: post.author ? {
            id: post.author.id,
            username: post.author.username,
            display_name: post.author.display_name,
            avatar_url: post.author.avatar_url,
            domain: post.author.domain,
            is_local: post.author.is_local,
          } : null,
        }));
        
        const cacheData = {
          posts: lightPosts,
          timestamp: Date.now(),
          hasEverLoaded: true,
        };
        
        userStorage.setItem('timeline-cache', JSON.stringify(cacheData));
        this.hasEverLoadedTimeline = true;
        this.timelineCacheTimestamp = Date.now();
        debug.log(`💾 Cached ${lightPosts.length} timeline posts`);
      } catch (error) {
        debug.warn('Failed to save timeline to cache:', error);
      }
    },

    /**
     * Reset ALL per-user state on logout / account switch.
     *
     * BUGS.md Pattern B / #3 v2: previously `auth.logout()` only called
     * `clearTimelineCache()` (home feed) and a hand-rolled cast against
     * the store's private state. That:
     *   - missed `publicFeed` / `localFeed` / `mentionsFeed` / `userFeeds`,
     *   - missed the `followCountsLoaded` flag, the relationship counts,
     *     `conversations` / `conversationContexts`, `blockedInstances`,
     *     `suggestedUsers`, the `lists*` set, and `unreadCount`,
     *   - had a dead-code branch for `bookmarks` (the audit fixup
     *     assumed `{ posts: [] }` but the state shape is `TimelinePost[]`).
     *
     * Centralising the reset here gives us a typed, single source of
     * truth that `auth.logout()` can call without unsafe casts.
     */
    resetUserRelationshipState() {
      // Relationship sets + cache flags
      this.followedUsers.clear();
      this.blockedUsers.clear();
      this.mutedUsers.clear();
      this.blockedInstances.clear();
      this.followsLoaded = false;
      this.followCountsLoaded = false;
      this.followingCount = 0;
      this.followersCount = 0;

      // Feeds
      const resetFeed = (feed: typeof this.homeFeed) => {
        feed.posts = [];
        feed.has_more = true;
        feed.cursor = undefined;
      };
      resetFeed(this.homeFeed);
      resetFeed(this.publicFeed);
      resetFeed(this.localFeed);
      resetFeed(this.mentionsFeed);
      this.userFeeds.clear();

      // Bookmarks (note: `bookmarks` is `TimelinePost[]`, not `{ posts: [] }`)
      this.bookmarks = [];
      this.hasMoreBookmarks = true;
      this.bookmarksCursor = null;

      // Lists
      this.lists = [];
      this.hasMoreLists = true;
      this.listsCursor = null;
      this.listsLoaded = false;
      this.currentListMembers.clear();

      // DM / conversations
      this.conversations.clear();
      this.conversationContexts.clear();

      // Notification / discovery caches
      this.unreadCount = 0;
      this.lastNotificationCheck = null;
      this.suggestedUsers = [];
      this.suggestedUsersFetchedAt = null;
    },

    /**
     * Clear timeline cache (on logout, etc.)
     */
    clearTimelineCache() {
      try {
        userStorage.removeItem('timeline-cache');
        this.hasEverLoadedTimeline = false;
        this.timelineCacheTimestamp = null;
        // Also clear in-memory posts to prevent data leakage between users.
        // The feed state historically used `hasMore`/`isLoading`/`error`; the
        // store has since standardised on `has_more`/`loading`/`cursor`. Keep
        // the old setters too via `any` so we don't lose state from older
        // call sites.
        const feed = this.homeFeed as any;
        feed.posts = [];
        feed.hasMore = true;
        feed.has_more = true;
        feed.isLoading = false;
        feed.loading = false;
        feed.error = null;
        debug.log('🗑️ Timeline cache and posts cleared');
      } catch (error) {
        debug.warn('Failed to clear timeline cache:', error);
      }
    },

    /**
     * Load follow counts for the current user
     * OPTIMIZED: Only loads if not already loaded to prevent duplicate queries
     */
    async loadFollowCounts(force = false, profileIdOverride?: string) {
      if (this.followCountsLoaded && !force) return;

      try {
        const profileId = profileIdOverride
          ?? userDataService.getCurrentUser()?.id
          ?? await authContextService.getCurrentProfileId().catch(() => null);
        if (!profileId) {
          debug.warn('📊 loadFollowCounts: profile id not ready yet');
          return;
        }

        const [{ count: followingCount }, { count: followersCount }] = await Promise.all([
          supabase
            .from('follows')
            .select('*', { count: 'exact', head: true })
            .eq('follower_id', profileId)
            .eq('status', 'accepted'),
          supabase
            .from('follows')
            .select('*', { count: 'exact', head: true })
            .eq('following_id', profileId)
            .eq('status', 'accepted'),
        ]);

        this.followingCount = followingCount || 0;
        this.followersCount = followersCount || 0;
        this.followCountsLoaded = true;

        debug.log(`📊 Follow counts loaded: ${this.followingCount} following, ${this.followersCount} followers`);
      } catch (error) {
        debug.error('❌ Failed to load follow counts:', error);
      }
    },


    async setupRealtimeSubscriptions(profileIdOverride?: string) {
      const profileId = profileIdOverride
        ?? userDataService.getCurrentUser()?.id
        ?? await authContextService.getCurrentProfileId().catch(() => null);
      if (!profileId) {
        debug.warn('⚠️ setupRealtimeSubscriptions: no profile id — skipping');
        return;
      }

      const { userEventChannel } = await import('@/services/UserEventChannel');

      // Idempotent: if handlers are already registered, just reconnect the
      // channel (handles profile id change too).
      if (this._broadcastUnsubs.length > 0) {
        userEventChannel.connect(profileId);
        return;
      }

      userEventChannel.connect(profileId);

      const unsubs: Array<() => void> = [];

      unsubs.push(userEventChannel.on('post:new', (data) => {
        this.handleRealtimePostCreate({ id: data.post_id, author_id: data.author_id, visibility: data.visibility, ap_type: data.ap_type });
      }));

      // Home-timeline broadcast: fan-out from `broadcast_home_feed_entry`
      // on `timeline_entries` INSERT. Reuses the same handler as `post:new`
      // because the handler is already idempotent via dedup-by-id on the
      // four feeds. The author also receives this event (their own home
      // timeline_entry insert fires it), but the existing `post:new`
      // arrives first on their channel — the dedup check in
      // handleRealtimePostCreate makes the second arrival a no-op.
      unsubs.push(userEventChannel.on('home_feed:new_post', (data) => {
        this.handleRealtimePostCreate({
          id: data.post_id,
          author_id: data.author_id,
          visibility: data.visibility,
        });
      }));

      unsubs.push(userEventChannel.on('post:updated', (data) => {
        this.handleRealtimePostUpdate({ id: data.post_id, author_id: data.author_id, is_deleted: data.is_deleted, visibility: data.visibility });
      }));

      unsubs.push(userEventChannel.on('post:deleted', (data) => {
        this.handleRealtimePostDelete({ id: data.post_id });
      }));

      unsubs.push(userEventChannel.on('post:interaction', (data) => {
        if (data.op === 'INSERT') {
          this.handleRealtimeInteractionChange({ event: 'INSERT', new: { post_id: data.post_id, interaction_type: data.interaction_type, user_id: data.user_id, emoji_id: data.emoji_id } });
        } else if (data.op === 'DELETE') {
          this.handleRealtimeInteractionChange({ event: 'DELETE', old: { post_id: data.post_id, interaction_type: data.interaction_type, user_id: data.user_id, emoji_id: data.emoji_id } });
        }
      }));

      unsubs.push(userEventChannel.on('follow:change', (data) => {
        if (data.op === 'INSERT') {
          this.handleRealtimeFollowCreate(data);
        } else if (data.op === 'UPDATE') {
          this.handleRealtimeFollowUpdate(data);
        } else if (data.op === 'DELETE') {
          this.handleRealtimeFollowDelete(data);
        }
      }));

      unsubs.push(userEventChannel.on('mute:insert', (data) => {
        if (data.muted_user_id) {
          const updated = new Set(this.mutedUsers);
          updated.add(data.muted_user_id);
          this.mutedUsers = updated;
          debug.log('🔇 Mute synced via broadcast:', data.muted_user_id);
        }
      }));

      unsubs.push(userEventChannel.on('mute:delete', (data) => {
        if (data.muted_user_id) {
          const updated = new Set(this.mutedUsers);
          updated.delete(data.muted_user_id);
          this.mutedUsers = updated;
          debug.log('🔇 Unmute synced via broadcast:', data.muted_user_id);
        }
      }));

      unsubs.push(userEventChannel.on('block:insert', (data) => {
        if (data.blocked_user_id) {
          const updated = new Set(this.blockedUsers);
          updated.add(data.blocked_user_id);
          this.blockedUsers = updated;
          debug.log('🚫 Block synced via broadcast:', data.blocked_user_id);
        }
      }));

      unsubs.push(userEventChannel.on('block:delete', (data) => {
        if (data.blocked_user_id) {
          const updated = new Set(this.blockedUsers);
          updated.delete(data.blocked_user_id);
          this.blockedUsers = updated;
          debug.log('🚫 Unblock synced via broadcast:', data.blocked_user_id);
        }
      }));

      unsubs.push(userEventChannel.on('post:embeds_ready', (data) => {
        if (data.post_id) {
          this.handlePostEmbedsReady(data.post_id);
        }
      }));

      this._broadcastUnsubs = unsubs;
      debug.log('🔔 ActivityPub realtime established via user:{id} broadcast');
    },

    async handlePostEmbedsReady(postId: string) {
      try {
        const { data, error } = await supabase
          .from('posts')
          .select('metadata')
          .eq('id', postId)
          .single();
        if (error || !data) return;
        this.updatePostFieldInAllFeeds(postId, 'metadata', data.metadata);
      } catch (error) {
        debug.warn('handlePostEmbedsReady failed:', error);
      }
    },



    /**
     * Handle realtime post creation
     */
    async handleRealtimePostCreate(post: any) {
      debug.log('📝 New post received via realtime:', post);
      debug.log('📝 Realtime post details:', {
        id: post.id,
        author_id: post.author_id,
        is_local: post.is_local,
        visibility: post.visibility
      });

      if (!post?.id) {
        return;
      }

      // Two realtime events can race to handle the same post: `post:new`
      // (always fires on the author's channel) and `home_feed:new_post`
      // (fires on the author + every local follower). For the author the
      // checks below would run twice in parallel, both pass the
      // exists-in-feed dedup (because neither call has unshifted yet),
      // both await loadPostWithAuthor, and both unshift → two copies of
      // the same post in every feed. Reserve the id BEFORE the async
      // fetch so the second handler invocation bails immediately.
      if (this._inFlightPostIds.has(post.id)) {
        debug.log('⚠️ Post create already in-flight, skipping concurrent duplicate:', post.id);
        return;
      }
      this._inFlightPostIds.add(post.id);

      try {
        // Check if post already exists in any feed to prevent duplicates
        const existsInPublic = this.publicFeed.posts.some(p => p.id === post.id);
        const existsInLocal = this.localFeed.posts.some(p => p.id === post.id);
        const existsInHome = this.homeFeed.posts.some(p => p.id === post.id);

        if (existsInPublic || existsInLocal || existsInHome) {
          debug.log('⚠️ Post already exists in feeds, skipping duplicate:', post.id);
          return;
        }

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
          is_local: completePost.is_local,
          visibility: completePost.visibility
        });
        
        // Get current user ID for home feed logic
        const { userDataService } = await import('@/services/userDataService');
        const currentUser = userDataService.getCurrentUser();
        const isOwnPost = currentUser?.id === completePost.author_id;
        let addedToFeed = false;

        // Add to public feed if public
        if (completePost.visibility === 'public') {
          this.publicFeed.posts.unshift(completePost);
          addedToFeed = true;
          debug.log('✅ Added post to public feed:', completePost.id);
          // Limit feed size
          if (this.publicFeed.posts.length > 100) {
            this.publicFeed.posts = this.publicFeed.posts.slice(0, 100);
          }
        }

        // Add to local feed if local
        if (completePost.is_local && completePost.visibility === 'public') {
          this.localFeed.posts.unshift(completePost);
          addedToFeed = true;
          debug.log('✅ Added post to local feed:', completePost.id);
          if (this.localFeed.posts.length > 100) {
            this.localFeed.posts = this.localFeed.posts.slice(0, 100);
          }
        }

        // Add to home feed if:
        // 1. Following the author, OR
        // 2. It's the current user's own post (so they see their own posts in home)
        const shouldAddToHome = isOwnPost || this.followedUsers.has(completePost.author_id);
        debug.log('📝 Home feed check:', {
          isOwnPost,
          isFollowing: this.followedUsers.has(completePost.author_id),
          shouldAddToHome
        });

        if (shouldAddToHome) {
          this.homeFeed.posts.unshift(completePost);
          addedToFeed = true;
          // Only increment unread for posts from others
          if (!isOwnPost) {
            this.unreadCount++;
          }
          debug.log('✅ Added post to home feed:', completePost.id);
          if (this.homeFeed.posts.length > 100) {
            this.homeFeed.posts = this.homeFeed.posts.slice(0, 100);
          }
        }

        // Play sound when a new post from someone else is displayed via realtime
        if (addedToFeed && !isOwnPost) {
          this.playNewPostSound();
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
      } finally {
        this._inFlightPostIds.delete(post.id);
      }
    },

    /**
     * Handle realtime post updates (ignore count-only updates to prevent loops)
     */
    handleRealtimePostUpdate(post: any) {
      debug.log('📝 Post updated:', post);

      // Check for soft delete (is_deleted = true) - remove from feeds
      if (post.is_deleted) {
        debug.log('🗑️ Post soft-deleted, removing from feeds:', post.id);
        this.removePostFromAllFeeds(post.id);
        return;
      }

      // Visibility downgrade: a post that was public but is now private
      // (unlisted / followers / direct) must disappear from the public and
      // local timelines that viewers are currently subscribed to. We keep
      // it on the home feed because the author's followers may still be
      // entitled to see it.
      if (post.visibility && post.visibility !== 'public') {
        const beforePublic = this.publicFeed.posts.length;
        const beforeLocal = this.localFeed.posts.length;
        this.publicFeed.posts = this.publicFeed.posts.filter(p => p.id !== post.id);
        this.localFeed.posts = this.localFeed.posts.filter(p => p.id !== post.id);
        if (beforePublic !== this.publicFeed.posts.length || beforeLocal !== this.localFeed.posts.length) {
          debug.log(`👁️ Post ${post.id} visibility -> ${post.visibility}; pruned from public/local`);
        }
      }

      // Ignore updates that are likely just count changes from interaction
      // triggers. Skip when `updated_at` is missing (broadcast payload from
      // `broadcast_post_event` doesn't include it — those are real edits).
      if (post.updated_at) {
        const now = new Date();
        const updatedAt = new Date(post.updated_at);
        const timeDiff = now.getTime() - updatedAt.getTime();

        if (timeDiff < 3000) {
          debug.log('🚫 Ignoring likely count-only post update');
          return;
        }
      }

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
     * Play sound when a new post arrives via realtime (not on initial load)
     * Respects notification preferences: sound_notifications, activitypub_sound_notifications, DND
     */
    async playNewPostSound() {
      try {
        const { useNotificationStore } = await import('@/stores/useNotification');
        const { useThemeStore } = await import('@/stores/useTheme');
        const notificationStore = useNotificationStore();
        const themeStore = useThemeStore();

        if (!notificationStore.preferences?.sound_notifications || notificationStore.isQuietHours) return;
        if (!notificationStore.preferences.activitypub_sound_notifications) return;

        if (!themeStore.isInitialized) {
          await themeStore.initialize();
        }
        await themeStore.playAudio('ui_notification');
        debug.log('🔊 Played new post sound');
      } catch (err) {
        debug.warn('Failed to play new post sound:', err);
      }
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
        // Note: Notification is now created by DB trigger (handle_unified_notification_processing)
        // with complete follower profile data - no need for client-side notification creation
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

      // Check event type first
      debug.log('💫 Event type check:', payload.event, 'interaction data:', interaction);
      
      // For DELETE events, handle with available data
      if (payload.event === 'DELETE') {
        debug.log('💫 DELETE event detected - processing reaction removal');
        
        // payload.old should contain the deleted row data
        const deletedInteraction = payload.old;
        if (deletedInteraction?.post_id) {
          // Trigger a refresh of the post reactions from the server
          // This ensures the UI is updated with the correct state
          debug.log('💫 Refreshing reactions for post:', deletedInteraction.post_id);
          
          // Import and use the post reactions store to refresh
          import('@/stores/postReactions').then(({ usePostReactionsStore }) => {
            const postReactionsStore = usePostReactionsStore();
            postReactionsStore.handleRealtimeUpdate(payload);
          });
          
          // Also update counts if we have interaction type
          if (deletedInteraction.interaction_type && deletedInteraction.user_id) {
            this.updatePostInteractionFromRealtime(
              deletedInteraction.post_id,
              deletedInteraction.interaction_type,
              'DELETE',
              deletedInteraction.user_id
            );
          }
        }
        return;
      }

      // Validate required fields (for INSERT/UPDATE events)
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
      
      // Handle emoji_reaction type specially - trigger postReactions store update
      if (interaction.interaction_type === 'emoji_reaction') {
        import('@/stores/postReactions').then(({ usePostReactionsStore }) => {
          const postReactionsStore = usePostReactionsStore();
          postReactionsStore.handleRealtimeUpdate(payload);
        });
      }
      
      // Update both counts AND interaction state based on realtime events
      this.updatePostInteractionFromRealtime(
        interaction.post_id,
        interaction.interaction_type,
        eventType,
        interaction.user_id
      );
    },

    // Note: createFollowNotification was removed - notifications are now created
    // by the database trigger (handle_unified_notification_processing) with
    // complete follower profile data to avoid duplicate notifications

    /**
     * Collect every Post object reference for `postId` that's currently
     * loaded across the four primary feeds, the bookmarks list, and any
     * active user feeds.
     *
     * Replaces a pattern where each callsite ran `feed.posts.find(...)`
     * 4-N times PLUS a separate per-realtime-event DB roundtrip even when
     * the post wasn't currently visible (BUGS.md PC4). Callers now check
     * the returned list - if empty, the post isn't in any UI surface and
     * an expensive server resync can be skipped entirely.
     *
     * Why bookmarks are included (BUGS.md H2 from code review):
     * `loadBookmarks` populates `this.bookmarks` independently of the
     * timeline feeds, with separate Post object instances. Without
     * scanning it here, realtime favorite/reblog/reply count updates
     * would silently skip the bookmarks view, causing permanent UI
     * desync until the next bookmark refresh.
     */
    _findPostRefs(postId: string): any[] {
      const refs: any[] = [];
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed, this.mentionsFeed];
      for (const feed of feeds) {
        const post = feed.posts.find((p: any) => p.id === postId);
        if (post) refs.push(post);
      }
      // Bookmarks live in a separate top-level array, not inside a feed
      // object. They typically have distinct Post instances from the
      // timeline feeds (separate API call) so we cannot skip this scan
      // even when a feed match was found.
      if (Array.isArray(this.bookmarks)) {
        const bookmarkPost = this.bookmarks.find((p: any) => p.id === postId);
        if (bookmarkPost) refs.push(bookmarkPost);
      }
      // `userFeeds` is initialized to `new Map()` and is always present,
      // so no defensive type check is needed.
      for (const feed of this.userFeeds.values()) {
        const post = feed?.posts?.find((p: any) => p.id === postId);
        if (post) refs.push(post);
      }
      return refs;
    },

    /**
     * Update post interaction counts - now uses server sync for consistency
     */
    async updatePostInteractionCounts(postId: string, interactionType: string, eventType: string) {
      // Short-circuit: if the post isn't visible in any feed, skip the
      // DB roundtrip entirely - the realtime event isn't relevant to
      // anything the user is currently looking at, and the cached
      // counts on the (absent) post object can't be updated anyway.
      const refs = this._findPostRefs(postId);
      if (refs.length === 0) return;

      const { data: postCounts, error: countsError } = await supabase
        .from('posts')
        .select('favorites_count, reblogs_count, replies_count')
        .eq('id', postId)
        .single();

      if (countsError) {
        debug.error('❌ Failed to get server counts:', countsError);
        return;
      }

      for (const post of refs) {
        post.favorites_count = postCounts.favorites_count;
        post.reblogs_count = postCounts.reblogs_count;
        post.replies_count = postCounts.replies_count;
      }
      debug.log(`📊 Updated post ${postId} counts across ${refs.length} feed entries (${interactionType} ${eventType})`);

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

      // Short-circuit: if the post isn't in any visible feed (primary feeds
      // or user feeds), nothing to update - skip the DB roundtrip.
      const refs = this._findPostRefs(postId);
      if (refs.length === 0) {
        debug.log(`🔍 Realtime update skipped: post ${postId} not in any visible feed`);
        return;
      }

      // Use cached auth context
      const context = await authContextService.getCurrentContext();
      const isCurrentUser = context.isAuthenticated && context.authUser?.id === userId;

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

      debug.log(`📊 Realtime: Server counts for post ${postId} (${refs.length} feed refs):`, {
        favorites_count: postCounts.favorites_count,
        reblogs_count: postCounts.reblogs_count,
        replies_count: postCounts.replies_count,
        interaction_type: interactionType,
        event_type: eventType,
        is_current_user: isCurrentUser
      });

      // Pre-compute user-interaction patch once (was rebuilt for every feed).
      const userStateUpdates: Record<string, boolean> = {};
      if (isCurrentUser) {
        switch (interactionType) {
          case 'favorite':
          case 'emoji_reaction':
            userStateUpdates.is_favorited = eventType === 'INSERT';
            break;
          case 'reblog':
            userStateUpdates.is_reblogged = eventType === 'INSERT';
            break;
          case 'bookmark':
            userStateUpdates.is_bookmarked = eventType === 'INSERT';
            break;
        }
      }

      // Single pass: apply count + interaction-state updates to every
      // reference of the post that exists across primary feeds and user
      // feeds. Previously this was two separate iterations
      // (`feeds.forEach` + `userFeeds.forEach`) with duplicated update
      // logic in each.
      for (const post of refs) {
        post.favorites_count = postCounts.favorites_count;
        post.reblogs_count = postCounts.reblogs_count;
        post.replies_count = postCounts.replies_count;

        const postWithReblog = post as any;
        if (postWithReblog.reblog) {
          postWithReblog.reblog.favorites_count = postCounts.favorites_count;
          postWithReblog.reblog.reblogs_count = postCounts.reblogs_count;
          postWithReblog.reblog.replies_count = postCounts.replies_count;
          if (isCurrentUser) {
            Object.assign(postWithReblog.reblog, userStateUpdates);
          }
        }

        if (isCurrentUser) {
          Object.assign(post, userStateUpdates);
        }
      }

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
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed, this.mentionsFeed];
      
      feeds.forEach(feed => {
        const index = feed.posts.findIndex(p => p.id === post.id);
        if (index !== -1) {
          // Merge updates with existing post to preserve author and other joined data
          // Realtime events don't include joined relations like author
          const existingPost = feed.posts[index];
          feed.posts[index] = {
            ...existingPost,  // Keep existing data (especially author!)
            ...post,          // Apply updates
            author: post.author || existingPost.author,  // Explicitly preserve author
            reblog_author: post.reblog_author || existingPost.reblog_author,  // Preserve reblog author
          };
        }
      });
      
      // Update in user feeds
      this.userFeeds.forEach(feed => {
        const index = feed.posts.findIndex(p => p.id === post.id);
        if (index !== -1) {
          // Same merge logic for user feeds
          const existingPost = feed.posts[index];
          feed.posts[index] = {
            ...existingPost,
            ...post,
            author: post.author || existingPost.author,
            reblog_author: post.reblog_author || existingPost.reblog_author,
          };
        }
      });
    },

    /**
     * Update post interaction state across all feeds (UI state only, counts handled by realtime)
     */
    updatePostInteractionState(postId: string, interactionType: 'favorite' | 'reblog' | 'bookmark', state: boolean) {
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed, this.mentionsFeed];
      
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
     * Remove post from all feeds (used by realtime and delete)
     */
    removePostFromAllFeeds(postId: string) {
      debug.log('🗑️ Removing post from all feeds:', postId);
      
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed, this.mentionsFeed];
      
      feeds.forEach(feed => {
        feed.posts = feed.posts.filter(p => p.id !== postId);
      });
      
      // Remove from user feeds (properly update the map)
      this.userFeeds.forEach((feed, key) => {
        this.userFeeds.set(key, {
          ...feed,
          posts: feed.posts.filter(p => p.id !== postId)
        });
      });
      
      debug.log('✅ Post removed from all feeds:', postId);
    },

    /**
     * Clean up realtime subscriptions
     */
    cleanupRealtimeSubscriptions() {
      this.realtimeSubscriptions.forEach((channel, _key) => {
        supabase.removeChannel(channel);
      });
      this.realtimeSubscriptions.clear();

      for (const unsub of this._broadcastUnsubs) {
        unsub();
      }
      this._broadcastUnsubs = [];

      debug.log('🧹 Realtime subscriptions cleaned up');
    },

    /**
     * One batched profile fetch keeps DisplayName from firing N per-post
     * profile RPCs as the virtualizer mounts MonyPost rows. Supporter
     * badges are now embedded in the post.author payload from the
     * timeline query, so no badge prefetch is needed.
     */
    async ensureAuthorProfilesCached(posts: TimelinePost[]) {
      const authorIds = new Set<string>();
      for (const post of posts) {
        if (post.author_id) authorIds.add(post.author_id);
        if (post.author?.id) authorIds.add(post.author.id);
        if ((post as any).reblog_author_id) authorIds.add((post as any).reblog_author_id);
        if (post.reblog?.author_id) authorIds.add(post.reblog.author_id);
      }
      if (authorIds.size === 0) return;
      await userDataService.ensureUsersLoaded(Array.from(authorIds));
    },

    /**
     * PERFORMANCE: Batch fetch interactions for reblog original posts
     * This prevents N+1 queries when MonyPost renders reblogs
     */
    async batchFetchReblogInteractions(posts: TimelinePost[]) {
      try {
        // Get current user's profile ID
        const profileId = await authContextService.getCurrentProfileId();
        if (!profileId) return posts;

        // Find all posts that are reblogs and have original post data
        const reblogOriginalIds = posts
          .filter(p => p.reblog?.id)
          .map(p => p.reblog!.id);

        if (reblogOriginalIds.length === 0) return posts;

        // Remove duplicates
        const uniqueIds = [...new Set(reblogOriginalIds)];
        debug.log(`🔄 Batch loading interactions for ${uniqueIds.length} reblog original posts`);

        // Batch fetch interactions for all original posts
        const { data: interactions, error } = await supabase
          .from('post_interactions')
          .select('post_id, interaction_type')
          .eq('user_id', profileId)
          .in('post_id', uniqueIds)
          .in('interaction_type', ['favorite', 'reblog', 'bookmark']);

        if (error) {
          debug.error('Failed to batch fetch reblog interactions:', error);
          return posts;
        }

        // Create a map of post_id -> interaction types
        const interactionMap = new Map<string, Set<string>>();
        (interactions || []).forEach(i => {
          if (!interactionMap.has(i.post_id)) {
            interactionMap.set(i.post_id, new Set());
          }
          interactionMap.get(i.post_id)!.add(i.interaction_type);
        });

        // Attach interactions to reblog.is_favorited, etc.
        return posts.map(post => {
          if (post.reblog?.id) {
            const postInteractions = interactionMap.get(post.reblog.id) || new Set();
            return {
              ...post,
              reblog: {
                ...post.reblog,
                is_favorited: postInteractions.has('favorite') || postInteractions.has('emoji_reaction'),
                is_reblogged: postInteractions.has('reblog'),
                is_bookmarked: postInteractions.has('bookmark')
              }
            };
          }
          return post;
        });
      } catch (error) {
        debug.error('Failed to batch fetch reblog interactions:', error);
        return posts;
      }
    },

    async batchFetchRemoteReactions(posts: TimelinePost[]) {
      const localDomain = this.instanceDomain;

      const getTargetApId = (p: TimelinePost): string | undefined =>
        (p.ap_type === 'Announce' || p.reblog) ? (p.reblog?.ap_id || p.metadata?.original_ap_id || p.ap_id) : p.ap_id;

      const remotePosts = posts.filter(p => {
        if (fetchedReactionsThisSession.has(p.id)) return false;
        const targetApId = getTargetApId(p);
        if (!targetApId) return false;
        if (!p.reblog && p.is_local) return false;
        try {
          if (new URL(targetApId).hostname === localDomain) return false;
        } catch { /* invalid URL, include it */ }
        return true;
      });
      if (remotePosts.length === 0) return;

      // Map from target ap_id back to timeline post for result lookup
      const apIdToPost = new Map<string, TimelinePost>();

      try {
        const batchPayload = remotePosts.map(p => {
          const targetApId = getTargetApId(p)!;
          const targetPostId = (p.ap_type === 'Announce' || p.reblog)
            ? (p.reblog?.id || p.metadata?.reblog_of || p.id) : p.id;
          apIdToPost.set(targetApId, p);
          return { post_ap_id: targetApId, post_id: targetPostId };
        });

        const response = await fetch(`${this.federationApiUrl}/fetch-reactions-batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ posts: batchPayload }),
        });

        if (!response.ok) {
          debug.warn(
            `batchFetchRemoteReactions: ${response.status} from fetch-reactions-batch — per-post fallback allowed`
          );
          return;
        }

        // Only mark after a successful batch so a 503/unhealthy federation backend
        // does not permanently suppress MonyPost's per-post fetch-reactions path.
        for (const p of remotePosts) fetchedReactionsThisSession.add(p.id);

        const { results } = await response.json();
        if (!results) return;

        for (const [targetApId, post] of apIdToPost.entries()) {
          const result = results[targetApId];
          if (!result?.success) continue;

          if (result.remote_reactions) {
            this.updatePostMetadataInAllFeeds(post.id, {
              remote_reactions: result.remote_reactions,
              remote_reactions_fetched_at: new Date().toISOString(),
            });
          }
          if (result.favorites_count !== undefined) {
            if (post.reblog) {
              (post.reblog as any).favorites_count = result.favorites_count;
            } else {
              this.updatePostFieldInAllFeeds(post.id, 'favorites_count', result.favorites_count);
            }
          }
        }

        debug.log(`📬 Batch-fetched remote reactions for ${remotePosts.length} posts`);
      } catch (error) {
        debug.warn('Batch remote reactions fetch failed (non-blocking):', error);
      }
    },

    /**
     * Load the user's home timeline (with cache support)
     */
    async loadHomeFeed(before?: string) {
      if (this.isLoadingFeed) return
      if (!before) {
        const hasCachedPosts = this.loadTimelineFromCache();
        if (hasCachedPosts) {
          debug.log('📋 Showing cached timeline, fetching fresh in background...');
          void this.ensureAuthorProfilesCached(this.homeFeed.posts);
          void this.refreshHomeFeedInBackground();
          return;
        }
      }

      this.isLoadingFeed = true;
      try {
        const authUser = await authContextService.getCurrentAuthUser();

        const { posts, fullPage } = await activityPubService.getUserTimeline(
          authUser.id,
          'home',
          { limit: 20, before }
        );

        if (posts.length > 0) {
          const postReactionsStore = usePostReactionsStore();
          const postIds = posts.map((p) => p.id);
          await postReactionsStore.fetchMultiplePostReactions(postIds, true);
        }

        const processedPosts = await this.batchFetchReblogInteractions(posts);
        await Promise.all([
          this.ensureAuthorProfilesCached(processedPosts),
          this.batchFetchRemoteReactions(processedPosts),
        ]);

        if (before) {
          this.homeFeed.posts.push(...processedPosts);
        } else {
          this.homeFeed.posts = processedPosts;
          this.unreadCount = 0;
          this.saveTimelineToCache();
        }

        this.homeFeed.has_more = fullPage;
        this.homeFeed.cursor = posts[posts.length - 1]?.created_at;
        this.hasEverLoadedTimeline = true;
      } catch (error) {
        debug.error('Failed to load home feed:', error);
      } finally {
        this.isLoadingFeed = false;
      }
    },

    /**
     * Refresh home feed in background (after showing cached data)
     */
    async refreshHomeFeedInBackground() {
      try {
        const context = await authContextService.getCurrentContext();
        if (!context.isAuthenticated) return;

        const { posts, fullPage } = await activityPubService.getUserTimeline(
          context.authUser.id,
          'home',
          { limit: 20 }
        );

        if (posts.length > 0) {
          const postReactionsStore = usePostReactionsStore();
          await postReactionsStore.fetchMultiplePostReactions(posts.map((p) => p.id), true);
        }

        const processedPosts = await this.batchFetchReblogInteractions(posts);
        for (const p of processedPosts) {
          if (!p.is_local && p.ap_id) fetchedReactionsThisSession.delete(p.id);
        }
        await Promise.all([
          this.ensureAuthorProfilesCached(processedPosts),
          this.batchFetchRemoteReactions(processedPosts),
        ]);

        this.homeFeed.posts = processedPosts;
        this.homeFeed.has_more = fullPage;
        this.homeFeed.cursor = posts[posts.length - 1]?.created_at;
        this.unreadCount = 0;
        this.saveTimelineToCache();
        debug.log('✅ Background refresh complete');
      } catch (error) {
        debug.warn('Background refresh failed (cached data still shown):', error);
      }
    },

    /**
     * Load the public timeline
     */
    async loadPublicFeed(before?: string) {
      if (this.isLoadingFeed) return
      this.isLoadingFeed = true;
      try {
        const { posts, fullPage } = await activityPubService.getEnhancedPublicTimeline({
          limit: 20,
          before,
        });

        if (posts.length > 0) {
          const postReactionsStore = usePostReactionsStore();
          await postReactionsStore.fetchMultiplePostReactions(posts.map((p) => p.id), true);
        }

        const processedPosts = await this.batchFetchReblogInteractions(posts);
        await Promise.all([
          this.ensureAuthorProfilesCached(processedPosts),
          this.batchFetchRemoteReactions(processedPosts),
        ]);

        if (before) {
          this.publicFeed.posts.push(...processedPosts);
        } else {
          this.publicFeed.posts = processedPosts;
        }

        this.publicFeed.has_more = fullPage;
        this.publicFeed.cursor = posts[posts.length - 1]?.created_at;

        const localCount = posts.filter((p) => p.is_local).length;
        const federatedCount = posts.filter((p) => !p.is_local).length;
        debug.log(
          `🌐 Public feed updated: ${localCount} local + ${federatedCount} federated = ${posts.length} total posts`
        );
      } catch (error) {
        debug.error('Failed to load public feed:', error);
      } finally {
        this.isLoadingFeed = false;
      }
    },

    /**
     * Load the local timeline
     */
    async loadLocalFeed(before?: string) {
      if (this.isLoadingFeed) return
      this.isLoadingFeed = true;
      try {
        const authUser = await authContextService.getCurrentAuthUser();
        const { posts, fullPage } = await activityPubService.getUserTimeline(
          authUser.id,
          'local',
          { limit: 20, before }
        );

        if (posts.length > 0) {
          const postReactionsStore = usePostReactionsStore();
          await postReactionsStore.fetchMultiplePostReactions(posts.map((p) => p.id), true);
        }

        const processedPosts = await this.batchFetchReblogInteractions(posts);
        await Promise.all([
          this.ensureAuthorProfilesCached(processedPosts),
          this.batchFetchRemoteReactions(processedPosts),
        ]);

        if (before) {
          this.localFeed.posts.push(...processedPosts);
        } else {
          this.localFeed.posts = processedPosts;
        }

        this.localFeed.has_more = fullPage;
        this.localFeed.cursor = posts[posts.length - 1]?.created_at;
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
        
        // Don't add media to content when we have media_attachments - MonyMediaGallery
        // shows them with lightbox. Federated posts often have media in content only
        // (no media_attachments), so they render via MonyContent's grid.
        
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
     * Update an existing post (edit). Uses the ActivityPub Update activity type.
     */
    async updatePost(postId: string, postData: {
      content: string | MessagePart[];
      content_warning?: string;
      is_sensitive?: boolean;
      media_attachments?: any[];
    }): Promise<TimelinePost> {
      this.isPosting = true;
      try {
        let finalContent: MessagePart[];
        if (Array.isArray(postData.content)) {
          finalContent = postData.content;
        } else if (typeof postData.content === 'string') {
          finalContent = await this.formatPostContent(postData.content);
        } else {
          throw new Error('Invalid content format - must be MessagePart[] or string');
        }

        const mediaUrls = postData.media_attachments?.length
          ? await this.uploadMediaAttachments(postData.media_attachments)
          : undefined;

        // `media_attachments` is not on the typed UpdatePostData but the
        // service accepts the field at runtime; cast to bypass the strict shape.
        const updatedPost = await services.posts.updatePost(postId, {
          content: finalContent,
          content_warning: postData.content_warning,
          is_sensitive: postData.is_sensitive,
          media_attachments: mediaUrls,
        } as any);

        this.updatePostInAllFeeds(updatedPost);

        return updatedPost;
      } catch (error) {
        debug.error('Failed to update post:', error);
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

      // If it has a stored File reference, use it directly (most reliable)
      if (attachment.file instanceof File) {
        return attachment.file;
      }

      // Fallback: if it has a blob URL, fetch and convert to File
      if (attachment.url && attachment.url.startsWith('blob:')) {
        const response = await fetch(attachment.url);
        const blob = await response.blob();
        const fileName = attachment.filename || `file.${blob.type.split('/')[1] || 'bin'}`;
        let mimeType = blob.type;
        if (!mimeType && attachment.type) {
          if (attachment.type === 'image') mimeType = 'image/jpeg';
          else if (attachment.type === 'video') mimeType = 'video/mp4';
          else if (attachment.type === 'audio') mimeType = 'audio/mpeg';
        }
        return new File([blob], fileName, { type: mimeType || 'application/octet-stream' });
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
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed, this.mentionsFeed];
      
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
         mediaAttachments: [],
         quotePost: undefined,
         quoteAuthor: undefined
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
     * Mute a user - hides their content without blocking
     */
    async muteUser(userId: string, options?: { hideNotifications?: boolean; duration?: number }) {
      try {
        debug.log('🔇 Muting user:', userId, options);
        
        // Use InteractionService for the database operation
        const result = await services.interactions.toggleMute(userId);
        
        if (result.muting) {
          // Create a new Set to trigger Vue reactivity (Set mutations don't trigger reactivity)
          const newMutedUsers = new Set(this.mutedUsers);
          newMutedUsers.add(userId);
          this.mutedUsers = newMutedUsers;
          debug.log('✅ User muted successfully:', userId, 'Total muted:', this.mutedUsers.size);
        }
        
        return { muted: result.muting };
      } catch (error) {
        debug.error('❌ Failed to mute user:', error);
        throw error;
      }
    },

    /**
     * Unmute a user
     */
    async unmuteUser(userId: string) {
      try {
        debug.log('🔊 Unmuting user:', userId);
        
        // Use InteractionService for the database operation
        const result = await services.interactions.toggleMute(userId);
        
        if (!result.muting) {
          // Create a new Set to trigger Vue reactivity (Set mutations don't trigger reactivity)
          const newMutedUsers = new Set(this.mutedUsers);
          newMutedUsers.delete(userId);
          this.mutedUsers = newMutedUsers;
          debug.log('✅ User unmuted successfully:', userId, 'Total muted:', this.mutedUsers.size);
        }
        
        return { muted: result.muting };
      } catch (error) {
        debug.error('❌ Failed to unmute user:', error);
        throw error;
      }
    },

    /**
     * Block a user - prevents all interactions
     */
    async blockUser(userId: string, options?: { reason?: string; blockType?: 'full' | 'posts_only' | 'interactions_only' }) {
      try {
        debug.log('🚫 Blocking user:', userId, options);
        
        // Use InteractionService for the database operation
        const result = await services.interactions.toggleBlock(userId);
        
        if (result.blocking) {
          // Create a new Set to trigger Vue reactivity (Set mutations don't trigger reactivity)
          const newBlockedUsers = new Set(this.blockedUsers);
          newBlockedUsers.add(userId);
          this.blockedUsers = newBlockedUsers;
          
          // Also unfollow if following (blocking implies unfollowing)
          if (this.followedUsers.has(userId)) {
            try {
              await this.unfollowUser(userId);
            } catch (unfollowError) {
              debug.warn('⚠️ Could not unfollow blocked user:', unfollowError);
            }
          }
          
          debug.log('✅ User blocked successfully:', userId, 'Total blocked:', this.blockedUsers.size);
        }
        
        return { blocked: result.blocking };
      } catch (error) {
        debug.error('❌ Failed to block user:', error);
        throw error;
      }
    },

    /**
     * Unblock a user
     */
    async unblockUser(userId: string) {
      try {
        debug.log('🔓 Unblocking user:', userId);
        
        // Use InteractionService for the database operation  
        const result = await services.interactions.toggleBlock(userId);
        
        if (!result.blocking) {
          // Create a new Set to trigger Vue reactivity (Set mutations don't trigger reactivity)
          const newBlockedUsers = new Set(this.blockedUsers);
          newBlockedUsers.delete(userId);
          this.blockedUsers = newBlockedUsers;
          debug.log('✅ User unblocked successfully:', userId, 'Total blocked:', this.blockedUsers.size);
        }
        
        return { blocked: result.blocking };
      } catch (error) {
        debug.error('❌ Failed to unblock user:', error);
        throw error;
      }
    },

    /**
     * Toggle post favorite (like) with optimistic UI updates
     */
    async toggleFavorite(postId: string) {
      debug.log(`🔍 DEBUG: toggleFavorite called for post ${postId}`);
      
      try {
        // Use cached auth context
        const authUser = await authContextService.getCurrentAuthUser();

        debug.log(`🔍 DEBUG: User authenticated: ${authUser.id}`);

        // Check current state first
        const { data: existing, error: existingError } = await supabase
          .from('post_interactions')
          .select('id')
          .eq('user_id', authUser.id)
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
    updatePostInteractionInAllFeeds(postId: string, interactionType: 'favorite' | 'reblog' | 'bookmark' | 'pin', isActive: boolean) {
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed, this.mentionsFeed];
      
      feeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          switch (interactionType) {
            case 'favorite':
              post.is_favorited = isActive;
              break;
            case 'reblog':
              post.is_reblogged = isActive;
              break;
            case 'bookmark':
              post.is_bookmarked = isActive;
              break;
            case 'pin':
              post.is_pinned = isActive;
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
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed, this.mentionsFeed];
      
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
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed, this.mentionsFeed];
      
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
     * Update post metadata in all feeds (for remote reactions, etc.)
     */
    updatePostMetadataInAllFeeds(postId: string, metadataUpdate: Record<string, any>) {
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed, this.mentionsFeed];
      
      feeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          post.metadata = { ...(post.metadata || {}), ...metadataUpdate };
          debug.log(`🔄 Updated post ${postId} metadata in feed`);
        }
      });

      // Update in user feeds too
      this.userFeeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          post.metadata = { ...(post.metadata || {}), ...metadataUpdate };
        }
      });
    },

    updatePostFieldInAllFeeds(postId: string, field: string, value: any) {
      const feeds = [this.homeFeed, this.publicFeed, this.localFeed, this.mentionsFeed];
      feeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          (post as any)[field] = value;
        }
      });
      this.userFeeds.forEach(feed => {
        const post = feed.posts.find(p => p.id === postId);
        if (post) {
          (post as any)[field] = value;
        }
      });
    },

    updatePostContentInAllFeeds(postId: string, content: any) {
      this.updatePostFieldInAllFeeds(postId, 'content', content);
    },

    /**
     * Toggle post bookmark - delegates to activityPubService which handles auth properly
     */
    async toggleBookmark(postId: string) {
      try {
        // Use the service which properly uses AuthContextService and profile_id
        const result = await activityPubService.toggleBookmark(postId);
        debug.log(`📍 Toggled bookmark for post ${postId}: -> ${result.bookmarked} (realtime will update UI)`);
      } catch (error) {
        debug.error('Failed to toggle bookmark:', error);
        throw error;
      }
    },

    /**
     * Get bookmarked posts (excludes deleted posts, includes interaction states)
     */
    async getBookmarks(options: { limit?: number; cursor?: string | null } = {}) {
      try {
        const { userDataService } = await import('@/services/userDataService');
        const currentUser = userDataService.getCurrentUser();
        if (!currentUser?.id) throw new Error('User not authenticated');

        const profileId = currentUser.id;
        const limit = options.limit || 20;
        
        // First, get bookmark interactions
        let query = supabase
          .from('post_interactions')
          .select(`
            created_at,
            post_id
          `)
          .eq('user_id', profileId)
          .eq('interaction_type', 'bookmark')
          .order('created_at', { ascending: false })
          .limit(limit * 2); // Fetch more to account for deleted posts

        if (options.cursor) {
          query = query.lt('created_at', options.cursor);
        }

        const { data: bookmarkData, error: bookmarkError } = await query;
        if (bookmarkError) throw bookmarkError;

        if (!bookmarkData || bookmarkData.length === 0) {
          return { posts: [], cursor: null, hasMore: false };
        }

        const postIds = bookmarkData.map(item => item.post_id);

        // Fetch posts, filtering out deleted ones
        const { data: postsData, error: postsError } = await supabase
          .from('posts')
          .select(`
            *,
            author:profiles(*)
          `)
          .in('id', postIds)
          .eq('is_deleted', false)
          .order('created_at', { ascending: false });

        if (postsError) throw postsError;

        // Fetch user's interactions with these posts
        const { data: userInteractions, error: interactionsError } = await supabase
          .from('post_interactions')
          .select('post_id, interaction_type')
          .eq('user_id', profileId)
          .in('post_id', postIds)
          .in('interaction_type', ['favorite', 'reblog', 'bookmark']);

        if (interactionsError) {
          debug.error('Failed to fetch user interactions:', interactionsError);
        }

        // Create a map of interactions per post
        const interactionMap = new Map<string, Set<string>>();
        (userInteractions || []).forEach(interaction => {
          if (!interactionMap.has(interaction.post_id)) {
            interactionMap.set(interaction.post_id, new Set());
          }
          interactionMap.get(interaction.post_id)!.add(interaction.interaction_type);
        });

        // Map posts to maintain bookmark order and add interaction states
        const postsMap = new Map((postsData || []).map(p => [p.id, p]));
        const orderedPosts = bookmarkData
          .map(item => {
            const post = postsMap.get(item.post_id);
            if (!post) return null;
            
            // Add interaction states
            const interactions = interactionMap.get(post.id) || new Set();
            return {
              ...post,
              is_favorited: interactions.has('favorite') || interactions.has('emoji_reaction'),
              is_reblogged: interactions.has('reblog'),
              is_bookmarked: interactions.has('bookmark') // Should always be true for bookmarks
            };
          })
          .filter(Boolean)
          .slice(0, limit);
        
        // Find the cursor from the last included bookmark
        const lastIncludedIndex = bookmarkData.findIndex(
          item => item.post_id === orderedPosts[orderedPosts.length - 1]?.id
        );
        const cursor = lastIncludedIndex >= 0 ? bookmarkData[lastIncludedIndex].created_at : null;
        
        return {
          posts: orderedPosts,
          cursor,
          hasMore: orderedPosts.length === limit && bookmarkData.length > lastIncludedIndex + 1
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
        // Use AuthContextService for proper profile_id resolution
        const profileId = await authContextService.getCurrentProfileId();

        const { error } = await supabase
          .from('post_interactions')
          .delete()
          .eq('user_id', profileId)
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

    // =============================================
    // LISTS MANAGEMENT (Mastodon-compatible)
    // =============================================

    /**
     * Load all user lists
     */
    async loadLists(force = false) {
      // Skip if already loaded unless forced
      if (this.listsLoaded && !force) {
        debug.log('📋 Lists already loaded, skipping');
        return;
      }

      try {
        const profileId = await authContextService.getCurrentProfileId();

        const { data, error } = await supabase
          .from('user_lists')
          .select(`
            *,
            members:user_list_members(count)
          `)
          .eq('user_id', profileId)
          .order('created_at', { ascending: false });

        if (error) throw error;

        // Transform to add members_count
        this.lists = (data || []).map(list => ({
          ...list,
          members_count: list.members?.[0]?.count || 0
        }));
        this.listsLoaded = true;
        this.hasMoreLists = false; // Lists don't typically paginate

        debug.log(`📋 Loaded ${this.lists.length} lists`);
      } catch (error) {
        debug.error('Failed to load lists:', error);
        throw error;
      }
    },

    /**
     * Load more lists (for pagination if needed)
     */
    async loadMoreLists() {
      // Lists don't typically need pagination, but included for API completeness
      debug.log('📋 loadMoreLists called - lists are fully loaded');
      return;
    },

    /**
     * Create a new list
     */
    async createList(data: {
      title: string;
      description?: string;
      replies_policy?: 'followed' | 'list' | 'none';
      is_exclusive?: boolean;
      is_public?: boolean;
    }): Promise<UserList> {
      try {
        const profileId = await authContextService.getCurrentProfileId();

        const { data: newList, error } = await supabase
          .from('user_lists')
          .insert({
            user_id: profileId,
            title: data.title,
            description: data.description || null,
            replies_policy: data.replies_policy || 'list',
            is_exclusive: data.is_exclusive || false,
            is_public: data.is_public || false
          })
          .select()
          .single();

        if (error) throw error;

        // Add to local state
        const listWithCount: UserList = { ...newList, members_count: 0 };
        this.lists.unshift(listWithCount);

        debug.log('✅ List created:', newList.title);
        return listWithCount;
      } catch (error) {
        debug.error('Failed to create list:', error);
        throw error;
      }
    },

    /**
     * Update a list
     */
    async updateList(listId: string, updates: {
      title?: string;
      description?: string;
      replies_policy?: 'followed' | 'list' | 'none';
      is_exclusive?: boolean;
      is_public?: boolean;
    }): Promise<UserList> {
      try {
        const profileId = await authContextService.getCurrentProfileId();

        const { data: updatedList, error } = await supabase
          .from('user_lists')
          .update({
            ...updates,
            updated_at: new Date().toISOString()
          })
          .eq('id', listId)
          .eq('user_id', profileId)
          .select()
          .single();

        if (error) throw error;

        // Update local state
        const index = this.lists.findIndex(l => l.id === listId);
        if (index !== -1) {
          this.lists[index] = { ...this.lists[index], ...updatedList };
        }

        debug.log('✅ List updated:', updatedList.title);
        // Return the updated list from local state if found, otherwise return server response
        return index !== -1 ? this.lists[index] : updatedList;
      } catch (error) {
        debug.error('Failed to update list:', error);
        throw error;
      }
    },

    /**
     * Delete a list
     */
    async deleteList(listId: string): Promise<void> {
      try {
        const profileId = await authContextService.getCurrentProfileId();

        const { error } = await supabase
          .from('user_lists')
          .delete()
          .eq('id', listId)
          .eq('user_id', profileId);

        if (error) throw error;

        // Remove from local state
        this.lists = this.lists.filter(l => l.id !== listId);
        this.currentListMembers.delete(listId);

        debug.log('✅ List deleted:', listId);
      } catch (error) {
        debug.error('Failed to delete list:', error);
        throw error;
      }
    },

    /**
     * Get list by ID
     */
    async getList(listId: string): Promise<UserList | null> {
      // Check local cache first
      const cached = this.lists.find(l => l.id === listId);
      if (cached) return cached;

      try {
        const { data, error } = await supabase
          .from('user_lists')
          .select(`
            *,
            members:user_list_members(count)
          `)
          .eq('id', listId)
          .single();

        if (error) {
          if (error.code === 'PGRST116') return null;
          throw error;
        }

        return {
          ...data,
          members_count: data.members?.[0]?.count || 0
        };
      } catch (error) {
        debug.error('Failed to get list:', error);
        return null;
      }
    },

    /**
     * Load members of a list
     */
    async loadListMembers(listId: string): Promise<UserListMember[]> {
      try {
        const { data, error } = await supabase
          .from('user_list_members')
          .select(`
            *,
            account:profiles(id, username, display_name, avatar_url, domain, is_local)
          `)
          .eq('list_id', listId)
          .order('created_at', { ascending: false });

        if (error) throw error;

        const members = data || [];
        this.currentListMembers.set(listId, members);

        debug.log(`📋 Loaded ${members.length} members for list ${listId}`);
        return members;
      } catch (error) {
        debug.error('Failed to load list members:', error);
        throw error;
      }
    },

    /**
     * Add a user to a list
     */
    async addToList(listId: string, accountId: string): Promise<UserListMember> {
      try {
        // First verify the user is followed
        const isFollowing = this.followedUsers.has(accountId);
        if (!isFollowing) {
          throw new Error('You can only add followed users to lists');
        }

        const { data, error } = await supabase
          .from('user_list_members')
          .insert({
            list_id: listId,
            account_id: accountId
          })
          .select(`
            *,
            account:profiles(id, username, display_name, avatar_url, domain, is_local)
          `)
          .single();

        if (error) throw error;

        // Update local state
        const members = this.currentListMembers.get(listId) || [];
        members.unshift(data);
        this.currentListMembers.set(listId, members);

        // Update members count
        const list = this.lists.find(l => l.id === listId);
        if (list) {
          list.members_count = (list.members_count || 0) + 1;
        }

        debug.log(`✅ Added user ${accountId} to list ${listId}`);
        return data;
      } catch (error) {
        debug.error('Failed to add user to list:', error);
        throw error;
      }
    },

    /**
     * Remove a user from a list
     */
    async removeFromList(listId: string, accountId: string): Promise<void> {
      try {
        const { error } = await supabase
          .from('user_list_members')
          .delete()
          .eq('list_id', listId)
          .eq('account_id', accountId);

        if (error) throw error;

        // Update local state
        const members = this.currentListMembers.get(listId) || [];
        this.currentListMembers.set(
          listId,
          members.filter(m => m.account_id !== accountId)
        );

        // Update members count
        const list = this.lists.find(l => l.id === listId);
        if (list && list.members_count) {
          list.members_count--;
        }

        debug.log(`✅ Removed user ${accountId} from list ${listId}`);
      } catch (error) {
        debug.error('Failed to remove user from list:', error);
        throw error;
      }
    },

    /**
     * Get timeline for a specific list
     */
    async getListTimeline(listId: string, options: { limit?: number; before?: string } = {}): Promise<TimelinePost[]> {
      try {
        const limit = options.limit || 20;

        // First get list members
        let members = this.currentListMembers.get(listId);
        if (!members) {
          members = await this.loadListMembers(listId);
        }

        if (!members || members.length === 0) {
          return [];
        }

        const memberIds = members.map(m => m.account_id);

        // Query posts from list members
        let query = supabase
          .from('posts')
          .select(`
            *,
            author:profiles(id, username, display_name, avatar_url, domain, is_local, bio)
          `)
          .in('author_id', memberIds)
          .eq('is_deleted', false)
          .in('visibility', ['public', 'unlisted'])
          .order('created_at', { ascending: false })
          .limit(limit);

        if (options.before) {
          query = query.lt('created_at', options.before);
        }

        const { data, error } = await query;

        if (error) throw error;

        debug.log(`📋 Loaded ${data?.length || 0} posts for list timeline`);
        return data || [];
      } catch (error) {
        debug.error('Failed to get list timeline:', error);
        throw error;
      }
    },

    /**
     * Toggle post reblog - creates actual reblog posts for timeline display
     */
    async toggleReblog(postId: string) {
      try {
        const { userDataService } = await import('@/services/userDataService');
        const currentUser = userDataService.getCurrentUser();
        if (!currentUser?.id) throw new Error('User not authenticated');

        const profileId = currentUser.id;

        // Check if we already have a reblog interaction for this post
        const { data: existingInteraction, error: interactionError } = await supabase
          .from('post_interactions')
          .select('id')
          .eq('user_id', profileId)
          .eq('post_id', postId)
          .eq('interaction_type', 'reblog')
          .maybeSingle();

        if (interactionError && interactionError.code !== 'PGRST116') {
          throw interactionError;
        }

        const isReblogged = !!existingInteraction;

        if (existingInteraction) {
          // Remove reblog interaction and reblog post
          const { data: reblogPost } = await supabase
            .from('posts')
            .select('id')
            .eq('author_id', profileId)
            .eq('metadata->>reblog_of', postId)
            .maybeSingle();

          if (reblogPost) {
            await activityPubService.unreblogPost(reblogPost.id);
            // Remove ONLY the reblog post from our feeds, NOT the original
            this.removePostFromAllFeeds(reblogPost.id);
          }

          // Remove the interaction record
          await supabase
            .from('post_interactions')
            .delete()
            .eq('id', existingInteraction.id);

          // Update UI immediately - don't wait for realtime
          this.updatePostInteractionState(postId, 'reblog', false);

          // Federation is handled automatically by database triggers
        } else {
          // Use service method for reblog (which creates both interaction and reblog post)
          // eslint-disable-next-line unused-imports/no-unused-vars
          const result = await activityPubService.toggleReblog(postId);
          
          // Update UI immediately
          this.updatePostInteractionState(postId, 'reblog', true);

          // Federation is handled automatically by database triggers
        }

        debug.log(`📍 Toggled reblog for post ${postId}: ${isReblogged} -> ${!isReblogged}`);

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
        // Get profile ID directly from userDataService - no extra DB query needed!
        const { userDataService } = await import('@/services/userDataService');
        const currentUser = userDataService.getCurrentUser();
        
        if (!currentUser?.id) {
          throw new Error('User not authenticated or profile not loaded');
        }

        const profileId = currentUser.id;

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
          .eq('author_id', profileId)
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
          .eq('author_id', profileId);

        if (deleteError) throw deleteError;

        // Federation is handled automatically by database triggers

        // Remove from local feeds
        this.removePostFromAllFeeds(postId);

      } catch (error) {
        debug.error('Failed to delete post:', error);
        throw error;
      }
    },
    
    /**
     * Remove reblog from feeds (when un-reblogging)
     */
    removeReblogFromFeeds(originalPostId: string, rebloggerId: string) {
      debug.log('🗑️ Removing reblog from feeds:', { originalPostId, rebloggerId });
      
      const filterReblog = (posts: TimelinePost[]) => 
        posts.filter(p => !(p.reblog?.id === originalPostId && p.author_id === rebloggerId));
      
      this.homeFeed.posts = filterReblog(this.homeFeed.posts);
      this.publicFeed.posts = filterReblog(this.publicFeed.posts);
      this.localFeed.posts = filterReblog(this.localFeed.posts);
    },

         /**
      * Load users that the current user follows
      * OPTIMIZED: Only loads if not already loaded to prevent duplicate queries
      */
     async loadFollowedUsers(force = false, profileIdOverride?: string) {
       // Skip if already loaded unless forced
       if (this.followsLoaded && !force) {
         debug.log('📋 Followed users already loaded, skipping');
         return;
       }

       try {
         debug.log('🔄 Loading followed users via InteractionService');

        const profileId = profileIdOverride
          ?? userDataService.getCurrentUser()?.id
          ?? await authContextService.getCurrentProfileId().catch(() => null);
        if (!profileId) {
          debug.log('ℹ️ No profile id yet, skipping followed users loading');
          return;
        }

        debug.log('🔄 Current user PROFILE ID for loading followed users:', profileId);

        const result = await services.interactions.getFollowing(profileId);
         debug.log('🔄 Service result:', result);
         
         // Result returns { following, hasMore, total } not { users }
         const followingList = result?.following || [];
         this.followedUsers = new Set(followingList.map((user: any) => user.id));
         this.followsLoaded = true;
         
         debug.log(`✅ Loaded ${this.followedUsers.size} followed users via service layer`);
       } catch (error) {
         debug.error('❌ Failed to load followed users via service:', error);
         
         // Fallback to direct query if service fails
         try {
           debug.log('🔄 Trying fallback method...');
           await this._loadFollowedUsersFallback();
           this.followsLoaded = true;
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
      const profileId = userDataService.getCurrentUser()?.id
        ?? await authContextService.getCurrentProfileId().catch(() => null);
      if (!profileId) return;

      const { data, error } = await supabase
        .from('follows')
        .select('following_id')
        .eq('follower_id', profileId)
        .eq('status', 'accepted');

      if (error) throw error;
      
      // Add all followed users (both local and federated)
      this.followedUsers = new Set(data.map(f => f.following_id));
    },

    /**
     * Load blocked users into local cache for efficient lookups
     * Called on store initialization to avoid N+1 queries
     */
    async loadBlockedUsers(userId: string) {
      try {
        debug.log('🔄 Loading blocked users for:', userId);
        
        // Explicitly filter by blocker_id to get only users WE have blocked
        const { data, error } = await supabase
          .from('user_blocks')
          .select('blocked_user_id')
          .eq('blocker_id', userId);

        if (error) {
          debug.error('❌ Failed to load blocked users:', error);
          return;
        }
        
        debug.log('📊 Raw blocked users data from DB:', data);
        
        // Create a new Set to trigger Vue reactivity (Set mutations don't trigger reactivity)
        const newBlockedUsers = new Set<string>();
        (data || []).forEach(b => newBlockedUsers.add(b.blocked_user_id));
        this.blockedUsers = newBlockedUsers;
        debug.log(`✅ Loaded ${this.blockedUsers.size} blocked users:`, Array.from(this.blockedUsers));
      } catch (error) {
        debug.error('❌ Failed to load blocked users:', error);
      }
    },

    /**
     * Load muted users into local cache for efficient lookups
     * Called on store initialization to avoid N+1 queries
     */
    async loadMutedUsers(userId: string) {
      try {
        debug.log('🔄 Loading muted users for:', userId);
        
        // Explicitly filter by muter_id to get only users WE have muted
        const { data, error } = await supabase
          .from('user_mutes')
          .select('muted_user_id')
          .eq('muter_id', userId);

        if (error) {
          debug.error('❌ Failed to load muted users:', error);
          return;
        }
        
        debug.log('📊 Raw muted users data from DB:', data);
        
        // Create a new Set to trigger Vue reactivity (Set mutations don't trigger reactivity)
        const newMutedUsers = new Set<string>();
        (data || []).forEach(m => newMutedUsers.add(m.muted_user_id));
        this.mutedUsers = newMutedUsers;
        debug.log(`✅ Loaded ${this.mutedUsers.size} muted users:`, Array.from(this.mutedUsers));
      } catch (error) {
        debug.error('❌ Failed to load muted users:', error);
      }
    },

    /**
     * Check if a user is blocked (uses local cache - O(1) lookup)
     */
    isUserBlocked(userId: string): boolean {
      return this.blockedUsers.has(userId);
    },

    /**
     * Check if a user is muted (uses local cache - O(1) lookup)
     */
    isUserMuted(userId: string): boolean {
      return this.mutedUsers.has(userId);
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
        // Use AuthContextService for proper profile_id resolution
        const profileId = await authContextService.getCurrentProfileId();

        const { data, error } = await supabase
          .from('notifications')
          .select('*')
          .eq('user_id', profileId)
          .order('created_at', { ascending: false })
          .limit(20);

        if (error) throw error;

        debug.log('🔔 Notifications loaded:', data);
        // `notifications` is not on the strict store state typing - the store
        // exposes `loadNotifications()` instead. Stash via `any` so legacy
        // call sites continue to read this field directly.
        (this as any).notifications = data;
      } catch (error) {
        debug.error('Failed to load notifications:', error);
        throw error;
      }
     },

     /**
      * Load posts where the current user is mentioned.
      * Uses activitypub_mention notifications to find post IDs, then fetches full posts.
      */
     async loadMentionedPosts(before?: string) {
       if (this.isLoadingFeed) return;
       this.isLoadingFeed = true;

       try {
         const profileId = await authContextService.getCurrentProfileId();
         const limit = 20;

         let notifQuery = supabase
           .from('notifications')
           .select('data, created_at')
           .eq('user_id', profileId)
           .eq('type', 'activitypub_mention')
           .order('created_at', { ascending: false })
           .limit(limit);

         if (before) {
           notifQuery = notifQuery.lt('created_at', before);
         }

         const { data: notifs, error: notifError } = await notifQuery;
         if (notifError) throw notifError;

         const postIds = (notifs || [])
           .map(n => n.data?.post_id || n.data?.post?.id)
           .filter((id): id is string => !!id);

         const uniquePostIds = [...new Set(postIds)];

         if (uniquePostIds.length === 0) {
           if (!before) {
             this.mentionsFeed.posts = [];
           }
           this.mentionsFeed.has_more = false;
           return;
         }

         const { data: posts, error: postsError } = await supabase
           .from('posts')
           .select(`
             *,
             author:profiles!posts_author_id_fkey(
               id, username, display_name, avatar_url, color, domain, is_local, is_suspended
             ),
             my_interactions:post_interactions!left(interaction_type, emoji_id)
           `)
           .in('id', uniquePostIds)
           .eq('my_interactions.user_id', profileId)
           .or('is_deleted.is.null,is_deleted.eq.false')
           .order('created_at', { ascending: false });

         if (postsError) throw postsError;

         const processedPosts = (posts || [])
           .filter(post => !post.author?.is_suspended)
           .map(post => {
             const interactions = post.my_interactions || [];
             return {
               ...post,
               is_bookmarked: interactions.some((i: any) => i.interaction_type === 'bookmark'),
               is_favorited: interactions.some((i: any) => i.interaction_type === 'favorite' || i.interaction_type === 'emoji_reaction'),
               is_reblogged: interactions.some((i: any) => i.interaction_type === 'reblog'),
             };
           });

         if (posts && posts.length > 0) {
           const postReactionsStore = usePostReactionsStore();
           await postReactionsStore.fetchMultiplePostReactions(processedPosts.map(p => p.id), true);
         }

         this.ensureAuthorProfilesCached(processedPosts);

         if (before) {
           this.mentionsFeed.posts.push(...processedPosts);
         } else {
           this.mentionsFeed.posts = processedPosts;
         }

         this.mentionsFeed.has_more = (notifs || []).length >= limit;
         this.mentionsFeed.cursor = notifs?.[notifs.length - 1]?.created_at;
       } catch (error) {
         debug.error('Failed to load mentioned posts:', error);
       } finally {
         this.isLoadingFeed = false;
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

         // `activityPubService.getConversationThread` returns a slightly
         // different shape (`PostWithContext`) than `ConversationThread`; cast
         // through `any` until the call sites converge on one type.
         const thread = await activityPubService.getConversationThread(conversationId) as any as ConversationThread | null;
         if (thread) this.conversations.set(conversationId, thread);

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
         debug.log(`🧭 Attempting to navigate to PostDetail route`);
         router.push({
           name: 'PostDetail',
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
