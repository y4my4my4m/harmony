/**
 * Voice moderation calls (20261017100002_voice_moderation.sql).
 *
 * Writes go through the federation backend (/api/federation/voice/*), which
 * runs the RPC as the caller and then applies the result to LiveKit. Reads
 * are RPCs.
 */
import { supabase } from '@/supabase';
import { apiUrl } from '@/services/instanceConfig';

export interface VoiceModerationFlags {
  muted: boolean;
  deafened: boolean;
}

export interface MyVoiceState extends VoiceModerationFlags {
  /** Voice channel of the server this profile has a row in. */
  channelId: string | null;
  /** Destination of a moderator's move, while its grant lives. */
  moveChannelId: string | null;
}

async function post(path: string, body: Record<string, unknown>): Promise<any> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not signed in');
  const response = await fetch(apiUrl(`/api/federation/voice/${path}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error || `Request failed (${response.status})`);
  return json;
}

/** Muted and deafened members of a local server; empty for a remote one. */
export async function fetchServerVoiceModeration(serverId: string): Promise<Record<string, VoiceModerationFlags>> {
  const { data, error } = await supabase.rpc('get_server_voice_moderation', { p_server_id: serverId });
  if (error) throw error;
  const out: Record<string, VoiceModerationFlags> = {};
  for (const row of (data ?? []) as Array<{ user_id: string; muted: boolean; deafened: boolean }>) {
    out[row.user_id] = { muted: row.muted === true, deafened: row.deafened === true };
  }
  return out;
}

export async function fetchMyVoiceState(serverId: string): Promise<MyVoiceState | null> {
  const { data, error } = await supabase.rpc('my_voice_state', { p_server_id: serverId });
  if (error) throw error;
  if (!data) return null;
  return {
    channelId: data.channel_id ?? null,
    moveChannelId: data.move_channel_id ?? null,
    muted: data.muted === true,
    deafened: data.deafened === true,
  };
}

/** Server mute and deafen; an absent flag is left as it is. */
export async function setServerVoiceState(
  serverId: string,
  userId: string,
  flags: { mute?: boolean; deafen?: boolean },
): Promise<VoiceModerationFlags> {
  const json = await post('moderation', { serverId, userId, ...flags });
  return { muted: json?.state?.muted === true, deafened: json?.state?.deafened === true };
}

/** Moves the member to `channelId`; null disconnects them. */
export async function moveVoiceMember(serverId: string, userId: string, channelId: string | null): Promise<void> {
  await post('move', { serverId, userId, channelId });
}

/** Brings the member's LiveKit participants in line with the database (after a kick or ban). */
export async function syncVoiceMember(serverId: string, userId: string): Promise<void> {
  await post('sync', { serverId, userId });
}
