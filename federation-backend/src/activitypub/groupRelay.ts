/**
 * Group relay, as FEP-1b12: what a member on one instance does in a channel reaches the
 * members on other instances as the Group's Announce of it.
 *
 * Host. An activity the server inbox accepted from a member (Create, Update and Delete of a
 * channel message, a reaction, the Undo of a reaction) is wrapped unchanged,
 *
 *   Announce { actor: <Group>, object: <activity>, to: <that instance's readers> }
 *
 * signed with the Group's key (ServerActor.ts), and delivered to every instance with readers
 * of the channel (federation_channel_recipients) except the sender's, at that instance's copy
 * of the server: <instance origin>/servers/<id>/inbox. Only Harmony keeps a copy: an instance
 * known to run other software is skipped. Harmony before 1.8.4 takes nothing on a copy's
 * inbox.
 *
 * Receiver. An Announce whose object is an embedded activity of RELAYED_TYPES is a relay of
 * the remote server whose Group is its actor (servers.ap_id, exact). The HTTP signature's key
 * must be the Group's. The Group vouches for what its host authorized; channel permissions,
 * which a copy holds incompletely, are not checked again. Still required:
 *   - the inner actor is not the Group, not on this instance, not on a blocked instance, and
 *     not suspended here;
 *   - the inner actor is a member: an accepted row of the copy, or an entry of the Group's
 *     members collection, read signed as a local member and then recorded in the copy. A ban
 *     on the copy refuses;
 *   - the target is in that server: a Note names it by harmony:serverId and a channel under
 *     the Group's id; an edit, delete, reaction or Undo names a message stored in one of the
 *     copy's channels;
 *   - a Note is on its author's host, and an edit or Undo is by the author of what it
 *     changes. A delete is the Group's to vouch for: moderators delete others' messages.
 * The inner object is not fetched from its origin: an instance serves a channel message only
 * under its host's read rules, which it cannot apply to a server it does not host.
 */

import { createHash, randomUUID } from 'crypto';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { sameOrigin, sameUrl, urlHost } from '../utils/apOrigin.js';
import { getChannelRecipientGroups, type RemoteMemberGroup } from '../utils/federationUtils.js';
import { DeliveryQueue } from './DeliveryQueue.js';
import { instanceSoftware } from './instanceSoftware.js';
import { SignatureService } from './SignatureService.js';

type Supabase = ReturnType<typeof getSupabaseClient>;

const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';

export const REACTION_TYPES = new Set(['Like', 'EmojiReact', 'EmojiReaction']);
export const RELAYED_TYPES = new Set(['Create', 'Update', 'Delete', 'Undo', ...REACTION_TYPES]);

/** A remote server's copy, as the receiver reads it. */
export interface RelayServer {
  id: string;
  ap_id: string | null;
  is_local_server: boolean | null;
  federation_metadata?: any;
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as any).id === 'string') return (value as any).id;
  return null;
}

/** The embedded activity an Announce relays; null for an Announce of anything else. */
export function relayedActivity(announce: any): any | null {
  if (announce?.type !== 'Announce') return null;
  const inner = announce.object;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null;
  return RELAYED_TYPES.has(inner.type) ? inner : null;
}

/**
 * Why the relay of `server`'s Group is refused, from the documents alone; null when it
 * passes. `ownHost` is this instance's host.
 */
