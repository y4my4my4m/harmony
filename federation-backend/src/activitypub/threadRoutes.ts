/**
 * Threads of local servers' channels, read over ActivityPub:
 *
 *   GET /threads/:threadId                ChatThread
 *   GET /threads/:threadId/members        its members, an OrderedCollection of actor ids
 *   GET /channels/:channelId/threads      the channel's threads, an OrderedCollection
 *
 * A thread is read under its channel's rules (groupAccess.ts), as the Group routes read the
 * channel: a public server's channels @everyone can view are served to anyone, every other
 * channel only to the signed remote member who can view it. An unknown id and one the caller
 * may not read answer the same 404. A thread opened on another instance keeps that
 * instance's id and is listed by id only; /threads/<id> serves the threads this instance
 * named. Only ActivityPub media types are served: 406 otherwise, as /messages/<id>.
 */

import { Router, Request, Response } from 'express';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { sameUrl } from '../utils/apOrigin.js';
import { isPublicView, loadGroupAccess, readableChannelIds, verifiedSigner } from './groupAccess.js';
import { threadToActivityPub } from './ThreadActivityHandler.js';
import { HARMONY_NS } from './harmonyContext.js';

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THREADS_PER_PAGE = 20;
const MEMBERS_PER_PAGE = 50;
const PRIVATE_CACHE = 'private, no-store';

const CONTEXT = [
  'https://www.w3.org/ns/activitystreams',
  {
    harmony: HARMONY_NS,
    ChatThread: 'harmony:ChatThread',
    autoArchiveDuration: 'harmony:autoArchiveDuration',
    messageCount: 'harmony:messageCount',
    memberCount: 'harmony:memberCount',
    lastMessageAt: 'harmony:lastMessageAt',
    serverId: 'harmony:serverId',
    channelName: 'harmony:channelName',
    channelId: 'harmony:channelId',
  },
];

const THREAD_COLUMNS = `
  id, channel_id, parent_message_id, name, created_by, created_at, updated_at, archived, locked,
  auto_archive_duration, message_count, member_count, last_message_at, ap_id,
  parent:messages!threads_parent_message_id_fkey(id, metadata),
  creator:profiles!threads_created_by_fkey(username, federated_id)
`;

interface ReadableChannel {
  id: string;
  name: string;
  server_id: string;
  ap_id: string | null;
  /** The response holds nothing beyond what anyone may read. */
  shareable: boolean;
}

function base(): string {
  return `https://${config.INSTANCE_DOMAIN}`;
}

function acceptsActivityPub(req: Request): boolean {
  const accept = req.headers.accept || '';
  return accept.includes('application/activity+json') || accept.includes('application/ld+json');
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'Not found' });
}

function send(res: Response, shareable: boolean, body: unknown): void {
  res.setHeader('Content-Type', 'application/activity+json');
  res.setHeader('Cache-Control', shareable ? 'public, max-age=60' : PRIVATE_CACHE);
  res.json(body);
}

/** The channel when it belongs to a local server and the request's signer may read it. */
async function readableChannel(req: Request, channelId: string): Promise<ReadableChannel | null> {
  const { data: channel } = await getSupabaseClient()
    .from('channels')
    .select('id, name, server_id, ap_id, is_remote')
    .eq('id', channelId)
    .maybeSingle();
  if (!channel || channel.is_remote === true || !channel.server_id) return null;

  const access = await loadGroupAccess(channel.server_id, await verifiedSigner(req));
  if (!access || !readableChannelIds(access).has(channel.id)) return null;
  return {
    id: channel.id,
    name: channel.name,
    server_id: channel.server_id,
    ap_id: channel.ap_id,
    shareable: isPublicView(access, [channel.id]),
  };
}

/** The thread's id is this instance's URL for its row. */
function ownThread(thread: any): boolean {
  return !thread.ap_id || sameUrl(thread.ap_id, `${base()}/threads/${thread.id}`);
}

function channelApId(channel: ReadableChannel): string {
  return channel.ap_id || `${base()}/servers/${channel.server_id}/channels/${channel.id}`;
}

function threadObject(thread: any, channel: ReadableChannel): Record<string, unknown> {
  const parentApId = thread.parent?.metadata?.ap_id || `${base()}/messages/${thread.parent_message_id}`;
  const creatorApId = thread.creator?.federated_id
    || (thread.creator?.username ? `${base()}/users/${thread.creator.username}` : undefined);
  const object: Record<string, unknown> = {
    ...threadToActivityPub(thread, channelApId(channel), parentApId, creatorApId as string, channel.name, channel.id),
    id: `${base()}/threads/${thread.id}`,
    'harmony:serverId': channel.server_id,
  };
  if (!creatorApId) delete object.attributedTo;
  return object;
}

