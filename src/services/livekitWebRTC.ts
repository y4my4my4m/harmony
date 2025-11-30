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
  E2EEOptions,
  ExternalE2EEKeyProvider,
} from 'livekit-client';
import { supabase } from '@/supabase';
import { debug } from '@/utils/debug';

// Set LiveKit log level based on debug mode
setLogLevel(debug.isEnabled() ? LogLevel.debug : LogLevel.warn);

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
      await this.room.connect(tokenResponse.wsUrl, tokenResponse.token, {
        autoSubscribe: true,
      });
      
      debug.log('✅ [LiveKit] Connected to room:', roomName);
      
      // Publish local audio track
      await this.publishLocalAudio();
      
      this.emit('channel-joined', { channelId, userId });
      this.emit('local-state-changed', this.localMediaState);
      
      return true;
    } catch (error) {
      debug.error('❌ [LiveKit] Failed to join channel:', error);
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
          await this.room.localParticipant.unpublishTrack(videoPublication.track);
          videoPublication.track.stop();
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
            await this.room.localParticipant.unpublishTrack(videoPublication.track);
            videoPublication.track.stop();
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
   * Get remote user's stream
   */
  getUserStream(userId: string): MediaStream | null {
    if (!this.room) return null;
    
    const participant = this.room.remoteParticipants.get(userId);
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
   * Get local media state
   */
  getLocalState(): UserMediaState {
    return { ...this.localMediaState };
  }
  
  /**
   * Get all remote user states
   */
  getAllUsers(): UserMediaState[] {
    return Array.from(this.allUserStates.values());
  }
  
  // =============================================================================
  // ROOM EVENT HANDLING
  // =============================================================================
  
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
    this.room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      debug.log('👋 [LiveKit] Participant connected:', participant.identity);
      
      const mediaState = this.createMediaState(participant);
      this.allUserStates.set(participant.identity, mediaState);
      
      this.setupParticipantListeners(participant);
      
      this.emit('user-joined', { userId: participant.identity, mediaState });
      this.emit('channel-state-synced', { users: this.getAllUsers() });
    });
    
    // Participant disconnected
    this.room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      debug.log('👋 [LiveKit] Participant disconnected:', participant.identity);
      
      this.allUserStates.delete(participant.identity);
      
      this.emit('user-left', { userId: participant.identity });
      this.emit('channel-state-synced', { users: this.getAllUsers() });
    });
    
    // Track subscribed
    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: TrackPublication, participant: RemoteParticipant) => {
      debug.log('📺 [LiveKit] Track subscribed:', track.kind, 'from', participant.identity);
      
      // Update user state
      const state = this.allUserStates.get(participant.identity);
      if (state) {
        if (track.kind === Track.Kind.Audio) {
          state.isAudioEnabled = true;
        } else if (track.kind === Track.Kind.Video) {
          state.isVideoEnabled = true;
        }
        this.allUserStates.set(participant.identity, state);
      }
      
      // Emit stream change
      const stream = this.getUserStream(participant.identity);
      this.emit('user-stream-changed', { userId: participant.identity, stream });
      this.emit('user-state-changed', { userId: participant.identity, mediaState: state });
    });
    
    // Track unsubscribed
    this.room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: TrackPublication, participant: RemoteParticipant) => {
      debug.log('📺 [LiveKit] Track unsubscribed:', track.kind, 'from', participant.identity);
      
      // Update user state
      const state = this.allUserStates.get(participant.identity);
      if (state) {
        if (track.kind === Track.Kind.Audio) {
          state.isAudioEnabled = false;
        } else if (track.kind === Track.Kind.Video) {
          state.isVideoEnabled = false;
        }
        this.allUserStates.set(participant.identity, state);
      }
      
      // Emit stream change
      const stream = this.getUserStream(participant.identity);
      this.emit('user-stream-changed', { userId: participant.identity, stream });
      this.emit('user-state-changed', { userId: participant.identity, mediaState: state });
    });
    
    // Active speaker changes
    this.room.on(RoomEvent.ActiveSpeakersChanged, (speakers: RemoteParticipant[]) => {
      // Update speaking state for all users
      for (const [userId, state] of this.allUserStates) {
        const isSpeaking = speakers.some(s => s.identity === userId);
        if (state.isSpeaking !== isSpeaking) {
          state.isSpeaking = isSpeaking;
          state.audioLevel = isSpeaking ? 50 : 0; // Approximate level
          this.allUserStates.set(userId, state);
          this.emit('audio-level', { userId, level: state.audioLevel });
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
            this.emit('user-state-changed', { userId: participant.identity, mediaState: state });
          }
        }
      } catch (error) {
        debug.warn('⚠️ [LiveKit] Failed to parse data message');
      }
    });
    
    // Initial sync of existing participants
    for (const participant of this.room.remoteParticipants.values()) {
      const mediaState = this.createMediaState(participant);
      this.allUserStates.set(participant.identity, mediaState);
      this.setupParticipantListeners(participant);
    }
    
    this.emit('channel-state-synced', { users: this.getAllUsers() });
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
        this.emit('user-state-changed', { userId: participant.identity, mediaState: state });
      }
    });
    
    // Track unmuted
    participant.on(ParticipantEvent.TrackUnmuted, (publication: TrackPublication) => {
      const state = this.allUserStates.get(participant.identity);
      if (state && publication.kind === Track.Kind.Audio) {
        state.isMuted = false;
        this.allUserStates.set(participant.identity, state);
        this.emit('user-state-changed', { userId: participant.identity, mediaState: state });
      }
    });
    
    // Speaking changed
    participant.on(ParticipantEvent.IsSpeakingChanged, (speaking: boolean) => {
      const state = this.allUserStates.get(participant.identity);
      if (state) {
        state.isSpeaking = speaking;
        state.audioLevel = speaking ? 50 : 0;
        this.allUserStates.set(participant.identity, state);
        this.emit('audio-level', { userId: participant.identity, level: state.audioLevel });
      }
    });
  }
  
  /**
   * Create initial media state for a participant
   */
  private createMediaState(participant: RemoteParticipant): UserMediaState {
    return {
      userId: participant.identity,
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

