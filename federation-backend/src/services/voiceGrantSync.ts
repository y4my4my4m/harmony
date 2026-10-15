/**
 * Connected voice participants brought in line with permission changes
 * (20261017100005_voice_moderation_followups.sql): voice_grant_resyncs names
 * who, voice_participant_grants decides, voiceGrants maps the decision.
 *
 *   syncVoiceGrants(deps, serverId)
 *     The server's pending rows give the scope: the server, channels or
 *     members. Participants in scope come from voice_channel_participants and,
 *     with deps.roomService, from the LiveKit rooms of the server's voice
 *     channels; their grants are read GRANT_BATCH pairs per call. A refused
 *     participant leaves: LiveKit removes it, voice_remove_member (reason
 *     revoked) drops its row and tells its client and, for a remote member,
 *     its instance. An admitted LiveKit participant whose permission or
 *     moderation metadata differs is updated; one that agrees costs no call.
 *     The rows read are deleted after; a failure leaves them for the sweep.
 *   syncStaleVoiceGrants(deps, olderThanMs)
 *     Every server with a row older than olderThanMs: notifications the worker
 *     never received.
 *
 * Cost, measured on a 2,000-member server with 30 roles, 50 voice channels
 * and 500 participants (PostgreSQL 15): one voice_participant_grants call
 * takes 1.5 ms per pair, 0.75 s for all 500; a change confined to a member or
 * a channel reads that scope alone. The triggers add about 1 ms to the
 * statement that changes a permission, whatever its row count.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ParticipantInfo, TrackSource } from 'livekit-server-sdk';
import { logger } from '../utils/logger.js';
import type { VoiceGrants } from './voiceAccess.js';
import { mergeVoiceMetadata, participantPermission, voiceMetadataFlags } from './voiceGrants.js';
import type { RoomAdmin } from './voiceModeration.js';
import { metadataProfileId } from './voiceParticipantReconciler.js';

/** Pairs per voice_participant_grants call: about 0.4 s of database time. */
export const GRANT_BATCH = 250;
/** Pending rows read per run; more wait for the next. */
const RESYNC_PAGE = 1000;

export interface VoiceGrantSyncDeps {
  supabase: SupabaseClient;
  /** Absent off LiveKit: only presence rows are checked. */
  roomService?: RoomAdmin | null;
}

export interface GrantSyncResult {
  checked: number;
  updated: number;
  removed: number;
}

interface Scope {
  server: boolean;
  channels: Set<string>;
  users: Set<string>;
}

interface Seat {
  channelId: string;
  profileId: string;
  room?: string;
  participant?: ParticipantInfo;
}

export interface GrantRow {
  channel_id: string;
  user_id: string;
  reason: string | null;
  can_speak: boolean;
  can_stream: boolean;
  can_soundboard: boolean;
  can_external_sounds: boolean;
  server_muted: boolean;
  server_deafened: boolean;
}

const ROOM = /^(?:channel|stage)-([0-9a-f-]{36})$/i;

export function grantsOf(row: GrantRow): VoiceGrants {
  return {
    canSpeak: row.can_speak === true,
    canStream: row.can_stream === true,
    canHear: row.server_deafened !== true,
    canSoundboard: row.can_soundboard === true,
    canExternalSounds: row.can_external_sounds === true,
    serverMuted: row.server_muted === true,
    serverDeafened: row.server_deafened === true,
  };
}

function inScope(scope: Scope, channelId: string, profileId: string): boolean {
  return scope.server || scope.channels.has(channelId) || scope.users.has(profileId);
}

function sameSources(a: readonly TrackSource[] | undefined, b: readonly TrackSource[] | undefined): boolean {
  const x = [...(a ?? [])].sort();
  const y = [...(b ?? [])].sort();
  return x.length === y.length && x.every((s, i) => s === y[i]);
}

