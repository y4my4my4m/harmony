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

export async function handleThreadJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { thread_id, server_id, type } = data;
  const hostDomain = config.INSTANCE_DOMAIN;

  logger.info(`📋 Processing thread ${type} job for thread: ${thread_id}`);

  try {
    // Get thread data with channel and creator joins
    const { data: thread, error: threadError } = await supabase
      .from('threads')
      .select(`
        *,
        channel:channels!threads_channel_id_fkey(
          id,
          name,
          ap_id,
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

    // Fetch parent message separately (no FK dependency)
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
      logger.error(`Missing required thread data: server=${!!server}, creator=${!!creator}`);
      return;
    }

    logger.info(`📋 Thread data: creator.is_local=${creator.is_local}, server.is_local=${server.is_local_server}, federation_enabled=${server.federation_enabled}, channel=${channel.name}`);

    // Only federate threads from local users
    if (!creator.is_local) {
      logger.info('Thread creator is not local, skipping federation');
      return;
    }

    const creatorApId = creator.federated_id || 
      `https://${hostDomain}/users/${creator.username}`;

    // CASE 1: Remote server - federate thread to that server
    if (!server.is_local_server && server.federation_inbox_url) {
      logger.info(`📤 Federating thread to remote server: ${server.name}`);
      
      const channelApId = channel.ap_id || 
        `https://${hostDomain}/channels/${channel.id}`;
      const parentMessageApId = parentMessage.metadata?.ap_id || 
        `https://${hostDomain}/messages/${parentMessage.id}`;
      
      const threadActivity = createThreadActivity(
        type === 'create' ? 'Create' : 'Update',
        thread,
        channelApId,
        parentMessageApId,
        creatorApId,
        creatorApId // actorApId (same as creator for thread creation)
      );

      await DeliveryQueue.enqueue(
        threadActivity,
        server.federation_inbox_url,
        creator.id,
        5 // priority
      );

      // Update federation status
      await supabase
        .from('threads')
        .update({ federation_status: 'completed' })
        .eq('id', thread_id);

      logger.info(`✅ Thread federated to ${server.federation_inbox_url}`);
      return;
    }

    // CASE 2: Local server with remote members - broadcast to them
    if (server.federation_enabled) {
      // Get remote member groups
      const { data: memberGroups } = await supabase
        .rpc('get_server_members_by_instance', { p_server_id: server_id });

      if (!memberGroups || memberGroups.length === 0) {
        logger.debug('No remote members, skipping thread federation');
        await supabase
          .from('threads')
          .update({ federation_status: 'skipped' })
          .eq('id', thread_id);
        return;
      }

      const remoteGroups = memberGroups.filter(
        (group: any) => group.instance !== 'local' && group.instance !== hostDomain
      );

      if (remoteGroups.length === 0) {
        logger.debug('No remote instances, skipping thread federation');
        await supabase
          .from('threads')
          .update({ federation_status: 'skipped' })
          .eq('id', thread_id);
        return;
      }

      const channelApId = channel.ap_id || 
        `https://${hostDomain}/channels/${channel.id}`;
      const parentMessageApId = parentMessage.metadata?.ap_id || 
        `https://${hostDomain}/messages/${parentMessage.id}`;
      
      const threadActivity = createThreadActivity(
        type === 'create' ? 'Create' : 'Update',
        thread,
        channelApId,
        parentMessageApId,
        creatorApId,
        creatorApId // actorApId (same as creator for thread creation)
      );

      // Send to each remote instance
      for (const group of remoteGroups) {
        const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
        await DeliveryQueue.enqueue(threadActivity, inbox, creator.id, 5);
        logger.info(`📤 Thread queued for ${group.instance}`);
      }

      // Update federation status
      await supabase
        .from('threads')
        .update({ federation_status: 'completed' })
        .eq('id', thread_id);

      logger.info(`✅ Thread federated to ${remoteGroups.length} instances`);
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

