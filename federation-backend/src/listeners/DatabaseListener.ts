/**
 * Database Listener - Listens for PostgreSQL NOTIFY events
 * 
 * This is how the federation backend knows when to federate content:
 * 1. User creates post → Supabase
 * 2. Database trigger → NOTIFY 'post_created'
 * 3. This listener receives notification
 * 4. Process and federate
 */

import crypto from 'crypto';
import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';
import { DeliveryQueue } from '../activitypub/DeliveryQueue.js';
import { createLikeActivity } from '../activitypub/converters/toActivityPub.js';
import { resolveOutboundEmoji } from '../utils/emojiResolvers.js';
import { logger } from '../utils/logger.js';
import { convertContentToHTML, extractActivityPubTags, extractAttachments } from '../utils/contentUtils.js';
import { linkPreviewService } from '../services/LinkPreviewService.js';
import { ActivityProcessor } from '../activitypub/ActivityProcessor.js';

/**
 * Start listening to database notifications
 */
export async function startDatabaseListener(): Promise<void> {
  logger.info('🔊 Starting database notification listener...');

  const supabase = getSupabaseClient();

  // Subscribe to real-time changes for federation events  
  let channel = supabase
    .channel('federation-events');

  if (config.environment !== 'production') {
    channel = channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: '*',
      },
      async (payload) => {
        const noisyTables = ['timeline_entries', 'notifications', 'ap_activities'];
        if (noisyTables.includes(payload.table)) {
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
    );
  }

  // NOTE: Post create/update/delete/pin federation runs exclusively through
  // BullMQ (`federate-post` job → `postHandler.handlePostJob`). The DB
  // trigger `trigger_queue_post_federation` queues the job via pg_notify on
  // every INSERT/UPDATE/soft-delete/pin change, so we don't need a
  // postgres_changes subscription on `posts` here. The previous CDC-based
  // path used to handle these events but was unreliable (Supabase Realtime
  // doesn't fire consistently for every row) and racy against the BullMQ
  // path — `enrichPostLinkPreviews` and the home-feed realtime push now
  // both live inside `handlePostJob`.
  channel = channel
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'post_interactions',
        filter: 'interaction_type=eq.emoji_reaction',
      },
      async (payload) => {
        if (config.USE_BULLMQ_QUEUE) {
          logger.debug('❤️ Post reaction detected - handled by BullMQ:', payload.new.id);
        } else {
          logger.info('❤️  New reaction detected:', payload.new.id);
          await handleNewReaction(payload.new);
        }
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
        if (config.USE_BULLMQ_QUEUE) {
          logger.debug('⭐ Post favorite detected - handled by BullMQ:', payload.new.id);
        } else {
          logger.info('⭐ New favorite/like detected:', payload.new.id);
          await handleNewReaction(payload.new);
        }
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
    // Listen for new blocks
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'user_blocks',
      },
      async (payload) => {
        logger.info('🚫 New block detected:', payload.new.id);
        await handleNewBlock(payload.new);
      }
    )
    // Listen for block removals (unblock)
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'user_blocks',
      },
      async (payload) => {
        logger.info('✅ Unblock detected:', payload.old?.id);
        await handleUnblock(payload.old);
      }
    )
    // Listen for new reports
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'reports',
      },
      async (payload) => {
        logger.info('🚩 New report detected:', payload.new.id);
        await handleNewReport(payload.new);
      }
    )
    // Listen for unfollow events
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'follows',
      },
      async (payload) => {
        logger.info('👤 Unfollow detected:', payload.old?.id);
        await handleUnfollow(payload.old);
      }
    )
    // Listen for reaction/reblog removals
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'post_interactions',
      },
      async (payload) => {
        logger.info('↩️ Interaction removal detected:', payload.old?.id);
        await handleInteractionRemoval(payload.old);
      }
    )
    // Listen for DM messages - federate to remote recipients
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
      },
      async (payload) => {
        // Enrich external link previews asynchronously for all local messages
        // Skip when BullMQ is enabled - the job handler already calls enrichMessageLinkPreviews
        if (!config.USE_BULLMQ_QUEUE && !payload.new.metadata?.federated) {
          enrichMessageLinkPreviews(payload.new).catch(err =>
            logger.warn('Link preview enrichment failed:', err)
          );
        }

        // Handle DM messages (conversation_id set)
        // When BullMQ is enabled, DMs are handled by the job queue for reliable delivery
        if (payload.new.conversation_id && !payload.new.metadata?.federated) {
          if (config.USE_BULLMQ_QUEUE) {
            logger.debug('💬 DM detected - handled by BullMQ:', payload.new.id);
          } else {
            logger.info('💬 DM message detected:', {
              id: payload.new.id,
              conversation_id: payload.new.conversation_id
            });
            await handleNewDM(payload.new);
          }
        }
        // Handle channel messages (channel_id set)
        // When BullMQ is enabled, channel messages are handled by BullMQ for reliability
        else if (payload.new.channel_id && !payload.new.metadata?.federated) {
          if (config.USE_BULLMQ_QUEUE) {
            logger.debug('📨 Channel message detected - handled by BullMQ:', payload.new.id);
          } else {
            logger.info('📨 Channel message detected:', {
              id: payload.new.id,
              channel_id: payload.new.channel_id
            });
            await handleNewChannelMessage(payload.new);
          }
        }
      }
    )
    // Listen for message updates (edits) - federate to remote
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
      },
      async (payload) => {
        // Only process if content changed
        if (payload.new.channel_id && 
            JSON.stringify(payload.old.content) !== JSON.stringify(payload.new.content)) {
          if (config.USE_BULLMQ_QUEUE) {
            logger.debug('✏️ Channel message update detected - handled by BullMQ:', payload.new.id);
          } else {
            logger.info('✏️ Channel message update detected:', {
              id: payload.new.id,
              channel_id: payload.new.channel_id
            });
            await handleChannelMessageUpdate(payload.new);
          }
        }
      }
    )
    // Listen for message deletions - federate to remote
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'messages',
      },
      async (payload) => {
        if (payload.old.channel_id) {
          if (config.USE_BULLMQ_QUEUE) {
            logger.debug('🗑️ Channel message deletion detected - handled by BullMQ:', payload.old.id);
          } else {
            logger.info('🗑️ Channel message deletion detected:', {
              id: payload.old.id,
              channel_id: payload.old.channel_id
            });
            await handleChannelMessageDeletion(payload.old);
          }
        }
      }
    )
    // Listen for channel creation - federate to remote server members
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'channels',
      },
      async (payload) => {
        // Only federate local channels (not remote mirrors)
        if (!payload.new.is_remote) {
          logger.info('📢 Channel created:', {
            id: payload.new.id,
            name: payload.new.name,
            server_id: payload.new.server_id
          });
          await handleChannelCreated(payload.new);
        }
      }
    )
    // Listen for channel updates - federate to remote server members
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'channels',
      },
      async (payload) => {
        // Only federate local channels and meaningful changes
        if (!payload.new.is_remote && 
            (payload.old.name !== payload.new.name || 
             payload.old.description !== payload.new.description ||
             payload.old.category !== payload.new.category ||
             payload.old.order !== payload.new.order)) {
          logger.info('✏️ Channel updated:', {
            id: payload.new.id,
            name: payload.new.name
          });
          await handleChannelUpdated(payload.new, payload.old);
        }
      }
    )
    // Listen for channel deletion - federate to remote server members
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'channels',
      },
      async (payload) => {
        // Only federate local channels
        if (!payload.old.is_remote) {
          logger.info('🗑️ Channel deleted:', {
            id: payload.old.id,
            name: payload.old.name
          });
          await handleChannelDeleted(payload.old);
        }
      }
    )
    // Listen for new message reactions (DMs)
    // When BullMQ is enabled, DM reactions are handled by job queue
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'reactions',
      },
      async (payload) => {
        if (config.USE_BULLMQ_QUEUE) {
          logger.debug('💬❤️ Message reaction detected - handled by BullMQ:', payload.new.id);
        } else {
          logger.info('💬❤️ New message reaction detected:', payload.new.id);
          await handleNewMessageReaction(payload.new);
        }
      }
    )
    // Listen for message reaction removals (DMs)
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'reactions',
      },
      async (payload) => {
        if (config.USE_BULLMQ_QUEUE) {
          logger.debug('💬💔 Message reaction removed - handled by BullMQ:', payload.old?.id);
        } else {
          logger.info('💬💔 Message reaction removed:', payload.old?.id);
          await handleMessageReactionRemoval(payload.old);
        }
      }
    )
    // Listen for server updates - federate to remote members
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'servers',
      },
      async (payload) => {
        // Only federate local servers with federation enabled and meaningful changes
        if (payload.new.is_local_server && 
            payload.new.federation_enabled &&
            (payload.old.name !== payload.new.name || 
             payload.old.description !== payload.new.description ||
             payload.old.icon !== payload.new.icon ||
             payload.old.banner !== payload.new.banner ||
             payload.old.public !== payload.new.public)) {
          logger.info('🏠 Server updated:', {
            id: payload.new.id,
            name: payload.new.name,
            changed: {
              name: payload.old.name !== payload.new.name,
              description: payload.old.description !== payload.new.description,
              icon: payload.old.icon !== payload.new.icon,
              banner: payload.old.banner !== payload.new.banner,
              public: payload.old.public !== payload.new.public,
            }
          });
          await handleServerUpdated(payload.new, payload.old);
        }
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
      // Note: For local posts, ap_id is set by a trigger AFTER the INSERT.
      // This realtime listener fires before the trigger runs, so ap_id is null.
      // The reaction federation is handled by the frontend's FederationActivityService
      // which inserts into ap_activities, triggering separate federation.
      logger.debug('Reaction on post without ap_id (likely handled via ap_activities table), skipping realtime handler');
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

    // Get post author profile
    const { data: postAuthor } = await supabase
      .from('profiles')
      .select('inbox_url, is_local, federated_id, username, domain')
      .eq('id', post.author_id)
      .single();

    if (!postAuthor) {
      logger.debug('Post author not found, skipping federation');
      return;
    }

    const targetDomain = postAuthor.is_local ? undefined : (postAuthor.domain || undefined);
    const { content, emojiData } = await resolveOutboundEmoji(
      interaction.emoji_id,
      interaction.custom_emoji_content,
      targetDomain,
    );

    logger.info(`🌐 Federating reaction: ${content} on post ${post.id}`);

    // Send to post author's inbox if they're remote
    if (!postAuthor.is_local && postAuthor.inbox_url) {
      const authorUrl = postAuthor.federated_id
        || `https://${postAuthor.domain}/users/${postAuthor.username}`;
      const activity = createLikeActivity(user, post.ap_id, content, emojiData ?? undefined, [authorUrl]);
      await DeliveryQueue.sendToInbox(postAuthor.inbox_url, activity, user.id);
      logger.info(`✅ Reaction sent to post author ${postAuthor.inbox_url}`);
    }

    // Broadcast to the post author's remote followers so all instances
    // that have a copy of the post can display the reaction.
    const broadcastActivity = createLikeActivity(user, post.ap_id, content, emojiData ?? undefined);
    await DeliveryQueue.broadcastToFollowers(post.author_id, broadcastActivity);
    logger.info(`✅ Reaction broadcast to post author's remote followers`);
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
    // Note: custom_status is now handled by database trigger (trigger_queue_profile_federation)
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

/**
 * Handle unfollow - send Undo Follow activity
 */
async function handleUnfollow(deletedFollow: any): Promise<void> {
  try {
    if (!deletedFollow) {
      logger.debug('No follow data in deletion event');
      return;
    }

    const supabase = getSupabaseClient();

    // Get follower (must be local)
    const { data: follower } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', deletedFollow.follower_id)
      .single();

    if (!follower || !follower.is_local) {
      logger.debug('Unfollow from remote user, skipping outgoing federation');
      return;
    }

    // Get following (check if remote)
    const { data: following } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', deletedFollow.following_id)
      .single();

    if (!following || following.is_local) {
      logger.debug('Unfollow of local user, no federation needed');
      return;
    }

    logger.info(`🌐 Federating unfollow: ${follower.username} → ${following.username}`);

    const { createUndoFollowActivity } = await import('./FederationHandlers.js');
    const activity = createUndoFollowActivity(follower, following, deletedFollow);

    // Send to following's inbox
    if (following.inbox_url) {
      await DeliveryQueue.sendToInbox(following.inbox_url, activity, follower.id);
      logger.info(`✅ Undo Follow queued for delivery to ${following.inbox_url}`);
    }
  } catch (error) {
    logger.error('Failed to handle unfollow:', error);
  }
}

/**
 * Handle interaction removal - send Undo Like for reactions
 */
async function handleInteractionRemoval(deletedInteraction: any): Promise<void> {
  try {
    if (!deletedInteraction) {
      logger.debug('No interaction data in deletion event');
      return;
    }

    const supabase = getSupabaseClient();

    // Get the user who removed the interaction
    const { data: user } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', deletedInteraction.user_id)
      .single();

    if (!user || !user.is_local) {
      logger.debug('Interaction removal from remote user, skipping');
      return;
    }

    // Get the post
    const { data: post } = await supabase
      .from('posts')
      .select('id, ap_id, author_id')
      .eq('id', deletedInteraction.post_id)
      .single();

    if (!post) {
      logger.debug('Post not found for interaction removal');
      return;
    }

    // Only federate if the post has an ap_id (is federated)
    if (!post.ap_id) {
      // Same as handleNewReaction - ap_id might not be set yet for local posts
      logger.debug('Interaction removal on post without ap_id, skipping realtime handler');
      return;
    }

    // Get post author to send Undo
    const { data: postAuthor } = await supabase
      .from('profiles')
      .select('inbox_url, is_local')
      .eq('id', post.author_id)
      .single();

    // Only need to send if author is remote
    if (!postAuthor || postAuthor.is_local) {
      logger.debug('Post author is local, no federation needed for interaction removal');
      return;
    }

    // Handle based on interaction type
    if (deletedInteraction.interaction_type === 'emoji_reaction' || 
        deletedInteraction.interaction_type === 'favorite') {
      logger.info(`🌐 Federating reaction removal on post ${post.id}`);
      
      const { createUndoLikeActivity } = await import('./FederationHandlers.js');
      const activity = createUndoLikeActivity(user, post.ap_id);

      if (postAuthor.inbox_url) {
        await DeliveryQueue.sendToInbox(postAuthor.inbox_url, activity, user.id);
        logger.info(`✅ Undo Like queued for delivery to ${postAuthor.inbox_url}`);
      }
    }
    // Note: Reblog removals are handled via post deletion (Undo Announce)
  } catch (error) {
    logger.error('Failed to handle interaction removal:', error);
  }
}

/**
 * Handle pin/unpin changes - send Add/Remove activity
 */
async function handlePinChange(post: any, oldPost: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    // Get full post data
    const { data: fullPost } = await supabase
      .from('posts')
      .select('*')
      .eq('id', post.id)
      .single();

    if (!fullPost || !fullPost.is_local) {
      logger.debug('Cannot federate pin change for non-local post');
      return;
    }

    // Get author
    const { data: author } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', fullPost.author_id)
      .single();

    if (!author || !author.is_local) {
      return;
    }

    const { createAddToFeaturedActivity, createRemoveFromFeaturedActivity } = await import('./FederationHandlers.js');
    
    const isPinned = post.is_pinned && !oldPost?.is_pinned;
    const isUnpinned = !post.is_pinned && oldPost?.is_pinned;

    let activity;
    if (isPinned) {
      activity = createAddToFeaturedActivity(author, fullPost);
      logger.info(`📌 Federating pin for post ${post.id}`);
    } else if (isUnpinned) {
      activity = createRemoveFromFeaturedActivity(author, fullPost);
      logger.info(`📌 Federating unpin for post ${post.id}`);
    } else {
      return;
    }

    // Get followers to notify
    const { data: followers } = await supabase
      .from('follows')
      .select('follower:profiles!follows_follower_id_fkey(id, inbox_url, is_local, shared_inbox_url)')
      .eq('following_id', author.id)
      .eq('status', 'accepted');

    if (!followers || followers.length === 0) {
      logger.debug('No followers to notify about pin change');
      return;
    }

    // Collect unique inboxes
    const inboxes = new Set<string>();
    for (const follow of followers) {
      const follower = follow.follower as any;
      if (!follower?.is_local && follower?.inbox_url) {
        inboxes.add(follower.shared_inbox_url || follower.inbox_url);
      }
    }

    await Promise.allSettled(
      [...inboxes].map(inbox => DeliveryQueue.sendToInbox(inbox, activity, author.id))
    );

    logger.info(`📌 Pin change federated to ${inboxes.size} inboxes`);
  } catch (error) {
    logger.error('Failed to handle pin change:', error);
  }
}

