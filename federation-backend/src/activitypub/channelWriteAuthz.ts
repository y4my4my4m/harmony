/**
 * Authorization for inbound federated writes into server channels: messages,
 * edits, reactions and threads, on the shared inbox and on server inboxes.
 *
 * `actorUrl` is the verified signer. Both inbox routes reject an activity whose
 * actor differs from the key owner, so the author is the profile whose
 * federated_id equals it, never a field of the object.
 *
 * Every write requires:
 *   - an author profile that is not suspended;
 *   - for a new message or thread, a server not suspended by this instance's staff
 *     (servers.suspended_at, migration 20261027250001);
 *   - the channel belongs to the server named by the activity or the route;
 *   - an accepted user_servers row and no server_bans row. On a remote server's local copy,
 *     a write signed by an account on the server's host whose row the copy lacks is checked
 *     against the Group's members collection, as a relay is (groupRelay.ts
 *     relayedMemberStanding), and the membership recorded when listed: a copy's member
 *     list is a partial mirror;
 *   - on a local server, VIEW_CHANNEL and the kind's permission through
 *     has_permission, and ATTACH_FILES for a message or edit carrying new
 *     uploads (federatedUploadUrls);
 *   - on a remote server's local copy, a signer on the server's host, or a relay
 *     by the server's Group (`relayedBy`, groupRelay.ts) for an actor elsewhere,
 *     and no block of the copy on this instance (instanceServerBlocks.ts).
 *     The host enforces permissions; the copy's roles and overrides are
 *     incomplete, so has_permission is not consulted there.
 */

import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { sameUrl } from '../utils/apOrigin.js';
import { isServerBlockedHere } from './instanceServerBlocks.js';
import type { RelayServer } from './groupRelay.js';

type Supabase = ReturnType<typeof getSupabaseClient>;

/**
 * federation_status of a thread created from a message that names a thread not
 * yet known here. The thread's own Create claims it; no other row changes owner.
 */
export const THREAD_STUB_STATUS = 'stub';

export type ChannelWriteKind =
  | 'message'
  | 'thread_message'
  | 'thread_create'
  | 'reaction'
  | 'edit';

// Each inner array is satisfied by any one of its permissions.
const KIND_PERMISSIONS: Record<ChannelWriteKind, string[][]> = {
  message: [['SEND_MESSAGES']],
  thread_message: [['SEND_MESSAGES_IN_THREADS']],
  // Harmony threads are public; CREATE_PRIVATE_THREADS grants no thread, as create_thread.
  thread_create: [['CREATE_PUBLIC_THREADS']],
  reaction: [['ADD_REACTIONS']],
  edit: [],
};

// Capability URL path of an object in a Harmony instance's media store (privateMedia.ts):
// .../media/<c|d|u>/<uuid>/<name>, with to= and sig= in the query.
const CAPABILITY_PATH = /\/media\/[cdu]\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i;

function isCapabilityUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return CAPABILITY_PATH.test(u.pathname) && u.searchParams.has('sig');
  } catch {
    return false;
  }
}

function attachmentUrl(attachment: any): string | null {
  const url = attachment?.url;
  if (typeof url === 'string') return url;
  const first = Array.isArray(url) ? url[0] : url;
  return typeof first?.href === 'string' ? first.href : null;
}

/**
 * Objects a federated Note uploaded: file parts of its Harmony content whose url is a media
 * capability URL of the sending instance. A file part with any other url (a picker GIF,
 * remote media) is a link, as message_upload_paths treats a part without path. A Note
 * without Harmony content counts every attachment.
 */
export function federatedUploadUrls(object: any): string[] {
  const parts = Array.isArray(object?.['harmony:rawContent'])
    ? object['harmony:rawContent']
    : Array.isArray(object?.content) ? object.content : null;
  if (parts) {
    return parts
      .filter((p: any) => p && typeof p === 'object' && p.type === 'file' && isCapabilityUrl(p.url))
      .map((p: any) => p.url as string);
  }
  const attachments = Array.isArray(object?.attachment) ? object.attachment : object?.attachment ? [object.attachment] : [];
  return attachments.map(attachmentUrl).filter((u: string | null): u is string => !!u);
}