export function relayRefusal(server: RelayServer, announce: any, ownHost: string): string | null {
  const group = server.ap_id;
  if (server.is_local_server !== false || typeof group !== 'string') return 'not a remote server';
  const actor = idOf(announce?.actor);
  if (!actor || !sameUrl(actor, group)) return `actor ${actor} is not the Group ${group}`;
  const inner = relayedActivity(announce);
  if (!inner) return 'not a relayed activity';

  const innerActor = idOf(inner.actor);
  const innerHost = urlHost(innerActor);
  if (!innerActor || !innerHost) return 'inner activity has no actor';
  if (sameUrl(innerActor, group)) return 'the Group relays no activity of its own';
  if (innerHost === ownHost.toLowerCase()) return 'inner actor is on this instance';

  const object = inner.object;
  switch (inner.type) {
    case 'Create':
    case 'Update': {
      if (!object || typeof object !== 'object' || object.type !== 'Note') return `${inner.type} of no Note`;
      if (object['harmony:serverId'] !== server.id) return 'Note names another server';
      if (inner.type === 'Create'
          && (typeof object.context !== 'string' || !object.context.startsWith(`${group}/channels/`))) {
        return 'Note is not in a channel of the Group';
      }
      if (!sameOrigin(object.id, innerActor)) return 'Note is not on its author\'s host';
      const author = idOf(object.attributedTo);
      if (author && !sameUrl(author, innerActor)) return 'Note is attributed to another actor';
      return null;
    }
    case 'Undo': {
      if (!object || typeof object !== 'object' || !REACTION_TYPES.has(object.type)) return 'Undo of no reaction';
      const undone = idOf(object.actor);
      if (!undone || !sameUrl(undone, innerActor)) return 'Undo of another actor\'s reaction';
      return idOf(object.object) ? null : 'Undo names no message';
    }
    default:
      return idOf(object) ? null : `${inner.type} names no object`;
  }
}

/** Object id an inner activity targets: the message of an edit, delete, reaction or Undo. */
export function relayTarget(inner: any): string | null {
  if (inner?.type === 'Undo') return idOf(inner.object?.object);
  return idOf(inner?.object);
}

/**
 * The channel message `ref` names, when it is in a channel of `serverId`: by ap_id, else by
 * id for this instance's own /messages/<uuid> URL.
 */
export async function messageInServer(
  supabase: Supabase,
  serverId: string,
  ref: string,
  ownHost: string,
): Promise<{ id: string; channel_id: string; user_id: string } | null> {
  const { data: byApId } = await supabase
    .from('messages')
    .select('id, channel_id, user_id')
    .eq('metadata->>ap_id', ref)
    .maybeSingle();
  let message = byApId;
  if (!message) {
    const own = new RegExp(`^https://${ownHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/messages/([0-9a-f-]{36})$`, 'i');
    const uuid = own.exec(ref)?.[1];
    if (uuid) {
      const { data: byId } = await supabase
        .from('messages')
        .select('id, channel_id, user_id')
        .eq('id', uuid)
        .maybeSingle();
      message = byId;
    }
  }
  if (!message?.channel_id) return null;
  const { data: channel } = await supabase
    .from('channels')
    .select('id')
    .eq('id', message.channel_id)
    .eq('server_id', serverId)
    .maybeSingle();
  return channel ? message : null;
}

// Groups that did not list an actor: `${serverId} ${actorUrl}` -> expiry. A refused relay
// does not read the collection again for NEGATIVE_TTL_MS.
const NEGATIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_MAX = 1_000;
const notListed = new Map<string, number>();

export function __resetRelayMembershipCache(): void {
  notListed.clear();
}

/** 1,000 members at GroupService's 50 a page. */
const MAX_MEMBER_PAGES = 20;

/** The Group's members collection lists `actorUrl`; read signed as a local member. */
async function groupListsMember(server: RelayServer, actorUrl: string): Promise<boolean> {
  const group = server.ap_id as string;
  const advertised = server.federation_metadata?.members;
  const membersUrl = typeof advertised === 'string' && sameOrigin(advertised, group) ? advertised : `${group}/members`;

  const { ServerDiscoveryService } = await import('../services/ServerDiscoveryService.js');
  const signAs = await ServerDiscoveryService.pickSigningMember(server.id);

  for (let page = 1; page <= MAX_MEMBER_PAGES; page++) {
    let body: any;
    try {
      const response = await SignatureService.signedApFetch(`${membersUrl}?page=${page}`, {
        headers: { Accept: 'application/activity+json' },
        timeoutMs: 10_000,
        ...(signAs ? { signAs } : {}),
      });
      if (!response.ok) {
        logger.warn(`Members of ${group} not read: ${response.status}`);
        return false;
      }
      body = await response.json();
    } catch (err) {
      logger.warn(`Members of ${group} not read: ${(err as Error)?.message ?? err}`);
      return false;
    }
    const items: unknown[] = Array.isArray(body?.orderedItems) ? body.orderedItems : Array.isArray(body?.items) ? body.items : [];
    if (items.some((item) => sameUrl(idOf(item), actorUrl))) return true;
    if (items.length === 0 || !body?.next) return false;
  }
  return false;
}