/**
 * Handle new block - send Block activity
 */
async function handleNewBlock(block: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    // Get blocker
    const { data: blocker } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', block.blocker_id)
      .single();

    // Get blocked user (column is blocked_user_id in user_blocks table)
    const { data: blocked } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', block.blocked_user_id)
      .single();

    if (!blocker?.is_local || !blocked) {
      logger.debug('Block not from local user or blocked user not found');
      return;
    }

    // Only federate if blocked user is remote
    if (blocked.is_local) {
      logger.debug('Blocked user is local, no federation needed');
      return;
    }

    const { createBlockActivity } = await import('./FederationHandlers.js');
    const activity = createBlockActivity(blocker, blocked);

    if (blocked.inbox_url) {
      await DeliveryQueue.sendToInbox(blocked.inbox_url, activity, blocker.id);
      logger.info(`🚫 Block federated to ${blocked.inbox_url}`);
    }
  } catch (error) {
    logger.error('Failed to handle new block:', error);
  }
}

/**
 * Handle unblock - send Undo Block activity
 */
async function handleUnblock(block: any): Promise<void> {
  try {
    if (!block) return;

    const supabase = getSupabaseClient();

    // Get blocker
    const { data: blocker } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', block.blocker_id)
      .single();

    // Get blocked user (column is blocked_user_id in user_blocks table)
    const { data: blocked } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', block.blocked_user_id)
      .single();

    if (!blocker?.is_local || !blocked) {
      return;
    }

    // Only federate if blocked user is remote
    if (blocked.is_local) {
      return;
    }

    const { createUndoBlockActivity } = await import('./FederationHandlers.js');
    const activity = createUndoBlockActivity(blocker, blocked);

    if (blocked.inbox_url) {
      await DeliveryQueue.sendToInbox(blocked.inbox_url, activity, blocker.id);
      logger.info(`✅ Unblock federated to ${blocked.inbox_url}`);
    }
  } catch (error) {
    logger.error('Failed to handle unblock:', error);
  }
}