/** The participant already holds this permission and these metadata flags. */
export function participantAgrees(participant: ParticipantInfo, grants: VoiceGrants, stage: boolean): boolean {
  const want = participantPermission(grants, stage, participant.permission);
  const have = participant.permission;
  if (!have) return false;
  if (have.canPublish !== want.canPublish || have.canSubscribe !== want.canSubscribe) return false;
  if (want.canPublish && !sameSources(have.canPublishSources, want.canPublishSources)) return false;
  let metadata: Record<string, unknown> = {};
  try {
    metadata = participant.metadata ? JSON.parse(participant.metadata) ?? {} : {};
  } catch {
    return false;
  }
  return Object.entries(voiceMetadataFlags(grants)).every(([key, value]) => metadata[key] === value);
}

async function liveKitSeats(
  deps: VoiceGrantSyncDeps,
  serverId: string,
  scope: Scope,
): Promise<Seat[]> {
  const roomService = deps.roomService;
  if (!roomService) return [];
  const { data: channels, error } = await deps.supabase
    .from('channels')
    .select('id')
    .eq('server_id', serverId)
    .eq('type', 1);
  if (error) throw new Error(`channel read failed: ${error.message}`);
  const ids = ((channels ?? []) as Array<{ id: string }>).map((c) => c.id)
    .filter((id) => scope.server || scope.users.size > 0 || scope.channels.has(id));
  if (ids.length === 0) return [];

  const rooms = await roomService.listRooms(ids.flatMap((id) => [`channel-${id}`, `stage-${id}`]));
  const raw: Array<{ room: string; channelId: string; participant: ParticipantInfo; profileId?: string }> = [];
  for (const room of rooms) {
    const channelId = room.name.match(ROOM)?.[1]?.toLowerCase();
    if (!channelId || room.numParticipants === 0) continue;
    for (const participant of await roomService.listParticipants(room.name)) {
      raw.push({ room: room.name, channelId, participant, profileId: metadataProfileId(participant.metadata) });
    }
  }

  // Remote tokens carry no profileId: federated:{federated_id}.
  const federatedIds = [...new Set(raw
    .filter((p) => !p.profileId && p.participant.identity.startsWith('federated:'))
    .map((p) => p.participant.identity.slice('federated:'.length)))];
  if (federatedIds.length > 0) {
    const { data, error: profileError } = await deps.supabase
      .from('profiles').select('id, federated_id').in('federated_id', federatedIds);
    if (profileError) throw new Error(`profile read failed: ${profileError.message}`);
    const byFederatedId = new Map(((data ?? []) as Array<{ id: string; federated_id: string }>)
      .map((p) => [p.federated_id, p.id]));
    for (const p of raw) {
      if (!p.profileId) p.profileId = byFederatedId.get(p.participant.identity.slice('federated:'.length));
    }
  }
  return raw
    .filter((p): p is typeof p & { profileId: string } => !!p.profileId && inScope(scope, p.channelId, p.profileId))
    .map((p) => ({ channelId: p.channelId, profileId: p.profileId, room: p.room, participant: p.participant }));
}

async function presenceSeats(deps: VoiceGrantSyncDeps, serverId: string, scope: Scope): Promise<Seat[]> {
  let query = deps.supabase
    .from('voice_channel_participants')
    .select('channel_id, user_id')
    .eq('server_id', serverId);
  if (!scope.server) {
    if (scope.channels.size > 0 && scope.users.size === 0) query = query.in('channel_id', [...scope.channels]);
    if (scope.users.size > 0 && scope.channels.size === 0) query = query.in('user_id', [...scope.users]);
  }
  const { data, error } = await query;
  if (error) throw new Error(`presence read failed: ${error.message}`);
  return ((data ?? []) as Array<{ channel_id: string; user_id: string }>)
    .filter((r) => inScope(scope, r.channel_id, r.user_id))
    .map((r) => ({ channelId: r.channel_id, profileId: r.user_id }));
}

