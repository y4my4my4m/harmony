import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';

const router = Router();

/**
 * Thread ActivityPub Types
 * Extends ActivityPub for Discord-style threads in federated channels
 */
export interface ThreadActivity {
  '@context': string | (string | Record<string, string>)[];
  id: string;
  type: 'Create' | 'Update' | 'Delete' | 'Add' | 'Remove';
  actor: string;
  object: ThreadObject | ThreadMembershipActivity;
  published: string;
  to?: string[];
  cc?: string[];
}

export interface ThreadObject {
  type: 'ChatThread';
  id: string;
  name: string;
  context: string; // Channel AP ID
  inReplyTo: string; // Parent message AP ID
  attributedTo: string; // Creator AP ID
  published: string;
  updated?: string;
  archived?: boolean;
  locked?: boolean;
  autoArchiveDuration?: number;
  messageCount?: number;
  memberCount?: number;
  lastMessageAt?: string;
}

export interface ThreadMembershipActivity {
  type: 'Relationship';
  subject: string; // User AP ID
  object: string; // Thread AP ID
  relationship: 'memberOf';
}

export function threadToActivityPub(
  thread: any,
  channelApId: string,
  parentMessageApId: string,
  creatorApId: string,
  channelName?: string,
  channelId?: string
): ThreadObject {
  const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
  const threadApId = thread.ap_id || `${baseUrl}/threads/${thread.id}`;

  const obj: any = {
    type: 'ChatThread',
    id: threadApId,
    name: thread.name,
    context: channelApId,
    inReplyTo: parentMessageApId,
    attributedTo: creatorApId,
    published: thread.created_at,
    updated: thread.updated_at,
    archived: thread.archived,
    locked: thread.locked,
    autoArchiveDuration: thread.auto_archive_duration,
    messageCount: thread.message_count,
    memberCount: thread.member_count,
    lastMessageAt: thread.last_message_at,
  };

  if (channelName) obj['harmony:channelName'] = channelName;
  if (channelId) obj['harmony:channelId'] = channelId;

  return obj as ThreadObject;
}

export function activityPubToThread(
  apThread: ThreadObject,
  channelId: string,
  parentMessageId: string,
  createdById: string
): any {
  return {
    channel_id: channelId,
    parent_message_id: parentMessageId,
    name: apThread.name,
    created_by: createdById,
    archived: apThread.archived || false,
    locked: apThread.locked || false,
    auto_archive_duration: apThread.autoArchiveDuration || 1440,
    message_count: apThread.messageCount || 0,
    member_count: apThread.memberCount || 0,
    last_message_at: apThread.lastMessageAt,
    ap_id: apThread.id,
    federation_status: 'synced',
  };
}

