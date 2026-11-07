/**
 * ChannelReactionHandler - Federate channel message reactions
 * 
 * Handles federation of emoji reactions on server channel messages.
 * Uses Like activity for standard likes, EmojiReaction for custom emojis.
 */

import { getSupabaseClient } from '../config/supabase.js';
import { DeliveryQueue } from '../activitypub/DeliveryQueue.js';
import { logger } from '../utils/logger.js';
import { formatEmojiForFederation, resolveOutboundEmoji } from '../utils/emojiResolvers.js';
import config from '../config/index.js';
import { getChannelRecipientGroups } from '../utils/federationUtils.js';
import { HARMONY_NS } from '../activitypub/harmonyContext.js';

// TYPES

interface ReactionPayload {
  reaction_id: string;
  message_id: string;
  user_id: string;
  emoji_id: string;
}

interface ReactionDeletePayload {
  /** Id of the deleted row; names the Like being undone. */
  reaction_id?: string;
  message_id: string;
  user_id: string;
  emoji_id?: string | null;
  /** The deleted row's custom_emoji_content; the row is gone when the job runs. */
  custom_emoji_content?: string | null;
}

/**
 * The Like a channel reaction federates as. Its id derives from the reaction row, so the
 * Undo names the same activity, and the Undo carries the same content and Emoji tag: the
 * receiver (ActivityProcessor.removeMessageReactions) matches the row to remove by that
 * emoji, not by id.
 */
function reactionLike(
  userApId: string,
  messageApId: string,
  reactionId: string | undefined,
  emojiContent: string,
  emojiData: { name: string; url: string } | null,
): Record<string, unknown> {
  return {
    id: reactionId ? `${userApId}/reactions/${reactionId}` : `${userApId}/activities/${crypto.randomUUID()}`,
    type: 'Like',
    actor: userApId,
    object: messageApId,
    content: emojiContent,
    _misskey_reaction: emojiContent,
    tag: emojiData ? [{
      type: 'Emoji',
      id: emojiData.url,
      name: emojiContent,
      icon: { type: 'Image', mediaType: emojiMediaType(emojiData.url), url: emojiData.url },
    }] : undefined,
  };
}

/** Image type by the file extension of an emoji URL; PNG when it names none. */
function emojiMediaType(url: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  switch (ext) {
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'avif': return 'image/avif';
    case 'svg': return 'image/svg+xml';
    default: return 'image/png';
  }
}

const REACTION_CONTEXT = [
  'https://www.w3.org/ns/activitystreams',
  {
    harmony: HARMONY_NS,
    'toot': 'http://joinmastodon.org/ns#',
    'Emoji': 'toot:Emoji',
    'misskey': 'https://misskey-hub.net/ns#',
    '_misskey_reaction': 'misskey:_misskey_reaction',
  },
];

/**
 * Inboxes a local user's reaction goes to. On a remote server's channel, the server's own
 * inbox: its host checks the reaction and its Group relays it to the other member instances
 * (groupRelay.ts). On a local server's, the shared inbox of every instance with readers.
 */
async function reactionInboxes(server: any, channelId: string): Promise<string[]> {
  if (server.is_local_server === false) {
    return typeof server.federation_inbox_url === 'string' ? [server.federation_inbox_url] : [];
  }
  return (await getChannelRecipientGroups(channelId))
    .map((group) => group.shared_inbox || `https://${group.instance}/inbox`);
}

// ADD REACTION HANDLER

/**
 * Handle channel message reaction federation
 */
