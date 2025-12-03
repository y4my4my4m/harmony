/**
 * LiveKit WebRTC Service
 * 
 * Provides a SFU-based WebRTC implementation using LiveKit.
 * Mirrors the unifiedWebRTC API for seamless switching between SFU and P2P modes.
 * 
 * Features:
 * - Selective Forwarding Unit (SFU) for efficient media routing
 * - Built-in E2EE support
 * - Scales to large rooms (stage events)
 * - Automatic quality adaptation
 */

import {
  Room,
  RoomEvent,
  RemoteParticipant,
  LocalParticipant,
  Track,
  TrackPublication,
  ConnectionState,
  ParticipantEvent,
  LocalTrack,
  LocalAudioTrack,
  LocalVideoTrack,
  RemoteTrack,
  RemoteAudioTrack,
  RemoteVideoTrack,
  VideoPresets,
  AudioPresets,
  createLocalAudioTrack,
  createLocalVideoTrack,
  setLogLevel,
  LogLevel,
  ExternalE2EEKeyProvider,
} from 'livekit-client';
import { supabase } from '@/supabase';
import { debug } from '@/utils/debug';

// =============================================================================
// FEDERATED IDENTITY HELPERS
// =============================================================================

// Cache for federated ID to profile UUID mappings
const federatedIdToUuidCache = new Map<string, string>();

// Reverse cache: UUID to LiveKit identity (for looking up participants by UUID)
const uuidToIdentityCache = new Map<string, string>();

/**
 * Resolve a LiveKit identity to a profile UUID
 * For local users, identity is already the UUID
 * For federated users, identity is `federated:{federatedId}` and we need to look up the UUID
 * @param identity - The LiveKit participant identity
 * @param remoteServerDomain - Optional domain of the remote server (for resolving non-federated identities from remote servers)
 */
async function resolveIdentityToUuid(identity: string, remoteServerDomain?: string | null): Promise<string | null> {
  // If it starts with 'federated:', extract and resolve the federated ID
  if (identity.startsWith('federated:')) {
    const federatedId = identity.substring('federated:'.length);
    return resolveFederatedId(federatedId, identity);
  }
  
  // It's a plain UUID - could be local or from a remote server
  // First check if this UUID exists in our local database
  const { data: localUser } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', identity)
    .maybeSingle();
  
  if (localUser?.id) {
    // UUID exists locally
    uuidToIdentityCache.set(identity, identity);
    return identity;
  }
  
  // UUID doesn't exist locally - if we're connected to a remote server,
  // this user is local to THAT server, not ours. We need to fetch their profile.
  if (remoteServerDomain) {
    debug.log(`🌐 [LiveKit] UUID ${identity} not found locally, user is from ${remoteServerDomain}`);
    
    // We need to look up this user by username on the remote server
    // First, try to get their username from the LiveKit participant metadata
    // If we can't, we'll need to query the remote server's API
    
    // For now, try to fetch by constructing a likely federated ID pattern
    // Most instances have users at https://domain/users/username, but we only have the UUID
    // We need to ask the remote server for user info
    
    // Try querying the remote instance's user endpoint
    try {
      const { activityPubService } = await import('./activityPubService');
      
      // Try to find by querying the remote server
      // First check if we have any user with a federated_id from this domain
      const { data: existingRemoteUser } = await supabase
        .from('profiles')
        .select('id, federated_id')
        .ilike('federated_id', `%${remoteServerDomain}%`)
        .limit(1);
      
      if (existingRemoteUser && existingRemoteUser.length > 0) {
        // We have synced users from this domain, try WebFinger or user lookup
        // For now, let's try a direct actor fetch if we can construct the URL
        // This is a heuristic - the remote server might use a different URL pattern
        
        // Try common patterns
        const potentialUrls = [
          `https://${remoteServerDomain}/users/${identity}`, // Some systems use UUID in URL
        ];
        
        for (const url of potentialUrls) {
          try {
            const response = await fetch(url, {
              headers: { 'Accept': 'application/activity+json' },
            });
            
            if (response.ok) {
              const actor = await response.json();
              if (actor.id) {
                const federatedUser = await activityPubService.fetchRemoteActor(actor.id);
                if (federatedUser?.id) {
                  federatedIdToUuidCache.set(actor.id, federatedUser.id);
                  uuidToIdentityCache.set(federatedUser.id, identity);
                  debug.log(`🌐 [LiveKit] Resolved remote UUID ${identity} to local UUID ${federatedUser.id}`);
                  return federatedUser.id;
                }
              }
            }
          } catch {
            // Try next pattern
          }
        }
      }
    } catch (error) {
      debug.warn(`🌐 [LiveKit] Failed to resolve remote UUID ${identity}:`, error);
    }
    
    // Couldn't resolve - skip this user for now
    debug.warn(`🌐 [LiveKit] Could not resolve UUID ${identity} from ${remoteServerDomain}`);
    return null;
  }
  
  // No remote server domain - assume it's a local user that should exist
  uuidToIdentityCache.set(identity, identity);
  return identity;
}

/**
 * Resolve a federated ID (actor URL) to a local profile UUID
 */
