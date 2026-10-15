/**
 * Voice moderation of a remote member, from the server's Group to the member's instance
 * (20261017100005_voice_moderation_followups.sql queues the jobs).
 *
 *   harmony:VoiceMemberMove        origin: channel left, target: channel to join
 *   harmony:VoiceMemberDisconnect  origin: channel left, harmony:reason
 *   harmony:VoiceMemberState       harmony:serverMuted, harmony:serverDeafened
 *
 * Each has actor: the Group (https://<host>/servers/<id>), object and to: the member's actor,
 * channels as the Group names them (<Group>/channels/<id>). Signed with the Group's key and
 * delivered to the member instance's copy of the server, <origin>/servers/<id>/inbox, as Group
 * relays are (groupRelay.ts). A move or disconnect is delivered once and retried by the job:
 * the move grant it relies on lasts 120 s. A state change is queued for retry.
 *
 * Receiver: accepted from the Group of a server copied here (servers.ap_id, exact; the HTTP
 * signature's key is the Group's), for a profile of this instance that is an accepted member
 * of the copy, naming channels of that copy. The member's client hears of it on user:<member>
 * as the host's own events: voice:moved {server_id, from_channel_id, channel_id, reason} and,
 * through apply_group_voice_state, voice:moderation; the copy's rosters read the state through
 * get_server_voice_moderation and the voice-moderation broadcast. The moved client fetches its
 * token from the host as for any join; the host admits it by the move grant.
 */

import { randomUUID } from 'crypto';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { sameUrl, urlHost } from '../utils/apOrigin.js';
import { DeliveryQueue } from './DeliveryQueue.js';
import { instanceSoftware } from './instanceSoftware.js';
import { logDenied } from './channelWriteAuthz.js';

type Supabase = ReturnType<typeof getSupabaseClient>;

const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';
const HARMONY_VOICE_CONTEXT = 'https://harmony.social/ns/voice';

export const VOICE_MEMBER_TYPES = {
  Move: 'harmony:VoiceMemberMove',
  Disconnect: 'harmony:VoiceMemberDisconnect',
  State: 'harmony:VoiceMemberState',
} as const;

const TYPES = new Set<string>(Object.values(VOICE_MEMBER_TYPES));

export const DEPARTURE_REASONS = ['moved', 'disconnected', 'removed', 'timed_out', 'revoked'] as const;
export type DepartureReason = (typeof DEPARTURE_REASONS)[number];

export function isVoiceMemberActivity(activity: any): boolean {
  return typeof activity?.type === 'string' && TYPES.has(activity.type);
}

/** A federate-voice-moderation job, as voice_remove_member and voice_moderation_federate queue it. */
export interface VoiceModerationJob {
  kind: 'move' | 'disconnect' | 'state';
  server_id: string;
  user_id: string;
  from_channel_id?: string | null;
  channel_id?: string | null;
  reason?: string | null;
  muted?: boolean;
  deafened?: boolean;
}

function groupUrl(serverId: string): string {
  return `https://${config.INSTANCE_DOMAIN}/servers/${serverId}`;
}

function channelUrl(serverId: string, channelId: string): string {
  return `${groupUrl(serverId)}/channels/${channelId}`;
}

function reasonOf(value: unknown, fallback: DepartureReason): DepartureReason {
  return (DEPARTURE_REASONS as readonly string[]).includes(value as string) ? value as DepartureReason : fallback;
}

/** The activity a job sends to `memberActor`. */
export function voiceMemberActivity(job: VoiceModerationJob, memberActor: string): Record<string, unknown> {
  const group = groupUrl(job.server_id);
  const base: Record<string, unknown> = {
    '@context': [AS_CONTEXT, HARMONY_VOICE_CONTEXT],
    id: `${group}/voice-moderation/${randomUUID()}`,
    actor: group,
    to: [memberActor],
    object: memberActor,
    published: new Date().toISOString(),
  };
  const origin = job.from_channel_id ? { origin: channelUrl(job.server_id, job.from_channel_id) } : {};
  if (job.kind === 'state') {
    return {
      ...base,
      type: VOICE_MEMBER_TYPES.State,
      'harmony:serverMuted': job.muted === true,
      'harmony:serverDeafened': job.deafened === true,
    };
  }
  if (job.kind === 'move' && job.channel_id) {
    return {
      ...base,
      type: VOICE_MEMBER_TYPES.Move,
      ...origin,
      target: channelUrl(job.server_id, job.channel_id),
      'harmony:reason': 'moved',
    };
  }
  return {
    ...base,
    type: VOICE_MEMBER_TYPES.Disconnect,
    ...origin,
    'harmony:reason': reasonOf(job.reason, 'disconnected'),
  };
}

