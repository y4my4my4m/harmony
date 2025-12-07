/**
 * ChannelReactionHandler - Federate channel message reactions
 * 
 * Handles federation of emoji reactions on server channel messages.
 * Uses Like activity for standard likes, EmojiReaction for custom emojis.
 */

import { getSupabaseClient } from '../config/supabase.js';
import { DeliveryQueue } from '../activitypub/DeliveryQueue.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';

// =============================================================================
// TYPES
// =============================================================================

interface ReactionPayload {
  reaction_id: string;
  message_id: string;
  user_id: string;
  emoji_id: string;
}

interface ReactionDeletePayload {
  message_id: string;
  user_id: string;
  emoji_id?: string;
}

// =============================================================================
// ADD REACTION HANDLER
// =============================================================================

/**
 * Handle channel message reaction federation
 */
export async function handleChannelReactionFederation(
  payload: ReactionPayload
): Promise<void> {
  try {
    const { reaction_id, message_id, user_id, emoji_id } = payload;
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;

    logger.info(`👍 Federating reaction ${reaction_id} on message ${message_id}`);

    // Get the reaction with related data
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

    // Get the message and its server
    const { data: message, error: messageError } = await supabase
      .from('messages')
      .select(`
        id,
        channel_id,
        metadata,
        channel:channels!messages_channel_id_fkey(
          id,
          server_id,
          server:servers!channels_server_id_fkey(id, federation_enabled, owner)
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

    // Get remote member groups
    const remoteMemberGroups = await getRemoteMemberGroups(server.id);
    
    if (remoteMemberGroups.length === 0) {
      logger.info('No remote members, skipping reaction federation');
      return;
    }

    // Build the reaction activity
    const userApId = reaction.user.federated_id || 
      `https://${hostDomain}/users/${reaction.user.username}`;
    const messageApId = message.metadata?.ap_id || 
      `https://${hostDomain}/messages/${message_id}`;
    const serverUrl = `https://${hostDomain}/servers/${server.id}`;

    // Determine activity type and emoji representation
    const emoji = reaction.emoji;
    const isCustomEmoji = !!emoji?.url;
    
    let emojiContent: string;
    let emojiTags: any[] | undefined;

    if (isCustomEmoji) {
      // Custom emoji - use :name@domain: format for federated emojis (Misskey-style)
      // This ensures remote instances can properly identify and display the emoji
      if (emoji.domain) {
        // Federated emoji - use :name@domain: format
        emojiContent = `:${emoji.name}@${emoji.domain}:`;
      } else {
        // Local emoji - use :name: format
        emojiContent = `:${emoji.name}:`;
      }
      
      emojiTags = [{
        type: 'Emoji',
        id: emoji.url,
        name: emojiContent, // Use the full format in the tag name too
        icon: {
          type: 'Image',
          mediaType: 'image/png',
          url: emoji.url,
        },
      }];
    } else {
      // Unicode emoji
      emojiContent = emoji?.name || '❤️';
    }

    const activity = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        { 'harmony': 'https://harmonyapp.dev/ns#' },
      ],
      id: `${userApId}/activities/${crypto.randomUUID()}`,
      type: isCustomEmoji ? 'EmojiReaction' : 'Like',
      actor: userApId,
      object: messageApId,
      content: emojiContent,
      tag: emojiTags,
      published: new Date().toISOString(),
    };

    // Send to remote instances
    for (const group of remoteMemberGroups) {
      const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
      
      await DeliveryQueue.enqueue(activity, inbox, reaction.user.id);
      
      logger.info(`✅ Queued reaction delivery to ${group.instance}`);
    }

    // Update reaction federation status
    await supabase
      .from('reactions')
      .update({ federation_status: 'completed' })
      .eq('id', reaction_id);

    logger.info(`👍 Reaction federation complete`);
  } catch (error) {
    logger.error('Error handling reaction federation:', error);
  }
}

// =============================================================================
// REMOVE REACTION HANDLER
// =============================================================================

/**
 * Handle channel message reaction removal federation
 */
export async function handleChannelReactionRemoval(
  payload: ReactionDeletePayload
): Promise<void> {
  try {
    const { message_id, user_id, emoji_id } = payload;
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;

    logger.info(`↩️ Federating reaction removal on message ${message_id}`);

    // Get the user
    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, federated_id, is_local')
      .eq('id', user_id)
      .single();

    if (!user?.is_local) {
      return;
    }

    // Get the message and server
    const { data: message } = await supabase
      .from('messages')
      .select(`
        id,
        metadata,
        channel:channels!messages_channel_id_fkey(
          server:servers!channels_server_id_fkey(id, federation_enabled, owner)
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

    // Get remote member groups
    const remoteMemberGroups = await getRemoteMemberGroups(server.id);
    
    if (remoteMemberGroups.length === 0) {
      return;
    }

    // Get emoji info if available
    let emoji = null;
    if (emoji_id) {
      const { data } = await supabase
        .from('emojis')
        .select('name, url')
        .eq('id', emoji_id)
        .single();
      emoji = data;
    }

    const userApId = user.federated_id || `https://${hostDomain}/users/${user.username}`;
    const messageApId = message.metadata?.ap_id || `https://${hostDomain}/messages/${message_id}`;

    // Create Undo activity
    const originalLikeId = `${userApId}/likes/${message_id}`;
    
    // Format emoji content consistently with add reaction
    let emojiContent: string;
    if (emoji?.url) {
      // Custom emoji - use :name@domain: format for federated emojis
      if (emoji.domain) {
        emojiContent = `:${emoji.name}@${emoji.domain}:`;
      } else {
        emojiContent = `:${emoji.name}:`;
      }
    } else {
      // Unicode emoji
      emojiContent = emoji?.name || '❤️';
    }
    
    const undoActivity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${userApId}/activities/${crypto.randomUUID()}`,
      type: 'Undo',
      actor: userApId,
      object: {
        id: originalLikeId,
        type: emoji?.url ? 'EmojiReaction' : 'Like',
        actor: userApId,
        object: messageApId,
        content: emojiContent,
      },
      published: new Date().toISOString(),
    };

    // Send to remote instances
    for (const group of remoteMemberGroups) {
      const inbox = group.shared_inbox || `https://${group.instance}/inbox`;
      await DeliveryQueue.enqueue(undoActivity, inbox, user.id);
    }

    logger.info(`↩️ Reaction removal federated to ${remoteMemberGroups.length} instances`);
  } catch (error) {
    logger.error('Error handling reaction removal federation:', error);
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

interface RemoteMemberGroup {
  instance: string;
  member_ap_ids: string[];
  member_count: number;
  shared_inbox?: string;
}

/**
 * Get remote member groups for a server
 */
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

