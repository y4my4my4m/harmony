/**
 * Federation entry point driven by PostgreSQL NOTIFY.
 *
 * Insert into Supabase → database trigger → NOTIFY → this listener → federate.
 */

import crypto from 'crypto';
import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';
import { DeliveryQueue } from '../activitypub/DeliveryQueue.js';
import { createLikeActivity } from '../activitypub/converters/toActivityPub.js';
import { federatePostEngagement, isLikeInteraction } from '../activitypub/postEngagement.js';
import { resolveOutboundEmoji } from '../utils/emojiResolvers.js';
import { logger } from '../utils/logger.js';
import { convertContentToHTML, extractActivityPubTags, extractAttachments } from '../utils/contentUtils.js';
import { fileAttachmentsToAp } from '../utils/privateMedia.js';
import { linkPreviewService } from '../services/LinkPreviewService.js';
import { ActivityProcessor } from '../activitypub/ActivityProcessor.js';
import { getFullServerBannerUrl, getFullServerIconUrl } from '../utils/urlUtils.js';
import { getChannelRecipientGroups } from '../utils/federationUtils.js';

/** postgres_changes payloads carry `{}` for the side absent from the event. */
function rowId(row: unknown): unknown {
  return row && typeof row === 'object' && 'id' in row ? row.id : undefined;
}