/** URLs of the file parts of stored message content. */
export function storedFileUrls(content: unknown): Set<string> {
  const urls = new Set<string>();
  if (!Array.isArray(content)) return urls;
  for (const part of content) {
    if (part && typeof part === 'object' && part.type === 'file' && typeof part.url === 'string') urls.add(part.url);
  }
  return urls;
}

export interface ChannelWriteServer {
  id: string;
  is_local_server: boolean | null;
  ap_id: string | null;
  host_domain: string | null;
  federation_domain: string | null;
  suspended_at?: string | null;
}

/** Kinds that add a message; a suspended server refuses them, as its messages insert guard. */
const NEW_MESSAGE_KINDS: ReadonlySet<ChannelWriteKind> = new Set(['message', 'thread_message', 'thread_create']);

export type ChannelWriteDecision =
  | { ok: true; userId: string; server: ChannelWriteServer }
  | { ok: false; reason: string };

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Hosts authoritative for a remote server's local copy. */
export function remoteServerHosts(server: ChannelWriteServer): Set<string> {
  const hosts = new Set<string>();
  for (const h of [server.host_domain, server.federation_domain]) {
    if (h) hosts.add(h.toLowerCase());
  }
  const apHost = hostOf(server.ap_id);
  if (apHost) hosts.add(apHost);
  return hosts;
}

/** Every listed permission group holds; any error denies. */
export async function hasChannelPermissions(
  supabase: Supabase,
  userId: string,
  serverId: string,
  channelId: string,
  groups: string[][],
): Promise<boolean> {
  for (const group of groups) {
    let granted = false;
    for (const permission of group) {
      const { data, error } = await supabase.rpc('has_permission', {
        p_user_id: userId,
        p_server_id: serverId,
        p_permission: permission,
        p_channel_id: channelId,
      });
      if (error) return false;
      if (data === true) {
        granted = true;
        break;
      }
    }
    if (!granted) return false;
  }
  return true;
}

export async function authorizeChannelWrite(
  supabase: Supabase,
  target: {
    actorUrl: string;
    serverId: string;
    channelId: string;
    kind: ChannelWriteKind;
    /** Objects the write uploads that the row does not hold yet. */
    newUploads?: number;
    /** Group whose verified Announce carried the write; only a remote server's own Group passes. */
    relayedBy?: string;
  },
): Promise<ChannelWriteDecision> {
  const { actorUrl, serverId, channelId, kind } = target;
  if (!actorUrl || !serverId || !channelId) return { ok: false, reason: 'incomplete target' };

  const { data: server } = await supabase
    .from('servers')
    .select('id, is_local_server, ap_id, host_domain, federation_domain, suspended_at, federation_metadata')
    .eq('id', serverId)
    .maybeSingle();
  if (!server) return { ok: false, reason: 'unknown server' };
  if (server.suspended_at && NEW_MESSAGE_KINDS.has(kind)) return { ok: false, reason: 'server suspended' };
  if (server.is_local_server === false && await isServerBlockedHere(supabase, serverId)) {
    return { ok: false, reason: 'server is blocked on this instance' };
  }

  const { data: channel } = await supabase
    .from('channels')
    .select('id, server_id')
    .eq('id', channelId)
    .eq('server_id', serverId)
    .maybeSingle();
  if (!channel) return { ok: false, reason: 'channel is not in the server' };

  const { data: author } = await supabase
    .from('profiles')
    .select('id, is_suspended')
    .eq('federated_id', actorUrl)
    .maybeSingle();
  if (!author) return { ok: false, reason: 'unknown author' };
  if (author.is_suspended === true) return { ok: false, reason: 'suspended' };

  const isLocal = server.is_local_server !== false;
  if (target.relayedBy !== undefined) {
    if (isLocal || !server.ap_id || !sameUrl(target.relayedBy, server.ap_id)) {
      return { ok: false, reason: 'relayed by a Group that does not host the server' };
    }
  } else if (!isLocal) {
    const actorHost = hostOf(actorUrl);
    if (!actorHost || !remoteServerHosts(server as ChannelWriteServer).has(actorHost)) {
      return { ok: false, reason: 'signer is not on the server host' };
    }
  }

  const { data: membership, error: membershipError } = await supabase
    .from('user_servers')
    .select('status')
    .eq('server_id', serverId)
    .eq('user_id', author.id)
    .maybeSingle();
  if (membershipError) return { ok: false, reason: 'membership lookup failed' };
  if (membership?.status !== 'accepted') {
    // Only a write the host signed; a relay's standing is settled before it gets here.
    if (isLocal || membership || target.relayedBy !== undefined) {
      return { ok: false, reason: 'not an accepted member' };
    }
    const { relayedMemberStanding } = await import('./groupRelay.js');
    const standing = await relayedMemberStanding(supabase, server as RelayServer, author.id, actorUrl);
    if (standing !== 'member') return { ok: false, reason: standing === 'banned' ? 'banned' : 'not an accepted member' };
  }

  const { data: ban, error: banError } = await supabase
    .from('server_bans')
    .select('id')
    .eq('server_id', serverId)
    .eq('user_id', author.id)
    .maybeSingle();
  if (banError) return { ok: false, reason: 'ban lookup failed' };
  if (ban) return { ok: false, reason: 'banned' };

  // A timeout (moderator or AutoMod) blocks every channel write until it lapses.
  const { data: timeout, error: timeoutError } = await supabase
    .from('server_member_timeouts')
    .select('until')
    .eq('server_id', serverId)
    .eq('user_id', author.id)
    .gt('until', new Date().toISOString())
    .maybeSingle();
  if (timeoutError) return { ok: false, reason: 'timeout lookup failed' };
  if (timeout) return { ok: false, reason: 'timed out' };

  if (isLocal) {
    const groups = [['VIEW_CHANNEL'], ...KIND_PERMISSIONS[kind]];
    if (!(await hasChannelPermissions(supabase, author.id, serverId, channelId, groups))) {
      return { ok: false, reason: `missing permission for ${kind}` };
    }
    if ((target.newUploads ?? 0) > 0
      && !(await hasChannelPermissions(supabase, author.id, serverId, channelId, [['ATTACH_FILES']]))) {
      return { ok: false, reason: 'missing ATTACH_FILES for uploads' };
    }
  }

  return { ok: true, userId: author.id, server: server as ChannelWriteServer };
}

