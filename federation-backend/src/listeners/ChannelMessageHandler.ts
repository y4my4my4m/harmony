/**
 * ChannelMessageHandler - Federate server channel messages
 * 
 * Handles federation of messages in Discord-like server channels
 * with smart local-first optimization.
 * 
 * Supports:
 * - Create: New messages
 * - Update: Message edits
 * - Delete: Message deletion
 */

import { getSupabaseClient } from '../config/supabase.js';
import { DeliveryQueue } from '../activitypub/DeliveryQueue.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';
import { convertContentToHTML, extractActivityPubTags, extractAttachments } from '../utils/contentUtils.js';
import { harmonyVoiceMessageExtension } from '../utils/voiceMessageFederation.js';
import { getRemoteMemberGroups, type RemoteMemberGroup } from '../utils/federationUtils.js';

// =============================================================================
// TYPES
// =============================================================================

interface ChannelMessagePayload {
  message_id: string;
  channel_id: string;
  server_id: string;
  channel_name: string;
  author_id: string;
}

interface ChannelMessageUpdatePayload {
  message_id: string;
  channel_id: string;
  server_id: string;
}

interface ChannelMessageDeletePayload {
  message_id: string;
  channel_id: string;
  server_id: string;
  ap_id?: string;
}

// =============================================================================
// CREATE MESSAGE HANDLER
// =============================================================================

/**
 * Handle channel message federation (Create)
 * Called when database trigger detects remote members
 */
export async function handleChannelMessageFederation(
  payload: ChannelMessagePayload
): Promise<void> {
  try {
    const { message_id, channel_id, server_id, channel_name } = payload;
    const supabase = getSupabaseClient();

    logger.info(`📨 Federating channel message ${message_id} in #${channel_name}`);

    const { data: message, error: messageError } = await supabase
      .from('messages')
      .select(`
        *,
        author:profiles!messages_user_id_fkey(*)
      `)
      .eq('id', message_id)
      .single();

    if (messageError || !message) {
      logger.error('Failed to fetch message for federation:', messageError);
      return;
    }

    // Skip if message is already federated or from a remote user
    if (message.federation_status === 'completed') {
      logger.info('Message already federated, skipping');
      return;
    }

    // Enrich with thread parent message ID for stub thread creation on remote instances
    if (message.thread_id) {
      const { data: thread } = await supabase
        .from('threads')
        .select('parent_message_id')
        .eq('id', message.thread_id)
        .maybeSingle();
      if (thread) {
        message.thread_parent_message_id = thread.parent_message_id;
      }
    }

    const { data: server } = await supabase
      .from('servers')
      .select('*, federation_inbox_url, ap_id, is_local_server')
      .eq('id', server_id)
      .single();

    if (!server) {
      logger.error(`Server ${server_id} not found`);
      return;
    }

    // CASE 1: User is sending message to a REMOTE server
    // We need to forward the message to the remote server's inbox
    if (server.is_local_server === false && server.federation_inbox_url) {
      logger.info(`📤 User sending message to REMOTE server: ${server.name}`);
      
      const { data: author } = await supabase
        .from('profiles')
        .select('id, username, federated_id, is_local')
        .eq('id', message.author?.id || payload.author_id)
        .single();

      if (!author?.is_local) {
        logger.info('Author is not local, skipping federation to remote server');
        return;
      }

      const activity = createMessageActivity(
        message,
        server,
        channel_id,
        channel_name,
        'Create'
      );

      // Deliver to remote server's inbox (static method)
      await DeliveryQueue.enqueue(
        activity,
        server.federation_inbox_url,
        author.id,
        5 // priority
      );

    // Update federation status (preserve updated_at to avoid showing as edited)
    await supabase
      .from('messages')
      .update({ 
        federation_status: 'completed',
        updated_at: message.updated_at || message.created_at, // Preserve original timestamp
        metadata: {
          ...(message.metadata || {}),
          federated_at: new Date().toISOString(),
          federated_to: [new URL(server.federation_inbox_url).hostname],
        }
      })
      .eq('id', message_id);

      logger.info(`🎉 Message sent to remote server inbox: ${server.federation_inbox_url}`);
      return;
    }

    // CASE 2: Local server with remote members - federate to those members
    if (!server.federation_enabled) {
      logger.info(`Federation not enabled for server ${server_id}, skipping`);
      await supabase
        .from('messages')
        .update({ 
          federation_status: 'skipped',
          updated_at: message.updated_at || message.created_at
        })
        .eq('id', message_id);
      return;
    }

    const remoteMemberGroups = await getRemoteMemberGroups(server_id);

    if (remoteMemberGroups.length === 0) {
      logger.info('No remote members, skipping federation');
      
      await supabase
        .from('messages')
        .update({ 
          federation_status: 'skipped',
          updated_at: message.updated_at || message.created_at
        })
        .eq('id', message_id);
      
      return;
    }

    logger.info(`📊 Server has members on ${remoteMemberGroups.length} remote instances`);

    // Ensure author exists for federation
    if (!message.author?.id) {
      logger.error(`Message ${message_id} has no valid author, skipping federation`);
      return;
    }

    const activity = createMessageActivity(
      message,
      server,
      channel_id,
      channel_name,
      'Create'
    );

    await deliverToRemoteInstances(remoteMemberGroups, activity, message.author.id);

    // Update federation status (preserve updated_at to avoid showing as edited)
    await supabase
      .from('messages')
      .update({ 
        federation_status: 'completed',
        updated_at: message.updated_at || message.created_at, // Preserve original timestamp
        metadata: {
          ...(message.metadata || {}),
          federated_at: new Date().toISOString(),
          federated_to: remoteMemberGroups.map(g => g.instance),
        }
      })
      .eq('id', message_id);

    logger.info(`🎉 Channel message federation complete: ${remoteMemberGroups.length} deliveries queued`);
  } catch (error) {
    logger.error('Error handling channel message federation:', error);
  }
}