/** The inbox of the copy of server `serverId` on the instance of a member with these URLs. */
export function memberCopyInbox(
  member: { federated_id: string | null; shared_inbox_url?: string | null; inbox_url?: string | null },
  serverId: string,
): string | null {
  for (const url of [member.shared_inbox_url, member.inbox_url, member.federated_id]) {
    if (!url || !urlHost(url)) continue;
    if (member.federated_id && urlHost(url) !== urlHost(member.federated_id)) continue;
    return `${new URL(url).origin}/servers/${serverId}/inbox`;
  }
  return null;
}

// HOST

/**
 * Job handler: the activity for a remote member of a local server, from its Group. A move or
 * disconnect that fails with a retryable answer throws, for the job's retry.
 */
export async function handleVoiceModerationFederationJob(data: VoiceModerationJob & Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseClient();
  const [{ data: server }, { data: member }] = await Promise.all([
    supabase.from('servers').select('id, is_local_server, federation_enabled').eq('id', data.server_id).maybeSingle(),
    supabase.from('profiles').select('id, is_local, federated_id, inbox_url, shared_inbox_url')
      .eq('id', data.user_id).maybeSingle(),
  ]);
  if (!server || server.is_local_server === false || server.federation_enabled !== true) {
    logger.info(`Voice moderation of ${data.user_id} not federated: server ${data.server_id} does not federate`);
    return;
  }
  if (!member || member.is_local !== false || !member.federated_id) {
    logger.info(`Voice moderation of ${data.user_id} not federated: not a remote member`);
    return;
  }
  const inbox = memberCopyInbox(member, server.id);
  const host = urlHost(inbox);
  if (!inbox || !host) {
    logger.warn(`Voice moderation of ${member.federated_id} not federated: no inbox`);
    return;
  }
  const software = await instanceSoftware(host);
  if (software && software !== 'harmony') {
    logger.info(`Voice moderation of ${member.federated_id} not sent: ${host} runs ${software}`);
    return;
  }

  const activity = voiceMemberActivity(data, member.federated_id);
  if (data.kind === 'state') {
    await DeliveryQueue.enqueue(activity, inbox, { serverId: server.id });
    return;
  }
  const result = await DeliveryQueue.deliverOnce(activity, inbox, { serverId: server.id });
  if (!result.delivered && result.retry) {
    throw new Error(`${activity.type} for ${member.federated_id} not delivered to ${inbox}`);
  }
}

// RECEIVER

/** A remote server's copy, as the receiver reads it. */
export interface VoiceMemberServer {
  id: string;
  ap_id: string | null;
  is_local_server: boolean | null;
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as any).id === 'string') return (value as any).id;
  return null;
}

/** The local profile an actor URL of this instance names. */
async function localProfile(supabase: Supabase, actorUrl: string): Promise<{ id: string } | null> {
  const { data: byId } = await supabase
    .from('profiles')
    .select('id, is_local')
    .eq('federated_id', actorUrl)
    .maybeSingle();
  if (byId) return byId.is_local === true ? { id: byId.id } : null;
  const own = `https://${config.INSTANCE_DOMAIN}/users/`;
  if (!actorUrl.toLowerCase().startsWith(own.toLowerCase())) return null;
  const username = actorUrl.slice(own.length);
  if (!/^[A-Za-z0-9_]+$/.test(username)) return null;
  const { data: byName } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', username)
    .eq('is_local', true)
    .maybeSingle();
  return byName ? { id: byName.id } : null;
}

