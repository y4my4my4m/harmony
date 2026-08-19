// ActivityPub: database operations for posts, interactions, and follows.
// Federation is driven by database triggers, not from the client.
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
  ConversationContext,
  PostContextOptions,
  PostWithContext
} from '@/types';
import { debug } from '@/utils/debug'

interface ProfileCacheEntry {
  profile: FederatedUser;
  timestamp: number;
}

// Quotes and boosts are both posts rows carrying metadata.reblog_of; only the
// quote sets is_quote. jsonb decodes to a boolean, `metadata->>'is_quote'` to a
// string.
function isQuoteMetadata(metadata: any): boolean {
  const flag = metadata?.is_quote;
  return flag === true || flag === 'true';
}

// Deduplicates concurrent fetches of the same profile.
interface InFlightRequest {
  promise: Promise<FederatedUser | null>;
}

export class ActivityPubService {
  private static instance: ActivityPubService;
  private currentDomain: string;
  private instanceUrl: string;
  
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
  
  // Null when absent or past PROFILE_CACHE_TTL; expired entries are evicted.
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
  
  private cacheProfile(cacheKey: string, profile: FederatedUser): void {
    this.profileCache.set(cacheKey, {
      profile,
      timestamp: Date.now()
    });
  }
  
  // Clears one key, or the whole cache when cacheKey is omitted.
  clearProfileCache(cacheKey?: string): void {
    if (cacheKey) {
      this.profileCache.delete(cacheKey);
    } else {
      this.profileCache.clear();
    }
  }

  // POST MANAGEMENT

  // NOTE: post creation lives in CorePostService/PostService; call
  // services.posts.createPost().

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

  // public + unlisted, newest first.
  async getPublicTimeline(options: TimelineOptions = {}): Promise<TimelinePost[]> {
    // post_interactions.user_id FKs to profiles(id)
    const userId = await this.getCurrentProfileId();

    const limit = options.limit || 20;

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

    debug.log(`Public timeline loaded: ${posts.length} posts (with user interactions)`);
    
    return posts;
  }

