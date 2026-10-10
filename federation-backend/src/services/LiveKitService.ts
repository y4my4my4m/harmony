import { AccessToken, RoomServiceClient, VideoGrant } from 'livekit-server-sdk';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import {
  authorizeVoiceChannel,
  isConversationParticipant,
  isLiveOutboundCallFor,
  liveKitIdentity,
  parseRoomName,
  type RoomType,
} from './voiceAccess.js';

// TYPES

export interface TokenRequest {
  userId: string;
  roomName: string;
  roomType: RoomType;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  metadata?: Record<string, any>;
}

export interface FederatedTokenRequest {
  actorId: string; // ActivityPub actor ID (e.g., https://remote.instance/@user)
  roomName: string;
  roomType: RoomType;
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

type RoomAccess =
  | { ok: true; canPublish: boolean; canSoundboard: boolean; canExternalSounds: boolean }
  | { ok: false };

/** An expected refusal of a token; `answer` is what the caller is told. */
export class TokenRefused extends Error {
  constructor(message: string, readonly answer: string) {
    super(message);
    this.name = 'TokenRefused';
  }
}
const DENIED: RoomAccess = { ok: false };

// LIVEKIT SERVICE

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
  
  /** Throws when LiveKit is not configured; callers that must fail closed use this. */
  roomServiceClient(): RoomServiceClient {
    return this.getRoomService();
  }

  // Client is constructed on first use.
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
   * Room token for a local user.
   * @returns token plus the profileId embedded as its identity.
   */
  async generateToken(request: TokenRequest): Promise<{ token: string; profileId: string }> {
    const cfg = this.getConfig();
    if (!cfg.isConfigured) {
      throw new Error('LiveKit is not configured');
    }
    
    // request.userId is auth_user_id from Supabase auth.
    const access = await this.validateRoomPermission(request.userId, request.roomName, request.roomType);
    if (!access.ok) {
      throw new TokenRefused('permission denied: not a member of this room', 'Not authorized for this room');
    }
    
    const supabase = getSupabaseClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, federated_id')
      .eq('auth_user_id', request.userId)
      .single();

    const profileId = profile?.id || request.userId;
    const identity = liveKitIdentity(
      { id: profileId, username: profile?.username, federated_id: profile?.federated_id },
      config.INSTANCE_DOMAIN,
    );

    const at = new AccessToken(cfg.apiKey, cfg.apiSecret, {
      identity,
      name: profile?.display_name || profile?.username || 'Unknown User',
      ttl: '24h',
      metadata: JSON.stringify({
        ...request.metadata,
        profileId, // local UUID, avoids a lookup by identity
        avatarUrl: profile?.avatar_url,
        username: profile?.username,
        roomType: request.roomType,
        instanceDomain: config.INSTANCE_DOMAIN,
        // USE_SOUNDBOARD and SPEAK on the channel; soundboardExternal adds USE_EXTERNAL_SOUNDS.
        // Follow the request's metadata, which cannot claim them.
        soundboard: access.canSoundboard,
        soundboardExternal: access.canExternalSounds,
      }),
    });
    
    at.addGrant(this.videoGrant(request, access.canPublish));
    
    const token = await at.toJwt();
    logger.info(`Generated LiveKit token for profile ${profileId} in room ${request.roomName}`);
    
    return { token, profileId };
  }

  /**
   * Requested grants narrowed by the room decision. Stage rooms default to
   * listener; publishing in a channel room needs SPEAK.
   */
  private videoGrant(
    request: { roomName: string; roomType: RoomType; canPublish?: boolean; canSubscribe?: boolean; canPublishData?: boolean },
    mayPublish: boolean,
  ): VideoGrant {
    const wantsPublish = request.canPublish ?? request.roomType !== 'stage';
    return {
      roomJoin: true,
      room: request.roomName,
      canPublish: wantsPublish && mayPublish,
      canSubscribe: request.canSubscribe ?? true,
      canPublishData: request.canPublishData ?? true,
    };
  }
  
  async generateFederatedToken(request: FederatedTokenRequest): Promise<string> {
    const cfg = this.getConfig();
    if (!cfg.isConfigured) {
      throw new Error('LiveKit is not configured');
    }
    
    if (!cfg.allowFederatedVoice) {
      throw new TokenRefused('Federated voice is not enabled on this instance', 'Federated voice is not enabled on this instance');
    }

    // NOTE: the HTTP Signature and the actorId<->signer binding are verified by
    // the caller, POST /api/livekit/federated-token. That authenticates the
    // remote actor but does not establish room membership, so room access is
    // authorized below. Without it any actor on a non-blocked instance can mint
    // a token for any voice channel or DM call and, for non-E2EE rooms, receive
    // the SFU media.

    const actorUrl = new URL(request.actorId);
    const remoteDomain = actorUrl.hostname;
    
    const supabase = getSupabaseClient();
    const { data: blocked } = await supabase
      .from('blocked_instances')
      .select('id')
      .eq('domain', remoteDomain)
      .single();
    
    if (blocked) {
      throw new TokenRefused(`Instance ${remoteDomain} is blocked`, 'Instance is blocked');
    }

    // AUTHORIZATION: the remote actor must belong to the requested room.
    const access = await this.validateFederatedRoomAccess(
      request.actorId,
      request.roomName,
      request.roomType,
    );
    if (!access.ok) {
      throw new TokenRefused('permission denied: federated actor is not authorized for this room', 'Not authorized for this room');
    }

    const federatedIdentity = `federated:${request.actorId}`;
    
    const at = new AccessToken(cfg.apiKey, cfg.apiSecret, {
      identity: federatedIdentity,
      name: request.actorId.split('@').pop() || 'Remote User',
      ttl: '4h', // shorter than local tokens
      metadata: JSON.stringify({
        actorId: request.actorId,
        remoteDomain,
        roomType: request.roomType,
        federated: true,
        soundboard: access.canSoundboard,
        soundboardExternal: access.canExternalSounds,
      }),
    });
    
    at.addGrant(this.videoGrant(request, access.canPublish));
    
    const token = await at.toJwt();
    logger.info(`Generated federated LiveKit token for actor ${request.actorId} in room ${request.roomName}`);
    
    return token;
  }
  
