/**
 * LiveKit WebRTC Service
 *
 * SFU-based WebRTC implementation on LiveKit. Mirrors the unifiedWebRTC API
 * so SFU and P2P modes are interchangeable. Media routes through a Selective
 * Forwarding Unit, with built-in E2EE and per-layer quality adaptation.
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
import {
  getFederatedLiveKitToken,
  getLiveKitConfig,
  getLiveKitToken,
} from './livekitTokens';

// FEDERATED IDENTITY HELPERS

// Cache for federated ID to profile UUID mappings
const federatedIdToUuidCache = new Map<string, string>();

// Reverse cache: UUID to LiveKit identity (for looking up participants by UUID)
const uuidToIdentityCache = new Map<string, string>();

/**
 * Resolve a LiveKit identity to a profile UUID.
 * Local users: the identity is already the UUID.
 * Federated users: the identity is `federated:{federatedId}` and needs a lookup.
 * @param remoteServerDomain - Domain of the remote server, for non-federated
 *   identities originating there.
 */
async function resolveIdentityToUuid(identity: string, remoteServerDomain?: string | null): Promise<string | null> {
  if (identity.startsWith('federated:')) {
    const federatedId = identity.substring('federated:'.length);
    return resolveFederatedId(federatedId, identity);
  }
  
  // Plain UUID: local or from a remote server. Local database first.
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
  
  // UUID absent locally: when connected to a remote server the user is
  // local to that server, so their profile must be fetched.
  if (remoteServerDomain) {
    debug.log(`[LiveKit] UUID ${identity} not found locally, user is from ${remoteServerDomain}`);
    
    // Only the UUID is known here; most instances expose users at
    // https://domain/users/username, so resolve via existing synced profiles
    // from that domain, else fall back to a constructed actor URL.
    try {
      const { activityPubService } = await import('./activityPubService');
      
      // Existing profiles synced from this domain are checked first.
      const { data: existingRemoteUser } = await supabase
        .from('profiles')
        .select('id, federated_id')
        .ilike('federated_id', `%${remoteServerDomain}%`)
        .limit(1);
      
      if (existingRemoteUser && existingRemoteUser.length > 0) {
        // Heuristic: direct actor fetch with a constructed URL; the remote
        // server might use a different URL pattern.
        
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
                  debug.log(`[LiveKit] Resolved remote UUID ${identity} to local UUID ${federatedUser.id}`);
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
      debug.warn(`[LiveKit] Failed to resolve remote UUID ${identity}:`, error);
    }
    
    // Unresolvable; the user is skipped.
    debug.warn(`[LiveKit] Could not resolve UUID ${identity} from ${remoteServerDomain}`);
    return null;
  }
  
  // No remote server domain - assume it's a local user that should exist
  uuidToIdentityCache.set(identity, identity);
  return identity;
}

/** Resolves an actor URL to a local profile UUID. */
async function resolveFederatedId(federatedId: string, originalIdentity: string): Promise<string | null> {
  // Check cache first
  if (federatedIdToUuidCache.has(federatedId)) {
    const cachedUuid = federatedIdToUuidCache.get(federatedId)!;
    uuidToIdentityCache.set(cachedUuid, originalIdentity);
    return cachedUuid;
  }
  
  let federatedUrl: URL;
  try {
    federatedUrl = new URL(federatedId);
  } catch {
    debug.warn(`[LiveKit] Invalid federated ID URL: ${federatedId}`);
    return null;
  }
  
  const federatedDomain = federatedUrl.hostname;
  const pathParts = federatedUrl.pathname.split('/').filter(p => p);
  const username = pathParts[pathParts.length - 1]; // Last part of /users/username
  
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
      debug.log(`[LiveKit] Resolved federated identity ${federatedId} to UUID ${user.id}`);
      return user.id;
    }
    
    // Local users have no federated_id, so look them up by username.
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
        debug.log(`[LiveKit] Resolved local user ${username} to UUID ${localUser.id}`);
        return localUser.id;
      }
    }
    
    // Profile not found locally - need to fetch it from the remote instance
    debug.log(`[LiveKit] Profile not found for ${federatedId}, fetching from remote instance...`);
    
    const { activityPubService } = await import('./activityPubService');
    
    try {
      const federatedUser = await activityPubService.fetchRemoteActor(federatedId);
      
      if (federatedUser?.id) {
        federatedIdToUuidCache.set(federatedId, federatedUser.id);
        uuidToIdentityCache.set(federatedUser.id, originalIdentity);
        debug.log(`[LiveKit] Fetched and resolved federated identity ${federatedId} to UUID ${federatedUser.id}`);
        return federatedUser.id;
      }
    } catch (fetchError) {
      debug.warn(`[LiveKit] Failed to fetch federated actor ${federatedId}:`, fetchError);
    }
    
  } catch (error) {
    debug.warn(`[LiveKit] Failed to resolve federated identity:`, error);
  }
  
  debug.warn(`[LiveKit] Could not resolve federated identity: ${federatedId}`);
  return null;
}

setLogLevel(import.meta.env.DEV ? LogLevel.debug : LogLevel.warn);

// TYPES

/** Which of a participant's video publications to target (camera and screenshare can be live concurrently). */
export type VideoSource = 'camera' | 'screen' | 'auto';

export interface UserMediaState {
  userId: string;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
  audioLevel: number;
  /** Only populated by the native (Tauri) transport. */
  hasScreenShareAudio?: boolean;
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

// LIVEKIT WEBRTC SERVICE

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
  
  // PTT gate: closed = mic track muted without touching the user's explicit mute state
  private pttGateOpen = true;

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
  
  private levelPollTimer: ReturnType<typeof setInterval> | null = null;

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
  
  constructor() {
    this.loadAudioSettings();
    this.loadStreamQualitySettings();
  }