/**
 * Handle new report - send Flag activity to remote instance
 */
async function handleNewReport(report: any): Promise<void> {
  try {
    // Skip if this report came from federation (source === 'federation')
    if (report.source === 'federation') {
      logger.debug('Report is from federation, not re-federating');
      return;
    }

    const supabase = getSupabaseClient();

    // Get reporter
    const { data: reporter } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', report.reporter_id)
      .single();

    if (!reporter?.is_local) {
      return;
    }

    // Get reported user
    const { data: reportedUser } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', report.reported_user_id)
      .single();

    if (!reportedUser) {
      return;
    }

    // Only federate if reported user is remote
    if (reportedUser.is_local) {
      logger.debug('Reported user is local, no federation needed');
      return;
    }

    // Get reported post if applicable
    let reportedPost = null;
    if (report.reported_post_id) {
      const { data: post } = await supabase
        .from('posts')
        .select('*')
        .eq('id', report.reported_post_id)
        .single();
      reportedPost = post;
    }

    const { createFlagActivity } = await import('./FederationHandlers.js');
    const activity = createFlagActivity(reporter, reportedUser, reportedPost, report.reason);

    // Send to the reported user's instance inbox
    const instanceDomain = reportedUser.domain;
    const instanceInbox = `https://${instanceDomain}/inbox`;

    await DeliveryQueue.sendToInbox(instanceInbox, activity, reporter.id);
    logger.info(`🚩 Report federated to ${instanceInbox}`);
  } catch (error) {
    logger.error('Failed to handle new report:', error);
  }
}

