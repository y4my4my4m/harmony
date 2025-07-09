// ActivityPub Service - Core federation functionality
// Professional, scalable, and DRY implementation
import { supabase } from '@/supabase';
import type { 
  Post, 
  Follow, 
  PostInteraction, 
  FederatedUser, 
  TimelineOptions,
  TimelinePost
} from '@/types';

/**
 * Core ActivityPub service for federation functionality
 * Handles posts, follows, and ActivityPub protocol compliance
 */
export class ActivityPubService {
  private static instance: ActivityPubService;
  private currentDomain: string;

  constructor() {
    this.currentDomain = import.meta.env.VITE_DOMAIN || 'har.mony.lol';
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

    const post = {
      author_id: user.id,
      content: postData.content,
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

    const { data, error } = await supabase
      .from('posts')
      .insert(post)
      .select(`
        *,
        author:profiles!posts_author_id_fkey (
          id, username, display_name, domain, avatar_url, is_local
        )
      `)
      .single();

    if (error) throw error;

    // Generate ActivityPub ID for local posts
    if (data.is_local) {
      const ap_id = `https://${this.currentDomain}/posts/${data.id}`;
      const url = ap_id;

      await supabase
        .from('posts')
        .update({ ap_id, url })
        .eq('id', data.id);

      data.ap_id = ap_id;
      data.url = url;
    }

    return data as Post;
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
   * Get public timeline (for discovery)
   */
  async getPublicTimeline(options: TimelineOptions = {}): Promise<TimelinePost[]> {
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
      .order('created_at', { ascending: false })
      .limit(limit);

    if (options.max_id) {
      query = query.lt('created_at', new Date(options.max_id).toISOString());
    }

    const { data, error } = await query;
    if (error) throw error;

    return data as TimelinePost[];
  }

  /**
   * Get local timeline (this instance only)
   */
  async getLocalTimeline(options: TimelineOptions = {}): Promise<TimelinePost[]> {
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
      .eq('is_local', true)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (options.max_id) {
      query = query.lt('created_at', new Date(options.max_id).toISOString());
    }

    const { data, error } = await query;
    if (error) throw error;

    return data as TimelinePost[];
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

    const { error } = await supabase
      .from('posts')
      .update({ 
        is_deleted: true, 
        deleted_at: new Date().toISOString() 
      })
      .eq('id', postId)
      .eq('author_id', user.id);

    if (error) throw error;
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
      return { favorited: false };
    } else {
      // Add favorite
      const interaction = await this.favoritePost(postId);
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
    const maxId = options.max_id || null;

    const { data, error } = await supabase
      .rpc('get_user_timeline', {
        p_user_id: userId,
        p_timeline_type: timelineType,
        p_limit: limit,
        p_max_id: maxId
      });

    if (error) throw error;

    return data?.map((post: any) => ({
      id: post.post_id,
      content: post.content,
      author_id: post.author_id,
      created_at: post.created_at,
      visibility: post.visibility,
      replies_count: post.replies_count,
      reblogs_count: post.reblogs_count,
      favorites_count: post.favorites_count,
      in_reply_to: post.in_reply_to,
      media_attachments: post.media_attachments,
      author: {
        id: post.author_id,
        username: post.author_username,
        display_name: post.author_display_name,
        avatar_url: post.author_avatar_url,
        domain: post.author_domain,
        handle: post.author_domain === 'har.mony.lol' 
          ? `@${post.author_username}`
          : `@${post.author_username}@${post.author_domain}`
      },
      interactions: {
        is_favorited: post.is_favorited,
        is_reblogged: post.is_reblogged,
        is_bookmarked: false
      }
    })) || [];
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
}

// Export singleton instance
export const activityPubService = ActivityPubService.getInstance();