async function resolveFederatedId(federatedId: string, originalIdentity: string): Promise<string | null> {
  // Check cache first
  if (federatedIdToUuidCache.has(federatedId)) {
    const cachedUuid = federatedIdToUuidCache.get(federatedId)!;
    uuidToIdentityCache.set(cachedUuid, originalIdentity);
    return cachedUuid;
  }
  
  // Look up the user by federated_id
  try {
    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', federatedId)
      .maybeSingle();
    
    if (user?.id) {
      federatedIdToUuidCache.set(federatedId, user.id);
      uuidToIdentityCache.set(user.id, originalIdentity);
      debug.log(`🌐 [LiveKit] Resolved federated identity ${federatedId} to UUID ${user.id}`);
      return user.id;
    }
    
    // Profile not found locally - need to fetch it from the remote instance
    debug.log(`🌐 [LiveKit] Profile not found for ${federatedId}, fetching from remote instance...`);
    
    const { activityPubService } = await import('./activityPubService');
    
    try {
      const federatedUser = await activityPubService.fetchRemoteActor(federatedId);
      
      if (federatedUser?.id) {
        federatedIdToUuidCache.set(federatedId, federatedUser.id);
        uuidToIdentityCache.set(federatedUser.id, originalIdentity);
        debug.log(`🌐 [LiveKit] Fetched and resolved federated identity ${federatedId} to UUID ${federatedUser.id}`);
        return federatedUser.id;
      }
    } catch (fetchError) {
      debug.warn(`🌐 [LiveKit] Failed to fetch federated actor ${federatedId}:`, fetchError);
    }
    
  } catch (error) {
    debug.warn(`🌐 [LiveKit] Failed to resolve federated identity:`, error);
  }
  
  debug.warn(`🌐 [LiveKit] Could not resolve federated identity: ${federatedId}`);
  return null;
}

// Set LiveKit log level based on environment
setLogLevel(import.meta.env.DEV ? LogLevel.debug : LogLevel.warn);

// =============================================================================
// TYPES
// =============================================================================

export interface UserMediaState {
  userId: string;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
  audioLevel: number;
}

export interface LiveKitConfig {
  enabled: boolean;
  mode: 'sfu' | 'p2p' | 'hybrid';
  wsUrl: string | null;
  allowFederatedVoice: boolean;
}

interface TokenResponse {
  token: string;
  wsUrl: string;
  roomName: string;
  identity: string;
}

// =============================================================================
// LIVEKIT WEBRTC SERVICE
// =============================================================================

export class LiveKitWebRTCService {
  private room: Room | null = null;
  private channelId: string | null = null;
  private currentUserId: string | null = null;
  private roomType: 'voice_channel' | 'dm_call' | 'stage' = 'voice_channel';
  private remoteServerDomain: string | null = null; // For federated voice channels
  
  // Local media state
  private localMediaState: UserMediaState = {
    userId: '',
    isAudioEnabled: true,
    isVideoEnabled: false,
    isScreenSharing: false,
    isMuted: false,
    isDeafened: false,
    isSpeaking: false,
    audioLevel: 0,
  };
  
  // Remote user states
  private allUserStates = new Map<string, UserMediaState>();
  
  // Event listeners
  private eventListeners = new Map<string, Function[]>();
  
  // Audio settings
  private audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  
  // Device selection
  private selectedInputDevice: string | null = null;
  private selectedOutputDevice: string | null = null;
  private selectedVideoDevice: string | null = null;
  
  // E2EE key provider
  private e2eeKeyProvider: ExternalE2EEKeyProvider | null = null;
  
  // LiveKit config cache
  private configCache: LiveKitConfig | null = null;
  private configCacheTime = 0;
  private readonly CONFIG_CACHE_TTL = 60000; // 1 minute
  
  constructor() {
    this.loadAudioSettings();
  }
  
  // =============================================================================
  // CONFIGURATION
  // =============================================================================
  
  /**
   * Get LiveKit configuration from the backend
   */
  async getConfig(forceRefresh = false): Promise<LiveKitConfig> {
    const now = Date.now();
    
    // Return cached config if still valid
    if (!forceRefresh && this.configCache && (now - this.configCacheTime) < this.CONFIG_CACHE_TTL) {
      return this.configCache;
    }
    
    try {
      // Try to get config from federation backend
      const response = await fetch('/api/livekit/config');
      
      if (!response.ok) {
        throw new Error('Failed to fetch LiveKit config');
      }
      
      const config = await response.json();
      
      this.configCache = {
        enabled: config.enabled ?? false,
        mode: config.mode ?? 'hybrid',
        wsUrl: config.wsUrl ?? null,
        allowFederatedVoice: config.allowFederatedVoice ?? true,
      };
      this.configCacheTime = now;
      
      return this.configCache;
    } catch (error) {
      debug.warn('⚠️ Could not fetch LiveKit config, using defaults');
      
      // Return default config (P2P fallback)
      return {
        enabled: false,
        mode: 'hybrid',
        wsUrl: null,
        allowFederatedVoice: true,
      };
    }
  }
  
  /**
   * Check if LiveKit SFU is available
   */
  async isAvailable(): Promise<boolean> {
    const config = await this.getConfig();
    return config.enabled && !!config.wsUrl;
  }
  
  // =============================================================================
  // TOKEN MANAGEMENT
  // =============================================================================
  
  /**
   * Get a room token from the backend
   */
  private async getToken(roomName: string, roomType: 'voice_channel' | 'dm_call' | 'stage'): Promise<TokenResponse> {
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session?.access_token) {
      throw new Error('User not authenticated');
    }
    