// =============================================================================
// CHANNEL CRUD FEDERATION HANDLERS
// =============================================================================

/**
 * Handle channel creation - federate to remote server members
 */
export async function handleChannelCreated(channel: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;
    
    // Get server info (include owner for signing federation requests)
    const { data: server } = await supabase
      .from('servers')
      .select('id, owner, federation_enabled, is_local_server')
      .eq('id', channel.server_id)
      .single();
    
    if (!server?.federation_enabled || !server.is_local_server) {
      return;
    }
    
    // Validate server owner exists (required for HTTP signature)
    if (!server.owner) {
      logger.warn(`⚠️ Server ${server.id} has no owner - cannot federate channel creation`);
      return;
    }
    
    // Get remote member groups
    const remoteMemberGroups = await getRemoteMemberGroups(channel.server_id);
    if (remoteMemberGroups.length === 0) {
      return;
    }
    
    const serverUrl = `https://${hostDomain}/servers/${channel.server_id}`;
    const channelUrl = `${serverUrl}/channels/${channel.id}`;
    
    // Determine channel type
    const channelType = channel.type === 2 ? 'harmony:Category' : 
                        (channel.type === 1 ? 'harmony:VoiceChannel' : 'harmony:TextChannel');
    
    // Create Add activity
    const activity = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        { 'harmony': 'https://harmonyapp.dev/ns#' },
      ],
      id: `${serverUrl}/activities/${crypto.randomUUID()}`,
      type: 'Add',
      actor: serverUrl,
      target: serverUrl,
      object: {
        type: channelType,
        id: channelUrl,
        name: channel.name,
        description: channel.description,
        position: channel.order || 0,
        category: channel.category ? `${serverUrl}/channels/${channel.category}` : null,
      },
      published: new Date().toISOString(),
    };
    
    // Send to remote instances (use server.owner as sender for HTTP signature)
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
    for (const group of remoteMemberGroups) {
      const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
      await DeliveryQueue.enqueue(activity, inbox, server.owner);
    }
    
    logger.info(`📢 Channel creation federated to ${remoteMemberGroups.length} instances`);
  } catch (error) {
    logger.error('Failed to federate channel creation:', error);
  }
}

/**
 * Handle channel update - federate to remote server members
 */
export async function handleChannelUpdated(channel: any, oldChannel: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;
    
    // Get server info (include owner for signing federation requests)
    const { data: server } = await supabase
      .from('servers')
      .select('id, owner, federation_enabled, is_local_server')
      .eq('id', channel.server_id)
      .single();
    
    if (!server?.federation_enabled || !server.is_local_server) {
      return;
    }
    
    // Validate server owner exists (required for HTTP signature)
    if (!server.owner) {
      logger.warn(`⚠️ Server ${server.id} has no owner - cannot federate channel update`);
      return;
    }
    
    // Get remote member groups
    const remoteMemberGroups = await getRemoteMemberGroups(channel.server_id);
    if (remoteMemberGroups.length === 0) {
      return;
    }
    
    const serverUrl = `https://${hostDomain}/servers/${channel.server_id}`;
    const channelUrl = `${serverUrl}/channels/${channel.id}`;
    
    // Create Update activity
    const activity = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        { 'harmony': 'https://harmonyapp.dev/ns#' },
      ],
      id: `${serverUrl}/activities/${crypto.randomUUID()}`,
      type: 'Update',
      actor: serverUrl,
      object: {
        type: channel.type === 2 ? 'harmony:Category' : 
              (channel.type === 1 ? 'harmony:VoiceChannel' : 'harmony:TextChannel'),
        id: channelUrl,
        name: channel.name,
        description: channel.description,
        position: channel.order || 0,
        category: channel.category ? `${serverUrl}/channels/${channel.category}` : null,
      },
      published: new Date().toISOString(),
    };
    
    // Send to remote instances (use server.owner as sender for HTTP signature)
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
    for (const group of remoteMemberGroups) {
      const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
      await DeliveryQueue.enqueue(activity, inbox, server.owner);
    }
    
    logger.info(`✏️ Channel update federated to ${remoteMemberGroups.length} instances`);
  } catch (error) {
    logger.error('Failed to federate channel update:', error);
  }
}

/**
 * Handle channel deletion - federate to remote server members
 */
