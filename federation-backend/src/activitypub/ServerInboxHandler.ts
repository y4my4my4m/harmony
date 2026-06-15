/**
 * ServerInboxHandler - Process activities sent to server inboxes
 * 
 * Handles:
 * - Join/Leave activities for federated server membership
 * - Accept/Reject responses for membership requests
 * - Create/Update/Delete activities for channel messages
 * - Like/EmojiReaction for message reactions
 * - Remove/Ban for moderation
 */

import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { ActivityProcessor } from './ActivityProcessor.js';
import { DeliveryQueue } from './DeliveryQueue.js';
import { noteToContent } from './converters/fromActivityPub.js';
import { decodeHtmlEntities } from '../utils/contentUtils.js';
import config from '../config/index.js';
import { harmonyVoiceMessageFromObject } from '../utils/voiceMessageFederation.js';
import { isDefaultServerIcon } from '../utils/urlUtils.js';

/**
 * Resolve a thread ID from an AP URL. Tries ap_id match first, then UUID extraction.
 */
async function resolveThreadIdFromAp(supabase: any, threadApIdValue: string): Promise<string | null> {
  const { data: threadByApId } = await supabase
    .from('threads')
    .select('id')
    .eq('ap_id', threadApIdValue)
    .maybeSingle();

  if (threadByApId) return threadByApId.id;

  const threadIdMatch = threadApIdValue.match(/\/threads\/([a-f0-9-]{36})/);
  if (threadIdMatch) {
    const { data: threadById } = await supabase
      .from('threads')
      .select('id')
      .eq('id', threadIdMatch[1])
      .maybeSingle();
    if (threadById) return threadById.id;
  }

  return null;
}

/**
 * Normalize mention `isLocal` flags relative to this instance.
 * Incoming `harmony:rawContent` has `isLocal` set by the sender, which is
 * relative to *their* instance. We re-evaluate against our own domain.
 */
