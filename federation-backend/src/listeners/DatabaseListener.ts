/**
 * Database Listener - Listens for PostgreSQL NOTIFY events
 * 
 * This is how the federation backend knows when to federate content:
 * 1. User creates post → Supabase
 * 2. Database trigger → NOTIFY 'post_created'
 * 3. This listener receives notification
 * 4. Process and federate
 */

import { getSupabaseClient } from '../config/supabase.js';
import { DeliveryQueue } from '../activitypub/DeliveryQueue.js';
import { createPostActivity, createLikeActivity, createAnnounceActivity } from './FederationHandlers.js';
import { handleChannelMessageFederation } from './ChannelMessageHandler.js';
import { handleServerMembershipEvents } from './ServerMembershipHandler.js';
import { logger } from '../utils/logger.js';

/**
 * Start listening to database notifications
 */
export async function startDatabaseListener(): Promise<void> {
  logger.info('🔊 Starting database notification listener...');

  const supabase = getSupabaseClient();

  // Subscribe to real-time changes for federation events
  const channel = supabase
    .channel('federation-events')
    
    // Channel messages (smart routed)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'messages',
        filter: 'channel_id=neq.null',
      },
      async (payload) => {
        if (payload.eventType === 'INSERT') {
          // Trigger will handle notification if needed
          // This is just for logging
          logger.debug('📝 Channel message created:', payload.new.id);
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'posts',
        filter: 'is_local=eq.true',
      },
      async (payload) => {
        logger.info('📝 New post detected:', payload.new.id);
        await handleNewPost(payload.new);
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'post_interactions',
        filter: 'interaction_type=eq.emoji_reaction',
      },
      async (payload) => {
        logger.info('❤️  New reaction detected:', payload.new.id);
        await handleNewReaction(payload.new);
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'follows',
      },
      async (payload) => {
        logger.info('👥 New follow detected:', payload.new.id);
        await handleNewFollow(payload.new);
      }
    )
    .subscribe((status, err) => {
      logger.info(`📡 Realtime subscription status: ${status}`);
      
      if (err) {
        logger.error('❌ Realtime subscription error:', err);
      }
      
      if (status === 'SUBSCRIBED') {
        logger.info('✅ Database listener active - watching for federation events');
      } else if (status === 'CHANNEL_ERROR') {
        logger.error('❌ Database listener channel error');
      } else if (status === 'TIMED_OUT') {
        logger.error('❌ Database listener timed out');
      } else if (status === 'CLOSED') {
        logger.warn('⚠️  Database listener closed');
      }
    });

  logger.info('🎧 Database listener subscribed to federation events');
  
  // Log channel state after a moment
  setTimeout(() => {
    logger.info(`📊 Channel state: ${channel.state}`);
  }, 2000);
}

/**
 * Handle new post creation
 */
async function handleNewPost(post: any): Promise<void> {
  try {
    // Check if post should be federated
    if (!post.is_local || !['public', 'unlisted'].includes(post.visibility)) {
      logger.debug(`Skipping federation for post ${post.id}: not public or local`);
      return;
    }

    logger.info(`🌐 Federating new post: ${post.id}`);

    // Get author profile
    const supabase = getSupabaseClient();
    const { data: author } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', post.author_id)
      .single();

    if (!author) {
      logger.error(`Author not found for post ${post.id}`);
      return;
    }

    // Create ActivityPub activity
    const activity = await createPostActivity(post, author);

    // Broadcast to followers
    await DeliveryQueue.broadcastToFollowers(author.id, activity);

    logger.info(`✅ Post ${post.id} queued for federation`);
  } catch (error) {
    logger.error('Failed to handle new post:', error);
  }
}

/**
 * Handle new reaction
 */
async function handleNewReaction(interaction: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    // Get the post to find its author and URL
    const { data: post } = await supabase
      .from('posts')
      .select('id, author_id, federated_id')
      .eq('id', interaction.post_id)
      .single();

    if (!post || !post.federated_id) {
      logger.debug('Reaction on non-federated post, skipping');
      return;
    }

    // Get user who reacted
    const { data: user } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', interaction.user_id)
      .single();

    if (!user || !user.is_local) {
      logger.debug('Reaction from remote user, skipping');
      return;
    }

    logger.info(`🌐 Federating reaction: ${interaction.emoji_id} on post ${post.id}`);

    // Create Like activity
    const activity = await createLikeActivity(user, post.federated_id, interaction.emoji_id);

    // Send to post author's inbox (if remote)
    const { data: postAuthor } = await supabase
      .from('profiles')
      .select('inbox_url, is_local')
      .eq('id', post.author_id)
      .single();

    if (postAuthor && !postAuthor.is_local && postAuthor.inbox_url) {
      await DeliveryQueue.sendToInbox(postAuthor.inbox_url, activity, user.id);
      logger.info(`✅ Reaction queued for delivery to ${postAuthor.inbox_url}`);
    }
  } catch (error) {
    logger.error('Failed to handle new reaction:', error);
  }
}

/**
 * Handle new follow
 */
async function handleNewFollow(follow: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    // Get follower (must be local)
    const { data: follower } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', follow.follower_id)
      .single();

    if (!follower || !follower.is_local) {
      logger.debug('Follow from remote user, skipping outgoing federation');
      return;
    }

    // Get following (check if remote)
    const { data: following } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', follow.following_id)
      .single();

    if (!following || following.is_local) {
      logger.debug('Follow of local user, no federation needed');
      return;
    }

    logger.info(`🌐 Federating follow: ${follower.username} → ${following.username}`);

    // Import inside function to avoid circular dependency
    const { createFollowActivity } = await import('./FederationHandlers.js');
    const activity = createFollowActivity(follower, following);

    // Send to following's inbox
    if (following.inbox_url) {
      await DeliveryQueue.sendToInbox(following.inbox_url, activity, follower.id);
      logger.info(`✅ Follow request queued for delivery to ${following.inbox_url}`);
    }
  } catch (error) {
    logger.error('Failed to handle new follow:', error);
  }
}

