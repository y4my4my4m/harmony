/**
 * Thread Federation Job Handler
 * 
 * Processes federate-thread jobs (thread creation/updates)
 * Federates threads to remote instances
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { logger } from '../../utils/logger.js';
import config from '../../config/index.js';
import type { FederationJobData } from '../BullMQManager.js';
import { createThreadActivity } from '../../activitypub/ThreadActivityHandler.js';
import { getRemoteMemberGroups } from '../../utils/federationUtils.js';

export async function handleThreadJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { thread_id, server_id, type } = data;
  const hostDomain = config.INSTANCE_DOMAIN;

  logger.info(`📋 Processing thread ${type} job for thread: ${thread_id}, server: ${server_id}`);

  try {
    const { data: thread, error: threadError } = await supabase
      .from('threads')
      .select(`
        *,
        channel:channels!threads_channel_id_fkey(
          id,
          name,
          ap_id,
          server_id,
          server:servers!channels_server_id_fkey(
            id,
            name,
            federation_enabled,
            is_local_server,
            federation_inbox_url
          )
        ),
        creator:profiles!threads_created_by_fkey(
          id,
          username,
          federated_id,
          is_local
        )
      `)
      .eq('id', thread_id)
      .single();

    if (threadError || !thread) {
      logger.error(`Thread not found: ${thread_id}`, threadError);
      return;
    }

    const { data: parentMessage, error: parentMsgError } = await supabase
      .from('messages')
      .select('id, metadata')
      .eq('id', thread.parent_message_id)
      .single();

    if (parentMsgError || !parentMessage) {
      logger.error(`Parent message not found for thread ${thread_id}: ${thread.parent_message_id}`, parentMsgError);
      return;
    }

    const channel = (thread as any).channel;
    const server = channel?.server;
    const creator = (thread as any).creator;

    if (!server || !creator) {
      logger.error(`Missing required thread data: server=${!!server}, channel=${!!channel}, creator=${!!creator}`);
      return;
    }

    logger.info(`📋 Thread "${thread.name}" data: creator.is_local=${creator.is_local}, server.is_local=${server.is_local_server}, federation_enabled=${server.federation_enabled}, channel=${channel.name} (${channel.id})`);

    if (!creator.is_local) {
      logger.info('Thread creator is not local, skipping federation');
      return;
    }

    const creatorApId = creator.federated_id || 
      `https://${hostDomain}/users/${creator.username}`;

    // Use consistent channel AP URL format: https://domain/servers/{serverId}/channels/{channelId}
    // This matches how handleChannelCreated federates channels (object.id = serverUrl/channels/channelId)
    const serverUrl = `https://${hostDomain}/servers/${server.id}`;
    const channelApId = channel.ap_id || `${serverUrl}/channels/${channel.id}`;
    const parentMessageApId = parentMessage.metadata?.ap_id || 
      `https://${hostDomain}/messages/${parentMessage.id}`;

    logger.info(`📋 Thread AP IDs: channelApId=${channelApId}, parentMessageApId=${parentMessageApId}, creatorApId=${creatorApId}`);

    // CASE 1: Remote server - federate thread to that server's inbox
    if (!server.is_local_server && server.federation_inbox_url) {
      logger.info(`📤 Federating thread to remote server inbox: ${server.federation_inbox_url}`);
      
      const threadActivity = createThreadActivity(
        type === 'create' ? 'Create' : 'Update',
        thread,
        channelApId,
        parentMessageApId,
        creatorApId,
        creatorApId,
        server.id,
        channel.name,
        channel.id
      );

      await DeliveryQueue.enqueue(
        threadActivity,
        server.federation_inbox_url,
        creator.id,
        5
      );

      await supabase
        .from('threads')
        .update({ federation_status: 'completed' })
        .eq('id', thread_id);

      logger.info(`✅ Thread federated to ${server.federation_inbox_url}`);
      return;
    }

    // CASE 2: Local server with remote members - broadcast to all remote instances
    if (server.federation_enabled) {
      const remoteMemberGroups = await getRemoteMemberGroups(server.id);

      if (remoteMemberGroups.length === 0) {
        logger.info('No remote members, skipping thread federation');
        await supabase
          .from('threads')
          .update({ federation_status: 'skipped' })
          .eq('id', thread_id);
        return;
      }

      const threadActivity = createThreadActivity(
        type === 'create' ? 'Create' : 'Update',
        thread,
        channelApId,
        parentMessageApId,
        creatorApId,
        creatorApId,
        server.id,
        channel.name,
        channel.id
      );

      for (const group of remoteMemberGroups) {
        const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
        const activityWithRecipients = {
          ...threadActivity,
          to: group.member_ap_ids,
          cc: threadActivity.cc,
        };
        await DeliveryQueue.enqueue(activityWithRecipients, inbox, creator.id, 5);
        logger.info(`📤 Thread queued for ${group.instance} (${group.member_count} members)`);
      }

      await supabase
        .from('threads')
        .update({ federation_status: 'completed' })
        .eq('id', thread_id);

      logger.info(`✅ Thread federated to ${remoteMemberGroups.length} instances`);
    } else {
      await supabase
        .from('threads')
        .update({ federation_status: 'skipped' })
        .eq('id', thread_id);
    }

  } catch (error) {
    logger.error(`Failed to federate thread ${thread_id}:`, error);
    await supabase
      .from('threads')
      .update({ federation_status: 'failed' })
      .eq('id', thread_id);
    throw error;
  }
}
