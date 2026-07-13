import { AccessToken, RoomServiceClient, VideoGrant } from 'livekit-server-sdk';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { pgrstOrValue } from '../utils/postgrestFilter.js';

export interface TokenRequest {
  userId: string;
  roomName: string;
  roomType: 'voice_channel' | 'dm_call' | 'stage';
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  metadata?: Record<string, any>;
}

export interface FederatedTokenRequest {
  actorId: string; // ActivityPub actor ID (e.g., https://remote.instance/@user)
  roomName: string;
  roomType: 'voice_channel' | 'dm_call' | 'stage';
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  signature?: string; // HTTP Signature for verification
}

export interface RoomInfo {
  name: string;
  sid: string;
  numParticipants: number;
  maxParticipants: number;
  creationTime: number;
  turnPassword?: string;
  enabledCodecs: string[];
  metadata: string;
}

export interface LiveKitConfig {
  apiKey: string;
  apiSecret: string;
  wsUrl: string;
  publicWsUrl: string;
  isConfigured: boolean;
  mode: 'sfu' | 'p2p' | 'hybrid';
  allowFederatedVoice: boolean;
}

class LiveKitService {
  private roomService: RoomServiceClient | null = null;

  getConfig(): LiveKitConfig {
    const isConfigured = !!(config.LIVEKIT_API_KEY && config.LIVEKIT_API_SECRET && config.LIVEKIT_URL);
    
    return {
      apiKey: config.LIVEKIT_API_KEY || '',
      apiSecret: config.LIVEKIT_API_SECRET || '',
      wsUrl: config.LIVEKIT_URL || '',
      publicWsUrl: config.LIVEKIT_PUBLIC_URL || config.LIVEKIT_URL || '',
      isConfigured,
      mode: config.WEBRTC_MODE,
      allowFederatedVoice: config.ALLOW_FEDERATED_VOICE,
    };
  }
  
  isConfigured(): boolean {
    return this.getConfig().isConfigured;
  }

  private getRoomService(): RoomServiceClient {
    if (!this.roomService) {
      const cfg = this.getConfig();
      if (!cfg.isConfigured) {
        throw new Error('LiveKit is not configured');
      }
      
      // RoomServiceClient needs HTTP URL, not WS
      const httpUrl = cfg.wsUrl.replace('ws://', 'http://').replace('wss://', 'https://');
      this.roomService = new RoomServiceClient(httpUrl, cfg.apiKey, cfg.apiSecret);
    }
    return this.roomService;
  }
  
  /**
   * Generate a room token for a local user
   * @returns Object with token and profileId (the identity used in the token)
   */
  async generateToken(request: TokenRequest): Promise<{ token: string; profileId: string }> {
    const cfg = this.getConfig();
    if (!cfg.isConfigured) {
      throw new Error('LiveKit is not configured');
    }
    
    // request.userId is auth_user_id (from Supabase auth)
    const hasPermission = await this.validateRoomPermission(request.userId, request.roomName, request.roomType);
    if (!hasPermission) {
      throw new Error('User does not have permission to join this room');
    }
    
    const supabase = getSupabaseClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, federated_id')
      .eq('auth_user_id', request.userId)
      .single();
    
    // AUTHORIZATION: caller must belong to the room they're requesting a token for,
    // otherwise any authenticated user could mint a token for any voice channel / DM call.
    const allowed = await this.validateRoomPermission(
      request.userId,
      request.roomName,
      request.roomType,
    );
    if (!allowed) {
      throw new Error('permission denied: not a member of this room');
    }

    const profileId = profile?.id || request.userId;
    const username = profile?.username || 'unknown';

    // Use federated identity format for consistency across federation
    let identity: string;
    if (profile?.federated_id) {
      identity = `federated:${profile.federated_id}`;
    } else if (config.INSTANCE_DOMAIN) {
      identity = `federated:https://${config.INSTANCE_DOMAIN}/users/${username}`;
    } else {
      identity = profileId;
    }

    const at = new AccessToken(cfg.apiKey, cfg.apiSecret, {
      identity,
      name: profile?.display_name || profile?.username || 'Unknown User',
      ttl: '24h',
      metadata: JSON.stringify({
        ...request.metadata,
        profileId,
        avatarUrl: profile?.avatar_url,
        username: profile?.username,
        roomType: request.roomType,
        instanceDomain: config.INSTANCE_DOMAIN,
      }),
    });
    
    const videoGrant: VideoGrant = {
      roomJoin: true,
      room: request.roomName,
      canPublish: request.canPublish ?? true,
      canSubscribe: request.canSubscribe ?? true,
      canPublishData: request.canPublishData ?? true,
    };
    
    // For stage mode, limit publishing by default (only speakers can publish)
    if (request.roomType === 'stage' && request.canPublish === undefined) {
      videoGrant.canPublish = false;
    }
    
    at.addGrant(videoGrant);
    
    const token = await at.toJwt();
    logger.info(`Generated LiveKit token for profile ${profileId} in room ${request.roomName}`);
    
    return { token, profileId };
  }
  