function normalizeMentionDomains(content: any[]): any[] {
  return content.map((part: any) => {
    if (part.type === 'mention' && part.domain) {
      return { ...part, isLocal: part.domain === config.INSTANCE_DOMAIN };
    }
    return part;
  });
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

/**
 * Process activity sent to server inbox
 */
export async function processServerInboxActivity(
  serverId: string,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();

  logger.info(`📥 Server ${serverId} received ${activity.type} activity from ${activity.actor}`);

  // Get server
  const { data: server } = await supabase
    .from('servers')
    .select('*')
    .eq('id', serverId)
    .single();

  if (!server) {
    logger.error(`Server ${serverId} not found`);
    return;
  }

  // Check if this is a local server that can receive activities
  if (!server.is_local_server) {
    logger.warn(`Server ${serverId} is not local, cannot process inbox`);
    return;
  }

  // Check if sender instance is blocked
  try {
    const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    if (actorUrl) {
      const actorDomain = new URL(actorUrl).hostname;
      const { BlockedInstancesCache } = await import('../services/BlockedInstancesCache.js');
      if (BlockedInstancesCache.isBlocked(actorDomain)) {
        logger.info(`🚫 Rejecting activity from blocked instance: ${actorDomain}`);
        return;
      }
    }
  } catch (error) {
    logger.debug(`Could not check instance block status: ${error}`);
  }

  // Route activity to appropriate handler
  // Leave/Accept/Reject always allowed so users can leave gracefully.
  // Everything else (Join, Create, Update, Delete, reactions, channel CRUD, voice)
  // requires federation_enabled on the server.
  switch (activity.type) {
    case 'Leave':
      await processLeaveServer(serverId, server, activity);
      break;

    case 'Accept':
      await processAcceptActivity(serverId, activity);
      break;

    case 'Reject':
      await processRejectActivity(serverId, activity);
      break;

    case 'Join':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting Join`);
        const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
        const derivedInbox = `${actorUrl}/inbox`;
        await sendRejectActivity(serverId, server, activity, derivedInbox, 'Federation is disabled on this server');
        return;
      }
      await processJoinServer(serverId, server, activity);
      break;

    case 'Create':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting Create`);
        return;
      }
      await processCreateActivity(serverId, server, activity);
      break;

    case 'Update':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting Update`);
        return;
      }
      await processUpdateActivity(serverId, server, activity);
      break;

    case 'Delete':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting Delete`);
        return;
      }
      await processDeleteActivity(serverId, server, activity);
      break;

    case 'Like':
    case 'EmojiReaction':
    case 'EmojiReact':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting reaction`);
        return;
      }
      await processReactionActivity(serverId, server, activity);
      break;

    case 'Add':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting Add`);
        return;
      }
      await processAddActivity(serverId, server, activity);
      break;

    case 'Remove':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting Remove`);
        return;
      }
      await processRemoveActivity(serverId, server, activity);
      break;

    case 'Undo':
      if (!server.federation_enabled) {
        logger.info(`Federation not enabled for server ${serverId}, rejecting Undo`);
        return;
      }
      await processUndoActivity(serverId, server, activity);
      break;

    default:
      // Check for Harmony-specific voice activities
      if (activity.type?.startsWith('harmony:Voice')) {
        if (!server.federation_enabled) {
          logger.info(`Federation not enabled for server ${serverId}, rejecting voice activity`);
          return;
        }
        const { VoiceActivityHandler } = await import('./VoiceActivityHandler.js');
        await VoiceActivityHandler.processVoiceActivity(activity);
      } else {
        logger.info(`Unhandled server activity type: ${activity.type}`);
      }
  }
}

// =============================================================================
// JOIN / LEAVE HANDLERS
// =============================================================================

/**
 * Process Join activity (remote user wants to join server)
 */
async function processJoinServer(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;

  logger.info(`👋 Processing Join request from ${actorUrl}`);

  // Ensure remote user exists locally
  const remoteUser = await ActivityProcessor['ensureRemoteUser'](actorUrl);

  // Try to get the full user record (ensureRemoteUser returns partial data)
  let user = remoteUser;
  if (remoteUser) {
    const { data: fullUser } = await supabase
      .from('profiles')
      .select('id, username, inbox_url, federated_id, is_suspended')
      .eq('id', remoteUser.id)
      .maybeSingle();
    
    if (fullUser) {
      user = fullUser;
    }
  }

  if (!user) {
    logger.error('Failed to find/create remote user for Join activity');
    // Derive inbox URL from actor URL (standard ActivityPub pattern: {actorUrl}/inbox)
    const derivedInbox = `${actorUrl}/inbox`;
    await sendRejectActivity(serverId, server, activity, derivedInbox, 'User not found');
    return;
  }

  // Check if user is suspended
  if (user.is_suspended) {
    logger.warn(`Rejecting join from suspended user: ${actorUrl}`);
    await sendRejectActivity(serverId, server, activity, user.inbox_url, 'User is suspended');
    return;
  }

  // Check if user is banned from this server
  const { data: ban } = await supabase
    .from('server_bans')
    .select('id')
    .eq('server_id', serverId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (ban) {
    logger.warn(`Rejecting join from banned user: ${actorUrl}`);
    await sendRejectActivity(serverId, server, activity, user.inbox_url, 'User is banned from this server');
    return;
  }

  // Check if server is private and requires an invite
  if (!server.public) {
    const inviteCode = activity['harmony:inviteCode'];
    
    if (!inviteCode) {
      logger.warn(`Rejecting join to private server without invite code: ${actorUrl}`);
      await sendRejectActivity(serverId, server, activity, user.inbox_url, 'Private server requires invite code');
      return;
    }

    // Validate the invite code
    const { data: invite, error: inviteError } = await supabase
      .from('invites')
      .select('id, expires_at, uses, max_uses, used')
      .eq('server_id', serverId)
      .eq('code', inviteCode)
      .single();

    if (inviteError || !invite) {
      logger.warn(`Invalid invite code for private server: ${inviteCode}`);
      await sendRejectActivity(serverId, server, activity, user.inbox_url, 'Invalid invite code');
      return;
    }

    // Check if invite is expired
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      logger.warn(`Expired invite code: ${inviteCode}`);
      await sendRejectActivity(serverId, server, activity, user.inbox_url, 'Invite code has expired');
      return;
    }

    // Check if invite has reached max uses
    if (invite.max_uses !== null && (invite.uses || 0) >= invite.max_uses) {
      logger.warn(`Invite code at max uses: ${inviteCode}`);
      await sendRejectActivity(serverId, server, activity, user.inbox_url, 'Invite code has reached maximum uses');
      return;
    }

    // Increment invite usage
    await supabase
      .from('invites')
      .update({ uses: (invite.uses || 0) + 1 })
      .eq('id', invite.id);

    logger.info(`✅ Valid invite code used: ${inviteCode}`);
  }

  // Get the domain for member_instance tracking
  const memberDomain = new URL(actorUrl).hostname;

  // Check if already a member
  const { data: existing } = await supabase
    .from('user_servers')
    .select('id, status')
    .eq('server_id', serverId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (existing) {
    if (existing.status === 'accepted') {
      logger.info(`User ${user.username} already member of server ${serverId}`);
    } else {
      // Update status to accepted
      await supabase
        .from('user_servers')
        .update({ status: 'accepted' })
        .eq('id', existing.id);
    }
  } else {
    // Add to server membership
    const { error } = await supabase.from('user_servers').insert({
      server_id: serverId,
      user_id: user.id,
      status: 'accepted',
      member_instance: memberDomain,
    });

    if (error) {
      logger.error('Failed to add user to server:', error);
      await sendRejectActivity(serverId, server, activity, user.inbox_url, 'Internal error');
      return;
    }

    logger.info(`✅ Added ${user.username}@${memberDomain} to server ${serverId}`);
  }

  // Send Accept activity
  await sendAcceptActivity(serverId, server, activity, user.inbox_url);
  logger.info(`✅ Sent Accept to ${user.username}`);
}

/**
 * Process Leave activity (remote user leaving server)
 */
async function processLeaveServer(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;

  // Get user
  const { data: user, error: userError } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('federated_id', actorUrl)
    .maybeSingle();

  if (userError) {
    logger.error(`Failed to query user for Leave activity: ${userError.message}`);
    return;
  }

  if (!user) {
    logger.warn(`User not found for Leave activity: ${actorUrl}`);
    return;
  }

  // Remove from server
  const { error } = await supabase
    .from('user_servers')
    .delete()
    .eq('server_id', serverId)
    .eq('user_id', user.id);

  if (error) {
    logger.error('Failed to remove user from server:', error);
  } else {
    logger.info(`✅ Removed ${user.username} from server ${serverId}`);
  }
}

/**
 * Process Accept activity (remote server accepted our join request)
 */
async function processAcceptActivity(
  serverId: string,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();

  // Check if this is accepting a Join activity
  const object = activity.object;
  if (!object || object.type !== 'Join') {
    logger.info('Accept activity is not for a Join, ignoring');
    return;
  }

  // Get the user who made the join request
  const userActorUrl = typeof object.actor === 'string' ? object.actor : object.actor?.id;
  if (!userActorUrl) {
    logger.warn('Could not determine user from Join object');
    return;
  }

  const { data: user } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('federated_id', userActorUrl)
    .single();

  if (!user) {
    logger.warn('User not found for Accept activity');
    return;
  }

  // Update membership status to accepted
  const { error } = await supabase
    .from('user_servers')
    .update({ status: 'accepted' })
    .eq('server_id', serverId)
    .eq('user_id', user.id);

  if (error) {
    logger.error('Failed to update membership status:', error);
  } else {
    logger.info(`✅ Membership accepted for ${user.username} in server ${serverId}`);
  }
}

/**
 * Process Reject activity (remote server rejected our join request)
 */
async function processRejectActivity(
  serverId: string,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();

  const object = activity.object;
  if (!object || object.type !== 'Join') {
    return;
  }

  const userActorUrl = typeof object.actor === 'string' ? object.actor : object.actor?.id;
  
  const { data: user } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('federated_id', userActorUrl)
    .single();

  if (!user) {
    return;
  }

  // Remove the pending membership
  await supabase
    .from('user_servers')
    .delete()
    .eq('server_id', serverId)
    .eq('user_id', user.id);

  logger.info(`❌ Join rejected for ${user.username} in server ${serverId}`);
}

// =============================================================================
// MESSAGE HANDLERS
// =============================================================================

/**
 * Process Create activity (message in server channel)
 */
async function processCreateActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const object = activity.object;

  // Route ChatThread to dedicated handler
  if (object?.type === 'ChatThread') {
    logger.info(`📋 Routing server inbox Create ChatThread to handler: ${object.id}`);
    const { handleThreadActivity } = await import('./ThreadActivityHandler.js');
    const result = await handleThreadActivity({ ...activity, object });
    if (!result.success) {
      logger.warn(`Thread Create via server inbox failed: ${result.error}`);
    }
    return;
  }

  if (!object || object.type !== 'Note') {
    logger.info(`Create activity object is not a Note: ${object?.type}`);
    return;
  }

  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;

  // Ensure author exists
  const remoteAuthor = await ActivityProcessor['ensureRemoteUser'](actorUrl);
  logger.debug(`ensureRemoteUser returned: ${remoteAuthor ? `id=${remoteAuthor.id}, username=${remoteAuthor.username}` : 'null'}`);

  // Get author
  const { data: author, error: authorError } = await supabase
    .from('profiles')
    .select('id, username, federated_id')
    .eq('federated_id', actorUrl)
    .maybeSingle();

  if (authorError) {
    logger.error(`Failed to query author profile: ${authorError.message}`);
    return;
  }

  if (!author) {
    logger.error(`Failed to find author for server message. actorUrl=${actorUrl}`);
    // Try to list all profiles with this username for debugging
    const username = actorUrl.split('/').pop();
    const { data: similarProfiles } = await supabase
      .from('profiles')
      .select('id, username, federated_id')
      .eq('username', username)
      .limit(5);
    if (similarProfiles?.length) {
      logger.debug(`Similar profiles found: ${JSON.stringify(similarProfiles)}`);
    }
    return;
  }

  logger.debug(`Found author: id=${author.id}, username=${author.username}, federated_id=${author.federated_id}`);

  // Verify author is a member of this server
  const { data: membership, error: memberError } = await supabase
    .from('user_servers')
    .select('id, status, member_instance')
    .eq('server_id', serverId)
    .eq('user_id', author.id)
    .maybeSingle();

  if (memberError) {
    logger.error(`Failed to query membership: ${memberError.message}`);
    return;
  }

  logger.debug(`Membership query: server=${serverId}, user=${author.id}, result=${JSON.stringify(membership)}`);

  if (!membership) {
    logger.warn(`Author ${author.username} (id=${author.id}) is not a member of server ${serverId}`);
    // List all memberships for this server for debugging
    const { data: serverMembers } = await supabase
      .from('user_servers')
      .select('user_id, status, member_instance')
      .eq('server_id', serverId)
      .limit(10);
    logger.debug(`Server ${serverId} has ${serverMembers?.length || 0} members: ${JSON.stringify(serverMembers)}`);
    return;
  }

  if (membership.status !== 'accepted') {
    logger.warn(`Author ${author.username} membership status is '${membership.status}', not 'accepted'`);
    return;
  }

  // Parse context to get channel info
  const context = object.context;
  if (!context || !context.includes('/channels/')) {
    logger.warn('Message missing channel context');
    return;
  }

  // Find channel by ap_id (the context URL)
  let { data: channel } = await supabase
    .from('channels')
    .select('id, name')
    .eq('ap_id', context)
    .single();

  if (!channel) {
    // Try to extract channel ID from URL and find by local ID
    const channelIdMatch = context.match(/\/channels\/([a-f0-9-]+)/);
    if (channelIdMatch) {
      const { data: localChannel } = await supabase
        .from('channels')
        .select('id, name')
        .eq('id', channelIdMatch[1])
        .eq('server_id', serverId)
        .single();
      channel = localChannel;
    }
  }

  if (!channel) {
    // For remote server references, try syncing the server to pick up new channels
    // instead of blindly creating channels from incoming messages (security risk)
    const { data: serverData } = await supabase
      .from('servers')
      .select('is_local_server, ap_id')
      .eq('id', serverId)
      .single();

    if (serverData && !serverData.is_local_server && serverData.ap_id) {
      try {
        const { ServerDiscoveryService } = await import('../services/ServerDiscoveryService');
        await ServerDiscoveryService.syncRemoteServer(serverId);

        // Re-check for the channel after sync
        const { data: syncedChannel } = await supabase
          .from('channels')
          .select('id, name')
          .eq('ap_id', context)
          .single();

        if (!syncedChannel) {
          const channelIdMatch = context.match(/\/channels\/([a-f0-9-]+)/);
          if (channelIdMatch) {
            const { data: localChannel } = await supabase
              .from('channels')
              .select('id, name')
              .eq('id', channelIdMatch[1])
              .eq('server_id', serverId)
              .single();
            channel = localChannel;
          }
        } else {
          channel = syncedChannel;
        }
      } catch (syncError) {
        logger.warn('Failed to sync remote server for missing channel:', syncError);
      }
    }

    if (!channel) {
      logger.warn(`Dropping message for unknown channel: ${context} (server: ${serverId}). Channel creation from messages is not allowed.`);
      return;
    }
  }

  // Parse content - handle both HTML string and harmony:rawContent
  let messageContent: any[];
  if (object['harmony:rawContent'] && Array.isArray(object['harmony:rawContent'])) {
    messageContent = normalizeMentionDomains(object['harmony:rawContent']);
  } else if (typeof object.content === 'string') {
    messageContent = noteToContent(object);
  } else if (Array.isArray(object.content)) {
    messageContent = normalizeMentionDomains(object.content);
  } else {
    messageContent = [{ type: 'text', text: String(object.content || '') }];
  }

  // Resolve mention userIds from origin-instance UUIDs to local profile UUIDs
  if (Array.isArray(messageContent)) {
    const { resolveMentionUserIds } = await import('../utils/mentionResolver.js');
    messageContent = await resolveMentionUserIds(messageContent);
  }

  // Check for duplicate message
  const { data: existingMessage } = await supabase
    .from('messages')
    .select('id')
    .eq('metadata->>ap_id', object.id)
    .maybeSingle();

  if (existingMessage) {
    logger.info(`Message already exists: ${object.id}`);
    return;
  }

  // Handle reply threading - look up parent by ap_id first, then by UUID
  let replyToId: string | null = null;
  if (object.inReplyTo) {
    const { data: parentByApId } = await supabase
      .from('messages')
      .select('id')
      .eq('metadata->>ap_id', object.inReplyTo)
      .maybeSingle();

    if (parentByApId) {
      replyToId = parentByApId.id;
    } else {
      const replyToMatch = object.inReplyTo.match(/\/messages\/([a-f0-9-]+)/);
      if (replyToMatch) {
        const { data: parentById } = await supabase
          .from('messages')
          .select('id')
          .eq('id', replyToMatch[1])
          .maybeSingle();
        if (parentById) {
          replyToId = parentById.id;
        }
      }
    }
  }

  // Resolve thread_id from harmony:threadId AP extension
  let resolvedThreadId: string | null = null;
  const threadApIdValue = object['harmony:threadId'];
  if (threadApIdValue) {
    resolvedThreadId = await resolveThreadIdFromAp(supabase, threadApIdValue);
    if (!resolvedThreadId) {
      logger.warn(`Thread not found for AP ID ${threadApIdValue}, will create stub thread after message insert.`);
    }
  }

  const messageTimestamp = object.published || new Date().toISOString();
  const isEncrypted = object['harmony:encrypted'] === true;

  const messageMetadata: Record<string, any> = {
    ap_id: object.id,
    from_domain: new URL(actorUrl).hostname,
    federated: true,
  };
  if (threadApIdValue && !resolvedThreadId) {
    messageMetadata.pending_thread_ap_id = threadApIdValue;
  }
  const voiceFromAp = harmonyVoiceMessageFromObject(object);
  if (voiceFromAp) {
    Object.assign(messageMetadata, voiceFromAp);
  }

  const { data: insertedMessage, error } = await supabase.from('messages').insert({
    channel_id: channel.id,
    user_id: author.id,
    content: messageContent,
    reply_to: replyToId,
    thread_id: resolvedThreadId,
    metadata: messageMetadata,
    encrypted: isEncrypted,
    created_at: messageTimestamp,
    updated_at: object.updated || messageTimestamp,
    federation_status: 'completed',
  }).select('id, content, metadata').single();

  if (error) {
    logger.error('Failed to insert server message:', error);
    return;
  }

  // Enrich link previews asynchronously for inbound federated messages
  if (insertedMessage) {
    const { enrichMessageLinkPreviews } = await import('../listeners/DatabaseListener.js');
    enrichMessageLinkPreviews(insertedMessage).catch(err =>
      logger.warn('Link preview enrichment failed for federated message:', err)
    );
  }
  
  logger.info(`✅ Inserted federated message in #${channel.name} from ${author.username}`);

  // If message belongs to a thread that doesn't exist yet, create a stub thread
  if (threadApIdValue && !resolvedThreadId && insertedMessage) {
    try {
      const threadUuidMatch = threadApIdValue.match(/\/threads\/([a-f0-9-]{36})/);
      const stubThreadId = threadUuidMatch ? threadUuidMatch[1] : crypto.randomUUID();

      // Resolve correct parent message from harmony:parentMessageId
      let parentMessageId = insertedMessage.id;
      const parentMessageApId = object['harmony:parentMessageId'];
      if (parentMessageApId) {
        const { data: parentByApId } = await supabase
          .from('messages')
          .select('id')
          .eq('metadata->>ap_id', parentMessageApId)
          .maybeSingle();
        if (parentByApId) {
          parentMessageId = parentByApId.id;
        } else {
          const parentUuidMatch = parentMessageApId.match(/\/messages\/([a-f0-9-]{36})/);
          if (parentUuidMatch) {
            const { data: parentById } = await supabase
              .from('messages')
              .select('id')
              .eq('id', parentUuidMatch[1])
              .maybeSingle();
            if (parentById) parentMessageId = parentById.id;
          }
        }
      }

      let threadName = 'Thread';
      if (Array.isArray(messageContent)) {
        const textPart = messageContent.find((p: any) => p?.type === 'text' && p?.text);
        if (textPart) {
          threadName = String(textPart.text).substring(0, 100);
        }
      }

      const { error: stubError } = await supabase
        .from('threads')
        .insert({
          id: stubThreadId,
          channel_id: channel.id,
          parent_message_id: parentMessageId,
          name: threadName,
          created_by: author.id,
          ap_id: threadApIdValue,
          federation_status: 'synced',
          message_count: 1,
          member_count: 1,
        });

      if (stubError) {
        if (stubError.code === '23505') {
          resolvedThreadId = stubThreadId;
          logger.info(`🧵 Stub thread ${stubThreadId} already exists (race condition), assigning message`);
        } else {
          logger.warn(`Failed to create stub thread: ${stubError.message}`);
        }
      } else {
        resolvedThreadId = stubThreadId;
        logger.info(`🧵 Created stub thread ${stubThreadId} for AP ID ${threadApIdValue}`);
      }

      if (resolvedThreadId) {
        await supabase
          .from('messages')
          .update({ thread_id: resolvedThreadId })
          .eq('id', insertedMessage.id);

        const { data: orphans } = await supabase
          .from('messages')
          .select('id')
          .eq('channel_id', channel.id)
          .is('thread_id', null)
          .eq('metadata->>pending_thread_ap_id', threadApIdValue)
          .neq('id', insertedMessage.id);

        if (orphans && orphans.length > 0) {
          await supabase
            .from('messages')
            .update({ thread_id: resolvedThreadId })
            .in('id', orphans.map((m: any) => m.id));
          logger.info(`🧵 Assigned ${orphans.length} additional orphaned messages to stub thread ${resolvedThreadId}`);
        }
      }
    } catch (err) {
      logger.warn('Failed to create stub thread from message:', err);
    }
  }

  // ==========================================================================
  // RE-BROADCAST: If this is the authoritative server, relay to other remotes
  // ==========================================================================
  // When Instance B sends a message to Instance A (the server host),
  // Instance A should re-broadcast to Instance C, D, etc.
  
  if (server.is_local_server) {
    const senderDomain = new URL(actorUrl).hostname;
    
    // Find all remote members EXCEPT the sender's instance
    const { data: remoteMemberGroups } = await supabase
      .from('user_servers')
      .select(`
        member_instance,
        profiles!inner(id, federated_id, domain)
      `)
      .eq('server_id', serverId)
      .eq('status', 'accepted')
      .not('member_instance', 'is', null)
      .neq('member_instance', senderDomain)
      .neq('member_instance', config.INSTANCE_DOMAIN);

    if (remoteMemberGroups && remoteMemberGroups.length > 0) {
      // Group by instance for shared inbox delivery
      const instanceMap = new Map<string, string[]>();
      for (const member of remoteMemberGroups) {
        const instance = member.member_instance;
        if (!instanceMap.has(instance)) {
          instanceMap.set(instance, []);
        }
        if (member.profiles?.federated_id) {
          instanceMap.get(instance)!.push(member.profiles.federated_id);
        }
      }

      // Forward the activity to each instance (excluding sender)
      for (const [instance, memberApIds] of instanceMap) {
        const inbox = `https://${instance}/inbox`;
        
        // Modify activity to address specific members
        const forwardedActivity = {
          ...activity,
          to: memberApIds,
        };

        try {
          await DeliveryQueue.enqueue(forwardedActivity, inbox, server.owner);
          logger.info(`📤 Re-broadcast message to ${instance} (${memberApIds.length} members)`);
        } catch (deliveryError) {
          logger.error(`Failed to re-broadcast to ${instance}:`, deliveryError);
        }
      }
      
      logger.info(`🔄 Re-broadcast complete: relayed to ${instanceMap.size} other instances`);
    }
  }
}

