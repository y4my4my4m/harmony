import { AccessToken, RoomServiceClient, VideoGrant, TrackSource } from 'livekit-server-sdk';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

// =============================================================================
// TYPES
// =============================================================================

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

// =============================================================================
// LIVEKIT SERVICE
// =============================================================================

class LiveKitService {
  private roomService: RoomServiceClient | null = null;
  
  /**
   * Get LiveKit configuration
   */
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
  
  /**
   * Check if LiveKit is properly configured
   */
  isConfigured(): boolean {
    return this.getConfig().isConfigured;
  }
  
  /**
   * Get RoomServiceClient instance (lazy initialization)
   */
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
   */
  async generateToken(request: TokenRequest): Promise<string> {
    const cfg = this.getConfig();
    if (!cfg.isConfigured) {
      throw new Error('LiveKit is not configured');
    }
    
    // Validate user has permission to join this room
    const hasPermission = await this.validateRoomPermission(request.userId, request.roomName, request.roomType);
    if (!hasPermission) {
      throw new Error('User does not have permission to join this room');
    }
    
    // Get user profile for metadata
    const supabase = getSupabaseClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('username, display_name, avatar_url')
      .eq('id', request.userId)
      .single();
    
    // Create access token
    const at = new AccessToken(cfg.apiKey, cfg.apiSecret, {
      identity: request.userId,
      name: profile?.display_name || profile?.username || 'Unknown User',
      ttl: '24h', // Token valid for 24 hours
      metadata: JSON.stringify({
        ...request.metadata,
        avatarUrl: profile?.avatar_url,
        username: profile?.username,
        roomType: request.roomType,
        instanceDomain: config.INSTANCE_DOMAIN,
      }),
    });
    
    // Set permissions based on room type
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
    logger.info(`Generated LiveKit token for user ${request.userId} in room ${request.roomName}`);
    
    return token;
  }
  
  /**
   * Generate a token for a federated user
   */
  async generateFederatedToken(request: FederatedTokenRequest): Promise<string> {
    const cfg = this.getConfig();
    if (!cfg.isConfigured) {
      throw new Error('LiveKit is not configured');
    }
    
    if (!cfg.allowFederatedVoice) {
      throw new Error('Federated voice is not enabled on this instance');
    }
    
    // TODO: Verify ActivityPub signature
    // This should validate the HTTP Signature to ensure the request is legitimate
    // For now, we trust requests that include a valid actor ID format
    
    // Extract instance domain from actor ID
    const actorUrl = new URL(request.actorId);
    const remoteDomain = actorUrl.hostname;
    
    // Check if the instance is blocked
    const supabase = getSupabaseClient();
    const { data: blocked } = await supabase
      .from('blocked_instances')
      .select('id')
      .eq('domain', remoteDomain)
      .single();
    
    if (blocked) {
      throw new Error('Instance is blocked');
    }
    
    // Create identity for federated user (unique across federation)
    const federatedIdentity = `federated:${request.actorId}`;
    
    // Create access token with limited permissions
    const at = new AccessToken(cfg.apiKey, cfg.apiSecret, {
      identity: federatedIdentity,
      name: request.actorId.split('@').pop() || 'Remote User',
      ttl: '4h', // Shorter TTL for federated users
      metadata: JSON.stringify({
        actorId: request.actorId,
        remoteDomain,
        roomType: request.roomType,
        federated: true,
      }),
    });
    
    // Set permissions
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
  
  /**
   * Validate that a user has permission to join a room
   */
  private async validateRoomPermission(
    userId: string,
    roomName: string,
    roomType: 'voice_channel' | 'dm_call' | 'stage'
  ): Promise<boolean> {
    const supabase = getSupabaseClient();
    
    if (roomType === 'voice_channel' || roomType === 'stage') {
      // Room name format: channel-{channelId} or stage-{channelId}
      const channelId = roomName.replace(/^(channel|stage)-/, '');
      
      // Check if user has access to the channel
      // First get the server this channel belongs to
      const { data: channel } = await supabase
        .from('channels')
        .select('server_id')
        .eq('id', channelId)
        .single();
      
      if (!channel) {
        return false;
      }
      
      // Check if user is a member of the server
      const { data: member } = await supabase
        .from('server_members')
        .select('id')
        .eq('server_id', channel.server_id)
        .eq('user_id', userId)
        .single();
      
      return !!member;
    }
    
    if (roomType === 'dm_call') {
      // Room name format: dm-{conversationId}
      const conversationId = roomName.replace(/^dm-/, '');
      
      // Check if user is a participant in this DM conversation
      const { data: participant } = await supabase
        .from('dm_participants')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('user_id', userId)
        .single();
      
      return !!participant;
    }
    
    return false;
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

