/**
 * Voice Activity Handler
 * 
 * Handles Harmony-specific voice/video ActivityPub extensions for:
 * - Federated DM voice/video calls
 * - Federated server voice channels with token exchange
 */

import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import config from '../config/index.js';
import { livekitService } from '../services/LiveKitService.js';
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
  VoiceChannelJoinAccept: 'harmony:VoiceChannelJoinAccept',
  VoiceChannelJoinReject: 'harmony:VoiceChannelJoinReject',
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
              conversationId: activity.object.conversationId,
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
   * Tracks federated users in voice channels, generates LiveKit token, and responds
   */
  private static async handleVoiceChannelJoin(activity: VoiceChannelJoin): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = activity.actor;
    const channelInfo = activity.object;
    const hostDomain = config.INSTANCE_DOMAIN;

    logger.info(`📞 Voice channel join request: ${actorUrl} joining ${channelInfo.name}`);

    // Ensure user exists locally
    const { ActivityProcessor } = await import('./ActivityProcessor.js');
    await ActivityProcessor['ensureRemoteUser'](actorUrl);

    // Get the user - use maybeSingle() to avoid throwing on 0 rows
    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, federated_id')
      .eq('federated_id', actorUrl)
      .maybeSingle();

    if (!user) {
      logger.warn('User not found for voice channel join');
      await this.sendVoiceChannelJoinReject(activity, 'User not found');
      return;
    }

    // Find the channel - try by AP ID first, then by UUID from URL
    let channel: { id: string; name: string; server_id: string } | null = null;
    
    // Try by ap_id first
    const { data: channelByApId } = await supabase
      .from('channels')
      .select('id, name, server_id')
      .eq('ap_id', channelInfo.id)
      .maybeSingle();
    
    if (channelByApId) {
      channel = channelByApId;
    } else {
      // Fallback: parse channel UUID from the URL
      // Format: https://domain/servers/{serverId}/channels/{channelId}
      const uuidMatch = channelInfo.id.match(/\/channels\/([a-f0-9-]{36})$/i);
      if (uuidMatch) {
        const channelId = uuidMatch[1];
        logger.debug(`Trying channel lookup by UUID: ${channelId}`);
        
        const { data: channelById } = await supabase
          .from('channels')
          .select('id, name, server_id')
          .eq('id', channelId)
          .maybeSingle();
        
        if (channelById) {
          channel = channelById;
        }
      }
    }

    if (!channel) {
      logger.warn(`Channel not found: ${channelInfo.id}`);
      await this.sendVoiceChannelJoinReject(activity, 'Channel not found');
      return;
    }
    
    // Get server info separately (Supabase foreign key joins can be unreliable)
    const { data: server } = await supabase
      .from('servers')
      .select('id, owner, is_local_server')
      .eq('id', channel.server_id)
      .single();
    
    logger.debug(`Server query result:`, JSON.stringify(server));
    logger.debug(`Server owner ID: ${server?.owner}, is_local: ${server?.is_local_server}`);
    
    // If this server is a federated COPY (not local), this is just a presence notification
    // from the hosting instance. We should just update presence, not generate tokens.
    if (!server?.is_local_server) {
      logger.info(`📡 Voice presence notification for federated server, updating local presence`);
      
      // Track in voice_channel_participants for presence display
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
      
      // Broadcast to local subscribers for UI update
      // IMPORTANT: Frontend listens on `voice-channels:${serverId}`, not `voice:${channelId}`
      await supabase
        .channel(`voice-channels:${channel.server_id}`)
        .send({
          type: 'broadcast',
          event: 'voice-channel-event',
          payload: {
            event: 'user-joined',
            userId: user.id,
            channelId: channel.id,
            username: user.username,
            displayName: user.display_name,
            avatar: user.avatar_url,
            federated: true,
          },
        });
      
      logger.info(`✅ Updated presence for federated user ${user.username} in voice channel ${channel.id}`);
      return; // Don't generate token - the user already has one from the hosting instance
    }
    
    // Server IS local - this is an actual join request, we need to generate a token
    if (!server?.owner) {
      logger.error(`Server owner not found for channel ${channel.id}, server_id: ${channel.server_id}`);
      await this.sendVoiceChannelJoinReject(activity, 'Server configuration error');
      return;
    }

    // Verify user has permission to join (must be a server member)
    const { data: membership } = await supabase
      .from('user_servers')
      .select('status')
      .eq('user_id', user.id)
      .eq('server_id', channel.server_id)
      .eq('status', 'accepted')
      .maybeSingle();

    if (!membership) {
      logger.warn(`User ${user.username} is not a member of server ${channel.server_id}`);
      await this.sendVoiceChannelJoinReject(activity, 'Not a server member');
      return;
    }

    // Generate LiveKit token for the federated user
    let token: string;
    let wsUrl: string;
    try {
      const roomName = `channel-${channel.id}`;
      token = await livekitService.generateFederatedToken({
        actorId: actorUrl,
        roomName,
        roomType: 'voice_channel',
        canPublish: true,
        canSubscribe: true,
      });
      wsUrl = livekitService.getClientConfig().wsUrl;
    } catch (error) {
      logger.error('Failed to generate LiveKit token for federated user:', error);
      await this.sendVoiceChannelJoinReject(activity, 'Failed to generate voice token');
      return;
    }

    // Track in voice_channel_participants
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

    // Broadcast to channel subscribers
    // IMPORTANT: Frontend listens on `voice-channels:${serverId}`, not `voice:${channelId}`
    await supabase
      .channel(`voice-channels:${channel.server_id}`)
      .send({
        type: 'broadcast',
        event: 'voice-channel-event',
        payload: {
          event: 'user-joined',
          userId: user.id,
          channelId: channel.id,
          username: user.username,
          displayName: user.display_name,
          avatar: user.avatar_url,
          federated: true,
        },
      });

    // Get server owner's AP ID for signing (actor must match signing key owner)
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

    // Send VoiceChannelJoinAccept with the token
    // Use owner's AP ID as actor (must match signing key owner)
    const acceptActivity = this.createVoiceChannelJoinAccept(
      ownerApId, // Use owner's AP ID instead of server AP ID for proper signing
      actorUrl,
      activity.id,
      wsUrl,
      token,
      `channel-${channel.id}`
    );

    // Deliver to the user's instance (use server owner for signing)
    const userDomain = new URL(actorUrl).hostname;
    const inbox = `https://${userDomain}/inbox`;
    
    const { DeliveryQueue } = await import('./DeliveryQueue.js');
    await DeliveryQueue.enqueue(acceptActivity, inbox, server.owner);

    logger.info(`✅ Federated user ${user.username} joined voice channel ${channelInfo.name}, token sent`);
  }

  /**
   * Handle voice channel join accept (response with LiveKit token)
   * This is received when our local user's join request is accepted by a remote server
   */
  private static async handleVoiceChannelJoinAccept(activity: VoiceChannelJoinAccept): Promise<void> {
    const supabase = getSupabaseClient();
    const result = activity.result;

    logger.info(`✅ Voice channel join accepted: ${activity.id}`);

    // Find the local user this response is for
    const recipients = Array.isArray(activity.to) ? activity.to : [activity.to];
    
    for (const recipientUrl of recipients) {
      const { data: user } = await supabase
        .from('profiles')
        .select('id, is_local')
        .eq('federated_id', recipientUrl)
        .maybeSingle();

      if (!user?.is_local) continue;

      // Broadcast the token to the user via Supabase Realtime
      await supabase
        .channel(`federated-voice:${user.id}`)
        .send({
          type: 'broadcast',
          event: 'voice-token-received',
          payload: {
            activityId: activity.id,
            originalJoinId: activity.object,
            livekitUrl: result.livekitUrl,
            token: result.token,
            roomName: result.roomName,
            expiresAt: result.expiresAt,
          },
        });

      logger.info(`📞 Token delivered to local user ${user.id}`);
    }
  }

  /**
   * Handle voice channel join reject
   */
  private static async handleVoiceChannelJoinReject(activity: VoiceChannelJoinReject): Promise<void> {
    const supabase = getSupabaseClient();

    logger.info(`❌ Voice channel join rejected: ${activity.id}, reason: ${activity.reason}`);

    // Find the local user this response is for
    const recipients = Array.isArray(activity.to) ? activity.to : [activity.to];
    
    for (const recipientUrl of recipients) {
      const { data: user } = await supabase
        .from('profiles')
        .select('id, is_local')
        .eq('federated_id', recipientUrl)
        .maybeSingle();

      if (!user?.is_local) continue;

      // Broadcast the rejection to the user via Supabase Realtime
      await supabase
        .channel(`federated-voice:${user.id}`)
        .send({
          type: 'broadcast',
          event: 'voice-join-rejected',
          payload: {
            activityId: activity.id,
            originalJoinId: activity.object,
            reason: activity.reason,
          },
        });

      logger.info(`📞 Join rejection delivered to local user ${user.id}`);
    }
  }

  /**
   * Helper to send a VoiceChannelJoinReject response
   * Note: Currently just logs the rejection. Full delivery requires server actor implementation.
   */
  private static async sendVoiceChannelJoinReject(
    originalActivity: VoiceChannelJoin,
    reason: string
  ): Promise<void> {
    // For now, just log the rejection
    // TODO: Implement proper reject delivery once we have server actor signing
    logger.warn(`🚫 Voice join rejected for ${originalActivity.actor}: ${reason}`);
    
    // Note: We don't send the reject activity because we don't have a proper
    // signing key for server-level activities. The remote client will timeout
    // and handle the failure gracefully.
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

    // Find the channel - try by AP ID first, then by UUID
    let channel: { id: string; server_id: string } | null = null;
    
    const { data: channelByApId } = await supabase
      .from('channels')
      .select('id, server_id')
      .eq('ap_id', channelInfo.id)
      .maybeSingle();
    
    if (channelByApId) {
      channel = channelByApId;
    } else {
      // Fallback: parse channel UUID from the URL
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
    // IMPORTANT: Frontend listens on `voice-channels:${serverId}`, not `voice:${channelId}`
    await supabase
      .channel(`voice-channels:${channel.server_id}`)
      .send({
        type: 'broadcast',
        event: 'voice-channel-event',
        payload: {
          event: 'user-left',
          userId: user.id,
          channelId: channel.id,
          username: user.username,
          federated: true,
        },
      });

    logger.info(`📞 Federated user ${user.username} left voice channel ${channel.id}`);
  }

  // =============================================================================
  // VOICE CHANNEL ACTIVITY CREATION
  // =============================================================================

  /**
   * Create a VoiceChannelJoin activity (legacy - constructs URLs from local domain)
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
   * Create a VoiceChannelJoin activity with explicit AP IDs
   * Used for federated joins where the channel/server AP IDs point to the remote instance
   */
  static createVoiceChannelJoinWithApIds(
    userFederatedId: string,
    channelApId: string,
    channelName: string,
    serverApId: string,
    serverName: string
  ): VoiceChannelJoin {
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
        id: channelApId,
        name: channelName,
      },
      target: serverApId,
      published: new Date().toISOString(),
    };
  }

  /**
   * Create a VoiceChannelLeave activity (legacy - constructs URLs from local domain)
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
   * Create a VoiceChannelLeave activity with explicit AP ID
   * Used for federated leaves where the channel AP ID points to the remote instance
   */
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

  /**
   * Create a VoiceChannelJoinAccept activity with LiveKit token
   */
  static createVoiceChannelJoinAccept(
    serverActorId: string,
    userActorId: string,
    originalJoinId: string,
    livekitUrl: string,
    token: string,
    roomName: string
  ): VoiceChannelJoinAccept {
    // Token expires in 4 hours (matches LiveKit token TTL)
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
   * Federate voice channel join to remote server
   */
  static async federateVoiceChannelJoin(
    userId: string,
    channelId: string,
    serverId: string
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

    // Get server and channel - use maybeSingle() to avoid throwing on 0 rows
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
      return;
    }

    const server = (channel as any).server;
    
    // Only federate if it's a remote server
    if (server.is_local_server) {
      return;
    }

    const userApId = user.federated_id || `https://${hostDomain}/users/${user.username}`;
    
    // Use the actual AP IDs from the database (pointing to the remote server)
    const channelApId = channel.ap_id || `https://${hostDomain}/servers/${server.id}/channels/${channelId}`;
    const serverApId = server.ap_id || `https://${hostDomain}/servers/${server.id}`;
    
    const joinActivity = this.createVoiceChannelJoinWithApIds(
      userApId,
      channelApId,
      channel.name,
      serverApId,
      server.name
    );

    // Send to server inbox (use profile.id as the sender for signing)
    if (server.federation_inbox_url) {
      const { DeliveryQueue } = await import('./DeliveryQueue.js');
      await DeliveryQueue.sendToInbox(server.federation_inbox_url, joinActivity, user.id);
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

    // Get user by auth UUID - use maybeSingle() to avoid throwing on 0 rows
    const { data: user } = await supabase
      .from('profiles')
      .select('id, username, federated_id, is_local')
      .eq('auth_user_id', userId)
      .maybeSingle();

    if (!user?.is_local) {
      return;
    }

    // Get channel with server info - use maybeSingle() to avoid throwing on 0 rows
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

