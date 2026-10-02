/**
 * Voice room authorization shared by the LiveKit token routes and the
 * ActivityPub voice handlers.
 *
 * Room names:
 *   channel-{channelId}                    voice channel
 *   stage-{channelId}                      stage channel
 *   dm-{conversationId}                    local DM call
 *   federated-dm-{conversationId}-{millis} DM call with a remote participant
 *
 * A room name is parsed against the requested room type; any other shape is
 * refused, so a dm_call request never names a channel room.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { hasChannelPermissions } from '../activitypub/channelWriteAuthz.js';

type Supabase = ReturnType<typeof getSupabaseClient>;

export type RoomType = 'voice_channel' | 'dm_call' | 'stage';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CHANNEL_ROOM = new RegExp(`^channel-(${UUID})$`, 'i');
const STAGE_ROOM = new RegExp(`^stage-(${UUID})$`, 'i');
const DM_ROOM = new RegExp(`^dm-(${UUID})$`, 'i');
const FEDERATED_DM_ROOM = new RegExp(`^federated-dm-(${UUID})-(\\d{1,16})$`, 'i');

export type ParsedRoom =
  | { kind: 'channel'; channelId: string }
  | { kind: 'dm'; conversationId: string; federated: boolean };

export function parseRoomName(roomName: unknown, roomType: RoomType): ParsedRoom | null {
  if (typeof roomName !== 'string') return null;
  if (roomType === 'voice_channel') {
    const m = roomName.match(CHANNEL_ROOM);
    return m ? { kind: 'channel', channelId: m[1].toLowerCase() } : null;
  }
  if (roomType === 'stage') {
    const m = roomName.match(STAGE_ROOM);
    return m ? { kind: 'channel', channelId: m[1].toLowerCase() } : null;
  }
  if (roomType === 'dm_call') {
    const local = roomName.match(DM_ROOM);
    if (local) return { kind: 'dm', conversationId: local[1].toLowerCase(), federated: false };
    const fed = roomName.match(FEDERATED_DM_ROOM);
    if (fed) return { kind: 'dm', conversationId: fed[1].toLowerCase(), federated: true };
  }
  return null;
}

/** `federated-dm-{conversationId}-{millis}` for exactly this conversation. */
export function isFederatedDmRoomFor(roomName: unknown, conversationId: string): boolean {
  if (typeof roomName !== 'string') return false;
  const m = roomName.match(FEDERATED_DM_ROOM);
  return !!m && m[1].toLowerCase() === conversationId.toLowerCase();
}

/** True for ws:// and wss:// URLs; ws:// only outside production. */
export function isLiveKitUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'wss:') return true;
    return url.protocol === 'ws:' && config.NODE_ENV !== 'production';
  } catch {
    return false;
  }
}

export type VoiceDecision =
  | { ok: true; serverId: string; canPublish: boolean }
  | { ok: false; reason: string };

/**
 * Voice channel access for one profile: an accepted member (or the owner) of
 * the channel's server, not banned, not timed out, holding VIEW_CHANNEL and
 * CONNECT on the channel. SPEAK decides canPublish.
 *
 * `remote`: the profile is a remote actor asking this instance for a token.
 * The server must then be hosted here with federation enabled.
 */
export async function authorizeVoiceChannel(
  supabase: Supabase,
  target: { profileId: string; channelId: string; remote: boolean },
): Promise<VoiceDecision> {
  const { profileId, channelId, remote } = target;

  const { data: channel, error: channelError } = await supabase
    .from('channels')
    .select('id, server_id')
    .eq('id', channelId)
    .maybeSingle();
  if (channelError || !channel?.server_id) return { ok: false, reason: 'channel not found' };
  const serverId: string = channel.server_id;

  const { data: server, error: serverError } = await supabase
    .from('servers')
    .select('id, owner, is_local_server, federation_enabled')
    .eq('id', serverId)
    .maybeSingle();
  if (serverError || !server) return { ok: false, reason: 'server not found' };

  if (remote) {
    if (server.is_local_server === false) return { ok: false, reason: 'server is not hosted here' };
    if (server.federation_enabled !== true) return { ok: false, reason: 'federation is disabled on the server' };
  }

  const isOwner = !!server.owner && server.owner === profileId;
  if (!isOwner) {
    const { data: membership, error: memberError } = await supabase
      .from('user_servers')
      .select('status')
      .eq('server_id', serverId)
      .eq('user_id', profileId)
      .maybeSingle();
    if (memberError || membership?.status !== 'accepted') return { ok: false, reason: 'not an accepted member' };

    const { data: ban, error: banError } = await supabase
      .from('server_bans')
      .select('id')
      .eq('server_id', serverId)
      .eq('user_id', profileId)
      .maybeSingle();
    if (banError) return { ok: false, reason: 'ban lookup failed' };
    if (ban) return { ok: false, reason: 'banned' };

    const { data: timeout, error: timeoutError } = await supabase
      .from('server_member_timeouts')
      .select('until')
      .eq('server_id', serverId)
      .eq('user_id', profileId)
      .gt('until', new Date().toISOString())
      .maybeSingle();
    if (timeoutError) return { ok: false, reason: 'timeout lookup failed' };
    if (timeout) return { ok: false, reason: 'timed out' };
  }

  if (!(await hasChannelPermissions(supabase, profileId, serverId, channelId, [['VIEW_CHANNEL'], ['CONNECT']]))) {
    return { ok: false, reason: 'missing VIEW_CHANNEL or CONNECT' };
  }
  const canPublish = await hasChannelPermissions(supabase, profileId, serverId, channelId, [['SPEAK']]);
  return { ok: true, serverId, canPublish };
}

