/**
 * ServerMembershipHandler - Handle server join/leave federation
 * 
 * Sends Join/Leave activities when users join/leave remote servers
 */

import { getSupabaseClient } from '../config/supabase.js';
import { DeliveryQueue } from '../activitypub/DeliveryQueue.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';

export async function handleUserJoinRemoteServer(payload: any): Promise<void> {
  try {
    const { user_id, server_id, server_ap_id, server_inbox } = payload;
    const supabase = getSupabaseClient();

    logger.info(`🚪 User ${user_id} joining remote server ${server_id}`);

    const { data: user } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user_id)
      .single();

    if (!user) {
      logger.error('User not found');
      return;
    }

    const activity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `https://${config.INSTANCE_DOMAIN}/users/${user.username}/joins/${Date.now()}`,
      type: 'Join',
      actor: user.ap_id || `https://${config.INSTANCE_DOMAIN}/users/${user.username}`,
      object: server_ap_id,
      published: new Date().toISOString(),
    };

    await DeliveryQueue.sendToInbox(server_inbox, activity, user.id);

    logger.info(`✅ Sent Join activity to remote server`);
  } catch (error) {
    logger.error('Error handling user join remote server:', error);
  }
}

export async function handleUserLeaveRemoteServer(payload: any): Promise<void> {
  try {
    const { user_id, server_id, server_ap_id, server_inbox } = payload;
    const supabase = getSupabaseClient();

    logger.info(`🚪 User ${user_id} leaving remote server ${server_id}`);

    const { data: user } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user_id)
      .single();

    if (!user) {
      logger.error('User not found');
      return;
    }

    const activity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `https://${config.INSTANCE_DOMAIN}/users/${user.username}/leaves/${Date.now()}`,
      type: 'Leave',
      actor: user.ap_id || `https://${config.INSTANCE_DOMAIN}/users/${user.username}`,
      object: server_ap_id,
      published: new Date().toISOString(),
    };

    await DeliveryQueue.sendToInbox(server_inbox, activity, user.id);

    logger.info(`✅ Sent Leave activity to remote server`);
  } catch (error) {
    logger.error('Error handling user leave remote server:', error);
  }
}

export async function handleRemoteUserLeftServer(payload: any): Promise<void> {
  try {
    const { user_id, user_ap_id, server_id } = payload;
    const supabase = getSupabaseClient();

    logger.info(`🚪 Remote user ${user_id} left local server ${server_id}`);

    const { data: server } = await supabase
      .from('servers')
      .select('*')
      .eq('id', server_id)
      .single();

    if (!server) {
      logger.error('Server not found');
      return;
    }

    // Broadcast Leave activity to other server members (so they know)
    const serverUrl = `https://${config.INSTANCE_DOMAIN}/servers/${server_id}`;

    const activity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${serverUrl}/activities/leave-${Date.now()}`,
      type: 'Leave',
      actor: user_ap_id,
      object: serverUrl,
      published: new Date().toISOString(),
    };

    const { data: memberGroups } = await supabase
      .rpc('get_server_members_by_instance', { p_server_id: server_id });

    if (memberGroups) {
      for (const group of memberGroups) {
        if (group.instance !== 'local' && group.instance !== config.INSTANCE_DOMAIN) {
          const sharedInbox = `https://${group.instance}/inbox`;
          await DeliveryQueue.enqueue(activity, sharedInbox, server.owner);
        }
      }
    }

    logger.info(`✅ Broadcasted Leave activity to server members`);
  } catch (error) {
    logger.error('Error handling remote user left server:', error);
  }
}

export function handleServerMembershipEvents(event: string, payload: any): void {
  switch (event) {
    case 'user_join_remote_server':
      handleUserJoinRemoteServer(payload);
      break;
    case 'user_leave_remote_server':
      handleUserLeaveRemoteServer(payload);
      break;
    case 'remote_user_left_server':
      handleRemoteUserLeftServer(payload);
      break;
    default:
      logger.debug(`Unhandled membership event: ${event}`);
  }
}