export async function startDatabaseListener(): Promise<void> {
  logger.info('Starting database notification listener...');

  const supabase = getSupabaseClient();

  let channel = supabase
    .channel('federation-events');

  if (config.NODE_ENV !== 'production') {
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
          logger.debug(`REALTIME EVENT: ${payload.eventType} on ${payload.table}`, {
            id: rowId(payload.new) ?? rowId(payload.old),
            table: payload.table
          });
          return;
        }

        logger.info(`REALTIME EVENT: ${payload.eventType} on ${payload.table}`, {
          id: rowId(payload.new) ?? rowId(payload.old),
          table: payload.table
        });
      }
    );
  }

  // NOTE: post create/update/delete/pin federation runs only through BullMQ
  // (`federate-post` job → `postHandler.handlePostJob`). Trigger
  // `trigger_queue_post_federation` queues the job via pg_notify on every
  // INSERT/UPDATE/soft-delete/pin change, so `posts` has no postgres_changes
  // subscription here. Supabase Realtime does not fire for every row, and a
  // CDC path races BullMQ. `enrichPostLinkPreviews` and the home-feed realtime
  // push live in `handlePostJob`.
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
          logger.debug('Post reaction detected - handled by BullMQ:', payload.new.id);
        } else {
          logger.info('New reaction detected:', payload.new.id);
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
          logger.debug('Post favorite detected - handled by BullMQ:', payload.new.id);
        } else {
          logger.info('New favorite/like detected:', payload.new.id);
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
        logger.info('New follow detected:', payload.new.id);
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
        logger.info('Profile update detected:', payload.new.id);
        await handleProfileUpdate(payload.old, payload.new);
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'user_blocks',
      },
      async (payload) => {
        logger.info('New block detected:', payload.new.id);
        await handleNewBlock(payload.new);
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'user_blocks',
      },
      async (payload) => {
        logger.info('Unblock detected:', payload.old?.id);
        await handleUnblock(payload.old);
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'follows',
      },
      async (payload) => {
        logger.info('Unfollow detected:', payload.old?.id);
        await handleUnfollow(payload.old);
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'post_interactions',
      },
      async (payload) => {
        // Under BullMQ the delete arm of trigger_queue_interaction_federation sends the Undo.
        if (config.USE_BULLMQ_QUEUE) {
          logger.debug('Interaction removal detected - handled by BullMQ:', payload.old?.id);
        } else {
          logger.info('Interaction removal detected:', payload.old?.id);
          await handleInteractionRemoval(payload.old);
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
      },
      async (payload) => {
        // Skipped under BullMQ: the job handler calls enrichMessageLinkPreviews.
        if (!config.USE_BULLMQ_QUEUE && !payload.new.metadata?.federated) {
          enrichMessageLinkPreviews(payload.new).catch(err =>
            logger.warn('Link preview enrichment failed:', err)
          );
        }

        // conversation_id set: DM.
        if (payload.new.conversation_id && !payload.new.metadata?.federated) {
          if (config.USE_BULLMQ_QUEUE) {
            logger.debug('DM detected - handled by BullMQ:', payload.new.id);
          } else {
            logger.info('DM message detected:', {
              id: payload.new.id,
              conversation_id: payload.new.conversation_id
            });
            await handleNewDM(payload.new);
          }
        }
        // channel_id set: channel message.
        else if (payload.new.channel_id && !payload.new.metadata?.federated) {
          if (config.USE_BULLMQ_QUEUE) {
            logger.debug('Channel message detected - handled by BullMQ:', payload.new.id);
          } else {
            logger.info('Channel message detected:', {
              id: payload.new.id,
              channel_id: payload.new.channel_id
            });
            await handleNewChannelMessage(payload.new);
          }
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
      },
      async (payload) => {
        if (payload.new.channel_id && 
            JSON.stringify(payload.old.content) !== JSON.stringify(payload.new.content)) {
          if (config.USE_BULLMQ_QUEUE) {
            logger.debug('Channel message update detected - handled by BullMQ:', payload.new.id);
          } else {
            logger.info('Channel message update detected:', {
              id: payload.new.id,
              channel_id: payload.new.channel_id
            });
            await handleChannelMessageUpdate(payload.new);
          }
        }
      }
    )
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
            logger.debug('Channel message deletion detected - handled by BullMQ:', payload.old.id);
          } else {
            logger.info('Channel message deletion detected:', {
              id: payload.old.id,
              channel_id: payload.old.channel_id
            });
            await handleChannelMessageDeletion(payload.old);
          }
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'channels',
      },
      async (payload) => {
        // is_remote rows are mirrors of channels owned elsewhere.
        if (!payload.new.is_remote) {
          logger.info('Channel created:', {
            id: payload.new.id,
            name: payload.new.name,
            server_id: payload.new.server_id
          });
          await handleChannelCreated(payload.new);
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'channels',
      },
      async (payload) => {
        if (!payload.new.is_remote && 
            (payload.old.name !== payload.new.name || 
             payload.old.description !== payload.new.description ||
             payload.old.category !== payload.new.category ||
             payload.old.order !== payload.new.order)) {
          logger.info('Channel updated:', {
            id: payload.new.id,
            name: payload.new.name
          });
          await handleChannelUpdated(payload.new, payload.old);
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'channels',
      },
      async (payload) => {
        if (!payload.old.is_remote) {
          logger.info('Channel deleted:', {
            id: payload.old.id,
            name: payload.old.name
          });
          await handleChannelDeleted(payload.old);
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'reactions',
      },
      async (payload) => {
        if (config.USE_BULLMQ_QUEUE) {
          logger.debug('Message reaction detected - handled by BullMQ:', payload.new.id);
        } else {
          logger.info('New message reaction detected:', payload.new.id);
          await handleNewMessageReaction(payload.new);
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'reactions',
      },
      async (payload) => {
        if (config.USE_BULLMQ_QUEUE) {
          logger.debug('Message reaction removed - handled by BullMQ:', payload.old?.id);
        } else {
          logger.info('Message reaction removed:', payload.old?.id);
          await handleMessageReactionRemoval(payload.old);
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'servers',
      },
      async (payload) => {
        if (payload.new.is_local_server && 
            payload.new.federation_enabled &&
            (payload.old.name !== payload.new.name || 
             payload.old.description !== payload.new.description ||
             payload.old.icon !== payload.new.icon ||
             payload.old.banner !== payload.new.banner ||
             payload.old.public !== payload.new.public)) {
          logger.info('Server updated:', {
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
      logger.info(`Realtime subscription status: ${status}`);
      
      if (err) {
        logger.error('Realtime subscription error:', err);
      }
      
      if (status === 'SUBSCRIBED') {
        logger.info('Database listener active - watching for federation events');
      } else if (status === 'CHANNEL_ERROR') {
        logger.error('Database listener channel error');
      } else if (status === 'TIMED_OUT') {
        logger.error('Database listener timed out');
      } else if (status === 'CLOSED') {
        logger.warn('Database listener closed');
      }
    });

  logger.info('Database listener subscribed to federation events');
  
  setTimeout(() => {
    logger.info(`Channel state: ${channel.state}`);
  }, 2000);
}

/**
 * Legacy CDC path of federate-reaction, with the same encoding. A row the backfill of
 * 20261007200001 wrote carries federation_status skipped and federates nothing.
 */
async function handleNewReaction(interaction: any): Promise<void> {
  try {
    if (!interaction?.id || interaction.federation_status === 'skipped') return;
    await federatePostEngagement({
      type: 'create',
      interaction_id: interaction.id,
      interaction_type: interaction.interaction_type,
      post_id: interaction.post_id,
      user_id: interaction.user_id,
      emoji_id: interaction.emoji_id,
      custom_emoji_content: interaction.custom_emoji_content,
      implied: interaction.implied_by_reaction,
    });
  } catch (error) {
    logger.error('Failed to handle new reaction:', error);
  }
}

async function handleNewFollow(follow: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    // Follower must be local.
    const { data: follower } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', follow.follower_id)
      .single();

    if (!follower || !follower.is_local) {
      logger.debug('Follow from remote user, skipping outgoing federation');
      return;
    }

    const { data: following } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', follow.following_id)
      .single();

    if (!following || following.is_local) {
      logger.debug('Follow of local user, no federation needed');
      return;
    }

    logger.info(`Federating follow: ${follower.username} → ${following.username}`);

    // Imported inside the function; module-level import is circular.
    const { createFollowActivity } = await import('./FederationHandlers.js');
    const activity = createFollowActivity(follower, following);

    if (following.inbox_url) {
      await DeliveryQueue.sendToInbox(following.inbox_url, activity, follower.id);
      logger.info(`Follow request queued for delivery to ${following.inbox_url}`);
    }
  } catch (error) {
    logger.error('Failed to handle new follow:', error);
  }
}

async function handleProfileUpdate(oldProfile: any, newProfile: any): Promise<void> {
  try {
    if (!newProfile.is_local) {
      logger.debug('Profile update for remote user, skipping');
      return;
    }

    // custom_status is excluded; trigger_queue_profile_federation federates it.
    const fieldsChanged = 
      oldProfile.display_name !== newProfile.display_name ||
      oldProfile.bio !== newProfile.bio ||
      oldProfile.avatar_url !== newProfile.avatar_url ||
      oldProfile.banner_url !== newProfile.banner_url;

    if (!fieldsChanged) {
      logger.debug('No federable fields changed, skipping');
      return;
    }

    logger.info(`Federating profile update: ${newProfile.username}`);
    logger.info('Changed fields:', {
      display_name: oldProfile.display_name !== newProfile.display_name ? `"${oldProfile.display_name}" → "${newProfile.display_name}"` : 'no change',
      bio: oldProfile.bio !== newProfile.bio ? 'changed' : 'no change',
      avatar_url: oldProfile.avatar_url !== newProfile.avatar_url ? `"${oldProfile.avatar_url}" → "${newProfile.avatar_url}"` : 'no change',
      banner_url: oldProfile.banner_url !== newProfile.banner_url ? `"${oldProfile.banner_url}" → "${newProfile.banner_url}"` : 'no change',
    });

    const supabase = getSupabaseClient();

    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', newProfile.id)
      .single();

    if (!profile) {
      logger.error(`Profile not found: ${newProfile.id}`);
      return;
    }

    const { createProfileUpdateActivity } = await import('./FederationHandlers.js');
    const activity = createProfileUpdateActivity(profile);

    logger.info('Update activity object:', {
      id: activity.id,
      type: activity.type,
      actor: activity.actor,
      hasIcon: !!activity.object.icon,
      iconUrl: activity.object.icon?.url,
      hasImage: !!activity.object.image,
      imageUrl: activity.object.image?.url,
    });

    await DeliveryQueue.broadcastToFollowers(profile.id, activity);

    logger.info(`Profile update for ${profile.username} queued for federation`);
  } catch (error) {
    logger.error('Failed to handle profile update:', error);
  }
}

/** Sends Undo Follow. */
async function handleUnfollow(deletedFollow: any): Promise<void> {
  try {
    if (!deletedFollow) {
      logger.debug('No follow data in deletion event');
      return;
    }
    // processReject marks the row rejected before deleting it; the target needs no Undo.
    if (deletedFollow.status === 'rejected') {
      logger.debug('Rejected follow deleted, no Undo');
      return;
    }

    const supabase = getSupabaseClient();

    // Follower must be local.
    const { data: follower } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', deletedFollow.follower_id)
      .single();

    if (!follower || !follower.is_local) {
      logger.debug('Unfollow from remote user, skipping outgoing federation');
      return;
    }

    const { data: following } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', deletedFollow.following_id)
      .single();

    if (!following || following.is_local) {
      logger.debug('Unfollow of local user, no federation needed');
      return;
    }

    logger.info(`Federating unfollow: ${follower.username} → ${following.username}`);

    const { createUndoFollowActivity } = await import('./FederationHandlers.js');
    const activity = createUndoFollowActivity(follower, following, deletedFollow);

    if (following.inbox_url) {
      await DeliveryQueue.sendToInbox(following.inbox_url, activity, follower.id);
      logger.info(`Undo Follow queued for delivery to ${following.inbox_url}`);
    }
  } catch (error) {
    logger.error('Failed to handle unfollow:', error);
  }
}

/** Legacy CDC path of a federate-reaction delete job. */
async function handleInteractionRemoval(deletedInteraction: any): Promise<void> {
  try {
    if (!deletedInteraction?.id || !isLikeInteraction(deletedInteraction.interaction_type)) {
      // Reblog removals federate through post deletion as Undo Announce.
      return;
    }
    await federatePostEngagement({
      type: 'delete',
      interaction_id: deletedInteraction.id,
      interaction_type: deletedInteraction.interaction_type,
      post_id: deletedInteraction.post_id,
      user_id: deletedInteraction.user_id,
      emoji_id: deletedInteraction.emoji_id,
      custom_emoji_content: deletedInteraction.custom_emoji_content,
      implied: deletedInteraction.implied_by_reaction,
    });
  } catch (error) {
    logger.error('Failed to handle interaction removal:', error);
  }
}

// Pin/unpin federation (Add/Remove against the featured collection) runs in
// `queue/handlers/postHandler.ts`.

/** Sends Block to the blocked actor's inbox. */
async function handleNewBlock(block: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    const { data: blocker } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', block.blocker_id)
      .single();

    const { data: blocked } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', block.blocked_user_id)
      .single();

    if (!blocker?.is_local || !blocked) {
      logger.debug('Block not from local user or blocked user not found');
      return;
    }

    if (blocked.is_local) {
      logger.debug('Blocked user is local, no federation needed');
      return;
    }

    const { createBlockActivity } = await import('./FederationHandlers.js');
    const activity = createBlockActivity(blocker, blocked);

    if (blocked.inbox_url) {
      await DeliveryQueue.sendToInbox(blocked.inbox_url, activity, blocker.id);
      logger.info(`Block federated to ${blocked.inbox_url}`);
    }
  } catch (error) {
    logger.error('Failed to handle new block:', error);
  }
}

/** Sends Undo Block. */
async function handleUnblock(block: any): Promise<void> {
  try {
    if (!block) return;

    const supabase = getSupabaseClient();

    const { data: blocker } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', block.blocker_id)
      .single();

    const { data: blocked } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', block.blocked_user_id)
      .single();

    if (!blocker?.is_local || !blocked) {
      return;
    }

    if (blocked.is_local) {
      return;
    }

    const { createUndoBlockActivity } = await import('./FederationHandlers.js');
    const activity = createUndoBlockActivity(blocker, blocked);

    if (blocked.inbox_url) {
      await DeliveryQueue.sendToInbox(blocked.inbox_url, activity, blocker.id);
      logger.info(`Unblock federated to ${blocked.inbox_url}`);
    }
  } catch (error) {
    logger.error('Failed to handle unblock:', error);
  }
}

// CHANNEL CRUD FEDERATION HANDLERS

/**
 * Instances to tell about a channel change. A channel reaches members who can
 * view it; a category (type 2, from channel_categories) has no permissions of
 * its own and reaches every accepted remote member.
 */
async function channelChangeRecipients(channel: any): Promise<any[]> {
  return channel.type === 2
    ? getRemoteMemberGroups(channel.server_id)
    : getChannelRecipientGroups(channel.id);
}

/** Sends Add to instances hosting remote members who can view the channel. */
export async function handleChannelCreated(channel: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;
    
    const { data: server } = await supabase
      .from('servers')
      .select('id, owner, federation_enabled, is_local_server')
      .eq('id', channel.server_id)
      .single();
    
    if (!server?.federation_enabled || !server.is_local_server) {
      return;
    }
    
    if (!server.owner) {
      logger.warn(`Server ${server.id} has no owner - cannot federate channel creation`);
      return;
    }
    
    const remoteMemberGroups = await channelChangeRecipients(channel);
    if (remoteMemberGroups.length === 0) {
      return;
    }
    
    const serverUrl = `https://${hostDomain}/servers/${channel.server_id}`;
    const channelUrl = `${serverUrl}/channels/${channel.id}`;
    
    const channelType = channel.type === 2 ? 'harmony:Category' : 
                        (channel.type === 1 ? 'harmony:VoiceChannel' : 'harmony:TextChannel');
    
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
    
    // server.owner is the signing key holder for the HTTP signature.
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
    for (const group of remoteMemberGroups) {
      const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
      await DeliveryQueue.enqueue(activity, inbox, server.owner);
    }
    
    logger.info(`Channel creation federated to ${remoteMemberGroups.length} instances`);
  } catch (error) {
    logger.error('Failed to federate channel creation:', error);
  }
}

/** Sends Update to instances hosting remote members who can view the channel. */
export async function handleChannelUpdated(channel: any, _oldChannel: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;
    
    const { data: server } = await supabase
      .from('servers')
      .select('id, owner, federation_enabled, is_local_server')
      .eq('id', channel.server_id)
      .single();
    
    if (!server?.federation_enabled || !server.is_local_server) {
      return;
    }
    
    if (!server.owner) {
      logger.warn(`Server ${server.id} has no owner - cannot federate channel update`);
      return;
    }
    
    const remoteMemberGroups = await channelChangeRecipients(channel);
    if (remoteMemberGroups.length === 0) {
      return;
    }
    
    const serverUrl = `https://${hostDomain}/servers/${channel.server_id}`;
    const channelUrl = `${serverUrl}/channels/${channel.id}`;
    
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
    
    // server.owner is the signing key holder for the HTTP signature.
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
    for (const group of remoteMemberGroups) {
      const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
      await DeliveryQueue.enqueue(activity, inbox, server.owner);
    }
    
    logger.info(`Channel update federated to ${remoteMemberGroups.length} instances`);
  } catch (error) {
    logger.error('Failed to federate channel update:', error);
  }
}

/** Sends Remove to instances hosting remote members of the server. */
export async function handleChannelDeleted(channel: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;
    
    const { data: server } = await supabase
      .from('servers')
      .select('id, owner, federation_enabled, is_local_server')
      .eq('id', channel.server_id)
      .single();
    
    if (!server?.federation_enabled || !server.is_local_server) {
      return;
    }
    
    if (!server.owner) {
      logger.warn(`Server ${server.id} has no owner - cannot federate channel deletion`);
      return;
    }
    
    const remoteMemberGroups = await getRemoteMemberGroups(channel.server_id);
    if (remoteMemberGroups.length === 0) {
      return;
    }
    
    const serverUrl = `https://${hostDomain}/servers/${channel.server_id}`;
    const channelUrl = channel.ap_id || `${serverUrl}/channels/${channel.id}`;
    
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
    
    // server.owner is the signing key holder for the HTTP signature.
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
    for (const group of remoteMemberGroups) {
      const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
      await DeliveryQueue.enqueue(activity, inbox, server.owner);
    }
    
    logger.info(`Channel deletion federated to ${remoteMemberGroups.length} instances`);
  } catch (error) {
    logger.error('Failed to federate channel deletion:', error);
  }
}

/** Sends Update for the server Group object to remote member instances. */
export async function handleServerUpdated(server: any, _oldServer: any): Promise<void> {
  try {
    const hostDomain = config.INSTANCE_DOMAIN;

    if (!server.owner) {
      logger.warn(`Server ${server.id} has no owner - cannot federate server update`);
      return;
    }
    
    const remoteMemberGroups = await getRemoteMemberGroups(server.id);
    if (remoteMemberGroups.length === 0) {
      logger.info('No remote members to notify of server update');
      return;
    }
    
    const serverUrl = `https://${hostDomain}/servers/${server.id}`;
    
    const iconUrl = getFullServerIconUrl(server.icon) ?? undefined;
    const bannerUrl = getFullServerBannerUrl(server.banner) ?? undefined;

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
    
    // server.owner is the signing key holder for the HTTP signature.
    const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js');
    for (const group of remoteMemberGroups) {
      const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
      await DeliveryQueue.enqueue(activity, inbox, server.owner);
    }
    
    logger.info(`Server update federated to ${remoteMemberGroups.length} instances`);
  } catch (error) {
    logger.error('Failed to federate server update:', error);
  }
}

/** Members of a server grouped by remote instance, excluding this host. */
async function getRemoteMemberGroups(serverId: string): Promise<any[]> {
  const supabase = getSupabaseClient();
  const hostDomain = config.INSTANCE_DOMAIN;

  const { data: memberGroups, error: rpcError } = await supabase
    .rpc('get_server_members_by_instance', { p_server_id: serverId });

  if (!rpcError && memberGroups) {
    return memberGroups.filter(
      (group: any) => group.instance !== 'local' && group.instance !== hostDomain
    );
  }

  // Fallback when the RPC is unavailable or errors.
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

// CHANNEL MESSAGE FEDERATION HANDLERS

/** Delegates to ChannelMessageHandler.handleChannelMessageFederation. */
export async function handleNewChannelMessage(message: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    
    const { data: channel } = await supabase
      .from('channels')
      .select('id, name, server_id')
      .eq('id', message.channel_id)
      .single();
    
    if (!channel) {
      logger.warn(`Channel ${message.channel_id} not found for message federation`);
      return;
    }
    
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

/** Delegates to ChannelMessageHandler.handleChannelMessageUpdate. */
async function handleChannelMessageUpdate(message: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    
    const { data: channel } = await supabase
      .from('channels')
      .select('id, server_id')
      .eq('id', message.channel_id)
      .single();
    
    if (!channel) {
      return;
    }
    
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

/** Delegates to ChannelMessageHandler.handleChannelMessageDelete. */
async function handleChannelMessageDeletion(message: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    
    const { data: channel } = await supabase
      .from('channels')
      .select('id, server_id')
      .eq('id', message.channel_id)
      .single();
    
    if (!channel) {
      return;
    }
    
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

// DM MESSAGE FEDERATION HANDLERS

/**
 * Federates a DM to remote recipients.
 * Replaces the database trigger handle_outgoing_messages for DMs.
 */
export async function handleNewDM(message: any): Promise<void> {
  try {
    if (message.is_system) {
      logger.debug('Skipping federation for system message');
      return;
    }
    const supabase = getSupabaseClient();
    const domain = config.INSTANCE_DOMAIN;
    
    const { data: sender } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, domain, is_local, federated_id')
      .eq('id', message.user_id)
      .single();
    
    if (!sender) {
      logger.warn(`Could not find sender for DM: ${message.user_id}`);
      return;
    }
    
    if (!sender.is_local) {
      logger.debug('Skipping federation for message from remote user');
      return;
    }
    
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
    
    const participantIds = participants.map(p => p.user_id);
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, username, domain, federated_id, is_local, inbox_url, shared_inbox_url')
      .in('id', participantIds);
    
    if (profilesError) {
      logger.error('Error fetching participant profiles:', profilesError);
      return;
    }
    
    logger.debug(`Fetched ${profiles?.length || 0} profile(s):`, 
      profiles?.map(p => ({ username: p.username, domain: p.domain, is_local: p.is_local }))
    );
    
    // Federated users carry is_local = false and a domain.
    const remoteUsers = (profiles || []).filter(
      (p: any) => p.is_local === false && p.domain
    );
    
    if (remoteUsers.length === 0) {
      logger.debug('All DM recipients are local (no remote users to federate to)');
      return;
    }
    
    logger.info(`Federating DM to ${remoteUsers.length} remote recipient(s):`, 
      remoteUsers.map((p: any) => `${p.username}@${p.domain}`)
    );
    
    const { data: conversation } = await supabase
      .from('conversations')
      .select('type')
      .eq('id', message.conversation_id)
      .single();
    const conversationType = conversation?.type || 'direct';

    const senderUrl = `https://${domain}/users/${sender.username}`;
    const messageUrl = `https://${domain}/messages/${message.id}`;
    
    const htmlContent = convertContentToHTML(message.content);
    const attachments = extractAttachments(message.content);
    const baseTags = extractActivityPubTags(
      message.content,
      new Map(remoteUsers.filter((p: any) => p.federated_id).map((p: any) => [p.id, p.federated_id])),
    );

    // to: carries every participant so the receiver can rebuild the group.
    const allParticipantProfiles = profiles || [];
    const recipientUrls = remoteUsers.map((p: any) => 
      p.federated_id || `https://${p.domain}/users/${p.username}`
    );
    // Group conversations also list local participants except the sender. Their
    // URLs are not resolvable remotely; the receiver counts them to decide
    // group versus direct.
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
    
    // Reuse the conversation tag from the first incoming federated message;
    // Mastodon threads by this tag.
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
      // One Mention per actor; a participant named in the text appears once.
      tag: [...baseTags, ...mentionTags].filter((t: any, i: number, all: any[]) =>
        t.type !== 'Mention' || all.findIndex((u: any) => u.type === 'Mention' && u.href === t.href) === i),
      to: allToUrls,
      cc: [],
      directMessage: true,
      conversation: conversationTag,
      'harmony:encrypted': message.encrypted === true ? true : undefined,
    };

    if (conversationType === 'group') {
      note['harmony:conversationType'] = 'group';
      note['harmony:conversationId'] = message.conversation_id;

      // Linear chain: inReplyTo points at the most recent message in the
      // conversation, preferring a remote AP ID Mastodon can resolve over a
      // local message URL.
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
    
    // Later messages read the conversation tag back from metadata, and
    // GET /messages/:id serves ap_id from it.
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
      // A DM addresses one actor, so the personal inbox comes first; sharedInbox is
      // the fallback and is read off the actor document, which is where ActivityPub
      // publishes it (endpoints.sharedInbox). Same order as federationUtils.ts and
      // the other delivery paths.
      const inboxUrl = profile.inbox_url
        || profile.shared_inbox_url
        || `https://${profile.domain}/inbox`;
      // Attachment URLs name the recipient's instance.
      const recipientActivity = {
        ...activity,
        object: {
          ...note,
          attachment: [...attachments, ...fileAttachmentsToAp(message.content, String(profile.domain).toLowerCase())],
        },
      };
      await DeliveryQueue.enqueue(recipientActivity, inboxUrl, sender.id);
      logger.info(`DM federated to ${profile.username}@${profile.domain}`);
    }
  } catch (error) {
    logger.error('Error handling DM federation:', error);
  }
}

/** Sends Like for a DM reaction to every remote participant. */
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

    // Remote-origin messages keep their original ap_id as the Like object.
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
        logger.info(`Federating message reaction: ${emojiContent} (emoji_id: ${reaction.emoji_id}) to ${participant.username}@${participant.domain}`);
        return DeliveryQueue.sendToInbox(inboxUrl, activity, user.id);
      })
    );
  } catch (error) {
    logger.error('Failed to handle message reaction:', error);
  }
}