  /**
   * Room authorization for a local user (auth UUID).
   *  - voice_channel / stage: authorizeVoiceChannel.
   *  - dm_call: active participant of the conversation the room names.
   * Fails closed on any lookup error.
   */
  private async validateRoomPermission(
    authUserId: string,
    roomName: string,
    roomType: RoomType,
  ): Promise<RoomAccess> {
    const supabase = getSupabaseClient();
    try {
      const room = parseRoomName(roomName, roomType);
      if (!room) return DENIED;

      // auth_user_id is the Supabase auth UUID; app tables key off profiles.id.
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('id')
        .eq('auth_user_id', authUserId)
        .maybeSingle();
      if (profileError || !profile) {
        logger.warn(`Profile not found for auth_user_id: ${authUserId}`);
        return DENIED;
      }

      if (room.kind === 'channel') {
        const decision = await authorizeVoiceChannel(supabase, {
          profileId: profile.id, channelId: room.channelId, remote: false,
        });
        if (!decision.ok) logger.debug(`Room ${roomName} refused for ${profile.id}: ${decision.reason}`);
        return decision.ok
          ? { ok: true, canPublish: decision.canPublish, canSoundboard: decision.canSoundboard, canExternalSounds: decision.canExternalSounds }
          : DENIED;
      }

      return (await isConversationParticipant(supabase, room.conversationId, profile.id))
        ? { ok: true, canPublish: true, canSoundboard: false, canExternalSounds: false }
        : DENIED;
    } catch (error) {
      logger.warn(`Room permission check failed for ${authUserId} / ${roomName}:`, error);
      return DENIED;
    }
  }
  
  /**
   * Room authorization for a remote actor, resolved by `federated_id`.
   *  - voice_channel / stage: authorizeVoiceChannel on a server hosted here
   *    with federation enabled.
   *  - dm_call: the actor is an active participant of the conversation the
   *    room names. A federated-dm room additionally needs a live outbound
   *    call naming it, whose recipient is the actor (isLiveOutboundCallFor).
   *    Inbound rows grant nothing: their room names and URLs are sender-chosen.
   * Fails closed on any lookup error.
   */
  private async validateFederatedRoomAccess(
    actorId: string,
    roomName: string,
    roomType: RoomType,
  ): Promise<RoomAccess> {
    const supabase = getSupabaseClient();
    try {
      const room = parseRoomName(roomName, roomType);
      if (!room) return DENIED;

      const { data: profile } = await supabase
        .from('profiles')
        .select('id, is_local, is_suspended')
        .eq('federated_id', actorId)
        .maybeSingle();
      if (!profile?.id || profile.is_local === true || profile.is_suspended === true) return DENIED;

      if (room.kind === 'channel') {
        const decision = await authorizeVoiceChannel(supabase, {
          profileId: profile.id, channelId: room.channelId, remote: true,
        });
        if (!decision.ok) logger.info(`Federated room ${roomName} refused for ${actorId}: ${decision.reason}`);
        return decision.ok
          ? { ok: true, canPublish: decision.canPublish, canSoundboard: decision.canSoundboard, canExternalSounds: decision.canExternalSounds }
          : DENIED;
      }

      if (room.federated && !(await isLiveOutboundCallFor(supabase, roomName, profile.id))) {
        logger.info(`Federated room ${roomName} refused for ${actorId}: no live outbound call to it`);
        return DENIED;
      }
      return (await isConversationParticipant(supabase, room.conversationId, profile.id))
        ? { ok: true, canPublish: true, canSoundboard: false, canExternalSounds: false }
        : DENIED;
    } catch (error) {
      logger.warn(`Federated room access check failed for ${actorId} / ${roomName}:`, error);
      return DENIED;
    }
  }

  /**
   * Membership check that infers room type from the name prefix. Gates the
   * room-introspection endpoints: callers see metadata and participants only
   * for rooms they belong to.
   */
  async userCanAccessRoom(authUserId: string, roomName: string): Promise<boolean> {
    const roomType: RoomType =
      roomName.startsWith('stage-') ? 'stage'
      : roomName.startsWith('channel-') ? 'voice_channel'
      : 'dm_call';
    return (await this.validateRoomPermission(authUserId, roomName, roomType)).ok;
  }

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
  
  // Disconnects every participant.
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
  
  // Also used to promote a stage listener to speaker.
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

export const livekitService = new LiveKitService();
export default livekitService;

