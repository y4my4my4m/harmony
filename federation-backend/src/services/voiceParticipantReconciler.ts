/**
 * voice_channel_participants against LiveKit.
 *
 * A row says a profile is in a voice channel; LiveKit says who is connected to
 * the channel's room (`channel-{id}`, or `stage-{id}`). A row older than the
 * grace period whose profile has no participant in either room is removed
 * through public.remove_voice_participant, which also broadcasts user-left.
 *
 * Any failure to read LiveKit or the database ends the run with nothing
 * removed. Rows with metadata.transport = 'p2p' are skipped: a client on the
 * P2P fallback is never in a LiveKit room.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { RoomServiceClient } from 'livekit-server-sdk';
import { logger } from '../utils/logger.js';
import { liveKitIdentity } from './voiceAccess.js';

/** The client writes its row before it connects to LiveKit. */
export const JOIN_GRACE_MS = 120_000;

export type RoomLister = Pick<RoomServiceClient, 'listRooms' | 'listParticipants'>;

/** A participant a LiveKit webhook reported gone, at LiveKit's clock. */
export interface Departure {
  identity: string;
  profileId?: string;
  at: Date;
}

export interface ReconcileOptions {
  roomService: RoomLister;
  supabase: SupabaseClient;
  instanceDomain: string | undefined;
  now?: Date;
  graceMs?: number;
  /** Only these channels; every channel with a row when absent. */
  channelIds?: string[];
  departure?: Departure;
}

export type ReconcileResult =
  | { ok: true; checked: number; removed: number }
  | { ok: false; reason: string };

interface Row {
  channel_id: string;
  user_id: string;
  joined_at: string;
  metadata: Record<string, unknown> | null;
}

interface ProfileRow {
  id: string;
  username: string | null;
  federated_id: string | null;
}

interface Present {
  identities: Set<string>;
  profileIds: Set<string>;
}

/** profileId from a local token's metadata (LiveKitService.generateToken). */
export function metadataProfileId(metadata: string | undefined): string | undefined {
  if (!metadata) return undefined;
  try {
    const value = JSON.parse(metadata)?.profileId;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Identities a token for this profile carries: the bare profile id and the
 * federated form. A username changed since the token was issued is caught by
 * the metadata profileId instead.
 */
export function identitiesOf(
  userId: string,
  profile: ProfileRow | undefined,
  instanceDomain: string | undefined,
): Set<string> {
  const ids = new Set<string>([userId]);
  if (profile) ids.add(liveKitIdentity(profile, instanceDomain));
  return ids;
}

function roomNamesOf(channelId: string): string[] {
  return [`channel-${channelId}`, `stage-${channelId}`];
}

export async function reconcileVoiceParticipants(opts: ReconcileOptions): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.graceMs ?? JOIN_GRACE_MS));
  const { supabase, roomService } = opts;

  // A departed participant's row is judged against the departure time, not the grace.
  const latestCutoff = opts.departure && opts.departure.at > cutoff ? opts.departure.at : cutoff;

  let query = supabase
    .from('voice_channel_participants')
    .select('channel_id, user_id, joined_at, metadata')
    .lt('joined_at', latestCutoff.toISOString());
  if (opts.channelIds) {
    if (opts.channelIds.length === 0) return { ok: true, checked: 0, removed: 0 };
    query = query.in('channel_id', opts.channelIds);
  }
  const { data: rowData, error: rowError } = await query;
  if (rowError) return { ok: false, reason: `participant read failed: ${rowError.message}` };

  const rows = ((rowData ?? []) as Row[]).filter((row) => row.metadata?.transport !== 'p2p');
  if (rows.length === 0) return { ok: true, checked: 0, removed: 0 };

  const userIds = [...new Set(rows.map((row) => row.user_id))];
  const { data: profileData, error: profileError } = await supabase
    .from('profiles')
    .select('id, username, federated_id')
    .in('id', userIds);
  if (profileError) return { ok: false, reason: `profile read failed: ${profileError.message}` };
  const profiles = new Map(((profileData ?? []) as ProfileRow[]).map((p) => [p.id, p]));

  const channelIds = [...new Set(rows.map((row) => row.channel_id))];
  const present = new Map<string, Present>();
  try {
    const wanted = channelIds.flatMap(roomNamesOf);
    const rooms = await roomService.listRooms(wanted);
    for (const room of rooms) {
      const channelId = channelIds.find((id) => roomNamesOf(id).includes(room.name));
      if (!channelId) continue;
      const participants = await roomService.listParticipants(room.name);
      const entry = present.get(channelId) ?? { identities: new Set(), profileIds: new Set() };
      for (const p of participants) {
        entry.identities.add(p.identity);
        const profileId = metadataProfileId(p.metadata);
        if (profileId) entry.profileIds.add(profileId);
      }
      present.set(channelId, entry);
    }
  } catch (error) {
    return { ok: false, reason: `LiveKit unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }

  let removed = 0;
  for (const row of rows) {
    const identities = identitiesOf(row.user_id, profiles.get(row.user_id), opts.instanceDomain);
    const inRoom = present.get(row.channel_id);
    if (inRoom && (inRoom.profileIds.has(row.user_id) || [...identities].some((id) => inRoom.identities.has(id)))) {
      continue;
    }

    const departed = !!opts.departure
      && (opts.departure.profileId === row.user_id || identities.has(opts.departure.identity));
    const joinedBefore = departed ? latestCutoff : cutoff;
    if (new Date(row.joined_at) >= joinedBefore) continue;

    const { data, error } = await supabase.rpc('remove_voice_participant', {
      p_channel_id: row.channel_id,
      p_user_id: row.user_id,
      p_joined_before: joinedBefore.toISOString(),
    });
    if (error) {
      logger.warn(`remove_voice_participant ${row.channel_id}/${row.user_id} failed: ${error.message}`);
      continue;
    }
    if (data === true) {
      removed += 1;
      logger.info(`Voice participant ${row.user_id} removed from channel ${row.channel_id}: not in LiveKit`);
    }
  }

  return { ok: true, checked: rows.length, removed };
}