export async function handleChannelDeleted(channel: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;
    
    // Get server info (include owner for signing federation requests)
    const { data: server } = await supabase
      .from('servers')
      .select('id, owner, federation_enabled, is_local_server')
      .eq('id', channel.server_id)
      .single();
    
    if (!server?.federation_enabled || !server.is_local_server) {
      return;
    }
    
    // Validate server owner exists (required for HTTP signature)
    if (!server.owner) {
      logger.warn(`⚠️ Server ${server.id} has no owner - cannot federate channel deletion`);
      return;
    }
    
    // Get remote member groups
    const remoteMemberGroups = await getRemoteMemberGroups(channel.server_id);
    if (remoteMemberGroups.length === 0) {
      return;
    }
    
    const serverUrl = `https://${hostDomain}/servers/${channel.server_id}`;
    const channelUrl = channel.ap_id || `${serverUrl}/channels/${channel.id}`;
    
    // Create Remove activity (opposite of Add)
    const activity = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        { 'harmony': 'https://harmonyapp.dev/ns#' },
      ],
      id: `${serverUrl}/activities/${crypto.randomUUID()}`,
      type: 'Remove',
      actor: serverUrl,
      target: serverUrl,
      object: channelUrl,
      published: new Date().toISOString(),
    };
    
    // Send to remote instances (use server.owner as sender for HTTP signature)
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
    for (const group of remoteMemberGroups) {
      const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
      await DeliveryQueue.enqueue(activity, inbox, server.owner);
    }
    
    logger.info(`🗑️ Channel deletion federated to ${remoteMemberGroups.length} instances`);
  } catch (error) {
    logger.error('Failed to federate channel deletion:', error);
  }
}

/**
 * Handle server update - federate to remote members
 */
export async function handleServerUpdated(server: any, oldServer: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;
    
    // Validate server owner exists (required for HTTP signature)
    if (!server.owner) {
      logger.warn(`⚠️ Server ${server.id} has no owner - cannot federate server update`);
      return;
    }
    
    // Get remote member groups
    const remoteMemberGroups = await getRemoteMemberGroups(server.id);
    if (remoteMemberGroups.length === 0) {
      logger.info('No remote members to notify of server update');
      return;
    }
    
    const serverUrl = `https://${hostDomain}/servers/${server.id}`;
    
    // Build Update activity with all profile properties
    const iconUrl = server.icon && !server.icon.includes('default')
      ? (server.icon.startsWith('http') ? server.icon : 
         `${config.PUBLIC_SUPABASE_URL || config.SUPABASE_URL}/storage/v1/render/image/public/server_icons/${server.icon}?width=96&height=96&resize=contain&quality=80`)
      : undefined;
    
    const bannerUrl = server.banner
      ? (server.banner.startsWith('http') ? server.banner :
         `${config.PUBLIC_SUPABASE_URL || config.SUPABASE_URL}/storage/v1/object/public/server_banners/${server.banner}`)
      : undefined;

    const activity = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        { 'harmony': 'https://harmonyapp.dev/ns#' },
      ],
      id: `${serverUrl}/activities/${crypto.randomUUID()}`,
      type: 'Update',
      actor: serverUrl,
      object: {
        id: serverUrl,
        type: 'Group',
        name: server.name,
        summary: server.description,
        icon: iconUrl ? { type: 'Image', url: iconUrl } : null,
        image: bannerUrl ? { type: 'Image', url: bannerUrl } : null,
        discoverable: server.public === true,
        'harmony:ChatServer': true,
        updated: new Date().toISOString(),
      },
      published: new Date().toISOString(),
    };
    
    // Send to remote instances (use server.owner as sender for HTTP signature)
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
    for (const group of remoteMemberGroups) {
      const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
      await DeliveryQueue.enqueue(activity, inbox, server.owner);
    }
    
    logger.info(`🏠 Server update federated to ${remoteMemberGroups.length} instances`);
  } catch (error) {
    logger.error('Failed to federate server update:', error);
  }
}

/**
 * Get remote member groups for a server (helper function)
 */
async function getRemoteMemberGroups(serverId: string): Promise<any[]> {
  const supabase = getSupabaseClient();
  const hostDomain = config.INSTANCE_DOMAIN;

  // Try the RPC function first
  const { data: memberGroups, error: rpcError } = await supabase
    .rpc('get_server_members_by_instance', { p_server_id: serverId });

  if (!rpcError && memberGroups) {
    return memberGroups.filter(
      (group: any) => group.instance !== 'local' && group.instance !== hostDomain
    );
  }

  // Fallback: manual query
  const { data: members } = await supabase
    .from('user_servers')
    .select(`
      member_instance,
      profile:profiles!user_servers_user_id_fkey(federated_id, shared_inbox_url)
    `)
    .eq('server_id', serverId)
    .eq('status', 'accepted')
    .not('member_instance', 'is', null);

  if (!members) {
    return [];
  }

  // Group by instance
  const instanceMap = new Map<string, any>();

  for (const member of members) {
    const instance = member.member_instance;
    if (!instance || instance === hostDomain) continue;

    const profile = (member as any).profile;
    if (!profile?.federated_id) continue;

    if (!instanceMap.has(instance)) {
      instanceMap.set(instance, {
        instance,
        member_ap_ids: [],
        member_count: 0,
        shared_inbox: profile.shared_inbox_url || `https://${instance}/inbox`,
      });
    }

    const group = instanceMap.get(instance)!;
    group.member_ap_ids.push(profile.federated_id);
    group.member_count++;
  }

  return Array.from(instanceMap.values());
}

// =============================================================================
// CHANNEL MESSAGE FEDERATION HANDLERS
// =============================================================================

/**
 * Handle new channel message - federate to remote server members
 */
export async function handleNewChannelMessage(message: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    
    // Get channel info
    const { data: channel } = await supabase
      .from('channels')
      .select('id, name, server_id')
      .eq('id', message.channel_id)
      .single();
    
    if (!channel) {
      logger.warn(`Channel ${message.channel_id} not found for message federation`);
      return;
    }
    
    // Import and call the handler
    const { handleChannelMessageFederation } = await import('./ChannelMessageHandler.js');
    await handleChannelMessageFederation({
      message_id: message.id,
      channel_id: channel.id,
      server_id: channel.server_id,
      channel_name: channel.name,
      author_id: message.user_id,
    });
  } catch (error) {
    logger.error('Failed to handle new channel message:', error);
  }
}

