/**
 * TrendingService - Handles trending content, hashtags, and explore functionality
 * Provides methods for discovering trending posts, hashtags, users, and instances
 */

import { supabase } from '@/supabase';
import type { TimelinePost, FederatedUser } from '@/types';
import { debug } from '@/utils/debug'

// INTERFACES

export interface TrendingHashtag {
  tag: string;
  daily_uses: number;
  weekly_uses: number;
  trending_score: number;
  trending_rank: number;
  change_percent: number;
  trend: 'up' | 'down' | 'stable';
}

export interface TrendingPost {
  post: TimelinePost;
  trending_score: number;
  engagement_score: number;
  trending_rank: number;
  engagement_velocity: number;
}

export interface TrendingUser {
  user: FederatedUser;
  trending_score: number;
  followers_growth: number;
  engagement_rate: number;
  trending_rank: number;
  new_followers: number;
  posts_count: number;
}

export interface HashtagStats {
  tag: string;
  total_uses: number;
  daily_uses: number;
  weekly_uses: number;
  first_used_at: string;
  last_used_at: string;
  peak_daily_uses: number;
  peak_daily_date: string;
}

export interface TrendingOptions {
  limit?: number;
  days?: number;
  /** Time window in hours. Takes precedence over `days` for hashtag queries. */
  hours?: number;
  timeframe?: 'hourly' | 'daily' | 'weekly';
  includeLocal?: boolean;
  includeFederated?: boolean;
  minEngagement?: number;
  instance?: string;
  timeRange?: ExploreFilters['timeRange'];
  /**
   * Filter posts by real uploaded media (`posts.media_attachments`):
   *  - `'media'`: only posts that contain at least one media attachment (uploads),
   *  - `'text'`: only posts with no media attachment,
   *  - `'all'`: no media constraint.
   * Link-preview / oEmbed cards (stored in `metadata.embeds`) are NOT media.
   */
  mediaFilter?: 'all' | 'media' | 'text';
  /** @deprecated use `mediaFilter: 'media'` */
  mediaOnly?: boolean;
}

export interface ExploreFilters {
  contentType?: 'all' | 'posts' | 'media' | 'users';
  timeRange?: '1h' | '6h' | '24h' | '7d' | '30d';
  instance?: string;
  language?: string;
  minScore?: number;
  limit?: number;
  includeLocal?: boolean;
  includeFederated?: boolean;
  /** `'engagement'` ranks by interactions within the window; `'recent'` by recency. */
  orderBy?: 'recent' | 'engagement';
}

// TRENDING SERVICE CLASS

class TrendingService {
  
  // HASHTAG TRENDING METHODS

  /**
   * Get trending hashtags
   */
  async getTrendingHashtags(options: TrendingOptions = {}): Promise<TrendingHashtag[]> {
    try {
      const { limit = 20 } = options;
      // Prefer an explicit hours window; fall back to days (legacy callers) → hours.
      const hours = options.hours ?? (options.days ? options.days * 24 : 168);

      const { data, error } = await supabase.rpc('get_trending_hashtags', {
        p_hours: hours,
        p_limit: limit
      });

      if (error) throw error;

      return (data || []).map((row: any, index: number) => ({
        tag: row.tag,
        daily_uses: Number(row.uses_count) || 0,
        weekly_uses: Number(row.uses_count) || 0,
        trending_score: Number(row.uses_count) || 0,
        trending_rank: index + 1,
        change_percent: Number(row.change_percent) || 0,
        trend: (row.trend === 'rising' ? 'up' : row.trend === 'falling' ? 'down' : 'stable') as 'up' | 'down' | 'stable'
      }));
    } catch (error) {
      debug.error('Failed to get trending hashtags:', error);
      return [];
    }
  }