  /** @param resolution - 360, 480, 720, 1080, or -1 for source. */
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
      case 1440:
        return { width: 2560, height: 1440, frameRate: 30 };
      case 2160:
        return { width: 3840, height: 2160, frameRate: 30 };
      case -1: // Source/Native - allow up to 4K
        return { width: 3840, height: 2160, frameRate: 30 };
      default: {
        const height = resolution;
        const width = Math.round(height * 16 / 9);
        return { width, height, frameRate: 30 };
      }
    }
  }

  // Screenshare bitrate ceiling — the previous 3 Mbps @1080p starved 60fps
  // (the encoder dropped frames to fit). Scale with resolution and framerate.
  private screenShareBitrate(height: number, frameRate: number): number {
    const base =
      height >= 2160 ? 16_000_000 :
      height >= 1440 ? 8_000_000 :
      height >= 1080 ? 5_000_000 :
      height >= 720 ? 2_500_000 :
      1_200_000;
    const fpsScale = frameRate >= 60 ? 1.8 : frameRate >= 48 ? 1.4 : 1;
    return Math.round(base * fpsScale);
  }
  
  // CONFIGURATION
  
  async getConfig(forceRefresh = false): Promise<LiveKitConfig> {
    return getLiveKitConfig(forceRefresh);
  }
  
  async isAvailable(): Promise<boolean> {
    const config = await this.getConfig();
    return config.enabled && !!config.wsUrl;
  }
  
  // TOKEN MANAGEMENT
  
  private async getToken(roomName: string, roomType: 'voice_channel' | 'dm_call' | 'stage'): Promise<TokenResponse> {
    return getLiveKitToken(roomName, roomType);
  }
  
  /** Token issued by a remote instance. */
  async getFederatedToken(
    instanceUrl: string,
    actorId: string,
    roomName: string,
    roomType: 'voice_channel' | 'dm_call' | 'stage'
  ): Promise<TokenResponse> {
    return getFederatedLiveKitToken(instanceUrl, actorId, roomName, roomType);
  }
  
  // CHANNEL MANAGEMENT
  
  async joinChannel(channelId: string, userId: string, roomType: 'voice_channel' | 'dm_call' | 'stage' = 'voice_channel', abortSignal?: AbortSignal, requireE2EE = false): Promise<boolean> {
    debug.log('[LiveKit] Joining voice channel:', channelId, 'as user:', userId, 'E2EE:', requireE2EE);
    
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
      
      const roomName = roomType === 'dm_call' ? channelId : `channel-${channelId}`;
      
      const tokenResponse = await this.getToken(roomName, roomType);
      
      // Check for cancellation after getting token
      if (abortSignal?.aborted) {
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      // The key is NOT known yet: it is a random shared room key
      // distributed server-blind over Megolm after connect (see
      // initVoiceE2EE). LiveKit needs the worker and key provider wired at
      // Room construction, so both are set up here when E2EE is requested
      // and this client can participate.
      this.e2eeRequired = requireE2EE && voiceE2EEService.canParticipate();
      if (requireE2EE && !this.e2eeRequired) {
        // The store gates on E2EE capability before joining, so reaching
        // here is a race. Refuse.
        throw new Error('Voice end-to-end encryption is required but not available on this device');
      }
      const e2eeOptions = this.e2eeRequired ? await this.setupE2EEOptions() : null;
      
      this.room = new Room({
        adaptiveStream: true,
        dynacast: true,
        ...(e2eeOptions ? { e2ee: e2eeOptions } : {}),
      });
      
      this.setupRoomListeners();
      this.e2eeEnabled = false;
      this.e2eeKeyReady = false;
      
      // Relay-only ICE avoids the browser "local network" prompt at no
      // latency cost, since traffic passes through the SFU regardless.
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
      
      debug.log('[LiveKit] Connected to room:', roomName);
      
      // Existing participants fire no ParticipantConnected event.
      await this.syncExistingParticipants();
      
      // Check for cancellation after syncing participants
      if (abortSignal?.aborted) {
        await this.leaveChannel();
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      // The shared E2EE key is established BEFORE publishing media so the
      // first frames are encrypted. Failure to agree on a key in time
      // refuses the join rather than sending plaintext into an encrypted
      // room.
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
      this.startLevelPolling();
      this.emit('local-state-changed', this.localMediaState);
      
      this.emit('channel-state-synced', { users: this.getAllUsers() });
      
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        debug.log('[LiveKit] Connection cancelled');
        // BUGS.md H23: cancellation paths call `leaveChannel()` inline, so
        // teardown is already done by the time this catch runs. Non-AbortError
        // failures below still need explicit cleanup so a half-constructed
        // Room and its listeners don't leak.
        throw error;
      }
      debug.error('[LiveKit] Failed to join channel:', error);
      // BUGS.md H23: the Room is constructed and its listeners registered
      // BEFORE `room.connect()` is awaited, so a connect failure would leave
      // both alive and accumulating across retries. Tear down before
      // returning.
      try {
        await this.leaveChannel();
      } catch (cleanupErr) {
        debug.warn('[LiveKit] join-failure cleanup also failed:', cleanupErr);
      }
      this.emit('error', error);
      return false;
    }
  }
  
  /**
   * Join with a pre-obtained token, for federated voice against a remote
   * instance's LiveKit server.
   */
  async joinWithToken(wsUrl: string, token: string, channelId: string, userId: string): Promise<boolean> {
    debug.log('[LiveKit] Joining federated voice channel:', channelId, 'with remote token');
    
    try {
      // Clean previous connection
      if (this.room) {
        await this.leaveChannel();
      }
      
      this.channelId = channelId;
      this.currentUserId = userId;
      this.roomType = 'voice_channel';
      this.localMediaState.userId = userId;
      
      // wsUrl is of the form "wss://livekit.example.org" or
      // "wss://example.org:7880".
      try {
        const wsUrlParsed = new URL(wsUrl);
        this.remoteServerDomain = wsUrlParsed.hostname.replace(/^livekit\./, '');
        debug.log('[LiveKit] Remote server domain:', this.remoteServerDomain);
      } catch {
        this.remoteServerDomain = null;
      }
      
      this.room = new Room({
        adaptiveStream: true,
        dynacast: true,
      });
      
      this.setupRoomListeners();
      
      // Connect to remote LiveKit server with provided token
      await this.room.connect(wsUrl, token, {
        autoSubscribe: true,
      });
      
      debug.log('[LiveKit] Connected to federated room');
      
      // Sync existing participants
      await this.syncExistingParticipants();
      
      // Publish local audio track
      await this.publishLocalAudio();
      
      this.emit('channel-joined', { channelId, userId });
      this.startLevelPolling();
      this.emit('local-state-changed', this.localMediaState);
      this.emit('channel-state-synced', { users: this.getAllUsers() });
      
      return true;
    } catch (error) {
      debug.error('[LiveKit] Failed to join federated channel:', error);
      this.emit('error', error);
      return false;
    }
  }
  
  // continuous local mic level (0-100); LiveKit's IsSpeaking VAD is binary/insensitive
  private startLevelPolling(): void {
    if (this.levelPollTimer) return;
    this.levelPollTimer = setInterval(() => {
      try {
        const lp = this.room?.localParticipant;
        if (!lp || !this.currentUserId) return;
        const level = this.isMicGated() ? 0 : Math.round((lp.audioLevel ?? 0) * 100);
        if (Math.abs(level - this.localMediaState.audioLevel) >= 3 || (level === 0) !== (this.localMediaState.audioLevel === 0)) {
          this.localMediaState.audioLevel = level;
          this.emit('audio-level', { userId: this.currentUserId, level });
        }
      } catch {
        /* non-critical */
      }
    }, 100);
  }

  private stopLevelPolling(): void {
    if (this.levelPollTimer) {
      clearInterval(this.levelPollTimer);
      this.levelPollTimer = null;
    }
  }

  async leaveChannel(): Promise<void> {
    debug.log('[LiveKit] Leaving voice channel');
    this.stopLevelPolling();

    if (this.room) {
      try {
        await this.room.disconnect(true);
      } catch (e) {
        debug.warn('[LiveKit] Room disconnect error (forcing cleanup):', e);
      }
      this.room = null;
    }
    
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
  
  // MEDIA CONTROLS
  
  private async publishLocalAudio(): Promise<void> {
    if (!this.room?.localParticipant) return;

    // Mic acquisition can hang (no device, or a stalled permission prompt,
    // common on Android). The timeout keeps the join completing, listen-only
    // if the mic never comes up.
    const trackPromise = createLocalAudioTrack({
      echoCancellation: this.audioConstraints.echoCancellation,
      noiseSuppression: this.audioConstraints.noiseSuppression,
      autoGainControl: this.audioConstraints.autoGainControl,
      deviceId: this.selectedInputDevice || undefined,
    });
    try {
      const audioTrack = await Promise.race([
        trackPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Microphone acquisition timed out')), 8000)),
      ]);
      
      // Settings are stored in kbps; LiveKit expects bps.
      const audioBitrateBps = (this.streamQualitySettings.audioBitrate || 128) * 1000;
      
      // audioBitrate is absent from TrackPublishOptions but accepted at
      // runtime; the cast bypasses the type check.
      await this.room.localParticipant.publishTrack(audioTrack, {
        audioBitrate: audioBitrateBps,
        dtx: true, // Discontinuous transmission for bandwidth saving
        red: true, // Redundant encoding for packet loss resilience
      } as any);
      
      debug.log('[LiveKit] Published audio with bitrate:', audioBitrateBps, 'bps');
      
      this.localMediaState.isAudioEnabled = true;

      if (this.isMicGated()) {
        audioTrack.mute();
      }
      
      debug.log('[LiveKit] Published local audio track');
    } catch (error) {
      // No microphone: join anyway, forced mute.
      debug.warn('[LiveKit] No microphone available, joining in muted state:', error);
      // A track resolving after the timeout is stopped so it releases the device.
      trackPromise.then(t => t.stop()).catch(() => {});
      this.localMediaState.isMuted = true;
      this.localMediaState.isAudioEnabled = false;
      this.emit('local-state-changed', this.localMediaState);
      // Not rethrown: the join continues without audio.
    }
  }
  
  async toggleVideo(): Promise<boolean> {
    if (!this.room?.localParticipant) {
      debug.warn('[LiveKit] No room connected');
      return false;
    }
    
    try {
      if (!this.localMediaState.isVideoEnabled) {
        // Camera and screenshare are independent tracks and may run concurrently.
        debug.log('[LiveKit] Enabling video with settings:', this.streamQualitySettings);
        
        const resolution = this.getResolutionPreset(this.streamQualitySettings.resolution);
        
        const videoTrack = await createLocalVideoTrack({
          resolution,
          deviceId: this.selectedVideoDevice || undefined,
          facingMode: 'user',
        });
        
        if (this.streamQualitySettings.frameRate) {
          try {
            await videoTrack.mediaStreamTrack.applyConstraints({
              frameRate: { ideal: this.streamQualitySettings.frameRate }
            });
          } catch (e) {
            debug.warn('[LiveKit] Could not apply frameRate constraint:', e);
          }
        }
        
        await this.room.localParticipant.publishTrack(videoTrack, {
          source: Track.Source.Camera,
          videoCodec: 'vp8',
          simulcast: true, // Enable simulcast for adaptive quality
        });
        
        this.localMediaState.isVideoEnabled = true;
        debug.log('[LiveKit] Video enabled');
      } else {
        // Only the camera track is unpublished; the screenshare stays.
        debug.log('[LiveKit] Disabling video...');

        const cameraPublication = this.room.localParticipant.getTrackPublication(Track.Source.Camera);
        if (cameraPublication?.track) {
          // unpublishTrack may invalidate the reference.
          const track = cameraPublication.track;
          await this.room.localParticipant.unpublishTrack(track);
          if (track.mediaStreamTrack) {
            track.mediaStreamTrack.stop();
          }
        }
        
        this.localMediaState.isVideoEnabled = false;
        debug.log('[LiveKit] Video disabled');
      }
      
      this.broadcastMediaState();
      this.emit('local-state-changed', this.localMediaState);
      this.emit('local-stream-changed', this.getLocalStream());
      
      return this.localMediaState.isVideoEnabled;
    } catch (error) {
      debug.error('[LiveKit] Failed to toggle video:', error);
      this.emit('error', error);
      return this.localMediaState.isVideoEnabled;
    }
  }
  
  async toggleScreenShare(): Promise<boolean> {
    if (!this.room?.localParticipant) {
      debug.warn('[LiveKit] No room connected');
      return false;
    }
    
    try {
      if (!this.localMediaState.isScreenSharing) {
        // A running camera keeps publishing alongside the screenshare.
        debug.log('[LiveKit] Enabling screen share...');
        
        debug.log('[LiveKit] Current audio tracks before screenshare:');
        for (const pub of this.room.localParticipant.audioTrackPublications.values()) {
          debug.log(`  - ${pub.source}: ${pub.trackSid}, muted: ${pub.isMuted}`);
        }
        
        // -1 means source, capped at 1080p.
        const screenResolution = this.streamQualitySettings.resolution === -1 
          ? VideoPresets.h1080.resolution 
          : this.getResolutionPreset(this.streamQualitySettings.resolution);
        
        const targetFrameRate = this.streamQualitySettings.frameRate;
        const audioBitrateKbps = this.streamQualitySettings.audioBitrate;
        
        debug.log('[LiveKit] Starting screenshare with settings:', {
          resolution: screenResolution,
          frameRate: targetFrameRate,
          audioBitrate: audioBitrateKbps
        });
        
        // At high framerate, prioritise motion (smoothness) over static detail
        const highFps = targetFrameRate >= 60;

        const captureOptions = {
          audio: {
            // Raw audio from the shared tab/window: no processing, no
            // normalization.
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false, // source of "auto-volume" behavior
          },
          video: {
            frameRate: targetFrameRate,
          },
          resolution: screenResolution,
          contentHint: highFps ? 'motion' : 'detail',
          systemAudio: 'include', // Explicitly request system audio
        };

        // Publish options. NOTE: screenshare reads `screenShareEncoding`, not
        // `videoEncoding` (the latter is ignored for screen tracks), and
        // degradationPreference/simulcast are top-level.
        const publishOptions = {
          screenShareEncoding: {
            maxBitrate: this.screenShareBitrate(screenResolution.height, targetFrameRate),
            maxFramerate: targetFrameRate,
          },
          // hold framerate under load instead of dropping frames
          degradationPreference: 'maintain-framerate' as RTCDegradationPreference,
          // full-res single layer keeps every frame at target fps (simulcast's
          // lower layers otherwise cap framerate)
          simulcast: false,
          // Audio bitrate in bits per second
          screenShareAudioBitrate: audioBitrateKbps * 1000,
        };
        
        // contentHint and systemAudio are non-standard fields LiveKit
        // forwards to getDisplayMedia; the official type omits them, hence
        // the widening cast.
        await this.room.localParticipant.setScreenShareEnabled(true, captureOptions as any, publishOptions);
        
        // Direct track constraints, for browsers that support them.
        for (const pub of this.room.localParticipant.videoTrackPublications.values()) {
          if (pub.source === Track.Source.ScreenShare && pub.track?.mediaStreamTrack) {
            try {
              await pub.track.mediaStreamTrack.applyConstraints({
                frameRate: { min: 15, ideal: targetFrameRate, max: targetFrameRate }
              });
              debug.log('[LiveKit] Applied frameRate constraint to screenshare:', targetFrameRate);
              
              // Chrome imposes limits, e.g. 15fps for tab capture.
              const actualSettings = pub.track.mediaStreamTrack.getSettings();
              debug.log('[LiveKit] Actual screenshare track settings:', {
                width: actualSettings.width,
                height: actualSettings.height,
                frameRate: actualSettings.frameRate,
                displaySurface: actualSettings.displaySurface, // 'browser'=tab, 'window', 'monitor'
              });
              
              // Chrome commonly limits FPS for tab capture.
              if (actualSettings.frameRate && actualSettings.frameRate < targetFrameRate) {
                debug.warn(`[LiveKit] Chrome limited framerate to ${actualSettings.frameRate}fps ` +
                  `(requested ${targetFrameRate}fps). ` +
                  `Note: Tab capture is often capped at ~15fps by Chrome. ` +
                  `Try sharing entire screen or window for higher framerates.`);
              }
            } catch (e) {
              debug.warn('[LiveKit] Could not apply additional frameRate constraint:', e);
            }
          }
        }
        
        this.localMediaState.isScreenSharing = true;
        
        debug.log('[LiveKit] Screen share tracks published:');
        for (const pub of this.room.localParticipant.videoTrackPublications.values()) {
          debug.log(`  - Video: ${pub.source}, trackSid: ${pub.trackSid}`);
        }
        
        let hasScreenShareAudio = false;
        for (const pub of this.room.localParticipant.audioTrackPublications.values()) {
          debug.log(`  - Audio: ${pub.source}, trackSid: ${pub.trackSid}`);
          if (pub.source === Track.Source.ScreenShareAudio) {
            hasScreenShareAudio = true;
            debug.log('[LiveKit] Screenshare audio track published!');
          }
        }
        if (!hasScreenShareAudio) {
          debug.warn('[LiveKit] No screenshare audio - possible reasons:');
          debug.warn('   1. "Share audio" checkbox not enabled in browser picker');
          debug.warn('   2. Sharing a window (not a tab) - no audio available');
          debug.warn('   3. Browser doesn\'t support system audio capture');
        }
        
        debug.log('[LiveKit] Screen share enabled');
      } else {
        debug.log('[LiveKit] Disabling screen share...');
        
        debug.log('[LiveKit] Tracks before disabling screenshare:');
        for (const pub of this.room.localParticipant.audioTrackPublications.values()) {
          debug.log(`  - Audio ${pub.source}: ${pub.trackSid}`);
        }
        for (const pub of this.room.localParticipant.videoTrackPublications.values()) {
          debug.log(`  - Video ${pub.source}: ${pub.trackSid}`);
        }
        
        await this.room.localParticipant.setScreenShareEnabled(false);
        
        debug.log('[LiveKit] Tracks after disabling screenshare:');
        for (const pub of this.room.localParticipant.audioTrackPublications.values()) {
          debug.log(`  - Audio ${pub.source}: ${pub.trackSid}`);
        }
        for (const pub of this.room.localParticipant.videoTrackPublications.values()) {
          debug.log(`  - Video ${pub.source}: ${pub.trackSid}`);
        }
        
        this.localMediaState.isScreenSharing = false;
        debug.log('[LiveKit] Screen share disabled');
      }
      
      this.broadcastMediaState();
      this.emit('local-state-changed', this.localMediaState);
      this.emit('local-stream-changed', this.getLocalStream());

      return this.localMediaState.isScreenSharing;
    } catch (error) {
      // BUGS.md #8: dismissing the screen-share picker makes
      // `setScreenShareEnabled` throw after spatial-audio listeners have
      // already flipped audio routing for the expected share. Without this
      // state change, both the spatial (wet) graph and the traditional
      // `<audio>` (dry) playback stay enabled, producing doubled audio.
      // Emitting lets listeners re-derive the routing.
      debug.error('[LiveKit] Failed to toggle screen share:', error);
      this.localMediaState.isScreenSharing = false;
      this.broadcastMediaState();
      this.emit('local-state-changed', this.localMediaState);
      this.emit('local-stream-changed', this.getLocalStream());
      this.emit('error', error);
      return false;
    }
  }

  // mic track transmits only when unmuted AND (voice activity mode OR PTT held)
  private isMicGated(): boolean {
    return this.localMediaState.isMuted || !this.pttGateOpen;
  }

  private applyMicGate(): void {
    if (!this.room?.localParticipant) return;
    const audioPublication = this.room.localParticipant.audioTrackPublications.values().next().value;
    if (!audioPublication?.track) return;
    if (this.isMicGated()) {
      (audioPublication.track as LocalAudioTrack).mute();
    } else {
      (audioPublication.track as LocalAudioTrack).unmute();
    }
  }

  toggleMute(): boolean {
    this.setMuted(!this.localMediaState.isMuted);
    return this.localMediaState.isMuted;
  }

  /** Explicit user intent; broadcast to peers. */
  setMuted(muted: boolean): void {
    if (this.localMediaState.isMuted === muted) return; // No change

    this.localMediaState.isMuted = muted;
    this.applyMicGate();

    this.broadcastMediaState();
    this.emit('local-state-changed', this.localMediaState);
  }

  /** PTT transmit gate. Mute state is unchanged and nothing is broadcast. */
  setTransmitGate(open: boolean): void {
    if (this.pttGateOpen === open) return;
    this.pttGateOpen = open;
    this.applyMicGate();
  }

  toggleDeafen(): boolean {
    this.localMediaState.isDeafened = !this.localMediaState.isDeafened;

    // Deafening also mutes.
    if (this.localMediaState.isDeafened && !this.localMediaState.isMuted) {
      this.localMediaState.isMuted = true;
      this.applyMicGate();
    }

    // Spatial audio master output, when active.
    try {
      const { spatialAudioService } = require('@/services/spatialAudio');
      spatialAudioService.setDeafened(this.localMediaState.isDeafened);
    } catch (e) {
      // Spatial audio not available.
    }
    
    // On undeafen the elements stay muted while spatial audio owns playback
    // (traditionalAudioMuted).
    for (const audioElement of this.remoteMicAudioElements.values()) {
      audioElement.muted = this.localMediaState.isDeafened || this.traditionalAudioMuted;
    }
    // Screenshare audio is never spatial, so it follows deafen alone.
    for (const audioElement of this.remoteScreenShareAudioElements.values()) {
      audioElement.muted = this.localMediaState.isDeafened;
    }
    
    this.broadcastMediaState();
    this.emit('local-state-changed', this.localMediaState);
    
    return this.localMediaState.isDeafened;
  }
  
  // STREAM QUALITY CONTROL
  
  /** Persists the settings and applies them to active video/screenshare tracks. */
  async updateStreamQuality(settings: { resolution?: number; frameRate?: number; audioBitrate?: number }): Promise<void> {
    if (settings.resolution !== undefined) {
      this.streamQualitySettings.resolution = settings.resolution;
    }
    if (settings.frameRate !== undefined) {
      this.streamQualitySettings.frameRate = settings.frameRate;
    }
    if (settings.audioBitrate !== undefined) {
      this.streamQualitySettings.audioBitrate = settings.audioBitrate;
    }
    
    debug.log('[LiveKit] Stream quality settings updated:', this.streamQualitySettings);
    
    if (!this.room?.localParticipant) {
      debug.log('ℹ[LiveKit] Not connected - settings saved for next session');
      return;
    }
    
    if (settings.resolution !== undefined || settings.frameRate !== undefined) {
      let trackCount = 0;
      for (const publication of this.room.localParticipant.videoTrackPublications.values()) {
        const track = publication.track;
        if (!track?.mediaStreamTrack) {
          debug.log('[LiveKit] Track publication has no media track:', publication.trackSid);
          continue;
        }
        
        const constraints: MediaTrackConstraints = {};
        
        if (settings.resolution !== undefined && settings.resolution !== -1) {
          constraints.height = { ideal: settings.resolution };
          constraints.width = { ideal: Math.round(settings.resolution * 16 / 9) };
        }
        
        if (settings.frameRate !== undefined) {
          constraints.frameRate = { ideal: settings.frameRate };
        }
        
        if (Object.keys(constraints).length > 0) {
          try {
            debug.log('[LiveKit] Applying constraints to track:', publication.trackSid, constraints);
            await track.mediaStreamTrack.applyConstraints(constraints);
            trackCount++;
            debug.log('[LiveKit] Applied video constraints to', publication.source);

            const actualSettings = track.mediaStreamTrack.getSettings();
            debug.log('[LiveKit] Actual track settings:', {
              width: actualSettings.width,
              height: actualSettings.height,
              frameRate: actualSettings.frameRate,
            });
          } catch (error) {
            debug.error('[LiveKit] Failed to apply video constraints:', error);
          }
        }

        // Raise the encoder ceiling live — applyConstraints only touches
        // capture; the sender keeps its publish-time maxBitrate otherwise.
        const sender = (track as any).sender as RTCRtpSender | undefined;
        if (sender && publication.source === Track.Source.ScreenShare) {
          try {
            const params = sender.getParameters();
            const configured = this.streamQualitySettings.resolution;
            const height = configured === -1
              ? track.mediaStreamTrack.getSettings().height ?? 1080
              : configured;
            const fps = this.streamQualitySettings.frameRate;
            params.degradationPreference = 'maintain-framerate';
            for (const enc of params.encodings ?? []) {
              enc.maxBitrate = this.screenShareBitrate(height, fps);
              enc.maxFramerate = fps;
            }
            await sender.setParameters(params);
            debug.log('[LiveKit] Updated screenshare encoder params:', {
              maxBitrate: this.screenShareBitrate(height, fps),
              maxFramerate: fps,
            });
          } catch (error) {
            debug.warn('[LiveKit] Could not update encoder params live:', error);
          }
        }
      }
      
      if (trackCount === 0) {
        debug.log('ℹ[LiveKit] No active video tracks to apply settings to');
      }
    }
    
    // NOTE: LiveKit fixes audio bitrate at track creation; changing it at
    // runtime requires republishing the track.
    if (settings.audioBitrate !== undefined) {
      debug.log('[LiveKit] Audio bitrate saved:', settings.audioBitrate, 'kbps');
      debug.log('   Note: Takes effect on next mic enable/reconnect');
    }
  }
  
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
        debug.log('[LiveKit] Loaded stream quality settings:', this.streamQualitySettings);
      }
    } catch (error) {
      debug.warn('[LiveKit] Failed to load stream settings:', error);
    }
  }
  
  // VOLUME CONTROL
  
  /**
   * Mute/unmute all remote mic audio elements.
   * Used by spatial audio to silence the dry signal while the wet signal plays.
   */
  setTraditionalAudioEnabled(enabled: boolean): void {
    this.traditionalAudioMuted = !enabled;
    debug.log(`[LiveKit] Setting traditional audio enabled: ${enabled} for ${this.remoteMicAudioElements.size} mic elements`);
    for (const audioElement of this.remoteMicAudioElements.values()) {
      audioElement.muted = !enabled;
    }
  }

  /** @param volume - 0-200, 100 = normal. */
  setUserMicVolume(participantId: string, volume: number): void {
    const clampedVolume = Math.max(0, Math.min(200, volume));
    this.userMicVolumes.set(participantId, clampedVolume);
    
    // Elements are keyed by both participantId (UUID) and identity.
    const audioElement = this.remoteMicAudioElements.get(participantId) || 
                         this.findAudioElementByResolvedId(participantId, 'mic');
    
    if (audioElement) {
      audioElement.volume = clampedVolume / 100;
      debug.log(`[LiveKit] Set mic volume for ${participantId} to ${clampedVolume}%`);
    }
  }
  
  /** @param volume - 0-200, 100 = normal. */
  setUserScreenShareVolume(participantId: string, volume: number): void {
    const clampedVolume = Math.max(0, Math.min(200, volume));
    this.userScreenShareVolumes.set(participantId, clampedVolume);
    
    const audioElement = this.remoteScreenShareAudioElements.get(participantId) ||
                         this.findAudioElementByResolvedId(participantId, 'screenshare');
    
    if (audioElement) {
      audioElement.volume = clampedVolume / 100;
      debug.log(`[LiveKit] Set screenshare volume for ${participantId} to ${clampedVolume}%`);
    }
  }
  
  /** Returns 0-200; 100 = normal. */
  getUserMicVolume(participantId: string): number {
    return this.userMicVolumes.get(participantId) ?? 100;
  }
  
  /** Returns 0-200; 100 = normal. */
  getUserScreenShareVolume(participantId: string): number {
    return this.userScreenShareVolumes.get(participantId) ?? 100;
  }
  
  /** Audio elements are stored by identity, so a UUID needs resolving. */
  private findAudioElementByResolvedId(
    userId: string, 
    type: 'mic' | 'screenshare'
  ): HTMLAudioElement | undefined {
    const map = type === 'mic' ? this.remoteMicAudioElements : this.remoteScreenShareAudioElements;
    
    for (const [identity, element] of map.entries()) {
      if (uuidToIdentityCache.get(userId) === identity) {
        return element;
      }
    }
    
    return undefined;
  }
  
  hasScreenShareAudio(participantId: string): boolean {
    return this.remoteScreenShareAudioElements.has(participantId) ||
           !!this.findAudioElementByResolvedId(participantId, 'screenshare');
  }
  
  // STREAM ACCESS
  
  /** Combined audio and video. */
  getLocalStream(): MediaStream | null {
    if (!this.room?.localParticipant) return null;
    
    const stream = new MediaStream();
    
    for (const publication of this.room.localParticipant.audioTrackPublications.values()) {
      if (publication.track?.mediaStreamTrack) {
        stream.addTrack(publication.track.mediaStreamTrack);
      }
    }
    
    for (const publication of this.room.localParticipant.videoTrackPublications.values()) {
      if (publication.track?.mediaStreamTrack) {
        stream.addTrack(publication.track.mediaStreamTrack);
      }
    }
    
    return stream.getTracks().length > 0 ? stream : null;
  }
  
  /** Works for local and remote users. */
  getUserStream(userId: string): MediaStream | null {
    if (!this.room) return null;
    
    if (userId === this.currentUserId) {
      return this.getLocalStream();
    }
    
    // Remote participant: by userId first, then by mapped identity.
    let participant = this.room.remoteParticipants.get(userId);
    if (!participant) {
      // Federated users have a UUID userId and a `federated:` identity.
      const identity = uuidToIdentityCache.get(userId);
      if (identity) {
        participant = this.room.remoteParticipants.get(identity);
      }
    }
    if (!participant) return null;
    
    const stream = new MediaStream();
    
    for (const publication of participant.audioTrackPublications.values()) {
      if (publication.track?.mediaStreamTrack) {
        stream.addTrack(publication.track.mediaStreamTrack);
      }
    }
    
    for (const publication of participant.videoTrackPublications.values()) {
      if (publication.track?.mediaStreamTrack) {
        stream.addTrack(publication.track.mediaStreamTrack);
      }
    }
    
    return stream.getTracks().length > 0 ? stream : null;
  }

  /**
   * Microphone-only stream. Spatial audio must process the mic alone;
   * getUserStream also carries screenshare audio, which would be
   * spatialized and panned with the voice.
   */
  getUserMicStream(userId: string): MediaStream | null {
    const participant = this.resolveParticipant(userId);
    if (!participant) return null;

    const stream = new MediaStream();
    for (const publication of participant.audioTrackPublications.values()) {
      if (publication.source === Track.Source.Microphone && publication.track?.mediaStreamTrack) {
        stream.addTrack(publication.track.mediaStreamTrack);
      }
    }
    return stream.getTracks().length > 0 ? stream : null;
  }

  /**
   * Resolve a participant (local or remote) by profile UUID or LiveKit identity.
   */
  private resolveParticipant(userId: string): LocalParticipant | RemoteParticipant | null {
    if (!this.room) return null;
    if (userId === this.currentUserId) return this.room.localParticipant;

    let participant = this.room.remoteParticipants.get(userId);
    if (!participant) {
      const identity = uuidToIdentityCache.get(userId);
      if (identity) {
        participant = this.room.remoteParticipants.get(identity);
      }
    }
    return participant || null;
  }

  /**
   * Pick a participant's video publication for the requested source.
   * 'auto' prefers screenshare over camera (legacy single-tile behavior).
   */
  private pickVideoPublication(
    participant: LocalParticipant | RemoteParticipant,
    source: VideoSource
  ): TrackPublication | undefined {
    const publications: TrackPublication[] = [...participant.videoTrackPublications.values()];
    const screen = publications.find(p => p.source === Track.Source.ScreenShare);
    const camera = publications.find(p => p.source === Track.Source.Camera);

    if (source === 'screen') return screen;
    if (source === 'camera') return camera;
    return screen || camera || publications[0];
  }

  /**
   * Attaches via LiveKit's attach API, which adaptive streaming requires:
   * with srcObject set directly, LiveKit does not know the video is consumed
   * and may disable all simulcast layers.
   *
   * @param source - which publication to attach; camera and screenshare can
   *   be live at the same time.
   */
  attachVideoToElement(userId: string, videoElement: HTMLVideoElement, source: VideoSource = 'auto'): boolean {
    if (!this.room) {
      debug.warn('[LiveKit] attachVideoToElement: No room');
      return false;
    }

    const participant = this.resolveParticipant(userId);
    if (!participant) {
      debug.warn('[LiveKit] attachVideoToElement: Participant not found:', userId);
      return false;
    }

    const publication = this.pickVideoPublication(participant, source);
    if (publication?.track) {
      publication.track.attach(videoElement);
      debug.log(`[LiveKit] Attached ${source} video for:`, userId);
      return true;
    }

    debug.warn(`[LiveKit] No ${source} video track to attach for:`, userId);
    return false;
  }

  /**
   * Detach video from element. When a source is given only that publication is
   * detached; otherwise every video publication is detached from the element.
   */
  detachVideoFromElement(userId: string, videoElement: HTMLVideoElement, source: VideoSource = 'auto'): void {
    if (!this.room) return;

    const participant = this.resolveParticipant(userId);
    if (!participant) return;

    if (source === 'auto') {
      for (const publication of participant.videoTrackPublications.values()) {
        publication.track?.detach(videoElement);
      }
      return;
    }

    const publication = this.pickVideoPublication(participant, source);
    publication?.track?.detach(videoElement);
  }
  
  getLocalState(): UserMediaState {
    return { ...this.localMediaState };
  }
  
  /**
   * States are stored under both UUID and identity for federated users, so
   * the result is deduplicated by userId.
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
  
  // ROOM EVENT HANDLING
  
  /**
   * Registers participants already in the room at connect time.
   *
   * NOTE: only participant setup happens here. Tracks are handled by
   * TrackSubscribed events, which fire per track as it becomes available.
   */
  private async syncExistingParticipants(): Promise<void> {
    if (!this.room) {
      debug.warn('[LiveKit] syncExistingParticipants called but no room');
      return;
    }
    
    const existingParticipants = this.room.remoteParticipants;
    debug.log(`[LiveKit] Syncing ${existingParticipants.size} existing participants`);
    
    if (existingParticipants.size === 0) {
      debug.log('[LiveKit] No existing participants to sync');
      return;
    }
    
    for (const participant of existingParticipants.values()) {
      debug.log(`[LiveKit] Found existing participant: ${participant.identity}, sid: ${participant.sid}`);
      
      // Resolve federated identity to profile UUID
      const userId = await resolveIdentityToUuid(participant.identity, this.remoteServerDomain);
      
      if (!userId) {
        debug.warn(`[LiveKit] Could not resolve identity for existing participant: ${participant.identity}`);
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
      debug.log(`[LiveKit] Added to allUserStates, total: ${this.allUserStates.size}`);
      
      this.setupParticipantListeners(participant);
      
      this.emit('user-joined', { userId, mediaState });
      
      // Already-subscribed tracks emit state now; later subscriptions are
      // handled by TrackSubscribed.
      const hasSubscribedTracks = this.hasSubscribedTracks(participant);
      if (hasSubscribedTracks) {
        debug.log(`[LiveKit] Participant ${userId} has already-subscribed tracks, emitting state`);
        const stream = this.getUserStream(userId);
        this.emit('user-stream-changed', { userId, stream });
        // Spread produces a new object reference for Vue reactivity.
        this.emit('user-state-changed', { userId, mediaState: { ...mediaState } });
      }
    }
    
    debug.log(`[LiveKit] Sync complete. Total users tracked: ${this.allUserStates.size}`);
  }
  
  private hasSubscribedTracks(participant: RemoteParticipant): boolean {
    for (const pub of participant.videoTrackPublications.values()) {
      if (pub.isSubscribed && pub.track) return true;
    }
    for (const pub of participant.audioTrackPublications.values()) {
      if (pub.isSubscribed && pub.track) return true;
    }
    return false;
  }
  
  private setupRoomListeners(): void {
    if (!this.room) return;
    
    // Connection state changes
    this.room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
      debug.log('[LiveKit] Connection state:', state);
      this.emit('connection-state-changed', { state });
    });
    
    // E2EE key-distribution messages (Model S shared-key handshake)
    this.room.on(RoomEvent.DataReceived, (payload: Uint8Array, _participant, _kind, topic?: string) => {
      if (topic === this.E2EE_DATA_TOPIC) {
        void this.handleE2EEData(payload);
      }
    });
    
    // Local voice activity indicator.
    this.room.localParticipant.on(ParticipantEvent.IsSpeakingChanged, (speaking: boolean) => {
      this.localMediaState.isSpeaking = speaking;
      // audioLevel owned by startLevelPolling()
      if (this.currentUserId && !speaking) {
        this.emit('audio-level', { userId: this.currentUserId, level: this.localMediaState.audioLevel });
      }
    });
    
    // Participant connected
    this.room.on(RoomEvent.ParticipantConnected, async (participant: RemoteParticipant) => {
      debug.log('[LiveKit] Participant connected:', participant.identity);
      
      // Resolve federated identity to profile UUID
      const userId = await resolveIdentityToUuid(participant.identity, this.remoteServerDomain);
      if (!userId) {
        debug.warn(`[LiveKit] Could not resolve identity for connected participant: ${participant.identity}`);
        return; // Skip unresolvable participants
      }
      
      const mediaState = this.createMediaState(participant, userId);
      this.allUserStates.set(userId, mediaState);
      // Also store by identity for internal LiveKit operations
      if (userId !== participant.identity) {
        this.allUserStates.set(participant.identity, mediaState);
      }
      
      this.setupParticipantListeners(participant);

      this.emit('user-joined', { userId, mediaState });
      this.emit('channel-state-synced', { users: this.getAllUsers() });

      // sends explicit mute/deafen state to the newcomer; track mute alone cannot convey it
      this.broadcastMediaState();

      // Rotate/redistribute the shared E2EE key so the newcomer is included.
      void this.onE2EEMembershipChanged();
    });
    
    // Participant disconnected
    this.room.on(RoomEvent.ParticipantDisconnected, async (participant: RemoteParticipant) => {
      debug.log('[LiveKit] Participant disconnected:', participant.identity);
      
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
      
      // Rotates the shared E2EE key so the departed member cannot decrypt
      // future media. The newly elected coordinator issues the fresh key.
      void this.onE2EEMembershipChanged();
    });
    
    this.room.on(RoomEvent.TrackSubscribed, async (track: RemoteTrack, publication: TrackPublication, participant: RemoteParticipant) => {
      const source = publication.source;
      debug.log('[LiveKit] Track subscribed:', track.kind, 'source:', source, 'from', participant.identity);
      
      // Resolve federated identity to profile UUID
      const userId = await resolveIdentityToUuid(participant.identity, this.remoteServerDomain);
      // Identity is a fallback for internal lookups only.
      const lookupId = userId || participant.identity;
      
      let state = this.allUserStates.get(lookupId) || this.allUserStates.get(participant.identity);
      if (!state) {
        // Track can subscribe before the participant is fully registered.
        debug.log('[LiveKit] Creating state for participant during TrackSubscribed:', lookupId);
        state = this.createMediaState(participant, userId || participant.identity);
      }
      
      if (track.kind === Track.Kind.Audio) {
        state.isAudioEnabled = true;
        
        // Remote audio tracks are attached for playback; local ones are not.
        if (track instanceof RemoteAudioTrack) {
          const audioElement = track.attach();
          
          const isScreenShareAudio = source === Track.Source.ScreenShareAudio;
          
          if (this.localMediaState.isDeafened || (!isScreenShareAudio && this.traditionalAudioMuted)) {
            audioElement.muted = true;
          }
          
          if (isScreenShareAudio) {
            // Existing screenshare audio for this participant is removed first.
            const existingElement = this.remoteScreenShareAudioElements.get(participant.identity);
            if (existingElement && existingElement !== audioElement) {
              debug.log('[LiveKit] Cleaning up old screenshare audio element');
              try {
                existingElement.pause();
                existingElement.srcObject = null;
              } catch (e) { /* ignore cleanup errors */ }
            }
            
            // Stored under both identity and resolved userId.
            this.remoteScreenShareAudioElements.set(participant.identity, audioElement);
            if (userId && userId !== participant.identity) {
              this.remoteScreenShareAudioElements.set(userId, audioElement);
              debug.log('[LiveKit] Also storing screenshare audio by userId:', userId);
            }
            
            // Screenshare audio bypasses all processing: no echo
            // cancellation, no noise suppression, no auto gain control.
            audioElement.setAttribute('data-screenshare-audio', 'true');
            
            // Saved volume is keyed by identity or userId; default 100%.
            const savedVolume = this.userScreenShareVolumes.get(participant.identity) 
              ?? (userId ? this.userScreenShareVolumes.get(userId) : null)
              ?? 100;
            audioElement.volume = savedVolume / 100;
            
            debug.log('[LiveKit] Screenshare audio attached (raw, no processing) for:', lookupId, 'volume:', savedVolume);
          } else {
            // Existing mic audio for this participant is removed first.
            const existingElement = this.remoteMicAudioElements.get(participant.identity);
            if (existingElement && existingElement !== audioElement) {
              try {
                existingElement.pause();
                existingElement.srcObject = null;
              } catch (e) { /* ignore cleanup errors */ }
            }
            
            this.remoteMicAudioElements.set(participant.identity, audioElement);
            
            // Muted while spatial audio owns playback.
            if (this.traditionalAudioMuted) {
              audioElement.muted = true;
            }
            
            const savedVolume = this.userMicVolumes.get(participant.identity) ?? 100;
            audioElement.volume = savedVolume / 100;
            
            debug.log('[LiveKit] Mic audio attached for:', lookupId, 'volume:', savedVolume, 'muted:', audioElement.muted);
          }
        }
      } else if (track.kind === Track.Kind.Video) {
        if (source === Track.Source.ScreenShare) {
          state.isScreenSharing = true;
          debug.log('[LiveKit] ScreenShare track subscribed for:', lookupId);
        } else {
          state.isVideoEnabled = true;
          debug.log('[LiveKit] Camera track subscribed for:', lookupId);
        }
      }
      
      // The updated state is always stored.
      this.allUserStates.set(lookupId, state);
      if (userId && userId !== participant.identity) {
        this.allUserStates.set(participant.identity, state);
      }
      
      // Emitted whenever the UUID resolved. Spread produces a new object
      // reference so Vue reactivity detects the change.
      if (userId) {
        debug.log('[LiveKit] Emitting state change for:', userId, 'screenSharing:', state.isScreenSharing, 'videoEnabled:', state.isVideoEnabled);
        const stream = this.getUserStream(userId);
        this.emit('user-stream-changed', { userId, stream });
        this.emit('user-state-changed', { userId, mediaState: { ...state } });
      }
    });
    
    this.room.on(RoomEvent.TrackUnsubscribed, async (track: RemoteTrack, publication: TrackPublication, participant: RemoteParticipant) => {
      const source = publication.source;
      debug.log('[LiveKit] Track unsubscribed:', track.kind, 'source:', source, 'from', participant.identity);
      
      // Resolve federated identity to profile UUID
      const userId = await resolveIdentityToUuid(participant.identity, this.remoteServerDomain);
      const lookupId = userId || participant.identity;
      
      if (track.kind === Track.Kind.Audio && track instanceof RemoteAudioTrack) {
        const isScreenShareAudio = source === Track.Source.ScreenShareAudio;
        
        track.detach();
        
        if (isScreenShareAudio) {
          this.remoteScreenShareAudioElements.delete(participant.identity);
          if (userId && userId !== participant.identity) {
            this.remoteScreenShareAudioElements.delete(userId);
          }
          debug.log('[LiveKit] Screenshare audio detached for:', lookupId);
        } else {
          this.remoteMicAudioElements.delete(participant.identity);
          debug.log('[LiveKit] Mic audio detached for:', lookupId);
        }
      }
      
      const state = this.allUserStates.get(lookupId) || this.allUserStates.get(participant.identity);
      if (state) {
        if (track.kind === Track.Kind.Audio) {
          // Only the microphone clears isAudioEnabled, not screenshare audio.
          if (source !== Track.Source.ScreenShareAudio) {
            state.isAudioEnabled = false;
          }
        } else if (track.kind === Track.Kind.Video) {
          if (source === Track.Source.ScreenShare) {
            state.isScreenSharing = false;
          } else {
            state.isVideoEnabled = false;
          }
        }
        this.allUserStates.set(lookupId, state);
      }
      
      // Emitted only when the UUID resolved. Spread produces a new object
      // reference so Vue reactivity detects the change.
      if (userId && state) {
        const stream = this.getUserStream(userId);
        this.emit('user-stream-changed', { userId, stream });
        this.emit('user-state-changed', { userId, mediaState: { ...state } });
      }
    });
    
    // Active speaker changes (includes both local and remote participants)
    this.room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const speakerIdentities = new Set(speakers.map(s => s.identity));
      
      const localIdentity = this.room?.localParticipant?.identity;
      if (localIdentity && this.currentUserId) {
        const localSpeaking = speakerIdentities.has(localIdentity);
        if (this.localMediaState.isSpeaking !== localSpeaking) {
          this.localMediaState.isSpeaking = localSpeaking;
        }
      }
      
      // Resolved userIds already processed, to avoid duplicates.
      const processedUserIds = new Set<string>();
      
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
      debug.log('[LiveKit] Disconnected:', reason);
      this.emit('channel-left', { channelId: this.channelId, reason });
    });
    
    // Error
    this.room.on(RoomEvent.MediaDevicesError, (error: Error) => {
      debug.error('[LiveKit] Media devices error:', error);
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
            // Events carry state.userId (resolved UUID), not identity.
            // Spread produces a new object reference for Vue reactivity.
            this.emit('user-state-changed', { userId: state.userId, mediaState: { ...state } });
          }
        } else if (message.type === 'call-start-time') {
          this.emit('call-start-time', { timestamp: message.data?.timestamp, from: message.from });
        } else if (message.type === 'request-call-start-time') {
          this.emit('request-call-start-time', { from: message.from });
        }
      } catch (error) {
        debug.warn('[LiveKit] Failed to parse data message');
      }
    });
    
    // LOCAL track unpublished (fires when Chrome's "Stop Sharing" is clicked or track ends)
    this.room.on(RoomEvent.LocalTrackUnpublished, (publication: TrackPublication, _participant: LocalParticipant) => {
      debug.log('[LiveKit] Local track unpublished:', publication.kind, 'source:', publication.source);
      
      if (publication.kind === Track.Kind.Video) {
        if (publication.source === Track.Source.ScreenShare) {
          debug.log('[LiveKit] Screen share ended (Chrome stop button or track ended)');
          this.localMediaState.isScreenSharing = false;
        } else if (publication.source === Track.Source.Camera) {
          debug.log('[LiveKit] Camera ended');
          this.localMediaState.isVideoEnabled = false;
        }
      } else if (publication.kind === Track.Kind.Audio) {
        if (publication.source === Track.Source.ScreenShareAudio) {
          debug.log('[LiveKit] Screen share audio ended');
          // Screenshare audio has no separate state flag.
        }
      }
      
      this.emit('local-state-changed', { ...this.localMediaState });
      
      // user-stream-changed keeps remoteStreams in the store current.
      if (this.currentUserId) {
        const stream = this.getLocalStream();
        this.emit('user-stream-changed', { userId: this.currentUserId, stream });
        this.emit('user-state-changed', { 
          userId: this.currentUserId, 
          mediaState: { ...this.localMediaState } 
        });
      }
      
      debug.log('[LiveKit] Local state after unpublish:', 
        'video:', this.localMediaState.isVideoEnabled, 
        'screen:', this.localMediaState.isScreenSharing);
    });
    
    // Track published by remote user (fires AFTER TrackSubscribed, good for UI notification)
    this.room.on(RoomEvent.TrackPublished, async (publication: TrackPublication, participant: RemoteParticipant) => {
      debug.log('[LiveKit] Remote track published:', publication.kind, 'source:', publication.source, 'from:', participant.identity);
    });
    
    // NOTE: initial sync is handled by syncExistingParticipants(), which
    // resolves identities. Nothing is emitted here; the caller emits after
    // connecting.
  }
  
  private setupParticipantListeners(participant: RemoteParticipant): void {
    // Track mute also fires for PTT gating, so it can't be trusted as user intent.
    // Explicit mute arrives via the media-state data broadcast instead.
    participant.on(ParticipantEvent.TrackMuted, (publication: TrackPublication) => {
      const state = this.allUserStates.get(participant.identity);
      if (state && publication.kind === Track.Kind.Audio) {
        state.isSpeaking = false;
        state.audioLevel = 0;
        this.allUserStates.set(participant.identity, state);
        this.emit('user-state-changed', { userId: state.userId, mediaState: { ...state } });
      }
    });

    participant.on(ParticipantEvent.IsSpeakingChanged, (speaking: boolean) => {
      const state = this.allUserStates.get(participant.identity);
      if (state) {
        state.isSpeaking = speaking;
        state.audioLevel = speaking ? 50 : 0;
        this.allUserStates.set(participant.identity, state);
        // Events carry state.userId (resolved UUID), not identity.
        this.emit('audio-level', { userId: state.userId, level: state.audioLevel });
      }
    });
  }
  
  /**
   * @param resolvedUserId - Resolved UUID for federated users; defaults to
   *   participant.identity.
   */
  private createMediaState(participant: RemoteParticipant, resolvedUserId?: string): UserMediaState {
    // Publication mute is only an initial guess (PTT gating also mutes the track);
    // the participant's media-state broadcast corrects it right after join.
    const hasMic = participant.audioTrackPublications.size > 0;
    const isMicMuted = hasMic && !participant.isMicrophoneEnabled;
    
    // Screen share is identified by the ScreenShare source type.
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
      isDeafened: false, // remote deafen state arrives via data messages
      isSpeaking: participant.isSpeaking,
      audioLevel: 0,
    };
  }
  
  broadcastMessage(message: any): void {
    if (!this.room?.localParticipant) return;

    try {
      const encoder = new TextEncoder();
      this.room.localParticipant.publishData(encoder.encode(JSON.stringify(message)), { reliable: true });
    } catch (error) {
      debug.warn('[LiveKit] Failed to broadcast message:', message?.type);
    }
  }

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
      debug.warn('[LiveKit] Failed to broadcast media state');
    }
  }
  
  // DEVICE MANAGEMENT
  
  /** Source of truth is VoiceSettingsService. */
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
      
      debug.log('[LiveKit] Loaded audio settings from VoiceSettingsService:', {
        devices,
        constraints
      });
    } catch (error) {
      debug.warn('[LiveKit] Failed to load audio settings:', error);
    }
  }
  
  getSelectedDevices(): { inputDevice: string | null; outputDevice: string | null; videoDevice: string | null } {
    return {
      inputDevice: this.selectedInputDevice,
      outputDevice: this.selectedOutputDevice,
      videoDevice: this.selectedVideoDevice,
    };
  }
  
  async updateInputDevice(deviceId: string): Promise<void> {
    this.selectedInputDevice = deviceId;
    VoiceSettingsService.setInputDevice(deviceId);
    
    if (this.room?.localParticipant) {
      await this.room.switchActiveDevice('audioinput', deviceId);
      debug.log('[LiveKit] Switched input device to:', deviceId);
    }
  }
  
  async updateOutputDevice(deviceId: string): Promise<void> {
    this.selectedOutputDevice = deviceId;
    VoiceSettingsService.setOutputDevice(deviceId);
    
    if (this.room) {
      await this.room.switchActiveDevice('audiooutput', deviceId);
      debug.log('[LiveKit] Switched output device to:', deviceId);
    }
  }
  
  async updateVideoDevice(deviceId: string): Promise<void> {
    this.selectedVideoDevice = deviceId;
    VoiceSettingsService.setVideoDevice(deviceId);
    
    if (this.room?.localParticipant && this.localMediaState.isVideoEnabled) {
      await this.room.switchActiveDevice('videoinput', deviceId);
      debug.log('[LiveKit] Switched video device to:', deviceId);
    }
  }
  
  // E2EE (End-to-End Encryption)
  
  /**
   * Build the E2EE options passed to the `Room` constructor.
   *
   * Returns `{ keyProvider, worker }` ready to encrypt media, or `null` when
   * the environment cannot support it (e.g. the crypto worker fails to
   * start); the caller then proceeds with an unencrypted room.
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
      debug.warn('[LiveKit] Failed to set up E2EE worker, room will be unencrypted:', error);
      return null;
    }
  }

  // Shared-key distribution (Model S)
  //
  // All participants hold the same 32-byte room key. The coordinator
  // (smallest participant identity) mints it ONCE and ships it,
  // Megolm-wrapped, over LiveKit's data channel; everyone else applies what
  // they receive. On membership change the coordinator re-broadcasts the SAME
  // key, re-wrapped for the new member: regenerating per join desyncs peers
  // and triggers MissingKey/InvalidKey. The SFU sees only Megolm ciphertext.

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
   * Profile UUID for a participant. The LiveKit token embeds the profile UUID
   * in `metadata.profileId` (see federation-backend LiveKitService), which is
   * used first and is required: the identity is always the synthetic
   * `federated:https://{domain}/users/{username}` form, even for local users,
   * and `resolveIdentityToUuid` cannot map that back to a UUID for a local
   * user (no `federated_id` row). Such users drop out of the Megolm recipient
   * list and hit "MissingKey".
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
      debug.warn('[LiveKit] Failed to send E2EE envelope:', err);
    }
  }

  /**
   * Apply a raw shared key to the LiveKit key provider and turn E2EE on.
   *
   * Idempotent: re-applying the currently held key is a no-op. The
   * coordinator re-broadcasts the SAME key on every join, and repeated setKey
   * calls churn the provider's key index and desync peers
   * ("MissingKey at index N").
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
    debug.log('[LiveKit] Applied shared room key', keyId);
  }

  /**
   * Coordinator: ensure a stable room key exists, then (re)wrap it for the
   * current members and broadcast.
   *
   * The key is minted ONCE and reused for its lifetime. New joiners receive
   * the existing key re-wrapped to include them; regenerating per membership
   * change desyncs peers into MissingKey/InvalidKey. Consequence: no forward
   * secrecy on leave - a departed member keeps the key until the call ends.
   */
  private async coordinatorEnsureKey(): Promise<void> {
    if (!this.room || !this.channelId) return;
    // A held key is reused; one is minted only on the first call.
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
    debug.log(`[LiveKit] Coordinator broadcast key ${keyId} to ${recipients.length} member(s)`);
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
      // A fresh joiner is requesting the key. The coordinator re-shares the
      // existing key wrapped to include the new member; no new key is minted.
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
   * connected members can decrypt. The key is stable (see
   * coordinatorEnsureKey): this re-broadcasts, it does not rotate.
   */
  private async onE2EEMembershipChanged(): Promise<void> {
    if (!this.e2eeRequired || !this.room) return;
    if (this.isE2EECoordinator()) {
      await this.coordinatorEnsureKey();
    }
  }

  isE2EEEnabled(): boolean {
    return this.e2eeEnabled;
  }
  
  /**
   * Enables E2EE with an explicit shared key. Normal joins enable E2EE
   * automatically; this is the manual override path.
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
      
      debug.log('[LiveKit] E2EE enabled');
    } catch (error) {
      debug.error('[LiveKit] Failed to enable E2EE:', error);
      throw error;
    }
  }
  
  async disableE2EE(): Promise<void> {
    if (!this.room) return;
    
    try {
      await this.room.setE2EEEnabled(false);
      this.e2eeEnabled = false;
      this.emit('e2ee-status-changed', { enabled: false });
      debug.log('[LiveKit] E2EE disabled');
    } catch (error) {
      debug.error('[LiveKit] Failed to disable E2EE:', error);
    }
  }

  // EVENT SYSTEM
  
  on(event: string, callback: Function): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(callback);
  }
  
  off(event: string, callback: Function): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      const index = listeners.indexOf(callback);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  }
  
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
  
  // UTILITY METHODS
  
  isConnected(): boolean {
    return this.room?.state === ConnectionState.Connected;
  }
  
  getCurrentChannelId(): string | null {
    return this.channelId;
  }
  
  getStats(): any {
    if (!this.room) return null;
    
    return {
      numParticipants: this.room.remoteParticipants.size + 1,
      connectionQuality: this.room.localParticipant?.connectionQuality,
    };
  }
}

// SINGLETON INSTANCE

export const livekitWebRTC = new LiveKitWebRTCService();
export default livekitWebRTC;

