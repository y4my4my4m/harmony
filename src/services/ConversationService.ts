import { supabase } from '@/supabase';
import type { ActivityPubPost, ConversationThread } from '@/types';
import { debug } from '@/utils/debug'
/**
 * ConversationService - Professional ActivityPub conversation threading system
 * 
 * Uses conversation_root_id for O(1) lookups like Twitter/X, Mastodon, Misskey
 * No more recursive CTEs - all operations are highly optimized
 * Separate from DM conversations table - this is for ActivityPub posts only
 */
export class ConversationService {
  
  /**
   * Find the root post of an ActivityPub conversation thread - O(1) operation
   * Uses denormalized conversation_root_id for instant lookups
   */
  static async findConversationRoot(postId: string): Promise<string> {
    debug.log(`Finding ActivityPub conversation root for post: ${postId} (O(1) lookup)`);
    
    try {
      // O(1) lookup using conversation_root_id - no recursive queries!
      const { data, error } = await supabase.rpc('get_activitypub_conversation_root', {
        post_id: postId
      });
      
      if (error) {
        debug.error('Error finding ActivityPub conversation root:', error);
        return postId; // Fallback to original post
      }
      
      const rootId = data?.[0]?.root_id || postId;
      debug.log(`Found ActivityPub conversation root: ${rootId} (instant lookup)`);
      return rootId;
      
    } catch (error) {
      debug.error('Exception finding ActivityPub conversation root:', error);
      return postId; // Fallback to original post
    }
  }
  
  /**
   * Get the complete ActivityPub conversation thread - O(log n) operation
   * Uses indexed conversation_root_id for fast retrieval
   */
  static async getConversationThread(conversationRootId: string): Promise<ConversationThread> {
    debug.log(`Loading ActivityPub conversation thread: ${conversationRootId} (indexed lookup)`);
    
    try {
      // O(log n) lookup using indexed conversation_root_id
      const { data, error } = await supabase.rpc('get_activitypub_conversation_thread', {
        in_conversation_root_id: conversationRootId
      });
      
      if (error) {
        debug.error('Error loading ActivityPub conversation thread:', error);
        throw error;
      }
      
      const posts = data || [];
      debug.log(`Loaded ${posts.length} posts in ActivityPub conversation (fast indexed lookup)`);
      
      return {
        id: conversationRootId,
        root_post: posts.find((p: any) => p.reply_context === null) || posts[0],
        posts: posts,
        reply_count: posts.length - 1,
        participant_count: 0,
        last_updated: posts[0]?.created_at || new Date().toISOString(),
      } as ConversationThread;
      
    } catch (error) {
      debug.error('Failed to load ActivityPub conversation thread:', error);
      throw error;
    }
  }
  
  /**
   * Get ActivityPub conversation context and metadata - O(1) operation
   * Fast statistics lookup using conversation_root_id index
   */
  static async getConversationContext(postId: string) {
    debug.log(`Getting ActivityPub conversation context for: ${postId}`);
    
    try {
      const { data, error } = await supabase.rpc('get_activitypub_conversation_context', {
        post_id: postId
      });
      
      if (error) {
        debug.error('Error getting ActivityPub conversation context:', error);
        return null;
      }
      
      const context = data?.[0];
      debug.log(`Got ActivityPub conversation context:`, context);
      return context;
      
    } catch (error) {
      debug.error('Failed to get ActivityPub conversation context:', error);
      return null;
    }
  }
  
  /**
   * Build a hierarchical tree structure from flat thread posts
   * Organizes replies under their parent posts for nested display
   */
  static buildThreadHierarchy(posts: ActivityPubPost[]): ActivityPubPost[] {
    if (!posts.length) return [];
    
    const postMap = new Map<string, ActivityPubPost & { replies?: ActivityPubPost[] }>();
    const rootPosts: ActivityPubPost[] = [];
    
    // First pass: create map and initialize reply arrays
    posts.forEach(post => {
      postMap.set(post.id, { ...post, replies: [] });
    });
    
    // Second pass: build hierarchy
    posts.forEach(post => {
      const postWithReplies = postMap.get(post.id)!;
      
      if (post.reply_context?.id) {
        const parent = postMap.get(post.reply_context.id);
        if (parent) {
          parent.replies = parent.replies || [];
          parent.replies.push(postWithReplies);
        } else {
          // Parent not in thread, treat as root
          rootPosts.push(postWithReplies);
        }
      } else {
        // No parent, this is a root post
        rootPosts.push(postWithReplies);
      }
    });
    
    const sortReplies = (post: ActivityPubPost & { replies?: ActivityPubPost[] }) => {
      if (post.replies?.length) {
        post.replies.sort((a: any, b: any) => 
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );
        post.replies.forEach(sortReplies);
      }
    };
    
    rootPosts.forEach(sortReplies);
    
    return rootPosts;
  }
  
  /**
   * Generate ActivityPub conversation navigation context
   * Preserves which post was originally clicked for highlighting
   */
  static createNavigationContext(
    conversationRootId: string, 
    clickedPostId?: string,
    highlightPostId?: string
  ) {
    return {
      conversationRootId,
      clickedPostId: clickedPostId || conversationRootId,
      highlightPostId: highlightPostId || clickedPostId,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get ActivityPub conversation navigation data
   * Returns the data needed for navigation without handling routing
   */
  static async getConversationNavigationData(
    postId: string,
    options: {
      highlightPost?: string;
      scrollToPost?: string;
    } = {}
  ): Promise<{
    success: boolean;
    conversationRootId?: string;
    route?: {
      name: string;
      params: { postId: string };
      query: {
        highlight: string;
        from: string;
        t: string;
      };
    };
    fallbackRoute: {
      name: string;
      params: { postId: string };
    };
    error?: any;
  }> {
    debug.log(`Getting conversation navigation data for post: ${postId}`);
    
    try {
      // O(1) lookup to get conversation_root_id
      const conversationRootId = await this.findConversationRoot(postId);

      debug.log(`Conversation root ID: ${conversationRootId}`);
      
      const context = this.createNavigationContext(
        conversationRootId,
        postId,
        options.highlightPost || postId
      );
      
      return {
        success: true,
        conversationRootId,
        route: {
          name: 'PostDetail',
          params: { 
            postId: conversationRootId
          },
          query: {
            highlight: context.highlightPostId || postId,
            from: context.clickedPostId,
            t: context.timestamp.toString()
          }
        },
        fallbackRoute: {
          name: 'PostDetail',
          params: { postId }
        }
      };
      
    } catch (error) {
      debug.error('Failed to get conversation navigation data:', error);
      
      return {
        success: false,
        error: error,
        fallbackRoute: {
          name: 'PostDetail',
          params: { postId }
        }
      };
    }
  }
  
  /**
   * Get ActivityPub conversation context from route query parameters
   * Extracts navigation context for highlighting and scrolling
   */
  static getRouteContext(route: any) {
    return {
      highlightPostId: route.query.highlight as string || null,
      fromPostId: route.query.from as string || null,
      timestamp: route.query.t ? parseInt(route.query.t as string) : null
    };
  }
}

export default ConversationService; 