  async generateFederatedToken(request: FederatedTokenRequest): Promise<string> {
    const cfg = this.getConfig();
    if (!cfg.isConfigured) {
      throw new Error('LiveKit is not configured');
    }
    
    if (!cfg.allowFederatedVoice) {
      throw new Error('Federated voice is not enabled on this instance');
    }

    // The HTTP Signature (actorId<->signer binding) is verified by the caller
    // (POST /api/livekit/federated-token), proving actor identity only. Room
    // access must still be authorized below, or any actor on a non-blocked
    // instance could mint a token to join any voice channel / DM call.

    const actorUrl = new URL(request.actorId);
    const remoteDomain = actorUrl.hostname;
    
    const supabase = getSupabaseClient();
    const { data: blocked } = await supabase
      .from('blocked_instances')
      .select('id')
      .eq('domain', remoteDomain)
      .single();
    
    if (blocked) {
      throw new Error('Instance is blocked');
    }

    // AUTHORIZATION: the remote actor must actually belong to the requested room.
    const allowed = await this.validateFederatedRoomAccess(
      request.actorId,
      request.roomName,
      request.roomType,
    );
    if (!allowed) {
      throw new Error('permission denied: federated actor is not authorized for this room');
    }

    const federatedIdentity = `federated:${request.actorId}`;
    
    const at = new AccessToken(cfg.apiKey, cfg.apiSecret, {
      identity: federatedIdentity,
      name: request.actorId.split('@').pop() || 'Remote User',
      ttl: '4h',
      metadata: JSON.stringify({
        actorId: request.actorId,
        remoteDomain,
        roomType: request.roomType,
        federated: true,
      }),
    });
    
    const videoGrant: VideoGrant = {
      roomJoin: true,
      room: request.roomName,
      canPublish: request.canPublish ?? true,
      canSubscribe: request.canSubscribe ?? true,
      canPublishData: request.canPublishData ?? true,
    };
    
    // For stage mode, federated users are listeners by default
    if (request.roomType === 'stage' && request.canPublish === undefined) {
      videoGrant.canPublish = false;
    }
    
    at.addGrant(videoGrant);
    
    const token = await at.toJwt();
    logger.info(`Generated federated LiveKit token for actor ${request.actorId} in room ${request.roomName}`);
    
    return token;
  }
  
  private async validateRoomPermission(
    authUserId: string,
    roomName: string,
    roomType: 'voice_channel' | 'dm_call' | 'stage'
  ): Promise<boolean> {
    const supabase = getSupabaseClient();
    
    logger.debug(`Validating room permission: authUserId=${authUserId}, roomName=${roomName}, roomType=${roomType}`);
    
    // First, get the profile.id from auth_user_id
    // auth_user_id is the Supabase auth UUID, profiles.id is the profile UUID used in app tables
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single();
    
    if (profileError || !profile) {
      logger.warn(`Profile not found for auth_user_id: ${authUserId}`, profileError);
      return false;
    }
    
    const userId = profile.id;
    logger.debug(`Found profile.id: ${userId}`);
    
    if (roomType === 'voice_channel' || roomType === 'stage') {
      // Room name format: channel-{channelId} or stage-{channelId}
      const channelId = roomName.replace(/^(channel|stage)-/, '');
      logger.debug(`Extracted channelId: ${channelId}`);

      const { data: channel, error: channelError } = await supabase
        .from('channels')
        .select('server_id')
        .eq('id', channelId)
        .single();
      
      if (channelError || !channel) {
        logger.warn(`Channel not found: ${channelId}`, channelError);
        return false;
      }
      
      logger.debug(`Found channel, server_id: ${channel.server_id}`);
      
      // Check if user is a member of the server (table is user_servers, not server_members)
      const { data: member, error: memberError } = await supabase
        .from('user_servers')
        .select('id')
        .eq('server_id', channel.server_id)
        .eq('user_id', userId)
        .single();
      
      if (memberError) {
        logger.warn(`Server member check failed: userId=${userId}, serverId=${channel.server_id}`, memberError);
      }
      
      const hasPermission = !!member;
      logger.debug(`Permission check result: ${hasPermission}`);
      return hasPermission;
    }
    
    if (roomType === 'dm_call') {
      // Room name formats:
      //   Local: dm-{conversationId}
      //   Federated: federated-dm-{conversationId}-{timestamp}
      let conversationId: string;
      const federatedMatch = roomName.match(/^federated-dm-([a-f0-9-]{36})/i);
      if (federatedMatch) {
        conversationId = federatedMatch[1];
      } else {
        conversationId = roomName.replace(/^dm-/, '');
      }
      logger.debug(`Extracted conversationId: ${conversationId}`);
      
      const { data: participant, error: participantError } = await supabase
        .from('conversation_participants')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('user_id', userId)
        .is('left_at', null)
        .single();
      
      if (participantError) {
        logger.warn(`DM participant check failed: userId=${userId}, conversationId=${conversationId}`, participantError);
      }
      
      const hasPermission = !!participant;
      logger.debug(`DM permission check result: ${hasPermission}`);
      return hasPermission;
    }
    
    logger.warn(`Unknown room type: ${roomType}`);
    return false;
  }
  
