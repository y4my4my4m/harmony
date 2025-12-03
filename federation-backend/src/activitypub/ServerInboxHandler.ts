/**
 * ServerInboxHandler - Process activities sent to server inboxes
 * 
 * Handles:
 * - Join/Leave activities for federated server membership
 * - Accept/Reject responses for membership requests
 * - Create/Update/Delete activities for channel messages
 * - Like/EmojiReaction for message reactions
 * - Remove/Ban for moderation
 */

import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { ActivityProcessor } from './ActivityProcessor.js';
import { DeliveryQueue } from './DeliveryQueue.js';
import config from '../config/index.js';

// =============================================================================
// MAIN HANDLER
// =============================================================================

/**
 * Process activity sent to server inbox
 */
export async function processServerInboxActivity(
  serverId: string,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();

  logger.info(`📥 Server ${serverId} received ${activity.type} activity from ${activity.actor}`);

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

  // Check if this is a local server that can receive activities
  if (!server.is_local_server) {
    logger.warn(`Server ${serverId} is not local, cannot process inbox`);
    return;
  }

  // Check if federation is enabled for this server
  if (!server.federation_enabled) {
    logger.warn(`Federation not enabled for server ${serverId}`);
    return;
  }

  // Check if sender instance is blocked
  try {
    const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    if (actorUrl) {
      const actorDomain = new URL(actorUrl).hostname;
      const { BlockedInstancesCache } = await import('../services/BlockedInstancesCache.js');
      if (BlockedInstancesCache.isBlocked(actorDomain)) {
        logger.info(`🚫 Rejecting activity from blocked instance: ${actorDomain}`);
        return;
      }
    }
  } catch (error) {
    logger.debug(`Could not check instance block status: ${error}`);
  }

  // Route activity to appropriate handler
  switch (activity.type) {
    case 'Join':
      await processJoinServer(serverId, server, activity);
      break;

    case 'Leave':
      await processLeaveServer(serverId, server, activity);
      break;

    case 'Accept':
      await processAcceptActivity(serverId, activity);
      break;

    case 'Reject':
      await processRejectActivity(serverId, activity);
      break;

    case 'Create':
      await processCreateActivity(serverId, server, activity);
      break;

    case 'Update':
      await processUpdateActivity(serverId, server, activity);
      break;

    case 'Delete':
      await processDeleteActivity(serverId, server, activity);
      break;

    case 'Like':
    case 'EmojiReaction':
      await processReactionActivity(serverId, server, activity);
      break;

    case 'Remove':
      await processRemoveActivity(serverId, server, activity);
      break;

    case 'Undo':
      await processUndoActivity(serverId, server, activity);
      break;

    default:
      // Check for Harmony-specific voice activities
      if (activity.type?.startsWith('harmony:Voice')) {
        const { VoiceActivityHandler } = await import('./VoiceActivityHandler.js');
        await VoiceActivityHandler.processVoiceActivity(activity);
      } else {
        logger.info(`Unhandled server activity type: ${activity.type}`);
      }
  }
}

// =============================================================================
// JOIN / LEAVE HANDLERS
// =============================================================================

/**
 * Process Join activity (remote user wants to join server)
 */