/** Active participant of a direct or group conversation. */
export async function isConversationParticipant(
  supabase: Supabase,
  conversationId: string,
  profileId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('conversation_participants')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('user_id', profileId)
    .is('left_at', null)
    .maybeSingle();
  return !error && !!data;
}

/**
 * An outbound federated call to `recipientId` names `roomName` and is live:
 * accepted, or pending before its expiry.
 */
export async function isLiveOutboundCallFor(
  supabase: Supabase,
  roomName: string,
  recipientId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('federated_voice_calls')
    .select('status, expires_at')
    .eq('direction', 'outbound')
    .eq('room_name', roomName)
    .eq('recipient_id', recipientId)
    .in('status', ['pending', 'accepted']);
  if (error) return false;
  const now = Date.now();
  return (data ?? []).some((c: any) =>
    c.status === 'accepted' || (!!c.expires_at && Date.parse(c.expires_at) > now));
}

/** A direct or group conversation in which both profiles are active participants. */
export async function sharedConversation(
  supabase: Supabase,
  a: string,
  b: string,
): Promise<string | null> {
  const { data: mine, error } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', a)
    .is('left_at', null);
  if (error || !mine?.length) return null;
  const ids = [...new Set(mine.map((r: any) => r.conversation_id as string))];

  const { data: theirs, error: theirsError } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .eq('user_id', b)
    .is('left_at', null)
    .in('conversation_id', ids);
  if (theirsError || !theirs?.length) return null;
  const shared = [...new Set(theirs.map((r: any) => r.conversation_id as string))];

  const { data: conversations } = await supabase
    .from('conversations')
    .select('id, type')
    .in('id', shared);
  const usable = (conversations ?? []).filter((c: any) => c.type === 'direct' || c.type === 'group');
  // A 1:1 conversation is preferred over a group both belong to.
  usable.sort((x: any, y: any) => (x.type === 'direct' ? 0 : 1) - (y.type === 'direct' ? 0 : 1));
  return usable[0]?.id ?? null;
}

/** Either profile has an active block on the other. */
export async function eitherBlocks(supabase: Supabase, a: string, b: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_blocks')
    .select('blocker_id, blocked_user_id, expires_at')
    .in('blocker_id', [a, b])
    .in('blocked_user_id', [a, b]);
  if (error) return true;
  const now = Date.now();
  return (data ?? []).some((row: any) =>
    row.blocker_id !== row.blocked_user_id
    && (!row.expires_at || Date.parse(row.expires_at) > now));
}

// VOICE CHANNEL JOIN IDS
//
// A federated VoiceChannelJoin carries an id this instance mints:
//   {userApId}/activities/voice-join/{nonce}.{expiresMs}.{mac}
// mac = HMAC-SHA256(key, profileId|serverHost|nonce|expiresMs), base64url, 32 chars.
// The answering VoiceChannelJoinAccept names it as `object`; verifying the mac
// binds the answer to a join this user sent to that host, without shared state
// between the HTTP server and the inbox.

const JOIN_TTL_MS = 2 * 60 * 1000;
const JOIN_SEGMENT = '/activities/voice-join/';

function joinKey(): Buffer {
  return createHash('sha256').update(`voice-join:${config.SUPABASE_SERVICE_ROLE_KEY}`).digest();
}

function joinMac(profileId: string, serverHost: string, nonce: string, expiresMs: string): string {
  return createHmac('sha256', joinKey())
    .update(`${profileId}|${serverHost.toLowerCase()}|${nonce}|${expiresMs}`)
    .digest('base64url')
    .slice(0, 32);
}

export function mintVoiceJoinId(userApId: string, profileId: string, serverHost: string, now = Date.now()): string {
  const nonce = randomBytes(12).toString('base64url');
  const expiresMs = String(now + JOIN_TTL_MS);
  return `${userApId}${JOIN_SEGMENT}${nonce}.${expiresMs}.${joinMac(profileId, serverHost, nonce, expiresMs)}`;
}

export function verifyVoiceJoinId(
  joinId: unknown,
  userApId: string,
  profileId: string,
  actorHost: string | null,
  now = Date.now(),
): boolean {
  if (typeof joinId !== 'string' || !actorHost) return false;
  const prefix = `${userApId}${JOIN_SEGMENT}`;
  if (!joinId.startsWith(prefix)) return false;
  const parts = joinId.slice(prefix.length).split('.');
  if (parts.length !== 3) return false;
  const [nonce, expiresMs, mac] = parts;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce) || !/^\d{1,16}$/.test(expiresMs)) return false;
  if (Number(expiresMs) < now) return false;
  const expected = Buffer.from(joinMac(profileId, actorHost, nonce, expiresMs));
  const given = Buffer.from(mac);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
