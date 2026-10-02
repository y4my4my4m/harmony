/**
 * Harmony voice/video ActivityPub extensions:
 * - federated DM voice/video calls
 * - federated server voice channels with LiveKit token exchange
 */

import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';
import { livekitService } from '../services/LiveKitService.js';
import {
  authorizeVoiceChannel,
  eitherBlocks,
  isLiveKitUrl,
  mintVoiceJoinId,
  parseRoomName,
  sharedConversation,
  verifyVoiceJoinId,
} from '../services/voiceAccess.js';
import { SignatureService } from './SignatureService.js';
import { remoteServerHosts, type ChannelWriteServer } from './channelWriteAuthz.js';
import { sameOrigin, urlHost } from '../utils/apOrigin.js';
import { safeFetch } from '../utils/ssrfProtection.js';
import type { 
  VoiceCallInvite, 
  VoiceCallAccept, 
  VoiceCallReject, 
  VoiceCallEnd,
  VoiceChannelJoin,
  VoiceChannelLeave,
  VoiceChannelJoinAccept,
  VoiceChannelJoinReject,
  VoiceActivity 
} from '../types/index.js';

// CONSTANTS

// Harmony ActivityPub context extension for voice
export const HARMONY_VOICE_CONTEXT = 'https://harmony.social/ns/voice';

// Voice activity type prefixes
export const HARMONY_VOICE_TYPES = {
  VoiceCallInvite: 'harmony:VoiceCallInvite',
  VoiceCallAccept: 'harmony:VoiceCallAccept',
  VoiceCallReject: 'harmony:VoiceCallReject',
  VoiceCallEnd: 'harmony:VoiceCallEnd',
  VoiceChannelJoin: 'harmony:VoiceChannelJoin',
  VoiceChannelLeave: 'harmony:VoiceChannelLeave',
  VoiceChannelJoinAccept: 'harmony:VoiceChannelJoinAccept',
  VoiceChannelJoinReject: 'harmony:VoiceChannelJoinReject',
} as const;

// A federated call rings for 60 s, matching federated_voice_calls.expires_at.
export const RING_TTL_MS = 60_000;
const MAX_CALL_RECIPIENTS = 10;
const MAX_TOKEN_LENGTH = 8192;

export type CallDirection = 'inbound' | 'outbound';

export interface CallToken {
  token: string;
  wsUrl: string;
  roomName: string;
}

function hostnameOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Voice presence over Realtime's REST broadcast with the service key: on the
 * private voice-channels:{serverId} topic for an open channel, on
 * voice-channel:{channelId} for one some member cannot view (channel_is_restricted;
 * a failed lookup counts as restricted). A public send reaches no member:
 * public and private topics are separate namespaces.
 */
async function broadcastVoicePresence(
  serverId: string,
  payload: Record<string, unknown> & { channelId: string },
): Promise<void> {
  const supabase = getSupabaseClient();
  const { data: restricted, error } = await supabase
    .rpc('channel_is_restricted', { p_channel_id: payload.channelId });
  const topic = error || restricted !== false
    ? `voice-channel:${payload.channelId}`
    : `voice-channels:${serverId}`;
  try {
    await supabase
      .channel(topic, { config: { private: true } })
      .httpSend('voice-channel-event', payload);
  } catch (sendError) {
    logger.warn(`Voice presence broadcast on ${topic} failed:`, sendError);
  }
}

// HANDLER

export class VoiceActivityHandler {
  static isVoiceActivity(activity: any): boolean {
    if (!activity?.type) return false;
    return activity.type.startsWith('harmony:Voice');
  }

  static async processVoiceActivity(activity: VoiceActivity): Promise<void> {
    const activityType = activity.type;
    
    logger.info(`Processing voice activity: ${activityType} from ${activity.actor}`);

    switch (activityType) {
      case HARMONY_VOICE_TYPES.VoiceCallInvite:
        await this.handleVoiceCallInvite(activity as VoiceCallInvite);
        break;
      case HARMONY_VOICE_TYPES.VoiceCallAccept:
        await this.handleVoiceCallAccept(activity as VoiceCallAccept);
        break;
      case HARMONY_VOICE_TYPES.VoiceCallReject:
        await this.handleVoiceCallReject(activity as VoiceCallReject);
        break;
      case HARMONY_VOICE_TYPES.VoiceCallEnd:
        await this.handleVoiceCallEnd(activity as VoiceCallEnd);
        break;
      case HARMONY_VOICE_TYPES.VoiceChannelJoin:
        await this.handleVoiceChannelJoin(activity as VoiceChannelJoin);
        break;
      case HARMONY_VOICE_TYPES.VoiceChannelLeave:
        await this.handleVoiceChannelLeave(activity as VoiceChannelLeave);
        break;
      case HARMONY_VOICE_TYPES.VoiceChannelJoinAccept:
        await this.handleVoiceChannelJoinAccept(activity as VoiceChannelJoinAccept);
        break;
      case HARMONY_VOICE_TYPES.VoiceChannelJoinReject:
        await this.handleVoiceChannelJoinReject(activity as VoiceChannelJoinReject);
        break;
      default:
        logger.warn(`Unknown voice activity type: ${activityType}`);
    }
  }