/** Sends Undo Like for a removed DM reaction to every remote participant. */
export async function handleMessageReactionRemoval(deletedReaction: any): Promise<void> {
  try {
    if (!deletedReaction) {
      logger.debug('No deleted reaction data');
      return;
    }

    const supabase = getSupabaseClient();
    const domain = config.INSTANCE_DOMAIN;

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
        logger.info(`Federating message reaction removal to ${participant.username}@${participant.domain}`);
        return DeliveryQueue.sendToInbox(inboxUrl, activity, user.id);
      })
    );
  } catch (error) {
    logger.error('Failed to handle message reaction removal:', error);
  }
}

// LINK PREVIEW ENRICHMENT

/**
 * Fetches previews for external URLs in a message via LinkPreviewService.
 * Local Harmony post URLs are covered by the DB trigger
 * process_local_link_previews; everything else lands here.
 *
 * Called from the BullMQ job handlers (channelMessageHandler, dmHandler);
 * Supabase Realtime does not fire for every message INSERT.
 */
export async function enrichMessageLinkPreviews(message: any): Promise<void> {
  const content = message.content;
  if (!Array.isArray(content)) return;
  if (message.metadata?.suppress_embeds === true) return;

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
            logger.info(`Auto-imported fediverse post ${preview.fediverse.postUrl} → ${imported.id}`);
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
    logger.info(`Enriched message ${message.id} with ${Object.keys(newEmbeds).length} link preview(s)`);
  }
}

