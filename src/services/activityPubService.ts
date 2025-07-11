// ActivityPub Service - Core federation functionality
// Professional, scalable, and DRY implementation
import { supabase } from '@/supabase';
import { federationService } from './FederationService';
import { trendingService } from './TrendingService';
import type { 
  Post, 
  Follow, 
  PostInteraction, 
  FederatedUser, 
  TimelineOptions,
  TimelinePost,
  ActivityPubActivityType,
  ActivityPubObjectType
} from '@/types';

/**
 * Core ActivityPub service for federation functionality
 * Handles posts, follows, and ActivityPub protocol compliance
 */
export class ActivityPubService {
  private static instance: ActivityPubService;
  private currentDomain: string;
  private instanceUrl: string;

  constructor() {
    this.currentDomain = import.meta.env.VITE_DOMAIN || 'har.mony.lol';
    this.instanceUrl = `https://${this.currentDomain}`;
  }

  static getInstance(): ActivityPubService {
    if (!ActivityPubService.instance) {
      ActivityPubService.instance = new ActivityPubService();
    }
    return ActivityPubService.instance;
  }

  // =============================================
  // POST MANAGEMENT
  // =============================================

  /**
   * Create a new post (Mony)
   */
  async createPost(postData: {
    content: any[];
    visibility: Post['visibility'];
    content_warning?: string;
    in_reply_to?: string;
    media_attachments?: any[];
    is_sensitive?: boolean;
    language?: string;
  }): Promise<Post> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    // Validate and normalize content format
    let normalizedContent = postData.content;
    if (!Array.isArray(normalizedContent)) {
      console.warn('⚠️ Content is not an array, normalizing:', typeof normalizedContent);
      normalizedContent = [{ type: 'text', text: String(normalizedContent || '') }];
    }

    const post = {
      author_id: user.id,
      content: normalizedContent,
      visibility: postData.visibility,
      content_warning: postData.content_warning,
      in_reply_to: postData.in_reply_to,
      media_attachments: postData.media_attachments || [],
      is_sensitive: postData.is_sensitive || false,
      language: postData.language || 'en',
      ap_type: 'Note',
      is_local: true,
      is_federated: true,
      metadata: {}
    };

    // Insert the post first
    const { data: insertedPost, error: insertError } = await supabase
      .from('posts')
      .insert(post)
      .select('*')
      .single();

    if (insertError) throw insertError;

    // Generate ActivityPub ID for local posts
    if (insertedPost.is_local) {
      const ap_id = `https://${this.currentDomain}/posts/${insertedPost.id}`;
      const url = ap_id;

      const { error: updateError } = await supabase
        .from('posts')
        .update({ ap_id, url })
        .eq('id', insertedPost.id);

      if (updateError) throw updateError;

      insertedPost.ap_id = ap_id;
      insertedPost.url = url;
    }

    // Now fetch the complete post with author information
    const { data: completePost, error: fetchError } = await supabase
      .from('posts')
      .select(`
        *,
        author:profiles (
          id, username, display_name, domain, avatar_url, is_local
        )
      `)
      .eq('id', insertedPost.id)
      .single();

    if (fetchError) throw fetchError;

    // 🌐 FEDERATION: Queue post for federation to remote instances
      if (completePost.is_local && completePost.visibility === 'public') {
        try {
          // Ensure we pass the user UUID, not username
          const authorForFederation = {
            ...completePost.author,
            id: user.id // Ensure we use the UUID from auth, not username
          };
          
          const activityId = await federationService.federatePost(completePost, authorForFederation);
          console.log(`🚀 Post ${completePost.id} queued for federation: ${activityId}`);
        } catch (federationError) {
          console.error('❌ Federation failed for post:', federationError);
          // Continue - federation failure shouldn't prevent local post creation
        }
      }