async function processJoinServer(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;

  logger.info(`👋 Processing Join request from ${actorUrl}`);

  // Ensure remote user exists locally
  await ActivityProcessor['ensureRemoteUser'](actorUrl);

  // Get user by federated_id (correct column name)
  const { data: user } = await supabase
    .from('profiles')
    .select('id, username, inbox_url, federated_id, is_suspended')
    .eq('federated_id', actorUrl)
    .single();

  if (!user) {
    logger.error('Failed to find/create remote user for Join activity');
    await sendRejectActivity(serverId, server, activity, actorUrl, 'User not found');
    return;
  }

  // Check if user is suspended
  if (user.is_suspended) {
    logger.warn(`Rejecting join from suspended user: ${actorUrl}`);
    await sendRejectActivity(serverId, server, activity, user.inbox_url, 'User is suspended');
    return;
  }

  // Check if user is banned from this server
  const { data: ban } = await supabase
    .from('server_bans')
    .select('id')
    .eq('server_id', serverId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (ban) {
    logger.warn(`Rejecting join from banned user: ${actorUrl}`);
    await sendRejectActivity(serverId, server, activity, user.inbox_url, 'User is banned from this server');
    return;
  }

  // Check if server is private and requires an invite
  if (!server.public) {
    const inviteCode = activity['harmony:inviteCode'];
    
    if (!inviteCode) {
      logger.warn(`Rejecting join to private server without invite code: ${actorUrl}`);
      await sendRejectActivity(serverId, server, activity, user.inbox_url, 'Private server requires invite code');
      return;
    }

    // Validate the invite code
    const { data: invite, error: inviteError } = await supabase
      .from('invites')
      .select('id, expires_at, uses, max_uses, used')
      .eq('server_id', serverId)
      .eq('code', inviteCode)
      .single();

    if (inviteError || !invite) {
      logger.warn(`Invalid invite code for private server: ${inviteCode}`);
      await sendRejectActivity(serverId, server, activity, user.inbox_url, 'Invalid invite code');
      return;
    }

    // Check if invite is expired
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      logger.warn(`Expired invite code: ${inviteCode}`);
      await sendRejectActivity(serverId, server, activity, user.inbox_url, 'Invite code has expired');
      return;
    }

    // Check if invite has reached max uses
    if (invite.max_uses !== null && (invite.uses || 0) >= invite.max_uses) {
      logger.warn(`Invite code at max uses: ${inviteCode}`);
      await sendRejectActivity(serverId, server, activity, user.inbox_url, 'Invite code has reached maximum uses');
      return;
    }

    // Increment invite usage
    await supabase
      .from('invites')
      .update({ uses: (invite.uses || 0) + 1 })
      .eq('id', invite.id);

    logger.info(`✅ Valid invite code used: ${inviteCode}`);
  }

  // Get the domain for member_instance tracking
  const memberDomain = new URL(actorUrl).hostname;

  // Check if already a member
  const { data: existing } = await supabase
    .from('user_servers')
    .select('id, status')
    .eq('server_id', serverId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (existing) {
    if (existing.status === 'accepted') {
      logger.info(`User ${user.username} already member of server ${serverId}`);
    } else {
      // Update status to accepted
      await supabase
        .from('user_servers')
        .update({ status: 'accepted' })
        .eq('id', existing.id);
    }
  } else {
    // Add to server membership
    const { error } = await supabase.from('user_servers').insert({
      server_id: serverId,
      user_id: user.id,
      status: 'accepted',
      member_instance: memberDomain,
    });

    if (error) {
      logger.error('Failed to add user to server:', error);
      await sendRejectActivity(serverId, server, activity, user.inbox_url, 'Internal error');
      return;
    }

    logger.info(`✅ Added ${user.username}@${memberDomain} to server ${serverId}`);
  }

  // Send Accept activity
  await sendAcceptActivity(serverId, server, activity, user.inbox_url);
  logger.info(`✅ Sent Accept to ${user.username}`);
}

/**
 * Process Leave activity (remote user leaving server)
 */
async function processLeaveServer(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;

  // Get user
  const { data: user } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('federated_id', actorUrl)
    .single();

  if (!user) {
    logger.warn('User not found for Leave activity');
    return;
  }

  // Remove from server
  const { error } = await supabase
    .from('user_servers')
    .delete()
    .eq('server_id', serverId)
    .eq('user_id', user.id);

  if (error) {
    logger.error('Failed to remove user from server:', error);
  } else {
    logger.info(`✅ Removed ${user.username} from server ${serverId}`);
  }
}

/**
 * Process Accept activity (remote server accepted our join request)
 */
async function processAcceptActivity(
  serverId: string,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();

  // Check if this is accepting a Join activity
  const object = activity.object;
  if (!object || object.type !== 'Join') {
    logger.info('Accept activity is not for a Join, ignoring');
    return;
  }

  // Get the user who made the join request
  const userActorUrl = typeof object.actor === 'string' ? object.actor : object.actor?.id;
  if (!userActorUrl) {
    logger.warn('Could not determine user from Join object');
    return;
  }

  const { data: user } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('federated_id', userActorUrl)
    .single();

  if (!user) {
    logger.warn('User not found for Accept activity');
    return;
  }

  // Update membership status to accepted
  const { error } = await supabase
    .from('user_servers')
    .update({ status: 'accepted' })
    .eq('server_id', serverId)
    .eq('user_id', user.id);

  if (error) {
    logger.error('Failed to update membership status:', error);
  } else {
    logger.info(`✅ Membership accepted for ${user.username} in server ${serverId}`);
  }
}

/**
 * Process Reject activity (remote server rejected our join request)
 */
async function processRejectActivity(
  serverId: string,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();

  const object = activity.object;
  if (!object || object.type !== 'Join') {
    return;
  }

  const userActorUrl = typeof object.actor === 'string' ? object.actor : object.actor?.id;
  
  const { data: user } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('federated_id', userActorUrl)
    .single();

  if (!user) {
    return;
  }

  // Remove the pending membership
  await supabase
    .from('user_servers')
    .delete()
    .eq('server_id', serverId)
    .eq('user_id', user.id);

  logger.info(`❌ Join rejected for ${user.username} in server ${serverId}`);
}

// =============================================================================
// MESSAGE HANDLERS
// =============================================================================

/**
 * Process Create activity (message in server channel)
 */
async function processCreateActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const object = activity.object;

  if (!object || object.type !== 'Note') {
    logger.info(`Create activity object is not a Note: ${object?.type}`);
    return;
  }

  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;

  // Ensure author exists
  await ActivityProcessor['ensureRemoteUser'](actorUrl);

  // Get author
  const { data: author } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('federated_id', actorUrl)
    .single();

  if (!author) {
    logger.error('Failed to find author for server message');
    return;
  }

  // Verify author is a member of this server
  const { data: membership } = await supabase
    .from('user_servers')
    .select('id, status')
    .eq('server_id', serverId)
    .eq('user_id', author.id)
    .eq('status', 'accepted')
    .maybeSingle();

  if (!membership) {
    logger.warn(`Author ${author.username} is not a member of server ${serverId}`);
    return;
  }

  // Parse context to get channel info
  const context = object.context;
  if (!context || !context.includes('/channels/')) {
    logger.warn('Message missing channel context');
    return;
  }

  // Find channel by ap_id (the context URL)
  let { data: channel } = await supabase
    .from('channels')
    .select('id, name')
    .eq('ap_id', context)
    .single();

  if (!channel) {
    // Try to extract channel ID from URL and find by local ID
    const channelIdMatch = context.match(/\/channels\/([a-f0-9-]+)/);
    if (channelIdMatch) {
      const { data: localChannel } = await supabase
        .from('channels')
        .select('id, name')
        .eq('id', channelIdMatch[1])
        .eq('server_id', serverId)
        .single();
      channel = localChannel;
    }
  }

  if (!channel) {
    // Create local reference to remote channel
    const channelName = object['harmony:channelName'] || 'remote-channel';
    const channelType = object['harmony:channelType'] === 'voice' ? 1 : 0;

    const { data: newChannel, error: channelError } = await supabase
      .from('channels')
      .insert({
        server_id: serverId,
        name: channelName,
        type: channelType,
        ap_id: context,
        is_remote: true,
      })
      .select()
      .single();

    if (channelError) {
      logger.error('Failed to create channel reference:', channelError);
      return;
    }

    channel = newChannel;
  }

  // Parse content - handle both HTML string and harmony:rawContent
  let messageContent: any[];
  if (object['harmony:rawContent'] && Array.isArray(object['harmony:rawContent'])) {
    // Use raw content if available (preserves structure)
    messageContent = object['harmony:rawContent'];
  } else if (typeof object.content === 'string') {
    // Convert HTML to content array
    messageContent = [{ type: 'text', text: stripHtml(object.content) }];
  } else if (Array.isArray(object.content)) {
    messageContent = object.content;
  } else {
    messageContent = [{ type: 'text', text: String(object.content || '') }];
  }

  // Check for duplicate message
  const { data: existingMessage } = await supabase
    .from('messages')
    .select('id')
    .eq('metadata->>ap_id', object.id)
    .maybeSingle();

  if (existingMessage) {
    logger.info(`Message already exists: ${object.id}`);
    return;
  }

  // Handle reply threading
  let replyToId: string | null = null;
  if (object.inReplyTo) {
    // Try to find the parent message
    const replyToMatch = object.inReplyTo.match(/\/messages\/([a-f0-9-]+)/);
    if (replyToMatch) {
      const { data: parentMessage } = await supabase
        .from('messages')
        .select('id')
        .eq('id', replyToMatch[1])
        .maybeSingle();
      
      if (parentMessage) {
        replyToId = parentMessage.id;
      }
    }
  }

  // Insert message
  const { error } = await supabase.from('messages').insert({
    channel_id: channel.id,
    user_id: author.id,
    content: messageContent,
    reply_to: replyToId,
    metadata: {
      ap_id: object.id,
      from_domain: new URL(actorUrl).hostname,
      federated: true,
    },
    created_at: object.published || new Date().toISOString(),
    federation_status: 'completed',
  });

  if (error) {
    logger.error('Failed to insert server message:', error);
  } else {
    logger.info(`✅ Inserted federated message in #${channel.name} from ${author.username}`);
  }
}