  /**
   * Validate that a FEDERATED (remote) actor is authorized for the requested
   * room. Mirrors validateRoomPermission but resolves the actor by ActivityPub
   * `federated_id` instead of a local auth user, and adds a DM-call fallback.
   *
   *  - voice_channel / stage: the actor's mirrored local profile must be an
   *    accepted member of the channel's server (same gate the AP
   *    VoiceChannelJoin handler enforces before minting a token).
   *  - dm_call: the actor must be a participant of the underlying conversation
   *    OR a party to an active federated_voice_calls row for this exact room.
   *    Either is sufficient and both call directions are covered.
   *
   * Fails closed on any lookup error.
   */
  private async validateFederatedRoomAccess(
    actorId: string,
    roomName: string,
    roomType: 'voice_channel' | 'dm_call' | 'stage',
  ): Promise<boolean> {
    const supabase = getSupabaseClient();
    try {
      // Resolve the remote actor to its mirrored local profile (if any).
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('federated_id', actorId)
        .maybeSingle();
      const profileId = profile?.id as string | undefined;

      if (roomType === 'voice_channel' || roomType === 'stage') {
        if (!profileId) return false;
        const channelId = roomName.replace(/^(channel|stage)-/, '');
        const { data: channel } = await supabase
          .from('channels')
          .select('server_id')
          .eq('id', channelId)
          .maybeSingle();
        if (!channel?.server_id) return false;
        const { data: member } = await supabase
          .from('user_servers')
          .select('id')
          .eq('server_id', channel.server_id)
          .eq('user_id', profileId)
          .eq('status', 'accepted')
          .maybeSingle();
        return !!member;
      }

      if (roomType === 'dm_call') {
        const federatedMatch = roomName.match(/^federated-dm-([a-f0-9-]{36})/i);
        const conversationId = federatedMatch
          ? federatedMatch[1]
          : roomName.replace(/^dm-/, '');

        // (a) Mirrored profile is an active participant of the conversation.
        if (profileId) {
          const { data: participant } = await supabase
            .from('conversation_participants')
            .select('id')
            .eq('conversation_id', conversationId)
            .eq('user_id', profileId)
            .is('left_at', null)
            .maybeSingle();
          if (participant) return true;
        }

        // (b) The actor is party to an active federated call for THIS room.
        let q = supabase
          .from('federated_voice_calls')
          .select('id')
          .eq('room_name', roomName)
          .in('status', ['pending', 'accepted']);
        q = profileId
          ? q.or(`caller_federated_id.eq.${pgrstOrValue(actorId)},recipient_id.eq.${profileId}`)
          : q.eq('caller_federated_id', actorId);
        const { data: call } = await q.maybeSingle();
        return !!call;
      }

      return false;
    } catch (error) {
      logger.warn(`Federated room access check failed for ${actorId} / ${roomName}:`, error);
      return false;
    }
  }

  /**
   * Public membership check for a room, inferring the room type from the name
   * prefix. Used to gate room-introspection endpoints so callers can only see
   * metadata/participants for rooms they belong to.
   */
  async userCanAccessRoom(authUserId: string, roomName: string): Promise<boolean> {
    const roomType: 'voice_channel' | 'dm_call' | 'stage' =
      roomName.startsWith('stage-') ? 'stage'
      : roomName.startsWith('channel-') ? 'voice_channel'
      : 'dm_call';
    return this.validateRoomPermission(authUserId, roomName, roomType);
  }