export async function handleThreadActivity(
  activity: ThreadActivity,
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();

  try {
    logger.info(`📋 Processing ${activity.type} thread activity: ${activity.id}`);

    switch (activity.type) {
      case 'Create': {
        const threadObject = activity.object as ThreadObject;
        const harmonyServerId = (threadObject as any)['harmony:serverId'];

        logger.info(`📋 Thread Create: name="${threadObject.name}", context=${threadObject.context}, inReplyTo=${threadObject.inReplyTo}, attributedTo=${threadObject.attributedTo}, harmony:serverId=${harmonyServerId}`);

        // Resolve channel: try ap_id match, UUID from URL, server-scoped lookup, name, then parent-message fallback.
        let channel: { id: string; server_id: string } | null = null;
        const harmonyChannelName = (threadObject as any)['harmony:channelName'];
        const harmonyChannelId = (threadObject as any)['harmony:channelId'];

        // Strategy 1: exact ap_id match
        const { data: channelByApId } = await supabase
          .from('channels')
          .select('id, server_id')
          .eq('ap_id', threadObject.context)
          .maybeSingle();

        if (channelByApId) {
          channel = channelByApId;
          logger.info(`📋 Channel resolved via ap_id: ${channel.id}`);
        }

        // Strategy 2: extract UUID from context URL
        if (!channel) {
          const channelUuidMatch = threadObject.context?.match(/\/channels\/([a-f0-9-]{36})/i);
          if (channelUuidMatch) {
            const { data: channelById } = await supabase
              .from('channels')
              .select('id, server_id')
              .eq('id', channelUuidMatch[1])
              .maybeSingle();
            if (channelById) {
              channel = channelById;
              logger.info(`📋 Channel resolved via UUID: ${channel.id}`);
            }
          }
        }

        // Strategy 3: if we have harmony:serverId, look up channel by server_id scope + UUID
        if (!channel && harmonyServerId) {
          const channelUuidMatch = threadObject.context?.match(/\/channels\/([a-f0-9-]{36})/i);
          if (channelUuidMatch) {
            const { data: channelByServerScope } = await supabase
              .from('channels')
              .select('id, server_id')
              .eq('server_id', harmonyServerId)
              .eq('id', channelUuidMatch[1])
              .maybeSingle();
            if (channelByServerScope) {
              channel = channelByServerScope;
              logger.info(`📋 Channel resolved via server-scoped UUID: ${channel.id}`);
            }
          }
        }

        // Strategy 4: find channel by harmony:channelId within the server
        if (!channel && harmonyChannelId && harmonyServerId) {
          const { data: channelByHarmonyId } = await supabase
            .from('channels')
            .select('id, server_id')
            .eq('id', harmonyChannelId)
            .eq('server_id', harmonyServerId)
            .maybeSingle();
          if (channelByHarmonyId) {
            channel = channelByHarmonyId;
            logger.info(`📋 Channel resolved via harmony:channelId: ${channel.id}`);
          }
        }

        // Strategy 5: find channel by name within the server
        if (!channel && harmonyChannelName && harmonyServerId) {
          const { data: channelByName } = await supabase
            .from('channels')
            .select('id, server_id')
            .eq('name', harmonyChannelName)
            .eq('server_id', harmonyServerId)
            .maybeSingle();
          if (channelByName) {
            channel = channelByName;
            logger.info(`📋 Channel resolved via channel name "${harmonyChannelName}": ${channel.id}`);
          }
        }

        // Strategy 6: find parent message first, use its channel_id
        if (!channel && threadObject.inReplyTo) {
          const { data: parentByApId } = await supabase
            .from('messages')
            .select('id, channel_id')
            .eq('metadata->>ap_id', threadObject.inReplyTo)
            .maybeSingle();
          if (parentByApId) {
            channel = { id: parentByApId.channel_id, server_id: harmonyServerId || '' };
            logger.info(`📋 Channel resolved via parent message: ${channel.id}`);
          } else {
            const msgUuidMatch = threadObject.inReplyTo.match(/\/messages\/([a-f0-9-]{36})/i);
            if (msgUuidMatch) {
              const { data: parentById } = await supabase
                .from('messages')
                .select('id, channel_id')
                .eq('id', msgUuidMatch[1])
                .maybeSingle();
              if (parentById) {
                channel = { id: parentById.channel_id, server_id: harmonyServerId || '' };
                logger.info(`📋 Channel resolved via parent message UUID: ${channel.id}`);
              }
            }
          }
        }

        if (!channel) {
          logger.warn(`❌ Channel not found for thread. context=${threadObject.context}, harmony:serverId=${harmonyServerId}, harmony:channelName=${harmonyChannelName}, inReplyTo=${threadObject.inReplyTo}`);
          return { success: false, error: 'Channel not found' };
        }

        // Resolve parent message
        let parentMessageId: string | null = null;

        // Strategy 1: metadata.ap_id match
        const { data: parentByApId } = await supabase
          .from('messages')
          .select('id')
          .eq('metadata->>ap_id', threadObject.inReplyTo)
          .maybeSingle();

        if (parentByApId) {
          parentMessageId = parentByApId.id;
          logger.info(`📋 Parent message resolved via ap_id: ${parentMessageId}`);
        }

        // Strategy 2: UUID from URL
        if (!parentMessageId) {
          const msgUuidMatch = threadObject.inReplyTo?.match(/\/messages\/([a-f0-9-]{36})/i);
          if (msgUuidMatch) {
            const { data: parentById } = await supabase
              .from('messages')
              .select('id')
              .eq('id', msgUuidMatch[1])
              .maybeSingle();
            if (parentById) {
              parentMessageId = parentById.id;
              logger.info(`📋 Parent message resolved via UUID: ${parentMessageId}`);
            }
          }
        }

        // Strategy 3: look in the resolved channel for the message by UUID
        if (!parentMessageId) {
          const msgUuidMatch = threadObject.inReplyTo?.match(/\/messages\/([a-f0-9-]{36})/i);
          if (msgUuidMatch) {
            const { data: parentInChannel } = await supabase
              .from('messages')
              .select('id')
              .eq('id', msgUuidMatch[1])
              .eq('channel_id', channel.id)
              .maybeSingle();
            if (parentInChannel) {
              parentMessageId = parentInChannel.id;
              logger.info(`📋 Parent message resolved via channel-scoped UUID: ${parentMessageId}`);
            }
          }
        }

        if (!parentMessageId) {
          logger.warn(`❌ Parent message not found. inReplyTo=${threadObject.inReplyTo}, channel=${channel.id}`);
          return { success: false, error: 'Parent message not found' };
        }

        // Resolve creator
        let creatorId: string | null = null;

        const { data: creatorByFedId } = await supabase
          .from('profiles')
          .select('id')
          .eq('federated_id', threadObject.attributedTo)
          .maybeSingle();

        if (creatorByFedId) {
          creatorId = creatorByFedId.id;
          logger.info(`📋 Creator resolved via federated_id: ${creatorId}`);
        } else {
          const usernameMatch = threadObject.attributedTo?.match(/\/users\/([^/]+)$/i);
          if (usernameMatch) {
            const { data: creatorByUsername } = await supabase
              .from('profiles')
              .select('id')
              .eq('username', usernameMatch[1])
              .maybeSingle();
            if (creatorByUsername) {
              creatorId = creatorByUsername.id;
              logger.info(`📋 Creator resolved via username: ${creatorId}`);
            }
          }
        }

        if (!creatorId) {
          logger.warn(`❌ Creator not found. attributedTo=${threadObject.attributedTo}`);
          return { success: false, error: 'Creator not found' };
        }

        // Check for existing thread (idempotent)
        const threadApId = threadObject.id;
        let existingThread: { id: string } | null = null;

        if (threadApId) {
          const { data: byApId } = await supabase
            .from('threads')
            .select('id')
            .eq('ap_id', threadApId)
            .maybeSingle();
          existingThread = byApId;
        }

        if (!existingThread) {
          const threadUuidMatch = threadApId?.match(/\/threads\/([a-f0-9-]{36})/i);
          if (threadUuidMatch) {
            const { data: byId } = await supabase
              .from('threads')
              .select('id')
              .eq('id', threadUuidMatch[1])
              .maybeSingle();
            existingThread = byId;
          }
        }

        if (existingThread) {
          const updateData: Record<string, any> = {
            name: threadObject.name,
            archived: threadObject.archived || false,
            locked: threadObject.locked || false,
            auto_archive_duration: threadObject.autoArchiveDuration || 1440,
            message_count: threadObject.messageCount || 0,
            member_count: threadObject.memberCount || 0,
            last_message_at: threadObject.lastMessageAt,
            ap_id: threadApId,
            federation_status: 'synced',
          };
          // Also fix parent_message_id if we have it (stub threads use a placeholder)
          if (parentMessageId) {
            updateData.parent_message_id = parentMessageId;
          }
          if (creatorId) {
            updateData.created_by = creatorId;
          }

          const { error: updateError } = await supabase
            .from('threads')
            .update(updateData)
            .eq('id', existingThread.id);

          if (updateError) {
            logger.error('Failed to update existing federated thread:', updateError);
            return { success: false, error: updateError.message };
          }
          logger.info(`✅ Updated existing federated thread: ${threadObject.name} (id: ${existingThread.id})`);

          // Assign orphaned messages for existing threads too (thread may have existed but
          // messages arrived before ap_id was set)
          if (threadApId) {
            try {
              const { data: orphans } = await supabase
                .from('messages')
                .select('id')
                .eq('channel_id', channel.id)
                .is('thread_id', null)
                .eq('metadata->>pending_thread_ap_id', threadApId);
              if (orphans && orphans.length > 0) {
                const orphanIds = orphans.map((m: any) => m.id);
                await supabase
                  .from('messages')
                  .update({ thread_id: existingThread.id })
                  .in('id', orphanIds);
                logger.info(`🔄 Retroactively assigned ${orphanIds.length} orphaned messages to existing thread ${existingThread.id}`);
              }
            } catch (err) {
              logger.warn('Failed to retroactively assign orphaned messages (existing thread):', err);
            }
          }

          return { success: true };
        }

        // Insert new thread
        const threadData = activityPubToThread(
          threadObject,
          channel.id,
          parentMessageId,
          creatorId
        );

        // Preserve original UUID across instances
        const threadIdMatch = threadApId?.match(/\/threads\/([a-f0-9-]{36})/i);
        if (threadIdMatch) {
          threadData.id = threadIdMatch[1];
        }

        logger.info(`📋 Inserting thread: id=${threadData.id || 'auto'}, channel_id=${threadData.channel_id}, parent_message_id=${threadData.parent_message_id}, created_by=${threadData.created_by}, ap_id=${threadData.ap_id}`);

        const { error } = await supabase
          .from('threads')
          .insert(threadData);

        if (error) {
          // If duplicate key, try upsert
          if (error.code === '23505') {
            logger.info(`Thread ${threadData.id} already exists (race condition), updating instead`);
            const { error: upsertError } = await supabase
              .from('threads')
              .update({
                name: threadObject.name,
                ap_id: threadApId,
                federation_status: 'synced',
              })
              .eq('id', threadData.id);
            if (upsertError) {
              logger.error('Failed to upsert federated thread:', upsertError);
              return { success: false, error: upsertError.message };
            }
            logger.info(`✅ Upserted federated thread: ${threadObject.name}`);

            // Also assign orphaned messages for the upsert case
            if (threadData.id && threadApId) {
              try {
                const { data: orphans } = await supabase
                  .from('messages')
                  .select('id')
                  .eq('channel_id', channel.id)
                  .is('thread_id', null)
                  .eq('metadata->>pending_thread_ap_id', threadApId);
                if (orphans && orphans.length > 0) {
                  const orphanIds = orphans.map((m: any) => m.id);
                  await supabase
                    .from('messages')
                    .update({ thread_id: threadData.id })
                    .in('id', orphanIds);
                  logger.info(`🔄 Retroactively assigned ${orphanIds.length} orphaned messages to thread ${threadData.id} (upsert)`);
                }
              } catch (err) {
                logger.warn('Failed to retroactively assign orphaned messages (upsert):', err);
              }
            }

            return { success: true };
          }
          logger.error(`Failed to create federated thread: code=${error.code}, message=${error.message}, details=${error.details}`);
          return { success: false, error: error.message };
        }

        logger.info(`✅ Created federated thread: "${threadObject.name}" (id: ${threadData.id}, ap_id: ${threadApId}, channel: ${channel.id})`);

        // Retroactively assign orphaned messages that arrived before this thread.
        // These messages have pending_thread_ap_id in their metadata but thread_id = null.
        const finalThreadId = threadData.id;
        if (finalThreadId && threadApId) {
          try {
            const { data: orphans } = await supabase
              .from('messages')
              .select('id')
              .eq('channel_id', channel.id)
              .is('thread_id', null)
              .eq('metadata->>pending_thread_ap_id', threadApId);
            if (orphans && orphans.length > 0) {
              const orphanIds = orphans.map((m: any) => m.id);
              await supabase
                .from('messages')
                .update({ thread_id: finalThreadId })
                .in('id', orphanIds);
              logger.info(`🔄 Retroactively assigned ${orphanIds.length} orphaned messages to thread ${finalThreadId}`);
            }
          } catch (err) {
            logger.warn('Failed to retroactively assign orphaned messages to thread:', err);
          }
        }

        return { success: true };
      }

      case 'Update': {
        const threadObject = activity.object as ThreadObject;

        const { error } = await supabase
          .from('threads')
          .update({
            name: threadObject.name,
            archived: threadObject.archived,
            locked: threadObject.locked,
            auto_archive_duration: threadObject.autoArchiveDuration,
            message_count: threadObject.messageCount,
            member_count: threadObject.memberCount,
            last_message_at: threadObject.lastMessageAt,
          })
          .eq('ap_id', threadObject.id);

        if (error) {
          logger.error('Failed to update federated thread:', error);
          return { success: false, error: error.message };
        }

        logger.info(`✅ Updated federated thread: ${threadObject.name}`);
        return { success: true };
      }

      case 'Delete': {
        const threadObject = activity.object as ThreadObject;

        const { error } = await supabase
          .from('threads')
          .delete()
          .eq('ap_id', threadObject.id);

        if (error) {
          logger.error('Failed to delete federated thread:', error);
          return { success: false, error: error.message };
        }

        logger.info(`✅ Deleted federated thread: ${threadObject.id}`);
        return { success: true };
      }

      case 'Add': {
        const membership = activity.object as ThreadMembershipActivity;

        const [{ data: thread }, { data: user }] = await Promise.all([
          supabase
            .from('threads')
            .select('id')
            .eq('ap_id', membership.object)
            .single(),
          supabase
            .from('profiles')
            .select('id')
            .eq('federated_id', membership.subject)
            .single(),
        ]);

        if (!thread || !user) {
          logger.warn('Thread or user not found for membership');
          return { success: false, error: 'Thread or user not found' };
        }

        const { error } = await supabase
          .from('thread_members')
          .upsert({
            thread_id: thread.id,
            user_id: user.id,
          }, {
            onConflict: 'thread_id,user_id',  // Column names, not constraint name
          });

        if (error) {
          logger.error('Failed to add thread member:', error);
          return { success: false, error: error.message };
        }

        logger.info(`✅ Added member to thread ${thread.id}`);
        return { success: true };
      }

      case 'Remove': {
        const membership = activity.object as ThreadMembershipActivity;

        const [{ data: thread }, { data: user }] = await Promise.all([
          supabase
            .from('threads')
            .select('id')
            .eq('ap_id', membership.object)
            .single(),
          supabase
            .from('profiles')
            .select('id')
            .eq('federated_id', membership.subject)
            .single(),
        ]);

        if (!thread || !user) {
          return { success: true }; // Already removed
        }

        const { error } = await supabase
          .from('thread_members')
          .delete()
          .eq('thread_id', thread.id)
          .eq('user_id', user.id);

        if (error) {
          logger.error('Failed to remove thread member:', error);
          return { success: false, error: error.message };
        }

        logger.info(`✅ Removed member from thread ${thread.id}`);
        return { success: true };
      }

      default:
        logger.warn(`Unknown thread activity type: ${activity.type}`);
        return { success: false, error: 'Unknown activity type' };
    }
  } catch (error: any) {
    logger.error('Error handling thread activity:', error);
    return { success: false, error: error.message };
  }
}

