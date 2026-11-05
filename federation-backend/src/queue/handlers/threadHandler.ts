/**
 * Thread Federation Job Handler
 *
 * Processes federate-thread jobs (thread creation, updates and deletes)
 * Federates threads to remote instances
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { logger } from '../../utils/logger.js';
import config from '../../config/index.js';
import type { FederationJobData } from '../BullMQManager.js';
import { createThreadActivity, createThreadDeleteActivity } from '../../activitypub/ThreadActivityHandler.js';
import { getChannelRecipientGroups } from '../../utils/federationUtils.js';

/**
 * Delete of a thread of a server hosted here (trigger_queue_thread_delete_federation,
 * migration 20261106200001). The row is gone; the job carries its ids. The server's Group
 * signs, as for a message Delete, and delivers to the instances of members who view the
 * channel.
 */
export async function handleThreadDeleteJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { thread_id, ap_id, channel_id, server_id } = data;
  const hostDomain = config.INSTANCE_DOMAIN;

  const { data: server } = await supabase
    .from('servers')
    .select('id, federation_enabled, is_local_server')
    .eq('id', server_id)
    .maybeSingle();
  if (!server?.is_local_server || !server.federation_enabled) {
    logger.info(`Thread ${thread_id} delete: server ${server_id} is not a federated server hosted here`);
    return;
  }

  const { data: channel } = await supabase
    .from('channels')
    .select('id, ap_id')
    .eq('id', channel_id)
    .eq('server_id', server.id)
    .maybeSingle();
  if (!channel) {
    logger.info(`Thread ${thread_id} delete: channel ${channel_id} is gone; its Delete covers the thread`);
    return;
  }

  const groups = await getChannelRecipientGroups(channel.id);
  if (groups.length === 0) return;

  const serverUrl = `https://${hostDomain}/servers/${server.id}`;
  const activity = createThreadDeleteActivity(
    ap_id || `https://${hostDomain}/threads/${thread_id}`,
    channel.ap_id || `${serverUrl}/channels/${channel.id}`,
    serverUrl,
    server.id,
    channel.id,
  );

  for (const group of groups) {
    const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
    await DeliveryQueue.enqueue({ ...activity, to: group.member_ap_ids }, inbox, { serverId: server.id }, 5);
  }
  logger.info(`Thread ${thread_id} delete federated to ${groups.length} instances`);
}

export async function handleThreadJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { thread_id, server_id, type } = data;
  const hostDomain = config.INSTANCE_DOMAIN;

  logger.info(`Processing thread ${type} job for thread: ${thread_id}, server: ${server_id}`);

  if (type === 'delete') {
    await handleThreadDeleteJob(data);
    return;
  }

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

    // A standalone thread's parent is its own 'started a thread' notice, which the
    // receiver posts itself rather than resolving.
    const standalone = parentMessage.metadata?.type === 'thread_created';
    const channel = (thread as any).channel;
    const server = channel?.server;
    const creator = (thread as any).creator;

    if (!server || !creator) {
      logger.error(`Missing required thread data: server=${!!server}, channel=${!!channel}, creator=${!!creator}`);
      return;
    }

    logger.info(`Thread "${thread.name}" data: creator.is_local=${creator.is_local}, server.is_local=${server.is_local_server}, federation_enabled=${server.federation_enabled}, channel=${channel.name} (${channel.id})`);

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

    logger.info(`Thread AP IDs: channelApId=${channelApId}, parentMessageApId=${parentMessageApId}, creatorApId=${creatorApId}`);

    // CASE 1: Remote server - federate thread to that server's inbox
    if (!server.is_local_server && server.federation_inbox_url) {
      logger.info(`Federating thread to remote server inbox: ${server.federation_inbox_url}`);
      
      const threadActivity = createThreadActivity(
        type === 'create' ? 'Create' : 'Update',
        thread,
        channelApId,
        parentMessageApId,
        creatorApId,
        creatorApId,
        server.id,
        channel.name,
        channel.id,
        standalone
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

      logger.info(`Thread federated to ${server.federation_inbox_url}`);
      return;
    }

    // CASE 2: Local server with remote members - broadcast to all remote instances
    if (server.federation_enabled) {
      const remoteMemberGroups = await getChannelRecipientGroups(channel.id);

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
        channel.id,
        standalone
      );

      for (const group of remoteMemberGroups) {
        const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
        const activityWithRecipients = {
          ...threadActivity,
          to: group.member_ap_ids,
          cc: threadActivity.cc,
        };
        await DeliveryQueue.enqueue(activityWithRecipients, inbox, creator.id, 5);
        logger.info(`Thread queued for ${group.instance} (${group.member_count} members)`);
      }

      await supabase
        .from('threads')
        .update({ federation_status: 'completed' })
        .eq('id', thread_id);

      logger.info(`Thread federated to ${remoteMemberGroups.length} instances`);
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
