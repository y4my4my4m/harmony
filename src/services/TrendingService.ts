import { supabase } from '@/supabase';
import type { TimelinePost, FederatedUser } from '@/types';
import { debug } from '@/utils/debug'
import { runtimeConfig } from '@/services/runtimeConfig'

// INTERFACES

export interface TrendingHashtag {
  tag: string;
  daily_uses: number;
  weekly_uses: number;
  /** Distinct authors using the tag in the window; 0 where the source does not count them. */
  unique_users: number;
  trending_score: number;
  trending_rank: number;
  change_percent: number;
  trend: 'up' | 'down' | 'stable';
}

export interface TrendingUser {
  user: FederatedUser;
  trending_rank: number;
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
  offset?: number;
  days?: number;
  /** Time window in hours. Takes precedence over `days` for hashtag queries. */
  hours?: number;
  includeLocal?: boolean;
  includeFederated?: boolean;
  instance?: string;
}

export type TrendingTimeRange = '1h' | '6h' | '24h' | '7d' | '30d';

export const TRENDING_TIME_RANGE_HOURS: Record<TrendingTimeRange, number> = {
  '1h': 1,
  '6h': 6,
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

/** Last row of a get_trending_posts page: score, created_at and id as returned. */
export interface TrendingCursor {
  score: number;
  createdAt: string;
  id: string;
}

export interface TrendingPostsQuery {
  timeRange?: TrendingTimeRange;
  /** Images or video in media_attachments or as content file parts (post_has_profile_media). */
  mediaOnly?: boolean;
  /** Posts made on this instance. */
  localOnly?: boolean;
  /** Authors on this domain. */
  domain?: string | null;
  limit?: number;
  /** Ranking instant returned by the first page; later pages pass it back. */
  asOf?: string | null;
  /** Cursor returned by the previous page; the page continues after that row. */
  after?: TrendingCursor | null;
}

export interface TrendingPostsPage {
  posts: TimelinePost[];
  asOf: string | null;
  cursor: TrendingCursor | null;
  hasMore: boolean;
}

class TrendingService {
  
  // HASHTAG TRENDING METHODS

  /** Throws on a failed request. */
  async getTrendingHashtags(options: TrendingOptions = {}): Promise<TrendingHashtag[]> {
    const { limit = 20 } = options;
    // Prefer an explicit hours window; fall back to days (legacy callers) → hours.
    const hours = options.hours ?? (options.days ? options.days * 24 : 168);

    const { data, error } = await supabase.rpc('get_trending_hashtags', {
      p_hours: hours,
      p_limit: limit
    });

    if (error) {
      debug.error('Failed to get trending hashtags:', error);
      throw error;
    }

    return (data || []).map((row: any, index: number) => ({
      tag: row.tag,
      daily_uses: Number(row.uses_count) || 0,
      weekly_uses: Number(row.uses_count) || 0,
      unique_users: Number(row.unique_users) || 0,
      trending_score: Number(row.uses_count) || 0,
      trending_rank: index + 1,
      change_percent: Number(row.change_percent) || 0,
      trend: (row.trend === 'rising' ? 'up' : row.trend === 'falling' ? 'down' : 'stable') as 'up' | 'down' | 'stable'
    }));
  }

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
        unique_users: 0,
        trending_score: parseFloat(row.trending_score) || 0,
        trending_rank: row.trending_rank || 999,
        change_percent: 0, // not computed by this query
        trend: 'stable' as const
      }));
    } catch (error) {
      debug.error('Failed to search hashtags:', error);
      return [];
    }
  }

  // TRENDING POSTS METHODS

  /**
   * One page of get_trending_posts. The first page passes no asOf; the returned asOf pins the
   * window and scores, and the returned cursor marks where the next page starts. Paging by
   * cursor rather than offset neither skips nor repeats rows when a row of an earlier page
   * is deleted or its counts change. Throws on a failed request.
   */
  async getTrendingPosts(query: TrendingPostsQuery = {}): Promise<TrendingPostsPage> {
    const limit = query.limit ?? 20;
    const args: Record<string, unknown> = {
      p_hours: TRENDING_TIME_RANGE_HOURS[query.timeRange ?? '24h'],
      p_media_only: query.mediaOnly ?? false,
      p_local_only: query.localOnly ?? false,
      p_domain: query.domain || null,
      p_limit: limit,
      p_offset: 0,
      p_as_of: query.asOf ?? null,
    };
    // Cursor arguments exist from migration 20261005300001; first pages omit them.
    if (query.after) {
      args.p_after_score = query.after.score;
      args.p_after_created_at = query.after.createdAt;
      args.p_after_id = query.after.id;
    }

    const { data, error } = await supabase.rpc('get_trending_posts', args);

    if (error) {
      debug.error('Failed to get trending posts:', error);
      throw error;
    }

    const rows: any[] = data || [];
    const last = rows[rows.length - 1];
    return {
      posts: rows.map(row => this.transformDatabasePostToTimelinePost(row)),
      asOf: rows[0]?.as_of ?? query.asOf ?? null,
      cursor: last ? { score: last.score, createdAt: last.created_at, id: last.id } : null,
      hasMore: rows.length === limit,
    };
  }

  async getPostsByHashtag(
    hashtag: string, 
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ posts: TimelinePost[]; hasMore: boolean; cursor: string | null }> {
    try {
      const { limit = 20, cursor } = options;
      const normalizedTag = hashtag.toLowerCase().replace(/^#/, '');

      debug.log(`Looking for hashtag: "${normalizedTag}" (original: "${hashtag}")`);

      // Step 1: resolve the hashtag ID from normalized_tag, else tag.
      let hashtagData: { id: string } | null = null;
      let hashtagError: any = null;

      const { data: data1 } = await supabase
        .from('hashtags')
        .select('id')
        .eq('normalized_tag', normalizedTag)
        .maybeSingle();

      if (data1) {
        hashtagData = data1;
      } else {
        // Fallback: unnormalized `tag` column.
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
        debug.log(`Hashtag not found in DB: ${normalizedTag}`);
        return { posts: [], hasMore: false, cursor: null };
      }

      debug.log(`Found hashtag ID: ${hashtagData.id}`);

      // Step 2: post IDs carrying this hashtag.
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

      debug.log(`Found ${postHashtags?.length || 0} post_hashtags entries`);

      if (!postHashtags || postHashtags.length === 0) {
        debug.log(`No posts found for hashtag ${normalizedTag}`);
        return { posts: [], hasMore: false, cursor: null };
      }

      const postIds = postHashtags.slice(0, limit).map(ph => ph.post_id);
      debug.log(`Post IDs: ${postIds.join(', ')}`);

      // Step 3: fetch those posts, excluding deleted.
      const { data: postsData, error: postsError } = await supabase
        .from('posts')
        .select(`
          *,
          author:profiles(*)
        `)
        .in('id', postIds)
        .eq('is_deleted', false);

      if (postsError) throw postsError;

      debug.log(`Fetched ${postsData?.length || 0} posts from DB`);

      // Preserve post_hashtags ordering; the `in` query returns rows unordered.
      const postsMap = new Map((postsData || []).map(p => [p.id, p]));
      const orderedPosts = postIds
        .map(id => postsMap.get(id))
        .filter(Boolean)
        .map((post: any) => this.transformDatabasePostToTimelinePost(post));

      debug.log(`Returning ${orderedPosts.length} posts for #${normalizedTag}`);

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
   * Discoverable, unsilenced accounts by follower count, the caller excluded. Auth lookup
   * goes through AuthContextService's cache. Throws on a failed request.
   */
  async getTrendingUsers(options: TrendingOptions = {}): Promise<TrendingUser[]> {
    const { limit = 10, offset = 0, instance, includeLocal = true, includeFederated = true } = options;

    // Exclusion key is profiles.id, not the auth UUID; the two differ, and
    // comparing the auth UUID leaves the current user in their own
    // suggested follows.
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
      .eq('is_suspended', false)
      .not('is_silenced', 'is', true)
      // AP `discoverable: false` opts an account out of discovery surfaces.
      .not('federation_discoverable', 'is', false);

    // "All Instances" includes federated users; narrow to one domain only
    // when a domain is explicitly selected.
    if (instance && instance !== 'all') {
      query = query.eq('domain', instance);
    } else if (includeLocal && !includeFederated) {
      // "This instance" only. Filters on is_local so local users with a NULL
      // domain are included; they do not match domain = runtimeConfig.domain.
      query = query.eq('is_local', true);
    } else if (!includeLocal && includeFederated) {
      query = query.eq('is_local', false);
    }

    if (currentUserId) {
      query = query.neq('id', currentUserId);
    }

    // id breaks follower-count ties so offset pages neither overlap nor skip.
    query = query
      .order('followers_count', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1);

    const { data, error } = await query;
    if (error) {
      debug.error('Failed to get trending users:', error);
      throw error;
    }

    const localDomain = runtimeConfig.domain as string;
    return (data || []).map((row: any, index: number) => ({
      user: {
        id: row.id,
        username: row.username,
        domain: row.domain || localDomain,
        handle: `@${row.username}${row.domain && row.domain !== localDomain ? '@' + row.domain : ''}`,
        display_name: row.display_name || row.username,
        avatar_url: row.avatar_url || '/default_avatar.webp',
        bio: row.bio || '',
        is_local: row.domain === localDomain || !row.domain,
        verified: false,
        followers_count: row.followers_count || 0,
        following_count: row.following_count || 0,
        posts_count: row.posts_count || 0,
        created_at: row.created_at,
        updated_at: row.updated_at || row.created_at
      },
      trending_rank: offset + index + 1,
    }));
  }

  // INSTANCE DISCOVERY METHODS

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
   * Cached federated_instances row lookup by domain. Callers needing only
   * icon_url / software, such as instance badges, use this instead of
   * getInstanceStats.
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

  async getInstanceStats(domain: string): Promise<any | null> {
    try {
      const { data, error } = await supabase
        .from('federated_instances')
        .select('*')
        .eq('domain', domain)
        .single();

      if (error || !data) return null;

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

  // MAINTENANCE METHODS

  /** Caller schedules this; nothing here runs it periodically. */
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
    // Beyond a week without federation activity the state is unknown: no data
    // has been exchanged recently, which says nothing about the instance.
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

  private transformDatabasePostToTimelinePost(post: any): TimelinePost {
    // Mirrors the row → TimelinePost conversion in the ActivityPub store.
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
        domain: post.author.domain || runtimeConfig.domain as string,
        handle: `@${post.author.username}${post.author.domain && post.author.domain !== runtimeConfig.domain as string ? '@' + post.author.domain : ''}`,
        display_name: post.author.display_name || post.author.username,
        avatar_url: post.author.avatar_url || '/default_avatar.webp',
        bio: post.author.bio || '',
        is_local: !post.author.domain || post.author.domain === runtimeConfig.domain as string,
        verified: post.author.verified || false,
        followers_count: 0, // counts are not selected by this query
        following_count: 0,
        posts_count: 0,
        created_at: post.author.created_at,
        updated_at: post.author.updated_at || post.author.created_at
      } as any) : {
        id: post.author_id,
        username: 'Unknown',
        domain: runtimeConfig.domain as string,
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
      // Reblog data, JSONB on the row.
      reblog: post.reblog || undefined,
      reblog_author: post.reblog_author || undefined,
      // Interaction states arrive only from RPC-sourced rows; default false.
      is_favorited: post.is_favorited || false,
      is_reblogged: post.is_reblogged || false,
      is_bookmarked: post.is_bookmarked || false
    };
  }
}

export const trendingService = new TrendingService(); 