/**
 * Handle channel message update - federate edit to remote server members
 */
async function handleChannelMessageUpdate(message: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    
    // Get channel info
    const { data: channel } = await supabase
      .from('channels')
      .select('id, server_id')
      .eq('id', message.channel_id)
      .single();
    
    if (!channel) {
      return;
    }
    
    // Import and call the handler
    const { handleChannelMessageUpdate: federateUpdate } = await import('./ChannelMessageHandler.js');
    await federateUpdate({
      message_id: message.id,
      channel_id: channel.id,
      server_id: channel.server_id,
    });
  } catch (error) {
    logger.error('Failed to handle channel message update:', error);
  }
}

/**
 * Handle channel message deletion - federate delete to remote server members
 */
async function handleChannelMessageDeletion(message: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    
    // Get channel info
    const { data: channel } = await supabase
      .from('channels')
      .select('id, server_id')
      .eq('id', message.channel_id)
      .single();
    
    if (!channel) {
      return;
    }
    
    // Import and call the handler
    const { handleChannelMessageDelete: federateDelete } = await import('./ChannelMessageHandler.js');
    await federateDelete({
      message_id: message.id,
      channel_id: channel.id,
      server_id: channel.server_id,
      ap_id: message.metadata?.ap_id,
    });
  } catch (error) {
    logger.error('Failed to handle channel message deletion:', error);
  }
}

// =============================================================================
// DM MESSAGE FEDERATION HANDLERS
// =============================================================================

/**
 * Handle new DM messages - federate to remote recipients
 * This replaces the database trigger handle_outgoing_messages for DMs
 */
