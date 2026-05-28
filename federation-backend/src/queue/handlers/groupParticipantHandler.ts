/**
 * Group Participant Change Federation Job Handler
 *
 * Sends an ActivityPub Remove/Leave activity to remote participants
 * when someone leaves or is removed from a group conversation.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { logger } from '../../utils/logger.js';
import config from '../../config/index.js';

export async function handleGroupParticipantChangeJob(data: {
  conversation_id: string;
  user_id: string;
  change_type: 'left';
}): Promise<void> {
  const supabase = getSupabaseClient();
  const domain = config.INSTANCE_DOMAIN;
  const { conversation_id, user_id, change_type } = data;

  logger.info(`👥 Processing federate-group-participant-change: ${change_type} for user ${user_id} in conversation ${conversation_id}`);

  const { data: leavingUser } = await supabase
    .from('profiles')
    .select('id, username, display_name, domain, federated_id, inbox_url, is_local')
    .eq('id', user_id)
    .single();

  if (!leavingUser) {
    logger.warn(`User ${user_id} not found`);
    return;
  }

  const { data: conversation } = await supabase
    .from('conversations')
    .select('id, name, type')
    .eq('id', conversation_id)
    .single();

  if (!conversation || conversation.type !== 'group') {
    logger.debug('Not a group conversation, skipping');
    return;
  }

  // Get remaining remote participants who need to be notified
  const { data: remainingParticipants } = await supabase
    .from('conversation_participants')
    .select(`
      user_id,
      profiles!conversation_participants_user_id_fkey (
        id, username, domain, federated_id, inbox_url, is_local
      )
    `)
    .eq('conversation_id', conversation_id)
    .is('left_at', null);

  if (!remainingParticipants) return;

  const remoteUsers = remainingParticipants
    .map((p: any) => p.profiles)
    .filter((profile: any) => profile && !profile.is_local && profile.inbox_url);

  // Also include the leaving user if they're remote (so their instance can update state)
  if (!leavingUser.is_local && leavingUser.inbox_url) {
    const alreadyIncluded = remoteUsers.some((u: any) => u.id === leavingUser.id);
    if (!alreadyIncluded) {
      remoteUsers.push(leavingUser);
    }
  }

  if (remoteUsers.length === 0) {
    logger.debug('No remote participants to notify');
    return;
  }

  // Use a local user as the actor for signing (pick first remaining local participant)
  const localParticipants = remainingParticipants
    .map((p: any) => p.profiles)
    .filter((profile: any) => profile?.is_local);

  const signingUser = localParticipants[0] || leavingUser;
  if (!signingUser?.is_local) {
    logger.debug('No local user available to sign the activity');
    return;
  }

  const leavingUserUrl = leavingUser.federated_id ||
    `https://${leavingUser.domain || domain}/users/${leavingUser.username}`;
  const actorUrl = signingUser.federated_id || `https://${domain}/users/${signingUser.username}`;
  const conversationUrl = `https://${domain}/conversations/${conversation_id}`;

  const activity = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://harmony.social/ns/extensions',
    ],
    type: 'Remove',
    id: `${conversationUrl}/participants/${user_id}/remove/${Date.now()}`,
    actor: actorUrl,
    object: leavingUserUrl,
    target: {
      id: conversationUrl,
      type: 'Group',
      'harmony:type': 'harmony:GroupConversation',
      name: conversation.name || '',
      'harmony:conversationId': conversation_id,
    },
    to: remoteUsers.map((u: any) => u.federated_id || `https://${u.domain}/users/${u.username}`),
    published: new Date().toISOString(),
  };

  // Deliver to each remote participant's inbox
  const deliveredDomains = new Set<string>();
  for (const remoteUser of remoteUsers) {
    const userDomain = remoteUser.domain;
    if (deliveredDomains.has(userDomain)) continue;
    deliveredDomains.add(userDomain);

    try {
      await DeliveryQueue.sendToInbox(remoteUser.inbox_url, activity, signingUser.id);
      logger.info(`📤 Group participant change sent to ${remoteUser.inbox_url}`);
    } catch (error) {
      logger.error(`Failed to send participant change to ${remoteUser.inbox_url}:`, error);
    }
  }
}
