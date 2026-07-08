// ActivityPub Service - Database operations for posts, interactions, and follows
// Triggers handle federation automatically - no client-side federation needed
import { supabase } from '@/supabase';
import { apiUrl } from '@/services/instanceConfig';
import { trendingService } from './TrendingService';

const POST_AUTHOR_EMBED = `
  author:profiles!posts_author_id_fkey(
    id, username, display_name, avatar_url, color, domain, is_local, is_suspended,
    supporter_membership:instance_supporters(
      is_active,
      tier:instance_supporter_tiers(name, badge_icon, badge_color)
    )
  )
`;
import type { 
  Post, 
  Follow, 
  PostInteraction, 
  FederatedUser, 
  TimelineOptions,
  TimelinePost,
  TimelineResult,
  ActivityPubActivityType,
  ActivityPubObjectType,
  ConversationContext,
  PostContextOptions,
  PostWithContext
} from '@/types';
import { debug } from '@/utils/debug'

/**
 * Core ActivityPub service for database operations
 * Handles posts, follows, and interactions - federation is automatic via triggers
 */
// Cache entry interface for profile caching
interface ProfileCacheEntry {
  profile: FederatedUser;
  timestamp: number;
}

// In-flight request tracking to prevent duplicate concurrent requests
interface InFlightRequest {
  promise: Promise<FederatedUser | null>;
}

export class ActivityPubService {
  private static instance: ActivityPubService;
  private currentDomain: string;
  private instanceUrl: string;
  