  /**
   * Rings each local recipient that shares a direct or group conversation with
   * the caller and has no block either way. The row stores this instance's
   * conversation id. Room name and LiveKit URL name the caller's room on the
   * caller's server; no token on this instance follows from them.
   */
  private static async handleVoiceCallInvite(activity: VoiceCallInvite): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = activity.actor;
    const call = activity.object;

    if (!config.ALLOW_FEDERATED_VOICE) {
      logger.info(`Voice invite ${activity.id} ignored: federated voice is off`);
      return;
    }
    if (typeof activity.id !== 'string' || !sameOrigin(activity.id, actorUrl)) {
      logger.warn(`Voice invite ${activity.id} is not on the host of ${actorUrl}`);
      return;
    }
    const room = parseRoomName(call?.roomName, 'dm_call');
    if (!call || (call.callType !== 'voice' && call.callType !== 'video')
        || room?.kind !== 'dm' || !room.federated || !isLiveKitUrl(call.livekitUrl)) {
      logger.warn(`Voice invite ${activity.id} from ${actorUrl} has an invalid call object`);
      return;
    }

    const { data: caller } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, is_local, is_suspended')
      .eq('federated_id', actorUrl)
      .maybeSingle();

    if (!caller || caller.is_local === true || caller.is_suspended === true) {
      logger.warn(`Caller not usable for voice invite: ${actorUrl}`);
      return;
    }

    const recipients = (Array.isArray(activity.to) ? activity.to : [activity.to])
      .filter((r): r is string => typeof r === 'string')
      .slice(0, MAX_CALL_RECIPIENTS);
    