    return completePost as Post;
  }

  /**
   * Get timeline posts
   */
  async getTimeline(
    timelineType: 'home' | 'public' | 'local' = 'home',
    options: TimelineOptions = {}
  ): Promise<TimelinePost[]> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    const limit = options.limit || 20;
    
    let query = supabase
      .from('timeline_entries')
      .select(`
        posts (
          *,
          author:profiles!posts_author_id_fkey (
            id, username, display_name, domain, avatar_url, is_local
          )
        )
      `)
      .eq('user_id', user.id)
      .eq('timeline_type', timelineType)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (options.max_id) {
      query = query.lt('position', options.max_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    return (data?.map((entry: any) => entry.posts).filter(Boolean) || []) as unknown as TimelinePost[];
  }

  /**
   * Get public timeline - clean and professional
   */
  async getPublicTimeline(options: TimelineOptions = {}): Promise<TimelinePost[]> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    const limit = options.limit || 20;
    const max_id = options.max_id || null;

    const { data, error } = await supabase.rpc('get_timeline_posts_with_interactions', {
      p_user_id: user.id,
      p_timeline_type: 'public',
      p_limit: limit,
      p_max_id: max_id
    });

    if (error) throw error;

    console.log(`📊 Public timeline loaded: ${data?.length || 0} posts`);
    
    return data || [];
  }

  /**
   * Get public timeline with enhanced federation support
   */
  async getEnhancedPublicTimeline(options: TimelineOptions = {}): Promise<TimelinePost[]> {
    const limit = options.limit || 20;
    
    try {
      // First, get a mixed feed of both local and federated posts
      let query = supabase
        .from('posts')
        .select(`
          *,
          author:profiles!posts_author_id_fkey (
            id, username, display_name, domain, avatar_url, is_local, bio
          )
        `)
        .eq('visibility', 'public')
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (options.max_id) {
        query = query.lt('created_at', new Date(options.max_id).toISOString());
      }

      const { data, error } = await query;
      if (error) throw error;

      // Transform and return the posts
      const posts = (data || []).map(post => this.transformDatabasePostToTimelinePost(post));
      
      // Log statistics
      const localCount = posts.filter(p => p.is_local).length;
      const federatedCount = posts.filter(p => !p.is_local).length;
      console.log(`🌐 Enhanced public timeline: ${localCount} local + ${federatedCount} federated = ${posts.length} total posts`);
      
      return posts;
    } catch (error) {
      console.error('Failed to load enhanced public timeline:', error);
      return [];
    }
  }

  /**
   * Get federated timeline (remote posts only)
   */
  async getFederatedTimeline(options: TimelineOptions = {}): Promise<TimelinePost[]> {
    const limit = options.limit || 20;
    
    let query = supabase
      .from('posts')
      .select(`
        *,
        author:profiles!posts_author_id_fkey (
          id, username, display_name, domain, avatar_url, is_local
        )
      `)
      .eq('visibility', 'public')
      .eq('is_deleted', false)
      .eq('is_local', false)  // Only federated posts
      .order('created_at', { ascending: false })
      .limit(limit);

    if (options.max_id) {
      query = query.lt('created_at', new Date(options.max_id).toISOString());
    }

    const { data, error } = await query;
    if (error) throw error;

    console.log(`🌐 Federated timeline loaded: ${data?.length || 0} posts from remote instances`);
    return data as TimelinePost[];
  }

  /**
   * Get local timeline - Supabase-native caching
   */
  async getLocalTimeline(options: TimelineOptions = {}): Promise<TimelinePost[]> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    const limit = options.limit || 20;

    // Try cache first - super fast!
    const { data: cached, error: cacheError } = await supabase
      .rpc('get_cached_timeline', {
        p_user_id: user.id,
        p_timeline_type: 'local',
        p_limit: limit
      });

    if (!cacheError && cached?.cached) {
      console.log(`📦 Serving local timeline from cache: ${cached.count} posts`);
      return cached.posts || [];
    }

    // Cache miss - fall back to database with caching
    console.log('🔄 Cache miss - building local timeline');
    const { data, error } = await supabase.rpc('get_timeline_posts_with_interactions', {
      p_user_id: user.id,
      p_timeline_type: 'local', 
      p_limit: limit,
      p_max_id: options.max_id || null
    });

    if (error) throw error;

    // Cache the results for next time
    if (data && data.length > 0) {
      await supabase.rpc('update_timeline_cache', {
        p_user_id: user.id,
        p_timeline_type: 'local',
        p_action: 'rebuild'
      });
    }

    console.log(`📊 Local timeline loaded: ${data?.length || 0} posts`);
    return data || [];
  }

  // =============================================
  // EXPLORE AND DISCOVERY METHODS
  // =============================================

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
        return await this.searchFederatedUsers(query, limit);
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
          author:profiles!posts_author_id_fkey (
            id, username, display_name, domain, avatar_url, is_local
          )
        `)
        .textSearch('content', query)
        .eq('visibility', 'public')
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return data as TimelinePost[];
    } catch (error) {
      console.error('Failed to search posts:', error);
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
   * Get recent activity from an instance
   */
  async getInstanceActivity(
    domain: string, 
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ posts: TimelinePost[]; hasMore: boolean; cursor: string | null }> {
    try {
      const { limit = 20, cursor } = options;

      let query = supabase
        .from('posts')
        .select(`
          *,
          author:profiles!posts_author_id_fkey (
            id, username, display_name, domain, avatar_url, is_local
          )
        `)
        .eq('author.domain', domain)
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
      const nextCursor = hasMore ? data![data!.length - 2].created_at : null;

      return { posts, hasMore, cursor: nextCursor };
    } catch (error) {
      console.error('Failed to get instance activity:', error);
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
    
    let query = supabase
      .from('posts')
      .select(`
        *,
        author:profiles!posts_author_id_fkey (
          id, username, display_name, domain, avatar_url, is_local
        )
      `)
      .eq('author_id', userId)
      .eq('is_deleted', false)
      .in('visibility', ['public', 'unlisted'])
      .order('created_at', { ascending: false })
      .limit(limit);

    if (options.max_id) {
      query = query.lt('created_at', new Date(options.max_id).toISOString());
    }

    const { data, error } = await query;
    if (error) throw error;

    return data as Post[];
  }

  /**
   * Get post by ID
   */
  async getPost(postId: string): Promise<Post | null> {
    const { data, error } = await supabase
      .from('posts')
      .select(`
        *,
        author:profiles!posts_author_id_fkey (
          id, username, display_name, domain, avatar_url, is_local
        )
      `)
      .eq('id', postId)
      .eq('is_deleted', false)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      throw error;
    }

    return data as Post;
  }

  /**
   * Delete a post
   */
  async deletePost(postId: string): Promise<void> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    // Get original post to verify ownership and get author info
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

    // 🌐 FEDERATION: Queue delete activity for federation using new FederationService
    if (originalPost.is_local && originalPost.visibility === 'public') {
      try {
        const activityId = await federationService.federatePostDelete(postId, originalPost.author);
        console.log(`🗑️ Post deletion ${postId} queued for federation: ${activityId}`);
      } catch (federationError) {
        console.error('❌ Federation failed for post deletion:', federationError);
      }
    }
  }

  // =============================================
  // FOLLOW MANAGEMENT
  // =============================================

  /**
   * Follow a user
   */
  async followUser(targetUserId: string): Promise<Follow> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    if (user.id === targetUserId) {
      throw new Error('Cannot follow yourself');
    }

    const follow = {
      follower_id: user.id,
      following_id: targetUserId,
      status: 'accepted', // Auto-accept for now, can be changed for locked accounts
      is_local: true,
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

    // 🌐 FEDERATION: Queue follow activity
    try {
      await federationService.federateFollow(user.id, targetUserId, true);
    } catch (federationError) {
      console.error('❌ Federation failed for follow:', federationError);
    }

    return data as Follow;
  }

  /**
   * Unfollow a user
   */
  async unfollowUser(targetUserId: string): Promise<void> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    const { error } = await supabase
      .from('follows')
      .delete()
      .eq('follower_id', user.id)
      .eq('following_id', targetUserId);

    if (error) throw error;

    // 🌐 FEDERATION: Queue unfollow activity
    try {
      await federationService.federateFollow(user.id, targetUserId, false);
    } catch (federationError) {
      console.error('❌ Federation failed for unfollow:', federationError);
    }
  }

  /**
   * Get user's followers
   */
  async getFollowers(userId: string, options: TimelineOptions = {}): Promise<FederatedUser[]> {
    const limit = options.limit || 20;
    
    const { data, error } = await supabase
      .from('follows')
      .select(`
        follower:profiles!follows_follower_id_fkey (
          id, username, display_name, domain, avatar_url, is_local
        )
      `)
      .eq('following_id', userId)
      .eq('status', 'accepted')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return (data?.map((follow: any) => ({
      ...follow.follower,
      handle: this.formatUserHandle(follow.follower.username, follow.follower.domain)
    })) || []) as unknown as FederatedUser[];
  }

  /**
   * Get users that a user is following
   */
  async getFollowing(userId: string, options: TimelineOptions = {}): Promise<FederatedUser[]> {
    const limit = options.limit || 20;
    
    const { data, error } = await supabase
      .from('follows')
      .select(`
        following:profiles!follows_following_id_fkey (
          id, username, display_name, domain, avatar_url, is_local
        )
      `)
      .eq('follower_id', userId)
      .eq('status', 'accepted')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return (data?.map((follow: any) => ({
      ...follow.following,
      handle: this.formatUserHandle(follow.following.username, follow.following.domain)
    })) || []) as unknown as FederatedUser[];
  }

  /**
   * Check if user is following another user
   */
  async isFollowing(targetUserId: string): Promise<boolean> {
    const { data: { user } } = await supabase.auth.getUser();
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

  // =============================================
  // POST INTERACTIONS
  // =============================================

  /**
   * Toggle favorite (like) status for a post
   */
  async toggleFavorite(postId: string): Promise<{ favorited: boolean; interaction?: PostInteraction }> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    // Check if already favorited
    const { data: existing } = await supabase
      .from('post_interactions')
      .select('id')
      .eq('user_id', user.id)
      .eq('post_id', postId)
      .eq('interaction_type', 'favorite')
      .single();

    if (existing) {
      // Remove favorite
      await this.unfavoritePost(postId);
      
      // 🌐 FEDERATION: Queue unlike activity
      try {
        await federationService.federateLike(postId, user.id, false);
      } catch (federationError) {
        console.error('❌ Federation failed for unlike:', federationError);
      }
      
      return { favorited: false };
    } else {
      // Add favorite
      const interaction = await this.favoritePost(postId);
      
      // 🌐 FEDERATION: Queue like activity
      try {
        await federationService.federateLike(postId, user.id, true);
      } catch (federationError) {
        console.error('❌ Federation failed for like:', federationError);
      }
      
      return { favorited: true, interaction };
    }
  }

  /**
   * Favorite (like) a post
   */
  async favoritePost(postId: string): Promise<PostInteraction> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    const interaction = {
      user_id: user.id,
      post_id: postId,
      interaction_type: 'favorite' as const,
      is_local: true,
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
    const { data: { user } } = await supabase.auth.getUser();
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
   * Toggle reblog (share) status for a post
   */
  async toggleReblog(postId: string): Promise<{ reblogged: boolean; interaction?: PostInteraction }> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    // Check if already reblogged
    const { data: existing } = await supabase
      .from('post_interactions')
      .select('id')
      .eq('user_id', user.id)
      .eq('post_id', postId)
      .eq('interaction_type', 'reblog')
      .single();

    if (existing) {
      // Remove reblog
      await this.unreblogPost(postId);
      return { reblogged: false };
    } else {
      // Add reblog
      const interaction = await this.reblogPost(postId);
      return { reblogged: true, interaction };
    }
  }

  /**
   * Reblog (share) a post
   */
  async reblogPost(postId: string): Promise<PostInteraction> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    const interaction = {
      user_id: user.id,
      post_id: postId,
      interaction_type: 'reblog' as const,
      is_local: true,
      metadata: {}
    };

    const { data, error } = await supabase
      .from('post_interactions')
      .insert(interaction)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new Error('Post already reblogged');
      }
      throw error;
    }

    return data as PostInteraction;
  }

  /**
   * Un-reblog a post
   */
  async unreblogPost(postId: string): Promise<void> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    const { error } = await supabase
      .from('post_interactions')
      .delete()
      .eq('user_id', user.id)
      .eq('post_id', postId)
      .eq('interaction_type', 'reblog');

    if (error) throw error;
  }

  /**
   * Toggle bookmark status for a post
   */
  async toggleBookmark(postId: string): Promise<{ bookmarked: boolean; interaction?: PostInteraction }> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    // Check if already bookmarked
    const { data: existing } = await supabase
      .from('post_interactions')
      .select('id')
      .eq('user_id', user.id)
      .eq('post_id', postId)
      .eq('interaction_type', 'bookmark')
      .single();

    if (existing) {
      // Remove bookmark
      await this.unbookmarkPost(postId);
      return { bookmarked: false };
    } else {
      // Add bookmark
      const interaction = await this.bookmarkPost(postId);
      return { bookmarked: true, interaction };
    }
  }

  /**
   * Bookmark a post
   */
  async bookmarkPost(postId: string): Promise<PostInteraction> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    const interaction = {
      user_id: user.id,
      post_id: postId,
      interaction_type: 'bookmark' as const,
      is_local: true,
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
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    const { error } = await supabase
      .from('post_interactions')
      .delete()
      .eq('user_id', user.id)
      .eq('post_id', postId)
      .eq('interaction_type', 'bookmark');

    if (error) throw error;
  }

  // =============================================
  // USER SEARCH AND DISCOVERY
  // =============================================

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

    return data as FederatedUser[];
  }

  /**
   * Get user profile by handle (@username@domain)
   */
  async getUserByHandle(handle: string): Promise<FederatedUser | null> {
    // Parse handle (@username@domain or @username)
    const cleanHandle = handle.startsWith('@') ? handle.slice(1) : handle;
    const [username, domain] = cleanHandle.includes('@') 
      ? cleanHandle.split('@')
      : [cleanHandle, this.currentDomain];

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
      ...data,
      handle: this.formatUserHandle(data.username, data.domain)
    } as FederatedUser;
  }

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
        last_synced_at: data.last_synced_at
      } as FederatedUser;
    } catch (error) {
      console.error('Failed to resolve user by handle:', error);
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
        handle: data.domain === 'har.mony.lol' 
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
        last_synced_at: data.last_synced_at
      } as FederatedUser;
    } catch (error) {
      console.error('Failed to get user by ID:', error);
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
  ): Promise<TimelinePost[]> {
    const limit = options.limit || 20;
    const max_id = options.max_id || null;

    const { data, error } = await supabase.rpc('get_timeline_posts_with_interactions', {
      p_user_id: userId,
      p_timeline_type: timelineType,
      p_limit: limit,
      p_max_id: max_id
    });

    if (error) throw error;

    return data || [];
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
  async searchFederatedUsers(query: string, limit: number = 10): Promise<FederatedUser[]> {
    const { data, error } = await supabase
      .rpc('search_federated_users', {
        p_query: query,
        p_limit: limit
      });

    if (error) throw error;

    return data?.map((user: any) => ({
      id: user.user_id,
      username: user.username,
      display_name: user.display_name,
      domain: user.domain,
      avatar_url: user.avatar_url,
      handle: user.handle,
      is_local: user.is_local,
      bio: '',
      verified: false,
      followers_count: 0,
      following_count: 0,
      posts_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })) || [];
  }

  // =============================================
  // UTILITY METHODS
  // =============================================

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

  // =============================================
  // REALTIME INTEGRATION
  // =============================================

  /**
   * Subscribe to post realtime updates
   */
  subscribeToPostUpdates(
    onPostCreate?: (post: any) => void,
    onPostUpdate?: (post: any) => void,
    onPostDelete?: (post: any) => void
  ) {
    const channel = supabase
      .channel('activitypub_posts_service')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'posts' },
        (payload) => onPostCreate?.(payload.new)
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'posts' },
        (payload) => onPostUpdate?.(payload.new)
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'posts' },
        (payload) => onPostDelete?.(payload.old)
      )
      .subscribe();

    return channel;
  }

  /**
   * Subscribe to interaction realtime updates
   */
  subscribeToInteractionUpdates(
    onInteractionCreate?: (interaction: any) => void,
    onInteractionDelete?: (interaction: any) => void
  ) {
    const channel = supabase
      .channel('activitypub_interactions_service')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'post_interactions' },
        (payload) => onInteractionCreate?.(payload.new)
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'post_interactions' },
        (payload) => onInteractionDelete?.(payload.old)
      )
      .subscribe();

    return channel;
  }

  /**
   * Subscribe to follow realtime updates
   */
  subscribeToFollowUpdates(
    onFollowCreate?: (follow: any) => void,
    onFollowUpdate?: (follow: any) => void,
    onFollowDelete?: (follow: any) => void
  ) {
    const channel = supabase
      .channel('activitypub_follows_service')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'follows' },
        (payload) => onFollowCreate?.(payload.new)
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'follows' },
        (payload) => onFollowUpdate?.(payload.new)
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'follows' },
        (payload) => onFollowDelete?.(payload.old)
      )
      .subscribe();

    return channel;
  }

  /**
   * Get current interaction state for a post and user
   */
  async getPostInteractionState(postId: string): Promise<{
    is_favorited: boolean;
    is_reblogged: boolean;
    is_bookmarked: boolean;
  }> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { is_favorited: false, is_reblogged: false, is_bookmarked: false };

    const { data: interactions } = await supabase
      .from('post_interactions')
      .select('interaction_type')
      .eq('user_id', user.id)
      .eq('post_id', postId);

    const state = {
      is_favorited: false,
      is_reblogged: false,
      is_bookmarked: false
    };

    interactions?.forEach(interaction => {
      if (interaction.interaction_type === 'favorite') state.is_favorited = true;
      if (interaction.interaction_type === 'reblog') state.is_reblogged = true;
      if (interaction.interaction_type === 'bookmark') state.is_bookmarked = true;
    });

    return state;
  }

  // =============================================
  // ENHANCED ACTIVITY HANDLING
  // =============================================

  /**
   * Update (edit) a post
   */
  async updatePost(postId: string, updates: {
    content?: string;
    content_warning?: string;
    is_sensitive?: boolean;
    media_attachments?: any[];
  }): Promise<Post> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    // Get original post to verify ownership
    const { data: originalPost, error: fetchError } = await supabase
      .from('posts')
      .select('*')
      .eq('id', postId)
      .eq('author_id', user.id)
      .single();

    if (fetchError || !originalPost) {
      throw new Error('Post not found or not owned by user');
    }

    // Prepare update data
    const updateData: any = {
      updated_at: new Date().toISOString()
    };

    if (updates.content !== undefined) {
      updateData.content = this.formatPostContent(updates.content);
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

    // Update post in database
    const { data: updatedPost, error } = await supabase
      .from('posts')
      .update(updateData)
      .eq('id', postId)
      .select()
      .single();

    if (error) throw error;

    // Create Update activity for federation
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
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    // Update follow status
    const { data: follow, error } = await supabase
      .from('follows')
      .update({
        status: 'accepted',
        accepted_at: new Date().toISOString()
      })
      .eq('id', followId)
      .eq('following_id', user.id)
      .eq('status', 'pending')
      .select()
      .single();

    if (error || !follow) {
      throw new Error('Follow request not found or already processed');
    }

    // Create Accept activity for federation
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
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    // Update follow status
    const { data: follow, error } = await supabase
      .from('follows')
      .update({ status: 'rejected' })
      .eq('id', followId)
      .eq('following_id', user.id)
      .eq('status', 'pending')
      .select()
      .single();

    if (error || !follow) {
      throw new Error('Follow request not found or already processed');
    }

    // Create Reject activity for federation
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
  async undoActivity(originalActivityId: string, undoType: 'Follow' | 'Like' | 'Announce'): Promise<void> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    // Get the original activity
    const { data: originalActivity, error } = await supabase
      .from('ap_activities')
      .select('*')
      .eq('id', originalActivityId)
      .eq('actor_id', user.id)
      .single();

    if (error || !originalActivity) {
      throw new Error('Original activity not found');
    }

    // Create Undo activity for federation
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

  // =============================================
  // VOICE CHAT FEDERATION (Harmony Extensions)
  // =============================================

  /**
   * Join a voice channel (federated)
   */
  async joinVoiceChannel(serverId: string, channelId: string, voiceState?: {
    muted?: boolean;
    deafened?: boolean;
    video_enabled?: boolean;
  }): Promise<void> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    // Get server and channel info
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

    // Create VoiceJoin activity for federation
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
            domain: server.domain || 'har.mony.lol'
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
    const { data: { user } } = await supabase.auth.getUser();
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
    const { data: { user } } = await supabase.auth.getUser();
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

  // =============================================
  // SERVER FEDERATION (Harmony Extensions)
  // =============================================

  /**
   * Join a federated server
   */
  async joinFederatedServer(serverDomain: string, inviteCode?: string): Promise<void> {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('User not authenticated');

    // Create Join activity for federation
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
    const { data: { user } } = await supabase.auth.getUser();
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

  // =============================================
  // ACTIVITY CREATION HELPER
  // =============================================

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
    
    // Store activity in database
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
      console.error('Failed to create activity:', error);
      throw error;
    }

    // Queue for delivery to federated instances
    // This would be handled by a background job in production
    console.log(`📤 Queued ${activity.type} activity for federation:`, ap_id);
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

    const domain = profile.domain === 'har.mony.lol' ? this.instanceUrl.replace('https://', '') : profile.domain;
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
      content: this.contentToHtml(post.content),
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
   * Format post content for storage
   */
  private formatPostContent(content: string): any {
    // Format content as JSONB structure similar to messages
    // This matches the expected database schema
    return [
      {
        type: 'text',
        text: content
      }
    ];
  }

  /**
   * Helper: Convert MessagePart[] content to HTML
   */
  private contentToHtml(content: any): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    
    return content.map(part => {
      switch (part.type) {
        case 'text':
          return part.text;
        case 'mention':
          return `<a href="${this.instanceUrl}/users/${part.mention}" class="mention">@${part.mention}</a>`;
        case 'url':
          return `<a href="${part.url}" target="_blank" rel="noopener">${part.url}</a>`;
        default:
          return '';
      }
    }).join('');
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
      author: post.author ? {
        id: post.author.id,
        username: post.author.username,
        display_name: post.author.display_name || post.author.username,
        avatar_url: post.author.avatar_url || '/default_avatar.png',
        domain: post.author.domain || 'har.mony.lol',
        bio: post.author.bio || '',
        is_local: post.author.is_local !== false,
        verified: post.author.verified || false,
        followers_count: 0, // Would need separate query
        following_count: 0, // Would need separate query
        posts_count: 0, // Would need separate query
        created_at: post.author.created_at,
        updated_at: post.author.updated_at || post.author.created_at
      } : {
        id: post.author_id,
        username: 'Unknown',
        display_name: 'Unknown User',
        avatar_url: '/default_avatar.png',
        domain: 'har.mony.lol',
        bio: '',
        is_local: true,
        verified: false,
        followers_count: 0,
        following_count: 0,
        posts_count: 0,
        created_at: post.created_at,
        updated_at: post.created_at
      },
      is_favorited: false, // Would need user context
      is_reblogged: false  // Would need user context
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
        in_reply_to: data.in_reply_to,
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
          avatar_url: data.author.avatar_url || '/default_avatar.png',
          domain: data.author.domain || 'har.mony.lol',
          bio: data.author.bio || '',
          is_local: !data.author.domain || data.author.domain === 'har.mony.lol',
          verified: data.author.verified || false,
          followers_count: 0,
          following_count: 0,
          posts_count: 0,
          created_at: data.author.created_at,
          updated_at: data.author.updated_at,
          handle: data.author.domain && data.author.domain !== 'har.mony.lol' 
            ? `@${data.author.username}@${data.author.domain}` 
            : `@${data.author.username}`
        },
        is_favorited: false,
        is_reblogged: false
      };
    } catch (error) {
      console.error('Failed to load post with author:', error);
      return null;
    }
  }
}

// Export singleton instance
export const activityPubService = ActivityPubService.getInstance();