/**
 * Process Update activity (message edit)
 */
async function processUpdateActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const object = activity.object;

  if (!object || object.type !== 'Note') {
    return;
  }

  // Find the message by ap_id
  const { data: message } = await supabase
    .from('messages')
    .select('id, channel_id')
    .eq('metadata->>ap_id', object.id)
    .maybeSingle();

  if (!message) {
    logger.warn(`Message not found for Update: ${object.id}`);
    return;
  }

  // Parse updated content
  let messageContent: any[];
  if (object['harmony:rawContent'] && Array.isArray(object['harmony:rawContent'])) {
    messageContent = object['harmony:rawContent'];
  } else if (typeof object.content === 'string') {
    messageContent = [{ type: 'text', text: stripHtml(object.content) }];
  } else {
    messageContent = object.content || [];
  }

  // Update message
  const { error } = await supabase
    .from('messages')
    .update({
      content: messageContent,
      updated_at: object.updated || new Date().toISOString(),
    })
    .eq('id', message.id);

  if (error) {
    logger.error('Failed to update message:', error);
  } else {
    logger.info(`✏️ Updated federated message: ${object.id}`);
  }
}

/**
 * Process Delete activity (message deletion)
 */
async function processDeleteActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  
  const objectUrl = typeof activity.object === 'string' 
    ? activity.object 
    : activity.object?.id;

  if (!objectUrl) {
    return;
  }

  // Find and soft-delete the message
  const { error } = await supabase
    .from('messages')
    .update({ is_deleted: true })
    .eq('metadata->>ap_id', objectUrl);

  if (!error) {
    logger.info(`🗑️ Deleted federated message: ${objectUrl}`);
  }
}