  // As getPublicTimeline, plus a fullPage flag for pagination.
  async getEnhancedPublicTimeline(options: TimelineOptions = {}): Promise<TimelineResult> {
    // post_interactions.user_id FKs to profiles(id)
    const userId = await this.getCurrentProfileId();

    const limit = options.limit || 20;
    
    try {
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
   * All public posts from remote instances known to this server, including
   * instances reached only through search rather than follows. The RPC does
   * the is_deleted and suspended-user filtering server-side.
   */
  async getFederatedTimeline(options: TimelineOptions = {}): Promise<TimelinePost[]> {
    // RPC compares p_user_id against post_interactions.user_id (profiles FK)
    const profileId = await this.getCurrentProfileId();

    const limit = options.limit || 20;

    try {
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

  // All public posts from local users on this instance, filtered server-side.
  async getLocalTimeline(options: TimelineOptions = {}): Promise<TimelinePost[]> {
    // RPC compares p_user_id against timeline_entries/post_interactions (profiles FK)
    const profileId = await this.getCurrentProfileId();

    const limit = options.limit || 20;

    debug.log('Loading local timeline via RPC');

    try {
      const { data, error } = await supabase.rpc('get_enhanced_timeline_posts', {
        p_user_id: profileId,
        p_timeline_type: 'local',
        p_limit: limit,
        p_max_id: options.max_id || null
      });

      if (error) throw error;

      // get_enhanced_timeline_posts does not filter suspended authors.
      const posts = (data || []).filter((post: any) => {
        const author = post.author;
        return !author?.is_suspended;
      });

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
   * Context types: minimal, thread, ancestors, descendants. The getPost /
   * getConversationThread / getConversationContext wrappers below all route
   * through here.
   */
  async getPostWithContext(
    postId: string, 
    options: PostContextOptions = {}
  ): Promise<PostWithContext> {
    // The RPC computes is_favorited/is_reblogged/is_bookmarked against
    // post_interactions.user_id, which FKs to profiles(id), not auth.users.
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

  async getPost(postId: string, includeInteractions: boolean = true): Promise<TimelinePost> {
    const result = await this.getPostWithContext(postId, {
      context: 'minimal',
      includeInteractions
    });
    return result.mainPost;
  }

  async getConversationThread(postId: string): Promise<PostWithContext> {
    return this.getPostWithContext(postId, {
      context: 'thread',
      includeInteractions: true
    });
  }

  // Drops mainPost/threadInfo; kept for the older ConversationContext shape.
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

  async getPostReplies(postId: string, options: TimelineOptions = {}): Promise<TimelinePost[]> {
    const user = await this.getCurrentAuthUser();
    if (!user) throw new Error('User not authenticated');

    const limit = options.limit || 20;

    try {
      let query = supabase
        .from('posts')
        .select(`
          *,
          ${POST_AUTHOR_EMBED}
        `)
        .eq('in_reply_to', postId)
        .or('is_deleted.is.null,is_deleted.eq.false')
        .order('created_at', { ascending: true })
        .limit(limit);

      // max_id is a post id; the cursor is that post's created_at.
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
      
      const replies = (data || []).map(post => this.transformDatabasePostToTimelinePost(post));
      
      return replies;
    } catch (error) {
      debug.error('Failed to get post replies:', error);
      return [];
    }
  }

  // EXPLORE AND DISCOVERY METHODS

  async getTrendingHashtags(limit: number = 20): Promise<any[]> {
    return await trendingService.getTrendingHashtags({ limit });
  }

  async getTrendingPosts(options: {
    limit?: number;
    timeframe?: 'hourly' | 'daily' | 'weekly';
    includeLocal?: boolean;
    includeFederated?: boolean;
  } = {}): Promise<any[]> {
    return await trendingService.getTrendingPosts(options);
  }

  // Backed by trending users; no follow-graph component.
  async getSuggestedUsers(limit: number = 10): Promise<any[]> {
    return await trendingService.getTrendingUsers({ limit });
  }

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

  async getPostsByHashtag(
    hashtag: string, 
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ posts: TimelinePost[]; hasMore: boolean; cursor: string | null }> {
    return await trendingService.getPostsByHashtag(hashtag, options);
  }

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

  // Postgres full-text search over posts.content; public posts only.
  async searchPosts(query: string, limit: number = 20): Promise<TimelinePost[]> {
    try {
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

  async getInstanceStats(domain: string): Promise<any | null> {
    return await trendingService.getInstanceStats(domain);
  }

  /**
   * Probes instance health through the federation backend proxy. 'online'
   * when the nodeinfo fetch succeeds, 'offline' otherwise, including on the
   * 15s timeout.
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

  // Public posts by profiles on `domain`, capped at the first 100 profiles.
  async getInstanceActivity(
    domain: string, 
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ posts: TimelinePost[]; hasMore: boolean; cursor: string | null }> {
    try {
      const { limit = 20, cursor } = options;

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

      // limit + 1 rows: the extra row signals hasMore.
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

  async updateTrendingScores(): Promise<void> {
    await trendingService.updateTrendingScores();
  }

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

  // Soft delete; the Delete activity is emitted by a database trigger.
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

    const { error } = await supabase
      .from('posts')
      .update({
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        content: [{ type: 'text', text: '[Deleted]' }]
      })
      .eq('id', postId);

    if (error) throw error;
  }

  // FOLLOW MANAGEMENT

  // Follow activity is emitted by a database trigger.
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
      status: 'accepted', // Locked accounts are not supported; all follows auto-accept.
      is_local: true, // Overwritten by a database trigger.
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

    return data as Follow;
  }

  // Undo activity is emitted by a database trigger.
  async unfollowUser(targetUserId: string): Promise<void> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const { error } = await supabase
      .from('follows')
      .delete()
      .eq('follower_id', user.id)
      .eq('following_id', targetUserId);

    if (error) throw error;
  }

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

  // status = 'pending' follows, i.e. manual-approval mode.
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

  async getFollowRequestsCount(userId: string): Promise<number> {
    const { count, error } = await supabase
      .from('follows')
      .select('id', { count: 'exact', head: true })
      .eq('following_id', userId)
      .eq('status', 'pending');

    if (error) throw error;
    return count || 0;
  }

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

  // Accepted follows only; PGRST116 (no rows) reads as false.
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

  async toggleFavorite(postId: string): Promise<{ favorited: boolean; interaction?: PostInteraction }> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    // maybeSingle: zero rows is the common case, not an error.
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
      return { favorited: false };
    } else {
      const interaction = await this.favoritePost(postId);
      return { favorited: true, interaction };
    }
  }

  async favoritePost(postId: string): Promise<PostInteraction> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const ap_id = `${this.instanceUrl}/activities/${crypto.randomUUID()}`;
    
    const interaction = {
      user_id: user.id,
      post_id: postId,
      interaction_type: 'favorite' as const,
      ap_id: ap_id,
      is_local: true, // Overwritten by a database trigger.
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
   * Toggles reblog state and the backing reblog post. Always operates on the
   * original post, never on a reblog.
   */
  async toggleReblog(postId: string): Promise<{ reblogged: boolean; reblogPost?: any }> {
    const { authUser: user } = await (await import('@/services/AuthContextService')).authContextService.getCurrentContext();
    if (!user) throw new Error('User not authenticated');

    const profileId = await this.getCurrentUserProfileId();

    // `reblog.id` is set when postId names a reblog; interactions attach to
    // the original.
    const { data: targetPost } = await supabase
      .from('timeline_posts')
      .select('id, reblog')
      .eq('id', postId)
      .single();

    const actualPostId = targetPost?.reblog?.id || postId;

    // idx_post_interactions_unique makes (user, post, 'reblog') at most one row,
    // so a PGRST116 here is a real fault rather than a duplicate.
    const { data: existingInteraction, error: interactionError } = await supabase
      .from('post_interactions')
      .select('id')
      .eq('user_id', profileId)
      .eq('post_id', actualPostId)
      .eq('interaction_type', 'reblog')
      .maybeSingle();

    if (interactionError) throw interactionError;

    if (existingInteraction) {
      const { error: deleteError } = await supabase
        .from('post_interactions')
        .delete()
        .eq('id', existingInteraction.id);

      if (deleteError) throw deleteError;

      await this.retractBoostPosts(actualPostId, profileId);

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

      return { reblogged: true, reblogPost };
    }
  }

  /**
   * Inserts a reblog post of type Announce. Reblogging a reblog resolves to
   * the original post, so reblog chains do not nest.
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

    // A non-null reblog.id means targetPost is itself a reblog.
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
        // Original row unreadable; the embedded reblog snapshot stands in.
        originalPost = {
          ...targetPost.reblog,
          author: targetPost.reblog_author || targetPost.reblog.author
        };
      }
    }

    // reblogs_count is recomputed by counting posts rows, and ap_id is a fresh
    // uuid per call, so a second insert raises no unique violation and just
    // raises the count. Reuse the boost already held.
    const [existingBoostId] = await this.findOwnBoostPostIds(actualOriginalId, profileId);
    if (existingBoostId) {
      const { data: existingBoost } = await supabase
        .from('posts')
        .select('*')
        .eq('id', existingBoostId)
        .single();

      debug.log(`Reblog post ${existingBoostId} already held for original post ${actualOriginalId}`);
      return existingBoost;
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
   * Reblog carrying the reblogger's own content. Quoting a reblog resolves
   * to the original post.
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

    // A non-null reblog.id means targetPost is itself a reblog.
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
      content: parsedContent, // The quote text; the original is under `reblog`.
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
      ap_type: 'Announce', // Announce with a content body; no Quote type exists.
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

    // No post_interactions row: update_post_reblog_count counts the posts row,
    // and a 'reblog' interaction reads back as is_reblogged, which routes the
    // next Boost click into the un-boost branch.

    debug.log(`Created quote reblog post ${data.id} for original post ${actualOriginalId}`);
    return data;
  }

  /**
   * Boost wrapper ids the current user holds for `originalPostId`, live rows
   * only. Quotes carry the same metadata.reblog_of and are excluded: a quote is
   * a post of its own, not the row an un-boost retracts.
   */
  private async findOwnBoostPostIds(originalPostId: string, profileId: string): Promise<string[]> {
    const { data, error } = await supabase
      .from('posts')
      .select('id, metadata, is_deleted')
      .eq('author_id', profileId)
      .eq('metadata->>reblog_of', originalPostId);

    if (error) throw error;

    return (data ?? [])
      .filter((row: any) => row.is_deleted !== true && !isQuoteMetadata(row.metadata))
      .map((row: any) => row.id as string);
  }

  /**
   * Soft-deletes every boost the current user holds for `originalPostId` and
   * returns their ids. More than one row is retracted rather than treated as an
   * error; leaving one behind keeps reblogs_count above zero forever.
   */
  async retractBoostPosts(originalPostId: string, profileIdOverride?: string): Promise<string[]> {
    const profileId = profileIdOverride ?? await this.getCurrentUserProfileId();
    const boostIds = await this.findOwnBoostPostIds(originalPostId, profileId);

    for (const boostId of boostIds) {
      await this.unreblogPost(boostId);
    }

    return boostIds;
  }

  // Soft-deletes the reblog post row; the interaction row is removed by the caller.
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
      is_local: true, // Overwritten by a database trigger.
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
   * Resolves `@username@domain`, falling back to a remote fetch when the
   * profile is not stored locally. Reads pass through the TTL cache and
   * concurrent calls for the same handle share one in-flight promise.
   */
  async getUserByHandle(handle: string, forceRefresh: boolean = false): Promise<FederatedUser | null> {
    const cleanHandle = handle.startsWith('@') ? handle.slice(1) : handle;
    const [username, domain] = cleanHandle.includes('@') 
      ? cleanHandle.split('@')
      : [cleanHandle, this.currentDomain];

    const cacheKey = `${username}@${domain}`;
    const isRemote = domain !== this.currentDomain;

    if (!forceRefresh) {
      const cachedProfile = this.getCachedProfile(cacheKey);
      if (cachedProfile) {
        debug.log(`Using cached profile for: ${cacheKey}`);
        return cachedProfile;
      }
    } else {
      this.clearProfileCache(cacheKey);
    }
    
    // A forceRefresh caller never joins an in-flight request.
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
  
  private async _fetchUserByHandle(
    username: string, 
    domain: string, 
    isRemote: boolean, 
    forceRefresh: boolean,
    cacheKey: string
  ): Promise<FederatedUser | null> {
    // A forced refresh of a remote user skips the local row.
    if (!forceRefresh || !isRemote) {
      // maybeSingle: single() returns 406 when the row is absent.
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
        
        this.cacheProfile(cacheKey, profile);
        return profile;
      }
    }

    if (isRemote) {
      debug.log(`${forceRefresh ? 'Force refreshing' : 'Fetching'} remote user: ${username}@${domain}`);
      
      const { resolveRemoteMention } = await import('@/utils/mentionUtils');
      const remoteUser = await resolveRemoteMention(username, domain, forceRefresh);
      
      if (remoteUser) {
        debug.log(`Successfully ${forceRefresh ? 'refreshed' : 'fetched'} remote user: @${username}@${domain}`);
        this.cacheProfile(cacheKey, remoteUser);
        return remoteUser;
      }
    }

    return null;
  }

  /** @deprecated Use getUserByHandle; it caches and deduplicates. */
  async resolveUserByHandle(handle: string): Promise<FederatedUser | null> {
    return this.getUserByHandle(handle);
  }

  // Returns the existing profiles row when federated_id already matches.
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
          p_banner_url: actor.image?.url || null,
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

  // userId is a profiles.id. Null on PGRST116 (no rows).
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

  async getUserTimeline(
    userId: string,
    timelineType: 'home' | 'public' | 'local' = 'home',
    options: TimelineOptions = {}
  ): Promise<TimelineResult> {
    const limit = options.limit || 20;
    // eslint-disable-next-line unused-imports/no-unused-vars
    const max_id = options.max_id || null;

    // Typed `any`: the Postgrest chain returns a different builder type per
    // call (`PostgrestQueryBuilder` -> `PostgrestFilterBuilder`), which does
    // not reassign back to the same `let`.
    let query: any = supabase.from('posts');

    if (timelineType === 'home') {
      // Server-side follows join in one round trip; keeps the follow list out
      // of the request URL, whose length otherwise grows with follow count.
      // Falls back to the two-query path when the RPC is missing (self-hosted
      // instance without the migration).
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
        // fullPage uses the raw row count: suspended-author filtering shrinks
        // posts.length and would end pagination early.
        return { posts: posts as TimelinePost[], fullPage: rawData.length >= limit };
      }
      debug.warn('get_home_timeline_page RPC unavailable, using legacy two-query load:', rpcError?.message);

      // Pending follows are included: their public posts are visible anyway.
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

    // fullPage uses the raw row count: suspended-author filtering shrinks
    // posts.length and would end pagination early.
    return { posts, fullPage: rawData.length >= limit };
  }

  async getUserHandle(userId: string): Promise<string | null> {
    const { data, error } = await supabase
      .rpc('get_user_handle', {
        p_user_id: userId
      });

    if (error) throw error;
    return data;
  }

  /** @deprecated Use searchUsers. */
  async searchFederatedUsers(query: string, limit: number = 10): Promise<FederatedUser[]> {
    return this.searchUsers(query, limit);
  }

  // UTILITY METHODS

  // profiles.id, from the userDataService cache when populated.
  private async getCurrentUserProfileId(): Promise<string> {
    const { userDataService } = await import('@/services/userDataService');
    const currentUser = userDataService.getCurrentUser();

    if (currentUser?.id) {
      return currentUser.id;
    }

    const { authContextService } = await import('@/services/AuthContextService');
    return await authContextService.getCurrentProfileId();
  }

  // AuthContextService caches this; supabase.auth.getUser() is not called per use.
  private async getCurrentAuthUser() {
    const { authContextService } = await import('@/services/AuthContextService');
    return await authContextService.getCurrentAuthUser();
  }

  // auth.users(id), not profiles(id).
  private async getCurrentAuthUserId(): Promise<string> {
    const user = await this.getCurrentAuthUser();
    return user.id;
  }

  /**
   * profiles.id for the current user.
   *
   * `post_interactions.user_id`, `timeline_entries.user_id`,
   * `follows.follower_id` and the timeline/context RPCs all FK to
   * profiles(id), not auth.users(id). An auth UUID matches nothing there and
   * fails silently: empty home timeline, missing favorites/boosts/bookmarks.
   */
  private async getCurrentProfileId(): Promise<string> {
    const { authContextService } = await import('@/services/AuthContextService');
    return await authContextService.getCurrentProfileId();
  }

  // Local handles omit the domain: @user, not @user@thisdomain.
  formatUserHandle(username: string, domain: string): string {
    if (domain === this.currentDomain) {
      return `@${username}`;
    }
    return `@${username}@${domain}`;
  }

  // A handle without a domain part resolves to the current domain.
  parseUserHandle(handle: string): { username: string; domain: string } {
    const cleanHandle = handle.startsWith('@') ? handle.slice(1) : handle;
    const [username, domain] = cleanHandle.includes('@') 
      ? cleanHandle.split('@')
      : [cleanHandle, this.currentDomain];
    
    return { username, domain };
  }

  generateActorUrl(username: string, domain: string = this.currentDomain): string {
    return `https://${domain}/users/${username}`;
  }

  generatePostUrl(postId: string, domain: string = this.currentDomain): string {
    return `https://${domain}/posts/${postId}`;
  }

  // emoji_reaction counts as favorited.
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

  // Plain text to MessagePart[], resolving mentions and emojis.
  private async formatPostContent(content: string): Promise<any> {
    const { parseContentToMessageParts, resolveMentionsUserData, resolveEmojisData } = await import('@/utils/unifiedContentProcessing');

    // Both resolvers batch their lookups; run them concurrently.
    const [usernameToUserDataMap, emojiDataMap] = await Promise.all([
      resolveMentionsUserData(content),
      resolveEmojisData(content)
    ]);
    
    return parseContentToMessageParts(content, usernameToUserDataMap, emojiDataMap);
  }

  private transformDatabasePostToTimelinePost(post: any): TimelinePost {
    // content is MessagePart[]; string rows may hold either serialized
    // MessagePart[] or raw text.
    let processedContent = post.content;
    if (typeof post.content === 'string') {
      try {
        const parsed = JSON.parse(post.content);
        if (Array.isArray(parsed)) {
          processedContent = parsed;
        } else {
          processedContent = [{ type: 'text', text: post.content }];
        }
      } catch {
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
        // Counts are not in the post embed; a separate profile query supplies them.
        followers_count: 0,
        following_count: 0,
        posts_count: 0,
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
      // JSONB columns.
      reblog: post.reblog || undefined,
      reblog_author: post.reblog_author || undefined,
      // Present only on rows from the interaction-aware RPCs.
      is_favorited: post.is_favorited || false,
      is_reblogged: post.is_reblogged || false,
      is_bookmarked: post.is_bookmarked || false
    };
  }

  // Embeds the full profiles row; interaction flags are always false here.
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
        // JSONB columns.
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

  // Federation proxy helpers

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