/**
 * Thread referenced by a message, restricted to `channelId`. A thread that
 * exists in another channel is `foreign`: the reference is dropped, and no stub
 * thread is created for it.
 */
export async function resolveThreadInChannel(
  supabase: Supabase,
  threadApId: string,
  channelId: string,
): Promise<{ status: 'found'; id: string } | { status: 'absent' } | { status: 'foreign' }> {
  const { data: byApId } = await supabase
    .from('threads')
    .select('id, channel_id')
    .eq('ap_id', threadApId)
    .maybeSingle();
  let thread = byApId;
  if (!thread) {
    const uuid = threadApId.match(/\/threads\/([a-f0-9-]{36})/i)?.[1];
    if (uuid) {
      const { data: byId } = await supabase
        .from('threads')
        .select('id, channel_id')
        .eq('id', uuid)
        .maybeSingle();
      thread = byId;
    }
  }
  if (!thread) return { status: 'absent' };
  return thread.channel_id === channelId ? { status: 'found', id: thread.id } : { status: 'foreign' };
}

/** Parent message for a reply, restricted to `channelId`: ap_id first, then the UUID in the URL. */
export async function resolveMessageInChannel(
  supabase: Supabase,
  ref: string,
  channelId: string,
): Promise<string | null> {
  const { data: byApId } = await supabase
    .from('messages')
    .select('id')
    .eq('metadata->>ap_id', ref)
    .eq('channel_id', channelId)
    .maybeSingle();
  if (byApId) return byApId.id;
  const uuid = ref.match(/\/messages\/([a-f0-9-]{36})/i)?.[1];
  if (!uuid) return null;
  const { data: byId } = await supabase
    .from('messages')
    .select('id')
    .eq('id', uuid)
    .eq('channel_id', channelId)
    .maybeSingle();
  return byId?.id ?? null;
}

/** A sender-supplied timestamp, never later than now. */
export function notAfterNow(value: unknown): string {
  const now = Date.now();
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t) && t <= now) return new Date(t).toISOString();
  }
  return new Date(now).toISOString();
}

/** The actor is an active participant of the conversation. */
export async function actorInConversation(
  supabase: Supabase,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .is('left_at', null)
    .maybeSingle();
  return !!data;
}

export function logDenied(what: string, actorUrl: string, reason: string): void {
  logger.warn(`Rejecting ${what} from ${actorUrl}: ${reason}`);
}
