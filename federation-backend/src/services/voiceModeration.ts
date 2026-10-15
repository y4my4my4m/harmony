/**
 * A member's LiveKit participants in a server's voice rooms, brought in line
 * with the database: authorizeVoiceChannel decides, voiceGrants maps the
 * decision to a LiveKit permission and metadata.
 *
 *   syncVoiceMember     every room of the server: a participant still admitted
 *                       gets the decision's permission and metadata (server mute,
 *                       server deafen, STREAM, soundboard); one no longer
 *                       admitted (kicked, banned, timed out, CONNECT revoked)
 *                       is removed.
 *   evictFromChannel    the rooms of one channel: the participant is removed.
 *   enforceVoiceRooms   every channel room: a participant who is no longer an
 *                       accepted member, is banned or timed out is removed; one
 *                       whose metadata disagrees with server_voice_moderation is
 *                       synced. Run by the worker's voice sweep, it covers
 *                       changes that reached the database without passing the
 *                       routes above (AutoMod timeouts, direct RPC calls).
 *                       Permission changes (SPEAK, STREAM, CONNECT, VIEW_CHANNEL)
 *                       are voiceGrantSync.ts's.
 *
 * Rooms are channel-{id} and stage-{id}. A participant is matched by the
 * identities its tokens carry (identitiesOf) or by metadata.profileId.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ParticipantInfo, RoomServiceClient } from 'livekit-server-sdk';
import { authorizeVoiceChannel } from './voiceAccess.js';
import { identitiesOf, metadataProfileId } from './voiceParticipantReconciler.js';
import { mergeVoiceMetadata, participantPermission } from './voiceGrants.js';

export type RoomAdmin = Pick<RoomServiceClient, 'listRooms' | 'listParticipants' | 'updateParticipant' | 'removeParticipant'>;

export interface VoiceModerationDeps {
  roomService: RoomAdmin;
  supabase: SupabaseClient;
  instanceDomain: string | undefined;
}

interface Seat {
  room: string;
  channelId: string;
  participant: ParticipantInfo;
}

interface MemberProfile {
  id: string;
  username: string | null;
  federated_id: string | null;
  is_local: boolean | null;
}

export interface SyncResult {
  updated: number;
  removed: number;
}

const ROOM = /^(?:channel|stage)-([0-9a-f-]{36})$/i;

async function memberProfile(supabase: SupabaseClient, profileId: string): Promise<MemberProfile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, federated_id, is_local')
    .eq('id', profileId)
    .maybeSingle();
  if (error) throw new Error(`profile read failed: ${error.message}`);
  return (data as MemberProfile | null) ?? null;
}

async function voiceChannelIds(supabase: SupabaseClient, serverId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('channels')
    .select('id')
    .eq('server_id', serverId)
    .eq('type', 1);
  if (error) throw new Error(`channel read failed: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map((c) => c.id);
}

/** The member's participants in the rooms of these channels. */
async function findSeats(
  deps: VoiceModerationDeps,
  profile: MemberProfile,
  channelIds: string[],
): Promise<Seat[]> {
  if (channelIds.length === 0) return [];
  const identities = identitiesOf(profile.id, profile, deps.instanceDomain);
  const names = channelIds.flatMap((id) => [`channel-${id}`, `stage-${id}`]);
  const rooms = await deps.roomService.listRooms(names);
  const seats: Seat[] = [];
  for (const room of rooms) {
    const channelId = room.name.match(ROOM)?.[1]?.toLowerCase();
    if (!channelId) continue;
    const participants = await deps.roomService.listParticipants(room.name);
    for (const participant of participants) {
      if (identities.has(participant.identity) || metadataProfileId(participant.metadata) === profile.id) {
        seats.push({ room: room.name, channelId, participant });
      }
    }
  }
  return seats;
}

export async function syncVoiceMember(
  deps: VoiceModerationDeps,
  serverId: string,
  profileId: string,
): Promise<SyncResult> {
  const result: SyncResult = { updated: 0, removed: 0 };
  const profile = await memberProfile(deps.supabase, profileId);
  if (!profile) return result;

  const seats = await findSeats(deps, profile, await voiceChannelIds(deps.supabase, serverId));
  for (const seat of seats) {
    const identity = seat.participant.identity;
    const decision = await authorizeVoiceChannel(deps.supabase, {
      profileId,
      channelId: seat.channelId,
      remote: profile.is_local === false,
    });
    if (!decision.ok) {
      await deps.roomService.removeParticipant(seat.room, identity);
      result.removed += 1;
      continue;
    }
    await deps.roomService.updateParticipant(seat.room, identity, {
      metadata: mergeVoiceMetadata(seat.participant.metadata, decision),
      permission: participantPermission(decision, seat.room.startsWith('stage-'), seat.participant.permission),
    });
    result.updated += 1;
  }
  return result;
}

export async function evictFromChannel(
  deps: VoiceModerationDeps,
  profileId: string,
  channelId: string,
): Promise<number> {
  const profile = await memberProfile(deps.supabase, profileId);
  if (!profile) return 0;
  const seats = await findSeats(deps, profile, [channelId]);
  for (const seat of seats) {
    await deps.roomService.removeParticipant(seat.room, seat.participant.identity);
  }
  return seats.length;
}

export interface EnforceResult {
  checked: number;
  updated: number;
  removed: number;
}

