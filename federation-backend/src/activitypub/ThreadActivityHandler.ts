import { Router, Request, Response } from 'express';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';
import { SignatureService } from './SignatureService.js';
import { sameOrigin } from '../utils/apOrigin.js';
import {
  authorizeChannelWrite,
  resolveMessageInChannel,
  THREAD_STUB_STATUS,
  type ChannelWriteKind,
} from './channelWriteAuthz.js';

const router = Router();

type ExistingThread = {
  id: string;
  channel_id: string;
  ap_id: string | null;
  federation_status: string | null;
  creator: { federated_id: string | null } | null;
};

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

/**
 * Convert database thread to ActivityPub Thread object
 */
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

/**
 * Convert ActivityPub Thread object to database format
 */
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

/**
 * Inbound ChatThread activities from the shared inbox and server inboxes.
 *
 * `activity.actor` is the verified signer. Create requires attributedTo (when
 * present) to be the signer and the thread id to be on the signer's host; the
 * thread's channel, parent message and any existing row are resolved within one
 * channel, and the write passes authorizeChannelWrite. Update and Delete come
 * from the thread's creator. Add and Remove (thread membership) name the signer
 * as subject. `opts.serverId` confines a server inbox to its own channels.
 */
export async function handleThreadActivity(
  activity: ThreadActivity,
  opts: { serverId?: string } = {},
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();
  const actorUrl: string | undefined =
    typeof activity.actor === 'string' ? activity.actor : (activity.actor as any)?.id;
  if (!actorUrl) return { success: false, error: 'Missing actor' };

  // The thread's channel, confined to opts.serverId, authorized for `kind`.
  const authorizeThreadChannel = async (
    channelId: string,
    kind: ChannelWriteKind,
  ): Promise<{ ok: true; serverId: string; userId: string } | { ok: false; error: string }> => {
    const { data: channel } = await supabase
      .from('channels')
      .select('id, server_id')
      .eq('id', channelId)
      .maybeSingle();
    if (!channel) return { ok: false, error: 'Channel not found' };
    if (opts.serverId && channel.server_id !== opts.serverId) {
      return { ok: false, error: 'Channel is not in this server' };
    }
    const authz = await authorizeChannelWrite(supabase, {
      actorUrl, serverId: channel.server_id, channelId: channel.id, kind,
    });
    if (!authz.ok) return { ok: false, error: authz.reason };
    return { ok: true, serverId: channel.server_id, userId: authz.userId };
  };

  // Update and Delete: the thread named by ap_id, written by its creator.
  const loadOwnedThread = async (
    threadApId: string | undefined,
  ): Promise<{ ok: true; id: string } | { ok: false; error: string }> => {
    if (!threadApId) return { ok: false, error: 'Missing thread id' };
    const { data: thread } = await supabase
      .from('threads')
      .select('id, channel_id, creator:profiles!threads_created_by_fkey(federated_id)')
      .eq('ap_id', threadApId)
      .maybeSingle();
    if (!thread) return { ok: false, error: 'Thread not found' };
    const creatorUrl = (thread as any).creator?.federated_id as string | null | undefined;
    if (!creatorUrl || !SignatureService.verifyActorMatch(actorUrl, creatorUrl)) {
      return { ok: false, error: 'Signer is not the thread creator' };
    }
    const authz = await authorizeThreadChannel(thread.channel_id, 'edit');
    if (!authz.ok) return authz;
    return { ok: true, id: thread.id };
  };

  try {
    logger.info(`Processing ${activity.type} thread activity: ${activity.id}`);

    switch (activity.type) {
      case 'Create': {
        const threadObject = activity.object as ThreadObject;
        const harmonyServerId = (threadObject as any)['harmony:serverId'];

        logger.info(`Thread Create: name="${threadObject.name}", context=${threadObject.context}, inReplyTo=${threadObject.inReplyTo}, attributedTo=${threadObject.attributedTo}, harmony:serverId=${harmonyServerId}`);

        if (threadObject.attributedTo && !SignatureService.verifyActorMatch(actorUrl, threadObject.attributedTo)) {
          logger.warn(`Rejecting thread Create: attributedTo ${threadObject.attributedTo} is not the signer ${actorUrl}`);
          return { success: false, error: 'attributedTo is not the signer' };
        }
        if (!threadObject.id || !sameOrigin(threadObject.id, actorUrl)) {
          logger.warn(`Rejecting thread Create: ${threadObject.id} is not on the host of ${actorUrl}`);
          return { success: false, error: 'Thread id is not on the signer host' };
        }

        // --- Resolve channel ---
        // Strategies: ap_id match, UUID from the context URL, harmony:channelId or
        // channel name within harmony:serverId, the parent message's channel.
        let channelId: string | null = null;
        const harmonyChannelName = (threadObject as any)['harmony:channelName'];
        const harmonyChannelId = (threadObject as any)['harmony:channelId'];
        const scopeServerId: string | undefined = opts.serverId ?? harmonyServerId;

        if (typeof threadObject.context === 'string') {
          let byApIdQuery = supabase.from('channels').select('id').eq('ap_id', threadObject.context);
          if (opts.serverId) byApIdQuery = byApIdQuery.eq('server_id', opts.serverId);
          const { data: channelByApId } = await byApIdQuery.maybeSingle();
          channelId = channelByApId?.id ?? null;

          const channelUuid = threadObject.context.match(/\/channels\/([a-f0-9-]{36})/i)?.[1];
          if (!channelId && channelUuid) {
            let byIdQuery = supabase.from('channels').select('id').eq('id', channelUuid);
            if (opts.serverId) byIdQuery = byIdQuery.eq('server_id', opts.serverId);
            const { data: channelById } = await byIdQuery.maybeSingle();
            channelId = channelById?.id ?? null;
          }
        }

        if (!channelId && scopeServerId && harmonyChannelId) {
          const { data: channelByHarmonyId } = await supabase
            .from('channels')
            .select('id')
            .eq('id', harmonyChannelId)
            .eq('server_id', scopeServerId)
            .maybeSingle();
          channelId = channelByHarmonyId?.id ?? null;
        }

        if (!channelId && scopeServerId && harmonyChannelName) {
          const { data: channelByName } = await supabase
            .from('channels')
            .select('id')
            .eq('name', harmonyChannelName)
            .eq('server_id', scopeServerId)
            .maybeSingle();
          channelId = channelByName?.id ?? null;
        }

        if (!channelId && typeof threadObject.inReplyTo === 'string') {
          const { data: parentByApId } = await supabase
            .from('messages')
            .select('channel_id')
            .eq('metadata->>ap_id', threadObject.inReplyTo)
            .not('channel_id', 'is', null)
            .maybeSingle();
          channelId = parentByApId?.channel_id ?? null;
          const msgUuid = threadObject.inReplyTo.match(/\/messages\/([a-f0-9-]{36})/i)?.[1];
          if (!channelId && msgUuid) {
            const { data: parentById } = await supabase
              .from('messages')
              .select('channel_id')
              .eq('id', msgUuid)
              .not('channel_id', 'is', null)
              .maybeSingle();
            channelId = parentById?.channel_id ?? null;
          }
        }

        if (!channelId) {
          logger.warn(`Channel not found for thread. context=${threadObject.context}, harmony:serverId=${harmonyServerId}, harmony:channelName=${harmonyChannelName}, inReplyTo=${threadObject.inReplyTo}`);
          return { success: false, error: 'Channel not found' };
        }

        // --- Resolve parent message, in the same channel ---
        // A standalone thread's parent is the sender's own notice; this instance posts its own.
        const standalone = (threadObject as any)['harmony:standalone'] === true;
        const parentMessageId = typeof threadObject.inReplyTo === 'string'
          ? await resolveMessageInChannel(supabase, threadObject.inReplyTo, channelId)
          : null;
        if (!parentMessageId && !standalone) {
          logger.warn(`Parent message not found in channel ${channelId}. inReplyTo=${threadObject.inReplyTo}`);
          return { success: false, error: 'Parent message not found' };
        }

        // --- Existing thread (idempotent). A row found by UUID must carry this ap_id:
        // a local thread or another instance's thread is not the signer's to rewrite.
        const threadApId = threadObject.id;
        const existingColumns = 'id, channel_id, ap_id, federation_status, creator:profiles!threads_created_by_fkey(federated_id)';
        let existingThread: ExistingThread | null = null;
        const { data: byApId } = await supabase
          .from('threads')
          .select(existingColumns)
          .eq('ap_id', threadApId)
          .maybeSingle();
        existingThread = byApId as unknown as ExistingThread | null;
        if (!existingThread) {
          const threadUuid = threadApId.match(/\/threads\/([a-f0-9-]{36})/i)?.[1];
          if (threadUuid) {
            const { data: byId } = await supabase
              .from('threads')
              .select(existingColumns)
              .eq('id', threadUuid)
              .maybeSingle();
            if (byId && byId.ap_id !== threadApId) {
              logger.warn(`Rejecting thread Create: thread ${threadUuid} exists under ap_id ${byId.ap_id}`);
              return { success: false, error: 'Thread id belongs to another thread' };
            }
            existingThread = byId as unknown as ExistingThread | null;
          }
        }
        if (existingThread && existingThread.channel_id !== channelId) {
          logger.warn(`Rejecting thread Create: thread ${existingThread.id} is in channel ${existingThread.channel_id}, not ${channelId}`);
          return { success: false, error: 'Thread is in another channel' };
        }

        // An existing thread changes owner only while it is a stub; otherwise
        // only its creator re-sends the Create.
        const writeExisting = async (existing: ExistingThread): Promise<{ success: boolean; error?: string }> => {
          const isStub = existing.federation_status === THREAD_STUB_STATUS;
          const creatorUrl = existing.creator?.federated_id;
          if (!isStub && (!creatorUrl || !SignatureService.verifyActorMatch(actorUrl, creatorUrl))) {
            logger.warn(`Rejecting thread Create from ${actorUrl}: thread ${existing.id} belongs to ${creatorUrl ?? 'nobody'}`);
            return { success: false, error: 'Signer is not the thread creator' };
          }

          const authz = await authorizeThreadChannel(channelId, isStub ? 'thread_create' : 'edit');
          if (!authz.ok) {
            logger.warn(`Rejecting thread Create from ${actorUrl}: ${authz.error}`);
            return { success: false, error: authz.error };
          }

          const updateData: Record<string, any> = {
            name: threadObject.name,
            archived: threadObject.archived || false,
            locked: threadObject.locked || false,
            auto_archive_duration: threadObject.autoArchiveDuration || 1440,
            message_count: threadObject.messageCount || 0,
            member_count: threadObject.memberCount || 0,
            last_message_at: threadObject.lastMessageAt,
          };
          if (isStub) {
            // A stub carries a placeholder parent and the first message's author.
            if (parentMessageId) updateData.parent_message_id = parentMessageId;
            updateData.created_by = authz.userId;
            updateData.federation_status = 'synced';
          }

          let update = supabase.from('threads').update(updateData).eq('id', existing.id);
          if (isStub) update = update.eq('federation_status', THREAD_STUB_STATUS);
          const { error: updateError } = await update;

          if (updateError) {
            logger.error('Failed to update existing federated thread:', updateError);
            return { success: false, error: updateError.message };
          }
          logger.info(`${isStub ? 'Claimed stub' : 'Updated'} federated thread: ${threadObject.name} (id: ${existing.id})`);

          await adoptOrphanMessages(supabase, channelId, threadApId, existing.id);
          return { success: true };
        };

        if (existingThread) {
          return writeExisting(existingThread);
        }

        const authz = await authorizeThreadChannel(channelId, 'thread_create');
        if (!authz.ok) {
          logger.warn(`Rejecting thread Create from ${actorUrl}: ${authz.error}`);
          return { success: false, error: authz.error };
        }
        const creatorId = authz.userId;

        // --- Insert new thread ---
        // Preserve original UUID across instances
        const threadIdMatch = threadApId.match(/\/threads\/([a-f0-9-]{36})/i);
        const threadId = threadIdMatch?.[1] ?? crypto.randomUUID();

        let noticeId: string | null = null;
        if (!parentMessageId) {
          const { data: notice, error: noticeError } = await supabase
            .from('messages')
            .insert({
              channel_id: channelId,
              user_id: creatorId,
              content: [{ type: 'text', text: 'started a thread' }],
              is_system: true,
              metadata: { type: 'thread_created', thread_id: threadId, thread_name: threadObject.name, standalone: true },
            })
            .select('id')
            .single();
          if (noticeError || !notice) {
            logger.error('Failed to post standalone thread notice:', noticeError);
            return { success: false, error: 'Failed to post thread notice' };
          }
          noticeId = notice.id;
        }

        const threadData = activityPubToThread(threadObject, channelId, (parentMessageId ?? noticeId)!, creatorId);
        threadData.id = threadId;

        logger.info(`Inserting thread: id=${threadData.id || 'auto'}, channel_id=${threadData.channel_id}, parent_message_id=${threadData.parent_message_id}, created_by=${threadData.created_by}, ap_id=${threadData.ap_id}`);

        const { error } = await supabase
          .from('threads')
          .insert(threadData);

        if (error && noticeId) {
          await supabase.from('messages').delete().eq('id', noticeId);
        }
        if (error) {
          // 23505: a concurrent insert of the same thread; only that thread is adopted.
          if (error.code === '23505' && threadData.id) {
            const { data: raced } = await supabase
              .from('threads')
              .select(existingColumns)
              .eq('id', threadData.id)
              .maybeSingle();
            if (!raced || raced.ap_id !== threadApId || raced.channel_id !== channelId) {
              return { success: false, error: 'Thread id belongs to another thread' };
            }
            logger.info(`Thread ${threadData.id} inserted concurrently`);
            return writeExisting(raced as unknown as ExistingThread);
          }
          logger.error(`Failed to create federated thread: code=${error.code}, message=${error.message}, details=${error.details}`);
          return { success: false, error: error.message };
        }

        logger.info(`Created federated thread: "${threadObject.name}" (id: ${threadData.id}, ap_id: ${threadApId}, channel: ${channelId})`);

        if (threadData.id) {
          await adoptOrphanMessages(supabase, channelId, threadApId, threadData.id);
        }
        return { success: true };
      }

      case 'Update': {
        const threadObject = activity.object as ThreadObject;
        const owned = await loadOwnedThread(threadObject.id);
        if (!owned.ok) {
          logger.warn(`Rejecting thread Update from ${actorUrl}: ${owned.error}`);
          return { success: false, error: owned.error };
        }

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
          .eq('id', owned.id);

        if (error) {
          logger.error('Failed to update federated thread:', error);
          return { success: false, error: error.message };
        }

        logger.info(`Updated federated thread: ${threadObject.name}`);
        return { success: true };
      }

      case 'Delete': {
        const threadObject = activity.object as ThreadObject;
        const owned = await loadOwnedThread(threadObject.id);
        if (!owned.ok) {
          logger.warn(`Rejecting thread Delete from ${actorUrl}: ${owned.error}`);
          return { success: false, error: owned.error };
        }

        const { error } = await supabase
          .from('threads')
          .delete()
          .eq('id', owned.id);

        if (error) {
          logger.error('Failed to delete federated thread:', error);
          return { success: false, error: error.message };
        }

        logger.info(`Deleted federated thread: ${threadObject.id}`);
        return { success: true };
      }

      case 'Add':
      case 'Remove': {
        // Thread membership: the signer joins or leaves.
        const membership = activity.object as ThreadMembershipActivity;
        if (!membership?.subject || !SignatureService.verifyActorMatch(actorUrl, membership.subject)) {
          return { success: false, error: 'Signer is not the subject' };
        }

        const { data: thread } = await supabase
          .from('threads')
          .select('id, channel_id')
          .eq('ap_id', membership.object)
          .maybeSingle();

        if (!thread) {
          logger.warn('Thread not found for membership');
          return activity.type === 'Remove' ? { success: true } : { success: false, error: 'Thread not found' };
        }

        const authz = await authorizeThreadChannel(thread.channel_id, 'edit');
        if (!authz.ok) {
          logger.warn(`Rejecting thread membership ${activity.type} from ${actorUrl}: ${authz.error}`);
          return { success: false, error: authz.error };
        }

        if (activity.type === 'Add') {
          const { error } = await supabase
            .from('thread_members')
            .upsert({
              thread_id: thread.id,
              user_id: authz.userId,
            }, {
              onConflict: 'thread_id,user_id',  // Column names, not constraint name
            });

          if (error) {
            logger.error('Failed to add thread member:', error);
            return { success: false, error: error.message };
          }
          logger.info(`Added member to thread ${thread.id}`);
          return { success: true };
        }

        const { error } = await supabase
          .from('thread_members')
          .delete()
          .eq('thread_id', thread.id)
          .eq('user_id', authz.userId);

        if (error) {
          logger.error('Failed to remove thread member:', error);
          return { success: false, error: error.message };
        }

        logger.info(`Removed member from thread ${thread.id}`);
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

/** Messages that arrived before their thread carry pending_thread_ap_id; they join it here. */
async function adoptOrphanMessages(
  supabase: ReturnType<typeof getSupabaseClient>,
  channelId: string,
  threadApId: string,
  threadId: string,
): Promise<void> {
  try {
    const { data: orphans } = await supabase
      .from('messages')
      .select('id')
      .eq('channel_id', channelId)
      .is('thread_id', null)
      .eq('metadata->>pending_thread_ap_id', threadApId);
    if (orphans && orphans.length > 0) {
      const orphanIds = orphans.map((m: any) => m.id);
      await supabase
        .from('messages')
        .update({ thread_id: threadId })
        .in('id', orphanIds);
      logger.info(`Assigned ${orphanIds.length} orphaned messages to thread ${threadId}`);
    }
  } catch (err) {
    logger.warn('Failed to assign orphaned messages to thread:', err);
  }
}

/**
 * Create a thread activity for federation
 */
export function createThreadActivity(
  type: 'Create' | 'Update' | 'Delete',
  thread: any,
  channelApId: string,
  parentMessageApId: string,
  creatorApId: string,
  actorApId: string,
  serverId?: string,
  channelName?: string,
  channelId?: string,
  standalone?: boolean
): ThreadActivity {
  const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
  const threadObject = threadToActivityPub(
    thread, channelApId, parentMessageApId, creatorApId,
    channelName, channelId
  );

  if (serverId) {
    (threadObject as any)['harmony:serverId'] = serverId;
  }
  if (standalone) {
    (threadObject as any)['harmony:standalone'] = true;
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
        standalone: 'harmony:standalone',
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

/**
 * Create a thread membership activity for federation
 */
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
      res.status(404).json({ error: 'Thread not found' });
      return;
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
      .eq('thread_id', threadId)
      // PostgREST returns a many-to-one embed as an object. The client is built
      // without a generated schema, so it cannot see cardinality and widens
      // every embed to an array.
      .overrideTypes<
        {
          user_id: string;
          joined_at: string;
          profiles: { federated_id: string | null };
        }[],
        { merge: false }
      >();

    if (error) {
      res.status(500).json({ error: 'Failed to fetch thread members' });
      return;
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
      res.status(500).json({ error: 'Failed to fetch threads' });
      return;
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

