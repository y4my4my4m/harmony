/**
 * What a local server's Group tells its member instances so their copies show the server as it
 * is here (activitypub/copyMirror.ts, migration 20261030100001):
 *
 *   federate-channel-pin    the Group's Add or Remove of a message's Note in its channel's pins,
 *                           to the instances whose members view the channel. The message's state
 *                           when the job runs decides which.
 *   federate-member-roles   the Group's Update(harmony:MemberRoles) naming all of a member's
 *                           roles, to every member instance.
 *
 * Each is signed with the Group's key.
 */

import crypto from 'node:crypto';
import { getSupabaseClient } from '../../config/supabase.js';
import config from '../../config/index.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { HARMONY_CONTEXT } from '../../activitypub/harmonyContext.js';
import { messageObjectId } from '../../activitypub/channelMessageActivity.js';
import { memberRolesObject, pinsCollectionId } from '../../activitypub/copyMirror.js';
import { getChannelRecipientGroups, getRemoteMemberGroups } from '../../utils/federationUtils.js';
import { logger } from '../../utils/logger.js';
import type { FederationJobData } from '../BullMQManager.js';

const AS = 'https://www.w3.org/ns/activitystreams';

async function federatedLocalServer(serverId: unknown): Promise<string | null> {
  if (typeof serverId !== 'string') return null;
  const { data: server } = await getSupabaseClient()
    .from('servers')
    .select('id, is_local_server, federation_enabled')
    .eq('id', serverId)
    .maybeSingle();
  return server?.is_local_server === true && server.federation_enabled === true ? server.id : null;
}

export async function handleChannelPinJob(data: FederationJobData): Promise<void> {
  const serverId = await federatedLocalServer(data.server_id);
  const { message_id: messageId, channel_id: channelId } = data;
  if (!serverId || typeof messageId !== 'string' || typeof channelId !== 'string') return;
  const supabase = getSupabaseClient();

  const { data: message } = await supabase
    .from('messages')
    .select('id, channel_id, is_pinned, pinned_at, is_deleted, metadata')
    .eq('id', messageId)
    .maybeSingle();
  if (!message || message.channel_id !== channelId) return;

  const recipients = await getChannelRecipientGroups(channelId);
  if (recipients.length === 0) return;

  const serverUrl = `https://${config.INSTANCE_DOMAIN}/servers/${serverId}`;
  const pinned = message.is_pinned === true && message.is_deleted !== true;
  const activity = {
    '@context': [AS, HARMONY_CONTEXT],
    id: `${serverUrl}/activities/${crypto.randomUUID()}`,
    type: pinned ? 'Add' : 'Remove',
    actor: serverUrl,
    object: messageObjectId(message.id, message.metadata?.ap_id),
    target: pinsCollectionId(`${serverUrl}/channels/${channelId}`),
    published: pinned && message.pinned_at ? new Date(message.pinned_at).toISOString() : new Date().toISOString(),
  };
  for (const group of recipients) {
    await DeliveryQueue.enqueue(activity, group.shared_inbox || `https://${group.instance}/inbox`, { serverId });
  }
  logger.info(`Pin change of message ${messageId} federated to ${recipients.length} instance(s)`);
}

export async function handleMemberRolesJob(data: FederationJobData): Promise<void> {
  const serverId = await federatedLocalServer(data.server_id);
  const userId = data.user_id;
  if (!serverId || typeof userId !== 'string') return;
  const supabase = getSupabaseClient();

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, username, federated_id, is_local')
    .eq('id', userId)
    .maybeSingle();
  const member = profile?.federated_id
    || (profile?.is_local && profile.username ? `https://${config.INSTANCE_DOMAIN}/users/${profile.username}` : null);
  if (!member) return;

  const { data: assignments, error } = await supabase
    .from('user_roles')
    .select('role_id, role:server_roles!inner(is_default)')
    .eq('server_id', serverId)
    .eq('user_id', userId);
  if (error) throw new Error(`Roles of ${userId} in ${serverId} not read: ${error.message}`);
  const roleIds = (assignments || [])
    .filter((a: any) => a.role?.is_default !== true)
    .map((a: any) => a.role_id as string)
    .sort();

  const recipients = await getRemoteMemberGroups(serverId);
  if (recipients.length === 0) return;

  const serverUrl = `https://${config.INSTANCE_DOMAIN}/servers/${serverId}`;
  const activity = {
    '@context': [AS, HARMONY_CONTEXT],
    id: `${serverUrl}/activities/${crypto.randomUUID()}`,
    type: 'Update',
    actor: serverUrl,
    object: memberRolesObject(serverUrl, userId, member, roleIds),
    published: new Date().toISOString(),
  };
  for (const group of recipients) {
    await DeliveryQueue.enqueue(activity, group.shared_inbox || `https://${group.instance}/inbox`, { serverId });
  }
  logger.info(`Roles of ${userId} in ${serverId} federated to ${recipients.length} instance(s)`);
}
