/**
 * Voice Activity Handler
 * 
 * Handles Harmony-specific voice/video ActivityPub extensions for:
 * - Federated DM voice/video calls
 * - Federated server voice channels (future)
 */

import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';
import type { 
  VoiceCallInvite, 
  VoiceCallAccept, 
  VoiceCallReject, 
  VoiceCallEnd,
  VoiceChannelJoin,
  VoiceChannelLeave,
  VoiceActivity 
} from '../types/index.js';

// =============================================================================
// CONSTANTS
// =============================================================================

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
} as const;

// =============================================================================
// HANDLER
// =============================================================================

export class VoiceActivityHandler {
  /**
   * Check if an activity is a Harmony voice activity
   */
  static isVoiceActivity(activity: any): boolean {
    if (!activity?.type) return false;
    return activity.type.startsWith('harmony:Voice');
  }

  /**
   * Process incoming voice activity
   */
  static async processVoiceActivity(activity: VoiceActivity): Promise<void> {
    const activityType = activity.type;
    
    logger.info(`📞 Processing voice activity: ${activityType} from ${activity.actor}`);

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
      default:
        logger.warn(`Unknown voice activity type: ${activityType}`);
    }
  }

  /**
   * Handle incoming voice call invitation
   * Stores the call invite for the recipient to see
   */
  private static async handleVoiceCallInvite(activity: VoiceCallInvite): Promise<void> {
    const supabase = getSupabaseClient();
    
    // Get the caller's profile - use maybeSingle() to avoid throwing on 0 rows
    const { data: caller } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .eq('federated_id', activity.actor)
      .maybeSingle();

    if (!caller) {
      logger.warn(`Caller not found for voice invite: ${activity.actor}`);
      return;
    }

    // Get local recipients
    const recipients = Array.isArray(activity.to) ? activity.to : [activity.to];
    
    for (const recipientUrl of recipients) {
      const { data: recipient } = await supabase
        .from('profiles')
        .select('id, is_local')
        .eq('federated_id', recipientUrl)
        .maybeSingle();

      if (!recipient?.is_local) {
        continue; // Skip non-local users
      }

      // Store the incoming call in a pending calls table or use realtime broadcast
      // For now, we'll store it in a federated_voice_calls table
      const { error } = await supabase
        .from('federated_voice_calls')
        .upsert({
          ap_id: activity.id,
          caller_id: caller.id,
          caller_federated_id: activity.actor,
          recipient_id: recipient.id,
          call_type: activity.object.callType,
          conversation_id: activity.object.conversationId,
          livekit_url: activity.object.livekitUrl,
          room_name: activity.object.roomName,
          status: 'pending',
          created_at: activity.published,
          expires_at: new Date(Date.now() + 60000).toISOString(), // 60 second timeout
        }, {
          onConflict: 'ap_id',
        });

      if (error) {
        logger.error(`Failed to store federated voice call invite:`, error);
      } else {
        logger.info(`📞 Stored federated voice call invite for ${recipientUrl}`);
        
        // Broadcast to recipient via Supabase Realtime
        // The frontend listens for these notifications
        await supabase
          .channel(`federated-calls:${recipient.id}`)
          .send({
            type: 'broadcast',
            event: 'incoming-call',
            payload: {
              callId: activity.id,
              callerId: caller.id,
              callerName: caller.display_name || caller.username,
              callerAvatar: caller.avatar_url,
              callerFederatedId: activity.actor,
              callType: activity.object.callType,
              livekitUrl: activity.object.livekitUrl,
              roomName: activity.object.roomName,
            },
          });
      }
    }
  }

  /**
   * Handle voice call acceptance
   */
  private static async handleVoiceCallAccept(activity: VoiceCallAccept): Promise<void> {
    const supabase = getSupabaseClient();
    
    // Update the call status
    const { error } = await supabase
      .from('federated_voice_calls')
      .update({
        status: 'accepted',
        accepted_at: activity.published,
      })
      .eq('ap_id', activity.object);

    if (error) {
      logger.error(`Failed to update voice call status:`, error);
      return;
    }

    logger.info(`📞 Voice call accepted: ${activity.object}`);

    // Notify the original caller that the call was accepted
    // Get the original call to find the caller - use maybeSingle() to avoid throwing
    const { data: call } = await supabase
      .from('federated_voice_calls')
      .select('caller_id, livekit_url, room_name')
      .eq('ap_id', activity.object)
      .maybeSingle();

    if (call) {
      await supabase
        .channel(`federated-calls:${call.caller_id}`)
        .send({
          type: 'broadcast',
          event: 'call-accepted',
          payload: {
            callId: activity.object,
            acceptedBy: activity.actor,
            livekitUrl: call.livekit_url,
            roomName: call.room_name,
          },
        });
    }
  }

  /**
   * Handle voice call rejection
   */
  private static async handleVoiceCallReject(activity: VoiceCallReject): Promise<void> {
    const supabase = getSupabaseClient();
    
    // Update the call status
    const { error } = await supabase
      .from('federated_voice_calls')
      .update({
        status: 'rejected',
        ended_at: activity.published,
      })
      .eq('ap_id', activity.object);

    if (error) {
      logger.error(`Failed to update voice call status:`, error);
      return;
    }

    logger.info(`📞 Voice call rejected: ${activity.object}`);

    // Notify the original caller - use maybeSingle() to avoid throwing
    const { data: call } = await supabase
      .from('federated_voice_calls')
      .select('caller_id')
      .eq('ap_id', activity.object)
      .maybeSingle();

    if (call) {
      await supabase
        .channel(`federated-calls:${call.caller_id}`)
        .send({
          type: 'broadcast',
          event: 'call-rejected',
          payload: {
            callId: activity.object,
            rejectedBy: activity.actor,
          },
        });
    }
  }

  /**
   * Handle voice call end
   */
  private static async handleVoiceCallEnd(activity: VoiceCallEnd): Promise<void> {
    const supabase = getSupabaseClient();
    
    // Update the call status
    const { error } = await supabase
      .from('federated_voice_calls')
      .update({
        status: 'ended',
        ended_at: activity.published,
      })
      .eq('ap_id', activity.object);

    if (error) {
      logger.error(`Failed to update voice call status:`, error);
      return;
    }

    logger.info(`📞 Voice call ended: ${activity.object}`);

    // Notify all participants - use maybeSingle() to avoid throwing
    const { data: call } = await supabase
      .from('federated_voice_calls')
      .select('caller_id, recipient_id')
      .eq('ap_id', activity.object)
      .maybeSingle();

    if (call) {
      // Notify both caller and recipient
      for (const userId of [call.caller_id, call.recipient_id]) {
        await supabase
          .channel(`federated-calls:${userId}`)
          .send({
            type: 'broadcast',
            event: 'call-ended',
            payload: {
              callId: activity.object,
              endedBy: activity.actor,
            },
          });
      }
    }
  }

  /**
   * Handle voice channel join (for federated server voice channels)
   * Tracks federated users in voice channels and notifies local users
   */
  private static async handleVoiceChannelJoin(activity: VoiceChannelJoin): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = activity.actor;
    const channelInfo = activity.object;

    logger.info(`📞 Voice channel join: ${actorUrl} joining ${channelInfo.name}`);

    // Ensure user exists locally
    const { ActivityProcessor } = await import('./ActivityProcessor.js');
    await ActivityProcessor['ensureRemoteUser'](actorUrl);

    // Get the user - use maybeSingle() to avoid throwing on 0 rows
    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .eq('federated_id', actorUrl)
      .maybeSingle();

    if (!user) {
      logger.warn('User not found for voice channel join');
      return;
    }

    // Find the channel by AP ID - use maybeSingle() to avoid throwing on 0 rows
    const { data: channel } = await supabase
      .from('channels')
      .select('id, server_id')
      .eq('ap_id', channelInfo.id)
      .maybeSingle();

    if (!channel) {
      logger.warn(`Channel not found: ${channelInfo.id}`);
      return;
    }

    // Track in voice_channel_participants (if table exists)
    // Otherwise broadcast via Supabase Realtime
    try {
      await supabase
        .from('voice_channel_participants')
        .upsert({
          channel_id: channel.id,
          user_id: user.id,
          joined_at: new Date().toISOString(),
          is_federated: true,
        }, {
          onConflict: 'channel_id,user_id',
        });
    } catch (error) {
      // Table might not exist, fall through to realtime broadcast
      logger.debug('voice_channel_participants table not found, using realtime only');
    }

    // Broadcast to channel subscribers
    await supabase
      .channel(`voice:${channel.id}`)
      .send({
        type: 'broadcast',
        event: 'user-joined',
        payload: {
          userId: user.id,
          username: user.username,
          displayName: user.display_name,
          avatar: user.avatar_url,
          federated: true,
          federatedId: actorUrl,
        },
      });

    logger.info(`📞 Federated user ${user.username} joined voice channel ${channelInfo.name}`);
  }

  /**
   * Handle voice channel leave
   * Removes federated user from voice channel tracking
   */
  private static async handleVoiceChannelLeave(activity: VoiceChannelLeave): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = activity.actor;
    const channelInfo = activity.object;

    logger.info(`📞 Voice channel leave: ${actorUrl} leaving ${channelInfo.id}`);

    // Get the user - use maybeSingle() to avoid throwing on 0 rows
    const { data: user } = await supabase
      .from('profiles')
      .select('id, username')
      .eq('federated_id', actorUrl)
      .maybeSingle();

    if (!user) {
      return;
    }

    // Find the channel - use maybeSingle() to avoid throwing on 0 rows
    const { data: channel } = await supabase
      .from('channels')
      .select('id')
      .eq('ap_id', channelInfo.id)
      .maybeSingle();

    if (!channel) {
      return;
    }

    // Remove from tracking
    try {
      await supabase
        .from('voice_channel_participants')
        .delete()
        .eq('channel_id', channel.id)
        .eq('user_id', user.id);
    } catch (error) {
      logger.debug('voice_channel_participants table not found');
    }

    // Broadcast leave event
    await supabase
      .channel(`voice:${channel.id}`)
      .send({
        type: 'broadcast',
        event: 'user-left',
        payload: {
          userId: user.id,
          username: user.username,
          federated: true,
        },
      });

    logger.info(`📞 Federated user ${user.username} left voice channel`);
  }

  // =============================================================================
  // VOICE CHANNEL ACTIVITY CREATION
  // =============================================================================

  /**
   * Create a VoiceChannelJoin activity
   */
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

  /**
   * Create a VoiceChannelLeave activity
   */
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

  /**
   * Federate voice channel join to remote server
   */
  static async federateVoiceChannelJoin(
    userId: string,
    channelId: string,
    serverId: string
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;

    // Get user - use maybeSingle() to avoid throwing on 0 rows
    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, federated_id, is_local')
      .eq('id', userId)
      .maybeSingle();

    if (!user?.is_local) {
      return;
    }

    // Get server and channel - use maybeSingle() to avoid throwing on 0 rows
    const { data: channel } = await supabase
      .from('channels')
      .select(`
        id,
        name,
        server:servers!channels_server_id_fkey(id, name, federation_inbox_url, is_local_server)
      `)
      .eq('id', channelId)
      .maybeSingle();

    if (!channel) {
      return;
    }

    const server = (channel as any).server;
    
    // Only federate if it's a remote server
    if (server.is_local_server) {
      return;
    }

    const userApId = user.federated_id || `https://${hostDomain}/users/${user.username}`;
    
    const joinActivity = this.createVoiceChannelJoin(
      userApId,
      channelId,
      channel.name,
      server.id,
      server.name
    );

    // Send to server inbox
    if (server.federation_inbox_url) {
      const { DeliveryQueue } = await import('./DeliveryQueue.js');
      await DeliveryQueue.sendToInbox(server.federation_inbox_url, joinActivity, userId);
      logger.info(`📞 Federated voice channel join to ${server.federation_inbox_url}`);
    }
  }

  /**
   * Federate voice channel leave to remote server
   */
  static async federateVoiceChannelLeave(
    userId: string,
    channelId: string,
    serverId: string
  ): Promise<void> {
    const supabase = getSupabaseClient();
    const hostDomain = config.INSTANCE_DOMAIN;

    // Get user - use maybeSingle() to avoid throwing on 0 rows
    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, federated_id, is_local')
      .eq('id', userId)
      .maybeSingle();

    if (!user?.is_local) {
      return;
    }

    // Get server - use maybeSingle() to avoid throwing on 0 rows
    const { data: server } = await supabase
      .from('servers')
      .select('id, federation_inbox_url, is_local_server')
      .eq('id', serverId)
      .maybeSingle();

    if (!server || server.is_local_server) {
      return;
    }

    const userApId = user.federated_id || `https://${hostDomain}/users/${user.username}`;
    
    const leaveActivity = this.createVoiceChannelLeave(userApId, channelId, serverId);

    if (server.federation_inbox_url) {
      const { DeliveryQueue } = await import('./DeliveryQueue.js');
      await DeliveryQueue.sendToInbox(server.federation_inbox_url, leaveActivity, userId);
      logger.info(`📞 Federated voice channel leave to ${server.federation_inbox_url}`);
    }
  }

  // =============================================================================
  // ACTIVITY CREATION HELPERS
  // =============================================================================

  /**
   * Create a VoiceCallInvite activity
   */
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

  /**
   * Create a VoiceCallAccept activity
   */
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

  /**
   * Create a VoiceCallReject activity
   */
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

  /**
   * Create a VoiceCallEnd activity
   */
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