interface RoomParticipant {
  room: string;
  channelId: string;
  participant: ParticipantInfo;
  profileId?: string;
}

function metadataFlag(metadata: string | undefined, key: string): boolean {
  if (!metadata) return false;
  try {
    return JSON.parse(metadata)?.[key] === true;
  } catch {
    return false;
  }
}

export async function enforceVoiceRooms(deps: VoiceModerationDeps): Promise<EnforceResult> {
  const result: EnforceResult = { checked: 0, updated: 0, removed: 0 };
  const { supabase, roomService } = deps;

  const seated: RoomParticipant[] = [];
  for (const room of await roomService.listRooms()) {
    const channelId = room.name.match(ROOM)?.[1]?.toLowerCase();
    if (!channelId || room.numParticipants === 0) continue;
    for (const participant of await roomService.listParticipants(room.name)) {
      seated.push({ room: room.name, channelId, participant, profileId: metadataProfileId(participant.metadata) });
    }
  }
  if (seated.length === 0) return result;

  // Remote tokens carry no profileId: federated:{federated_id}.
  const federatedIds = [...new Set(seated
    .filter((p) => !p.profileId && p.participant.identity.startsWith('federated:'))
    .map((p) => p.participant.identity.slice('federated:'.length)))];
  if (federatedIds.length > 0) {
    const { data, error } = await supabase.from('profiles').select('id, federated_id').in('federated_id', federatedIds);
    if (error) throw new Error(`profile read failed: ${error.message}`);
    const byFederatedId = new Map(((data ?? []) as Array<{ id: string; federated_id: string }>).map((p) => [p.federated_id, p.id]));
    for (const p of seated) {
      if (!p.profileId) p.profileId = byFederatedId.get(p.participant.identity.slice('federated:'.length));
    }
  }

  const channelIds = [...new Set(seated.map((p) => p.channelId))];
  const { data: channelRows, error: channelError } = await supabase
    .from('channels').select('id, server_id').in('id', channelIds);
  if (channelError) throw new Error(`channel read failed: ${channelError.message}`);
  const serverOf = new Map(((channelRows ?? []) as Array<{ id: string; server_id: string }>).map((c) => [c.id, c.server_id]));

  const byServer = new Map<string, RoomParticipant[]>();
  for (const p of seated) {
    const serverId = serverOf.get(p.channelId);
    if (!serverId || !p.profileId) continue;
    const list = byServer.get(serverId) ?? [];
    list.push(p);
    byServer.set(serverId, list);
  }

  const now = new Date().toISOString();
  for (const [serverId, participants] of byServer) {
    const ids = [...new Set(participants.map((p) => p.profileId as string))];
    const [server, members, bans, timeouts, moderation] = await Promise.all([
      supabase.from('servers').select('owner').eq('id', serverId).maybeSingle(),
      supabase.from('user_servers').select('user_id, status').eq('server_id', serverId).in('user_id', ids),
      supabase.from('server_bans').select('user_id').eq('server_id', serverId).in('user_id', ids),
      supabase.from('server_member_timeouts').select('user_id').eq('server_id', serverId).in('user_id', ids).gt('until', now),
      supabase.from('server_voice_moderation').select('user_id, muted, deafened').eq('server_id', serverId).in('user_id', ids),
    ]);
    const failed = [server, members, bans, timeouts, moderation].find((r) => r.error);
    if (failed) throw new Error(`voice enforcement read failed for ${serverId}: ${failed.error!.message}`);

    const owner = (server.data as { owner?: string } | null)?.owner;
    const accepted = new Set(((members.data ?? []) as Array<{ user_id: string; status: string }>)
      .filter((m) => m.status === 'accepted').map((m) => m.user_id));
    const barred = new Set([
      ...((bans.data ?? []) as Array<{ user_id: string }>).map((b) => b.user_id),
      ...((timeouts.data ?? []) as Array<{ user_id: string }>).map((t) => t.user_id),
    ]);
    const flags = new Map(((moderation.data ?? []) as Array<{ user_id: string; muted: boolean; deafened: boolean }>)
      .map((m) => [m.user_id, m]));

    for (const p of participants) {
      const profileId = p.profileId as string;
      result.checked += 1;
      if (profileId !== owner && (!accepted.has(profileId) || barred.has(profileId))) {
        await roomService.removeParticipant(p.room, p.participant.identity);
        result.removed += 1;
        continue;
      }
      const row = flags.get(profileId);
      if (metadataFlag(p.participant.metadata, 'serverMuted') === (row?.muted === true)
          && metadataFlag(p.participant.metadata, 'serverDeafened') === (row?.deafened === true)) {
        continue;
      }
      const decision = await authorizeVoiceChannel(supabase, {
        profileId,
        channelId: p.channelId,
        remote: p.participant.identity.startsWith('federated:') && !metadataProfileId(p.participant.metadata),
      });
      if (!decision.ok) {
        await roomService.removeParticipant(p.room, p.participant.identity);
        result.removed += 1;
        continue;
      }
      await roomService.updateParticipant(p.room, p.participant.identity, {
        metadata: mergeVoiceMetadata(p.participant.metadata, decision),
        permission: participantPermission(decision, p.room.startsWith('stage-'), p.participant.permission),
      });
      result.updated += 1;
    }
  }
  return result;
}
