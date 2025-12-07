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
  '@context': string | string[];
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
  creatorApId: string
): ThreadObject {
  const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
  const threadApId = thread.ap_id || `${baseUrl}/threads/${thread.id}`;

  return {
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
 * Handle incoming thread activities from federated servers
 */
export async function handleThreadActivity(
  activity: ThreadActivity,
): Promise<{ success: boolean; error?: string }> {
  const supabase = getSupabaseClient();

  try {
    logger.info(`📋 Processing ${activity.type} thread activity: ${activity.id}`);

    switch (activity.type) {
      case 'Create': {
        const threadObject = activity.object as ThreadObject;
        
        // Find local channel by AP ID
        const { data: channel } = await supabase
          .from('channels')
          .select('id, server_id')
          .eq('ap_id', threadObject.context)
          .single();

        if (!channel) {
          logger.warn(`Channel not found for thread: ${threadObject.context}`);
          return { success: false, error: 'Channel not found' };
        }

        // Find local message by AP ID
        const { data: parentMessage } = await supabase
          .from('messages')
          .select('id')
          .eq('metadata->>ap_id', threadObject.inReplyTo)
          .single();

        if (!parentMessage) {
          logger.warn(`Parent message not found for thread: ${threadObject.inReplyTo}`);
          return { success: false, error: 'Parent message not found' };
        }

        // Find or create creator profile
        const { data: creator } = await supabase
          .from('profiles')
          .select('id')
          .eq('federated_id', threadObject.attributedTo)
          .single();

        if (!creator) {
          logger.warn(`Creator not found for thread: ${threadObject.attributedTo}`);
          return { success: false, error: 'Creator not found' };
        }

        const threadData = activityPubToThread(
          threadObject,
          channel.id,
          parentMessage.id,
          creator.id
        );

        const { error } = await supabase
          .from('threads')
          .upsert(threadData, {
            onConflict: 'ap_id',
          });

        if (error) {
          logger.error('Failed to create federated thread:', error);
          return { success: false, error: error.message };
        }

        logger.info(`✅ Created federated thread: ${threadObject.name}`);
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
        // User joining a thread
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
            onConflict: 'thread_members_unique',
          });

        if (error) {
          logger.error('Failed to add thread member:', error);
          return { success: false, error: error.message };
        }

        logger.info(`✅ Added member to thread ${thread.id}`);
        return { success: true };
      }

      case 'Remove': {
        // User leaving a thread
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

/**
 * Create a thread activity for federation
 */
export function createThreadActivity(
  type: 'Create' | 'Update' | 'Delete',
  thread: any,
  channelApId: string,
  parentMessageApId: string,
  creatorApId: string,
  actorApId: string
): ThreadActivity {
  const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
  const threadObject = threadToActivityPub(thread, channelApId, parentMessageApId, creatorApId);

  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      {
        ChatThread: 'harmony:ChatThread',
        autoArchiveDuration: 'harmony:autoArchiveDuration',
        messageCount: 'harmony:messageCount',
        memberCount: 'harmony:memberCount',
        lastMessageAt: 'harmony:lastMessageAt',
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