// =============================================================================
// UPDATE MESSAGE HANDLER
// =============================================================================

/**
 * Handle channel message update federation
 */
export async function handleChannelMessageUpdate(
  payload: ChannelMessageUpdatePayload
): Promise<void> {
  try {
    const { message_id, channel_id, server_id } = payload;
    const supabase = getSupabaseClient();

    logger.info(`✏️ Federating message update ${message_id}`);

    const { data: message, error: messageError } = await supabase
      .from('messages')
      .select(`
        *,
        author:profiles!messages_user_id_fkey(*),
        channel:channels!messages_channel_id_fkey(name)
      `)
      .eq('id', message_id)
      .single();

    if (messageError || !message) {
      logger.error('Failed to fetch message for update federation:', messageError);
      return;
    }

    if (message.thread_id) {
      const { data: thread } = await supabase
        .from('threads')
        .select('parent_message_id')
        .eq('id', message.thread_id)
        .maybeSingle();
      if (thread) {
        message.thread_parent_message_id = thread.parent_message_id;
      }
    }

    const { data: server } = await supabase
      .from('servers')
      .select('*, federation_inbox_url, is_local_server')
      .eq('id', server_id)
      .single();

    if (!server) {
      return;
    }

    if (!message.author?.id) {
      logger.error(`Message ${message_id} has no valid author, skipping update federation`);
      return;
    }

    // CASE 1: Non-local server - forward edit to the remote server's inbox
    if (server.is_local_server === false && server.federation_inbox_url) {
      logger.info(`📤 Forwarding message edit to remote server: ${server.name}`);

      const activity = createMessageActivity(
        message, server, channel_id,
        message.channel?.name || 'channel', 'Update'
      );

      await DeliveryQueue.enqueue(
        activity, server.federation_inbox_url, message.author.id, 5
      );

      logger.info(`✏️ Message edit forwarded to ${server.federation_inbox_url}`);
      return;
    }

    // CASE 2: Local server - broadcast edit to remote member instances
    if (!server.federation_enabled) {
      return;
    }

    const remoteMemberGroups = await getRemoteMemberGroups(server_id);

    if (remoteMemberGroups.length === 0) {
      return;
    }

    const activity = createMessageActivity(
      message, server, channel_id,
      message.channel?.name || 'channel', 'Update'
    );

    await deliverToRemoteInstances(remoteMemberGroups, activity, message.author.id);

    logger.info(`✏️ Message update federated to ${remoteMemberGroups.length} instances`);
  } catch (error) {
    logger.error('Error handling channel message update federation:', error);
  }
}