    for (const recipientUrl of recipients) {
      const { data: recipient } = await supabase
        .from('profiles')
        .select('id, is_local, is_suspended')
        .eq('federated_id', recipientUrl)
        .maybeSingle();

      if (!recipient?.is_local || recipient.is_suspended === true || recipient.id === caller.id) {
        continue;
      }

      if (await eitherBlocks(supabase, caller.id, recipient.id)) {
        logger.info(`Voice invite from ${actorUrl} to ${recipient.id} refused: blocked`);
        continue;
      }
      const conversationId = await sharedConversation(supabase, caller.id, recipient.id);
      if (!conversationId) {
        logger.info(`Voice invite from ${actorUrl} to ${recipient.id} refused: no shared conversation`);
        continue;
      }

      // ignoreDuplicates: a replayed or colliding ap_id never rewrites a stored call.
      const now = Date.now();
      const { data: stored, error } = await supabase
        .from('federated_voice_calls')
        .upsert({
          ap_id: activity.id,
          caller_id: caller.id,
          caller_federated_id: actorUrl,
          recipient_id: recipient.id,
          call_type: call.callType,
          conversation_id: conversationId,
          livekit_url: call.livekitUrl,
          room_name: call.roomName,
          status: 'pending',
          direction: 'inbound',
          created_at: new Date(now).toISOString(),
          expires_at: new Date(now + RING_TTL_MS).toISOString(),
        }, {
          onConflict: 'ap_id',
          ignoreDuplicates: true,
        })
        .select('id');

      if (error) {
        logger.error(`Failed to store federated voice call invite:`, error);
        continue;
      }
      if (!stored || stored.length === 0) {
        logger.info(`Voice invite ${activity.id} already stored; not ringing again`);
        continue;
      }

      logger.info(`Stored federated voice call invite for ${recipientUrl}`);

      await this.notifyCallParty(recipient.id, 'incoming', {
        callId: activity.id,
        callerId: caller.id,
        callerName: caller.display_name || caller.username,
        callerAvatar: caller.avatar_url,
        callerFederatedId: actorUrl,
        callType: call.callType,
        conversationId,
        livekitUrl: call.livekitUrl,
        roomName: call.roomName,
      });
    }
  }

  /**
   * Call event on the party's private user:{profileId} channel, as
   * `federated_call:{event}`. Only its owner subscribes or sends there.
   */
  private static async notifyCallParty(
    profileId: string,
    event: 'incoming' | 'accepted' | 'rejected' | 'ended',
    payload: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await getSupabaseClient().rpc('broadcast_user_event', {
      p_user_id: profileId,
      p_payload: { type: `federated_call:${event}`, ...payload },
    });
    if (error) logger.error(`Failed to deliver federated_call:${event} to ${profileId}:`, error);
  }

  /**
   * Call row named by an Accept/Reject/End, with the federated id of its
   * recipient. inbound: remote caller, local recipient. outbound: local
   * caller, remote recipient.
   */
  private static async loadCall(apId: unknown): Promise<{
    id: string; status: string; expires_at: string | null; direction: CallDirection;
    caller_id: string | null; caller_federated_id: string; recipient_id: string;
    recipient_federated_id: string | null; conversation_id: string | null;
    livekit_url: string; room_name: string;
  } | null> {
    if (typeof apId !== 'string' || !apId) return null;
    const supabase = getSupabaseClient();
    const { data: call } = await supabase
      .from('federated_voice_calls')
      .select('id, status, expires_at, direction, caller_id, caller_federated_id, recipient_id, conversation_id, livekit_url, room_name')
      .eq('ap_id', apId)
      .maybeSingle();
    if (!call) return null;
    const { data: recipient } = await supabase
      .from('profiles')
      .select('federated_id')
      .eq('id', call.recipient_id)
      .maybeSingle();
    return {
      ...call,
      direction: call.direction === 'outbound' ? 'outbound' : 'inbound',
      recipient_federated_id: recipient?.federated_id ?? null,
    };
  }

  private static isRinging(call: { status: string; expires_at: string | null }): boolean {
    return call.status === 'pending' && !!call.expires_at && Date.parse(call.expires_at) > Date.now();
  }

  /** The remote recipient of an outbound call is the actor. */
  private static isRemoteRecipient(
    call: { direction: CallDirection; recipient_federated_id: string | null },
    actor: string,
  ): boolean {
    return call.direction === 'outbound' && !!call.recipient_federated_id
      && SignatureService.verifyActorMatch(actor, call.recipient_federated_id);
  }

  /**
   * Accept of an outbound call, from its remote recipient while it rings.
   * The recipient's instance has already fetched its token for the room from
   * POST /api/livekit/federated-token.
   */
  private static async handleVoiceCallAccept(activity: VoiceCallAccept): Promise<void> {
    const supabase = getSupabaseClient();
    const call = await this.loadCall(activity.object);
    if (!call) return;

    if (!this.isRemoteRecipient(call, activity.actor)) {
      logger.warn(`Rejecting VoiceCallAccept from ${activity.actor}: not the remote recipient of ${activity.object}`);
      return;
    }
    if (!this.isRinging(call)) {
      logger.info(`Ignoring VoiceCallAccept for ${activity.object}: call is ${call.status} or expired`);
      return;
    }

    const { data: updated, error } = await supabase
      .from('federated_voice_calls')
      .update({ status: 'accepted', accepted_at: new Date().toISOString() })
      .eq('id', call.id)
      .eq('status', 'pending')
      .select('id');

    if (error) {
      logger.error(`Failed to update voice call status:`, error);
      return;
    }
    if (!updated?.length) return;

    logger.info(`Voice call accepted: ${activity.object}`);

    if (call.caller_id) {
      await this.notifyCallParty(call.caller_id, 'accepted', {
        callId: activity.object,
        conversationId: call.conversation_id,
        partyId: call.recipient_id,
        acceptedBy: activity.actor,
        roomName: call.room_name,
      });
    }
  }

  /** Reject of an outbound call, from its remote recipient while it rings. */
  private static async handleVoiceCallReject(activity: VoiceCallReject): Promise<void> {
    const supabase = getSupabaseClient();
    const call = await this.loadCall(activity.object);
    if (!call) return;

    if (!this.isRemoteRecipient(call, activity.actor)) {
      logger.warn(`Rejecting VoiceCallReject from ${activity.actor}: not the remote recipient of ${activity.object}`);
      return;
    }
    if (call.status !== 'pending') return;

    const { data: updated, error } = await supabase
      .from('federated_voice_calls')
      .update({ status: 'rejected', ended_at: new Date().toISOString() })
      .eq('id', call.id)
      .eq('status', 'pending')
      .select('id');

    if (error) {
      logger.error(`Failed to update voice call status:`, error);
      return;
    }
    if (!updated?.length) return;

    logger.info(`Voice call rejected: ${activity.object}`);

    if (call.caller_id) {
      await this.notifyCallParty(call.caller_id, 'rejected', {
        callId: activity.object,
        conversationId: call.conversation_id,
        partyId: call.recipient_id,
        rejectedBy: activity.actor,
        roomName: call.room_name,
      });
    }
  }

  /**
   * End from the remote party: the caller of an inbound call, the recipient
   * of an outbound one. The local party is told.
   */
  private static async handleVoiceCallEnd(activity: VoiceCallEnd): Promise<void> {
    const supabase = getSupabaseClient();
    const call = await this.loadCall(activity.object);
    if (!call) return;

    const fromRemoteParty = call.direction === 'inbound'
      ? SignatureService.verifyActorMatch(activity.actor, call.caller_federated_id)
      : this.isRemoteRecipient(call, activity.actor);
    if (!fromRemoteParty) {
      logger.warn(`Rejecting VoiceCallEnd from ${activity.actor}: not the remote party of ${activity.object}`);
      return;
    }
    if (call.status !== 'pending' && call.status !== 'accepted') return;

    const { data: updated, error } = await supabase
      .from('federated_voice_calls')
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('id', call.id)
      .in('status', ['pending', 'accepted'])
      .select('id');

    if (error) {
      logger.error(`Failed to update voice call status:`, error);
      return;
    }
    if (!updated?.length) return;

    logger.info(`Voice call ended: ${activity.object}`);

    const [localParty, remoteParty] = call.direction === 'inbound'
      ? [call.recipient_id, call.caller_id]
      : [call.caller_id, call.recipient_id];
    if (localParty) {
      await this.notifyCallParty(localParty, 'ended', {
        callId: activity.object,
        conversationId: call.conversation_id,
        partyId: remoteParty,
        endedBy: activity.actor,
        roomName: call.room_name,
      });
    }
  }

  /**
   * Token for the caller's room, from the caller's instance: a POST to
   * /api/livekit/federated-token at the caller's origin, signed with the
   * accepting recipient's key. That instance grants it to the recipient of
   * its live outbound invite for the room (LiveKitService.validateFederatedRoomAccess).
   * Null when the instance refuses or answers for another room.
   */
  static async requestCallToken(
    call: { caller_federated_id: string; room_name: string },
    recipient: { id: string; federated_id: string },
  ): Promise<CallToken | null> {
    let endpoint: string;
    try {
      endpoint = new URL('/api/livekit/federated-token', call.caller_federated_id).href;
    } catch {
      return null;
    }
    const body = JSON.stringify({ actorId: recipient.federated_id, roomName: call.room_name, roomType: 'dm_call' });

    try {
      const { headers } = await SignatureService.signRequest(endpoint, 'POST', body, recipient.id);
      const res = await safeFetch(endpoint, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        timeoutMs: 8000,
        maxRedirects: 0,
        maxBodyBytes: 64 * 1024,
      });
      if (!res.ok) {
        logger.warn(`Caller instance refused a token for ${call.room_name}: HTTP ${res.status}`);
        return null;
      }
      const data: any = await res.json();
      if (data?.roomName !== call.room_name || !isLiveKitUrl(data?.wsUrl)
          || typeof data?.token !== 'string' || !data.token || data.token.length > MAX_TOKEN_LENGTH) {
        logger.warn(`Caller instance answered a token request for ${call.room_name} with a malformed token`);
        return null;
      }
      return { token: data.token, wsUrl: data.wsUrl, roomName: data.roomName };
    } catch (error) {
      logger.warn(`Token request to ${endpoint} failed:`, error);
      return null;
    }
  }

  /** Channel row named by a voice activity: ap_id first, then the UUID in the URL. */
  private static async resolveVoiceChannel(
    channelRef: unknown,
  ): Promise<{ id: string; name: string; server_id: string } | null> {
    if (typeof channelRef !== 'string' || !channelRef) return null;
    const supabase = getSupabaseClient();
    const { data: byApId } = await supabase
      .from('channels')
      .select('id, name, server_id')
      .eq('ap_id', channelRef)
      .maybeSingle();
    if (byApId) return byApId;
    // URL form: https://domain/servers/{serverId}/channels/{channelId}
    const uuid = channelRef.match(/\/channels\/([a-f0-9-]{36})$/i)?.[1];
    if (!uuid) return null;
    const { data: byId } = await supabase
      .from('channels')
      .select('id, name, server_id')
      .eq('id', uuid)
      .maybeSingle();
    return byId ?? null;
  }

  /**
   * Federated server voice channel join.
   *
   * On a server hosted here: authorizeVoiceChannel (membership, ban, timeout,
   * VIEW_CHANNEL + CONNECT, federation_enabled), then a LiveKit token whose
   * publish grant follows SPEAK, answered with VoiceChannelJoinAccept.
   *
   * On a remote server's local copy: a presence notice. The sender must be on
   * the server's host and an accepted member of the copy.
   */
  private static async handleVoiceChannelJoin(activity: VoiceChannelJoin): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = activity.actor;
    const channelInfo = activity.object;
    const hostDomain = config.INSTANCE_DOMAIN;

    logger.info(`Voice channel join request: ${actorUrl} joining ${channelInfo?.name}`);

    const channel = await this.resolveVoiceChannel(channelInfo?.id);
    if (!channel) {
      logger.warn(`Channel not found: ${channelInfo?.id}`);
      await this.sendVoiceChannelJoinReject(activity, 'Channel not found');
      return;
    }

    const { data: server } = await supabase
      .from('servers')
      .select('id, owner, is_local_server, ap_id, host_domain, federation_domain')
      .eq('id', channel.server_id)
      .maybeSingle();
    if (!server) {
      await this.sendVoiceChannelJoinReject(activity, 'Server not found');
      return;
    }

    if (server.is_local_server === false) {
      await this.recordRemotePresence(activity, channel, server);
      return;
    }

    // Ensure user exists locally
    const { ActivityProcessor } = await import('./ActivityProcessor.js');
    await ActivityProcessor['ensureRemoteUser'](actorUrl);

    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, federated_id, inbox_url, shared_inbox_url, is_local, is_suspended')
      .eq('federated_id', actorUrl)
      .maybeSingle();

    if (!user || user.is_local === true || user.is_suspended === true) {
      logger.warn('User not usable for voice channel join');
      await this.sendVoiceChannelJoinReject(activity, 'User not found');
      return;
    }

    if (!server.owner) {
      logger.error(`Server owner not found for channel ${channel.id}, server_id: ${channel.server_id}`);
      await this.sendVoiceChannelJoinReject(activity, 'Server configuration error');
      return;
    }

    const decision = await authorizeVoiceChannel(supabase, {
      profileId: user.id, channelId: channel.id, remote: true,
    });
    if (!decision.ok) {
      logger.warn(`Voice join by ${actorUrl} to ${channel.id} refused: ${decision.reason}`);
      await this.sendVoiceChannelJoinReject(activity, decision.reason);
      return;
    }

    let token: string;
    let wsUrl: string;
    try {
      const roomName = `channel-${channel.id}`;
      token = await livekitService.generateFederatedToken({
        actorId: actorUrl,
        roomName,
        roomType: 'voice_channel',
        canPublish: decision.canPublish,
        canSubscribe: true,
      });
      const clientWsUrl = livekitService.getClientConfig().wsUrl;
      if (!clientWsUrl) {
        throw new Error('LiveKit is not configured');
      }
      wsUrl = clientWsUrl;
    } catch (error) {
      logger.error('Failed to generate LiveKit token for federated user:', error);
      await this.sendVoiceChannelJoinReject(activity, 'Failed to generate voice token');
      return;
    }

    try {
      await supabase
        .from('voice_channel_participants')
        .upsert({
          channel_id: channel.id,
          server_id: channel.server_id,
          user_id: user.id,
          joined_at: new Date().toISOString(),
          is_federated: true,
        }, {
          onConflict: 'channel_id,user_id',
        });
    } catch (error) {
      logger.debug('voice_channel_participants table not found, continuing anyway');
    }

    await broadcastVoicePresence(channel.server_id, {
      event: 'user-joined',
      userId: user.id,
      channelId: channel.id,
      username: user.username,
      displayName: user.display_name,
      avatar: user.avatar_url,
      federated: true,
    });

    // The signing actor must own the key, so the owner's AP ID is required.
    const { data: ownerProfile, error: ownerError } = await supabase
      .from('profiles')
      .select('federated_id, username')
      .eq('id', server.owner)
      .single();
    
    if (ownerError || !ownerProfile) {
      logger.error(`Failed to get server owner profile for signing: ${ownerError?.message || 'not found'}`);
      return;
    }

    if (!ownerProfile.federated_id && !ownerProfile.username) {
      logger.error(`Server owner ${server.owner} has no federated_id or username - cannot sign VoiceChannelJoinAccept`);
      return;
    }

    const ownerApId = ownerProfile.federated_id || 
      `https://${hostDomain}/users/${ownerProfile.username}`;

    // Actor is the owner's AP ID; the signing key belongs to the owner, not
    // to the server actor.
    const acceptActivity = this.createVoiceChannelJoinAccept(
      ownerApId,
      actorUrl,
      activity.id,
      wsUrl,
      token,
      `channel-${channel.id}`
    );

    // Delivered once to an inbox on the joining actor's host, signed as the
    // server owner. Not queued: a retry lands after the client gave up, and the
    // queue row would hold the token.
    const inbox = [user.shared_inbox_url, user.inbox_url].find((u) => sameOrigin(u, actorUrl))
      ?? new URL('/inbox', actorUrl).href;

    const { DeliveryQueue } = await import('./DeliveryQueue.js');
    const delivery = await DeliveryQueue.deliverOnce(acceptActivity, inbox, server.owner);
    if (!delivery.delivered) {
      logger.warn(`VoiceChannelJoinAccept for ${actorUrl} was not delivered to ${inbox}`);
      return;
    }

    logger.info(`Federated user ${user.username} joined voice channel ${channelInfo?.name}, token sent`);
  }

  /** Presence of a host-side member in a voice channel of a remote server's local copy. */
  private static async recordRemotePresence(
    activity: VoiceChannelJoin,
    channel: { id: string; server_id: string },
    server: ChannelWriteServer,
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = activity.actor;

    const actorHost = hostnameOf(actorUrl);
    if (!actorHost || !remoteServerHosts(server).has(actorHost)) {
      logger.warn(`Rejecting voice presence from ${actorUrl}: not on the host of server ${server.id}`);
      return;
    }

    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, is_suspended')
      .eq('federated_id', actorUrl)
      .maybeSingle();
    if (!user || user.is_suspended === true) return;

    const { data: membership } = await supabase
      .from('user_servers')
      .select('status')
      .eq('server_id', server.id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (membership?.status !== 'accepted') {
      logger.warn(`Rejecting voice presence from ${actorUrl}: not a member of server ${server.id}`);
      return;
    }

    try {
      await supabase
        .from('voice_channel_participants')
        .upsert({
          channel_id: channel.id,
          server_id: channel.server_id,
          user_id: user.id,
          joined_at: new Date().toISOString(),
          is_federated: true,
        }, {
          onConflict: 'channel_id,user_id',
        });
    } catch (error) {
      logger.debug('voice_channel_participants update failed, continuing anyway');
    }

    await broadcastVoicePresence(channel.server_id, {
      event: 'user-joined',
      userId: user.id,
      channelId: channel.id,
      username: user.username,
      displayName: user.display_name,
      avatar: user.avatar_url,
      federated: true,
    });

    logger.info(`Updated presence for federated user ${user.username} in voice channel ${channel.id}`);
  }

  /**
   * Local recipients of a VoiceChannelJoinAccept/Reject whose join id this
   * instance minted for them toward the signer's host.
   */
  private static async joinAnswerRecipients(
    activity: VoiceChannelJoinAccept | VoiceChannelJoinReject,
  ): Promise<string[]> {
    const supabase = getSupabaseClient();
    const actorHost = urlHost(activity.actor);
    const recipients = (Array.isArray(activity.to) ? activity.to : [activity.to])
      .filter((r): r is string => typeof r === 'string')
      .slice(0, MAX_CALL_RECIPIENTS);
    const out: string[] = [];
    for (const recipientUrl of recipients) {
      const { data: user } = await supabase
        .from('profiles')
        .select('id, is_local, federated_id')
        .eq('federated_id', recipientUrl)
        .maybeSingle();
      if (!user?.is_local || !user.federated_id) continue;
      if (!verifyVoiceJoinId(activity.object, user.federated_id, user.id, actorHost)) {
        logger.warn(`Ignoring ${activity.type} from ${activity.actor}: ${activity.object} is not a pending join of ${user.id} to that host`);
        continue;
      }
      out.push(user.id);
    }
    return out;
  }

  /**
   * A remote server's answer to a local user's join, carrying the LiveKit
   * token. Accepted only from the host the join went to, for a join id this
   * instance minted for that user.
   */
  private static async handleVoiceChannelJoinAccept(activity: VoiceChannelJoinAccept): Promise<void> {
    const supabase = getSupabaseClient();
    const result = activity.result;

    logger.info(`Voice channel join accepted: ${activity.id}`);

    if (!result || !isLiveKitUrl(result.livekitUrl)
        || typeof result.token !== 'string' || !result.token || result.token.length > 8192) {
      logger.warn(`Ignoring VoiceChannelJoinAccept ${activity.id}: malformed result`);
      return;
    }

    // The private user:{profileId} channel: only its owner subscribes or sends
    // there. A public channel would hand the token to any subscriber.
    for (const userId of await this.joinAnswerRecipients(activity)) {
      const { error } = await supabase.rpc('broadcast_user_event', {
        p_user_id: userId,
        p_payload: {
          type: 'federated_voice:token',
          activityId: activity.id,
          originalJoinId: activity.object,
          serverHost: urlHost(activity.actor),
          livekitUrl: result.livekitUrl,
          token: result.token,
          roomName: result.roomName,
          expiresAt: result.expiresAt,
        },
      });
      if (error) {
        logger.error(`Failed to deliver voice token to ${userId}:`, error);
        continue;
      }

      logger.info(`Token delivered to local user ${userId}`);
    }
  }

  private static async handleVoiceChannelJoinReject(activity: VoiceChannelJoinReject): Promise<void> {
    const supabase = getSupabaseClient();

    logger.info(`Voice channel join rejected: ${activity.id}, reason: ${activity.reason}`);

    for (const userId of await this.joinAnswerRecipients(activity)) {
      await supabase.rpc('broadcast_user_event', {
        p_user_id: userId,
        p_payload: {
          type: 'federated_voice:rejected',
          activityId: activity.id,
          originalJoinId: activity.object,
          serverHost: urlHost(activity.actor),
          reason: typeof activity.reason === 'string' ? activity.reason.slice(0, 200) : undefined,
        },
      });

      logger.info(`Join rejection delivered to local user ${userId}`);
    }
  }

  /**
   * NOTE: logs only. Delivering a reject needs a server-level signing key,
   * which does not exist; the remote client times out instead.
   */
  private static async sendVoiceChannelJoinReject(
    originalActivity: VoiceChannelJoin,
    reason: string
  ): Promise<void> {
    logger.warn(`Voice join rejected for ${originalActivity.actor}: ${reason}`);
  }

  /**
   * Drops the federated participant row and broadcasts the leave.
   */
  private static async handleVoiceChannelLeave(activity: VoiceChannelLeave): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = activity.actor;
    const channelInfo = activity.object;

    logger.info(`Voice channel leave: ${actorUrl} leaving ${channelInfo.id}`);

    const { data: user } = await supabase
      .from('profiles')
      .select('id, username')
      .eq('federated_id', actorUrl)
      .maybeSingle();

    if (!user) {
      return;
    }

    // Channel lookup: ap_id first, then UUID parsed from the URL.
    let channel: { id: string; server_id: string } | null = null;
    
    const { data: channelByApId } = await supabase
      .from('channels')
      .select('id, server_id')
      .eq('ap_id', channelInfo.id)
      .maybeSingle();
    
    if (channelByApId) {
      channel = channelByApId;
    } else {
      const uuidMatch = channelInfo.id.match(/\/channels\/([a-f0-9-]{36})$/i);
      if (uuidMatch) {
        const { data: channelById } = await supabase
          .from('channels')
          .select('id, server_id')
          .eq('id', uuidMatch[1])
          .maybeSingle();
        if (channelById) {
          channel = channelById;
        }
      }
    }

    if (!channel) {
      return;
    }

    try {
      await supabase
        .from('voice_channel_participants')
        .delete()
        .eq('channel_id', channel.id)
        .eq('user_id', user.id);
    } catch (error) {
      logger.debug('voice_channel_participants table not found');
    }

    await broadcastVoicePresence(channel.server_id, {
      event: 'user-left',
      userId: user.id,
      channelId: channel.id,
      username: user.username,
      federated: true,
    });

    logger.info(`Federated user ${user.username} left voice channel ${channel.id}`);
  }

  // VOICE CHANNEL ACTIVITY CREATION

  /** Legacy: builds channel/server URLs from the local domain. */
  static createVoiceChannelJoin(
    userFederatedId: string,
    channelId: string,
    channelName: string,
    serverId: string,
    serverName: string
  ): VoiceChannelJoin {
    const hostDomain = config.INSTANCE_DOMAIN;
    const serverUrl = `https://${hostDomain}/servers/${serverId}`;
    const channelUrl = `${serverUrl}/channels/${channelId}`;

    return {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        HARMONY_VOICE_CONTEXT,
      ],
      id: `${userFederatedId}/activities/${crypto.randomUUID()}`,
      type: HARMONY_VOICE_TYPES.VoiceChannelJoin,
      actor: userFederatedId,
      object: {
        type: 'harmony:VoiceChannel',
        id: channelUrl,
        name: channelName,
        serverId,
        serverName,
      },
      target: serverUrl,
      published: new Date().toISOString(),
    };
  }

  /** Federated join: channel/server AP IDs point at the remote instance. */
  static createVoiceChannelJoinWithApIds(
    userFederatedId: string,
    channelApId: string,
    channelName: string,
    serverApId: string,
    serverName: string,
    activityId: string = `${userFederatedId}/activities/${crypto.randomUUID()}`,
  ): VoiceChannelJoin {
    return {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        HARMONY_VOICE_CONTEXT,
      ],
      id: activityId,
      type: HARMONY_VOICE_TYPES.VoiceChannelJoin,
      actor: userFederatedId,
      object: {
        type: 'harmony:VoiceChannel',
        id: channelApId,
        // The local UUID means nothing to the receiver; the server AP ID does.
        serverId: serverApId,
        serverName,
        name: channelName,
      },
      target: serverApId,
      published: new Date().toISOString(),
    };
  }

  /** Legacy: builds channel/server URLs from the local domain. */
  static createVoiceChannelLeave(
    userFederatedId: string,
    channelId: string,
    serverId: string
  ): VoiceChannelLeave {
    const hostDomain = config.INSTANCE_DOMAIN;
    const serverUrl = `https://${hostDomain}/servers/${serverId}`;
    const channelUrl = `${serverUrl}/channels/${channelId}`;

    return {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        HARMONY_VOICE_CONTEXT,
      ],
      id: `${userFederatedId}/activities/${crypto.randomUUID()}`,
      type: HARMONY_VOICE_TYPES.VoiceChannelLeave,
      actor: userFederatedId,
      object: {
        type: 'harmony:VoiceChannel',
        id: channelUrl,
      },
      published: new Date().toISOString(),
    };
  }

  /** Federated leave: channel AP ID points at the remote instance. */
  static createVoiceChannelLeaveWithApId(
    userFederatedId: string,
    channelApId: string
  ): VoiceChannelLeave {
    return {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        HARMONY_VOICE_CONTEXT,
      ],
      id: `${userFederatedId}/activities/${crypto.randomUUID()}`,
      type: HARMONY_VOICE_TYPES.VoiceChannelLeave,
      actor: userFederatedId,
      object: {
        type: 'harmony:VoiceChannel',
        id: channelApId,
      },
      published: new Date().toISOString(),
    };
  }

  static createVoiceChannelJoinAccept(
    serverActorId: string,
    userActorId: string,
    originalJoinId: string,
    livekitUrl: string,
    token: string,
    roomName: string
  ): VoiceChannelJoinAccept {
    // 4h, matching the LiveKit token TTL.
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

    return {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        HARMONY_VOICE_CONTEXT,
      ],
      id: `${serverActorId}/activities/${crypto.randomUUID()}`,
      type: HARMONY_VOICE_TYPES.VoiceChannelJoinAccept,
      actor: serverActorId,
      to: [userActorId],
      object: originalJoinId,
      result: {
        type: 'harmony:VoiceToken',
        livekitUrl,
        token,
        roomName,
        expiresAt,
      },
      published: new Date().toISOString(),
    };
  }

  /**
   * Sends a VoiceChannelJoin for a remote server's channel. The join id is
   * minted with mintVoiceJoinId; the caller hands it to the client, which
   * accepts only the token answering it.
   */
  static async federateVoiceChannelJoin(
    userId: string,
    channelId: string,
    _serverId: string
  ): Promise<{ joinId: string; serverHost: string } | null> {
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;

    // Keyed by auth UUID, not profile id.
    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, federated_id, is_local')
      .eq('auth_user_id', userId)
      .maybeSingle();

    if (!user?.is_local) {
      return null;
    }

    const { data: channel } = await supabase
      .from('channels')
      .select(`
        id,
        name,
        ap_id,
        server:servers!channels_server_id_fkey(id, name, ap_id, federation_inbox_url, is_local_server)
      `)
      .eq('id', channelId)
      .maybeSingle();

    if (!channel) {
      return null;
    }

    const server = (channel as any).server;
    
    if (!server || server.is_local_server) {
      return null;
    }

    const serverHost = urlHost(server.ap_id) ?? urlHost(server.federation_inbox_url);
    if (!server.federation_inbox_url || !serverHost) {
      return null;
    }

    const userApId = user.federated_id || `https://${hostDomain}/users/${user.username}`;
    
    // Stored AP IDs point at the remote instance; the fallbacks are local.
    const channelApId = channel.ap_id || `https://${hostDomain}/servers/${server.id}/channels/${channelId}`;
    const serverApId = server.ap_id || `https://${hostDomain}/servers/${server.id}`;
    const joinId = mintVoiceJoinId(userApId, user.id, serverHost);
    
    const joinActivity = this.createVoiceChannelJoinWithApIds(
      userApId,
      channelApId,
      channel.name,
      serverApId,
      server.name,
      joinId,
    );

    // Signed with profile.id as sender.
    const { DeliveryQueue } = await import('./DeliveryQueue.js');
    await DeliveryQueue.sendToInbox(server.federation_inbox_url, joinActivity, user.id);
    logger.info(`Federated voice channel join to ${server.federation_inbox_url}`);
    return { joinId, serverHost };
  }

  static async federateVoiceChannelLeave(
    userId: string,
    channelId: string,
    _serverId: string
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;

    // Get user by auth UUID - use maybeSingle() to avoid throwing on 0 rows
    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, federated_id, is_local')
      .eq('auth_user_id', userId)
      .maybeSingle();

    if (!user?.is_local) {
      return;
    }

    const { data: channel } = await supabase
      .from('channels')
      .select(`
        id,
        ap_id,
        server:servers!channels_server_id_fkey(id, ap_id, federation_inbox_url, is_local_server)
      `)
      .eq('id', channelId)
      .maybeSingle();

    if (!channel) {
      return;
    }

    const server = (channel as any).server;
    
    if (!server || server.is_local_server) {
      return;
    }

    const userApId = user.federated_id || `https://${hostDomain}/users/${user.username}`;
    const channelApId = channel.ap_id || `https://${hostDomain}/servers/${server.id}/channels/${channelId}`;
    
    const leaveActivity = this.createVoiceChannelLeaveWithApId(userApId, channelApId);

    if (server.federation_inbox_url) {
      const { DeliveryQueue } = await import('./DeliveryQueue.js');
      await DeliveryQueue.sendToInbox(server.federation_inbox_url, leaveActivity, user.id);
      logger.info(`Federated voice channel leave to ${server.federation_inbox_url}`);
    }
  }

  // ACTIVITY CREATION HELPERS

  static createVoiceCallInvite(
    callerFederatedId: string,
    recipientFederatedId: string,
    callType: 'voice' | 'video',
    conversationId: string,
    livekitUrl: string,
    roomName: string
  ): VoiceCallInvite {
    const activityId = `${callerFederatedId}/activities/${crypto.randomUUID()}`;
    
    return {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        HARMONY_VOICE_CONTEXT,
      ],
      id: activityId,
      type: HARMONY_VOICE_TYPES.VoiceCallInvite,
      actor: callerFederatedId,
      to: [recipientFederatedId],
      object: {
        type: 'harmony:VoiceCall',
        id: `${activityId}/call`,
        callType,
        conversationId,
        livekitUrl,
        roomName,
      },
      published: new Date().toISOString(),
    };
  }

  static createVoiceCallAccept(
    acceptorFederatedId: string,
    callerFederatedId: string,
    originalInviteId: string
  ): VoiceCallAccept {
    return {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        HARMONY_VOICE_CONTEXT,
      ],
      id: `${acceptorFederatedId}/activities/${crypto.randomUUID()}`,
      type: HARMONY_VOICE_TYPES.VoiceCallAccept,
      actor: acceptorFederatedId,
      to: [callerFederatedId],
      object: originalInviteId,
      published: new Date().toISOString(),
    };
  }

  static createVoiceCallReject(
    rejectorFederatedId: string,
    callerFederatedId: string,
    originalInviteId: string
  ): VoiceCallReject {
    return {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        HARMONY_VOICE_CONTEXT,
      ],
      id: `${rejectorFederatedId}/activities/${crypto.randomUUID()}`,
      type: HARMONY_VOICE_TYPES.VoiceCallReject,
      actor: rejectorFederatedId,
      to: [callerFederatedId],
      object: originalInviteId,
      published: new Date().toISOString(),
    };
  }

  static createVoiceCallEnd(
    enderFederatedId: string,
    otherParticipantFederatedId: string,
    originalInviteId: string
  ): VoiceCallEnd {
    return {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        HARMONY_VOICE_CONTEXT,
      ],
      id: `${enderFederatedId}/activities/${crypto.randomUUID()}`,
      type: HARMONY_VOICE_TYPES.VoiceCallEnd,
      actor: enderFederatedId,
      to: [otherParticipantFederatedId],
      object: originalInviteId,
      published: new Date().toISOString(),
    };
  }
}

export default VoiceActivityHandler;