/**
 * Process Update activity (message edit OR channel update)
 */
async function processUpdateActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const object = activity.object;

  if (!object) {
    return;
  }

  // Handle ChatThread updates
  if (object.type === 'ChatThread') {
    logger.info(`📋 Routing server inbox Update ChatThread to handler: ${object.id}`);
    const { handleThreadActivity } = await import('./ThreadActivityHandler.js');
    const result = await handleThreadActivity({ ...activity, object });
    if (!result.success) {
      logger.warn(`Thread Update via server inbox failed: ${result.error}`);
    }
    return;
  }

  // Handle CATEGORY updates - stored in channel_categories table
  if (object.type === 'harmony:Category') {
    const catUuidMatch = object.id?.match(/\/channels\/([a-f0-9-]{36})$/i);
    if (!catUuidMatch) {
      logger.warn(`Cannot extract UUID from category ap_id: ${object.id}`);
      return;
    }
    const catUuid = catUuidMatch[1];

    const { data: existingCat } = await supabase
      .from('channel_categories')
      .select('id')
      .eq('id', catUuid)
      .maybeSingle();

    if (existingCat) {
      await supabase
        .from('channel_categories')
        .update({
          name: object.name,
          order: object.position || object.order,
        })
        .eq('id', catUuid);
      logger.info(`✏️ Updated remote category: ${object.name}`);
    } else {
      const { error } = await supabase.from('channel_categories').insert({
        id: catUuid,
        server_id: serverId,
        name: object.name,
        order: object.position || object.order || 0,
      });
      if (error) {
        logger.error(`Failed to auto-create category ${object.name}:`, error);
      } else {
        logger.info(`📁 Auto-created remote category on Update: ${object.name}`);
      }
    }
    return;
  }

  // Handle CHANNEL updates (text/voice) - stored in channels table
  if (['harmony:TextChannel', 'harmony:VoiceChannel'].includes(object.type)) {
    const { data: channel } = await supabase
      .from('channels')
      .select('id')
      .eq('ap_id', object.id)
      .maybeSingle();

    // Resolve category reference
    let categoryId = null;
    if (object.category) {
      const catMatch = object.category.match(/\/channels\/([a-f0-9-]{36})$/i);
      if (catMatch) {
        const { data: cat } = await supabase
          .from('channel_categories')
          .select('id')
          .eq('id', catMatch[1])
          .maybeSingle();
        categoryId = cat?.id || null;
      }
    }

    if (channel) {
      await supabase
        .from('channels')
        .update({
          name: object.name,
          description: object.description,
          order: object.position || object.order,
          category: categoryId,
        })
        .eq('id', channel.id);
      logger.info(`✏️ Updated remote channel: ${object.name}`);
    } else {
      const entityUuidMatch = object.id?.match(/\/channels\/([a-f0-9-]{36})$/i);
      const channelType = object.type === 'harmony:VoiceChannel' ? 1 : 0;
      const insertData: any = {
        server_id: serverId,
        name: object.name,
        description: object.description,
        type: channelType,
        order: object.position || object.order || 0,
        ap_id: object.id,
        is_remote: true,
        category: categoryId,
      };
      if (entityUuidMatch) insertData.id = entityUuidMatch[1];

      const { error } = await supabase.from('channels').insert(insertData);
      if (error) {
        logger.error(`Failed to auto-create channel ${object.name}:`, error);
      } else {
        logger.info(`📢 Auto-created remote channel on Update: ${object.name}`);
      }
    }
    return;
  }

  // Handle SERVER updates (Group type) - name, icon, description changes
  if (object.type === 'Group' || object['harmony:ChatServer']) {
    // Extract server ID from the ap_id
    const serverIdMatch = object.id?.match(/\/servers\/([a-f0-9-]{36})$/i);
    if (!serverIdMatch) {
      logger.warn(`Cannot extract server ID from ap_id: ${object.id}`);
      return;
    }
    
    // Find the server by ID (it should already exist as a federated copy)
    const { data: existingServer } = await supabase
      .from('servers')
      .select('id')
      .eq('id', serverIdMatch[1])
      .eq('is_local_server', false)
      .maybeSingle();
    
    if (!existingServer) {
      logger.warn(`Remote server not found for Update: ${object.id}`);
      return;
    }
    
    // Build update object
    const updateData: any = {
      updated_at: new Date().toISOString(),
    };
    
    if (object.name) {
      updateData.name = object.name;
    }
    if (object.summary !== undefined) {
      updateData.description = object.summary;
    }
    // Icon - explicit null means the server removed its icon. The built-in
    // default value is treated the same as "no icon" (store null) so the local
    // UI uses its own fallback instead of loading a bogus default asset URL.
    if (object.icon?.url) {
      updateData.icon = isDefaultServerIcon(object.icon.url) ? null : object.icon.url;
    } else if (object.icon === null) {
      updateData.icon = null;
    }
    // Banner (ActivityPub 'image' property)
    if (object.image?.url) {
      updateData.banner = object.image.url;
    } else if (object.image === null) {
      updateData.banner = null;
    }
    // Discoverability / public flag
    if (object.discoverable !== undefined) {
      updateData.public = object.discoverable;
    }
    
    const { error: updateError } = await supabase
      .from('servers')
      .update(updateData)
      .eq('id', existingServer.id);
    
    if (updateError) {
      logger.error(`Failed to update server ${existingServer.id}:`, updateError);
    } else {
      const changedFields = Object.keys(updateData).filter(k => k !== 'updated_at');
      logger.info(`🏠 Updated remote server ${existingServer.id}: ${changedFields.join(', ')}`);
    }
    return;
  }

  // Handle message updates (Note type)
  if (object.type !== 'Note') {
    return;
  }

  // Find the message by ap_id
  const { data: message } = await supabase
    .from('messages')
    .select('id, channel_id')
    .eq('metadata->>ap_id', object.id)
    .maybeSingle();

  if (!message) {
    logger.warn(`Message not found for Update: ${object.id}`);
    return;
  }

  // Parse updated content
  let messageContent: any[];
  if (object['harmony:rawContent'] && Array.isArray(object['harmony:rawContent'])) {
    messageContent = normalizeMentionDomains(object['harmony:rawContent']);
  } else if (typeof object.content === 'string') {
    messageContent = noteToContent(object);
  } else {
    messageContent = normalizeMentionDomains(object.content || []);
  }

  const voicePatch = harmonyVoiceMessageFromObject(object);
  let updatePayload: Record<string, unknown> = {
    content: messageContent,
    updated_at: object.updated || new Date().toISOString(),
  };
  if (voicePatch) {
    const { data: existingRow } = await supabase
      .from('messages')
      .select('metadata')
      .eq('id', message.id)
      .maybeSingle();
    const meta = (existingRow?.metadata && typeof existingRow.metadata === 'object')
      ? { ...existingRow.metadata }
      : {};
    Object.assign(meta, voicePatch);
    updatePayload = { ...updatePayload, metadata: meta };
  }

  // Update message
  const { error } = await supabase
    .from('messages')
    .update(updatePayload)
    .eq('id', message.id);

  if (error) {
    logger.error('Failed to update message:', error);
    return;
  }
  
  logger.info(`✏️ Updated federated message: ${object.id}`);

  // Re-broadcast edit to other remote instances
  if (server.is_local_server) {
    const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;
    const senderDomain = new URL(actorUrl).hostname;
    
    const { data: remoteMemberGroups } = await supabase
      .from('user_servers')
      .select('member_instance')
      .eq('server_id', serverId)
      .eq('status', 'accepted')
      .not('member_instance', 'is', null)
      .neq('member_instance', senderDomain)
      .neq('member_instance', config.INSTANCE_DOMAIN);

    if (remoteMemberGroups && remoteMemberGroups.length > 0) {
      const instances = [...new Set(remoteMemberGroups.map(m => m.member_instance))];
      for (const instance of instances) {
        const inbox = `https://${instance}/inbox`;
        try {
          await DeliveryQueue.enqueue(activity, inbox, server.owner);
          logger.info(`📤 Re-broadcast edit to ${instance}`);
        } catch (e) {
          logger.error(`Failed to re-broadcast edit to ${instance}:`, e);
        }
      }
    }
  }
}