/**
 * Process Like/EmojiReaction activity
 */
async function processReactionActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;
  const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;

  if (!objectUrl) {
    return;
  }

  // Ensure reactor exists
  await ActivityProcessor['ensureRemoteUser'](actorUrl);

  const { data: user } = await supabase
    .from('profiles')
    .select('id')
    .eq('federated_id', actorUrl)
    .single();

  if (!user) {
    return;
  }

  // Find the message
  const messageIdMatch = objectUrl.match(/\/messages\/([a-f0-9-]+)/);
  let message = null;

  if (messageIdMatch) {
    const { data } = await supabase
      .from('messages')
      .select('id')
      .eq('id', messageIdMatch[1])
      .maybeSingle();
    message = data;
  }

  if (!message) {
    // Try by ap_id in metadata
    const { data } = await supabase
      .from('messages')
      .select('id')
      .eq('metadata->>ap_id', objectUrl)
      .maybeSingle();
    message = data;
  }

  if (!message) {
    logger.warn(`Message not found for reaction: ${objectUrl}`);
    return;
  }

  // Extract emoji
  const emoji = activity.content || activity.tag?.find((t: any) => t.type === 'Emoji')?.name || '❤️';
  const emojiUrl = activity.tag?.find((t: any) => t.type === 'Emoji')?.icon?.url;

  // Find or create emoji
  let emojiId: string | null = null;
  
  if (emojiUrl) {
    // Custom emoji
    const { data: existingEmoji } = await supabase
      .from('emojis')
      .select('id')
      .eq('url', emojiUrl)
      .maybeSingle();

    if (existingEmoji) {
      emojiId = existingEmoji.id;
    } else {
      const cleanName = emoji.replace(/:/g, '');
      const { data: newEmoji } = await supabase
        .from('emojis')
        .insert({
          name: cleanName,
          url: emojiUrl,
          server_id: null,
          uploader: user.id,
          domain: new URL(emojiUrl).hostname,
        })
        .select('id')
        .single();
      
      if (newEmoji) {
        emojiId = newEmoji.id;
      }
    }
  } else {
    // Unicode emoji - find or create
    const { data: existingEmoji } = await supabase
      .from('emojis')
      .select('id')
      .eq('name', emoji)
      .is('server_id', null)
      .is('url', null)
      .maybeSingle();

    if (existingEmoji) {
      emojiId = existingEmoji.id;
    } else {
      const { data: newEmoji } = await supabase
        .from('emojis')
        .insert({
          name: emoji,
          url: null,
          server_id: null,
          uploader: user.id,
        })
        .select('id')
        .single();
      
      if (newEmoji) {
        emojiId = newEmoji.id;
      }
    }
  }

  if (!emojiId) {
    logger.error('Failed to get/create emoji for reaction');
    return;
  }

  // Add reaction (idempotent)
  const { error } = await supabase
    .from('reactions')
    .upsert({
      message_id: message.id,
      user_id: user.id,
      emoji_id: emojiId,
      metadata: { federated: true, ap_id: activity.id },
    }, {
      onConflict: 'message_id,user_id,emoji_id',
    });

  if (!error) {
    logger.info(`👍 Added reaction to message ${message.id}`);
  }
}

