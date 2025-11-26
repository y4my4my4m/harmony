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
    
    // DEBUG: Listen to ALL events on ALL tables to see if realtime works at all
    // Filter out high-frequency tables that create noise (timeline_entries, notifications, ap_activities)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: '*',
      },
      async (payload) => {
        // Skip logging for high-frequency tables that aren't relevant to federation debugging
        const noisyTables = ['timeline_entries', 'notifications', 'ap_activities'];
        if (noisyTables.includes(payload.table)) {
          // Use debug level for noisy tables
          logger.debug(`🔔 REALTIME EVENT: ${payload.eventType} on ${payload.table}`, {
            id: payload.new?.id || payload.old?.id,
            table: payload.table
          });
          return;
        }
        
        logger.info(`🔔 REALTIME EVENT: ${payload.eventType} on ${payload.table}`, {
          id: payload.new?.id || payload.old?.id,
          table: payload.table
        });
      }
    )
    
    // Listen to posts
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'posts',
      },
      async (payload) => {
        logger.info('📬 REALTIME: Post INSERT received:', {
          id: payload.new.id,
          is_local: payload.new.is_local,
          visibility: payload.new.visibility,
          author_id: payload.new.author_id
        });
        
        // Only process local public/unlisted posts
        if (payload.new.is_local && ['public', 'unlisted'].includes(payload.new.visibility)) {
          logger.info('📝 Processing post for federation:', payload.new.id);
          await handleNewPost(payload.new);
        } else {
          logger.debug(`Skipping post: is_local=${payload.new.is_local}, visibility=${payload.new.visibility}`);
        }
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
        table: 'post_interactions',
        filter: 'interaction_type=eq.favorite',
      },
      async (payload) => {
        logger.info('⭐ New favorite/like detected:', payload.new.id);
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
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'profiles',
      },
      async (payload) => {
        logger.info('📝 Profile update detected:', payload.new.id);
        await handleProfileUpdate(payload.old, payload.new);
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
async function handleNewPost(postEvent: any): Promise<void> {
  try {
    // Check if post should be federated
    if (!postEvent.is_local || !['public', 'unlisted'].includes(postEvent.visibility)) {
      logger.debug(`Skipping federation for post ${postEvent.id}: not public or local`);
      return;
    }

    logger.info(`🌐 Federating new post: ${postEvent.id}`);

    // Get full post data (realtime events might not include all columns)
    const supabase = getSupabaseClient();
    const { data: post } = await supabase
      .from('posts')
      .select('*')
      .eq('id', postEvent.id)
      .single();

    if (!post) {
      logger.error(`Post not found: ${postEvent.id}`);
      return;
    }

    // Get author profile
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
    
    // Also deliver to mentioned users (they might not be followers)
    if (Array.isArray(post.content)) {
      const mentions = post.content.filter((part: any) => part.type === 'mention');
      
      for (const mention of mentions) {
        if (!mention.isLocal && mention.domain) {
          // Get mentioned user's inbox
          const { data: mentionedUser } = await supabase
            .from('profiles')
            .select('inbox_url')
            .eq('username', mention.username)
            .eq('domain', mention.domain)
            .single();
          
          if (mentionedUser?.inbox_url) {
            logger.info(`📧 Delivering to mentioned user: ${mention.username}@${mention.domain}`);
            await DeliveryQueue.sendToInbox(mentionedUser.inbox_url, activity, author.id);
          }
        }
      }
    }

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
      .select('id, author_id, ap_id')
      .eq('id', interaction.post_id)
      .single();

    if (!post || !post.ap_id) {
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

    // Get emoji data if it's a custom emoji
    let emojiContent = interaction.custom_emoji_content; // For unicode emojis
    let emojiData = null;
    
    if (interaction.emoji_id) {
      const { data: emoji } = await supabase
        .from('emojis')
        .select('name, url')
        .eq('id', interaction.emoji_id)
        .single();
      
      if (emoji) {
        emojiData = emoji;
        emojiContent = `:${emoji.name}:`; // Misskey format
      }
    }
    
    logger.info(`🌐 Federating reaction: ${emojiContent} on post ${post.id}`);

    // Create Like activity with proper emoji data
    const activity = await createLikeActivity(user, post.ap_id, emojiContent, emojiData);

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

/**
 * Handle profile update
 */
async function handleProfileUpdate(oldProfile: any, newProfile: any): Promise<void> {
  try {
    // Only federate updates for local users
    if (!newProfile.is_local) {
      logger.debug('Profile update for remote user, skipping');
      return;
    }

    // Check if any federable fields changed
    const fieldsChanged = 
      oldProfile.display_name !== newProfile.display_name ||
      oldProfile.bio !== newProfile.bio ||
      oldProfile.avatar_url !== newProfile.avatar_url ||
      oldProfile.banner_url !== newProfile.banner_url;

    if (!fieldsChanged) {
      logger.debug('No federable fields changed, skipping');
      return;
    }

    logger.info(`🌐 Federating profile update: ${newProfile.username}`);
    logger.info('Changed fields:', {
      display_name: oldProfile.display_name !== newProfile.display_name ? `"${oldProfile.display_name}" → "${newProfile.display_name}"` : 'no change',
      bio: oldProfile.bio !== newProfile.bio ? 'changed' : 'no change',
      avatar_url: oldProfile.avatar_url !== newProfile.avatar_url ? `"${oldProfile.avatar_url}" → "${newProfile.avatar_url}"` : 'no change',
      banner_url: oldProfile.banner_url !== newProfile.banner_url ? `"${oldProfile.banner_url}" → "${newProfile.banner_url}"` : 'no change',
    });

    const supabase = getSupabaseClient();

    // Get full profile data (realtime might not include all fields)
    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', newProfile.id)
      .single();

    if (!profile) {
      logger.error(`Profile not found: ${newProfile.id}`);
      return;
    }

    // Create Update activity
    const { createProfileUpdateActivity } = await import('./FederationHandlers.js');
    const activity = createProfileUpdateActivity(profile);

    // Log what we're sending
    logger.info('Update activity object:', {
      id: activity.id,
      type: activity.type,
      actor: activity.actor,
      hasIcon: !!activity.object.icon,
      iconUrl: activity.object.icon?.url,
      hasImage: !!activity.object.image,
      imageUrl: activity.object.image?.url,
    });

    // Broadcast to followers
    await DeliveryQueue.broadcastToFollowers(profile.id, activity);

    logger.info(`✅ Profile update for ${profile.username} queued for federation`);
  } catch (error) {
    logger.error('Failed to handle profile update:', error);
  }
}