/**
 * Process Delete activity (message deletion)
 */
async function processDeleteActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  
  const objectUrl = typeof activity.object === 'string' 
    ? activity.object 
    : activity.object?.id;

  if (!objectUrl) {
    return;
  }

  // Find and soft-delete the message
  const { data: deletedMsg, error } = await supabase
    .from('messages')
    .update({ is_deleted: true })
    .eq('metadata->>ap_id', objectUrl)
    .select('id')
    .maybeSingle();

  if (error) {
    logger.error('Failed to delete message:', error);
    return;
  }
  
  if (!deletedMsg) {
    logger.warn(`Message not found for delete: ${objectUrl}`);
    return;
  }
  
  logger.info(`🗑️ Deleted federated message: ${objectUrl}`);

  // Re-broadcast delete to other remote instances
  if (server.is_local_server) {
    const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;
    const senderDomain = new URL(actorUrl).hostname;
    
    const { data: remoteMemberGroups } = await supabase
      .from('user_servers')
      .select('member_instance')
      .eq('server_id', serverId)
      .eq('status', 'accepted')
      .not('member_instance', 'is', null)
      .neq('member_instance', senderDomain)
      .neq('member_instance', config.INSTANCE_DOMAIN);

    if (remoteMemberGroups && remoteMemberGroups.length > 0) {
      const instances = [...new Set(remoteMemberGroups.map(m => m.member_instance))];
      for (const instance of instances) {
        const inbox = `https://${instance}/inbox`;
        try {
          await DeliveryQueue.enqueue(activity, inbox, server.owner);
          logger.info(`📤 Re-broadcast delete to ${instance}`);
        } catch (e) {
          logger.error(`Failed to re-broadcast delete to ${instance}:`, e);
        }
      }
    }
  }
}