/**
 * Process Remove activity (kick from server)
 */
async function processRemoveActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  
  // Remove activity: actor removes object from target
  const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  
  if (!objectUrl) {
    return;
  }

  // Get the user being removed
  const { data: user } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('federated_id', objectUrl)
    .single();

  if (!user) {
    return;
  }

  // Remove from server
  await supabase
    .from('user_servers')
    .delete()
    .eq('server_id', serverId)
    .eq('user_id', user.id);

  logger.info(`👢 Kicked ${user.username} from server ${serverId}`);
}

/**
 * Process Undo activity
 */
async function processUndoActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const object = activity.object;

  if (!object) {
    return;
  }

  const objectType = typeof object === 'string' ? null : object.type;

  switch (objectType) {
    case 'Join':
      // Undo Join = Leave
      await processLeaveServer(serverId, server, object);
      break;

    case 'Like':
    case 'EmojiReaction':
      // Remove reaction
      const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;
      const targetUrl = typeof object.object === 'string' ? object.object : object.object?.id;

      const { data: user } = await supabase
        .from('profiles')
        .select('id')
        .eq('federated_id', actorUrl)
        .single();

      if (user && targetUrl) {
        const messageIdMatch = targetUrl.match(/\/messages\/([a-f0-9-]+)/);
        if (messageIdMatch) {
          await supabase
            .from('reactions')
            .delete()
            .eq('message_id', messageIdMatch[1])
            .eq('user_id', user.id);
          
          logger.info(`↩️ Removed reaction from message ${messageIdMatch[1]}`);
        }
      }
      break;

    default:
      logger.info(`Unhandled Undo object type: ${objectType}`);
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Send Accept activity for a Join request
 */
async function sendAcceptActivity(
  serverId: string,
  server: any,
  originalActivity: any,
  targetInbox: string
): Promise<void> {
  const serverUrl = `https://${config.INSTANCE_DOMAIN}/servers/${serverId}`;

  const acceptActivity = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      { 'harmony': 'https://harmonyapp.dev/ns#' },
    ],
    id: `${serverUrl}/activities/${crypto.randomUUID()}`,
    type: 'Accept',
    actor: serverUrl,
    object: originalActivity,
    published: new Date().toISOString(),
  };

  await DeliveryQueue.sendToInbox(targetInbox, acceptActivity, server.owner);
}

/**
 * Send Reject activity for a Join request
 */
async function sendRejectActivity(
  serverId: string,
  server: any,
  originalActivity: any,
  targetInbox: string,
  reason: string
): Promise<void> {
  const serverUrl = `https://${config.INSTANCE_DOMAIN}/servers/${serverId}`;

  const rejectActivity = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      { 'harmony': 'https://harmonyapp.dev/ns#' },
    ],
    id: `${serverUrl}/activities/${crypto.randomUUID()}`,
    type: 'Reject',
    actor: serverUrl,
    object: originalActivity,
    summary: reason,
    published: new Date().toISOString(),
  };

  await DeliveryQueue.sendToInbox(targetInbox, rejectActivity, server.owner);
}

/**
 * Strip HTML tags from content
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
