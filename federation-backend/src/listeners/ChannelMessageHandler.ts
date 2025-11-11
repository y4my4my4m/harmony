/**
 * ChannelMessageHandler - Federate server channel messages
 * 
 * Handles federation of messages in Discord-like server channels
 * with smart local-first optimization
 */

import { getSupabaseClient } from '../config/supabase.js';
import { DeliveryQueue } from '../activitypub/DeliveryQueue.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';

interface ChannelMessagePayload {
  message_id: string;
  channel_id: string;
  server_id: string;
  channel_name: string;
  author_id: string;
}

/**
 * Handle channel message federation
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

    // Get server
    const { data: server } = await supabase
      .from('servers')
      .select('*')
      .eq('id', server_id)
      .single();

    if (!server) {
      logger.error(`Server ${server_id} not found`);
      return;
    }

    // Get members grouped by instance
    const { data: memberGroups, error: membersError } = await supabase
      .rpc('get_server_members_by_instance', { p_server_id: server_id });

    if (membersError || !memberGroups) {
      logger.error('Failed to get server members by instance:', membersError);
      return;
    }

    // Filter out local instance (they already got it via real-time!)
    const hostDomain = config.INSTANCE_DOMAIN;
    const remoteMemberGroups = memberGroups.filter(
      (group: any) => group.instance !== 'local' && group.instance !== hostDomain
    );

    if (remoteMemberGroups.length === 0) {
      logger.info('No remote members, skipping federation');
      return;
    }

    logger.info(
      `📊 Server has members on ${remoteMemberGroups.length} remote instances`
    );

    // Create ActivityPub activity
    const serverUrl = `https://${hostDomain}/servers/${server_id}`;
    const channelUrl = `${serverUrl}/channels/${channel_id}`;
    const activityId = `${serverUrl}/activities/${message_id}`;

    const activity = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        {
          'harmony': 'https://harmonyapp.dev/ns#',
          'channelName': 'harmony:channelName',
          'channelType': 'harmony:channelType',
        },
      ],
      id: activityId,
      type: 'Create',
      actor: message.author.ap_id || `https://${hostDomain}/users/${message.author.username}`,
      published: message.created_at,
      
      object: {
        type: 'Note',
        id: `https://${hostDomain}/messages/${message_id}`,
        content: convertContentToHTML(message.content),
        context: channelUrl,
        published: message.created_at,
        inReplyTo: message.reply_to,
        
        // Harmony metadata
        'harmony:channelName': channel_name,
        'harmony:channelType': 'text',
        'harmony:serverId': server_id,
        'harmony:serverName': server.name,
      },
      
      // Addressing
      to: [], // Will be filled per instance
      cc: [`${serverUrl}/followers`],
    };

    // Send to each remote instance (batched!)
    for (const group of remoteMemberGroups) {
      const { instance, member_ap_ids, member_count } = group;

      // Update activity with this instance's members
      activity.to = member_ap_ids || [];

      // Use shared inbox for efficiency (ONE request per instance!)
      const sharedInbox = `https://${instance}/inbox`;

      await DeliveryQueue.enqueue(
        activity,
        sharedInbox,
        message.author.id
      );

      logger.info(
        `✅ Queued delivery to ${instance} for ${member_count} members`
      );
    }

    logger.info(
      `🎉 Channel message federation complete: ${remoteMemberGroups.length} deliveries queued`
    );
  } catch (error) {
    logger.error('Error handling channel message federation:', error);
  }
}

/**
 * Convert JSONB content to HTML for ActivityPub
 */
function convertContentToHTML(content: any): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        switch (part.type) {
          case 'text':
            return escapeHtml(part.text);
          case 'mention':
            return `<a href="https://${part.domain}/users/${part.username}" class="mention">@${part.username}</a>`;
          case 'url':
            return `<a href="${part.url}">${part.url}</a>`;
          case 'emoji':
            return part.emoji || '';
          default:
            return '';
        }
      })
      .join('');
  }

  return '';
}

/**
 * Escape HTML entities
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