/**
 * Process Like/EmojiReaction activity
 */
async function processReactionActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;
  const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;

  if (!objectUrl) {
    return;
  }

  // Ensure reactor exists
  await ActivityProcessor['ensureRemoteUser'](actorUrl);

  const { data: user } = await supabase
    .from('profiles')
    .select('id')
    .eq('federated_id', actorUrl)
    .single();

  if (!user) {
    return;
  }

  // Find the message
  const messageIdMatch = objectUrl.match(/\/messages\/([a-f0-9-]+)/);
  let message = null;

  if (messageIdMatch) {
    const { data } = await supabase
      .from('messages')
      .select('id')
      .eq('id', messageIdMatch[1])
      .maybeSingle();
    message = data;
  }

  if (!message) {
    // Try by ap_id in metadata
    const { data } = await supabase
      .from('messages')
      .select('id')
      .eq('metadata->>ap_id', objectUrl)
      .maybeSingle();
    message = data;
  }

  if (!message) {
    logger.warn(`Message not found for reaction: ${objectUrl}`);
    return;
  }

  // Extract emoji
  const emoji = activity.content || activity.tag?.find((t: any) => t.type === 'Emoji')?.name || '❤️';
  const emojiUrl = activity.tag?.find((t: any) => t.type === 'Emoji')?.icon?.url;
  const emojiName = activity.tag?.find((t: any) => t.type === 'Emoji')?.name;

  const isCustomEmoji = !!(emojiUrl && emojiName);

  const reactionData: any = {
    message_id: message.id,
    user_id: user.id,
    metadata: { federated: true, ap_id: activity.id },
  };

  if (isCustomEmoji) {
    // Custom emoji with URL - resolve to an emoji_id in the emojis table
    const { data: existingEmoji } = await supabase
      .from('emojis')
      .select('id')
      .eq('url', emojiUrl)
      .maybeSingle();

    if (existingEmoji) {
      reactionData.emoji_id = existingEmoji.id;
    } else {
      const cleanName = (emojiName || emoji).replace(/:/g, '');
      const { data: newEmoji } = await supabase
        .from('emojis')
        .insert({
          name: cleanName,
          url: emojiUrl,
          server_id: null,
          uploader: user.id,
          domain: new URL(emojiUrl).hostname,
        })
        .select('id')
        .single();

      if (newEmoji) {
        reactionData.emoji_id = newEmoji.id;
      }
    }

    if (!reactionData.emoji_id) {
      logger.error('Failed to get/create custom emoji for reaction');
      return;
    }
  } else {
    // Native/unicode emoji - store with emoji_id=null + custom_emoji_content
    // Must match ActivityProcessor.processLike storage to prevent double counting
    let normalizedEmoji = emoji || '❤️';
    if (normalizedEmoji === '❤') normalizedEmoji = '❤️';
    reactionData.emoji_id = null;
    reactionData.custom_emoji_content = normalizedEmoji;
  }

  // Deduplicate: check if this reaction already exists
  let dupQuery = supabase
    .from('reactions')
    .select('id')
    .eq('message_id', message.id)
    .eq('user_id', user.id);

  if (reactionData.emoji_id) {
    dupQuery = dupQuery.eq('emoji_id', reactionData.emoji_id);
  } else {
    dupQuery = dupQuery.is('emoji_id', null)
      .eq('custom_emoji_content', reactionData.custom_emoji_content);
  }

  const { data: existingReaction } = await dupQuery.maybeSingle();
  if (existingReaction) {
    logger.info(`🔄 Reaction already exists for user ${user.id} on message ${message.id}`);
    return;
  }

  const { error } = await supabase
    .from('reactions')
    .insert(reactionData);

  if (error) {
    // Handle unique constraint violation gracefully (concurrent insert race)
    if (error.code === '23505') {
      logger.info(`🔄 Reaction already exists (constraint): ${error.message}`);
      return;
    }
    logger.error('Failed to add reaction:', error);
    return;
  }
  
  logger.info(`👍 Added reaction to message ${message.id}`);

  // Re-broadcast reaction to other remote instances
  if (server.is_local_server) {
    const senderDomain = new URL(actorUrl).hostname;
    
    const { data: remoteMemberGroups } = await supabase
      .from('user_servers')
      .select('member_instance')
      .eq('server_id', serverId)
      .eq('status', 'accepted')
      .not('member_instance', 'is', null)
      .neq('member_instance', senderDomain)
      .neq('member_instance', config.INSTANCE_DOMAIN);

    if (remoteMemberGroups && remoteMemberGroups.length > 0) {
      const instances = [...new Set(remoteMemberGroups.map(m => m.member_instance))];
      for (const instance of instances) {
        const inbox = `https://${instance}/inbox`;
        try {
          await DeliveryQueue.enqueue(activity, inbox, server.owner);
          logger.info(`📤 Re-broadcast reaction to ${instance}`);
        } catch (e) {
          logger.error(`Failed to re-broadcast reaction to ${instance}:`, e);
        }
      }
    }
  }
}

