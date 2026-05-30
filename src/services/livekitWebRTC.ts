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
  LocalAudioTrack,
  RemoteTrack,
  RemoteAudioTrack,
  VideoPresets,
  createLocalAudioTrack,
  createLocalVideoTrack,
  setLogLevel,
  LogLevel,
  ExternalE2EEKeyProvider,
} from 'livekit-client';
import { supabase } from '@/supabase';
import { debug } from '@/utils/debug';
import { userStorage } from '@/utils/userScopedStorage';
import { VoiceSettingsService } from './VoiceSettingsService';
import {
  voiceE2EEService,
  electKeyCoordinator,
  type VoiceKeyEnvelope,
} from './encryption/VoiceE2EEService';

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
  
  // Parse the federated ID to extract domain and username
  let federatedUrl: URL;
  try {
    federatedUrl = new URL(federatedId);
  } catch {
    debug.warn(`🌐 [LiveKit] Invalid federated ID URL: ${federatedId}`);
    return null;
  }
  
  const federatedDomain = federatedUrl.hostname;
  const pathParts = federatedUrl.pathname.split('/').filter(p => p);
  const username = pathParts[pathParts.length - 1]; // Last part of /users/username
  
  // Check if this is a local user (federated ID domain matches our instance)
  const currentDomain = window.location.hostname;
  const isLocalUser = federatedDomain === currentDomain;
  
  // Look up the user by federated_id first
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
    
    // If it's a local user, try looking up by username (local users don't have federated_id set)
    if (isLocalUser && username) {
      const { data: localUser } = await supabase
        .from('profiles')
        .select('id')
        .eq('username', username)
        .eq('is_local', true)
        .maybeSingle();
      
      if (localUser?.id) {
        federatedIdToUuidCache.set(federatedId, localUser.id);
        uuidToIdentityCache.set(localUser.id, originalIdentity);
        debug.log(`🌐 [LiveKit] Resolved local user ${username} to UUID ${localUser.id}`);
        return localUser.id;
      }
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
  
  // Remote audio elements (for deafen/volume control)
  // Separated by type for independent volume control
  private remoteMicAudioElements = new Map<string, HTMLAudioElement>();
  private remoteScreenShareAudioElements = new Map<string, HTMLAudioElement>();
  
  // When true, mic audio elements are muted (spatial audio is handling playback)
  private traditionalAudioMuted = false;
  
  // Volume settings (0-200, 100 = normal)
  private userMicVolumes = new Map<string, number>();
  private userScreenShareVolumes = new Map<string, number>();
  
  // Stream quality settings (applied to new tracks and updated live)
  private streamQualitySettings = {
    resolution: 720,    // Default 720p
    frameRate: 30,      // Default 30fps
    audioBitrate: 128,  // Default 128kbps
  };
  
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
  
  // E2EE key provider + worker (LiveKit requires both at Room construction)
  private e2eeKeyProvider: ExternalE2EEKeyProvider | null = null;
  private e2eeWorker: Worker | null = null;
  private e2eeEnabled = false;
  // Voice E2EE key distribution (Model S: shared room key over Megolm)
  private e2eeRequired = false;        // E2EE was requested for this join
  private e2eeRoomKey: Uint8Array | null = null;
  private e2eeKeyId: string | null = null;
  private e2eeKeyReady = false;
  private lastKeyEnvelope: VoiceKeyEnvelope | null = null;
  private megolmKeyRetryHandler: (() => void) | null = null;
  private readonly E2EE_DATA_TOPIC = 'harmony-e2ee';
  
  // LiveKit config cache
  private configCache: LiveKitConfig | null = null;
  private configCacheTime = 0;
  private readonly CONFIG_CACHE_TTL = 60000; // 1 minute
  
  constructor() {
    this.loadAudioSettings();
    this.loadStreamQualitySettings();
  }

  /**
   * Get LiveKit VideoResolution preset for a given resolution value
   * @param resolution - Resolution in pixels (360, 480, 720, 1080, or -1 for source)
   */
  private getResolutionPreset(resolution: number): { width: number; height: number; frameRate: number } {
    switch (resolution) {
      case 360:
        return { width: 640, height: 360, frameRate: 30 };
      case 480:
        return { width: 854, height: 480, frameRate: 30 };
      case 720:
        // VideoPresets.*.resolution has frameRate as optional in the lib types,
        // but presets always provide it; cast to the stricter shape.
        return VideoPresets.h720.resolution as { width: number; height: number; frameRate: number };
      case 1080:
        return VideoPresets.h1080.resolution as { width: number; height: number; frameRate: number };
      case -1: // Source/Native - use 1080p as max
        return VideoPresets.h1080.resolution as { width: number; height: number; frameRate: number };
      default: {
        const height = resolution;
        const width = Math.round(height * 16 / 9);
        return { width, height, frameRate: 30 };
      }
    }
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
  async joinChannel(channelId: string, userId: string, roomType: 'voice_channel' | 'dm_call' | 'stage' = 'voice_channel', abortSignal?: AbortSignal, requireE2EE = false): Promise<boolean> {
    debug.log('🎯 [LiveKit] Joining voice channel:', channelId, 'as user:', userId, 'E2EE:', requireE2EE);
    
    try {
      // Check for cancellation
      if (abortSignal?.aborted) {
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      // Clean previous connection
      if (this.room) {
        await this.leaveChannel();
      }
      
      // Check for cancellation after cleanup
      if (abortSignal?.aborted) {
        throw new DOMException('Connection cancelled', 'AbortError');
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
      
      // Check for cancellation after getting token
      if (abortSignal?.aborted) {
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      // Prepare E2EE. The key itself is NOT known yet — it's a random shared
      // room key distributed server-blind over Megolm after we connect (see
      // initVoiceE2EE). LiveKit needs the worker + key provider wired up front
      // at Room construction, so we set those up here when E2EE is requested
      // and this client is capable of participating.
      this.e2eeRequired = requireE2EE && voiceE2EEService.canParticipate();
      if (requireE2EE && !this.e2eeRequired) {
        // Caller asked for E2EE but this client can't do it. The store gates on
        // this before joining, so reaching here means a race; refuse cleanly.
        throw new Error('Voice end-to-end encryption is required but not available on this device');
      }
      const e2eeOptions = this.e2eeRequired ? await this.setupE2EEOptions() : null;
      
      // Create room with options
      this.room = new Room({
        adaptiveStream: true,
        dynacast: true,
        ...(e2eeOptions ? { e2ee: e2eeOptions } : {}),
      });
      
      // Setup room event listeners
      this.setupRoomListeners();
      this.e2eeEnabled = false;
      this.e2eeKeyReady = false;
      
      // Connect to LiveKit server
      // Use relay-only ICE to avoid browser "local network" prompt
      // No latency impact since traffic goes through LiveKit SFU server anyway
      await this.room.connect(tokenResponse.wsUrl, tokenResponse.token, {
        autoSubscribe: true,
        // rtcConfig: {
        //   iceTransportPolicy: 'relay',
        // },
      });
      
      // Check for cancellation after connecting
      if (abortSignal?.aborted) {
        await this.leaveChannel();
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      debug.log('✅ [LiveKit] Connected to room:', roomName);
      
      // Sync existing participants (they don't trigger ParticipantConnected event)
      await this.syncExistingParticipants();
      
      // Check for cancellation after syncing participants
      if (abortSignal?.aborted) {
        await this.leaveChannel();
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      // Establish the shared E2EE key BEFORE publishing media, so the very
      // first frames we send are encrypted with the agreed key. If we can't
      // agree on a key in time, refuse rather than leak plaintext into a room
      // that's supposed to be encrypted.
      if (this.e2eeRequired) {
        const keyed = await this.initVoiceE2EE();
        if (!keyed) {
          await this.leaveChannel();
          throw new Error('Could not establish a shared encryption key for this call');
        }
      }
      
      // Publish local audio track
      await this.publishLocalAudio();
      
      // Final cancellation check
      if (abortSignal?.aborted) {
        await this.leaveChannel();
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      this.emit('channel-joined', { channelId, userId });
      this.emit('local-state-changed', this.localMediaState);
      
      // Emit channel state sync with all users including existing ones
      this.emit('channel-state-synced', { users: this.getAllUsers() });
      
      return true;
    } catch (error) {
      // Check if this was a cancellation
      if (error instanceof DOMException && error.name === 'AbortError') {
        debug.log('🚫 [LiveKit] Connection cancelled');
        // BUGS.md H23: cancellation paths already call `leaveChannel()`
        // inline; this catch only sees the error after they've torn down.
        // Non-AbortError failures below still need explicit cleanup so a
        // half-constructed Room / its event listeners don't leak.
        throw error; // Re-throw to propagate cancellation
      }
      debug.error('❌ [LiveKit] Failed to join channel:', error);
      // BUGS.md H23: previously the catch only logged + emitted. The Room
      // was instantiated (`this.room = new Room(...)`) and its listeners
      // were registered BEFORE `room.connect()` was awaited. A connect
      // failure left both the Room object and the listeners alive,
      // accumulating across retries. Tear down before returning.
      try {
        await this.leaveChannel();
      } catch (cleanupErr) {
        debug.warn('⚠️ [LiveKit] join-failure cleanup also failed:', cleanupErr);
      }
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
      try {
        await this.room.disconnect(true);
      } catch (e) {
        debug.warn('⚠️ [LiveKit] Room disconnect error (forcing cleanup):', e);
      }
      this.room = null;
    }
    
    // Clear state
    this.allUserStates.clear();
    this.remoteMicAudioElements.clear();
    this.remoteScreenShareAudioElements.clear();
    this.userMicVolumes.clear();
    this.userScreenShareVolumes.clear();
    this.traditionalAudioMuted = false;
    
    if (this.megolmKeyRetryHandler) {
      window.removeEventListener('megolm-key-received', this.megolmKeyRetryHandler);
      this.megolmKeyRetryHandler = null;
    }
    this.e2eeRequired = false;
    this.e2eeRoomKey = null;
    this.e2eeKeyId = null;
    this.e2eeKeyReady = false;
    this.lastKeyEnvelope = null;
    if (this.e2eeEnabled) {
      this.e2eeEnabled = false;
      this.emit('e2ee-status-changed', { enabled: false });
    }
    
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
      
      // Convert kbps to bps for LiveKit (settings stored in kbps, LiveKit expects bps)
      const audioBitrateBps = (this.streamQualitySettings.audioBitrate || 128) * 1000;
      
      // audioBitrate isn't on the official TrackPublishOptions type, but LiveKit
      // accepts it at runtime. Cast to any to avoid the type check.
      await this.room.localParticipant.publishTrack(audioTrack, {
        audioBitrate: audioBitrateBps,
        dtx: true, // Discontinuous transmission for bandwidth saving
        red: true, // Redundant encoding for packet loss resilience
      } as any);
      
      debug.log('🎵 [LiveKit] Published audio with bitrate:', audioBitrateBps, 'bps');
      
      this.localMediaState.isAudioEnabled = true;
      
      // Apply mute state if needed
      if (this.localMediaState.isMuted) {
        audioTrack.mute();
      }
      
      debug.log('✅ [LiveKit] Published local audio track');
    } catch (error) {
      // No microphone available - allow joining but force mute
      debug.warn('⚠️ [LiveKit] No microphone available, joining in muted state:', error);
      this.localMediaState.isMuted = true;
      this.localMediaState.isAudioEnabled = false;
      this.emit('local-state-changed', this.localMediaState);
      // Don't throw - allow join to continue without audio
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
        
        // Enable video with current quality settings
        debug.log('🎥 [LiveKit] Enabling video with settings:', this.streamQualitySettings);
        
        // Build resolution based on saved settings (-1 means source/native)
        const resolution = this.getResolutionPreset(this.streamQualitySettings.resolution);
        
        const videoTrack = await createLocalVideoTrack({
          resolution,
          deviceId: this.selectedVideoDevice || undefined,
          facingMode: 'user',
        });
        
        // Apply frame rate constraint
        if (this.streamQualitySettings.frameRate) {
          try {
            await videoTrack.mediaStreamTrack.applyConstraints({
              frameRate: { ideal: this.streamQualitySettings.frameRate }
            });
          } catch (e) {
            debug.warn('⚠️ [LiveKit] Could not apply frameRate constraint:', e);
          }
        }
        
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
        
        // Log existing tracks before starting new screenshare
        debug.log('📺 [LiveKit] Current audio tracks before screenshare:');
        for (const pub of this.room.localParticipant.audioTrackPublications.values()) {
          debug.log(`  - ${pub.source}: ${pub.trackSid}, muted: ${pub.isMuted}`);
        }
        
        // Use saved resolution for screenshare (-1 = source/1080p, otherwise use user's setting)
        const screenResolution = this.streamQualitySettings.resolution === -1 
          ? VideoPresets.h1080.resolution 
          : this.getResolutionPreset(this.streamQualitySettings.resolution);
        
        const targetFrameRate = this.streamQualitySettings.frameRate;
        const audioBitrateKbps = this.streamQualitySettings.audioBitrate;
        
        debug.log('📺 [LiveKit] Starting screenshare with settings:', {
          resolution: screenResolution,
          frameRate: targetFrameRate,
          audioBitrate: audioBitrateKbps
        });
        
        // Capture options for screenshare
        const captureOptions = {
          audio: {
            // Disable all audio processing for screenshare audio
            // We want RAW audio from the shared tab/window - no normalization
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false, // This is what causes "auto-volume" behavior
          },
          // Request specific framerate during capture
          video: {
            frameRate: targetFrameRate,
          },
          resolution: screenResolution,
          contentHint: 'detail',
          systemAudio: 'include', // Explicitly request system audio
        };
        
        // Publish options with bitrate settings
        const publishOptions = {
          // Video encoding settings
          videoEncoding: {
            maxBitrate: screenResolution.height >= 1080 ? 3_000_000 : 
                        screenResolution.height >= 720 ? 1_500_000 : 800_000,
            maxFramerate: targetFrameRate,
          },
          // Audio bitrate in bits per second
          screenShareAudioBitrate: audioBitrateKbps * 1000,
        };
        
        // captureOptions includes a few non-standard fields (contentHint, systemAudio)
        // that LiveKit forwards to getDisplayMedia; the official type doesn't include
        // them so we widen here.
        await this.room.localParticipant.setScreenShareEnabled(true, captureOptions as any, publishOptions);
        
        // Also try to apply constraints directly to the track for browsers that support it
        for (const pub of this.room.localParticipant.videoTrackPublications.values()) {
          if (pub.source === Track.Source.ScreenShare && pub.track?.mediaStreamTrack) {
            try {
              await pub.track.mediaStreamTrack.applyConstraints({
                frameRate: { min: 15, ideal: targetFrameRate, max: targetFrameRate }
              });
              debug.log('✅ [LiveKit] Applied frameRate constraint to screenshare:', targetFrameRate);
              
              // Log actual track settings - Chrome may impose limits (e.g., 15fps for tab capture)
              const actualSettings = pub.track.mediaStreamTrack.getSettings();
              debug.log('📊 [LiveKit] Actual screenshare track settings:', {
                width: actualSettings.width,
                height: actualSettings.height,
                frameRate: actualSettings.frameRate,
                displaySurface: actualSettings.displaySurface, // 'browser'=tab, 'window', 'monitor'
              });
              
              // Warn if Chrome is limiting FPS (common for tab capture)
              if (actualSettings.frameRate && actualSettings.frameRate < targetFrameRate) {
                debug.warn(`⚠️ [LiveKit] Chrome limited framerate to ${actualSettings.frameRate}fps ` +
                  `(requested ${targetFrameRate}fps). ` +
                  `Note: Tab capture is often capped at ~15fps by Chrome. ` +
                  `Try sharing entire screen or window for higher framerates.`);
              }
            } catch (e) {
              debug.warn('⚠️ [LiveKit] Could not apply additional frameRate constraint:', e);
            }
          }
        }
        
        this.localMediaState.isScreenSharing = true;
        
        // Log all tracks for debugging
        debug.log('📺 [LiveKit] Screen share tracks published:');
        for (const pub of this.room.localParticipant.videoTrackPublications.values()) {
          debug.log(`  - Video: ${pub.source}, trackSid: ${pub.trackSid}`);
        }
        
        // Check if screenshare audio was captured
        let hasScreenShareAudio = false;
        for (const pub of this.room.localParticipant.audioTrackPublications.values()) {
          debug.log(`  - Audio: ${pub.source}, trackSid: ${pub.trackSid}`);
          if (pub.source === Track.Source.ScreenShareAudio) {
            hasScreenShareAudio = true;
            debug.log('🔊 [LiveKit] ✅ Screenshare audio track published!');
          }
        }
        if (!hasScreenShareAudio) {
          debug.warn('⚠️ [LiveKit] No screenshare audio - possible reasons:');
          debug.warn('   1. "Share audio" checkbox not enabled in browser picker');
          debug.warn('   2. Sharing a window (not a tab) - no audio available');
          debug.warn('   3. Browser doesn\'t support system audio capture');
        }
        
        debug.log('✅ [LiveKit] Screen share enabled');
      } else {
        // Disable screen share
        debug.log('📺 [LiveKit] Disabling screen share...');
        
        // Log tracks before disabling
        debug.log('📺 [LiveKit] Tracks before disabling screenshare:');
        for (const pub of this.room.localParticipant.audioTrackPublications.values()) {
          debug.log(`  - Audio ${pub.source}: ${pub.trackSid}`);
        }
        for (const pub of this.room.localParticipant.videoTrackPublications.values()) {
          debug.log(`  - Video ${pub.source}: ${pub.trackSid}`);
        }
        
        await this.room.localParticipant.setScreenShareEnabled(false);
        
        // Log tracks after disabling
        debug.log('📺 [LiveKit] Tracks after disabling screenshare:');
        for (const pub of this.room.localParticipant.audioTrackPublications.values()) {
          debug.log(`  - Audio ${pub.source}: ${pub.trackSid}`);
        }
        for (const pub of this.room.localParticipant.videoTrackPublications.values()) {
          debug.log(`  - Video ${pub.source}: ${pub.trackSid}`);
        }
        
        this.localMediaState.isScreenSharing = false;
        debug.log('✅ [LiveKit] Screen share disabled');
      }
      
      this.broadcastMediaState();
      this.emit('local-state-changed', this.localMediaState);
      this.emit('local-stream-changed', this.getLocalStream());

      return this.localMediaState.isScreenSharing;
    } catch (error) {
      // BUGS.md #8 - when the user dismisses the screen-share picker,
      // `setScreenShareEnabled` throws but spatial-audio listeners had
      // already started flipping audio routing in anticipation of the
      // share. Without this notification, the consumer was leaving both
      // the spatial (wet) graph AND the traditional `<audio>` (dry)
      // playback enabled simultaneously, producing a "two streams at
      // once" effect after a cancel. Emit a state change so listeners
      // can re-derive the correct audio routing.
      debug.error('❌ [LiveKit] Failed to toggle screen share:', error);
      this.localMediaState.isScreenSharing = false;
      this.broadcastMediaState();
      this.emit('local-state-changed', this.localMediaState);
      this.emit('local-stream-changed', this.getLocalStream());
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
   * Set mute state directly (for Push-to-Talk)
   */
  setMuted(muted: boolean): void {
    if (this.localMediaState.isMuted === muted) return; // No change
    
    this.localMediaState.isMuted = muted;
    
    if (this.room?.localParticipant) {
      const audioPublication = this.room.localParticipant.audioTrackPublications.values().next().value;
      if (audioPublication?.track) {
        if (muted) {
          (audioPublication.track as LocalAudioTrack).mute();
        } else {
          (audioPublication.track as LocalAudioTrack).unmute();
        }
      }
    }
    
    this.broadcastMediaState();
    this.emit('local-state-changed', this.localMediaState);
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
    
    // Mute/unmute spatial audio master output if active
    try {
      const { spatialAudioService } = require('@/services/spatialAudio');
      spatialAudioService.setDeafened(this.localMediaState.isDeafened);
    } catch (e) {
      // Spatial audio not available, ignore
    }
    
    // Mute/unmute remote mic audio elements
    // When undeafening, keep muted if spatial audio has taken over (traditionalAudioMuted)
    for (const audioElement of this.remoteMicAudioElements.values()) {
      audioElement.muted = this.localMediaState.isDeafened || this.traditionalAudioMuted;
    }
    // Screen share audio is always traditional (not spatial), only respect deafen
    for (const audioElement of this.remoteScreenShareAudioElements.values()) {
      audioElement.muted = this.localMediaState.isDeafened;
    }
    
    this.broadcastMediaState();
    this.emit('local-state-changed', this.localMediaState);
    
    return this.localMediaState.isDeafened;
  }
  
  // =============================================================================
  // STREAM QUALITY CONTROL
  // =============================================================================
  
  /**
   * Update stream quality settings (resolution, framerate, and audio bitrate)
   * Saves settings and applies to currently active video/screenshare tracks
   */
  async updateStreamQuality(settings: { resolution?: number; frameRate?: number; audioBitrate?: number }): Promise<void> {
    // Save settings for future track creation
    if (settings.resolution !== undefined) {
      this.streamQualitySettings.resolution = settings.resolution;
    }
    if (settings.frameRate !== undefined) {
      this.streamQualitySettings.frameRate = settings.frameRate;
    }
    if (settings.audioBitrate !== undefined) {
      this.streamQualitySettings.audioBitrate = settings.audioBitrate;
    }
    
    debug.log('🎬 [LiveKit] Stream quality settings updated:', this.streamQualitySettings);
    
    if (!this.room?.localParticipant) {
      debug.log('ℹ️ [LiveKit] Not connected - settings saved for next session');
      return;
    }
    
    // Apply to existing video tracks
    if (settings.resolution !== undefined || settings.frameRate !== undefined) {
      let trackCount = 0;
      for (const publication of this.room.localParticipant.videoTrackPublications.values()) {
        const track = publication.track;
        if (!track?.mediaStreamTrack) {
          debug.log('⚠️ [LiveKit] Track publication has no media track:', publication.trackSid);
          continue;
        }
        
        const constraints: MediaTrackConstraints = {};
        
        // Handle resolution (-1 means source/native, use no constraint)
        if (settings.resolution !== undefined && settings.resolution !== -1) {
          constraints.height = { ideal: settings.resolution };
          // Calculate width based on 16:9 aspect ratio
          constraints.width = { ideal: Math.round(settings.resolution * 16 / 9) };
        }
        
        // Handle framerate
        if (settings.frameRate !== undefined) {
          constraints.frameRate = { ideal: settings.frameRate };
        }
        
        if (Object.keys(constraints).length > 0) {
          try {
            // Apply constraints to the underlying media stream track
            debug.log('🎬 [LiveKit] Applying constraints to track:', publication.trackSid, constraints);
            await track.mediaStreamTrack.applyConstraints(constraints);
            trackCount++;
            debug.log('✅ [LiveKit] Applied video constraints to', publication.source);
            
            // Log actual track settings after applying
            const actualSettings = track.mediaStreamTrack.getSettings();
            debug.log('📊 [LiveKit] Actual track settings:', {
              width: actualSettings.width,
              height: actualSettings.height,
              frameRate: actualSettings.frameRate,
            });
          } catch (error) {
            debug.error('❌ [LiveKit] Failed to apply video constraints:', error);
          }
        }
      }
      
      if (trackCount === 0) {
        debug.log('ℹ️ [LiveKit] No active video tracks to apply settings to');
      }
    }
    
    // Note: Audio bitrate in LiveKit is set at track creation time
    // Runtime bitrate changes require republishing the track
    if (settings.audioBitrate !== undefined) {
      debug.log('🎵 [LiveKit] Audio bitrate saved:', settings.audioBitrate, 'kbps');
      debug.log('   Note: Takes effect on next mic enable/reconnect');
    }
  }
  
  /**
   * Load saved stream quality settings from localStorage
   */
  loadStreamQualitySettings(): void {
    try {
      const saved = userStorage.getItem('stream-settings');
      if (saved) {
        const settings = JSON.parse(saved);
        this.streamQualitySettings = {
          resolution: settings.resolution ?? 720,
          frameRate: settings.frameRate ?? 30,
          audioBitrate: settings.audioBitrate ?? 128,
        };
        debug.log('📊 [LiveKit] Loaded stream quality settings:', this.streamQualitySettings);
      }
    } catch (error) {
      debug.warn('⚠️ [LiveKit] Failed to load stream settings:', error);
    }
  }
  
  // =============================================================================
  // VOLUME CONTROL
  // =============================================================================
  
  /**
   * Mute/unmute all remote mic audio elements.
   * Used by spatial audio to silence the dry signal while the wet (spatial) signal plays.
   */
  setTraditionalAudioEnabled(enabled: boolean): void {
    this.traditionalAudioMuted = !enabled;
    debug.log(`🔊 [LiveKit] Setting traditional audio enabled: ${enabled} for ${this.remoteMicAudioElements.size} mic elements`);
    for (const audioElement of this.remoteMicAudioElements.values()) {
      audioElement.muted = !enabled;
    }
  }

  /**
   * Set volume for a user's microphone audio (0-200, 100 = normal)
   */
  setUserMicVolume(participantId: string, volume: number): void {
    const clampedVolume = Math.max(0, Math.min(200, volume));
    this.userMicVolumes.set(participantId, clampedVolume);
    
    // Apply to audio element if it exists
    // Check both by participantId (UUID) and by identity
    const audioElement = this.remoteMicAudioElements.get(participantId) || 
                         this.findAudioElementByResolvedId(participantId, 'mic');
    
    if (audioElement) {
      audioElement.volume = clampedVolume / 100;
      debug.log(`🔊 [LiveKit] Set mic volume for ${participantId} to ${clampedVolume}%`);
    }
  }
  
  /**
   * Set volume for a user's screenshare audio (0-200, 100 = normal)
   */
  setUserScreenShareVolume(participantId: string, volume: number): void {
    const clampedVolume = Math.max(0, Math.min(200, volume));
    this.userScreenShareVolumes.set(participantId, clampedVolume);
    
    // Apply to audio element if it exists
    const audioElement = this.remoteScreenShareAudioElements.get(participantId) ||
                         this.findAudioElementByResolvedId(participantId, 'screenshare');
    
    if (audioElement) {
      audioElement.volume = clampedVolume / 100;
      debug.log(`🔊 [LiveKit] Set screenshare volume for ${participantId} to ${clampedVolume}%`);
    }
  }
  
  /**
   * Get the current mic volume setting for a user (0-200)
   */
  getUserMicVolume(participantId: string): number {
    return this.userMicVolumes.get(participantId) ?? 100;
  }
  
  /**
   * Get the current screenshare volume setting for a user (0-200)
   */
  getUserScreenShareVolume(participantId: string): number {
    return this.userScreenShareVolumes.get(participantId) ?? 100;
  }
  
  /**
   * Helper to find audio element by resolved UUID (since we store by identity)
   */
  private findAudioElementByResolvedId(
    userId: string, 
    type: 'mic' | 'screenshare'
  ): HTMLAudioElement | undefined {
    const map = type === 'mic' ? this.remoteMicAudioElements : this.remoteScreenShareAudioElements;
    
    // Check if userId is stored in the identity-to-UUID cache
    for (const [identity, element] of map.entries()) {
      // Check if this identity resolves to the given userId
      if (uuidToIdentityCache.get(userId) === identity) {
        return element;
      }
    }
    
    return undefined;
  }
  
  /**
   * Check if a user is currently screen sharing (has screenshare audio)
   */
  hasScreenShareAudio(participantId: string): boolean {
    return this.remoteScreenShareAudioElements.has(participantId) ||
           !!this.findAudioElementByResolvedId(participantId, 'screenshare');
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
   * This handles participants who were already in the room before we joined.
   * 
   * NOTE: We only setup the participants here. Track handling is done via
   * TrackSubscribed events which fire for each track as they become available.
   * This is cleaner and faster than polling/delayed syncs.
   */
  private async syncExistingParticipants(): Promise<void> {
    if (!this.room) {
      debug.warn('⚠️ [LiveKit] syncExistingParticipants called but no room');
      return;
    }
    
    const existingParticipants = this.room.remoteParticipants;
    debug.log(`🔄 [LiveKit] Syncing ${existingParticipants.size} existing participants`);
    
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
      
      // For tracks that are ALREADY subscribed, emit state immediately
      // TrackSubscribed events will handle any tracks that subscribe later
      const hasSubscribedTracks = this.hasSubscribedTracks(participant);
      if (hasSubscribedTracks) {
        debug.log(`📺 [LiveKit] Participant ${userId} has already-subscribed tracks, emitting state`);
        const stream = this.getUserStream(userId);
        this.emit('user-stream-changed', { userId, stream });
        // Spread to create new object reference for Vue reactivity
        this.emit('user-state-changed', { userId, mediaState: { ...mediaState } });
      }
    }
    
    debug.log(`✅ [LiveKit] Sync complete. Total users tracked: ${this.allUserStates.size}`);
  }
  
  /**
   * Check if a participant has any subscribed tracks
   */
  private hasSubscribedTracks(participant: RemoteParticipant): boolean {
    for (const pub of participant.videoTrackPublications.values()) {
      if (pub.isSubscribed && pub.track) return true;
    }
    for (const pub of participant.audioTrackPublications.values()) {
      if (pub.isSubscribed && pub.track) return true;
    }
    return false;
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
    
    // E2EE key-distribution messages (Model S shared-key handshake)
    this.room.on(RoomEvent.DataReceived, (payload: Uint8Array, _participant, _kind, topic?: string) => {
      if (topic === this.E2EE_DATA_TOPIC) {
        void this.handleE2EEData(payload);
      }
    });
    
    // Local participant speaking changes (voice activity indicator for ourselves)
    this.room.localParticipant.on(ParticipantEvent.IsSpeakingChanged, (speaking: boolean) => {
      this.localMediaState.isSpeaking = speaking;
      this.localMediaState.audioLevel = speaking ? 50 : 0;
      if (this.currentUserId) {
        this.emit('audio-level', { userId: this.currentUserId, level: this.localMediaState.audioLevel });
      }
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
      
      // Rotate/redistribute the shared E2EE key so the newcomer is included.
      void this.onE2EEMembershipChanged();
    });
    
    // Participant disconnected
    this.room.on(RoomEvent.ParticipantDisconnected, async (participant: RemoteParticipant) => {
      debug.log('👋 [LiveKit] Participant disconnected:', participant.identity);
      
      // Resolve federated identity to profile UUID
      const userId = await resolveIdentityToUuid(participant.identity, this.remoteServerDomain);
      
      // Always clean up by identity at minimum
      this.allUserStates.delete(participant.identity);
      this.remoteMicAudioElements.delete(participant.identity);
      this.remoteScreenShareAudioElements.delete(participant.identity);
      
      if (userId) {
        this.allUserStates.delete(userId);
        // Also clean up screenshare audio by userId key
        this.remoteScreenShareAudioElements.delete(userId);
        this.emit('user-left', { userId });
      }
      
      this.emit('channel-state-synced', { users: this.getAllUsers() });
      
      // Rotate the shared E2EE key so the departed member can't decrypt
      // future media (forward secrecy on leave). The newly-elected coordinator
      // — which may now be us — issues the fresh key.
      void this.onE2EEMembershipChanged();
    });
    
    // Track subscribed - this is the PRIMARY mechanism for receiving remote tracks
    this.room.on(RoomEvent.TrackSubscribed, async (track: RemoteTrack, publication: TrackPublication, participant: RemoteParticipant) => {
      const source = publication.source;
      debug.log('📺 [LiveKit] Track subscribed:', track.kind, 'source:', source, 'from', participant.identity);
      
      // Resolve federated identity to profile UUID
      const userId = await resolveIdentityToUuid(participant.identity, this.remoteServerDomain);
      // Use identity as fallback for internal lookups only
      const lookupId = userId || participant.identity;
      
      // Get or create user state
      let state = this.allUserStates.get(lookupId) || this.allUserStates.get(participant.identity);
      if (!state) {
        // Create state if it doesn't exist (edge case - track subscribed before participant fully registered)
        debug.log('📺 [LiveKit] Creating state for participant during TrackSubscribed:', lookupId);
        state = this.createMediaState(participant, userId || participant.identity);
      }
      
      // Update state based on track type
      if (track.kind === Track.Kind.Audio) {
        state.isAudioEnabled = true;
        
        // Auto-attach REMOTE audio tracks to play them (not our own!)
        if (track instanceof RemoteAudioTrack) {
          const audioElement = track.attach();
          
          const isScreenShareAudio = source === Track.Source.ScreenShareAudio;
          
          // Apply deafen state, and for mic audio also respect spatial audio muting
          if (this.localMediaState.isDeafened || (!isScreenShareAudio && this.traditionalAudioMuted)) {
            audioElement.muted = true;
          }
          
          if (isScreenShareAudio) {
            // Clean up any existing screenshare audio for this participant first
            const existingElement = this.remoteScreenShareAudioElements.get(participant.identity);
            if (existingElement && existingElement !== audioElement) {
              debug.log('🔊 [LiveKit] Cleaning up old screenshare audio element');
              try {
                existingElement.pause();
                existingElement.srcObject = null;
              } catch (e) { /* ignore cleanup errors */ }
            }
            
            // Store new screenshare audio element by BOTH identity AND resolved userId
            // This ensures hasScreenShareAudio() works with either lookup key
            this.remoteScreenShareAudioElements.set(participant.identity, audioElement);
            if (userId && userId !== participant.identity) {
              this.remoteScreenShareAudioElements.set(userId, audioElement);
              debug.log('🔊 [LiveKit] Also storing screenshare audio by userId:', userId);
            }
            
            // Screenshare audio should bypass ALL audio processing
            // No echo cancellation, no noise suppression, no auto gain control
            // This gives us raw, unprocessed audio from the shared screen/tab
            audioElement.setAttribute('data-screenshare-audio', 'true');
            
            // Apply saved screenshare volume or default to 100%
            // Check both identity and userId for saved volume
            const savedVolume = this.userScreenShareVolumes.get(participant.identity) 
              ?? (userId ? this.userScreenShareVolumes.get(userId) : null)
              ?? 100;
            audioElement.volume = savedVolume / 100;
            
            debug.log('🔊 [LiveKit] Screenshare audio attached (raw, no processing) for:', lookupId, 'volume:', savedVolume);
          } else {
            // Clean up any existing mic audio for this participant first  
            const existingElement = this.remoteMicAudioElements.get(participant.identity);
            if (existingElement && existingElement !== audioElement) {
              try {
                existingElement.pause();
                existingElement.srcObject = null;
              } catch (e) { /* ignore cleanup errors */ }
            }
            
            // Store mic audio element
            this.remoteMicAudioElements.set(participant.identity, audioElement);
            
            // Mute if spatial audio has taken over playback
            if (this.traditionalAudioMuted) {
              audioElement.muted = true;
            }
            
            // Apply saved mic volume or default to 100%
            const savedVolume = this.userMicVolumes.get(participant.identity) ?? 100;
            audioElement.volume = savedVolume / 100;
            
            debug.log('🔊 [LiveKit] Mic audio attached for:', lookupId, 'volume:', savedVolume, 'muted:', audioElement.muted);
          }
        }
      } else if (track.kind === Track.Kind.Video) {
        // Check if it's screenshare or camera
        if (source === Track.Source.ScreenShare) {
          state.isScreenSharing = true;
          debug.log('📺 [LiveKit] ScreenShare track subscribed for:', lookupId);
        } else {
          state.isVideoEnabled = true;
          debug.log('📺 [LiveKit] Camera track subscribed for:', lookupId);
        }
      }
      
      // Always save the updated state
      this.allUserStates.set(lookupId, state);
      if (userId && userId !== participant.identity) {
        this.allUserStates.set(participant.identity, state);
      }
      
      // Emit events to update UI - ALWAYS emit when we have a valid UUID
      // Spread to create a NEW object reference so Vue's reactivity detects the change
      if (userId) {
        debug.log('📺 [LiveKit] Emitting state change for:', userId, 'screenSharing:', state.isScreenSharing, 'videoEnabled:', state.isVideoEnabled);
        const stream = this.getUserStream(userId);
        this.emit('user-stream-changed', { userId, stream });
        this.emit('user-state-changed', { userId, mediaState: { ...state } });
      }
    });
    
    // Track unsubscribed
    this.room.on(RoomEvent.TrackUnsubscribed, async (track: RemoteTrack, publication: TrackPublication, participant: RemoteParticipant) => {
      const source = publication.source;
      debug.log('📺 [LiveKit] Track unsubscribed:', track.kind, 'source:', source, 'from', participant.identity);
      
      // Resolve federated identity to profile UUID
      const userId = await resolveIdentityToUuid(participant.identity, this.remoteServerDomain);
      const lookupId = userId || participant.identity;
      
      // Detach audio track and clean up references
      if (track.kind === Track.Kind.Audio && track instanceof RemoteAudioTrack) {
        const isScreenShareAudio = source === Track.Source.ScreenShareAudio;
        
        // Let LiveKit handle the detach
        track.detach();
        
        // Clean up our map reference (both identity and userId keys)
        if (isScreenShareAudio) {
          this.remoteScreenShareAudioElements.delete(participant.identity);
          if (userId && userId !== participant.identity) {
            this.remoteScreenShareAudioElements.delete(userId);
          }
          debug.log('🔊 [LiveKit] Screenshare audio detached for:', lookupId);
        } else {
          this.remoteMicAudioElements.delete(participant.identity);
          debug.log('🔊 [LiveKit] Mic audio detached for:', lookupId);
        }
      }
      
      // Update user state - check both possible keys
      const state = this.allUserStates.get(lookupId) || this.allUserStates.get(participant.identity);
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
      // Spread to create a NEW object reference so Vue's reactivity detects the change
      if (userId && state) {
        const stream = this.getUserStream(userId);
        this.emit('user-stream-changed', { userId, stream });
        this.emit('user-state-changed', { userId, mediaState: { ...state } });
      }
    });
    
    // Active speaker changes (includes both local and remote participants)
    this.room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const speakerIdentities = new Set(speakers.map(s => s.identity));
      
      // Update local participant speaking state
      const localIdentity = this.room?.localParticipant?.identity;
      if (localIdentity && this.currentUserId) {
        const localSpeaking = speakerIdentities.has(localIdentity);
        if (this.localMediaState.isSpeaking !== localSpeaking) {
          this.localMediaState.isSpeaking = localSpeaking;
          this.localMediaState.audioLevel = localSpeaking ? 50 : 0;
          this.emit('audio-level', { userId: this.currentUserId, level: this.localMediaState.audioLevel });
        }
      }
      
      // Track which resolved userIds we've already processed to avoid duplicates
      const processedUserIds = new Set<string>();
      
      // Update speaking state for remote users
      for (const [key, state] of this.allUserStates) {
        if (processedUserIds.has(state.userId)) {
          continue;
        }
        processedUserIds.add(state.userId);
        
        const identity = uuidToIdentityCache.get(state.userId) || state.userId;
        const isSpeaking = speakerIdentities.has(identity) || speakerIdentities.has(key);
        
        if (state.isSpeaking !== isSpeaking) {
          state.isSpeaking = isSpeaking;
          state.audioLevel = isSpeaking ? 50 : 0;
          this.allUserStates.set(key, state);
          this.emit('audio-level', { userId: state.userId, level: state.audioLevel });
        }
      }
    });
    
    // Disconnected
    this.room.on(RoomEvent.Disconnected, (reason?: any) => {
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
            // Spread to create new object reference for Vue reactivity
            this.emit('user-state-changed', { userId: state.userId, mediaState: { ...state } });
          }
        }
      } catch (error) {
        debug.warn('⚠️ [LiveKit] Failed to parse data message');
      }
    });
    
    // LOCAL track unpublished (fires when Chrome's "Stop Sharing" is clicked or track ends)
    this.room.on(RoomEvent.LocalTrackUnpublished, (publication: TrackPublication, _participant: LocalParticipant) => {
      debug.log('📺 [LiveKit] Local track unpublished:', publication.kind, 'source:', publication.source);
      
      // Update local media state based on what was unpublished
      if (publication.kind === Track.Kind.Video) {
        if (publication.source === Track.Source.ScreenShare) {
          debug.log('📺 [LiveKit] Screen share ended (Chrome stop button or track ended)');
          this.localMediaState.isScreenSharing = false;
        } else if (publication.source === Track.Source.Camera) {
          debug.log('📺 [LiveKit] Camera ended');
          this.localMediaState.isVideoEnabled = false;
        }
      } else if (publication.kind === Track.Kind.Audio) {
        if (publication.source === Track.Source.ScreenShareAudio) {
          debug.log('🔊 [LiveKit] Screen share audio ended');
          // No state to update - screenshare audio doesn't have a separate flag
        }
      }
      
      // Emit state change so UI updates (spread for new object reference)
      this.emit('local-state-changed', { ...this.localMediaState });
      
      // Also emit user-stream-changed so remoteStreams in store gets updated
      if (this.currentUserId) {
        const stream = this.getLocalStream();
        this.emit('user-stream-changed', { userId: this.currentUserId, stream });
        this.emit('user-state-changed', { 
          userId: this.currentUserId, 
          mediaState: { ...this.localMediaState } 
        });
      }
      
      debug.log('📺 [LiveKit] Local state after unpublish:', 
        'video:', this.localMediaState.isVideoEnabled, 
        'screen:', this.localMediaState.isScreenSharing);
    });
    
    // Track published by remote user (fires AFTER TrackSubscribed, good for UI notification)
    this.room.on(RoomEvent.TrackPublished, async (publication: TrackPublication, participant: RemoteParticipant) => {
      debug.log('📺 [LiveKit] Remote track published:', publication.kind, 'source:', publication.source, 'from:', participant.identity);
      // This gives us another chance to update UI when remote user publishes a track
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
        // Spread to create new object reference for Vue reactivity
        this.emit('user-state-changed', { userId: state.userId, mediaState: { ...state } });
      }
    });
    
    // Track unmuted
    participant.on(ParticipantEvent.TrackUnmuted, (publication: TrackPublication) => {
      const state = this.allUserStates.get(participant.identity);
      if (state && publication.kind === Track.Kind.Audio) {
        state.isMuted = false;
        this.allUserStates.set(participant.identity, state);
        // Use state.userId (resolved UUID) instead of identity for events
        // Spread to create new object reference for Vue reactivity
        this.emit('user-state-changed', { userId: state.userId, mediaState: { ...state } });
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
    // Check if participant has muted their microphone
    // isMicrophoneEnabled is false when they've muted or don't have a mic track
    const hasMic = participant.audioTrackPublications.size > 0;
    const isMicMuted = hasMic && !participant.isMicrophoneEnabled;
    
    // Check for screen share (source type is ScreenShare)
    let isScreenSharing = false;
    for (const pub of participant.videoTrackPublications.values()) {
      if (pub.source === Track.Source.ScreenShare) {
        isScreenSharing = true;
        break;
      }
    }
    
    return {
      userId: resolvedUserId || participant.identity,
      isAudioEnabled: hasMic,
      isVideoEnabled: participant.isCameraEnabled,
      isScreenSharing,
      isMuted: isMicMuted,
      isDeafened: false, // We can't know if remote user is deafened - they broadcast this via data messages
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
   * Load audio settings from centralized VoiceSettingsService
   */
  private loadAudioSettings(): void {
    try {
      // eslint-disable-next-line unused-imports/no-unused-vars
      const settings = VoiceSettingsService.getAll();
      const devices = VoiceSettingsService.getDevices();
      const constraints = VoiceSettingsService.getAudioConstraints();
      
      this.selectedInputDevice = devices.inputDevice;
      this.selectedOutputDevice = devices.outputDevice;
      this.selectedVideoDevice = devices.videoDevice;
      
      this.audioConstraints.echoCancellation = constraints.echoCancellation;
      this.audioConstraints.noiseSuppression = constraints.noiseSuppression;
      this.audioConstraints.autoGainControl = constraints.autoGainControl;
      
      debug.log('🎛️ [LiveKit] Loaded audio settings from VoiceSettingsService:', {
        devices,
        constraints
      });
    } catch (error) {
      debug.warn('⚠️ [LiveKit] Failed to load audio settings:', error);
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
    VoiceSettingsService.setInputDevice(deviceId);
    
    if (this.room?.localParticipant) {
      // Switch active microphone
      await this.room.switchActiveDevice('audioinput', deviceId);
      debug.log('🎤 [LiveKit] Switched input device to:', deviceId);
    }
  }
  
  /**
   * Update output device
   */
  async updateOutputDevice(deviceId: string): Promise<void> {
    this.selectedOutputDevice = deviceId;
    VoiceSettingsService.setOutputDevice(deviceId);
    
    if (this.room) {
      // Switch audio output
      await this.room.switchActiveDevice('audiooutput', deviceId);
      debug.log('🔊 [LiveKit] Switched output device to:', deviceId);
    }
  }
  
  /**
   * Update video device
   */
  async updateVideoDevice(deviceId: string): Promise<void> {
    this.selectedVideoDevice = deviceId;
    VoiceSettingsService.setVideoDevice(deviceId);
    
    if (this.room?.localParticipant && this.localMediaState.isVideoEnabled) {
      // Switch active camera
      await this.room.switchActiveDevice('videoinput', deviceId);
      debug.log('📹 [LiveKit] Switched video device to:', deviceId);
    }
  }
  
  // =============================================================================
  // E2EE (End-to-End Encryption)
  // =============================================================================
  
  /**
   * Build the E2EE options passed to the `Room` constructor.
   *
   * Returns `{ keyProvider, worker }` ready to encrypt media, or `null` if the
   * environment can't support it (e.g. the crypto worker fails to spin up), in
   * which case the caller proceeds with an unencrypted room.
   */
  private async setupE2EEOptions(): Promise<{ keyProvider: ExternalE2EEKeyProvider; worker: Worker } | null> {
    try {
      if (!this.e2eeKeyProvider) {
        this.e2eeKeyProvider = new ExternalE2EEKeyProvider();
      }
      if (!this.e2eeWorker) {
        // Vite resolves this to the livekit-client e2ee worker bundle.
        this.e2eeWorker = new Worker(
          new URL('livekit-client/e2ee-worker', import.meta.url),
          { type: 'module' }
        );
      }
      return { keyProvider: this.e2eeKeyProvider, worker: this.e2eeWorker };
    } catch (error) {
      debug.warn('⚠️ [LiveKit] Failed to set up E2EE worker, room will be unencrypted:', error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Shared-key distribution (Model S)
  //
  // All participants must hold the same 32-byte room key. A deterministic
  // "coordinator" (smallest participant identity) mints the key ONCE and ships
  // it, Megolm-wrapped, over LiveKit's data channel; everyone else applies what
  // they receive. On membership change the coordinator re-broadcasts the SAME
  // key (re-wrapped for the new member) rather than rotating — regenerating per
  // join desynced peers and triggered MissingKey/InvalidKey. The SFU only ever
  // sees Megolm ciphertext, never the key bytes.
  // ---------------------------------------------------------------------------

  /** Identities of everyone currently in the room (self + remotes). */
  private getRoomMemberIdentities(): string[] {
    if (!this.room) return [];
    const ids = [this.room.localParticipant.identity];
    for (const p of this.room.remoteParticipants.values()) ids.push(p.identity);
    return ids;
  }

  /** Whether this client is the elected key coordinator right now. */
  private isE2EECoordinator(): boolean {
    if (!this.room) return false;
    return electKeyCoordinator(this.getRoomMemberIdentities()) === this.room.localParticipant.identity;
  }

  /**
   * Profile UUID for a participant. The LiveKit token embeds the real profile
   * UUID in `metadata.profileId` (see federation-backend LiveKitService), so we
   * trust that first. We MUST: the identity is always the synthetic
   * `federated:https://{domain}/users/{username}` form — even for local users —
   * and `resolveIdentityToUuid` can't map a local user's synthetic federated
   * identity back to a UUID (they have no `federated_id` row), which silently
   * dropped them from the Megolm recipient list -> "MissingKey".
   */
  private async resolveParticipantUuid(p: { identity: string; metadata?: string }): Promise<string | null> {
    if (p.metadata) {
      try {
        const meta = JSON.parse(p.metadata) as { profileId?: string };
        if (meta.profileId) return meta.profileId;
      } catch {
        /* fall through to network resolution */
      }
    }
    return resolveIdentityToUuid(p.identity, this.remoteServerDomain);
  }

  /** Resolve remote participant identities to profile UUIDs (Megolm recipients). */
  private async getRemoteMemberUuids(): Promise<string[]> {
    if (!this.room) return [];
    const uuids: string[] = [];
    for (const p of this.room.remoteParticipants.values()) {
      const uuid = await this.resolveParticipantUuid(p);
      if (uuid) uuids.push(uuid);
    }
    return uuids;
  }

  /** Push an envelope to all room participants over the data channel. */
  private async sendE2EEEnvelope(envelope: VoiceKeyEnvelope): Promise<void> {
    if (!this.room) return;
    try {
      const data = new TextEncoder().encode(JSON.stringify(envelope));
      await this.room.localParticipant.publishData(data, { reliable: true, topic: this.E2EE_DATA_TOPIC });
    } catch (err) {
      debug.warn('⚠️ [LiveKit] Failed to send E2EE envelope:', err);
    }
  }

  /**
   * Apply a raw shared key to the LiveKit key provider and turn E2EE on.
   *
   * Idempotent: re-applying the key we already hold is a no-op. This matters
   * because the coordinator re-broadcasts the SAME key on every join, and
   * calling setKey repeatedly would otherwise churn the provider's key index
   * and desync peers (-> "MissingKey at index N").
   */
  private async applyRoomKey(key: Uint8Array, keyId: string): Promise<void> {
    if (!this.e2eeKeyProvider || !this.room) return;
    if (this.e2eeKeyId === keyId && this.e2eeKeyReady) return; // already applied
    // ExternalE2EEKeyProvider.setKey(ArrayBuffer) -> HKDF-derives the media key.
    await this.e2eeKeyProvider.setKey(key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength));
    await this.room.setE2EEEnabled(true);
    this.e2eeRoomKey = key;
    this.e2eeKeyId = keyId;
    this.e2eeKeyReady = true;
    if (!this.e2eeEnabled) {
      this.e2eeEnabled = true;
      this.emit('e2ee-status-changed', { enabled: true });
    }
    debug.log('🔐 [LiveKit] Applied shared room key', keyId);
  }

  /**
   * Coordinator: ensure a stable room key exists, then (re)wrap it for the
   * current members and broadcast.
   *
   * The key is minted ONCE per call and reused for its lifetime. New joiners
   * receive the existing key (re-wrapped to include them) rather than forcing
   * a fresh key on everyone — regenerating per membership change caused peers
   * to desync and drop to MissingKey/InvalidKey. (Trade-off: no forward
   * secrecy on leave for v1; a departed member keeps the key until the call
   * ends. Acceptable for a live media key; revisit with explicit rotation.)
   */
  private async coordinatorEnsureKey(): Promise<void> {
    if (!this.room || !this.channelId) return;
    // Reuse the key we already hold; only mint one if this is the first time.
    let key = this.e2eeRoomKey;
    let keyId = this.e2eeKeyId;
    if (!key || !keyId) {
      key = voiceE2EEService.generateRoomKey();
      keyId = voiceE2EEService.newKeyId();
      await this.applyRoomKey(key, keyId);
    }
    const recipients = await this.getRemoteMemberUuids();
    // Wrap the (stable) key for current remotes. Solo room -> empty list is fine.
    const cipher = await voiceE2EEService.wrapKey(key, this.channelId, recipients);
    this.lastKeyEnvelope = { t: 'voice-key', keyId, cipher };
    await this.sendE2EEEnvelope(this.lastKeyEnvelope);
    debug.log(`🔑 [LiveKit] Coordinator broadcast key ${keyId} to ${recipients.length} member(s)`);
  }

  /** Try to apply the most recently received key envelope (retried as Megolm sessions arrive). */
  private async tryApplyPendingEnvelope(): Promise<void> {
    const env = this.lastKeyEnvelope;
    if (!env || env.t !== 'voice-key' || !this.channelId) return;
    if (this.e2eeKeyId === env.keyId) return; // already applied
    const key = await voiceE2EEService.unwrapKey(env.cipher, this.channelId);
    if (!key) return; // session not here yet; megolm-key-received will retry
    await this.applyRoomKey(key, env.keyId);
  }

  /** Handle a key-distribution envelope received over the data channel. */
  private async handleE2EEData(payload: Uint8Array): Promise<void> {
    let env: VoiceKeyEnvelope;
    try {
      env = JSON.parse(new TextDecoder().decode(payload)) as VoiceKeyEnvelope;
    } catch {
      return;
    }
    if (env.t === 'voice-key-request') {
      // A fresh joiner wants the key. If we're the coordinator, re-share the
      // existing key wrapped to include the new member (no new key minted).
      if (this.isE2EECoordinator()) await this.coordinatorEnsureKey();
      return;
    }
    if (env.t === 'voice-key') {
      if (this.e2eeKeyId === env.keyId) return;
      this.lastKeyEnvelope = env;
      await this.tryApplyPendingEnvelope();
    }
  }

  /** Block until the shared key is applied, or time out. */
  private waitForKey(timeoutMs: number): Promise<boolean> {
    if (this.e2eeKeyReady) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (this.e2eeKeyReady) return resolve(true);
        if (Date.now() - start >= timeoutMs) return resolve(false);
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  /**
   * Run the key handshake after connecting. Returns true once a shared key is
   * applied. The coordinator mints immediately; everyone else requests the key
   * and waits (retrying as the Megolm session arrives).
   */
  private async initVoiceE2EE(): Promise<boolean> {
    if (!this.room) return false;
    // Retry applying a pending key whenever a Megolm session shows up.
    this.megolmKeyRetryHandler = () => { void this.tryApplyPendingEnvelope(); };
    window.addEventListener('megolm-key-received', this.megolmKeyRetryHandler);

    if (this.isE2EECoordinator()) {
      await this.coordinatorEnsureKey();
    } else {
      await this.sendE2EEEnvelope({ t: 'voice-key-request' });
    }
    return this.waitForKey(12000);
  }

  /**
   * On membership change the coordinator re-shares the existing key so newly
   * connected members can decrypt. The key itself is stable (see
   * coordinatorEnsureKey) — we are not rotating, just re-broadcasting.
   */
  private async onE2EEMembershipChanged(): Promise<void> {
    if (!this.e2eeRequired || !this.room) return;
    if (this.isE2EECoordinator()) {
      await this.coordinatorEnsureKey();
    }
  }

  /**
   * Whether media for the current room is end-to-end encrypted.
   */
  isE2EEEnabled(): boolean {
    return this.e2eeEnabled;
  }
  
  /**
   * Enable E2EE for the room with an explicit shared key.
   * (Normal joins enable E2EE automatically; this is for manual/override use.)
   */
  async enableE2EE(sharedKey: Uint8Array): Promise<void> {
    if (!this.room) {
      throw new Error('No room connected');
    }
    
    try {
      if (!this.e2eeKeyProvider) {
        this.e2eeKeyProvider = new ExternalE2EEKeyProvider();
      }
      
      await this.e2eeKeyProvider.setKey(sharedKey);
      await this.room.setE2EEEnabled(true);
      this.e2eeEnabled = true;
      this.emit('e2ee-status-changed', { enabled: true });
      
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
      this.e2eeEnabled = false;
      this.emit('e2ee-status-changed', { enabled: false });
      debug.log('🔓 [LiveKit] E2EE disabled');
    } catch (error) {
      debug.error('❌ [LiveKit] Failed to disable E2EE:', error);
    }
  }

  /**
   * Re-apply the shared room key we already hold (debug/testing helper, e.g.
   * to recover after a manual `disableE2EE()`). No-op if no key is held.
   */
  async reapplyE2EEKey(): Promise<void> {
    if (this.e2eeRoomKey && this.e2eeKeyId) {
      await this.applyRoomKey(this.e2eeRoomKey, this.e2eeKeyId);
    }
  }

  /** Snapshot of current E2EE state for debugging. */
  getE2EEDebugStatus(): {
    required: boolean;
    enabled: boolean;
    keyReady: boolean;
    keyId: string | null;
    hasKey: boolean;
  } {
    return {
      required: this.e2eeRequired,
      enabled: this.e2eeEnabled,
      keyReady: this.e2eeKeyReady,
      keyId: this.e2eeKeyId,
      hasKey: !!this.e2eeRoomKey,
    };
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

// ---------------------------------------------------------------------------
// Debug console handle for manual voice E2EE testing.
//
// Opt-in (so prod builds don't expose internals by default): in dev it's
// always on; elsewhere enable once with
//   localStorage.setItem('harmony-debug-voice', '1')  // then reload
// then in the console, mid-call:
//   __voiceE2EE.status()    // inspect current E2EE state
//   await __voiceE2EE.disable()   // should garble audio for you
//   await __voiceE2EE.reenable()  // re-apply the held key to recover
//
// These only affect THIS client's own call and never expose key bytes, so the
// surface is limited to self-downgrading your own privacy.
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  try {
    const debugEnabled =
      import.meta.env.DEV ||
      window.localStorage?.getItem('harmony-debug-voice') === '1';
    if (debugEnabled) {
      (window as any).__voiceE2EE = {
        status: () => livekitWebRTC.getE2EEDebugStatus(),
        disable: () => livekitWebRTC.disableE2EE(),
        reenable: () => livekitWebRTC.reapplyE2EEKey(),
      };
      (window as any).__livekit = livekitWebRTC;
    }
  } catch {
    /* ignore - debug hook is best-effort */
  }
}

