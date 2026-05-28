/**
 * Voice Federation Job Handler
 * 
 * Processes federate-voice-join and federate-voice-leave jobs for
 * voice channel presence federation to remote servers.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { VoiceActivityHandler } from '../../activitypub/VoiceActivityHandler.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { logger } from '../../utils/logger.js';
import config from '../../config/index.js';
import type { FederationJobData } from '../BullMQManager.js';

// =============================================================================
// VOICE CHANNEL JOIN HANDLER
// =============================================================================

export async function handleVoiceJoinJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { channel_id, user_id } = data;
  const hostDomain = config.INSTANCE_DOMAIN;

  logger.info(`🎤 Processing voice join federation: user ${user_id} -> channel ${channel_id}`);

  try {
    // Get user info
    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, federated_id, is_local')
      .eq('id', user_id)
      .single();

    if (!user?.is_local) {
      logger.debug('User is not local, skipping voice join federation');
      await updateFederationStatus(channel_id, user_id, 'skipped');
      return;
    }

    // Get channel and server info
    const { data: channel } = await supabase
      .from('channels')
      .select(`
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
      `)
      .eq('id', channel_id)
      .single();

    if (!channel) {
      logger.error(`Channel not found: ${channel_id}`);
      await updateFederationStatus(channel_id, user_id, 'failed');
      return;
    }

    const server = (channel as any).server;
    const userApId = user.federated_id || `https://${hostDomain}/users/${user.username}`;

    // CASE 1: Remote server - federate join to that server
    if (!server.is_local_server && server.federation_inbox_url) {
      logger.info(`📤 Federating voice join to remote server: ${server.name}`);
      
      const joinActivity = VoiceActivityHandler.createVoiceChannelJoin(
        userApId,
        channel_id,
        channel.name,
        server.id,
        server.name
      );

      await DeliveryQueue.enqueue(
        joinActivity,
        server.federation_inbox_url,
        user.id,
        10 // high priority
      );

      await updateFederationStatus(channel_id, user_id, 'completed');
      logger.info(`✅ Voice join federated to ${server.federation_inbox_url}`);
      return;
    }

    // CASE 2: Local server with remote members - broadcast to them
    if (server.federation_enabled) {
      const remoteMemberGroups = await getRemoteMemberGroups(server.id);
      
      if (remoteMemberGroups.length === 0) {
        logger.debug('No remote members, skipping voice join federation');
        await updateFederationStatus(channel_id, user_id, 'skipped');
        return;
      }

      const joinActivity = VoiceActivityHandler.createVoiceChannelJoin(
        userApId,
        channel_id,
        channel.name,
        server.id,
        server.name
      );

      // Send to each remote instance
      for (const group of remoteMemberGroups) {
        const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
        await DeliveryQueue.enqueue(joinActivity, inbox, user.id, 10);
        logger.info(`📤 Voice join queued for ${group.instance}`);
      }

      await updateFederationStatus(channel_id, user_id, 'completed');
      logger.info(`✅ Voice join federated to ${remoteMemberGroups.length} instances`);
    } else {
      await updateFederationStatus(channel_id, user_id, 'skipped');
    }

  } catch (error) {
    logger.error(`Failed to federate voice join:`, error);
    await updateFederationStatus(channel_id, user_id, 'failed');
    throw error;
  }
}

// =============================================================================
// VOICE CHANNEL LEAVE HANDLER
// =============================================================================

export async function handleVoiceLeaveJob(data: FederationJobData): Promise<void> {
  const supabase = getSupabaseClient();
  const { channel_id, server_id, user_id } = data;
  const hostDomain = config.INSTANCE_DOMAIN;

  logger.info(`🔇 Processing voice leave federation: user ${user_id} -> channel ${channel_id}`);

  try {
    // Get user info
    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, federated_id, is_local')
      .eq('id', user_id)
      .single();

    if (!user?.is_local) {
      logger.debug('User is not local, skipping voice leave federation');
      return;
    }

    // Get server info
    const { data: server } = await supabase
      .from('servers')
      .select('id, name, federation_enabled, is_local_server, federation_inbox_url')
      .eq('id', server_id)
      .single();

    if (!server) {
      logger.error(`Server not found: ${server_id}`);
      return;
    }

    const userApId = user.federated_id || `https://${hostDomain}/users/${user.username}`;

    // CASE 1: Remote server - federate leave to that server
    if (!server.is_local_server && server.federation_inbox_url) {
      logger.info(`📤 Federating voice leave to remote server: ${server.name}`);
      
      const leaveActivity = VoiceActivityHandler.createVoiceChannelLeave(
        userApId,
        channel_id,
        server_id
      );

      await DeliveryQueue.enqueue(
        leaveActivity,
        server.federation_inbox_url,
        user.id,
        10 // high priority
      );

      logger.info(`✅ Voice leave federated to ${server.federation_inbox_url}`);
      return;
    }

    // CASE 2: Local server with remote members - broadcast to them
    if (server.federation_enabled) {
      const remoteMemberGroups = await getRemoteMemberGroups(server.id);
      
      if (remoteMemberGroups.length === 0) {
        logger.debug('No remote members, skipping voice leave federation');
        return;
      }

      const leaveActivity = VoiceActivityHandler.createVoiceChannelLeave(
        userApId,
        channel_id,
        server_id
      );

      // Send to each remote instance
      for (const group of remoteMemberGroups) {
        const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
        await DeliveryQueue.enqueue(leaveActivity, inbox, user.id, 10);
        logger.info(`📤 Voice leave queued for ${group.instance}`);
      }

      logger.info(`✅ Voice leave federated to ${remoteMemberGroups.length} instances`);
    }

  } catch (error) {
    logger.error(`Failed to federate voice leave:`, error);
    throw error;
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

async function updateFederationStatus(
  channelId: string,
  userId: string,
  status: string
): Promise<void> {
  const supabase = getSupabaseClient();
  await supabase
    .from('voice_channel_participants')
    .update({ federation_status: status })
    .eq('channel_id', channelId)
    .eq('user_id', userId);
}

interface RemoteMemberGroup {
  instance: string;
  member_ap_ids: string[];
  member_count: number;
  shared_inbox?: string;
}

async function getRemoteMemberGroups(serverId: string): Promise<RemoteMemberGroup[]> {
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