/**
 * Process Add activity (channel or category creation)
 */
async function processAddActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const object = activity.object;

  if (!object) {
    return;
  }

  const objectType = object.type;
  
  // Extract UUID from ap_id if possible
  let entityUuid: string | undefined;
  const match = object.id?.match(/\/channels\/([a-f0-9-]{36})$/i);
  if (match) {
    entityUuid = match[1];
  }

  // Handle CATEGORY creation - goes into channel_categories table
  if (objectType === 'harmony:Category') {
    // Check if category already exists (by name and server, since no ap_id column)
    const { data: existingCat } = await supabase
      .from('channel_categories')
      .select('id')
      .eq('server_id', serverId)
      .eq('name', object.name)
      .maybeSingle();

    if (existingCat) {
      logger.info(`Category already exists: ${object.name}`);
      return;
    }

    const catInsertData: any = {
      server_id: serverId,
      name: object.name,
      order: object.position || object.order || 0,
    };

    // Use remote UUID for consistency
    if (entityUuid) {
      catInsertData.id = entityUuid;
    }

    const { error: catError } = await supabase.from('channel_categories').insert(catInsertData);
    if (catError) {
      logger.error(`Failed to create category ${object.name}:`, catError);
    } else {
      logger.info(`📁 Created remote category: ${object.name}`);
    }
    return;
  }

  // Handle CHANNEL creation (text/voice) - goes into channels table
  if (['harmony:TextChannel', 'harmony:VoiceChannel'].includes(objectType)) {
    const channelType = objectType === 'harmony:VoiceChannel' ? 1 : 0;

    // Resolve category reference - look up in channel_categories by UUID
    let categoryId = null;
    if (object.category) {
      const catMatch = object.category.match(/\/channels\/([a-f0-9-]{36})$/i);
      if (catMatch) {
        // Look up the category in channel_categories table by UUID
        const { data: cat } = await supabase
          .from('channel_categories')
          .select('id')
          .eq('id', catMatch[1])
          .eq('server_id', serverId)
          .maybeSingle();
        
        categoryId = cat?.id || null;
      }
    }

    // Check if channel already exists
    const { data: existing } = await supabase
      .from('channels')
      .select('id')
      .eq('ap_id', object.id)
      .maybeSingle();

    if (existing) {
      logger.info(`Channel already exists: ${object.name}`);
      return;
    }

    const insertData: any = {
      server_id: serverId,
      name: object.name,
      description: object.description,
      type: channelType,
      order: object.position || object.order || 0,
      ap_id: object.id,
      is_remote: true,
      category: categoryId,
    };

    // Use remote UUID for consistency
    if (entityUuid) {
      insertData.id = entityUuid;
    }

    const { error: channelError } = await supabase.from('channels').insert(insertData);
    if (channelError) {
      logger.error(`Failed to create channel ${object.name}:`, channelError);
    } else {
      logger.info(`📢 Created remote channel: ${object.name} (${objectType}, category: ${categoryId})`);
    }
  }
}