    const response = await fetch('/api/livekit/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        roomName,
        roomType,
      }),
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Failed to get room token');
    }
    
    return response.json();
  }
  
  /**
   * Get a federated token from a remote instance
   */
  async getFederatedToken(
    instanceUrl: string,
    actorId: string,
    roomName: string,
    roomType: 'voice_channel' | 'dm_call' | 'stage'
  ): Promise<TokenResponse> {
    // TODO: Implement HTTP signature for federated requests
    const response = await fetch(`${instanceUrl}/api/livekit/federated-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        actorId,
        roomName,
        roomType,
      }),
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Failed to get federated token');
    }
    
    return response.json();
  }
  
  // =============================================================================
  // CHANNEL MANAGEMENT
  // =============================================================================
  
  /**
   * Join a voice channel using LiveKit SFU
   */
  async joinChannel(channelId: string, userId: string, roomType: 'voice_channel' | 'dm_call' | 'stage' = 'voice_channel'): Promise<boolean> {
    debug.log('🎯 [LiveKit] Joining voice channel:', channelId, 'as user:', userId);
    
    try {
      // Clean previous connection
      if (this.room) {
        await this.leaveChannel();
      }
      
      this.channelId = channelId;
      this.currentUserId = userId;
      this.roomType = roomType;
      this.localMediaState.userId = userId;
      this.remoteServerDomain = null; // Local server, no remote domain
      
      // Get room name based on type
      const roomName = roomType === 'dm_call' ? channelId : `channel-${channelId}`;
      
      // Get token from backend
      const tokenResponse = await this.getToken(roomName, roomType);
      
      // Create room with options
      this.room = new Room({
        adaptiveStream: true,
        dynacast: true,
        // E2EE options (optional, enabled by user)
        // e2ee: this.e2eeKeyProvider ? { keyProvider: this.e2eeKeyProvider } : undefined,
      });
      
      // Setup room event listeners
      this.setupRoomListeners();
      
      // Connect to LiveKit server
      // Use relay-only ICE to avoid browser "local network" prompt
      // No latency impact since traffic goes through LiveKit SFU server anyway
      await this.room.connect(tokenResponse.wsUrl, tokenResponse.token, {
        autoSubscribe: true,
        // rtcConfig: {
        //   iceTransportPolicy: 'relay',
        // },
      });
      
      debug.log('✅ [LiveKit] Connected to room:', roomName);
      
      // Sync existing participants (they don't trigger ParticipantConnected event)
      await this.syncExistingParticipants();
      
      // Publish local audio track
      await this.publishLocalAudio();
      
      this.emit('channel-joined', { channelId, userId });
      this.emit('local-state-changed', this.localMediaState);
      
      // Emit channel state sync with all users including existing ones
      this.emit('channel-state-synced', { users: this.getAllUsers() });
      
      return true;
    } catch (error) {
      debug.error('❌ [LiveKit] Failed to join channel:', error);
      this.emit('error', error);
      return false;
    }
  }
  
  /**
   * Join a voice channel with a pre-obtained token (for federated voice)
   * Used when connecting to a remote instance's LiveKit server
   */
  async joinWithToken(wsUrl: string, token: string, channelId: string, userId: string): Promise<boolean> {
    debug.log('🌐 [LiveKit] Joining federated voice channel:', channelId, 'with remote token');
    
    try {
      // Clean previous connection
      if (this.room) {
        await this.leaveChannel();
      }
      
      this.channelId = channelId;
      this.currentUserId = userId;
      this.roomType = 'voice_channel';
      this.localMediaState.userId = userId;
      
      // Extract the remote server domain from the WebSocket URL
      // wsUrl is like "wss://livekit.har.mony.lol" or "wss://har.mony.lol:7880"
      try {
        const wsUrlParsed = new URL(wsUrl);
        // Remove 'livekit.' prefix if present, or use the main domain
        this.remoteServerDomain = wsUrlParsed.hostname.replace(/^livekit\./, '');
        debug.log('🌐 [LiveKit] Remote server domain:', this.remoteServerDomain);
      } catch {
        this.remoteServerDomain = null;
      }
      
      // Create room with options
      this.room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });
      
      // Setup room event listeners
      this.setupRoomListeners();
      
      // Connect to remote LiveKit server with provided token
      await this.room.connect(wsUrl, token, {
        autoSubscribe: true,
      });
      
      debug.log('✅ [LiveKit] Connected to federated room');
      
      // Sync existing participants
      await this.syncExistingParticipants();
      
      // Publish local audio track
      await this.publishLocalAudio();
      
      this.emit('channel-joined', { channelId, userId });
      this.emit('local-state-changed', this.localMediaState);
      this.emit('channel-state-synced', { users: this.getAllUsers() });
      
      return true;
    } catch (error) {
      debug.error('❌ [LiveKit] Failed to join federated channel:', error);
      this.emit('error', error);
      return false;
    }
  }
  
  /**
   * Leave current voice channel
   */
  async leaveChannel(): Promise<void> {
    debug.log('👋 [LiveKit] Leaving voice channel');
    
    if (this.room) {
      // Disconnect from room
      await this.room.disconnect(true);
      this.room = null;
    }
    
    // Clear state
    this.allUserStates.clear();
    
    const oldChannelId = this.channelId;
    this.channelId = null;
    this.currentUserId = null;
    this.remoteServerDomain = null;
    
    // Reset local state
    this.localMediaState = {
      userId: '',
      isAudioEnabled: true,
      isVideoEnabled: false,
      isScreenSharing: false,
      isMuted: false,
      isDeafened: false,
      isSpeaking: false,
      audioLevel: 0,
    };
    
    this.emit('channel-left', { channelId: oldChannelId });
  }
  
  // =============================================================================
  // MEDIA CONTROLS
  // =============================================================================
  
  /**
   * Publish local audio track
   */
  private async publishLocalAudio(): Promise<void> {
    if (!this.room?.localParticipant) return;
    
    try {
      const audioTrack = await createLocalAudioTrack({
        echoCancellation: this.audioConstraints.echoCancellation,
        noiseSuppression: this.audioConstraints.noiseSuppression,
        autoGainControl: this.audioConstraints.autoGainControl,
        deviceId: this.selectedInputDevice || undefined,
      });
      
      await this.room.localParticipant.publishTrack(audioTrack, {
        audioBitrate: AudioPresets.music.maxBitrate,
        dtx: true, // Discontinuous transmission for bandwidth saving
        red: true, // Redundant encoding for packet loss resilience
      });
      
      this.localMediaState.isAudioEnabled = true;
      
      // Apply mute state if needed
      if (this.localMediaState.isMuted) {
        audioTrack.mute();
      }
      
      debug.log('✅ [LiveKit] Published local audio track');
    } catch (error) {
      debug.error('❌ [LiveKit] Failed to publish audio:', error);
      throw error;
    }
  }
  
  /**
   * Toggle video on/off
   */
  async toggleVideo(): Promise<boolean> {
    if (!this.room?.localParticipant) {
      debug.warn('⚠️ [LiveKit] No room connected');
      return false;
    }
    
    try {
      if (!this.localMediaState.isVideoEnabled) {
        // Disable screen share first if active
        if (this.localMediaState.isScreenSharing) {
          await this.toggleScreenShare();
        }
        
        // Enable video
        debug.log('🎥 [LiveKit] Enabling video...');
        
        const videoTrack = await createLocalVideoTrack({
          resolution: VideoPresets.h720.resolution,
          deviceId: this.selectedVideoDevice || undefined,
        });
        
        await this.room.localParticipant.publishTrack(videoTrack, {
          videoCodec: 'vp8',
          simulcast: true, // Enable simulcast for adaptive quality
        });
        
        this.localMediaState.isVideoEnabled = true;
        debug.log('✅ [LiveKit] Video enabled');
      } else {
        // Disable video
        debug.log('🎥 [LiveKit] Disabling video...');
        
        const videoPublication = this.room.localParticipant.videoTrackPublications.values().next().value;
        if (videoPublication?.track) {
          // Store track reference before unpublishing (unpublish may invalidate it)
          const track = videoPublication.track;
          await this.room.localParticipant.unpublishTrack(track);
          // Stop the track to release camera
          if (track.mediaStreamTrack) {
            track.mediaStreamTrack.stop();
          }
        }
        
        this.localMediaState.isVideoEnabled = false;
        debug.log('✅ [LiveKit] Video disabled');
      }
      
      this.broadcastMediaState();
      this.emit('local-state-changed', this.localMediaState);
      this.emit('local-stream-changed', this.getLocalStream());
      
      return this.localMediaState.isVideoEnabled;
    } catch (error) {
      debug.error('❌ [LiveKit] Failed to toggle video:', error);
      this.emit('error', error);
      return this.localMediaState.isVideoEnabled;
    }
  }
  
  /**
   * Toggle screen share on/off
   */
  async toggleScreenShare(): Promise<boolean> {
    if (!this.room?.localParticipant) {
      debug.warn('⚠️ [LiveKit] No room connected');
      return false;
    }
    
    try {
      if (!this.localMediaState.isScreenSharing) {
        // Disable video first if active
        if (this.localMediaState.isVideoEnabled) {
          const videoPublication = this.room.localParticipant.videoTrackPublications.values().next().value;
          if (videoPublication?.track) {
            const track = videoPublication.track;
            await this.room.localParticipant.unpublishTrack(track);
            if (track.mediaStreamTrack) {
              track.mediaStreamTrack.stop();
            }
          }
          this.localMediaState.isVideoEnabled = false;
        }
        
        // Enable screen share
        debug.log('📺 [LiveKit] Enabling screen share...');
        
        await this.room.localParticipant.setScreenShareEnabled(true, {
          audio: true, // Include system audio if available
          resolution: VideoPresets.h1080.resolution,
          contentHint: 'detail',
        });
        
        this.localMediaState.isScreenSharing = true;
        debug.log('✅ [LiveKit] Screen share enabled');
      } else {
        // Disable screen share
        debug.log('📺 [LiveKit] Disabling screen share...');
        
        await this.room.localParticipant.setScreenShareEnabled(false);
        
        this.localMediaState.isScreenSharing = false;
        debug.log('✅ [LiveKit] Screen share disabled');
      }
      
      this.broadcastMediaState();
      this.emit('local-state-changed', this.localMediaState);
      this.emit('local-stream-changed', this.getLocalStream());
      
      return this.localMediaState.isScreenSharing;
    } catch (error) {
      debug.error('❌ [LiveKit] Failed to toggle screen share:', error);
      this.localMediaState.isScreenSharing = false;
      this.emit('error', error);
      return false;
    }
  }
  
  /**
   * Toggle mute on/off
   */
  toggleMute(): boolean {
    this.localMediaState.isMuted = !this.localMediaState.isMuted;
    
    if (this.room?.localParticipant) {
      const audioPublication = this.room.localParticipant.audioTrackPublications.values().next().value;
      if (audioPublication?.track) {
        if (this.localMediaState.isMuted) {
          (audioPublication.track as LocalAudioTrack).mute();
        } else {
          (audioPublication.track as LocalAudioTrack).unmute();
        }
      }
    }
    
    this.broadcastMediaState();
    this.emit('local-state-changed', this.localMediaState);
    
    return this.localMediaState.isMuted;
  }
  
  /**
   * Toggle deafen on/off
   */
  toggleDeafen(): boolean {
    this.localMediaState.isDeafened = !this.localMediaState.isDeafened;
    
    // Deafening also mutes (Discord behavior)
    if (this.localMediaState.isDeafened && !this.localMediaState.isMuted) {
      this.localMediaState.isMuted = true;
      
      if (this.room?.localParticipant) {
        const audioPublication = this.room.localParticipant.audioTrackPublications.values().next().value;
        if (audioPublication?.track) {
          (audioPublication.track as LocalAudioTrack).mute();
        }
      }
    }
    
    // Mute/unmute all remote audio based on deafen state
    if (this.room) {
      for (const participant of this.room.remoteParticipants.values()) {
        for (const publication of participant.audioTrackPublications.values()) {
          if (publication.track) {
            (publication.track as RemoteAudioTrack).setMuted(this.localMediaState.isDeafened);
          }
        }
      }
    }
    
    this.broadcastMediaState();
    this.emit('local-state-changed', this.localMediaState);
    
    return this.localMediaState.isDeafened;
  }
  
  // =============================================================================
  // STREAM ACCESS
  // =============================================================================
  
  /**
   * Get local media stream (combined audio/video)
   */
  getLocalStream(): MediaStream | null {
    if (!this.room?.localParticipant) return null;
    
    const stream = new MediaStream();
    
    // Add audio tracks
    for (const publication of this.room.localParticipant.audioTrackPublications.values()) {
      if (publication.track?.mediaStreamTrack) {
        stream.addTrack(publication.track.mediaStreamTrack);
      }
    }
    
    // Add video tracks
    for (const publication of this.room.localParticipant.videoTrackPublications.values()) {
      if (publication.track?.mediaStreamTrack) {
        stream.addTrack(publication.track.mediaStreamTrack);
      }
    }
    
    return stream.getTracks().length > 0 ? stream : null;
  }
  
  /**
   * Get user's stream (both local and remote)
   */
  getUserStream(userId: string): MediaStream | null {
    if (!this.room) return null;
    
    // Handle local participant
    if (userId === this.currentUserId) {
      return this.getLocalStream();
    }
    
    // Handle remote participant - try by userId first, then by mapped identity
    let participant = this.room.remoteParticipants.get(userId);
    if (!participant) {
      // Try looking up by identity (for federated users where userId is a UUID but identity is federated:...)
      const identity = uuidToIdentityCache.get(userId);
      if (identity) {
        participant = this.room.remoteParticipants.get(identity);
      }
    }
    if (!participant) return null;
    
    const stream = new MediaStream();
    
    // Add audio tracks
    for (const publication of participant.audioTrackPublications.values()) {
      if (publication.track?.mediaStreamTrack) {
        stream.addTrack(publication.track.mediaStreamTrack);
      }
    }
    
    // Add video tracks
    for (const publication of participant.videoTrackPublications.values()) {
      if (publication.track?.mediaStreamTrack) {
        stream.addTrack(publication.track.mediaStreamTrack);
      }
    }
    
    return stream.getTracks().length > 0 ? stream : null;
  }

  /**
   * Attach video track to a video element using LiveKit's proper attachment method.
   * This is REQUIRED for adaptive streaming to work correctly!
   * When using srcObject directly, LiveKit doesn't know the video is being consumed
   * and may disable all simulcast layers.
   */
  attachVideoToElement(userId: string, videoElement: HTMLVideoElement): boolean {
    if (!this.room) {
      debug.warn('📺 [LiveKit] attachVideoToElement: No room');
      return false;
    }
    
    // For local participant
    if (userId === this.currentUserId) {
      const localParticipant = this.room.localParticipant;
      debug.log('📺 [LiveKit] Attaching local video, publications:', localParticipant.videoTrackPublications.size);
      for (const publication of localParticipant.videoTrackPublications.values()) {
        debug.log('📺 [LiveKit] Local publication:', publication.trackSid, 'track exists:', !!publication.track);
        if (publication.track) {
          // Use LiveKit's attach method for proper adaptive streaming
          publication.track.attach(videoElement);
          debug.log('📺 [LiveKit] Attached local video to element');
          return true;
        }
      }
      debug.warn('📺 [LiveKit] No local video track to attach');
      return false;
    }
    
    // For remote participant - try by userId first, then by mapped identity
    let participant = this.room.remoteParticipants.get(userId);
    if (!participant) {
      const identity = uuidToIdentityCache.get(userId);
      if (identity) {
        participant = this.room.remoteParticipants.get(identity);
      }
    }
    if (!participant) {
      debug.warn('📺 [LiveKit] attachVideoToElement: Participant not found:', userId);
      return false;
    }
    
    debug.log('📺 [LiveKit] Attaching remote video for:', userId, 'publications:', participant.videoTrackPublications.size);
    
    for (const publication of participant.videoTrackPublications.values()) {
      debug.log('📺 [LiveKit] Remote publication:', publication.trackSid, 
        'isSubscribed:', publication.isSubscribed, 
        'track exists:', !!publication.track,
        'trackName:', publication.trackName);
      
      if (publication.track) {
        // Use LiveKit's attach method for proper adaptive streaming
        publication.track.attach(videoElement);
        debug.log('📺 [LiveKit] ✅ Attached remote video to element for:', userId);
        return true;
      }
    }
    
    debug.warn('📺 [LiveKit] No subscribed video track to attach for:', userId);
    return false;
  }

  /**
   * Detach video from element
   */
  detachVideoFromElement(userId: string, videoElement: HTMLVideoElement): void {
    if (!this.room) return;
    
    // For local participant
    if (userId === this.currentUserId) {
      const localParticipant = this.room.localParticipant;
      for (const publication of localParticipant.videoTrackPublications.values()) {
        if (publication.track) {
          publication.track.detach(videoElement);
        }
      }
      return;
    }
    
    // For remote participant - try by userId first, then by mapped identity
    let participant = this.room.remoteParticipants.get(userId);
    if (!participant) {
      const identity = uuidToIdentityCache.get(userId);
      if (identity) {
        participant = this.room.remoteParticipants.get(identity);
      }
    }
    if (!participant) return;
    
    for (const publication of participant.videoTrackPublications.values()) {
      if (publication.track) {
        publication.track.detach(videoElement);
      }
    }
  }
  
  /**
   * Get local media state
   */
  getLocalState(): UserMediaState {
    return { ...this.localMediaState };
  }
  
  /**
   * Get all remote user states
   * Note: We store states by both UUID and identity (for federated users),
   * so we need to deduplicate by userId
   */
  getAllUsers(): UserMediaState[] {
    const seen = new Set<string>();
    const result: UserMediaState[] = [];
    
    for (const state of this.allUserStates.values()) {
      if (!seen.has(state.userId)) {
        seen.add(state.userId);
        result.push(state);
      }
    }
    
    return result;
  }
  
  // =============================================================================
  // ROOM EVENT HANDLING
  // =============================================================================
  
  /**
   * Sync existing participants in the room (called after connecting)
   * This handles participants who were already in the room before we joined
   */
  private async syncExistingParticipants(): Promise<void> {
    if (!this.room) {
      debug.warn('⚠️ [LiveKit] syncExistingParticipants called but no room');
      return;
    }
    
    const existingParticipants = this.room.remoteParticipants;
    debug.log(`🔄 [LiveKit] Syncing ${existingParticipants.size} existing participants`);
    debug.log(`🔄 [LiveKit] Room state: ${this.room.state}, local participant: ${this.room.localParticipant?.identity}`);
    
    if (existingParticipants.size === 0) {
      debug.log('📭 [LiveKit] No existing participants to sync');
      return;
    }
    
    // Process each participant and resolve their identity
    for (const participant of existingParticipants.values()) {
      debug.log(`👤 [LiveKit] Found existing participant: ${participant.identity}, sid: ${participant.sid}`);
      
      // Resolve federated identity to profile UUID
      const userId = await resolveIdentityToUuid(participant.identity, this.remoteServerDomain);
      
      if (!userId) {
        debug.warn(`⚠️ [LiveKit] Could not resolve identity for existing participant: ${participant.identity}`);
        // Store by identity for internal use but skip emitting events
        const mediaState = this.createMediaState(participant, participant.identity);
        this.allUserStates.set(participant.identity, mediaState);
        this.setupParticipantListeners(participant);
        continue;
      }
      
      const mediaState = this.createMediaState(participant, userId);
      this.allUserStates.set(userId, mediaState);
      if (userId !== participant.identity) {
        this.allUserStates.set(participant.identity, mediaState);
      }
      debug.log(`👤 [LiveKit] Added to allUserStates, total: ${this.allUserStates.size}`);
      
      // Setup listeners for this participant
      this.setupParticipantListeners(participant);
      
      // Emit user-joined event so the store knows about them
      this.emit('user-joined', { userId, mediaState });
      
      // CRITICAL: Also emit stream change for existing tracks (video/screenshare)
      // This ensures late-joiners can see video that was already streaming
      const hasExistingTracks = participant.videoTrackPublications.size > 0 || 
                                 participant.audioTrackPublications.size > 0;
      if (hasExistingTracks) {
        debug.log(`📺 [LiveKit] Syncing existing tracks for ${userId}: ` +
          `video=${participant.videoTrackPublications.size}, audio=${participant.audioTrackPublications.size}`);
        
        const stream = this.getUserStream(userId);
        this.emit('user-stream-changed', { userId, stream });
        this.emit('user-state-changed', { userId, mediaState });
      }
    }
    
    debug.log(`✅ [LiveKit] Sync complete. Total users tracked: ${this.allUserStates.size}`);
  }
  
  /**
   * Setup LiveKit room event listeners
   */
  private setupRoomListeners(): void {
    if (!this.room) return;
    
    // Connection state changes
    this.room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
      debug.log('🔗 [LiveKit] Connection state:', state);
      this.emit('connection-state-changed', { state });
    });
    
    // Participant connected
    this.room.on(RoomEvent.ParticipantConnected, async (participant: RemoteParticipant) => {
      debug.log('👋 [LiveKit] Participant connected:', participant.identity);
      
      // Resolve federated identity to profile UUID
      const userId = await resolveIdentityToUuid(participant.identity, this.remoteServerDomain);
      if (!userId) {
        debug.warn(`⚠️ [LiveKit] Could not resolve identity for connected participant: ${participant.identity}`);
        return; // Skip unresolvable participants
      }
      
      const mediaState = this.createMediaState(participant, userId);
      // Store by resolved UUID, but keep identity mapping for internal lookups
      this.allUserStates.set(userId, mediaState);
      // Also store by identity for internal LiveKit operations
      if (userId !== participant.identity) {
        this.allUserStates.set(participant.identity, mediaState);
      }
      
      this.setupParticipantListeners(participant);
      
      this.emit('user-joined', { userId, mediaState });
      this.emit('channel-state-synced', { users: this.getAllUsers() });
    });
    
    // Participant disconnected
    this.room.on(RoomEvent.ParticipantDisconnected, async (participant: RemoteParticipant) => {
      debug.log('👋 [LiveKit] Participant disconnected:', participant.identity);
      
      // Resolve federated identity to profile UUID
      const userId = await resolveIdentityToUuid(participant.identity, this.remoteServerDomain);
      
      // Always clean up by identity at minimum
      this.allUserStates.delete(participant.identity);
      
      if (userId) {
        this.allUserStates.delete(userId);
        this.emit('user-left', { userId });
      }
      
      this.emit('channel-state-synced', { users: this.getAllUsers() });
    });
    
    // Track subscribed
    this.room.on(RoomEvent.TrackSubscribed, async (track: RemoteTrack, publication: TrackPublication, participant: RemoteParticipant) => {
      const source = publication.source;
      debug.log('📺 [LiveKit] Track subscribed:', track.kind, 'source:', source, 'from', participant.identity);
      
      // Resolve federated identity to profile UUID
      const userId = await resolveIdentityToUuid(participant.identity, this.remoteServerDomain);
      // Use identity as fallback for internal lookups only
      const lookupId = userId || participant.identity;
      
      // Update user state - check both possible keys
      let state = this.allUserStates.get(lookupId) || this.allUserStates.get(participant.identity);
      if (state) {
        if (track.kind === Track.Kind.Audio) {
          state.isAudioEnabled = true;
          
          // Auto-attach audio tracks to play them
          // This is crucial for screenshare audio!
          if (track instanceof RemoteAudioTrack) {
            const audioElement = track.attach();
            audioElement.volume = 1.0; // Default volume
            debug.log('🔊 [LiveKit] Audio track attached for:', lookupId, 'source:', source);
            
            // Store reference for volume control later
            if (source === Track.Source.ScreenShareAudio) {
              debug.log('🔊 [LiveKit] Screenshare audio attached for:', lookupId);
            }
          }
        } else if (track.kind === Track.Kind.Video) {
          state.isVideoEnabled = true;
          // Check if it's screenshare video
          if (source === Track.Source.ScreenShare) {
            state.isScreenSharing = true;
          }
        }
        this.allUserStates.set(lookupId, state);
      }
      
      // Only emit events if we have a valid UUID
      if (userId) {
        const stream = this.getUserStream(userId);
        this.emit('user-stream-changed', { userId, stream });
        this.emit('user-state-changed', { userId, mediaState: state });
      }
    });
    
    // Track unsubscribed
    this.room.on(RoomEvent.TrackUnsubscribed, async (track: RemoteTrack, publication: TrackPublication, participant: RemoteParticipant) => {
      const source = publication.source;
      debug.log('📺 [LiveKit] Track unsubscribed:', track.kind, 'source:', source, 'from', participant.identity);
      
      // Resolve federated identity to profile UUID
      const userId = await resolveIdentityToUuid(participant.identity, this.remoteServerDomain);
      const lookupId = userId || participant.identity;
      
      // Detach audio track
      if (track.kind === Track.Kind.Audio && track instanceof RemoteAudioTrack) {
        track.detach();
        debug.log('🔊 [LiveKit] Audio track detached for:', lookupId);
      }
      
      // Update user state - check both possible keys
      let state = this.allUserStates.get(lookupId) || this.allUserStates.get(participant.identity);
      if (state) {
        if (track.kind === Track.Kind.Audio) {
          // Only set audio disabled if it's the microphone, not screenshare audio
          if (source !== Track.Source.ScreenShareAudio) {
            state.isAudioEnabled = false;
          }
        } else if (track.kind === Track.Kind.Video) {
          // Check if it's screenshare ending
          if (source === Track.Source.ScreenShare) {
            state.isScreenSharing = false;
          } else {
            state.isVideoEnabled = false;
          }
        }
        this.allUserStates.set(lookupId, state);
      }
      
      // Only emit events if we have a valid UUID
      if (userId) {
        const stream = this.getUserStream(userId);
        this.emit('user-stream-changed', { userId, stream });
        this.emit('user-state-changed', { userId, mediaState: state });
      }
    });
    
    // Active speaker changes
    this.room.on(RoomEvent.ActiveSpeakersChanged, (speakers: RemoteParticipant[]) => {
      // Get a set of speaker identities for fast lookup
      const speakerIdentities = new Set(speakers.map(s => s.identity));
      
      // Track which resolved userIds we've already processed to avoid duplicates
      const processedUserIds = new Set<string>();
      
      // Update speaking state for all users
      for (const [key, state] of this.allUserStates) {
        // Skip if we've already processed this userId (we store by both UUID and identity)
        if (processedUserIds.has(state.userId)) {
          continue;
        }
        processedUserIds.add(state.userId);
        
        // Check if this user is speaking - compare against both the key and any mapped identity
        const identity = uuidToIdentityCache.get(state.userId) || state.userId;
        const isSpeaking = speakerIdentities.has(identity) || speakerIdentities.has(key);
        
        if (state.isSpeaking !== isSpeaking) {
          state.isSpeaking = isSpeaking;
          state.audioLevel = isSpeaking ? 50 : 0; // Approximate level
          this.allUserStates.set(key, state);
          // Use state.userId (resolved UUID) for events
          this.emit('audio-level', { userId: state.userId, level: state.audioLevel });
        }
      }
    });
    
    // Disconnected
    this.room.on(RoomEvent.Disconnected, (reason?: string) => {
      debug.log('🔌 [LiveKit] Disconnected:', reason);
      this.emit('channel-left', { channelId: this.channelId, reason });
    });
    
    // Error
    this.room.on(RoomEvent.MediaDevicesError, (error: Error) => {
      debug.error('❌ [LiveKit] Media devices error:', error);
      this.emit('error', error);
    });
    
    // Data received (for custom messaging like media state)
    this.room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant) => {
      try {
        const message = JSON.parse(new TextDecoder().decode(payload));
        
        if (message.type === 'media-state' && participant) {
          const state = this.allUserStates.get(participant.identity);
          if (state) {
            Object.assign(state, message.data);
            this.allUserStates.set(participant.identity, state);
            // Use state.userId (resolved UUID) instead of identity for events
            this.emit('user-state-changed', { userId: state.userId, mediaState: state });
          }
        }
      } catch (error) {
        debug.warn('⚠️ [LiveKit] Failed to parse data message');
      }
    });
    
    // Note: Initial sync is handled by syncExistingParticipants() which properly resolves identities
    // Don't emit here - let the caller handle it after connecting
  }
  
  /**
   * Setup event listeners for a specific participant
   */
  private setupParticipantListeners(participant: RemoteParticipant): void {
    // Track muted
    participant.on(ParticipantEvent.TrackMuted, (publication: TrackPublication) => {
      const state = this.allUserStates.get(participant.identity);
      if (state && publication.kind === Track.Kind.Audio) {
        state.isMuted = true;
        this.allUserStates.set(participant.identity, state);
        // Use state.userId (resolved UUID) instead of identity for events
        this.emit('user-state-changed', { userId: state.userId, mediaState: state });
      }
    });
    
    // Track unmuted
    participant.on(ParticipantEvent.TrackUnmuted, (publication: TrackPublication) => {
      const state = this.allUserStates.get(participant.identity);
      if (state && publication.kind === Track.Kind.Audio) {
        state.isMuted = false;
        this.allUserStates.set(participant.identity, state);
        // Use state.userId (resolved UUID) instead of identity for events
        this.emit('user-state-changed', { userId: state.userId, mediaState: state });
      }
    });
    
    // Speaking changed
    participant.on(ParticipantEvent.IsSpeakingChanged, (speaking: boolean) => {
      const state = this.allUserStates.get(participant.identity);
      if (state) {
        state.isSpeaking = speaking;
        state.audioLevel = speaking ? 50 : 0;
        this.allUserStates.set(participant.identity, state);
        // Use state.userId (resolved UUID) instead of identity for events
        this.emit('audio-level', { userId: state.userId, level: state.audioLevel });
      }
    });
  }
  
  /**
   * Create initial media state for a participant
   * @param participant - The remote participant
   * @param resolvedUserId - Optional resolved UUID (for federated users). If not provided, uses participant.identity
   */
  private createMediaState(participant: RemoteParticipant, resolvedUserId?: string): UserMediaState {
    return {
      userId: resolvedUserId || participant.identity,
      isAudioEnabled: participant.audioTrackPublications.size > 0,
      isVideoEnabled: participant.videoTrackPublications.size > 0,
      isScreenSharing: false, // LiveKit tracks this separately
      isMuted: false,
      isDeafened: false,
      isSpeaking: participant.isSpeaking,
      audioLevel: 0,
    };
  }
  
  /**
   * Broadcast local media state to all participants
   */
  private broadcastMediaState(): void {
    if (!this.room?.localParticipant) return;
    
    const message = {
      type: 'media-state',
      data: {
        isMuted: this.localMediaState.isMuted,
        isDeafened: this.localMediaState.isDeafened,
        isVideoEnabled: this.localMediaState.isVideoEnabled,
        isScreenSharing: this.localMediaState.isScreenSharing,
      },
    };
    
    try {
      const encoder = new TextEncoder();
      this.room.localParticipant.publishData(encoder.encode(JSON.stringify(message)), { reliable: true });
    } catch (error) {
      debug.warn('⚠️ [LiveKit] Failed to broadcast media state');
    }
  }
  
  // =============================================================================
  // DEVICE MANAGEMENT
  // =============================================================================
  
  /**
   * Load audio settings from localStorage
   */
  private loadAudioSettings(): void {
    try {
      const settings = localStorage.getItem('harmony_audio_settings');
      if (settings) {
        const parsed = JSON.parse(settings);
        this.selectedInputDevice = parsed.inputDevice || null;
        this.selectedOutputDevice = parsed.outputDevice || null;
        this.selectedVideoDevice = parsed.videoDevice || null;
        
        if (parsed.echoCancellation !== undefined) {
          this.audioConstraints.echoCancellation = parsed.echoCancellation;
        }
        if (parsed.noiseSuppression !== undefined) {
          this.audioConstraints.noiseSuppression = parsed.noiseSuppression;
        }
        if (parsed.autoGainControl !== undefined) {
          this.audioConstraints.autoGainControl = parsed.autoGainControl;
        }
      }
    } catch (error) {
      debug.warn('⚠️ [LiveKit] Failed to load audio settings');
    }
  }
  
  /**
   * Get selected devices
   */
  getSelectedDevices(): { inputDevice: string | null; outputDevice: string | null; videoDevice: string | null } {
    return {
      inputDevice: this.selectedInputDevice,
      outputDevice: this.selectedOutputDevice,
      videoDevice: this.selectedVideoDevice,
    };
  }
  
  /**
   * Update input device
   */
  async updateInputDevice(deviceId: string): Promise<void> {
    this.selectedInputDevice = deviceId;
    
    if (this.room?.localParticipant) {
      // Switch active microphone
      await this.room.switchActiveDevice('audioinput', deviceId);
    }
  }
  
  /**
   * Update output device
   */
  async updateOutputDevice(deviceId: string): Promise<void> {
    this.selectedOutputDevice = deviceId;
    
    if (this.room) {
      // Switch audio output
      await this.room.switchActiveDevice('audiooutput', deviceId);
    }
  }
  
  /**
   * Update video device
   */
  async updateVideoDevice(deviceId: string): Promise<void> {
    this.selectedVideoDevice = deviceId;
    
    if (this.room?.localParticipant && this.localMediaState.isVideoEnabled) {
      // Switch active camera
      await this.room.switchActiveDevice('videoinput', deviceId);
    }
  }
  
  // =============================================================================
  // E2EE (End-to-End Encryption)
  // =============================================================================
  
  /**
   * Enable E2EE for the room
   */
  async enableE2EE(sharedKey: Uint8Array): Promise<void> {
    if (!this.room) {
      throw new Error('No room connected');
    }
    
    try {
      // Create key provider if not exists
      if (!this.e2eeKeyProvider) {
        this.e2eeKeyProvider = new ExternalE2EEKeyProvider();
      }
      
      // Set the shared key
      await this.e2eeKeyProvider.setKey(sharedKey);
      
      // Enable E2EE on the room
      await this.room.setE2EEEnabled(true);
      
      debug.log('🔐 [LiveKit] E2EE enabled');
    } catch (error) {
      debug.error('❌ [LiveKit] Failed to enable E2EE:', error);
      throw error;
    }
  }
  
  /**
   * Disable E2EE
   */
  async disableE2EE(): Promise<void> {
    if (!this.room) return;
    
    try {
      await this.room.setE2EEEnabled(false);
      debug.log('🔓 [LiveKit] E2EE disabled');
    } catch (error) {
      debug.error('❌ [LiveKit] Failed to disable E2EE:', error);
    }
  }
  
  // =============================================================================
  // EVENT SYSTEM
  // =============================================================================
  
  /**
   * Subscribe to an event
   */
  on(event: string, callback: Function): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(callback);
  }
  
  /**
   * Unsubscribe from an event
   */
  off(event: string, callback: Function): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(callback);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  }
  
  /**
   * Emit an event
   */
  private emit(event: string, data?: any): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          debug.error(`Error in ${event} listener:`, error);
        }
      });
    }
  }
  
  // =============================================================================
  // UTILITY METHODS
  // =============================================================================
  
  /**
   * Check if currently connected to a channel
   */
  isConnected(): boolean {
    return this.room?.state === ConnectionState.Connected;
  }
  
  /**
   * Get current channel ID
   */
  getCurrentChannelId(): string | null {
    return this.channelId;
  }
  
  /**
   * Get room statistics
   */
  getStats(): any {
    if (!this.room) return null;
    
    return {
      numParticipants: this.room.remoteParticipants.size + 1,
      connectionQuality: this.room.localParticipant?.connectionQuality,
    };
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const livekitWebRTC = new LiveKitWebRTCService();
export default livekitWebRTC;