async function readGrants(deps: VoiceGrantSyncDeps, pairs: Array<{ channelId: string; profileId: string }>): Promise<Map<string, GrantRow>> {
  const out = new Map<string, GrantRow>();
  for (let i = 0; i < pairs.length; i += GRANT_BATCH) {
    const batch = pairs.slice(i, i + GRANT_BATCH);
    const { data, error } = await deps.supabase.rpc('voice_participant_grants', {
      p_channels: batch.map((p) => p.channelId),
      p_users: batch.map((p) => p.profileId),
    });
    if (error) throw new Error(`voice grants read failed: ${error.message}`);
    for (const row of (data ?? []) as GrantRow[]) out.set(`${row.channel_id} ${row.user_id}`, row);
  }
  return out;
}

export async function syncVoiceGrants(deps: VoiceGrantSyncDeps, serverId: string): Promise<GrantSyncResult> {
  const result: GrantSyncResult = { checked: 0, updated: 0, removed: 0 };
  const { data: rows, error } = await deps.supabase
    .from('voice_grant_resyncs')
    .select('id, channel_id, user_id')
    .eq('server_id', serverId)
    .order('id', { ascending: true })
    .limit(RESYNC_PAGE);
  if (error) throw new Error(`resync read failed: ${error.message}`);
  const pending = (rows ?? []) as Array<{ id: number; channel_id: string | null; user_id: string | null }>;
  if (pending.length === 0) return result;

  const scope: Scope = { server: false, channels: new Set(), users: new Set() };
  for (const row of pending) {
    if (!row.channel_id && !row.user_id) scope.server = true;
    if (row.channel_id) scope.channels.add(row.channel_id);
    if (row.user_id) scope.users.add(row.user_id);
  }

  const seats = [...await presenceSeats(deps, serverId, scope), ...await liveKitSeats(deps, serverId, scope)];
  const pairs = [...new Map(seats.map((s) => [`${s.channelId} ${s.profileId}`, s])).values()];
  const grants = await readGrants(deps, pairs);

  const revoked = new Set<string>();
  for (const seat of seats) {
    const row = grants.get(`${seat.channelId} ${seat.profileId}`);
    if (!row) continue;
    result.checked += 1;
    if (!seat.participant) {
      if (row.reason && !revoked.has(seat.profileId)) {
        revoked.add(seat.profileId);
        const { error: removeError } = await deps.supabase.rpc('voice_remove_member', {
          p_server_id: serverId, p_user_id: seat.profileId, p_reason: 'revoked',
        });
        if (removeError) throw new Error(`voice_remove_member failed: ${removeError.message}`);
        logger.info(`Voice: ${seat.profileId} left ${seat.channelId}: ${row.reason}`);
      }
      continue;
    }
    const room = seat.room as string;
    const identity = seat.participant.identity;
    if (row.reason) {
      await deps.roomService!.removeParticipant(room, identity);
      result.removed += 1;
      continue;
    }
    const decision = grantsOf(row);
    const stage = room.startsWith('stage-');
    if (participantAgrees(seat.participant, decision, stage)) continue;
    await deps.roomService!.updateParticipant(room, identity, {
      metadata: mergeVoiceMetadata(seat.participant.metadata, decision),
      permission: participantPermission(decision, stage, seat.participant.permission),
    });
    result.updated += 1;
  }
  result.removed += revoked.size;

  const { error: deleteError } = await deps.supabase
    .from('voice_grant_resyncs')
    .delete()
    .in('id', pending.map((r) => r.id));
  if (deleteError) throw new Error(`resync delete failed: ${deleteError.message}`);
  return result;
}

export async function syncStaleVoiceGrants(deps: VoiceGrantSyncDeps, olderThanMs: number): Promise<GrantSyncResult> {
  const total: GrantSyncResult = { checked: 0, updated: 0, removed: 0 };
  const { data, error } = await deps.supabase
    .from('voice_grant_resyncs')
    .select('server_id')
    .lt('queued_at', new Date(Date.now() - olderThanMs).toISOString())
    .limit(RESYNC_PAGE);
  if (error) throw new Error(`resync read failed: ${error.message}`);
  for (const serverId of new Set(((data ?? []) as Array<{ server_id: string }>).map((r) => r.server_id))) {
    const one = await syncVoiceGrants(deps, serverId);
    total.checked += one.checked;
    total.updated += one.updated;
    total.removed += one.removed;
  }
  return total;
}