/**
 * Process Remove activity (kick from server OR channel deletion)
 */
async function processRemoveActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  
  // Remove activity: actor removes object from target
  const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  
  if (!objectUrl) {
    return;
  }

  // Check if this is a channel/category removal
  if (objectUrl.includes('/channels/')) {
    // Extract UUID from the URL
    const uuidMatch = objectUrl.match(/\/channels\/([a-f0-9-]{36})$/i);
    const entityUuid = uuidMatch ? uuidMatch[1] : null;

    // Try to remove from channels table first
    const { data: deletedChannel } = await supabase
      .from('channels')
      .delete()
      .eq('ap_id', objectUrl)
      .eq('server_id', serverId)
      .select('id')
      .maybeSingle();
    
    if (deletedChannel) {
      logger.info(`🗑️ Removed remote channel: ${objectUrl}`);
      return;
    }

    // If not found in channels, try channel_categories (by UUID since no ap_id column)
    if (entityUuid) {
      const { data: deletedCategory } = await supabase
        .from('channel_categories')
        .delete()
        .eq('id', entityUuid)
        .eq('server_id', serverId)
        .select('id')
        .maybeSingle();
      
      if (deletedCategory) {
        logger.info(`🗑️ Removed remote category: ${objectUrl}`);
        return;
      }
    }

    logger.warn(`Could not find channel or category to remove: ${objectUrl}`);
    return;
  }

  // Otherwise, it's a user removal (kick)
  const { data: user } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('federated_id', objectUrl)
    .single();

  if (!user) {
    return;
  }

  // Remove from server
  await supabase
    .from('user_servers')
    .delete()
    .eq('server_id', serverId)
    .eq('user_id', user.id);

  logger.info(`👢 Kicked ${user.username} from server ${serverId}`);
}

