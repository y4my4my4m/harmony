/**
 * federate-instance-leave: the Leave of a local member that this instance's staff removed from a
 * server hosted elsewhere, or that left it when staff blocked it (public.instance_server_leaves,
 * migration 20261027300001). The member's own Leave, as POST /servers/leave sends it
 * (ServerDiscoveryService.sendMemberLeave). delivered_at is set once the Leave is handed to
 * DeliveryQueue, which retries a failed delivery itself, and also when there is nothing to send:
 * the server has no Group inbox, or the member is back in it since.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { membershipOutlivesRemove } from '../../activitypub/memberRemoval.js';
import { logger } from '../../utils/logger.js';
import type { FederationJobData } from '../BullMQManager.js';

async function markDelivered(leaveId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('instance_server_leaves')
    .update({ delivered_at: new Date().toISOString() })
    .eq('id', leaveId)
    .is('delivered_at', null);
  if (error) logger.warn(`Instance leave ${leaveId}: delivered_at not recorded: ${error.message}`);
}

export async function handleInstanceLeaveJob(data: FederationJobData): Promise<void> {
  const leaveId = data.leave_id;
  if (typeof leaveId !== 'string') return;
  const supabase = getSupabaseClient();

  const { data: leave } = await supabase
    .from('instance_server_leaves')
    .select('id, server_id, profile_id, reason, created_at, delivered_at')
    .eq('id', leaveId)
    .maybeSingle();
  if (!leave || leave.delivered_at) return;

  const [{ data: server }, { data: member }, { data: membership }] = await Promise.all([
    supabase.from('servers').select('id, ap_id, federation_inbox_url, is_local_server').eq('id', leave.server_id).maybeSingle(),
    supabase.from('profiles').select('id, username, federated_id, is_local').eq('id', leave.profile_id).maybeSingle(),
    supabase.from('user_servers').select('created_at').eq('server_id', leave.server_id).eq('user_id', leave.profile_id).maybeSingle(),
  ]);

  if (membership && membershipOutlivesRemove(membership.created_at, leave.created_at)) {
    logger.info(`Instance leave ${leaveId}: the member rejoined since; no Leave sent`);
    await markDelivered(leaveId);
    return;
  }
  if (!server || !member || member.is_local !== true) {
    logger.info(`Instance leave ${leaveId}: no server or local member left to send for`);
    await markDelivered(leaveId);
    return;
  }

  const { ServerDiscoveryService } = await import('../../services/ServerDiscoveryService.js');
  const sent = await ServerDiscoveryService.sendMemberLeave(server, member, leaveId);
  await markDelivered(leaveId);
  logger.info(`Instance leave ${leaveId} (${leave.reason}): ${sent ? 'Leave sent' : 'no Group inbox to tell'}`);
}