/** Page number of a collection request; null for the collection itself, NaN for a bad one. */
function pageOf(req: Request): number | null {
  if (req.query.page === undefined) return null;
  const page = Number(req.query.page);
  return Number.isInteger(page) && page >= 1 ? page : NaN;
}

async function loadThread(threadId: string): Promise<any | null> {
  if (!UUID.test(threadId)) return null;
  const { data } = await getSupabaseClient()
    .from('threads')
    .select(THREAD_COLUMNS)
    .eq('id', threadId)
    .maybeSingle();
  return data && ownThread(data) ? data : null;
}

router.get(
  '/threads/:threadId',
  asyncHandler(async (req: Request, res: Response) => {
    if (!acceptsActivityPub(req)) {
      res.status(406).json({ error: 'Not Acceptable' });
      return;
    }
    const thread = await loadThread(req.params.threadId);
    const channel = thread ? await readableChannel(req, thread.channel_id) : null;
    if (!thread || !channel) {
      notFound(res);
      return;
    }
    send(res, channel.shareable, { '@context': CONTEXT, ...threadObject(thread, channel) });
  }),
);

router.get(
  '/threads/:threadId/members',
  asyncHandler(async (req: Request, res: Response) => {
    if (!acceptsActivityPub(req)) {
      res.status(406).json({ error: 'Not Acceptable' });
      return;
    }
    const thread = await loadThread(req.params.threadId);
    const channel = thread ? await readableChannel(req, thread.channel_id) : null;
    const page = pageOf(req);
    if (!thread || !channel || Number.isNaN(page)) {
      notFound(res);
      return;
    }

    const supabase = getSupabaseClient();
    const collectionUrl = `${base()}/threads/${thread.id}/members`;
    if (page === null) {
      const { count } = await supabase
        .from('thread_members')
        .select('id', { count: 'exact', head: true })
        .eq('thread_id', thread.id);
      send(res, channel.shareable, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: collectionUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${collectionUrl}?page=1`,
      });
      return;
    }

    const offset = (page - 1) * MEMBERS_PER_PAGE;
    const { data: members } = await supabase
      .from('thread_members')
      .select('user_id, joined_at, profile:profiles!thread_members_user_id_fkey(username, federated_id, is_local)')
      .eq('thread_id', thread.id)
      // user_id breaks joined_at ties (rows inserted in one statement share now()); OFFSET
      // paging over a non-unique key repeats and skips rows between pages.
      .order('joined_at', { ascending: true })
      .order('user_id', { ascending: true })
      .range(offset, offset + MEMBERS_PER_PAGE - 1);
    const rows = (members ?? []) as any[];
    const items = rows
      .map((m) => m.profile?.federated_id || (m.profile?.is_local ? `${base()}/users/${m.profile.username}` : null))
      .filter((id): id is string => typeof id === 'string');

    send(res, channel.shareable, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${collectionUrl}?page=${page}`,
      type: 'OrderedCollectionPage',
      partOf: collectionUrl,
      orderedItems: items,
      next: rows.length === MEMBERS_PER_PAGE ? `${collectionUrl}?page=${page + 1}` : undefined,
    });
  }),
);

router.get(
  '/channels/:channelId/threads',
  asyncHandler(async (req: Request, res: Response) => {
    if (!acceptsActivityPub(req)) {
      res.status(406).json({ error: 'Not Acceptable' });
      return;
    }
    const { channelId } = req.params;
    const channel = UUID.test(channelId) ? await readableChannel(req, channelId) : null;
    const page = pageOf(req);
    if (!channel || Number.isNaN(page)) {
      notFound(res);
      return;
    }

    const supabase = getSupabaseClient();
    const collectionUrl = `${base()}/channels/${channel.id}/threads`;
    if (page === null) {
      const { count } = await supabase
        .from('threads')
        .select('id', { count: 'exact', head: true })
        .eq('channel_id', channel.id);
      send(res, channel.shareable, {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: collectionUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${collectionUrl}?page=1`,
      });
      return;
    }

    const offset = (page - 1) * THREADS_PER_PAGE;
    const { data: threads } = await supabase
      .from('threads')
      .select(THREAD_COLUMNS)
      .eq('channel_id', channel.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + THREADS_PER_PAGE - 1);
    const rows = (threads ?? []) as any[];

    send(res, channel.shareable, {
      '@context': CONTEXT,
      id: `${collectionUrl}?page=${page}`,
      type: 'OrderedCollectionPage',
      partOf: collectionUrl,
      orderedItems: rows.map((t) => (ownThread(t) ? threadObject(t, channel) : t.ap_id)),
      next: rows.length === THREADS_PER_PAGE ? `${collectionUrl}?page=${page + 1}` : undefined,
    });
  }),
);

export default router;