export function createThreadActivity(
  type: 'Create' | 'Update' | 'Delete',
  thread: any,
  channelApId: string,
  parentMessageApId: string,
  creatorApId: string,
  actorApId: string,
  serverId?: string,
  channelName?: string,
  channelId?: string
): ThreadActivity {
  const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
  const threadObject = threadToActivityPub(
    thread, channelApId, parentMessageApId, creatorApId,
    channelName, channelId
  );

  if (serverId) {
    (threadObject as any)['harmony:serverId'] = serverId;
  }

  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      {
        harmony: 'https://harmonyapp.dev/ns#',
        ChatThread: 'harmony:ChatThread',
        autoArchiveDuration: 'harmony:autoArchiveDuration',
        messageCount: 'harmony:messageCount',
        memberCount: 'harmony:memberCount',
        lastMessageAt: 'harmony:lastMessageAt',
        serverId: 'harmony:serverId',
        channelName: 'harmony:channelName',
        channelId: 'harmony:channelId',
      },
    ],
    id: `${baseUrl}/activities/${crypto.randomUUID()}`,
    type,
    actor: actorApId,
    object: threadObject,
    published: new Date().toISOString(),
    to: [`${channelApId}/followers`],
    cc: ['https://www.w3.org/ns/activitystreams#Public'],
  };
}