/**
 * Standing of a relayed activity's actor in the copy of `server`. An actor the copy does not
 * hold is looked up in the Group's members collection and, when listed, recorded as an
 * accepted member.
 */
export async function relayedMemberStanding(
  supabase: Supabase,
  server: RelayServer,
  profileId: string,
  actorUrl: string,
): Promise<'member' | 'banned' | 'not a member'> {
  const [{ data: ban, error: banError }, { data: row }] = await Promise.all([
    supabase.from('server_bans').select('id').eq('server_id', server.id).eq('user_id', profileId).maybeSingle(),
    supabase.from('user_servers').select('status').eq('server_id', server.id).eq('user_id', profileId).maybeSingle(),
  ]);
  if (banError || ban || row?.status === 'banned') return 'banned';
  if (row?.status === 'accepted') return 'member';

  const key = `${server.id} ${actorUrl}`;
  const until = notListed.get(key);
  if (until !== undefined && until > Date.now()) return 'not a member';

  if (!(await groupListsMember(server, actorUrl))) {
    if (notListed.size >= NEGATIVE_MAX) {
      const oldest = notListed.keys().next().value;
      if (oldest !== undefined) notListed.delete(oldest);
    }
    notListed.set(key, Date.now() + NEGATIVE_TTL_MS);
    return 'not a member';
  }
  notListed.delete(key);

  const { error } = await supabase
    .from('user_servers')
    .upsert(
      { server_id: server.id, user_id: profileId, status: 'accepted', member_instance: urlHost(actorUrl) },
      { onConflict: 'server_id,user_id', ignoreDuplicates: true },
    );
  if (error) logger.warn(`Member ${actorUrl} of ${server.ap_id} not recorded: ${error.message}`);
  return 'member';
}

// HOST

/**
 * The Group's Announce of `inner`. The id is derived from the inner activity's, so a
 * redelivered relay is the same activity to its receiver.
 */
export function groupAnnounce(serverId: string, inner: any, to: string[]): Record<string, unknown> {
  const group = `https://${config.INSTANCE_DOMAIN}/servers/${serverId}`;
  const innerId = idOf(inner);
  const suffix = innerId ? createHash('sha256').update(innerId).digest('hex').slice(0, 32) : randomUUID();
  return {
    '@context': AS_CONTEXT,
    id: `${group}/relays/${suffix}`,
    type: 'Announce',
    actor: group,
    object: inner,
    to,
    cc: [`${group}/members`],
    published: new Date().toISOString(),
  };
}

/** Inbox of an instance's copy of the server, on the origin of its shared inbox. */
export function copyInboxUrl(group: RemoteMemberGroup, serverId: string): string | null {
  let origin: string | null = null;
  try {
    if (group.shared_inbox) origin = new URL(group.shared_inbox).origin;
  } catch {
    origin = null;
  }
  if (!origin && group.instance) origin = `https://${group.instance}`;
  return origin ? `${origin}/servers/${serverId}/inbox` : null;
}

/**
 * Relays an activity accepted on the inbox of local server `serverId` to the other instances
 * whose members may view the channel.
 */
export async function relayToChannelReaders(
  serverId: string,
  channelId: string,
  activity: any,
  senderUrl: string,
  label: string,
): Promise<void> {
  const senderHost = urlHost(senderUrl);
  if (!senderHost) return;

  for (const group of await getChannelRecipientGroups(channelId)) {
    const inbox = copyInboxUrl(group, serverId);
    const host = urlHost(inbox);
    if (!inbox || !host || host === senderHost || group.instance === senderHost) continue;

    const software = await instanceSoftware(host);
    if (software && software !== 'harmony') {
      logger.info(`Not relaying ${label} to ${group.instance}: it runs ${software}`);
      continue;
    }
    try {
      await DeliveryQueue.enqueue(groupAnnounce(serverId, activity, group.member_ap_ids), inbox, { serverId });
      logger.info(`Relayed ${label} to ${group.instance} (${group.member_count} members)`);
    } catch (error) {
      logger.error(`Failed to relay ${label} to ${group.instance}:`, error);
    }
  }
}
