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

interface RemoteMemberGroup {
  instance: string;
  member_ap_ids: string[];
  member_count: number;
  shared_inbox?: string;
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

    // Get message with author
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

    // Get server with federation info
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
      
      // Check if the author is local
      const { data: author } = await supabase
        .from('profiles')
        .select('id, username, federated_id, is_local')
        .eq('id', message.author?.id || payload.author_id)
        .single();

      if (!author?.is_local) {
        logger.info('Author is not local, skipping federation to remote server');
        return;
      }

      // Create activity to send to remote server
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

    // Update federation status
    await supabase
      .from('messages')
      .update({ 
        federation_status: 'completed',
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
    // Check if server has federation enabled
    if (!server.federation_enabled) {
      logger.info(`Federation not enabled for server ${server_id}`);
      return;
    }

    // Get remote member groups
    const remoteMemberGroups = await getRemoteMemberGroups(server_id);

    if (remoteMemberGroups.length === 0) {
      logger.info('No remote members, skipping federation');
      
      // Mark as skipped
      await supabase
        .from('messages')
        .update({ federation_status: 'skipped' })
        .eq('id', message_id);
      
      return;
    }

    logger.info(`📊 Server has members on ${remoteMemberGroups.length} remote instances`);

    // Ensure author exists for federation
    if (!message.author?.id) {
      logger.error(`Message ${message_id} has no valid author, skipping federation`);
      return;
    }

    // Create ActivityPub activity
    const activity = createMessageActivity(
      message,
      server,
      channel_id,
      channel_name,
      'Create'
    );

    // Send to each remote instance
    await deliverToRemoteInstances(remoteMemberGroups, activity, message.author.id);

    // Update federation status
    await supabase
      .from('messages')
      .update({ 
        federation_status: 'completed',
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

    // Get message with author and channel
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

    // Get server
    const { data: server } = await supabase
      .from('servers')
      .select('*')
      .eq('id', server_id)
      .single();

    if (!server || !server.federation_enabled) {
      return;
    }

    // Get remote member groups
    const remoteMemberGroups = await getRemoteMemberGroups(server_id);

    if (remoteMemberGroups.length === 0) {
      return;
    }

    // Ensure author exists for federation
    if (!message.author?.id) {
      logger.error(`Message ${message_id} has no valid author, skipping update federation`);
      return;
    }

    // Create Update activity
    const activity = createMessageActivity(
      message,
      server,
      channel_id,
      message.channel?.name || 'channel',
      'Update'
    );

    // Send to each remote instance
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

    // Get server
    const { data: server } = await supabase
      .from('servers')
      .select('*')
      .eq('id', server_id)
      .single();

    if (!server || !server.federation_enabled) {
      return;
    }

    // Get remote member groups
    const remoteMemberGroups = await getRemoteMemberGroups(server_id);

    if (remoteMemberGroups.length === 0) {
      return;
    }

    const hostDomain = config.INSTANCE_DOMAIN;
    const serverUrl = `https://${hostDomain}/servers/${server_id}`;
    const messageUrl = ap_id || `https://${hostDomain}/messages/${message_id}`;

    // Create Delete activity
    const activity = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        { 'harmony': 'https://harmonyapp.dev/ns#' },
      ],
      id: `${serverUrl}/activities/${crypto.randomUUID()}`,
      type: 'Delete',
      actor: serverUrl, // Server is the actor for deletions
      object: messageUrl,
      published: new Date().toISOString(),
    };

    // Send to each remote instance
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
 * Get remote member groups for a server
 */
async function getRemoteMemberGroups(serverId: string): Promise<RemoteMemberGroup[]> {
  const supabase = getSupabaseClient();
  const hostDomain = config.INSTANCE_DOMAIN;

  // Try the RPC function first (more efficient)
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
  const instanceMap = new Map<string, RemoteMemberGroup>();

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

  // Get author AP ID - require valid author with username
  if (!message.author?.username) {
    throw new Error(`Cannot create activity: message ${message.id} has no valid author`);
  }
  const authorApId = message.author.federated_id || 
    `https://${hostDomain}/users/${message.author.username}`;

  // Convert content
  const contentHtml = convertContentToHTML(message.content);
  const tags = extractActivityPubTags(message.content);
  const attachments = extractAttachments(message.content);

  // Handle reply threading
  let inReplyTo: string | undefined;
  if (message.reply_to) {
    inReplyTo = `https://${hostDomain}/messages/${message.reply_to}`;
  }

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
      'harmony:rawContent': message.content, // Preserve original structure
      
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

      // Tags and attachments
      tag: tags.length > 0 ? tags : undefined,
      attachment: attachments.length > 0 ? attachments : undefined,
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

    // Add specific recipients to the activity
    const activityWithRecipients = {
      ...activity,
      to: group.member_ap_ids,
      cc: activity.cc,
    };

    await DeliveryQueue.enqueue(activityWithRecipients, inbox, senderId);

    logger.info(`✅ Queued delivery to ${group.instance} for ${group.member_count} members`);
  }
}