export function createThreadMembershipActivity(
  type: 'Add' | 'Remove',
  userApId: string,
  threadApId: string,
  actorApId: string,
  channelApId: string
): ThreadActivity {
  const baseUrl = `https://${config.INSTANCE_DOMAIN}`;

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${baseUrl}/activities/${crypto.randomUUID()}`,
    type,
    actor: actorApId,
    object: {
      type: 'Relationship',
      subject: userApId,
      object: threadApId,
      relationship: 'memberOf',
    },
    published: new Date().toISOString(),
    to: [userApId, `${channelApId}/followers`],
  };
}

/**
 * GET /threads/:threadId
 * Get a thread as ActivityPub object
 */
router.get(
  '/threads/:threadId',
  asyncHandler(async (req: Request, res: Response) => {
    const { threadId } = req.params;
    const supabase = getSupabaseClient();

    const { data: thread, error } = await supabase
      .from('threads')
      .select(`
        *,
        channels (
          id,
          ap_id,
          server_id
        ),
        messages!threads_parent_message_id_fkey (
          id,
          metadata
        ),
        profiles!threads_created_by_fkey (
          federated_id
        )
      `)
      .eq('id', threadId)
      .single();

    if (error || !thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const channelApId = thread.channels?.ap_id || `${baseUrl}/channels/${thread.channel_id}`;
    const parentMessageApId = thread.messages?.metadata?.ap_id || `${baseUrl}/messages/${thread.parent_message_id}`;
    const creatorApId = thread.profiles?.federated_id || `${baseUrl}/users/${thread.created_by}`;

    res.setHeader('Content-Type', 'application/activity+json');
    res.json(threadToActivityPub(thread, channelApId, parentMessageApId, creatorApId));
  })
);

/**
 * GET /threads/:threadId/members
 * Get thread members as ActivityPub Collection
 */
router.get(
  '/threads/:threadId/members',
  asyncHandler(async (req: Request, res: Response) => {
    const { threadId } = req.params;
    const supabase = getSupabaseClient();

    const { data: members, error } = await supabase
      .from('thread_members')
      .select(`
        user_id,
        joined_at,
        profiles:user_id (
          federated_id
        )
      `)
      .eq('thread_id', threadId);

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch thread members' });
    }

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const collectionUrl = `${baseUrl}/threads/${threadId}/members`;

    res.setHeader('Content-Type', 'application/activity+json');
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: collectionUrl,
      type: 'OrderedCollection',
      totalItems: members?.length || 0,
      orderedItems: (members || []).map(m => ({
        type: 'Person',
        id: m.profiles?.federated_id || `${baseUrl}/users/${m.user_id}`,
        joinedAt: m.joined_at,
      })),
    });
  })
);

/**
 * GET /channels/:channelId/threads
 * Get all threads in a channel
 */
router.get(
  '/channels/:channelId/threads',
  asyncHandler(async (req: Request, res: Response) => {
    const { channelId } = req.params;
    const includeArchived = req.query.includeArchived === 'true';
    const supabase = getSupabaseClient();

    let query = supabase
      .from('threads')
      .select(`
        *,
        channels (
          id,
          ap_id
        ),
        messages!threads_parent_message_id_fkey (
          id,
          metadata
        ),
        profiles!threads_created_by_fkey (
          federated_id
        )
      `)
      .eq('channel_id', channelId)
      .order('last_message_at', { ascending: false, nullsFirst: false });

    if (!includeArchived) {
      query = query.eq('archived', false);
    }

    const { data: threads, error } = await query;

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch threads' });
    }

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const collectionUrl = `${baseUrl}/channels/${channelId}/threads`;

    const { data: channel } = await supabase
      .from('channels')
      .select('ap_id')
      .eq('id', channelId)
      .single();

    const channelApId = channel?.ap_id || `${baseUrl}/channels/${channelId}`;

    res.setHeader('Content-Type', 'application/activity+json');
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: collectionUrl,
      type: 'OrderedCollection',
      totalItems: threads?.length || 0,
      orderedItems: (threads || []).map(t => {
        const parentMessageApId = t.messages?.metadata?.ap_id || `${baseUrl}/messages/${t.parent_message_id}`;
        const creatorApId = t.profiles?.federated_id || `${baseUrl}/users/${t.created_by}`;
        return threadToActivityPub(t, channelApId, parentMessageApId, creatorApId);
      }),
    });
  })
);

export default router;