/**
 * Process Undo activity
 */
async function processUndoActivity(
  serverId: string,
  server: any,
  activity: any
): Promise<void> {
  const supabase = getSupabaseClient();
  const object = activity.object;

  if (!object) {
    return;
  }

  const objectType = typeof object === 'string' ? null : object.type;

  switch (objectType) {
    case 'Join':
      // Undo Join = Leave
      await processLeaveServer(serverId, server, object);
      break;

    case 'Like':
    case 'EmojiReaction': {
      const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor.id;
      const targetUrl = typeof object.object === 'string' ? object.object : object.object?.id;

      const { data: user } = await supabase
        .from('profiles')
        .select('id')
        .eq('federated_id', actorUrl)
        .single();

      if (user && targetUrl) {
        const messageIdMatch = targetUrl.match(/\/messages\/([a-f0-9-]+)/);
        if (messageIdMatch) {
          await supabase
            .from('reactions')
            .delete()
            .eq('message_id', messageIdMatch[1])
            .eq('user_id', user.id);

          logger.info(`Removed reaction from message ${messageIdMatch[1]}`);
        }
      }
      break;
    }

    default:
      logger.info(`Unhandled Undo object type: ${objectType}`);
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Send Accept activity for a Join request
 */
async function sendAcceptActivity(
  serverId: string,
  server: any,
  originalActivity: any,
  targetInbox: string
): Promise<void> {
  const serverUrl = `https://${config.INSTANCE_DOMAIN}/servers/${serverId}`;

  const acceptActivity = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      { 'harmony': 'https://harmonyapp.dev/ns#' },
    ],
    id: `${serverUrl}/activities/${crypto.randomUUID()}`,
    type: 'Accept',
    actor: serverUrl,
    object: originalActivity,
    published: new Date().toISOString(),
  };

  await DeliveryQueue.sendToInbox(targetInbox, acceptActivity, server.owner);
}

/**
 * Send Reject activity for a Join request
 */
async function sendRejectActivity(
  serverId: string,
  server: any,
  originalActivity: any,
  targetInbox: string,
  reason: string
): Promise<void> {
  const serverUrl = `https://${config.INSTANCE_DOMAIN}/servers/${serverId}`;

  const rejectActivity = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      { 'harmony': 'https://harmonyapp.dev/ns#' },
    ],
    id: `${serverUrl}/activities/${crypto.randomUUID()}`,
    type: 'Reject',
    actor: serverUrl,
    object: originalActivity,
    summary: reason,
    published: new Date().toISOString(),
  };

  await DeliveryQueue.sendToInbox(targetInbox, rejectActivity, server.owner);
}

/**
 * Strip HTML tags from content
 */
// eslint-disable-next-line unused-imports/no-unused-vars
function stripHtml(html: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|blockquote|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t]+/g, ' ');
  return decodeHtmlEntities(text).trim();
}