export async function handleNewDM(message: any): Promise<void> {
  try {
    if (message.is_system) {
      logger.debug('Skipping federation for system message');
      return;
    }
    const supabase = getSupabaseClient();
    const domain = config.INSTANCE_DOMAIN;
    
    // Get the sender profile
    const { data: sender } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, domain, is_local, federated_id')
      .eq('id', message.user_id)
      .single();
    
    if (!sender) {
      logger.warn(`Could not find sender for DM: ${message.user_id}`);
      return;
    }
    
    // Only federate messages from local users
    if (!sender.is_local) {
      logger.debug('Skipping federation for message from remote user');
      return;
    }
    
    // Get all participants in the conversation (excluding sender)
    const { data: participants, error: participantsError } = await supabase
      .from('conversation_participants')
      .select('user_id')
      .eq('conversation_id', message.conversation_id)
      .neq('user_id', message.user_id)
      .is('left_at', null);
    
    if (participantsError) {
      logger.error('Error fetching conversation participants:', participantsError);
      return;
    }
    
    if (!participants || participants.length === 0) {
      logger.debug('No other participants in conversation');
      return;
    }
    
    logger.debug(`Found ${participants.length} participant(s) in conversation`);
    
    // Get profiles for all participants
    const participantIds = participants.map(p => p.user_id);
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, username, domain, federated_id, is_local, inbox_url')
      .in('id', participantIds);
    
    if (profilesError) {
      logger.error('Error fetching participant profiles:', profilesError);
      return;
    }
    
    logger.debug(`Fetched ${profiles?.length || 0} profile(s):`, 
      profiles?.map(p => ({ username: p.username, domain: p.domain, is_local: p.is_local }))
    );
    
    // Filter to only remote users (federated users have is_local = false and a domain)
    const remoteUsers = (profiles || []).filter(
      (p: any) => p.is_local === false && p.domain
    );
    
    if (remoteUsers.length === 0) {
      logger.debug('All DM recipients are local (no remote users to federate to)');
      return;
    }
    
    logger.info(`📮 Federating DM to ${remoteUsers.length} remote recipient(s):`, 
      remoteUsers.map((p: any) => `${p.username}@${p.domain}`)
    );
    
    // Look up conversation type so the receiver knows group vs direct
    const { data: conversation } = await supabase
      .from('conversations')
      .select('type')
      .eq('id', message.conversation_id)
      .single();
    const conversationType = conversation?.type || 'direct';

    // Build sender URL
    const senderUrl = `https://${domain}/users/${sender.username}`;
    const messageUrl = `https://${domain}/messages/${message.id}`;
    
    // Convert content to HTML
    const htmlContent = convertContentToHTML(message.content);
    const attachments = extractAttachments(message.content);
    const baseTags = extractActivityPubTags(message.content);

    // Include ALL participants (local + remote) in to: so receiver can reconstruct the group
    const allParticipantProfiles = profiles || [];
    const recipientUrls = remoteUsers.map((p: any) => 
      p.federated_id || `https://${p.domain}/users/${p.username}`
    );
    // For group conversations, also include local participants (except sender) so the
    // receiver knows the full participant list (they appear as non-resolvable URLs, which
    // is fine - the receiver just counts them to decide group vs direct)
    const localParticipantUrls = conversationType === 'group'
      ? allParticipantProfiles
          .filter((p: any) => p.is_local && p.id !== sender.id)
          .map((p: any) => `https://${domain}/users/${p.username}`)
      : [];
    const allToUrls = [...recipientUrls, ...localParticipantUrls];
    const mentionTags = remoteUsers.map((p: any) => ({
      type: 'Mention',
      href: p.federated_id || `https://${p.domain}/users/${p.username}`,
      name: `@${p.username}@${p.domain}`
    }));
    
    // Check if the conversation has an established remote conversation tag
    // (from the first incoming federated message). Use it so Mastodon groups
    // all messages into the same thread.
    let conversationTag = `tag:${domain},${new Date(message.created_at).getFullYear()}:conversation-${message.conversation_id}`;
    const { data: existingConvMsg } = await supabase
      .from('messages')
      .select('metadata')
      .eq('conversation_id', message.conversation_id)
      .not('metadata->conversation', 'is', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .single();
    if (existingConvMsg?.metadata?.conversation) {
      conversationTag = existingConvMsg.metadata.conversation;
    }

    const note: any = {
      id: messageUrl,
      type: 'Note',
      attributedTo: senderUrl,
      published: message.created_at,
      content: htmlContent,
      contentMap: { en: htmlContent },
      attachment: attachments,
      tag: [...baseTags, ...mentionTags],
      to: allToUrls,
      cc: [],
      directMessage: true,
      conversation: conversationTag,
      'harmony:encrypted': message.encrypted === true ? true : undefined,
    };

    if (conversationType === 'group') {
      note['harmony:conversationType'] = 'group';
      note['harmony:conversationId'] = message.conversation_id;

      // Thread group messages using linear chain: set inReplyTo to the most
      // recent message in the conversation (preferring remote AP IDs that
      // Mastodon can resolve, falling back to our own message URLs).
      const { data: prevMsg } = await supabase
        .from('messages')
        .select('id, metadata')
        .eq('conversation_id', message.conversation_id)
        .neq('id', message.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (prevMsg) {
        note.inReplyTo = prevMsg.metadata?.ap_id
          || `https://${domain}/messages/${prevMsg.id}`;
      }
    }
    
    const activity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${senderUrl}#dm-${message.id}`,
      type: 'Create',
      actor: senderUrl,
      published: message.created_at,
      object: note,
      to: recipientUrls,
      cc: []
    };
    
    // Store conversation tag and ap_id on the message metadata so future
    // messages can reference it and the GET /messages/:id endpoint can serve it
    const updatedMetadata = {
      ...(message.metadata || {}),
      ap_id: messageUrl,
      conversation: conversationTag,
    };
    if (note.inReplyTo) {
      updatedMetadata.in_reply_to_ap = note.inReplyTo;
    }
    await supabase
      .from('messages')
      .update({ metadata: updatedMetadata })
      .eq('id', message.id);

    for (const profile of remoteUsers) {
      let inboxUrl = profile.inbox_url;
      if (!inboxUrl) {
        const { data: instance } = await supabase
          .from('instances')
          .select('shared_inbox_url')
          .eq('domain', profile.domain)
          .single();
        inboxUrl = instance?.shared_inbox_url || `https://${profile.domain}/inbox`;
      }
      await DeliveryQueue.enqueue(activity, inboxUrl, sender.id);
      logger.info(`✅ DM federated to ${profile.username}@${profile.domain}`);
    }
  } catch (error) {
    logger.error('Error handling DM federation:', error);
  }
}

/**
 * Handle new message reaction (DM reaction federation)
 * When a local user reacts to a DM, federate the Like activity to all remote participants
 */
export async function handleNewMessageReaction(reaction: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const domain = config.INSTANCE_DOMAIN;

    if (reaction.metadata?.federated) {
      logger.debug('Skipping federated reaction');
      return;
    }

    const { data: user } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', reaction.user_id)
      .single();

    if (!user || !user.is_local) {
      logger.debug('Reaction from remote user, skipping outbound federation');
      return;
    }

    const { data: message } = await supabase
      .from('messages')
      .select('id, user_id, conversation_id, metadata')
      .eq('id', reaction.message_id)
      .single();

    if (!message || !message.conversation_id) {
      logger.debug('Message not found or not a DM');
      return;
    }

    const { data: participants } = await supabase
      .from('conversation_participants')
      .select(`
        user_id,
        profiles!inner (
          id,
          username,
          domain,
          is_local,
          inbox_url,
          federated_id
        )
      `)
      .eq('conversation_id', message.conversation_id)
      .neq('user_id', reaction.user_id)
      .is('left_at', null);

    const remoteParticipants = participants?.filter(
      (p: any) => !p.profiles.is_local && p.profiles.domain
    ).map((p: any) => p.profiles);

    if (!remoteParticipants || remoteParticipants.length === 0) {
      logger.debug('No remote participants in conversation, no federation needed');
      return;
    }

    const { content: emojiContent, emojiData } = await resolveOutboundEmoji(
      reaction.emoji_id,
      reaction.custom_emoji_content,
    );

    // Use the original ap_id if the message came from a remote instance,
    // otherwise use our local URL
    const objectUrl = message.metadata?.ap_id
      || `https://${domain}/messages/${message.id}`;

    const recipientUrls = remoteParticipants.map(
      (p: any) => p.federated_id || `https://${p.domain}/users/${p.username}`,
    );
    const activity = createLikeActivity(
      user, objectUrl, emojiContent, emojiData ?? undefined, recipientUrls,
    );

    await Promise.allSettled(
      remoteParticipants.map((participant: any) => {
        const inboxUrl = participant.inbox_url || `https://${participant.domain}/inbox`;
        logger.info(`🌐 Federating message reaction: ${emojiContent} (emoji_id: ${reaction.emoji_id}) to ${participant.username}@${participant.domain}`);
        return DeliveryQueue.sendToInbox(inboxUrl, activity, user.id);
      })
    );
  } catch (error) {
    logger.error('Failed to handle message reaction:', error);
  }
}

/**
 * Handle message reaction removal (Undo Like for DMs)
 * When a local user removes a reaction from a DM, federate Undo Like to all remote participants
 */
export async function handleMessageReactionRemoval(deletedReaction: any): Promise<void> {
  try {
    if (!deletedReaction) {
      logger.debug('No deleted reaction data');
      return;
    }

    const supabase = getSupabaseClient();
    const domain = config.INSTANCE_DOMAIN;

    // Get the user who removed the reaction
    const { data: user } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', deletedReaction.user_id)
      .single();

    if (!user || !user.is_local) {
      logger.debug('Reaction removal from remote user, skipping outbound federation');
      return;
    }

    const { data: message } = await supabase
      .from('messages')
      .select('id, user_id, conversation_id, metadata')
      .eq('id', deletedReaction.message_id)
      .single();

    if (!message || !message.conversation_id) {
      logger.debug('Message not found or not a DM');
      return;
    }

    const { data: participants } = await supabase
      .from('conversation_participants')
      .select(`
        user_id,
        profiles!inner (
          id,
          username,
          domain,
          is_local,
          inbox_url
        )
      `)
      .eq('conversation_id', message.conversation_id)
      .neq('user_id', deletedReaction.user_id)
      .is('left_at', null);

    const remoteParticipants = participants?.filter(
      (p: any) => !p.profiles.is_local && p.profiles.domain
    ).map((p: any) => p.profiles);

    if (!remoteParticipants || remoteParticipants.length === 0) {
      logger.debug('No remote participants in conversation, no federation needed');
      return;
    }

    const objectUrl = message.metadata?.ap_id
      || `https://${domain}/messages/${message.id}`;

    const { createUndoLikeActivity } = await import('./FederationHandlers.js');
    const activity = createUndoLikeActivity(user, objectUrl);

    await Promise.allSettled(
      remoteParticipants.map((participant: any) => {
        const inboxUrl = participant.inbox_url || `https://${participant.domain}/inbox`;
        logger.info(`🌐 Federating message reaction removal to ${participant.username}@${participant.domain}`);
        return DeliveryQueue.sendToInbox(inboxUrl, activity, user.id);
      })
    );
  } catch (error) {
    logger.error('Failed to handle message reaction removal:', error);
  }
}