/** The voice channel of copy `server` the Group's URL names; null for any other. */
async function copyVoiceChannel(supabase: Supabase, server: VoiceMemberServer, ref: unknown): Promise<string | null> {
  const url = idOf(ref);
  if (!url || !server.ap_id || !url.startsWith(`${server.ap_id}/channels/`)) return null;
  const { data: byApId } = await supabase
    .from('channels')
    .select('id, type')
    .eq('server_id', server.id)
    .eq('ap_id', url)
    .maybeSingle();
  let channel = byApId;
  if (!channel) {
    const uuid = url.slice(`${server.ap_id}/channels/`.length);
    if (!/^[0-9a-f-]{36}$/i.test(uuid)) return null;
    const { data: byId } = await supabase
      .from('channels')
      .select('id, type')
      .eq('server_id', server.id)
      .eq('id', uuid.toLowerCase())
      .maybeSingle();
    channel = byId;
  }
  return channel && Number(channel.type) === 1 ? channel.id : null;
}

/**
 * Applies a voice member activity of the Group of copy `server`; the caller has matched the
 * HTTP signature's key to that Group. Null when applied, else why it was refused.
 */
export async function processVoiceMemberActivity(server: VoiceMemberServer, activity: any): Promise<string | null> {
  const group = server.ap_id ?? `server ${server.id}`;
  const refuse = (reason: string) => {
    logDenied(activity?.type ?? 'voice member activity', group, reason);
    return reason;
  };
  if (server.is_local_server !== false || !server.ap_id) return refuse('not a remote server\'s copy');
  if (!isVoiceMemberActivity(activity)) return refuse('not a voice member activity');
  if (!sameUrl(idOf(activity.actor), server.ap_id)) return refuse(`actor ${idOf(activity.actor)} is not the Group`);

  const memberUrl = idOf(activity.object);
  if (!memberUrl || urlHost(memberUrl) !== config.INSTANCE_DOMAIN.toLowerCase()) {
    return refuse(`${memberUrl} is not on this instance`);
  }
  const supabase = getSupabaseClient();
  const profile = await localProfile(supabase, memberUrl);
  if (!profile) return refuse(`${memberUrl} is no local profile`);
  const { data: membership } = await supabase
    .from('user_servers')
    .select('status')
    .eq('server_id', server.id)
    .eq('user_id', profile.id)
    .maybeSingle();
  if (membership?.status !== 'accepted') return refuse(`${memberUrl} is not a member of the copy`);

  if (activity.type === VOICE_MEMBER_TYPES.State) {
    const { error } = await supabase.rpc('apply_group_voice_state', {
      p_server_id: server.id,
      p_user_id: profile.id,
      p_muted: activity['harmony:serverMuted'] === true,
      p_deafened: activity['harmony:serverDeafened'] === true,
    });
    if (error) throw new Error(`voice state of ${profile.id} in ${server.id} not stored: ${error.message}`);
    return null;
  }

  const from = activity.origin === undefined ? null : await copyVoiceChannel(supabase, server, activity.origin);
  if (activity.origin !== undefined && !from) return refuse(`origin ${idOf(activity.origin)} is no voice channel of the copy`);
  let to: string | null = null;
  if (activity.type === VOICE_MEMBER_TYPES.Move) {
    to = await copyVoiceChannel(supabase, server, activity.target);
    if (!to) return refuse(`target ${idOf(activity.target)} is no voice channel of the copy`);
  }
  const { error } = await supabase.rpc('broadcast_user_event', {
    p_user_id: profile.id,
    p_payload: {
      type: 'voice:moved',
      server_id: server.id,
      from_channel_id: from,
      channel_id: to,
      reason: to ? 'moved' : reasonOf(activity['harmony:reason'], 'disconnected'),
    },
  });
  if (error) throw new Error(`voice move of ${profile.id} not delivered: ${error.message}`);
  return null;
}

/** The copy whose Group is `actorUrl`, for an activity on the shared inbox. */
export async function copyOfGroup(actorUrl: unknown): Promise<VoiceMemberServer | null> {
  const url = idOf(actorUrl);
  if (!url) return null;
  const { data } = await getSupabaseClient()
    .from('servers')
    .select('id, ap_id, is_local_server')
    .eq('ap_id', url)
    .eq('is_local_server', false)
    .maybeSingle();
  return data ?? null;
}
