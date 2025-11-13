/**
 * ServerInboxHandler - Process activities sent to server inboxes
 * 
 * Handles Join/Leave activities for federated server membership
 */

import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { ActivityProcessor } from './ActivityProcessor.js';
import { DeliveryQueue } from './DeliveryQueue.js';

/**
 * Process activity sent to server inbox
 */
export async function processServerInboxActivity(
  serverId: string,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();

  logger.info(`📥 Server ${serverId} received ${activity.type} activity`);

  // Get server
  const { data: server } = await supabase
    .from('servers')
    .select('*')
    .eq('id', serverId)
    .single();

  if (!server) {
    logger.error(`Server ${serverId} not found`);
    return;
  }

  // Check if federation is enabled
  if (!server.federation_enabled) {
    logger.warn(`Federation not enabled for server ${serverId}`);
    return;
  }

  switch (activity.type) {
    case 'Join':
      await processJoinServer(serverId, server, activity);
      break;

    case 'Leave':
      await processLeaveServer(serverId, activity);
      break;

    case 'Create':
      // Handle messages posted to server from remote instances
      await processServerMessage(serverId, activity);
      break;

    case 'Undo':
      if (activity.object?.type === 'Join') {
        await processLeaveServer(serverId, activity.object);
      }
      break;

    default:
      logger.info(`Unhandled server activity type: ${activity.type}`);
  }
}

/**
 * Process Join activity (remote user wants to join server)
 */
async function processJoinServer(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();

  // Ensure remote user exists locally
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;
  await ActivityProcessor['ensureRemoteUser'](actorUrl);

  // Get user
  const { data: user } = await supabase
    .from('profiles')
    .select('id, username, inbox_url')
    .eq('ap_id', actorUrl)
    .single();

  if (!user) {
    logger.error('Failed to find/create remote user for Join activity');
    return;
  }

  // Check if already a member
  const { data: existing } = await supabase
    .from('user_servers')
    .select('id')
    .eq('server_id', serverId)
    .eq('user_id', user.id)
    .single();

  if (existing) {
    logger.info(`User ${user.username} already member of server ${serverId}`);
    // Still send Accept (idempotent)
  } else {
    // Add to server membership
    const { error } = await supabase.from('user_servers').insert({
      server_id: serverId,
      user_id: user.id,
    });

    if (error) {
      logger.error('Failed to add user to server:', error);
      return;
    }

    logger.info(`✅ Added ${user.username} to server ${serverId}`);
  }

  // Send Accept activity
  const acceptActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `https://${config.INSTANCE_DOMAIN}/servers/${serverId}/accepts/${Date.now()}`,
    type: 'Accept',
    actor: `https://${config.INSTANCE_DOMAIN}/servers/${serverId}`,
    object: activity,
  };

  await DeliveryQueue.sendToInbox(user.inbox_url, acceptActivity, server.owner);

  logger.info(`✅ Sent Accept to ${user.username}`);
}

/**
 * Process Leave activity (remote user leaving server)
 */
async function processLeaveServer(serverId: string, activity: any): Promise<void> {
  const supabase = getSupabaseClient();

  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;

  // Get user
  const { data: user } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('ap_id', actorUrl)
    .single();

  if (!user) {
    logger.warn('User not found for Leave activity');
    return;
  }

  // Remove from server
  await supabase
    .from('user_servers')
    .delete()
    .eq('server_id', serverId)
    .eq('user_id', user.id);

  logger.info(`✅ Removed ${user.username} from server ${serverId}`);
}

/**
 * Process Create activity (message in server channel)
 */
async function processServerMessage(serverId: string, activity: any): Promise<void> {
  const supabase = getSupabaseClient();

  const object = activity.object;
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;

  // Ensure author exists
  await ActivityProcessor['ensureRemoteUser'](actorUrl);

  // Get author
  const { data: author } = await supabase
    .from('profiles')
    .select('id')
    .eq('ap_id', actorUrl)
    .single();

  if (!author) {
    logger.error('Failed to find author for server message');
    return;
  }

  // Parse context to get channel info
  // Format: "https://harmonyB.com/servers/123/channels/456"
  const context = object.context;
  if (!context || !context.includes('/channels/')) {
    logger.warn('Message missing channel context');
    return;
  }

  const channelIdFromContext = context.split('/channels/')[1];

  // Find or create channel reference
  let { data: channel } = await supabase
    .from('channels')
    .select('id')
    .eq('ap_id', context)
    .single();

  if (!channel) {
    // Create local reference to remote channel
    const { data: newChannel } = await supabase
      .from('channels')
      .insert({
        server_id: serverId,
        name: object['harmony:channelName'] || 'remote-channel',
        type: object['harmony:channelType'] || 'text',
        ap_id: context,
        is_remote: true,
      })
      .select()
      .single();

    channel = newChannel;
  }

  if (!channel) {
    logger.error('Failed to create channel reference');
    return;
  }

  // Insert message
  const { error } = await supabase.from('messages').insert({
    channel_id: channel.id,
    user_id: author.id,
    content: object.content,
    ap_id: object.id,
    is_local: false,
    created_at: object.published || new Date().toISOString(),
  });

  if (error) {
    logger.error('Failed to insert server message:', error);
  } else {
    logger.info(`✅ Inserted federated message in channel ${channel.id}`);
  }
}

