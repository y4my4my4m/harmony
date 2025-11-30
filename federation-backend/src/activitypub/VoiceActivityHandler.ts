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
    
    // Get the caller's profile
    const { data: caller } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url')
      .eq('federated_id', activity.actor)
      .single();

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
        .single();

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
    // Get the original call to find the caller
    const { data: call } = await supabase
      .from('federated_voice_calls')
      .select('caller_id, livekit_url, room_name')
      .eq('ap_id', activity.object)
      .single();

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

    // Notify the original caller
    const { data: call } = await supabase
      .from('federated_voice_calls')
      .select('caller_id')
      .eq('ap_id', activity.object)
      .single();

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

    // Notify all participants
    const { data: call } = await supabase
      .from('federated_voice_calls')
      .select('caller_id, recipient_id')
      .eq('ap_id', activity.object)
      .single();

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
   */
  private static async handleVoiceChannelJoin(activity: VoiceChannelJoin): Promise<void> {
    // For now, just log it
    // Future: Track federated users in voice channels
    logger.info(`📞 Voice channel join: ${activity.actor} joined ${activity.object.name}`);
  }

  /**
   * Handle voice channel leave
   */
  private static async handleVoiceChannelLeave(activity: VoiceChannelLeave): Promise<void> {
    // For now, just log it
    logger.info(`📞 Voice channel leave: ${activity.actor} left ${activity.object.id}`);
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