// =============================================================================
// DELETE MESSAGE HANDLER
// =============================================================================

/**
 * Handle channel message deletion federation
 */
export async function handleChannelMessageDelete(
  payload: ChannelMessageDeletePayload
): Promise<void> {
  try {
    const { message_id, server_id, ap_id } = payload;
    const supabase = getSupabaseClient();

    logger.info(`🗑️ Federating message deletion ${message_id}`);

    const { data: server } = await supabase
      .from('servers')
      .select('*, federation_inbox_url, is_local_server')
      .eq('id', server_id)
      .single();

    if (!server) {
      return;
    }

    const hostDomain = config.INSTANCE_DOMAIN;
    const serverUrl = `https://${hostDomain}/servers/${server_id}`;
    const messageUrl = ap_id || `https://${hostDomain}/messages/${message_id}`;

    const activity = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        { 'harmony': 'https://harmonyapp.dev/ns#' },
      ],
      id: `${serverUrl}/activities/${crypto.randomUUID()}`,
      type: 'Delete',
      actor: serverUrl,
      object: messageUrl,
      published: new Date().toISOString(),
    };

    // CASE 1: Non-local server - forward delete to the remote server's inbox
    if (server.is_local_server === false && server.federation_inbox_url) {
      logger.info(`📤 Forwarding message delete to remote server: ${server.name}`);

      await DeliveryQueue.enqueue(
        activity, server.federation_inbox_url, server.owner, 5
      );

      logger.info(`🗑️ Message delete forwarded to ${server.federation_inbox_url}`);
      return;
    }

    // CASE 2: Local server - broadcast delete to remote member instances
    if (!server.federation_enabled) {
      return;
    }

    const remoteMemberGroups = await getRemoteMemberGroups(server_id);

    if (remoteMemberGroups.length === 0) {
      return;
    }

    await deliverToRemoteInstances(remoteMemberGroups, activity, server.owner);

    logger.info(`🗑️ Message deletion federated to ${remoteMemberGroups.length} instances`);
  } catch (error) {
    logger.error('Error handling channel message deletion federation:', error);
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create ActivityPub activity for a message
 */
function createMessageActivity(
  message: any,
  server: any,
  channelId: string,
  channelName: string,
  activityType: 'Create' | 'Update'
): any {
  const hostDomain = config.INSTANCE_DOMAIN;
  const serverUrl = `https://${hostDomain}/servers/${server.id}`;
  const channelUrl = `${serverUrl}/channels/${channelId}`;
  const messageUrl = `https://${hostDomain}/messages/${message.id}`;
  const activityId = `${serverUrl}/activities/${message.id}`;

  if (!message.author?.username) {
    throw new Error(`Cannot create activity: message ${message.id} has no valid author`);
  }
  const authorApId = message.author.federated_id || 
    `https://${hostDomain}/users/${message.author.username}`;

  const contentHtml = convertContentToHTML(message.content);
  const tags = extractActivityPubTags(message.content);
  const attachments = extractAttachments(message.content);

  // Transform emoji URLs to absolute URLs for federation
  const federatedContent = Array.isArray(message.content) 
    ? message.content.map((item: any) => {
        if (item.type === 'emoji' && item.emoji?.url) {
          let emojiUrl = item.emoji.url;
          if (!emojiUrl.startsWith('http://') && !emojiUrl.startsWith('https://')) {
            const baseUrl = config.PUBLIC_SUPABASE_URL || config.SUPABASE_URL;
            emojiUrl = emojiUrl.startsWith('/') ? `${baseUrl}${emojiUrl}` : `${baseUrl}/${emojiUrl}`;
          }
          return {
            ...item,
            emoji: {
              ...item.emoji,
              url: emojiUrl
            }
          };
        }
        return item;
      })
    : message.content;

  let inReplyTo: string | undefined;
  if (message.reply_to) {
    inReplyTo = `https://${hostDomain}/messages/${message.reply_to}`;
  }

  // Thread context - if this message belongs to a thread, include the thread AP ID
  let threadApId: string | undefined;
  let parentMessageApId: string | undefined;
  if (message.thread_id) {
    threadApId = `https://${hostDomain}/threads/${message.thread_id}`;
    // Include thread's parent message so remote instances can create correct stub threads
    if (message.thread_parent_message_id) {
      parentMessageApId = `https://${hostDomain}/messages/${message.thread_parent_message_id}`;
    }
  }

  const voiceHarmony = harmonyVoiceMessageExtension(message.metadata);

  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      {
        'harmony': 'https://harmonyapp.dev/ns#',
        'rawContent': 'harmony:rawContent',
        'channelName': 'harmony:channelName',
        'channelType': 'harmony:channelType',
        'serverId': 'harmony:serverId',
        'serverName': 'harmony:serverName',
        'encrypted': 'harmony:encrypted',
        'threadId': 'harmony:threadId',
        'parentMessageId': 'harmony:parentMessageId',
        'voiceMessage': 'harmony:voiceMessage',
      },
    ],
    id: activityType === 'Update' ? `${activityId}/updates/${Date.now()}` : activityId,
    type: activityType,
    actor: authorApId,
    published: message.created_at,
    updated: activityType === 'Update' ? message.updated_at : undefined,

    object: {
      type: 'Note',
      id: messageUrl,
      attributedTo: authorApId,
      content: contentHtml,
      'harmony:rawContent': federatedContent, // Send transformed content with absolute emoji URLs
      
      // Channel context
      context: channelUrl,
      'harmony:channelName': channelName,
      'harmony:channelType': 'text',
      'harmony:serverId': server.id,
      'harmony:serverName': server.name,

      // Timestamps
      published: message.created_at,
      updated: message.updated_at !== message.created_at ? message.updated_at : undefined,

      // Threading
      inReplyTo,
      'harmony:threadId': threadApId,
      'harmony:parentMessageId': parentMessageApId,

      // Tags and attachments
      tag: tags.length > 0 ? tags : undefined,
      attachment: attachments.length > 0 ? attachments : undefined,

      // E2EE indicator - remote instances can't decrypt but should show the lock glyph
      'harmony:encrypted': message.encrypted === true ? true : undefined,

      // Voice message UI (waveform player) - metadata is not inside harmony:rawContent
      ...(voiceHarmony ? { 'harmony:voiceMessage': voiceHarmony } : {}),
    },

    // Addressing - to server members
    to: [`${serverUrl}/members`],
    cc: [],
  };
}

/**
 * Deliver activity to remote instances
 */
async function deliverToRemoteInstances(
  groups: RemoteMemberGroup[],
  activity: any,
  senderId: string
): Promise<void> {
  for (const group of groups) {
    // Use shared inbox for efficiency
    const inbox = group.shared_inbox || `https://${group.instance}/inbox`;

    const activityWithRecipients = {
      ...activity,
      to: group.member_ap_ids,
      cc: activity.cc,
    };

    await DeliveryQueue.enqueue(activityWithRecipients, inbox, senderId);

    logger.info(`✅ Queued delivery to ${group.instance} for ${group.member_count} members`);
  }
}