/**
 * enrichMessageLinkPreviews against the posts table.
 *
 * Callers:
 *   - postHandler.handlePostJob (BullMQ create/update branches), the primary
 *     runtime path, with retries.
 *   - ActivityProcessor, for federated and refetched remote posts.
 *   - federation-backend/backfill-posts.ts (--link-previews-only).
 *
 * Idempotent: the `existingEmbeds[part.url]` filter reduces a re-run over an
 * unchanged URL set to a no-op, so the update branch calls this
 * unconditionally.
 */
export async function enrichPostLinkPreviews(post: any): Promise<boolean> {
  const content = post.content;
  if (!Array.isArray(content)) return false;

  const instanceDomain = config.INSTANCE_DOMAIN.toLowerCase();
  const existingEmbeds: Record<string, any> = post.metadata?.embeds || {};

  const urlParts = content.filter(
    (part: any) =>
      part.type === 'url' &&
      typeof part.url === 'string' &&
      part.preview !== 'false' &&
      part.preview !== false
  );

  if (urlParts.length === 0) return false;

  const eligibleUrls = urlParts.filter((part: any) => {
    try {
      const host = new URL(part.url).hostname.toLowerCase();
      return host !== instanceDomain && !existingEmbeds[part.url];
    } catch {
      return false;
    }
  });

  if (eligibleUrls.length === 0) return false;

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

  if (Object.keys(newEmbeds).length === 0) return false;

  const supabase = getSupabaseClient();
  const { error } = await supabase.rpc('update_post_embeds', {
    p_post_id: post.id,
    p_embeds: newEmbeds,
  });

  if (error) {
    logger.warn(`Failed to write embeds for post ${post.id}:`, error);
    return false;
  }

  logger.info(`Enriched post ${post.id} with ${Object.keys(newEmbeds).length} link preview(s)`);
  return true;
}

// Content conversion lives in utils/contentUtils.ts, shared by DMs, channel
// messages and posts so federated output stays identical across them.