  // Profile cache with TTL to prevent repeated lookups
  private profileCache: Map<string, ProfileCacheEntry> = new Map();
  private inFlightRequests: Map<string, InFlightRequest> = new Map();
  private readonly PROFILE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.currentDomain = import.meta.env.VITE_DOMAIN as string;
    this.instanceUrl = `https://${this.currentDomain}`;
  }

  static getInstance(): ActivityPubService {
    if (!ActivityPubService.instance) {
      ActivityPubService.instance = new ActivityPubService();
    }
    return ActivityPubService.instance;
  }
  
  /**
   * Get cached profile or null if not cached/expired
   */
  private getCachedProfile(cacheKey: string): FederatedUser | null {
    const entry = this.profileCache.get(cacheKey);
    if (!entry) return null;
    
    const now = Date.now();
    if (now - entry.timestamp > this.PROFILE_CACHE_TTL) {
      this.profileCache.delete(cacheKey);
      return null;
    }
    
    return entry.profile;
  }
  
  /**
   * Cache a profile
   */
  private cacheProfile(cacheKey: string, profile: FederatedUser): void {
    this.profileCache.set(cacheKey, {
      profile,
      timestamp: Date.now()
    });
  }
  
  /**
   * Clear profile cache (useful for force refresh)
   */
  clearProfileCache(cacheKey?: string): void {
    if (cacheKey) {
      this.profileCache.delete(cacheKey);
    } else {
      this.profileCache.clear();
    }
  }

  // POST MANAGEMENT

  // NOTE: createPost is now handled by CorePostService/PostService
  // This dead code was removed - use services.posts.createPost() instead

  /**
   * Get timeline posts
   */
  async getTimeline(
    timelineType: 'home' | 'public' | 'local' = 'home',
    options: TimelineOptions = {}
  ): Promise<TimelinePost[]> {
    // timeline_entries.user_id FKs to profiles(id)
    const userId = await this.getCurrentProfileId();

    const limit = options.limit || 20;

    let query = supabase
      .from('timeline_entries')
      .select(`
        posts (
          *,
          ${POST_AUTHOR_EMBED}
        )
      `)
      .eq('user_id', userId)
      .eq('timeline_type', timelineType)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (options.before) {
      query = query.lt('created_at', options.before);
    }

    const { data, error } = await query;
    if (error) throw error;

    return (data?.map((entry: any) => entry.posts).filter(Boolean) || []) as unknown as TimelinePost[];
  }

  /**
   * Get public timeline - clean and professional
   */
  async getPublicTimeline(options: TimelineOptions = {}): Promise<TimelinePost[]> {
    // post_interactions.user_id FKs to profiles(id)
    const userId = await this.getCurrentProfileId();

    const limit = options.limit || 20;

    // Direct query with user interactions
    let query = supabase
      .from('posts')
      .select(`
        *,
        ${POST_AUTHOR_EMBED},
        my_interactions:post_interactions!left(interaction_type, emoji_id)
      `)
      .eq('my_interactions.user_id', userId)
      .in('visibility', ['public', 'unlisted'])
      .or('is_deleted.is.null,is_deleted.eq.false')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (options.before) {
      query = query.lt('created_at', options.before);
    }

    const { data, error } = await query;

    if (error) throw error;

    const posts = (data || [])
      .filter((post: any) => !post.author?.is_suspended) // Exclude posts from suspended users
      .map((post: any) => {
        const interactions = post.my_interactions || [];
        return {
          ...post,
          is_bookmarked: interactions.some((i: any) => i.interaction_type === 'bookmark'),
          is_favorited: interactions.some((i: any) => i.interaction_type === 'favorite' || i.interaction_type === 'emoji_reaction'),
          is_reblogged: interactions.some((i: any) => i.interaction_type === 'reblog'),
        };
      });

    debug.log(`Public timeline loaded: ${posts.length} posts (with user interactions)`);
    
    return posts;
  }

  /**
   * Get public timeline with enhanced federation support and user interaction states
   */
  async getEnhancedPublicTimeline(options: TimelineOptions = {}): Promise<TimelineResult> {
    // post_interactions.user_id FKs to profiles(id)
    const userId = await this.getCurrentProfileId();

    const limit = options.limit || 20;
    
    try {
      // Direct query with user interactions
      let query = supabase
        .from('posts')
        .select(`
          *,
          ${POST_AUTHOR_EMBED},
          my_interactions:post_interactions!left(interaction_type, emoji_id)
        `)
        .eq('my_interactions.user_id', userId)
        .in('visibility', ['public', 'unlisted'])
        .or('is_deleted.is.null,is_deleted.eq.false')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (options.before) {
        query = query.lt('created_at', options.before);
      }

      const { data, error } = await query;

      if (error) throw error;

      const posts = (data || [])
        .filter((post: any) => !post.author?.is_suspended)
        .map((post: any) => {
          const interactions = post.my_interactions || [];
          return {
            ...post,
            is_bookmarked: interactions.some((i: any) => i.interaction_type === 'bookmark'),
            is_favorited: interactions.some((i: any) => i.interaction_type === 'favorite' || i.interaction_type === 'emoji_reaction'),
            is_reblogged: interactions.some((i: any) => i.interaction_type === 'reblog'),
          };
        });
      
      const localCount = posts.filter((p: any) => p.is_local).length;
      const federatedCount = posts.filter((p: any) => !p.is_local).length;
      debug.log(`Enhanced public timeline: ${localCount} local + ${federatedCount} federated = ${posts.length} total posts`);
      
      const rawCount = (data || []).length;
      return { posts: posts as TimelinePost[], fullPage: rawCount >= limit };
    } catch (error) {
      debug.error('Failed to load enhanced public timeline:', error);
      return { posts: [], fullPage: false };
    }
  }

  /**
   * Get federated timeline - ALL public posts from remote instances the server knows about
   * This includes posts from searched users, not just followed users
   * Uses RPC for proper server-side filtering of deleted posts and suspended users
   */
  async getFederatedTimeline(options: TimelineOptions = {}): Promise<TimelinePost[]> {
    // RPC compares p_user_id against post_interactions.user_id (profiles FK)
    const profileId = await this.getCurrentProfileId();

    const limit = options.limit || 20;

    try {
      // Use RPC for proper server-side filtering (is_deleted, suspended users, etc.)
      const { data, error } = await supabase.rpc('get_federated_timeline', {
        p_user_id: profileId,
        p_limit: limit,
        p_max_id: options.max_id || null
      });

      if (error) throw error;

      debug.log(`Federated timeline loaded: ${(data || []).length} posts from remote instances`);
      return (data || []) as TimelinePost[];
    } catch (error) {
      debug.error('Failed to load federated timeline:', error);
      return [];
    }
  }

  /**
   * Get local timeline - ALL public posts from local users on this instance
   * Uses RPC for proper server-side filtering
   */
  async getLocalTimeline(options: TimelineOptions = {}): Promise<TimelinePost[]> {
    // RPC compares p_user_id against timeline_entries/post_interactions (profiles FK)
    const profileId = await this.getCurrentProfileId();

    const limit = options.limit || 20;

    debug.log('Loading local timeline via RPC');

    try {
      // Use existing RPC that properly handles local timeline
      const { data, error } = await supabase.rpc('get_enhanced_timeline_posts', {
        p_user_id: profileId,
        p_timeline_type: 'local',
        p_limit: limit,
        p_max_id: options.max_id || null
      });

      if (error) throw error;

      // Filter out suspended users (TODO: add to RPC)
      const posts = (data || []).filter((post: any) => {
        const author = post.author;
        return !author?.is_suspended;
      });
    
      // DEBUG: Verify all posts are truly local
      const localCount = posts.filter((p: any) => p.is_local).length || 0;
      const federatedCount = posts.filter((p: any) => !p.is_local).length || 0;
      debug.log(`Local timeline loaded: ${posts.length} posts total (${localCount} local, ${federatedCount} federated) with user interactions`);
      
      if (federatedCount > 0) {
        debug.warn(`WARNING: Local timeline contains ${federatedCount} federated posts! These should be filtered out.`);
        const federatedPosts = data?.filter((p: any) => !p.is_local) || [];
        federatedPosts.forEach((post: any) => {
          debug.warn(`Federated post in local timeline:`, {
            id: post.id,
            author: post.author?.username,
            domain: post.author?.domain,
            is_local: post.is_local
          });
        });
      }
      
      return posts as TimelinePost[];
    } catch (error) {
      debug.error('Failed to load local timeline:', error);
      return [];
    }
  }

  // POST CONTEXT METHODS (NEW ARCHITECTURE)

  /**
   * Get post with configurable context - main method that replaces separate post/thread methods
   * Supports all context scenarios: minimal, full thread, ancestors only, descendants only
   */
  async getPostWithContext(
    postId: string, 
    options: PostContextOptions = {}
  ): Promise<PostWithContext> {
    // RPC computes is_favorited/is_reblogged/is_bookmarked against
    // post_interactions.user_id (profiles FK) - must be the PROFILE id.
    const profileId = await this.getCurrentProfileId();

    const {
      context = 'minimal',
      highlightReply,
      maxDepth = 10,
      includeInteractions = true
    } = options;

    try {
      debug.log(`Loading post with context: ${postId} (${context})`);
      
      const { data, error } = await supabase.rpc('get_post_with_context', {
        p_context_type: context,
        p_highlight_reply: highlightReply,
        p_include_interactions: includeInteractions,
        p_max_depth: maxDepth,
        p_post_id: postId,
        p_user_id: profileId
      });

      if (error) {
        debug.error('Failed to get post with context:', error);
        throw error;
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      debug.log(`Post with context loaded: ${data.ancestors?.length || 0} ancestors, ${data.descendants?.length || 0} descendants`);
      
      return {
        mainPost: data.mainPost,
        ancestors: data.ancestors || [],
        descendants: data.descendants || [],
        threadInfo: data.threadInfo || {
          totalPosts: 1,
          participantCount: 1,
          depth: 0,
          rootPostId: postId,
          lastActivity: data.mainPost?.created_at || new Date().toISOString()
        },
        highlightedPost: highlightReply,
        contextType: context
      };
    } catch (error) {
      debug.error('Failed to get post with context:', error);
      throw error;
    }
  }

  /**
   * Get post in minimal context (just the post itself) - convenience method
   */
  async getPost(postId: string, includeInteractions: boolean = true): Promise<TimelinePost> {
    const result = await this.getPostWithContext(postId, {
      context: 'minimal',
      includeInteractions
    });
    return result.mainPost;
  }

  /**
   * Get full conversation thread - convenience method
   */
  async getConversationThread(postId: string): Promise<PostWithContext> {
    return this.getPostWithContext(postId, {
      context: 'thread',
      includeInteractions: true
    });
  }

  /**
   * Get conversation context (ancestors + descendants) - convenience method for compatibility
   */
  async getConversationContext(postId: string): Promise<ConversationContext> {
    const result = await this.getPostWithContext(postId, {
      context: 'thread',
      includeInteractions: true
    });
    
    return {
      ancestors: result.ancestors,
      descendants: result.descendants
    };
  }

  /**
   * Get replies to a specific post
   */
  async getPostReplies(postId: string, options: TimelineOptions = {}): Promise<TimelinePost[]> {
    // Use cached auth context
    const user = await this.getCurrentAuthUser();
    if (!user) throw new Error('User not authenticated');

    const limit = options.limit || 20;

    try {
      // Direct query for replies - posts where in_reply_to matches the postId
      let query = supabase
        .from('posts')
        .select(`
          *,
          ${POST_AUTHOR_EMBED},
          reply_context:reply_context
        `)
        .eq('in_reply_to', postId)
        .or('is_deleted.is.null,is_deleted.eq.false')
        .order('created_at', { ascending: true })
        .limit(limit);

      // Pagination using max_id
      if (options.max_id) {
        const { data: cursorPost } = await supabase
          .from('posts')
          .select('created_at')
          .eq('id', options.max_id)
          .single();
        
        if (cursorPost) {
          query = query.gt('created_at', cursorPost.created_at);
        }
      }

      const { data, error } = await query;

      if (error) throw error;
      
      // Transform replies to TimelinePost format
      const replies = (data || []).map(post => this.transformDatabasePostToTimelinePost(post));
      
      return replies;
    } catch (error) {
      debug.error('Failed to get post replies:', error);
      return [];
    }
  }

  // EXPLORE AND DISCOVERY METHODS

  /**
   * Get trending hashtags
   */
  async getTrendingHashtags(limit: number = 20): Promise<any[]> {
    return await trendingService.getTrendingHashtags({ limit });
  }

  /**
   * Get trending posts
   */
  async getTrendingPosts(options: {
    limit?: number;
    timeframe?: 'hourly' | 'daily' | 'weekly';
    includeLocal?: boolean;
    includeFederated?: boolean;
  } = {}): Promise<any[]> {
    return await trendingService.getTrendingPosts(options);
  }

  /**
   * Get suggested users to follow
   */
  async getSuggestedUsers(limit: number = 10): Promise<any[]> {
    return await trendingService.getTrendingUsers({ limit });
  }

  /**
   * Get federated instances for discovery
   */
  async getDiscoverableInstances(options: {
    limit?: number;
    filter?: 'all' | 'active' | 'trusted';
    search?: string;
  } = {}): Promise<any[]> {
    return await trendingService.getFederatedInstances(options);
  }

  async getFederatedInstanceByDomain(domain: string) {
    return trendingService.getFederatedInstanceByDomain(domain);
  }

  /**
   * Get posts by hashtag
   */
  async getPostsByHashtag(
    hashtag: string, 
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ posts: TimelinePost[]; hasMore: boolean; cursor: string | null }> {
    return await trendingService.getPostsByHashtag(hashtag, options);
  }

  /**
   * Get comprehensive explore content
   */
  async getExploreContent(filters: {
    contentType?: 'all' | 'posts' | 'media' | 'users';
    timeRange?: '1h' | '6h' | '24h' | '7d' | '30d';
    instance?: string;
    language?: string;
  } = {}): Promise<{
    posts: TimelinePost[];
    hashtags: any[];
    users: any[];
    instances: any[];
  }> {
    return await trendingService.getExploreContent(filters);
  }

  /**
   * Search content across the fediverse
   */
  async searchContent(
    query: string, 
    type: 'posts' | 'users' | 'hashtags' = 'posts',
    options: { limit?: number; cursor?: string } = {}
  ): Promise<any[]> {
    const { limit = 20 } = options;

    switch (type) {
      case 'posts':
        return await this.searchPosts(query, limit);
      case 'users':
        return await this.searchUsers(query, limit);
      case 'hashtags':
        return await trendingService.searchHashtags(query, limit);
      default:
        return [];
    }
  }

  /**
   * Search posts by content
   */
  async searchPosts(query: string, limit: number = 20): Promise<TimelinePost[]> {
    try {
      // Simple text search in post content
      const { data, error } = await supabase
        .from('posts')
        .select(`
          *,
          ${POST_AUTHOR_EMBED}
        `)
        .textSearch('content', query)
        .eq('visibility', 'public')
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      
      return (data || []).filter(post => !post.author?.is_suspended) as TimelinePost[];
    } catch (error) {
      debug.error('Failed to search posts:', error);
      return [];
    }
  }

  /**
   * Get instance statistics
   */
  async getInstanceStats(domain: string): Promise<any | null> {
    return await trendingService.getInstanceStats(domain);
  }

  /**
   * Probe instance health via the federation backend proxy.
   * Returns 'online' if nodeinfo fetch succeeds, 'offline' otherwise.
   */
  async probeInstanceHealth(domain: string): Promise<'online' | 'offline'> {
    try {
      const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
      const res = await fetch(apiUrl(`/api/federation/instances/health?domain=${encodeURIComponent(cleanDomain)}`), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return 'offline';
      const data = await res.json();
      return data.status === 'online' ? 'online' : 'offline';
    } catch {
      return 'offline';
    }
  }

  /**
   * Get recent activity from an instance
   */
  async getInstanceActivity(
    domain: string, 
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ posts: TimelinePost[]; hasMore: boolean; cursor: string | null }> {
    try {
      const { limit = 20, cursor } = options;

      // First, get profile IDs from users of this domain
      const { data: profiles, error: profileError } = await supabase
        .from('profiles')
        .select('id')
        .eq('domain', domain)
        .limit(100);

      if (profileError) throw profileError;
      
      if (!profiles || profiles.length === 0) {
        return { posts: [], hasMore: false, cursor: null };
      }

      const profileIds = profiles.map(p => p.id);

      // Now query posts from those profiles
      let query = supabase
        .from('posts')
        .select(`
          *,
          ${POST_AUTHOR_EMBED}
        `)
        .in('author_id', profileIds)
        .eq('visibility', 'public')
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .limit(limit + 1);

      if (cursor) {
        query = query.lt('created_at', cursor);
      }

      const { data, error } = await query;
      if (error) throw error;

      const posts = (data || []).slice(0, limit) as TimelinePost[];
      const hasMore = (data || []).length > limit;
      const nextCursor = hasMore && data && data.length > 1 ? data[data.length - 2].created_at : null;

      return { posts, hasMore, cursor: nextCursor };
    } catch (error) {
      debug.error('Failed to get instance activity:', error);
      return { posts: [], hasMore: false, cursor: null };
    }
  }

  /**
   * Update trending scores (maintenance method)
   */
  async updateTrendingScores(): Promise<void> {
    await trendingService.updateTrendingScores();
  }

  /**
   * Get user's posts
   */
  async getUserPosts(userId: string, options: TimelineOptions = {}): Promise<Post[]> {
    const limit = options.limit || 20;
    // post_interactions.user_id FKs to profiles(id)
    const currentProfileId = await this.getCurrentProfileId().catch(() => null);

    const selectClause = currentProfileId
      ? `*, ${POST_AUTHOR_EMBED}, my_interactions:post_interactions!left(interaction_type)`
      : `*, ${POST_AUTHOR_EMBED}`;

    let query = supabase
      .from('posts')
      .select(selectClause)
      .eq('author_id', userId)
      .eq('is_deleted', false)
      .in('visibility', ['public', 'unlisted'])
      .order('created_at', { ascending: false })
      .limit(limit);

    if (currentProfileId) {
      query = query.eq('my_interactions.user_id', currentProfileId);
    }
    if (options.before) {
      query = query.lt('created_at', options.before);
    }

    const { data, error } = await query;
    if (error) throw error;

    const posts = (data || []).map((post: any) => {
      const interactions = post.my_interactions || [];
      return {
        ...post,
        is_favorited: interactions.some((i: any) => i.interaction_type === 'favorite' || i.interaction_type === 'emoji_reaction'),
        is_reblogged: interactions.some((i: any) => i.interaction_type === 'reblog'),
        is_bookmarked: interactions.some((i: any) => i.interaction_type === 'bookmark'),
      };
    });

    return posts as Post[];
  }

  /**
   * Delete a post
   */
  async deletePost(postId: string): Promise<void> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const { data: originalPost, error: fetchError } = await supabase
      .from('posts')
      .select(`
        *,
        author:profiles(username, domain, is_local)
      `)
      .eq('id', postId)
      .eq('author_id', user.id)
      .single();

    if (fetchError || !originalPost) {
      throw new Error('Post not found or not owned by user');
    }

    // Soft delete the post
    const { error } = await supabase
      .from('posts')
      .update({
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        content: [{ type: 'text', text: '[Deleted]' }]
      })
      .eq('id', postId);

    if (error) throw error;

    // Federation is handled automatically by database triggers
  }

  // FOLLOW MANAGEMENT

  /**
   * Follow a user
   */
  async followUser(targetUserId: string): Promise<Follow> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    if (user.id === targetUserId) {
      throw new Error('Cannot follow yourself');
    }

    const ap_id = `${this.instanceUrl}/activities/${crypto.randomUUID()}`;
    
    const follow = {
      follower_id: user.id,
      following_id: targetUserId,
      ap_id: ap_id,
      status: 'accepted', // Auto-accept for now, can be changed for locked accounts
      is_local: true, // Database triggers will determine the correct value
      metadata: {}
    };

    const { data, error } = await supabase
      .from('follows')
      .insert(follow)
      .select(`
        *,
        follower:profiles!follows_follower_id_fkey (
          id, username, display_name, domain, avatar_url, is_local
        ),
        following:profiles!follows_following_id_fkey (
          id, username, display_name, domain, avatar_url, is_local
        )
      `)
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new Error('Already following this user');
      }
      throw error;
    }

    // Federation is handled automatically by database triggers

    return data as Follow;
  }

  /**
   * Unfollow a user
   */
  async unfollowUser(targetUserId: string): Promise<void> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const { error } = await supabase
      .from('follows')
      .delete()
      .eq('follower_id', user.id)
      .eq('following_id', targetUserId);

    if (error) throw error;

    // Federation is handled automatically by database triggers
  }

  /**
   * Get user's followers
   */
  async getFollowers(userId: string, options: TimelineOptions = {}): Promise<FederatedUser[]> {
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    
    const { data, error } = await supabase
      .from('follows')
      .select(`
        follower:profiles!follows_follower_id_fkey (
          id, username, display_name, domain, avatar_url, is_local, bio,
          followers_count, following_count, posts_count, created_at, updated_at
        )
      `)
      .eq('following_id', userId)
      .eq('status', 'accepted')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    return (data
      ?.filter((follow: any) => follow.follower)
      .map((follow: any) => ({
        ...follow.follower,
        handle: this.formatUserHandle(follow.follower.username, follow.follower.domain)
      })) || []) as unknown as FederatedUser[];
  }

  /**
   * Get pending follow requests for a user (manual approval mode)
   */
  async getFollowRequests(userId: string, options: TimelineOptions = {}): Promise<FederatedUser[]> {
    const limit = options.limit || 20;
    const offset = options.offset || 0;

    const { data, error } = await supabase
      .from('follows')
      .select(`
        follower:profiles!follows_follower_id_fkey (
          id, username, display_name, domain, avatar_url, is_local, bio,
          followers_count, following_count, posts_count, created_at, updated_at
        )
      `)
      .eq('following_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    return (data
      ?.filter((follow: any) => follow.follower)
      .map((follow: any) => ({
        ...follow.follower,
        handle: this.formatUserHandle(follow.follower.username, follow.follower.domain)
      })) || []) as unknown as FederatedUser[];
  }

  /**
   * Get count of pending follow requests for a user
   */
  async getFollowRequestsCount(userId: string): Promise<number> {
    const { count, error } = await supabase
      .from('follows')
      .select('id', { count: 'exact', head: true })
      .eq('following_id', userId)
      .eq('status', 'pending');

    if (error) throw error;
    return count || 0;
  }

  /**
   * Get users that a user is following
   */
  async getFollowing(userId: string, options: TimelineOptions = {}): Promise<FederatedUser[]> {
    const limit = options.limit || 20;
    const offset = options.offset || 0;
    
    const { data, error } = await supabase
      .from('follows')
      .select(`
        following:profiles!follows_following_id_fkey (
          id, username, display_name, domain, avatar_url, is_local, bio,
          followers_count, following_count, posts_count, created_at, updated_at
        )
      `)
      .eq('follower_id', userId)
      .eq('status', 'accepted')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    return (data
      ?.filter((follow: any) => follow.following)
      .map((follow: any) => ({
        ...follow.following,
        handle: this.formatUserHandle(follow.following.username, follow.following.domain)
      })) || []) as unknown as FederatedUser[];
  }

  /**
   * Check if user is following another user
   */
  async isFollowing(targetUserId: string): Promise<boolean> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) return false;

    const { data, error } = await supabase
      .from('follows')
      .select('id')
      .eq('follower_id', user.id)
      .eq('following_id', targetUserId)
      .eq('status', 'accepted')
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return !!data;
  }

  // POST INTERACTIONS

  /**
   * Toggle favorite (like) status for a post
   */
  async toggleFavorite(postId: string): Promise<{ favorited: boolean; interaction?: PostInteraction }> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    // Check if already favorited - use maybeSingle to handle 0 rows gracefully
    const { data: existing, error: existingError } = await supabase
      .from('post_interactions')
      .select('id')
      .eq('user_id', user.id)
      .eq('post_id', postId)
      .eq('interaction_type', 'favorite')
      .maybeSingle();

    if (existingError && existingError.code !== 'PGRST116') {
      throw existingError;
    }

    if (existing) {
      await this.unfavoritePost(postId);
      
      // Federation is handled automatically by database triggers
      
      return { favorited: false };
    } else {
      const interaction = await this.favoritePost(postId);
      
      // Federation is handled automatically by database triggers
      
      return { favorited: true, interaction };
    }
  }

  /**
   * Favorite (like) a post
   */
  async favoritePost(postId: string): Promise<PostInteraction> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const ap_id = `${this.instanceUrl}/activities/${crypto.randomUUID()}`;
    
    const interaction = {
      user_id: user.id,
      post_id: postId,
      interaction_type: 'favorite' as const,
      ap_id: ap_id,
      is_local: true, // Database triggers will determine the correct value
      metadata: {}
    };

    const { data, error } = await supabase
      .from('post_interactions')
      .insert(interaction)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new Error('Post already favorited');
      }
      throw error;
    }

    return data as PostInteraction;
  }

  /**
   * Unfavorite a post
   */
  async unfavoritePost(postId: string): Promise<void> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const { error } = await supabase
      .from('post_interactions')
      .delete()
      .eq('user_id', user.id)
      .eq('post_id', postId)
      .eq('interaction_type', 'favorite');

    if (error) throw error;
  }

  /**
   * Toggle reblog (share) status for a post - creates actual reblog posts with federation
   * Always operates on the ORIGINAL post, not a reblog
   */
  async toggleReblog(postId: string): Promise<{ reblogged: boolean; reblogPost?: any }> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const profileId = await this.getCurrentUserProfileId();

    // First, resolve to the original post ID (in case this is a reblog)
    const { data: targetPost } = await supabase
      .from('timeline_posts')
      .select('id, reblog')
      .eq('id', postId)
      .single();

    // Use the original post ID if this is a reblog
    const actualPostId = targetPost?.reblog?.id || postId;

    const { data: existingInteraction } = await supabase
      .from('post_interactions')
      .select('id')
      .eq('user_id', profileId)
      .eq('post_id', actualPostId)
      .eq('interaction_type', 'reblog')
      .maybeSingle();

    if (existingInteraction) {
      await supabase
        .from('post_interactions')
        .delete()
        .eq('id', existingInteraction.id);

      // Also remove any reblog post we created
      const { data: reblogPost } = await supabase
        .from('posts')
        .select('id')
        .eq('author_id', profileId)
        .eq('metadata->>reblog_of', actualPostId)
        .maybeSingle();

      if (reblogPost) {
        await this.unreblogPost(reblogPost.id);
      }

      // Federation is handled automatically by database triggers

      return { reblogged: false };
    } else {
      await supabase
        .from('post_interactions')
        .insert({
          user_id: profileId,
          post_id: actualPostId,
          interaction_type: 'reblog',
          is_local: true,
          metadata: {}
        });

      const reblogPost = await this.reblogPost(actualPostId);

      // Federation is handled automatically by database triggers

      return { reblogged: true, reblogPost };
    }
  }

  /**
   * Reblog (share) a post - creates an actual reblog post
   * Always reblogs the ORIGINAL post, not a reblog of a reblog (like Twitter)
   */
  async reblogPost(postId: string): Promise<any> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const profileId = await this.getCurrentUserProfileId();

    const { data: targetPost, error: postError } = await supabase
      .from('timeline_posts')
      .select('*')
      .eq('id', postId)
      .single();

    if (postError) throw postError;

    // If the target is itself a reblog, get the ORIGINAL post instead
    let originalPost = targetPost;
    let actualOriginalId = postId;
    
    if (targetPost.reblog && targetPost.reblog.id) {
      // This is a reblog - get the original post
      actualOriginalId = targetPost.reblog.id;
      const { data: rootPost, error: rootError } = await supabase
        .from('timeline_posts')
        .select('*')
        .eq('id', actualOriginalId)
        .single();
      
      if (!rootError && rootPost) {
        originalPost = rootPost;
      } else {
        // Fallback: use the reblog data we already have
        originalPost = {
          ...targetPost.reblog,
          author: targetPost.reblog_author || targetPost.reblog.author
        };
      }
    }

    const ap_id = `${this.instanceUrl}/activities/${crypto.randomUUID()}`;
    
    const reblogPost = {
      author_id: profileId,
      content: originalPost.content,
      visibility: originalPost.visibility,
      is_local: true,
      is_federated: true,
      ap_id: ap_id,
      conversation_id: originalPost.conversation_id,
      conversation_root_id: originalPost.conversation_root_id || actualOriginalId,
      reblog: {
        id: actualOriginalId,
        content: originalPost.content,
        created_at: originalPost.created_at,
        author: originalPost.author,
        visibility: originalPost.visibility,
        favorites_count: originalPost.favorites_count || 0,
        reblogs_count: originalPost.reblogs_count || 0,
        replies_count: originalPost.replies_count || 0,
        media_attachments: originalPost.media_attachments,
        reply_context: originalPost.reply_context,
        content_warning: originalPost.content_warning,
        is_sensitive: originalPost.is_sensitive,
        url: originalPost.url
      },
      reblog_author: originalPost.author,
      ap_type: 'Announce',
      metadata: { 
        reblog_of: actualOriginalId,
        original_author: originalPost.author?.id 
      }
    };

    const { data, error } = await supabase
      .from('posts')
      .insert(reblogPost)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new Error('Post already reblogged');
      }
      throw error;
    }

    debug.log(`Created reblog post ${data.id} for original post ${postId}`);
    return data;
  }

  /**
   * Create a quote reblog - reblog with user's own comment
   * Always quotes the ORIGINAL post, not a reblog
   */
  async createQuoteReblog(
    postId: string, 
    userContent: string,
    visibility: 'public' | 'unlisted' | 'followers' | 'direct' = 'public',
    contentWarning?: string,
    isSensitive: boolean = false
  ): Promise<any> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const profileId = await this.getCurrentUserProfileId();

    const { data: targetPost, error: postError } = await supabase
      .from('timeline_posts')
      .select('*')
      .eq('id', postId)
      .single();

    if (postError) throw postError;

    // If the target is itself a reblog, get the ORIGINAL post instead
    let originalPost = targetPost;
    let actualOriginalId = postId;
    
    if (targetPost.reblog && targetPost.reblog.id) {
      actualOriginalId = targetPost.reblog.id;
      const { data: rootPost, error: rootError } = await supabase
        .from('timeline_posts')
        .select('*')
        .eq('id', actualOriginalId)
        .single();
      
      if (!rootError && rootPost) {
        originalPost = rootPost;
      } else {
        originalPost = {
          ...targetPost.reblog,
          author: targetPost.reblog_author || targetPost.reblog.author
        };
      }
    }

    const parsedContent = await this.formatPostContent(userContent);

    const ap_id = `${this.instanceUrl}/activities/${crypto.randomUUID()}`;
    
    const quotePost = {
      author_id: profileId,
      content: parsedContent, // User's comment, not the original content
      visibility: visibility,
      is_local: true,
      is_federated: true,
      ap_id: ap_id,
      conversation_id: originalPost.conversation_id,
      conversation_root_id: originalPost.conversation_root_id || actualOriginalId,
      content_warning: contentWarning,
      is_sensitive: isSensitive,
      reblog: {
        id: actualOriginalId,
        content: originalPost.content,
        created_at: originalPost.created_at,
        author: originalPost.author,
        visibility: originalPost.visibility,
        favorites_count: originalPost.favorites_count || 0,
        reblogs_count: originalPost.reblogs_count || 0,
        replies_count: originalPost.replies_count || 0,
        media_attachments: originalPost.media_attachments,
        reply_context: originalPost.reply_context,
        content_warning: originalPost.content_warning,
        is_sensitive: originalPost.is_sensitive,
        url: originalPost.url,
        in_reply_to: originalPost.in_reply_to
      },
      reblog_author: originalPost.author,
      ap_type: 'Announce', // Still an Announce but with content
      metadata: { 
        reblog_of: actualOriginalId,
        original_author: originalPost.author?.id,
        is_quote: true
      }
    };

    const { data, error } = await supabase
      .from('posts')
      .insert(quotePost)
      .select()
      .single();

    if (error) {
      throw error;
    }

    await supabase
      .from('post_interactions')
      .insert({
        user_id: profileId,
        post_id: actualOriginalId,
        interaction_type: 'reblog',
        is_local: true,
        metadata: { is_quote: true }
      });

    debug.log(`Created quote reblog post ${data.id} for original post ${actualOriginalId}`);
    return data;
  }

  /**
   * Un-reblog a post - removes the reblog post
   */
  async unreblogPost(reblogPostId: string): Promise<void> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const profileId = await this.getCurrentUserProfileId();

    const { error } = await supabase
      .from('posts')
      .update({ 
        is_deleted: true, 
        deleted_at: new Date().toISOString() 
      })
      .eq('id', reblogPostId)
      .eq('author_id', profileId);

    if (error) throw error;
  }

  /**
   * Toggle bookmark status for a post
   */
  async toggleBookmark(postId: string): Promise<{ bookmarked: boolean; interaction?: PostInteraction }> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const profileId = await this.getCurrentUserProfileId();

    const { data: existing } = await supabase
      .from('post_interactions')
      .select('id')
      .eq('user_id', profileId)
      .eq('post_id', postId)
      .eq('interaction_type', 'bookmark')
      .single();

    if (existing) {
      await this.unbookmarkPost(postId);
      return { bookmarked: false };
    } else {
      const interaction = await this.bookmarkPost(postId);
      return { bookmarked: true, interaction };
    }
  }

  /**
   * Bookmark a post
   */
  async bookmarkPost(postId: string): Promise<PostInteraction> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const profileId = await this.getCurrentUserProfileId();

    const ap_id = `${this.instanceUrl}/activities/${crypto.randomUUID()}`;
    
    const interaction = {
      user_id: profileId,
      post_id: postId,
      interaction_type: 'bookmark' as const,
      ap_id: ap_id,
      is_local: true, // Database triggers will determine the correct value
      metadata: {}
    };

    const { data, error } = await supabase
      .from('post_interactions')
      .insert(interaction)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new Error('Post already bookmarked');
      }
      throw error;
    }

    return data as PostInteraction;
  }

  /**
   * Remove bookmark from post
   */
  async unbookmarkPost(postId: string): Promise<void> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const profileId = await this.getCurrentUserProfileId();

    const { error } = await supabase
      .from('post_interactions')
      .delete()
      .eq('user_id', profileId)
      .eq('post_id', postId)
      .eq('interaction_type', 'bookmark');

    if (error) throw error;
  }

  // USER SEARCH AND DISCOVERY

  /**
   * Search for federated users
   */
  async searchUsers(query: string, limit: number = 10): Promise<FederatedUser[]> {
    const { data, error } = await supabase
      .rpc('search_federated_users', {
        p_query: query,
        p_limit: limit
      });

    if (error) throw error;

    return (data ?? []).map((user: any) => ({
      id: user.user_id,
      username: user.username,
      display_name: user.display_name,
      domain: user.domain,
      avatar_url: user.avatar_url,
      handle: user.handle,
      is_local: user.is_local,
    })) as FederatedUser[];
  }

  /**
   * Get user profile by handle (@username@domain)
   * Will attempt to fetch from remote if not found locally
   * OPTIMIZED: Uses in-memory cache with TTL and request deduplication
   */
  async getUserByHandle(handle: string, forceRefresh: boolean = false): Promise<FederatedUser | null> {
    const cleanHandle = handle.startsWith('@') ? handle.slice(1) : handle;
    const [username, domain] = cleanHandle.includes('@') 
      ? cleanHandle.split('@')
      : [cleanHandle, this.currentDomain];

    const cacheKey = `${username}@${domain}`;
    const isRemote = domain !== this.currentDomain;

    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cachedProfile = this.getCachedProfile(cacheKey);
      if (cachedProfile) {
        debug.log(`Using cached profile for: ${cacheKey}`);
        return cachedProfile;
      }
    } else {
      this.clearProfileCache(cacheKey);
    }
    
    // Deduplicate concurrent requests for same profile
    const inFlight = this.inFlightRequests.get(cacheKey);
    if (inFlight && !forceRefresh) {
      debug.log(`⏳ Waiting for in-flight request: ${cacheKey}`);
      return inFlight.promise;
    }
    
    const fetchPromise = this._fetchUserByHandle(username, domain, isRemote, forceRefresh, cacheKey);
    
    this.inFlightRequests.set(cacheKey, { promise: fetchPromise });
    
    try {
      const result = await fetchPromise;
      return result;
    } finally {
      this.inFlightRequests.delete(cacheKey);
    }
  }
  
  /**
   * Internal method to actually fetch user by handle
   */
  private async _fetchUserByHandle(
    username: string, 
    domain: string, 
    isRemote: boolean, 
    forceRefresh: boolean,
    cacheKey: string
  ): Promise<FederatedUser | null> {
    // If force refresh on a remote user, skip local lookup
    if (!forceRefresh || !isRemote) {
      // Use maybeSingle() to avoid 406 error when user doesn't exist
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('username', username)
        .eq('domain', domain)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (data) {
        let bio: string | any[] = data.bio || '';
        let display_name: string | any[] = data.display_name || data.username;
        
        if (data.federation_metadata) {
          try {
            const { parseBioWithEmojis } = await import('@/utils/mentionUtils');
            const metadata = typeof data.federation_metadata === 'string' 
              ? JSON.parse(data.federation_metadata)
              : data.federation_metadata;
            
            if (metadata.bio_emojis && metadata.bio_emojis.length > 0 && typeof bio === 'string') {
              bio = parseBioWithEmojis(bio, metadata.bio_emojis);
            }
            if (metadata.display_name_emojis && metadata.display_name_emojis.length > 0 && typeof display_name === 'string') {
              display_name = parseBioWithEmojis(display_name, metadata.display_name_emojis);
            }
          } catch (e) {
            debug.warn('Failed to parse federation_metadata for cached user:', e);
          }
        }
        
        const profile = {
          ...data,
          bio,
          display_name,
          handle: this.formatUserHandle(data.username, data.domain),
          fields: data.profile_fields || [],
        } as FederatedUser;
        
        // Cache the profile
        this.cacheProfile(cacheKey, profile);
        return profile;
      }
    }

    // If remote user not found locally (or force refresh), try to fetch from federation
    if (isRemote) {
      debug.log(`${forceRefresh ? 'Force refreshing' : 'Fetching'} remote user: ${username}@${domain}`);
      
      const { resolveRemoteMention } = await import('@/utils/mentionUtils');
      const remoteUser = await resolveRemoteMention(username, domain, forceRefresh);
      
      if (remoteUser) {
        debug.log(`Successfully ${forceRefresh ? 'refreshed' : 'fetched'} remote user: @${username}@${domain}`);
        // Cache the remote profile
        this.cacheProfile(cacheKey, remoteUser);
        return remoteUser;
      }
    }

    return null;
  }

  /**
   * Resolve a user handle to a user object
   */
  /** @deprecated Use getUserByHandle instead - it has caching and deduplication */
  async resolveUserByHandle(handle: string): Promise<FederatedUser | null> {
    return this.getUserByHandle(handle);
  }

  /**
   * Fetch and create a remote actor profile by ActivityPub ID
   */
  async fetchRemoteActor(actorId: string): Promise<FederatedUser | null> {
    try {
      debug.log(`Fetching remote actor: ${actorId}`);
      
      const { data: existingProfile } = await supabase
        .from('profiles')
        .select('*')
        .eq('federated_id', actorId)
        .single();
      
      if (existingProfile) {
        debug.log('Actor profile already exists');
        return {
          id: existingProfile.id,
          username: existingProfile.username,
          display_name: existingProfile.display_name,
          domain: existingProfile.domain,
          avatar_url: existingProfile.avatar_url,
          banner_url: existingProfile.banner_url,
          handle: existingProfile.domain === import.meta.env.VITE_DOMAIN as string
            ? `@${existingProfile.username}`
            : `@${existingProfile.username}@${existingProfile.domain}`,
          is_local: existingProfile.is_local,
          bio: existingProfile.bio,
          verified: false,
          followers_count: 0,
          following_count: 0,
          posts_count: 0,
          created_at: existingProfile.created_at,
          updated_at: existingProfile.updated_at,
          federated_id: existingProfile.federated_id,
          public_key: existingProfile.public_key,
          inbox_url: existingProfile.inbox_url,
          outbox_url: existingProfile.outbox_url,
          followers_url: existingProfile.followers_url,
          following_url: existingProfile.following_url,
          featured_url: existingProfile.featured_url,
          last_synced_at: existingProfile.last_synced_at
        } as FederatedUser;
      }
      
      const actorResponse = await fetch(actorId, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
          'User-Agent': 'Harmony/1.0 (+https://har.mony.lol)'
        }
      });
      
      if (!actorResponse.ok) {
        debug.error(`Failed to fetch actor: ${actorResponse.status}`);
        return null;
      }
      
      const actor = await actorResponse.json();
      
      const actorUrl = new URL(actorId);
      const domain = actorUrl.hostname;
      const pathParts = actorUrl.pathname.split('/');
      const username = actor.preferredUsername || pathParts[pathParts.length - 1];
      
      const { data: profileId, error: createError } = await supabase
        .rpc('create_federated_profile', {
          p_username: username,
          p_display_name: actor.name || username,
          p_domain: domain,
          p_avatar_url: actor.icon?.url || null,
          p_banner_url: actor.image?.url || null, // Include banner
          p_bio: actor.summary || null,
          p_federated_id: actor.id,
          p_inbox_url: actor.inbox || null,
          p_outbox_url: actor.outbox || null,
          p_followers_url: actor.followers || null,
          p_following_url: actor.following || null,
          p_public_key: actor.publicKey?.publicKeyPem || null
        });
      
      if (createError) {
        debug.error('Failed to create federated profile:', createError);
        return null;
      }
      
      const { data: newProfile, error: fetchError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', profileId)
        .single();
      
      if (fetchError || !newProfile) {
        debug.error('Failed to fetch created profile:', fetchError);
        return null;
      }
      
      debug.log(`Successfully created federated profile for ${actorId}`);
      
      return {
        id: newProfile.id,
        username: newProfile.username,
        display_name: newProfile.display_name,
        domain: newProfile.domain,
        avatar_url: newProfile.avatar_url,
        banner_url: newProfile.banner_url,
        handle: newProfile.domain === import.meta.env.VITE_DOMAIN as string
          ? `@${newProfile.username}`
          : `@${newProfile.username}@${newProfile.domain}`,
        is_local: newProfile.is_local,
        bio: newProfile.bio,
        verified: false,
        followers_count: 0,
        following_count: 0,
        posts_count: 0,
        created_at: newProfile.created_at,
        updated_at: newProfile.updated_at,
        federated_id: newProfile.federated_id,
        public_key: newProfile.public_key,
        inbox_url: newProfile.inbox_url,
        outbox_url: newProfile.outbox_url,
        followers_url: newProfile.followers_url,
        following_url: newProfile.following_url,
        featured_url: newProfile.featured_url,
        last_synced_at: newProfile.last_synced_at
      } as FederatedUser;
      
    } catch (error) {
      debug.error(`Failed to fetch remote actor ${actorId}:`, error);
      return null;
    }
  }

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
        handle: data.domain === import.meta.env.VITE_DOMAIN as string
          ? `@${data.username}`
          : `@${data.username}@${data.domain}`,
        is_local: data.is_local,
        bio: data.bio,
        verified: false,
        followers_count: 0,
        following_count: 0,
        posts_count: 0,
        created_at: data.created_at,
        updated_at: data.updated_at,
        federated_id: data.federated_id,
        public_key: data.public_key,
        inbox_url: data.inbox_url,
        outbox_url: data.outbox_url,
        followers_url: data.followers_url,
        following_url: data.following_url,
        featured_url: data.featured_url,
        last_synced_at: data.last_synced_at,
        fields: data.profile_fields || [],
      } as FederatedUser;
    } catch (error) {
      debug.error('Failed to get user by ID:', error);
      return null;
    }
  }

  /**
   * Get user's timeline using SQL helper function
   */
  async getUserTimeline(
    userId: string,
    timelineType: 'home' | 'public' | 'local' = 'home',
    options: TimelineOptions = {}
  ): Promise<TimelineResult> {
    const limit = options.limit || 20;
    // eslint-disable-next-line unused-imports/no-unused-vars
    const max_id = options.max_id || null;

    // Build query based on timeline type.
    // Typed as `any` because the Postgrest chain returns a different builder
    // type per chained call (`PostgrestQueryBuilder` -> `PostgrestFilterBuilder`),
    // and reassigning back to the same `let` variable would otherwise mismatch.
    let query: any = supabase.from('posts');

    if (timelineType === 'home') {
      // Fast path: server-side follows join in ONE round trip. Also avoids
      // inlining the entire follow list into the request URL, which degrades
      // with follow count. Falls back to the legacy two-query path when the
      // RPC is unavailable (self-hosted instance without the migration).
      const { data: rpcData, error: rpcError } = await supabase.rpc('get_home_timeline_page', {
        p_limit: limit,
        p_before: options.before ?? null,
      });
      if (!rpcError && Array.isArray(rpcData)) {
        const rawData: any[] = rpcData;
        const posts = rawData
          .filter((post: any) => !post.author?.is_suspended)
          .map((post: any) => {
            const interactions = post.my_interactions || [];
            return {
              ...post,
              is_bookmarked: interactions.some((i: any) => i.interaction_type === 'bookmark'),
              is_favorited: interactions.some((i: any) => i.interaction_type === 'favorite' || i.interaction_type === 'emoji_reaction'),
              is_reblogged: interactions.some((i: any) => i.interaction_type === 'reblog'),
            };
          });
        // Raw count for pagination - suspended-user filtering shrinks
        // posts.length and would incorrectly stop pagination.
        return { posts: posts as TimelinePost[], fullPage: rawData.length >= limit };
      }
      debug.warn('get_home_timeline_page RPC unavailable, using legacy two-query load:', rpcError?.message);

      // Get following list - include both accepted AND pending follows
      // Pending follows should still show PUBLIC posts (they're public anyway)
      const { data: follows } = await supabase
        .from('follows')
        .select('following_id, status')
        .eq('follower_id', userId)
        .in('status', ['accepted', 'pending']);

      const acceptedFollowingIds = follows?.filter(f => f.status === 'accepted').map(f => f.following_id) || [];
      const pendingFollowingIds = follows?.filter(f => f.status === 'pending').map(f => f.following_id) || [];
      const allFollowingIds = [...new Set([...acceptedFollowingIds, ...pendingFollowingIds, userId])];

      query = query
        .select(`
          *,
          ${POST_AUTHOR_EMBED},
          my_interactions:post_interactions!left(interaction_type, emoji_id)
        `)
        .eq('my_interactions.user_id', userId)
        .in('author_id', allFollowingIds);
    } else if (timelineType === 'local') {
      query = query
        .select(`
          *,
          ${POST_AUTHOR_EMBED},
          my_interactions:post_interactions!left(interaction_type, emoji_id)
        `)
        .eq('my_interactions.user_id', userId)
        .eq('is_local', true);
    } else {
      // public
      query = query
        .select(`
          *,
          ${POST_AUTHOR_EMBED},
          my_interactions:post_interactions!left(interaction_type, emoji_id)
        `)
        .eq('my_interactions.user_id', userId)
        .in('visibility', ['public', 'unlisted']);
    }

    query = query
      .or('is_deleted.is.null,is_deleted.eq.false')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (options.before) {
      query = query.lt('created_at', options.before);
    }

    const { data, error } = await query;

    if (error) throw error;

    const rawData: any[] = data || [];
    const posts = rawData
      .filter((post: any) => !post.author?.is_suspended)
      .map((post: any) => {
        const interactions = post.my_interactions || [];
        return {
          ...post,
          is_bookmarked: interactions.some((i: any) => i.interaction_type === 'bookmark'),
          is_favorited: interactions.some((i: any) => i.interaction_type === 'favorite' || i.interaction_type === 'emoji_reaction'),
          is_reblogged: interactions.some((i: any) => i.interaction_type === 'reblog'),
        };
      });

    // Use raw DB count for pagination - filtering suspended users reduces posts.length, which would incorrectly stop pagination
    return { posts, fullPage: rawData.length >= limit };
  }

  /**
   * Get user handle using SQL helper function
   */
  async getUserHandle(userId: string): Promise<string | null> {
    const { data, error } = await supabase
      .rpc('get_user_handle', {
        p_user_id: userId
      });

    if (error) throw error;
    return data;
  }

  /**
   * Search federated users using SQL helper function
   */
  /** @deprecated Use searchUsers instead */
  async searchFederatedUsers(query: string, limit: number = 10): Promise<FederatedUser[]> {
    return this.searchUsers(query, limit);
  }

  // UTILITY METHODS

  /**
   * Get the user's profile ID from their auth user ID
   * OPTIMIZED: Uses AuthContextService for centralized caching
   */
  private async getCurrentUserProfileId(): Promise<string> {
    // First try to get from userDataService cache (fastest)
    const { userDataService } = await import('@/services/userDataService');
    const currentUser = userDataService.getCurrentUser();
    
    if (currentUser?.id) {
      return currentUser.id;
    }
    
    // Use AuthContextService which caches auth + profile ID
    const { authContextService } = await import('@/services/AuthContextService');
    return await authContextService.getCurrentProfileId();
  }

  /**
   * Get the current auth user - uses cached AuthContextService
   * OPTIMIZED: Avoids repeated supabase.auth.getUser() calls
   */
  private async getCurrentAuthUser() {
    const { authContextService } = await import('@/services/AuthContextService');
    return await authContextService.getCurrentAuthUser();
  }

  /**
   * Get the current auth user's ID (auth_user_id, not profile_id)
   * OPTIMIZED: Uses cached AuthContextService
   */
  private async getCurrentAuthUserId(): Promise<string> {
    const user = await this.getCurrentAuthUser();
    return user.id;
  }

  /**
   * Get the current user's PROFILE id (profiles.id).
   *
   * Pattern A guard: `post_interactions.user_id`, `timeline_entries.user_id`,
   * `follows.follower_id` and the timeline/context RPCs all FK to profiles(id),
   * NOT auth.users(id). Passing the auth UUID there silently matches nothing,
   * which surfaced as "my favorites/boosts/bookmarks disappear on refresh" and
   * an empty home timeline. Always use this for those columns.
   */
  private async getCurrentProfileId(): Promise<string> {
    const { authContextService } = await import('@/services/AuthContextService');
    return await authContextService.getCurrentProfileId();
  }

  /**
   * Format user handle consistently
   */
  formatUserHandle(username: string, domain: string): string {
    if (domain === this.currentDomain) {
      return `@${username}`;
    }
    return `@${username}@${domain}`;
  }

  /**
   * Parse user handle into username and domain
   */
  parseUserHandle(handle: string): { username: string; domain: string } {
    const cleanHandle = handle.startsWith('@') ? handle.slice(1) : handle;
    const [username, domain] = cleanHandle.includes('@') 
      ? cleanHandle.split('@')
      : [cleanHandle, this.currentDomain];
    
    return { username, domain };
  }

  /**
   * Generate ActivityPub actor URL
   */
  generateActorUrl(username: string, domain: string = this.currentDomain): string {
    return `https://${domain}/users/${username}`;
  }

  /**
   * Generate post URL
   */
  generatePostUrl(postId: string, domain: string = this.currentDomain): string {
    return `https://${domain}/posts/${postId}`;
  }

  /**
   * Get current interaction state for a post and user
   */
  async getPostInteractionState(postId: string): Promise<{
    is_favorited: boolean;
    is_reblogged: boolean;
    is_bookmarked: boolean;
  }> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) return { is_favorited: false, is_reblogged: false, is_bookmarked: false };

    const profileId = await this.getCurrentUserProfileId();

    const { data: interactions } = await supabase
      .from('post_interactions')
      .select('interaction_type')
      .eq('user_id', profileId)
      .eq('post_id', postId);

    const state = {
      is_favorited: false,
      is_reblogged: false,
      is_bookmarked: false
    };

    interactions?.forEach(interaction => {
      if (interaction.interaction_type === 'favorite' || interaction.interaction_type === 'emoji_reaction') state.is_favorited = true;
      if (interaction.interaction_type === 'reblog') state.is_reblogged = true;
      if (interaction.interaction_type === 'bookmark') state.is_bookmarked = true;
    });

    return state;
  }

  // ENHANCED ACTIVITY HANDLING

  /**
   * Update (edit) a post
   */
  async updatePost(postId: string, updates: {
    content?: string;
    content_warning?: string;
    is_sensitive?: boolean;
    media_attachments?: any[];
  }): Promise<Post> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const profileId = await this.getCurrentUserProfileId();

    const { data: originalPost, error: fetchError } = await supabase
      .from('posts')
      .select('*')
      .eq('id', postId)
      .eq('author_id', profileId)
      .single();

    if (fetchError || !originalPost) {
      throw new Error('Post not found or not owned by user');
    }

    const updateData: any = {
    };

    if (updates.content !== undefined) {
      updateData.content = await this.formatPostContent(updates.content);
    }
    if (updates.content_warning !== undefined) {
      updateData.content_warning = updates.content_warning;
    }
    if (updates.is_sensitive !== undefined) {
      updateData.is_sensitive = updates.is_sensitive;
    }
    if (updates.media_attachments !== undefined) {
      updateData.media_attachments = updates.media_attachments;
    }

    const { data: updatedPost, error } = await supabase
      .from('posts')
      .update(updateData)
      .eq('id', postId)
      .select()
      .single();

    if (error) throw error;

    await this.createActivity({
      type: 'Update',
      actor_id: user.id,
      target_id: postId,
      target_type: 'Note',
      activity_data: {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Update',
        actor: await this.getUserActivityPubId(user.id),
        object: await this.postToActivityPubObject(updatedPost),
        published: new Date().toISOString(),
        to: this.getPostAudience(updatedPost.visibility),
        cc: []
      }
    });

    return updatedPost;
  }

  /**
   * Accept a follow request
   */
  async acceptFollowRequest(followId: string): Promise<void> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const profileId = await this.getCurrentUserProfileId();

    const { data: follow, error } = await supabase
      .from('follows')
      .update({
        status: 'accepted',
        accepted_at: new Date().toISOString()
      })
      .eq('id', followId)
      .eq('following_id', profileId)
      .eq('status', 'pending')
      .select()
      .single();

    if (error || !follow) {
      throw new Error('Follow request not found or already processed');
    }

    await this.createActivity({
      type: 'Accept',
      actor_id: user.id,
      target_id: follow.follower_id,
      target_type: 'Person',
      activity_data: {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Accept',
        actor: await this.getUserActivityPubId(user.id),
        object: {
          type: 'Follow',
          id: follow.ap_id,
          actor: await this.getUserActivityPubId(follow.follower_id),
          object: await this.getUserActivityPubId(user.id)
        },
        published: new Date().toISOString()
      }
    });
  }

  /**
   * Reject a follow request
   */
  async rejectFollowRequest(followId: string): Promise<void> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const profileId = await this.getCurrentUserProfileId();

    const { data: follow, error } = await supabase
      .from('follows')
      .update({ status: 'rejected' })
      .eq('id', followId)
      .eq('following_id', profileId)
      .eq('status', 'pending')
      .select()
      .single();

    if (error || !follow) {
      throw new Error('Follow request not found or already processed');
    }

    await this.createActivity({
      type: 'Reject',
      actor_id: user.id,
      target_id: follow.follower_id,
      target_type: 'Person',
      activity_data: {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Reject',
        actor: await this.getUserActivityPubId(user.id),
        object: {
          type: 'Follow',
          id: follow.ap_id,
          actor: await this.getUserActivityPubId(follow.follower_id),
          object: await this.getUserActivityPubId(user.id)
        },
        published: new Date().toISOString()
      }
    });
  }

  /**
   * Undo an action (unfollow, unfavorite, etc.)
   */
  async undoActivity(originalActivityId: string): Promise<void> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const { data: originalActivity, error } = await supabase
      .from('ap_activities')
      .select('*')
      .eq('id', originalActivityId)
      .eq('actor_id', user.id)
      .single();

    if (error || !originalActivity) {
      throw new Error('Original activity not found');
    }

    await this.createActivity({
      type: 'Undo',
      actor_id: user.id,
      target_id: originalActivity.target_id,
      target_type: originalActivity.target_type,
      activity_data: {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: 'Undo',
        actor: await this.getUserActivityPubId(user.id),
        object: originalActivity.activity_data,
        published: new Date().toISOString()
      }
    });
  }

  // VOICE CHAT FEDERATION (Harmony Extensions)

  /**
   * Join a voice channel (federated)
   */
  async joinVoiceChannel(serverId: string, channelId: string, voiceState?: {
    muted?: boolean;
    deafened?: boolean;
    video_enabled?: boolean;
  }): Promise<void> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const { data: server } = await supabase
      .from('servers')
      .select('name, domain')
      .eq('id', serverId)
      .single();

    const { data: channel } = await supabase
      .from('channels')
      .select('name')
      .eq('id', channelId)
      .single();

    if (!server || !channel) {
      throw new Error('Server or channel not found');
    }

    await this.createActivity({
      type: 'VoiceJoin',
      actor_id: user.id,
      target_id: channelId,
      target_type: 'VoiceChannel',
      activity_data: {
        '@context': ['https://www.w3.org/ns/activitystreams', 'https://har.mony.lol/ns/harmony'],
        type: 'VoiceJoin',
        actor: await this.getUserActivityPubId(user.id),
        object: {
          type: 'VoiceChannel',
          id: `${this.instanceUrl}/servers/${serverId}/channels/${channelId}`,
          name: channel.name,
          server: {
            id: `${this.instanceUrl}/servers/${serverId}`,
            name: server.name,
            domain: server.domain || import.meta.env.VITE_DOMAIN as string
          }
        },
        voiceState: voiceState || {},
        published: new Date().toISOString()
      }
    });
  }

  /**
   * Leave a voice channel (federated)
   */
  async leaveVoiceChannel(serverId: string, channelId: string): Promise<void> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    // Similar to joinVoiceChannel but with VoiceLeave type
    await this.createActivity({
      type: 'VoiceLeave',
      actor_id: user.id,
      target_id: channelId,
      target_type: 'VoiceChannel',
      activity_data: {
        '@context': ['https://www.w3.org/ns/activitystreams', 'https://har.mony.lol/ns/harmony'],
        type: 'VoiceLeave',
        actor: await this.getUserActivityPubId(user.id),
        object: {
          type: 'VoiceChannel',
          id: `${this.instanceUrl}/servers/${serverId}/channels/${channelId}`
        },
        published: new Date().toISOString()
      }
    });
  }

  /**
   * Update voice state (mute, deafen, video, etc.)
   */
  async updateVoiceState(serverId: string, channelId: string, voiceState: {
    muted?: boolean;
    deafened?: boolean;
    video_enabled?: boolean;
    screen_sharing?: boolean;
    speaking?: boolean;
  }): Promise<void> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    await this.createActivity({
      type: 'VoiceUpdate',
      actor_id: user.id,
      target_id: channelId,
      target_type: 'VoiceChannel',
      activity_data: {
        '@context': ['https://www.w3.org/ns/activitystreams', 'https://har.mony.lol/ns/harmony'],
        type: 'VoiceUpdate',
        actor: await this.getUserActivityPubId(user.id),
        object: {
          type: 'VoiceChannel',
          id: `${this.instanceUrl}/servers/${serverId}/channels/${channelId}`
        },
        voiceState,
        published: new Date().toISOString()
      }
    });
  }

  // SERVER FEDERATION (Harmony Extensions)

  /**
   * Join a federated server
   */
  async joinFederatedServer(serverDomain: string, inviteCode?: string): Promise<void> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    await this.createActivity({
      type: 'Join',
      actor_id: user.id,
      target_type: 'ChatServer',
      activity_data: {
        '@context': ['https://www.w3.org/ns/activitystreams', 'https://har.mony.lol/ns/harmony'],
        type: 'Join',
        actor: await this.getUserActivityPubId(user.id),
        object: {
          type: 'ChatServer',
          id: `https://${serverDomain}`,
          domain: serverDomain
        },
        invite: inviteCode ? {
          type: 'Invite',
          code: inviteCode
        } : undefined,
        published: new Date().toISOString()
      }
    });
  }

  /**
   * Leave a federated server
   */
  async leaveFederatedServer(serverDomain: string): Promise<void> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    await this.createActivity({
      type: 'Leave',
      actor_id: user.id,
      target_type: 'ChatServer',
      activity_data: {
        '@context': ['https://www.w3.org/ns/activitystreams', 'https://har.mony.lol/ns/harmony'],
        type: 'Leave',
        actor: await this.getUserActivityPubId(user.id),
        object: {
          type: 'ChatServer',
          id: `https://${serverDomain}`,
          domain: serverDomain
        },
        published: new Date().toISOString()
      }
    });
  }

  // ACTIVITY CREATION HELPER

  /**
   * Create and queue an ActivityPub activity
   */
  private async createActivity(activity: {
    type: ActivityPubActivityType;
    actor_id: string;
    target_id?: string;
    target_type?: ActivityPubObjectType;
    activity_data: any;
  }): Promise<void> {
    const ap_id = `${this.instanceUrl}/activities/${crypto.randomUUID()}`;
    
    const { error } = await supabase
      .from('ap_activities')
      .insert({
        ap_id,
        ap_type: activity.type,
        actor_id: activity.actor_id,
        target_id: activity.target_id,
        target_type: activity.target_type,
        activity_data: {
          ...activity.activity_data,
          id: ap_id
        },
        status: 'pending',
        is_local: true,
        retry_count: 0
      });

    if (error) {
      debug.error('Failed to create activity:', error);
      throw error;
    }

    // Queue for delivery to federated instances
    // This would be handled by a background job in production
    debug.log(`Queued ${activity.type} activity for federation:`, ap_id);
  }

  /**
   * Helper: Get user's ActivityPub ID
   */
  private async getUserActivityPubId(userId: string): Promise<string> {
    const { data: profile } = await supabase
      .from('profiles')
      .select('username, domain')
      .eq('id', userId)
      .single();

    if (!profile) throw new Error('User profile not found');

    const domain = profile.domain === import.meta.env.VITE_DOMAIN as string ? this.instanceUrl.replace('https://', '') : profile.domain;
    return `https://${domain}/users/${profile.username}`;
  }

  /**
   * Helper: Convert post to ActivityPub object
   */
  private async postToActivityPubObject(post: any): Promise<any> {
    const author = await this.getUserActivityPubId(post.author_id);
    
    return {
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: post.ap_type || 'Note',
      id: post.ap_id || `${this.instanceUrl}/posts/${post.id}`,
      attributedTo: author,
      content: await this.contentToHtml(post.content),
      published: post.created_at,
      updated: post.updated_at !== post.created_at ? post.updated_at : undefined,
      to: this.getPostAudience(post.visibility),
      cc: [],
      sensitive: post.is_sensitive,
      summary: post.content_warning,
      attachment: post.media_attachments || [],
      inReplyTo: post.in_reply_to ? `${this.instanceUrl}/posts/${post.in_reply_to}` : undefined
    };
  }

  /**
   * Helper: Get post audience based on visibility
   */
  private getPostAudience(visibility: string): string[] {
    switch (visibility) {
      case 'public':
        return ['https://www.w3.org/ns/activitystreams#Public'];
      case 'unlisted':
        return [];
      case 'followers':
        return [`${this.instanceUrl}/users/followers`];
      case 'direct':
        return []; // Would include specific users
      default:
        return ['https://www.w3.org/ns/activitystreams#Public'];
    }
  }

  /**
   * Format post content for storage with mention detection and unified format
   */
  private async formatPostContent(content: string): Promise<any> {
    // Use the centralized unified content processing utility
    const { parseContentToMessageParts, resolveMentionsUserData, resolveEmojisData } = await import('@/utils/unifiedContentProcessing');
    
    // Efficiently resolve all mention and emoji data in batch
    const [usernameToUserDataMap, emojiDataMap] = await Promise.all([
      resolveMentionsUserData(content),
      resolveEmojisData(content)
    ]);
    
    return parseContentToMessageParts(content, usernameToUserDataMap, emojiDataMap);
  }

  /**
   * Helper: Convert MessagePart[] content to HTML for federation
   */
  private async contentToHtml(content: any): Promise<string> {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    
    // Use the centralized unified content processing utility
    const { convertMessagePartsToActivityPubHTML } = await import('@/utils/unifiedContentProcessing');
    return convertMessagePartsToActivityPubHTML(content);
  }

  /**
   * Transform a database post object to a TimelinePost object
   */
  private transformDatabasePostToTimelinePost(post: any): TimelinePost {
    // Keep content in proper format
    let processedContent = post.content;
    if (typeof post.content === 'string') {
      try {
        // Try to parse as JSON first in case it's a JSON string
        const parsed = JSON.parse(post.content);
        if (Array.isArray(parsed)) {
          processedContent = parsed;
        } else {
          processedContent = [{ type: 'text', text: post.content }];
        }
      } catch {
        // Not valid JSON, treat as plain text
        processedContent = [{ type: 'text', text: post.content }];
      }
    } else if (!Array.isArray(post.content)) {
      processedContent = [{ type: 'text', text: '' }];
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
        avatar_url: post.author.avatar_url || '/default_avatar.webp',
        domain: post.author.domain || import.meta.env.VITE_DOMAIN as string,
        bio: post.author.bio || '',
        is_local: post.author.is_local !== false,
        followers_count: 0, // Would need separate query
        following_count: 0, // Would need separate query
        posts_count: 0, // Would need separate query
        created_at: post.author.created_at,
        updated_at: post.author.updated_at || post.author.created_at
      } : {
        id: post.author_id,
        username: 'Unknown',
        display_name: 'Unknown User',
        avatar_url: '/default_avatar.webp',
        domain: import.meta.env.VITE_DOMAIN as string,
        bio: '',
        is_local: true,
        followers_count: 0,
        following_count: 0,
        posts_count: 0,
        created_at: post.created_at,
        updated_at: post.created_at
      },
      // Reblog data (stored as JSONB in database)
      reblog: post.reblog || undefined,
      reblog_author: post.reblog_author || undefined,
      // Use provided interaction states if available (from RPC functions), otherwise false
      is_favorited: post.is_favorited || false,
      is_reblogged: post.is_reblogged || false,
      is_bookmarked: post.is_bookmarked || false
    };
  }

  /**
   * Load post with complete author information
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
      if (!data) return null;

      // Transform to TimelinePost format
      return {
        id: data.id,
        created_at: data.created_at,
        updated_at: data.updated_at,
        content: data.content,
        content_warning: data.content_warning,
        language: data.language || 'en',
        author_id: data.author_id,
        ap_id: data.ap_id,
        ap_type: data.ap_type,
        url: data.url,
        reply_context: data.reply_context,
        conversation_id: data.conversation_id,
        visibility: data.visibility,
        is_local: data.is_local,
        is_federated: data.is_federated,
        replies_count: data.replies_count || 0,
        reblogs_count: data.reblogs_count || 0,
        favorites_count: data.favorites_count || 0,
        media_attachments: data.media_attachments || [],
        metadata: data.metadata || {},
        is_sensitive: data.is_sensitive,
        is_deleted: data.is_deleted,
        deleted_at: data.deleted_at,
        author: {
          id: data.author.id,
          username: data.author.username,
          display_name: data.author.display_name || data.author.username,
          avatar_url: data.author.avatar_url || '/default_avatar.webp',
          domain: data.author.domain || import.meta.env.VITE_DOMAIN as string,
          bio: data.author.bio || '',
          is_local: !data.author.domain || data.author.domain === import.meta.env.VITE_DOMAIN as string,
          followers_count: 0,
          following_count: 0,
          posts_count: 0,
          created_at: data.author.created_at,
          updated_at: data.author.updated_at,
          handle: data.author.domain && data.author.domain !== import.meta.env.VITE_DOMAIN as string 
            ? `@${data.author.username}@${data.author.domain}` 
            : `@${data.author.username}`
        },
        // Reblog data (stored as JSONB in database)
        reblog: data.reblog || undefined,
        reblog_author: data.reblog_author || undefined,
        is_favorited: false,
        is_reblogged: false,
        is_bookmarked: false
      };
    } catch (error) {
      debug.error('Failed to load post with author:', error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Federation proxy helpers
  // ---------------------------------------------------------------------------

  private getFederationApiUrl(): string {
    try {
      const { useActivityPubStore } = require('@/stores/useActivityPub');
      return useActivityPubStore().federationApiUrl;
    } catch {
      return '/api/federation';
    }
  }

  async fetchRemoteReactions(postApId: string, postId: string): Promise<{ count: number; remote_reactions?: any } | null> {
    try {
      const response = await fetch(`${this.getFederationApiUrl()}/fetch-reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_ap_id: postApId, post_id: postId }),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      debug.error('Error fetching remote reactions:', error);
      return null;
    }
  }

  async fetchRemoteReplies(postApId: string, postId: string, limit = 10): Promise<{ count: number } | null> {
    try {
      const response = await fetch(`${this.getFederationApiUrl()}/fetch-replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_ap_id: postApId, post_id: postId, limit }),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (error) {
      debug.error('Error fetching remote replies:', error);
      return null;
    }
  }
}

export const activityPubService = ActivityPubService.getInstance();
