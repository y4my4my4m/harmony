/**
 * Group Update Federation Job Handler
 *
 * Sends an ActivityPub Update activity to remote participants
 * when a group conversation's name or icon changes.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { logger } from '../../utils/logger.js';
import config from '../../config/index.js';

export async function handleGroupUpdateJob(data: {
  conversation_id: string;
  updater_id: string;
  update_type: 'name' | 'icon' | 'icon_removed';
  new_value?: string;
}): Promise<void> {
  const supabase = getSupabaseClient();
  const domain = config.INSTANCE_DOMAIN;
  const { conversation_id, updater_id, update_type } = data;

  logger.info(`📝 Processing federate-group-update: ${update_type} for conversation ${conversation_id}`);

  const { data: updater } = await supabase
    .from('profiles')
    .select('id, username, display_name, federated_id, is_local')
    .eq('id', updater_id)
    .single();

  if (!updater?.is_local) {
    logger.debug('Skipping group update from remote user');
    return;
  }

  const { data: conversation } = await supabase
    .from('conversations')
    .select('id, name, metadata, type')
    .eq('id', conversation_id)
    .single();

  if (!conversation || conversation.type !== 'group') {
    logger.warn(`Conversation ${conversation_id} not found or not a group`);
    return;
  }

  // Get remote participants who need to be notified
  const { data: remoteParticipants } = await supabase
    .from('conversation_participants')
    .select(`
      user_id,
      profiles!conversation_participants_user_id_fkey (
        id, username, domain, federated_id, inbox_url, is_local
      )
    `)
    .eq('conversation_id', conversation_id)
    .is('left_at', null);

  if (!remoteParticipants) return;

  const remoteUsers = remoteParticipants
    .map((p: any) => p.profiles)
    .filter((profile: any) => profile && !profile.is_local && profile.inbox_url);

  if (remoteUsers.length === 0) {
    logger.debug('No remote participants to notify');
    return;
  }

  const updaterUrl = updater.federated_id || `https://${domain}/users/${updater.username}`;
  const conversationUrl = `https://${domain}/conversations/${conversation_id}`;
  const iconUrl = (conversation.metadata as any)?.icon_url || null;

  const conversationObject: any = {
    id: conversationUrl,
    type: 'Group',
    'harmony:type': 'harmony:GroupConversation',
    name: conversation.name || '',
    'harmony:conversationId': conversation_id,
  };

  if (iconUrl) {
    const fullIconUrl = iconUrl.startsWith('http') ? iconUrl : `https://${domain}${iconUrl}`;
    conversationObject.icon = { type: 'Image', url: fullIconUrl };
  }

  const activity = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://harmony.social/ns/extensions',
    ],
    type: 'Update',
    id: `${conversationUrl}/updates/${Date.now()}`,
    actor: updaterUrl,
    object: conversationObject,
    to: remoteUsers.map((u: any) => u.federated_id || `https://${u.domain}/users/${u.username}`),
    published: new Date().toISOString(),
    'harmony:updateType': update_type,
  };

  // Deliver to each remote participant's inbox
  const deliveredDomains = new Set<string>();
  for (const remoteUser of remoteUsers) {
    // Avoid sending to the same domain twice (shared inbox optimization)
    const userDomain = remoteUser.domain;
    if (deliveredDomains.has(userDomain)) continue;
    deliveredDomains.add(userDomain);

    try {
      await DeliveryQueue.sendToInbox(remoteUser.inbox_url, activity, updater_id);
      logger.info(`📤 Group update (${update_type}) sent to ${remoteUser.inbox_url}`);
    } catch (error) {
      logger.error(`Failed to send group update to ${remoteUser.inbox_url}:`, error);
    }
  }
}