  /**
   * Get room info
   */
  async getRoomInfo(roomName: string): Promise<RoomInfo | null> {
    try {
      const roomService = this.getRoomService();
      const rooms = await roomService.listRooms([roomName]);
      
      if (rooms.length === 0) {
        return null;
      }
      
      const room = rooms[0];
      return {
        name: room.name,
        sid: room.sid,
        numParticipants: room.numParticipants,
        maxParticipants: room.maxParticipants,
        creationTime: Number(room.creationTime),
        enabledCodecs: room.enabledCodecs?.map(c => c.mime) || [],
        metadata: room.metadata,
      };
    } catch (error) {
      logger.error('Failed to get room info:', error);
      return null;
    }
  }
  
  /**
   * List active rooms
   */
  async listRooms(): Promise<RoomInfo[]> {
    try {
      const roomService = this.getRoomService();
      const rooms = await roomService.listRooms();
      
      return rooms.map(room => ({
        name: room.name,
        sid: room.sid,
        numParticipants: room.numParticipants,
        maxParticipants: room.maxParticipants,
        creationTime: Number(room.creationTime),
        enabledCodecs: room.enabledCodecs?.map(c => c.mime) || [],
        metadata: room.metadata,
      }));
    } catch (error) {
      logger.error('Failed to list rooms:', error);
      return [];
    }
  }
  
  /**
   * Delete a room (kick all participants)
   */
  async deleteRoom(roomName: string): Promise<boolean> {
    try {
      const roomService = this.getRoomService();
      await roomService.deleteRoom(roomName);
      logger.info(`Deleted room: ${roomName}`);
      return true;
    } catch (error) {
      logger.error(`Failed to delete room ${roomName}:`, error);
      return false;
    }
  }
  
  /**
   * Get participants in a room
   */
  async getParticipants(roomName: string): Promise<any[]> {
    try {
      const roomService = this.getRoomService();
      const participants = await roomService.listParticipants(roomName);
      
      return participants.map(p => ({
        identity: p.identity,
        name: p.name,
        sid: p.sid,
        state: p.state,
        joinedAt: Number(p.joinedAt),
        metadata: p.metadata,
        isPublisher: p.isPublisher,
      }));
    } catch (error) {
      logger.error(`Failed to get participants for room ${roomName}:`, error);
      return [];
    }
  }
  
  /**
   * Remove a participant from a room
   */
  async removeParticipant(roomName: string, identity: string): Promise<boolean> {
    try {
      const roomService = this.getRoomService();
      await roomService.removeParticipant(roomName, identity);
      logger.info(`Removed participant ${identity} from room ${roomName}`);
      return true;
    } catch (error) {
      logger.error(`Failed to remove participant ${identity} from ${roomName}:`, error);
      return false;
    }
  }
  
  /**
   * Mute a participant's track
   */
  async muteParticipant(roomName: string, identity: string, trackSid: string, muted: boolean): Promise<boolean> {
    try {
      const roomService = this.getRoomService();
      await roomService.mutePublishedTrack(roomName, identity, trackSid, muted);
      logger.info(`${muted ? 'Muted' : 'Unmuted'} track ${trackSid} for ${identity} in ${roomName}`);
      return true;
    } catch (error) {
      logger.error(`Failed to ${muted ? 'mute' : 'unmute'} participant:`, error);
      return false;
    }
  }
  
  /**
   * Update participant permissions (e.g., promote to speaker in stage)
   */
  async updateParticipantPermissions(
    roomName: string,
    identity: string,
    permissions: { canPublish?: boolean; canSubscribe?: boolean; canPublishData?: boolean }
  ): Promise<boolean> {
    try {
      const roomService = this.getRoomService();
      await roomService.updateParticipant(roomName, identity, undefined, {
        canPublish: permissions.canPublish,
        canSubscribe: permissions.canSubscribe,
        canPublishData: permissions.canPublishData,
      });
      logger.info(`Updated permissions for ${identity} in ${roomName}:`, permissions);
      return true;
    } catch (error) {
      logger.error(`Failed to update participant permissions:`, error);
      return false;
    }
  }
  
  /**
   * Get WebRTC configuration for clients
   * Returns the connection info needed by the frontend
   */
  getClientConfig(): {
    enabled: boolean;
    mode: 'sfu' | 'p2p' | 'hybrid';
    wsUrl: string | null;
    allowFederatedVoice: boolean;
  } {
    const cfg = this.getConfig();
    
    return {
      enabled: cfg.isConfigured,
      mode: cfg.mode,
      wsUrl: cfg.isConfigured ? cfg.publicWsUrl : null,
      allowFederatedVoice: cfg.allowFederatedVoice,
    };
  }
}

// Singleton instance
export const livekitService = new LiveKitService();
export default livekitService;

