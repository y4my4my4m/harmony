/**
 * Group Invite Federation Job Handler
 *
 * Sends an ActivityPub Create activity with a Note (metadata.type=group_invite)
 * to a remote user's inbox when they are added to a group conversation.
 */

import { getSupabaseClient } from '../../config/supabase.js';
import { DeliveryQueue } from '../../activitypub/DeliveryQueue.js';
import { logger } from '../../utils/logger.js';
import config from '../../config/index.js';

export async function handleGroupInviteJob(data: {
  conversation_id: string;
  inviter_id: string;
  invited_user_id: string;
}): Promise<void> {
  const supabase = getSupabaseClient();
  const domain = config.INSTANCE_DOMAIN;

  const { conversation_id, inviter_id, invited_user_id } = data;

  logger.info(`📨 Processing federate-group-invite for conversation ${conversation_id}, invited user ${invited_user_id}`);

  const { data: inviter } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url, domain, federated_id, is_local')
    .eq('id', inviter_id)
    .single();

  if (!inviter) {
    logger.error(`Inviter not found: ${inviter_id}`);
    return;
  }

  if (!inviter.is_local) {
    logger.debug('Skipping group invite from remote inviter');
    return;
  }

  const { data: invitedUser } = await supabase
    .from('profiles')
    .select('id, username, domain, federated_id, inbox_url')
    .eq('id', invited_user_id)
    .single();

  if (!invitedUser || !invitedUser.inbox_url) {
    logger.debug(`Invited user has no inbox: ${invited_user_id}`);
    return;
  }

  const { data: conversation } = await supabase
    .from('conversations')
    .select('name')
    .eq('id', conversation_id)
    .single();

  const conversationName = conversation?.name || 'a group conversation';

  const inviterUrl = inviter.federated_id || `https://${domain}/users/${inviter.username}`;
  const invitedUrl = invitedUser.federated_id || `https://${invitedUser.domain}/users/${invitedUser.username}`;
  const activityId = `https://${domain}/group-invites/${conversation_id}/${invited_user_id}`;

  const note = {
    id: activityId,
    type: 'Note',
    attributedTo: inviterUrl,
    published: new Date().toISOString(),
    to: [invitedUrl],
    content: `<p>You were added to ${escapeHtml(conversationName)} by <a href="${inviterUrl}">${escapeHtml(inviter.display_name || inviter.username)}</a>.</p>`,
    metadata: { type: 'group_invite', conversation_id, inviter_id, conversation_name: conversationName },
    directMessage: true,
  };

  const activity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'Create',
    id: `${activityId}#activity`,
    actor: inviterUrl,
    object: note,
    to: [invitedUrl],
    published: note.published,
  };

  await DeliveryQueue.sendToInbox(invitedUser.inbox_url, activity, inviter_id);
  logger.info(`✅ Group invite sent to ${invitedUser.inbox_url}`);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