export async function handleChannelReactionFederation(
  payload: ReactionPayload
): Promise<void> {
  try {
    const { reaction_id, message_id } = payload;
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;

    logger.info(`Federating reaction ${reaction_id} on message ${message_id}`);

    const { data: reaction, error: reactionError } = await supabase
      .from('reactions')
      .select(`
        *,
        user:profiles!reactions_user_id_fkey(id, username, federated_id, is_local),
        emoji:emojis!reactions_emoji_id_fkey(id, name, url, domain)
      `)
      .eq('id', reaction_id)
      .single();

    if (reactionError || !reaction) {
      logger.error('Failed to fetch reaction:', reactionError);
      return;
    }

    // Only federate reactions from local users
    if (!reaction.user?.is_local) {
      logger.info('Reaction from remote user, skipping outbound federation');
      return;
    }

    const { data: message, error: messageError } = await supabase
      .from('messages')
      .select(`
        id,
        channel_id,
        metadata,
        channel:channels!messages_channel_id_fkey(
          id,
          server_id,
          server:servers!channels_server_id_fkey(id, federation_enabled, owner, is_local_server, federation_inbox_url)
        )
      `)
      .eq('id', message_id)
      .single();

    if (messageError || !message) {
      logger.error('Failed to fetch message for reaction:', messageError);
      return;
    }

    const server = (message.channel as any)?.server;
    if (!server?.federation_enabled) {
      logger.info('Server federation not enabled');
      return;
    }

    const inboxes = await reactionInboxes(server, message.channel_id);
    if (inboxes.length === 0) {
      logger.info('No remote members, skipping reaction federation');
      return;
    }

    const userApId = reaction.user.federated_id || 
      `https://${hostDomain}/users/${reaction.user.username}`;
    const messageApId = message.metadata?.ap_id || 
      `https://${hostDomain}/messages/${message_id}`;

    const { content: emojiContent, emojiData } = formatEmojiForFederation(
      reaction.emoji,
      reaction.custom_emoji_content,
    );

    const activity: any = {
      '@context': REACTION_CONTEXT,
      ...reactionLike(userApId, messageApId, reaction_id, emojiContent, emojiData),
      published: new Date().toISOString(),
    };

    for (const inbox of inboxes) {
      await DeliveryQueue.enqueue(activity, inbox, reaction.user.id);
      logger.info(`Queued reaction delivery to ${inbox}`);
    }

    await supabase
      .from('reactions')
      .update({ federation_status: 'completed' })
      .eq('id', reaction_id);

    logger.info(`Reaction federation complete`);
  } catch (error) {
    logger.error('Error handling reaction federation:', error);
  }
}

// REMOVE REACTION HANDLER

/**
 * Handle channel message reaction removal federation
 */
export async function handleChannelReactionRemoval(
  payload: ReactionDeletePayload
): Promise<void> {
  try {
    const { reaction_id, message_id, user_id, emoji_id, custom_emoji_content } = payload;
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;

    logger.info(`Federating reaction removal on message ${message_id}`);

    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, federated_id, is_local')
      .eq('id', user_id)
      .single();

    if (!user?.is_local) {
      return;
    }

    const { data: message } = await supabase
      .from('messages')
      .select(`
        id,
        channel_id,
        metadata,
        channel:channels!messages_channel_id_fkey(
          server:servers!channels_server_id_fkey(id, federation_enabled, owner, is_local_server, federation_inbox_url)
        )
      `)
      .eq('id', message_id)
      .single();

    if (!message) {
      return;
    }

    const server = (message.channel as any)?.server;
    if (!server?.federation_enabled) {
      return;
    }

    const inboxes = await reactionInboxes(server, message.channel_id);
    if (inboxes.length === 0) {
      return;
    }

    const { content: emojiContent, emojiData } = await resolveOutboundEmoji(
      emoji_id,
      custom_emoji_content,
    );

    const userApId = user.federated_id || `https://${hostDomain}/users/${user.username}`;
    const messageApId = message.metadata?.ap_id || `https://${hostDomain}/messages/${message_id}`;
    const undone = reactionLike(userApId, messageApId, reaction_id, emojiContent, emojiData);

    const undoActivity = {
      '@context': REACTION_CONTEXT,
      id: `${userApId}/activities/${crypto.randomUUID()}`,
      type: 'Undo',
      actor: userApId,
      object: undone,
      published: new Date().toISOString(),
    };

    for (const inbox of inboxes) {
      await DeliveryQueue.enqueue(undoActivity, inbox, user.id);
    }

    logger.info(`Reaction removal federated to ${inboxes.length} inboxes`);
  } catch (error) {
    logger.error('Error handling reaction removal federation:', error);
  }
}
