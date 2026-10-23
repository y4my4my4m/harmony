/**
 * federate-member-removal: the Group's Remove of a member from another instance, for one row of
 * public.federation_member_removals (activitypub/memberRemoval.ts). delivered_at is set once the
 * Remove is handed to DeliveryQueue, which retries a failed delivery itself, and also when there
 * is no one to tell: the profile has no actor URL or inbox, or the member is back in the server
 * since the removal.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { memberRemoveActivity, membershipOutlivesRemove, type MemberRemovalRow } from '../../activitypub/memberRemoval.js';
import { logger } from '../../utils/logger.js';
import type { FederationJobData } from '../BullMQManager.js';

async function markDelivered(removalId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from('federation_member_removals')
    .update({ delivered_at: new Date().toISOString() })
    .eq('id', removalId)
    .is('delivered_at', null);
  if (error) logger.warn(`Member removal ${removalId}: delivered_at not recorded: ${error.message}`);
}

export async function handleMemberRemovalJob(data: FederationJobData): Promise<void> {
  const removalId = data.removal_id;
  if (typeof removalId !== 'string') return;
  const supabase = getSupabaseClient();

  const { data: removal } = await supabase
    .from('federation_member_removals')
    .select('id, server_id, profile_id, reason, summary, staff, created_at, delivered_at')
    .eq('id', removalId)
    .maybeSingle();
  if (!removal || removal.delivered_at) return;

  const [{ data: member }, { data: membership }] = await Promise.all([
    supabase.from('profiles').select('federated_id, inbox_url, shared_inbox_url, is_local').eq('id', removal.profile_id).maybeSingle(),
    supabase.from('user_servers').select('created_at').eq('server_id', removal.server_id).eq('user_id', removal.profile_id).maybeSingle(),
  ]);

  if (membership && membershipOutlivesRemove(membership.created_at, removal.created_at)) {
    logger.info(`Member removal ${removalId}: the member rejoined since; no Remove sent`);
    await markDelivered(removalId);
    return;
  }

  const inbox = member?.inbox_url || member?.shared_inbox_url;
  if (member?.is_local !== false || !member.federated_id || !inbox) {
    logger.info(`Member removal ${removalId}: no remote inbox to tell`);
    await markDelivered(removalId);
    return;
  }

  const activity = memberRemoveActivity(removal as MemberRemovalRow, member.federated_id);
  await DeliveryQueue.sendToInbox(inbox, activity, { serverId: removal.server_id });
  await markDelivered(removalId);
  logger.info(`Member removal ${removalId} (${removal.reason}): Remove sent to ${inbox}`);
}