// =============================================================================
// LINK PREVIEW ENRICHMENT
// =============================================================================

/**
 * Detect external URLs in a message and fetch previews via LinkPreviewService.
 * Local Harmony post URLs are already handled by the DB trigger (process_local_link_previews).
 * This handles everything else: YouTube, Spotify, Reddit, generic external URLs.
 *
 * Called from BullMQ job handlers (channelMessageHandler, dmHandler) for reliability,
 * since Supabase Realtime may not fire consistently for all message INSERTs.
 */
export async function enrichMessageLinkPreviews(message: any): Promise<void> {
  const content = message.content;
  if (!Array.isArray(content)) return;

  const instanceDomain = config.INSTANCE_DOMAIN.toLowerCase();
  const existingEmbeds: Record<string, any> = message.metadata?.embeds || {};

  const urlParts = content.filter(
    (part: any) =>
      part.type === 'url' &&
      typeof part.url === 'string' &&
      part.preview !== 'false' &&
      part.preview !== false
  );

  if (urlParts.length === 0) return;

  const eligibleUrls = urlParts.filter((part: any) => {
    try {
      const host = new URL(part.url).hostname.toLowerCase();
      return host !== instanceDomain && !existingEmbeds[part.url];
    } catch {
      return false;
    }
  });

  if (eligibleUrls.length === 0) return;

  const previewResults = await Promise.allSettled(
    eligibleUrls.map(async (part: any) => {
      const url: string = part.url;
      const preview = await linkPreviewService.getPreview(url);
      if (!preview) return null;

      if (preview.provider === 'fediverse-post' && preview.fediverse?.postUrl) {
        try {
          const imported = await ActivityProcessor.fetchAndCreateRemotePost(preview.fediverse.postUrl);
          if (imported) {
            preview.localPostId = imported.id;
            logger.info(`📥 Auto-imported fediverse post ${preview.fediverse.postUrl} → ${imported.id}`);
          }
        } catch (importErr) {
          logger.debug(`Could not auto-import fediverse post ${url}:`, importErr);
        }
      }
      return { url, preview };
    })
  );

  const newEmbeds: Record<string, any> = {};
  for (const result of previewResults) {
    if (result.status === 'fulfilled' && result.value) {
      newEmbeds[result.value.url] = result.value.preview;
    }
  }

  if (Object.keys(newEmbeds).length === 0) return;

  const supabase = getSupabaseClient();
  const { error } = await supabase.rpc('update_message_embeds', {
    p_message_id: message.id,
    p_embeds: newEmbeds,
  });

  if (error) {
    logger.warn(`Failed to write embeds for message ${message.id}:`, error);
  } else {
    logger.info(`🔗 Enriched message ${message.id} with ${Object.keys(newEmbeds).length} link preview(s)`);
  }
}

/**
 * Detect external URLs in a post's content and fetch previews via LinkPreviewService.
 * Same shape as enrichMessageLinkPreviews but for the posts table.
 *
 * Called from:
 *   - postHandler.handlePostJob (BullMQ create/update branches) — the
 *     primary runtime path; reliable retries via BullMQ.
 *   - ActivityProcessor (federated/refetched remote posts).
 *   - federation-backend/backfill-posts.ts (--link-previews-only manual run).
 *
 * Idempotent: the `existingEmbeds[part.url]` filter below makes a re-run on
 * an unchanged URL set a cheap no-op, which is why the update branch can
 * call this unconditionally without checking what actually changed.
 */
export async function enrichPostLinkPreviews(post: any): Promise<void> {
  const content = post.content;
  if (!Array.isArray(content)) return;

  const instanceDomain = config.INSTANCE_DOMAIN.toLowerCase();
  const existingEmbeds: Record<string, any> = post.metadata?.embeds || {};

  const urlParts = content.filter(
    (part: any) =>
      part.type === 'url' &&
      typeof part.url === 'string' &&
      part.preview !== 'false' &&
      part.preview !== false
  );

  if (urlParts.length === 0) return;

  const eligibleUrls = urlParts.filter((part: any) => {
    try {
      const host = new URL(part.url).hostname.toLowerCase();
      return host !== instanceDomain && !existingEmbeds[part.url];
    } catch {
      return false;
    }
  });

  if (eligibleUrls.length === 0) return;

  const previewResults = await Promise.allSettled(
    eligibleUrls.map(async (part: any) => {
      const url: string = part.url;
      const preview = await linkPreviewService.getPreview(url);
      if (!preview) return null;
      return { url, preview };
    })
  );

  const newEmbeds: Record<string, any> = {};
  for (const result of previewResults) {
    if (result.status === 'fulfilled' && result.value) {
      newEmbeds[result.value.url] = result.value.preview;
    }
  }

  if (Object.keys(newEmbeds).length === 0) return;

  const supabase = getSupabaseClient();
  const { error } = await supabase.rpc('update_post_embeds', {
    p_post_id: post.id,
    p_embeds: newEmbeds,
  });

  if (error) {
    logger.warn(`Failed to write embeds for post ${post.id}:`, error);
  } else {
    logger.info(`🔗 Enriched post ${post.id} with ${Object.keys(newEmbeds).length} link preview(s)`);
  }
}

// Content conversion functions are now in utils/contentUtils.ts
// Used by: DMs, Channel Messages, Posts - ensuring consistent federation output