  /**
   * Get hashtag statistics
   */
  async getHashtagStats(tag: string): Promise<HashtagStats | null> {
    try {
      const { data, error } = await supabase
        .from('hashtags')
        .select('*')
        .eq('normalized_tag', tag.toLowerCase().replace(/^#/, ''))
        .single();

      if (error || !data) return null;

      return {
        tag: data.tag,
        total_uses: data.total_uses || 0,
        daily_uses: data.daily_uses || 0,
        weekly_uses: data.weekly_uses || 0,
        first_used_at: data.first_used_at,
        last_used_at: data.last_used_at,
        peak_daily_uses: data.peak_daily_uses || 0,
        peak_daily_date: data.peak_daily_date
      };
    } catch (error) {
      debug.error('Failed to get hashtag stats:', error);
      return null;
    }
  }

  /**
   * Search hashtags
   */
  async searchHashtags(query: string, limit: number = 20): Promise<TrendingHashtag[]> {
    try {
      const normalizedQuery = query.toLowerCase().replace(/^#/, '');
      
      const { data, error } = await supabase
        .from('hashtags')
        .select('*')
        .ilike('normalized_tag', `%${normalizedQuery}%`)
        .order('trending_score', { ascending: false })
        .limit(limit);

      if (error) throw error;

      return (data || []).map(row => ({
        tag: row.tag,
        daily_uses: row.daily_uses || 0,
        weekly_uses: row.weekly_uses || 0,
        trending_score: parseFloat(row.trending_score) || 0,
        trending_rank: row.trending_rank || 999,
        change_percent: 0, // Would need additional calculation
        trend: 'stable' as const
      }));
    } catch (error) {
      debug.error('Failed to search hashtags:', error);
      return [];
    }
  }

  // TRENDING POSTS METHODS

  /**
   * Get trending posts
   */
  async getTrendingPosts(options: TrendingOptions = {}): Promise<TrendingPost[]> {
    try {
      const {
        limit = 20,
        includeLocal = true,
        includeFederated = true,
        instance,
        timeRange = '24h',
        mediaFilter,
        mediaOnly = false,
      } = options;

      // Map the media filter onto an explore content type. The precomputed
      // `trending_posts` table can't honor media/instance/time filters at the
      // row level (nested embeds + sparse buckets), so trending on the explore
      // tab is sourced from a live, engagement-ranked `posts` query. This makes
      // every filter (time window, instance, media vs text) actually apply.
      const contentType: ExploreFilters['contentType'] =
        mediaFilter === 'media' || mediaOnly
          ? 'media'
          : mediaFilter === 'text'
            ? 'posts'
            : 'all';

      const posts = await this.getExplorePosts({
        contentType,
        timeRange,
        instance,
        includeLocal,
        includeFederated,
        limit,
        orderBy: 'engagement',
      });

      return posts.map((post, index) => {
        const score = this.engagementScore(post);
        return {
          post,
          trending_score: score,
          engagement_score: score,
          trending_rank: index + 1,
          engagement_velocity: 0,
        };
      });
    } catch (error) {
      debug.error('Failed to get trending posts:', error);
      return [];
    }
  }

  /** Weighted engagement score: reblogs count double, replies/favorites once. */
  private engagementScore(post: { favorites_count?: number; reblogs_count?: number; replies_count?: number }): number {
    return (post.favorites_count || 0)
      + (post.reblogs_count || 0) * 2
      + (post.replies_count || 0);
  }

  /**
   * Get posts by hashtag
   */
  async getPostsByHashtag(
    hashtag: string, 
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ posts: TimelinePost[]; hasMore: boolean; cursor: string | null }> {
    try {
      const { limit = 20, cursor } = options;
      const normalizedTag = hashtag.toLowerCase().replace(/^#/, '');

      debug.log(`🔍 Looking for hashtag: "${normalizedTag}" (original: "${hashtag}")`);

      // Step 1: Find the hashtag ID - try both tag and normalized_tag
      let hashtagData: { id: string } | null = null;
      let hashtagError: any = null;

      // First try normalized_tag
      const { data: data1 } = await supabase
        .from('hashtags')
        .select('id')
        .eq('normalized_tag', normalizedTag)
        .maybeSingle();

      if (data1) {
        hashtagData = data1;
      } else {
        // Fallback: try the tag field
        const { data: data2, error: error2 } = await supabase
          .from('hashtags')
          .select('id')
          .eq('tag', normalizedTag)
          .maybeSingle();
        
        hashtagData = data2;
        // eslint-disable-next-line unused-imports/no-unused-vars
        hashtagError = error2;
      }

      if (!hashtagData) {
        debug.log(`❌ Hashtag not found in DB: ${normalizedTag}`);
        return { posts: [], hasMore: false, cursor: null };
      }

      debug.log(`✅ Found hashtag ID: ${hashtagData.id}`);

      // Step 2: Get post IDs with this hashtag
      let postHashtagQuery = supabase
        .from('post_hashtags')
        .select('post_id, created_at')
        .eq('hashtag_id', hashtagData.id)
        .order('created_at', { ascending: false })
        .limit(limit + 1);

      if (cursor) {
        postHashtagQuery = postHashtagQuery.lt('created_at', cursor);
      }

      const { data: postHashtags, error: phError } = await postHashtagQuery;
      if (phError) throw phError;

      debug.log(`📝 Found ${postHashtags?.length || 0} post_hashtags entries`);

      if (!postHashtags || postHashtags.length === 0) {
        debug.log(`❌ No posts found for hashtag ${normalizedTag}`);
        return { posts: [], hasMore: false, cursor: null };
      }

      const postIds = postHashtags.slice(0, limit).map(ph => ph.post_id);
      debug.log(`📝 Post IDs: ${postIds.join(', ')}`);

      // Step 3: Fetch posts with those IDs (excluding deleted)
      const { data: postsData, error: postsError } = await supabase
        .from('posts')
        .select(`
          *,
          author:profiles(*)
        `)
        .in('id', postIds)
        .eq('is_deleted', false);

      if (postsError) throw postsError;

      debug.log(`📝 Fetched ${postsData?.length || 0} posts from DB`);

      // Maintain the original order from post_hashtags
      const postsMap = new Map((postsData || []).map(p => [p.id, p]));
      const orderedPosts = postIds
        .map(id => postsMap.get(id))
        .filter(Boolean)
        .map((post: any) => this.transformDatabasePostToTimelinePost(post));

      debug.log(`✅ Returning ${orderedPosts.length} posts for #${normalizedTag}`);

      const hasMore = postHashtags.length > limit;
      const nextCursor = hasMore && postHashtags.length > 1 
        ? postHashtags[postHashtags.length - 2].created_at 
        : null;

      return { posts: orderedPosts, hasMore, cursor: nextCursor };
    } catch (error) {
      debug.error('Failed to get posts by hashtag:', error);
      return { posts: [], hasMore: false, cursor: null };
    }
  }

  // TRENDING USERS METHODS

  /**
   * Get trending users (suggested follows)
   * OPTIMIZED: Uses AuthContextService for cached auth lookup
   */
  async getTrendingUsers(options: TrendingOptions = {}): Promise<TrendingUser[]> {
    try {
      const { limit = 10, instance, includeLocal = true, includeFederated = true } = options;

      // Get current user's PROFILE id to exclude from trending users
      // (profiles.id, not the auth UUID - they differ, and comparing the auth
      // UUID meant you'd see yourself in your own "suggested follows").
      const { authContextService } = await import('@/services/AuthContextService');
      const context = await authContextService.getCurrentContext();
      const currentUserId = context.profileId;

      let query = supabase
        .from('profiles')
        .select(`
          id,
          username,
          display_name,
          avatar_url,
          bio,
          domain,
          is_local,
          created_at,
          updated_at,
          followers_count,
          following_count,
          posts_count
        `)
        .eq('is_suspended', false);

      // "All Instances" includes federated users too - only narrow to a single
      // domain when one is explicitly selected.
      if (instance && instance !== 'all') {
        query = query.eq('domain', instance);
      } else if (includeLocal && !includeFederated) {
        // "This instance" only. Uses is_local so local users with a NULL domain
        // are included (they wouldn't match domain = VITE_DOMAIN).
        query = query.eq('is_local', true);
      } else if (!includeLocal && includeFederated) {
        query = query.eq('is_local', false);
      }

      query = query.order('followers_count', { ascending: false });

      if (currentUserId) {
        query = query.neq('id', currentUserId);
      }

      query = query.limit(limit);

      const { data, error } = await query;
      if (error) throw error;

      const now = Date.now();
      const results = (data || []).map((row: any) => {
        const user: FederatedUser = {
          id: row.id,
          username: row.username,
          domain: row.domain || import.meta.env.VITE_DOMAIN as string,
          handle: `@${row.username}${row.domain && row.domain !== import.meta.env.VITE_DOMAIN as string ? '@' + row.domain : ''}`,
          display_name: row.display_name || row.username,
          avatar_url: row.avatar_url || '/default_avatar.webp',
          bio: row.bio || '',
          is_local: row.domain === import.meta.env.VITE_DOMAIN as string || !row.domain,
          verified: false,
          followers_count: row.followers_count || 0,
          following_count: row.following_count || 0,
          posts_count: row.posts_count || 0,
          created_at: row.created_at,
          updated_at: row.updated_at || row.created_at
        };

        const followers = user.followers_count ?? 0;
        const posts = user.posts_count ?? 0;
        const createdAt = new Date(row.created_at).getTime();
        const daysSinceCreated = Math.max(1, (now - createdAt) / (1000 * 60 * 60 * 24));
        const updatedAt = new Date(row.updated_at || row.created_at).getTime();
        const daysSinceActive = Math.max(0.1, (now - updatedAt) / (1000 * 60 * 60 * 24));
        const recencyBoost = 1 / (1 + daysSinceActive / 7);

        const trendingScore = ((followers * 0.3) + (posts * 2.0)) * recencyBoost;
        const followersGrowth = (followers / daysSinceCreated) * 7;
        const engagementRate = posts > 0 ? Math.min(100, (followers / posts) * 10) : 0;

        return {
          user,
          trending_score: Math.round(trendingScore * 100) / 100,
          followers_growth: Math.round(followersGrowth * 100) / 100,
          engagement_rate: Math.round(engagementRate * 100) / 100,
          trending_rank: 0,
          new_followers: Math.round(followersGrowth),
          posts_count: posts
        };
      });

      results.sort((a, b) => b.trending_score - a.trending_score);
      results.forEach((r, i) => { r.trending_rank = i + 1; });

      return results;
    } catch (error) {
      debug.error('Failed to get trending users:', error);
      return [];
    }
  }

  // INSTANCE DISCOVERY METHODS

  /**
   * Get federated instances for exploration
   */
  async getFederatedInstances(options: {
    limit?: number;
    filter?: 'all' | 'active' | 'blocked' | 'trusted';
    search?: string;
  } = {}): Promise<any[]> {
    try {
      const { limit = 20, filter = 'active', search } = options;
      const fetchLimit = Math.min(limit * 3, 150);

      let query = supabase
        .from('federated_instances')
        .select('*')
        .order('last_seen_at', { ascending: false })
        .limit(fetchLimit);

      switch (filter) {
        case 'active':
          query = query.eq('is_blocked', false);
          break;
        case 'blocked':
          query = query.eq('is_blocked', true);
          break;
        case 'trusted':
          query = query.eq('is_trusted', true);
          break;
      }

      if (search) {
        query = query.or(`domain.ilike.%${search}%,description.ilike.%${search}%`);
      }

      const { data, error } = await query;
      if (error) throw error;

      const instances = data || [];
      const domains = instances.map((instance) => instance.domain).filter(Boolean);
      const healthByDomain = new Map<string, string>();
      const connectionsByDomain = new Map<string, number>();

      if (domains.length > 0) {
        const [{ data: healthRows }, { data: connectionRows }] = await Promise.all([
          supabase
            .from('federation_health')
            .select('instance_domain, last_success_at')
            .in('instance_domain', domains),
          supabase.rpc('get_federated_instance_connection_counts', {
            p_domains: domains,
          }),
        ]);

        for (const row of healthRows || []) {
          if (row.last_success_at) {
            healthByDomain.set(row.instance_domain.toLowerCase(), row.last_success_at);
          }
        }

        for (const row of connectionRows || []) {
          if (row.domain) {
            connectionsByDomain.set(row.domain.toLowerCase(), Number(row.connection_count) || 0);
          }
        }
      }

      return instances
        .map(instance => {
        const domainKey = instance.domain ? instance.domain.toLowerCase() : '';
        const healthLastSeen = domainKey ? healthByDomain.get(domainKey) : undefined;
        const effectiveLastSeen = this.maxTimestamp(instance.last_seen_at, healthLastSeen);
        const connectionCount = domainKey
          ? (connectionsByDomain.get(domainKey) ?? instance.connection_count ?? 0)
          : (instance.connection_count ?? 0);

        return {
        id: instance.id,
        domain: instance.domain,
        software: instance.software || 'Unknown',
        version: instance.version || 'Unknown',
        description: instance.description || 'No description available',
        admin_contact: instance.admin_contact,
        is_blocked: instance.is_blocked,
        is_trusted: instance.is_trusted,
        last_seen_at: effectiveLastSeen,
        user_count: instance.user_count || 0,
        status_count: instance.status_count || 0,
        connection_count: connectionCount,
        metadata: instance.metadata || {},
        status: this.getInstanceStatus({ last_seen_at: effectiveLastSeen })
      };
      })
        .sort(
          (a, b) =>
            new Date(b.last_seen_at || 0).getTime() - new Date(a.last_seen_at || 0).getTime()
        )
        .slice(0, limit);
    } catch (error) {
      debug.error('Failed to get federated instances:', error);
      return [];
    }
  }

  private instanceByDomainCache = new Map<string, any | null>();
  private instanceByDomainInflight = new Map<string, Promise<any | null>>();

  /**
   * Lightweight federated_instances row lookup by domain (cached).
   * Used by badges and anywhere we need icon_url / software without full stats.
   */
  async getFederatedInstanceByDomain(domain: string): Promise<any | null> {
    const normalized = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    if (this.instanceByDomainCache.has(normalized)) {
      return this.instanceByDomainCache.get(normalized) ?? null;
    }

    const pending = this.instanceByDomainInflight.get(normalized);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const { data, error } = await supabase
          .from('federated_instances')
          .select('domain, software, description, metadata')
          .eq('domain', normalized)
          .maybeSingle();

        if (error) throw error;
        this.instanceByDomainCache.set(normalized, data ?? null);
        return data ?? null;
      } catch (err) {
        debug.warn('Failed to lookup federated instance:', normalized, err);
        this.instanceByDomainCache.set(normalized, null);
        return null;
      } finally {
        this.instanceByDomainInflight.delete(normalized);
      }
    })();

    this.instanceByDomainInflight.set(normalized, promise);
    return promise;
  }

  /**
   * Get instance statistics
   */
  async getInstanceStats(domain: string): Promise<any | null> {
    try {
      const { data, error } = await supabase
        .from('federated_instances')
        .select('*')
        .eq('domain', domain)
        .single();

      if (error || !data) return null;

      // Get additional stats
      const [postsCount, usersCount] = await Promise.all([
        this.getInstancePostCount(domain),
        this.getInstanceUserCount(domain)
      ]);

      return {
        ...data,
        posts_count: postsCount,
        local_users_count: usersCount,
        status: this.getInstanceStatus(data),
        last_activity: data.last_seen_at
      };
    } catch (error) {
      debug.error('Failed to get instance stats:', error);
      return null;
    }
  }

  // EXPLORE CONTENT METHODS

  /**
   * Get explore content based on filters
   */
  async getExploreContent(filters: ExploreFilters = {}): Promise<{
    posts: TimelinePost[];
    hashtags: TrendingHashtag[];
    users: TrendingUser[];
    instances: any[];
  }> {
    try {
      const timeRange = filters.timeRange ?? '24h';
      const [posts, hashtags, users, instances] = await Promise.all([
        this.getExplorePosts(filters),
        this.getTrendingHashtags({
          limit: 10,
          days: this.getDaysForTimeRange(timeRange),
        }),
        this.getTrendingUsers({
          limit: 6,
          instance: filters.instance,
        }),
        this.getFederatedInstances({ limit: 8, filter: 'active' })
      ]);

      return { posts, hashtags, users, instances };
    } catch (error) {
      debug.error('Failed to get explore content:', error);
      return { posts: [], hashtags: [], users: [], instances: [] };
    }
  }

  /**
   * Get posts for explore feed
   */
  async getExplorePosts(filters: ExploreFilters = {}): Promise<TimelinePost[]> {
    try {
      const {
        contentType = 'all',
        timeRange = '24h',
        instance,
        limit = 20,
        includeLocal = true,
        includeFederated = true,
        orderBy = 'recent',
      } = filters;

      const timeThreshold = this.getTimeThreshold(timeRange);

      // For engagement ranking we over-fetch the most recent candidates within
      // the window, then rank client-side (PostgREST can't ORDER BY a weighted
      // expression). Capped so a hot window can't pull an unbounded result set.
      const candidateLimit = orderBy === 'engagement'
        ? Math.min(Math.max(limit * 5, limit), 100)
        : limit;

      let query = supabase
        .from('posts')
        .select(`
          *,
          author:profiles!inner(*)
        `)
        .eq('visibility', 'public')
        .eq('is_deleted', false)
        .eq('author.is_suspended', false) // Exclude posts from suspended users
        .gte('created_at', timeThreshold)
        .order('created_at', { ascending: false })
        .limit(candidateLimit);

      // Content type → real uploaded media (`media_attachments`), not oEmbed
      // link previews (which live in `metadata.embeds`).
      if (contentType === 'media') {
        query = query.not('media_attachments', 'eq', '[]');
      } else if (contentType === 'posts') {
        // "Posts only" = no uploaded media attachment.
        query = query.eq('media_attachments', '[]');
      }

      // Apply instance filter
      if (instance && instance !== 'all') {
        query = query.eq('author.domain', instance);
      }

      // Local/federated scoping (only when exactly one is requested)
      if (includeLocal && !includeFederated) {
        query = query.eq('is_local', true);
      } else if (!includeLocal && includeFederated) {
        query = query.eq('is_local', false);
      }

      const { data, error } = await query;
      if (error) throw error;

      let rows = data || [];
      if (orderBy === 'engagement') {
        rows = [...rows]
          .sort((a, b) => this.engagementScore(b) - this.engagementScore(a))
          .slice(0, limit);
      }

      return rows.map(row => this.transformDatabasePostToTimelinePost(row));
    } catch (error) {
      debug.error('Failed to get explore posts:', error);
      return [];
    }
  }

  // MAINTENANCE METHODS

  /**
   * Update trending scores (should be called periodically)
   */
  async updateTrendingScores(): Promise<void> {
    try {
      await Promise.all([
        supabase.rpc('update_hashtag_trending_scores'),
        supabase.rpc('update_trending_posts')
      ]);
    } catch (error) {
      debug.error('Failed to update trending scores:', error);
    }
  }

  /**
   * Reset daily counters (should be called daily)
   */
  async resetDailyCounters(): Promise<void> {
    try {
      await supabase.rpc('reset_daily_hashtag_counters');
    } catch (error) {
      debug.error('Failed to reset daily counters:', error);
    }
  }

  // PRIVATE HELPER METHODS

  private calculateTrend(changePercent: number): 'up' | 'down' | 'stable' {
    if (changePercent > 5) return 'up';
    if (changePercent < -5) return 'down';
    return 'stable';
  }

  private getInstanceStatus(instance: any): 'online' | 'slow' | 'offline' | 'unknown' {
    if (!instance.last_seen_at) return 'unknown';
    const lastSeen = new Date(instance.last_seen_at);
    const hoursSince = (Date.now() - lastSeen.getTime()) / (1000 * 60 * 60);
    
    if (hoursSince < 24) return 'online';
    if (hoursSince < 24 * 7) return 'slow';
    // Beyond a week without federation activity - we don't actually know;
    // the instance may be fine, we just haven't exchanged data recently.
    return 'unknown';
  }

  private maxTimestamp(a?: string | null, b?: string | null): string | null {
    if (!a && !b) return null;
    if (!a) return b ?? null;
    if (!b) return a;
    return new Date(a) >= new Date(b) ? a : b;
  }

  private async getInstancePostCount(domain: string): Promise<number> {
    try {
      const { count } = await supabase
        .from('posts')
        .select('*, author:profiles!inner(domain)', { count: 'exact', head: true })
        .eq('author.domain', domain);
      
      return count || 0;
    } catch {
      return 0;
    }
  }

  private async getInstanceUserCount(domain: string): Promise<number> {
    try {
      const { count } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('domain', domain);
      
      return count || 0;
    } catch {
      return 0;
    }
  }

  private getTimeThreshold(timeRange: string): string {
    const now = new Date();
    switch (timeRange) {
      case '1h':
        return new Date(now.getTime() - 60 * 60 * 1000).toISOString();
      case '6h':
        return new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
      case '24h':
        return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      case '7d':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      case '30d':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
      default:
        return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    }
  }

  private getDaysForTimeRange(timeRange: ExploreFilters['timeRange'] = '24h'): number {
    switch (timeRange) {
      case '1h':
      case '6h':
        return 1;
      case '24h':
        return 1;
      case '7d':
        return 7;
      case '30d':
        return 30;
      default:
        return 1;
    }
  }

  private transformDatabasePostToTimelinePost(post: any): TimelinePost {
    // Convert database post format to TimelinePost format
    // This matches the logic from the ActivityPub store
    let processedContent = post.content;
    
    if (typeof post.content === 'string') {
      processedContent = [{ type: 'text', text: post.content }];
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
      author: post.author ? ({
        id: post.author.id,
        username: post.author.username,
        domain: post.author.domain || import.meta.env.VITE_DOMAIN as string,
        handle: `@${post.author.username}${post.author.domain && post.author.domain !== import.meta.env.VITE_DOMAIN as string ? '@' + post.author.domain : ''}`,
        display_name: post.author.display_name || post.author.username,
        avatar_url: post.author.avatar_url || '/default_avatar.webp',
        bio: post.author.bio || '',
        is_local: !post.author.domain || post.author.domain === import.meta.env.VITE_DOMAIN as string,
        verified: post.author.verified || false,
        followers_count: 0, // Would need separate query
        following_count: 0, // Would need separate query
        posts_count: 0, // Would need separate query
        created_at: post.author.created_at,
        updated_at: post.author.updated_at || post.author.created_at
      } as any) : {
        id: post.author_id,
        username: 'Unknown',
        domain: import.meta.env.VITE_DOMAIN as string,
        handle: '@Unknown',
        display_name: 'Unknown User',
        avatar_url: '/default_avatar.webp',
        bio: '',
        is_local: true,
        verified: false,
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
}

// Export singleton instance
export const trendingService = new TrendingService(); 