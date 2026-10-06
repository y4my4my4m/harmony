/**
 * WebRTC Manager
 * 
 * Manages the switching between SFU (LiveKit) and P2P (unifiedWebRTC) modes.
 * Provides a unified interface for voice/video regardless of the underlying transport.
 * 
 * Connection Priority:
 * 1. SFU (LiveKit) - if configured and available
 * 2. P2P (unifiedWebRTC) - fallback
 * 
 * Mode Configuration:
 * - 'sfu': Only use LiveKit (fail if unavailable)
 * - 'p2p': Only use P2P (never try LiveKit)
 * - 'hybrid': Try LiveKit first, fallback to P2P
 */

import { livekitWebRTC, preloadLiveKit, type UserMediaState, type LiveKitConfig, type VideoSource } from './livekitWebRTC';
import { unifiedWebRTC } from './unifiedWebRTC';
import { VoiceSettingsService } from './VoiceSettingsService';
import { remoteAudioMixer, type RemoteAudioKind } from './voice/remoteAudioMixer';
import { debug } from '@/utils/debug';

// TYPES

export type WebRTCMode = 'sfu' | 'p2p' | 'hybrid';
export type ActiveWebRTCService = 'livekit' | 'p2p' | null;

export interface WebRTCManager {
  // Connection
  joinChannel(channelId: string, userId: string, roomType?: 'voice_channel' | 'dm_call' | 'stage'): Promise<boolean>;
  joinWithToken(wsUrl: string, token: string, channelId: string, userId: string): Promise<boolean>;
  leaveChannel(): Promise<void>;
  
  // Media controls
  toggleVideo(): Promise<boolean>;
  toggleScreenShare(): Promise<boolean>;
  toggleMute(): boolean;
  toggleDeafen(): boolean;
  setTransmitGate(open: boolean): void;
  
  // Volume control
  setUserMicVolume(userId: string, volume: number): void;
  setUserScreenShareVolume(userId: string, volume: number): void;
  getUserMicVolume(userId: string): number;
  getUserScreenShareVolume(userId: string): number;
  hasScreenShareAudio(userId: string): boolean;
  
  // Stream quality control
  updateStreamQuality(settings: { resolution?: number; frameRate?: number; audioBitrate?: number }): Promise<void>;
  
  // Stream access
  getLocalStream(): MediaStream | null;
  getUserStream(userId: string): MediaStream | null;
  getLocalState(): UserMediaState;
  getAllUsers(): UserMediaState[];
  
  // Video element attachment (required for LiveKit adaptive streaming)
  attachVideoToElement(userId: string, videoElement: HTMLVideoElement, source?: VideoSource): boolean;
  detachVideoFromElement(userId: string, videoElement: HTMLVideoElement, source?: VideoSource): void;
  
  // Events
  on(event: string, callback: Function): void;
  off(event: string, callback: Function): void;
  
  // Status
  isConnected(): boolean;
  getCurrentMode(): 'sfu' | 'p2p' | null;
  getActiveService(): ActiveWebRTCService;
}

// WEBRTC MANAGER SERVICE

class WebRTCManagerService implements WebRTCManager {
  private currentMode: WebRTCMode = 'hybrid';
  private activeService: ActiveWebRTCService = null;
  private transmitGateOpen = true;
  private configCache: LiveKitConfig | null = null;
  private eventListeners = new Map<string, Function[]>();
  
  constructor() {
    // Forward events from both services
    this.setupEventForwarding();
  }
  
  /**
   * Setup event forwarding from both services
   */
  private setupEventForwarding(): void {
    const eventsToForward = [
      'channel-joined',
      'channel-left',
      'user-joined',
      'user-left',
      'user-state-changed',
      'user-stream-changed',
      'local-state-changed',
      'local-stream-changed',
      'channel-state-synced',
      'audio-level',
      'connection-state-changed',
      'connection-lost',
      'microphone-unavailable',
      'connection-quality-changed',
      'stream-watch-changed',
      'error',
      'call-start-time',
      'request-call-start-time',
      'e2ee-status-changed',
    ];
    
    for (const event of eventsToForward) {
      livekitWebRTC.on(event, (data: any) => {
        if (this.activeService === 'livekit') {
          this.emit(event, data);
        }
      });

      unifiedWebRTC.on(event, (data: any) => {
        if (this.activeService === 'p2p') {
          this.emit(event, data);
        }
      });
    }
  }

  /**
   * Set the WebRTC mode
   */
  setMode(mode: WebRTCMode): void {
    debug.log(`[WebRTCManager] Setting mode to: ${mode}`);
    this.currentMode = mode;
  }
  
  /**
   * Get the current mode setting
   */
  getMode(): WebRTCMode {
    return this.currentMode;
  }
  
  /**
   * Get the currently active service
   */
  getActiveService(): ActiveWebRTCService {
    return this.activeService;
  }

  /**
   * Get the current connection mode (what's actually being used)
   */
  getCurrentMode(): 'sfu' | 'p2p' | null {
    if (!this.activeService) return null;
    return this.activeService === 'p2p' ? 'p2p' : 'sfu';
  }
  
  /**
   * Whether media for the active connection is end-to-end encrypted.
   * Only the LiveKit (SFU) transport encrypts media; P2P does not.
   */
  isE2EEEnabled(): boolean {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.isE2EEEnabled();
    }
    return false;
  }
  
  /**
   * Check if SFU is available and should be used
   */
  private async shouldUseSFU(): Promise<boolean> {
    if (this.currentMode === 'p2p') {
      return false;
    }
    
    if (this.currentMode === 'sfu') {
      return true; // Force SFU (will fail if unavailable)
    }
    
    // Hybrid mode: check if LiveKit is available
    try {
      const isAvailable = await livekitWebRTC.isAvailable();
      debug.log(`[WebRTCManager] LiveKit available: ${isAvailable}`);
      return isAvailable;
    } catch (error) {
      debug.warn('[WebRTCManager] Failed to check LiveKit availability:', error);
      return false;
    }
  }
  
  // CONNECTION METHODS
  
  /** Starts the SFU library download ahead of a join. P2P mode never loads it. */
  preloadTransport(): void {
    if (this.currentMode !== 'p2p') {
      preloadLiveKit();
    }
  }

  /**
   * Join a voice channel
   * Automatically selects the best available transport
   */
  async joinChannel(
    channelId: string,
    userId: string,
    roomType: 'voice_channel' | 'dm_call' | 'stage' = 'voice_channel',
    abortSignal?: AbortSignal,
    requireE2EE = false
  ): Promise<boolean> {
    debug.log(`[WebRTCManager] Joining channel: ${channelId} as: ${userId}, E2EE: ${requireE2EE}`);
    
    // Voice E2EE exists only on the LiveKit (SFU) transport. A channel that
    // requires it cannot be served by the P2P fallback, so refuse rather than
    // silently downgrade.
    if (requireE2EE && this.currentMode === 'p2p') {
      this.emit('error', new Error('This channel requires end-to-end encrypted voice, which needs the SFU transport.'));
      return false;
    }
    
    // Check for cancellation before starting
    if (abortSignal?.aborted) {
      debug.log('[WebRTCManager] Connection cancelled before starting');
      return false;
    }

    // Leave any existing connection
    if (this.activeService) {
      await this.leaveChannel();
    }

    // Check for cancellation after cleanup
    if (abortSignal?.aborted) {
      debug.log('[WebRTCManager] Connection cancelled after cleanup');
      return false;
    }

    const useSFU = await this.shouldUseSFU();
    
    // Check for cancellation after checking SFU availability
    if (abortSignal?.aborted) {
      debug.log('[WebRTCManager] Connection cancelled after SFU check');
      return false;
    }
    
    if (useSFU) {
      // Try LiveKit first
      debug.log('[WebRTCManager] Attempting LiveKit connection...');
      
      // Set activeService BEFORE joining so events are forwarded during connection
      this.activeService = 'livekit';
      livekitWebRTC.setTransmitGate(this.transmitGateOpen);

      try {
        const success = await livekitWebRTC.joinChannel(channelId, userId, roomType, abortSignal, requireE2EE);
        
        // Check for cancellation after LiveKit join attempt
        if (abortSignal?.aborted) {
          if (success) {
            await livekitWebRTC.leaveChannel();
          }
          this.activeService = null;
          debug.log('[WebRTCManager] Connection cancelled after LiveKit join');
          return false;
        }
        
        if (success) {
          debug.log('[WebRTCManager] Connected via LiveKit SFU');
          return true;
        }
        
        // Connection failed, reset activeService
        this.activeService = null;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          this.activeService = null;
          debug.log('[WebRTCManager] LiveKit connection cancelled');
          return false;
        }
        debug.warn('[WebRTCManager] LiveKit connection failed:', error);
        this.activeService = null;
      }
      
      // If SFU-only mode, don't fallback
      if (this.currentMode === 'sfu') {
        debug.error('[WebRTCManager] SFU connection failed and mode is sfu-only');
        this.emit('error', new Error('SFU connection failed'));
        return false;
      }
      
      // E2EE-required channels must not fall back to the (currently
      // unencrypted) P2P transport.
      if (requireE2EE) {
        debug.error('[WebRTCManager] SFU failed and channel requires E2EE; not falling back to P2P');
        this.emit('error', new Error('Could not establish an end-to-end encrypted call'));
        return false;
      }
      
      debug.log('[WebRTCManager] Falling back to P2P...');
    }
    
    // Check for cancellation before trying P2P
    if (abortSignal?.aborted) {
      debug.log('[WebRTCManager] Connection cancelled before P2P attempt');
      return false;
    }
    
    // Use P2P (unifiedWebRTC)
    // Set activeService BEFORE joining so events are forwarded during connection
    this.activeService = 'p2p';
    void remoteAudioMixer.setOutputDevice(VoiceSettingsService.getDevices().outputDevice);
    unifiedWebRTC.setTransmitGate(this.transmitGateOpen);

    try {
      const success = await unifiedWebRTC.joinChannel(channelId, userId, abortSignal);
      
      // Check for cancellation after P2P join attempt
      if (abortSignal?.aborted) {
        if (success) {
          await unifiedWebRTC.leaveChannel();
        }
        this.activeService = null;
        debug.log('[WebRTCManager] Connection cancelled after P2P join');
        return false;
      }
      
      if (success) {
        debug.log('[WebRTCManager] Connected via P2P');
        return true;
      }
      
      this.activeService = null;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.activeService = null;
        debug.log('[WebRTCManager] P2P connection cancelled');
        return false;
      }
      debug.error('[WebRTCManager] P2P connection failed:', error);
      this.activeService = null;
      this.emit('error', error);
    }
    
    return false;
  }
  
  /**
   * Join a voice channel with a pre-obtained token (for federated voice)
   * Used when connecting to a remote instance's LiveKit server
   */
  async joinWithToken(
    wsUrl: string,
    token: string,
    channelId: string,
    userId: string
  ): Promise<boolean> {
    debug.log(`[WebRTCManager] Joining federated channel: ${channelId} with remote token`);
    
    // Leave any existing connection
    if (this.activeService) {
      await this.leaveChannel();
    }

    // Set activeService BEFORE joining so events are forwarded during connection
    this.activeService = 'livekit';
    livekitWebRTC.setTransmitGate(this.transmitGateOpen);

    try {
      const success = await livekitWebRTC.joinWithToken(wsUrl, token, channelId, userId);

      if (success) {
        debug.log('[WebRTCManager] Connected to federated LiveKit server');
        return true;
      }

      // Connection failed, reset activeService
      this.activeService = null;
      return false;
    } catch (error) {
      debug.error('[WebRTCManager] Federated connection failed:', error);
      this.activeService = null;
      this.emit('error', error);
      return false;
    }
  }
  
  /**
   * Leave current voice channel
   */
  async leaveChannel(): Promise<void> {
    debug.log('[WebRTCManager] Leaving channel');
    
    try {
      if (this.activeService === 'livekit') {
        await livekitWebRTC.leaveChannel();
      } else if (this.activeService === 'p2p') {
        await unifiedWebRTC.leaveChannel();
      }
    } catch (e) {
      debug.warn('[WebRTCManager] Error during leaveChannel (forcing cleanup):', e);
    }

    remoteAudioMixer.reset();
    this.activeService = null;
  }
  
  // MEDIA CONTROLS
  
  /**
   * Toggle video
   */
  async toggleVideo(): Promise<boolean> {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.toggleVideo();
    } else if (this.activeService === 'p2p') {
      return unifiedWebRTC.toggleVideo();
    }
    return false;
  }
  
  /**
   * Toggle screen share
   */
  async toggleScreenShare(): Promise<boolean> {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.toggleScreenShare();
    } else if (this.activeService === 'p2p') {
      return unifiedWebRTC.toggleScreenShare();
    }
    return false;
  }
  
  /**
   * Toggle mute
   */
  toggleMute(): boolean {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.toggleMute();
    } else if (this.activeService === 'p2p') {
      return unifiedWebRTC.toggleMute();
    }
    return false;
  }
  
  /**
   * Set explicit mute state (user intent — broadcast to peers)
   */
  setMuted(muted: boolean): void {
    if (this.activeService === 'livekit') {
      livekitWebRTC.setMuted(muted);
    } else if (this.activeService === 'p2p') {
      unifiedWebRTC.setMuted(muted);
    }
  }

  /**
   * PTT transmit gate — cached so joins pick it up before the mic is published
   */
  setTransmitGate(open: boolean): void {
    this.transmitGateOpen = open;
    if (this.activeService === 'livekit') {
      livekitWebRTC.setTransmitGate(open);
    } else if (this.activeService === 'p2p') {
      unifiedWebRTC.setTransmitGate(open);
    }
  }
  
  /**
   * Toggle deafen
   */
  toggleDeafen(): boolean {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.toggleDeafen();
    } else if (this.activeService === 'p2p') {
      const deafened = unifiedWebRTC.toggleDeafen();
      remoteAudioMixer.setDeafened(deafened);
      return deafened;
    }
    return false;
  }
  
  // STREAM ACCESS
  
  /**
   * Get local stream
   */
  getLocalStream(): MediaStream | null {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.getLocalStream();
    } else if (this.activeService === 'p2p') {
      return unifiedWebRTC.getLocalStream();
    }
    return null;
  }
  
  /**
   * Get user stream
   */
  getUserStream(userId: string): MediaStream | null {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.getUserStream(userId);
    } else if (this.activeService === 'p2p') {
      return unifiedWebRTC.getUserStream(userId);
    }
    return null;
  }

  /**
   * Get a user's microphone-only stream for spatial audio processing.
   * Must exclude screenshare audio - spatializing a movie soundtrack is wrong.
   */
  getUserMicStream(userId: string): MediaStream | null {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.getUserMicStream(userId);
    } else if (this.activeService === 'p2p') {
      // P2P mic/camera stream carries mic audio only (screen audio lives in its own stream)
      return unifiedWebRTC.getUserStream(userId);
    }
    return null;
  }

  /**
   * Attach video track to element (required for LiveKit adaptive streaming)
   */
  attachVideoToElement(userId: string, videoElement: HTMLVideoElement, source: VideoSource = 'auto'): boolean {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.attachVideoToElement(userId, videoElement, source);
    } else if (this.activeService === 'p2p') {
      // P2P keeps camera/mic and screenshare in separate MediaStreams.
      // Wrap the video track alone so the <video> element never doubles up audio
      // (audio playback is owned by the service's dedicated audio elements).
      const screenStream = unifiedWebRTC.getUserScreenStream(userId);
      const cameraStream = unifiedWebRTC.getUserStream(userId);
      const stream = source === 'screen' ? screenStream
        : source === 'camera' ? cameraStream
        : screenStream || cameraStream;

      const videoTrack = stream?.getVideoTracks()[0];
      if (videoTrack) {
        videoElement.srcObject = new MediaStream([videoTrack]);
        return true;
      }
    }
    return false;
  }

  /**
   * Detach video from element
   */
  detachVideoFromElement(userId: string, videoElement: HTMLVideoElement, source: VideoSource = 'auto'): void {
    if (this.activeService === 'livekit') {
      livekitWebRTC.detachVideoFromElement(userId, videoElement, source);
    } else {
      videoElement.srcObject = null;
    }
  }

  /**
   * Update stream quality settings (resolution, framerate, audio bitrate)
   * Applies to currently active video/screenshare and audio tracks
   */
  async updateStreamQuality(settings: { resolution?: number; frameRate?: number; audioBitrate?: number }): Promise<void> {
    if (this.activeService === 'livekit') {
      await livekitWebRTC.updateStreamQuality(settings);
    } else if (this.activeService === 'p2p') {
      await unifiedWebRTC.updateStreamQuality(settings);
    } else {
      debug.warn('No active WebRTC service to update stream quality');
    }
  }
  
  /**
   * Get local state
   */
  getLocalState(): UserMediaState {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.getLocalState();
    } else if (this.activeService === 'p2p') {
      return unifiedWebRTC.getLocalState();
    }
    return {
      userId: '',
      isAudioEnabled: false,
      isVideoEnabled: false,
      isScreenSharing: false,
      isMuted: false,
      isDeafened: false,
      isSpeaking: false,
      audioLevel: 0,
    };
  }
  
  /**
   * Get all users
   */
  getAllUsers(): UserMediaState[] {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.getAllUsers();
    } else if (this.activeService === 'p2p') {
      return unifiedWebRTC.getAllUsers();
    }
    return [];
  }
  
  // STATUS
  
  /**
   * Check if connected
   */
  isConnected(): boolean {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.isConnected();
    } else if (this.activeService === 'p2p') {
      return !!unifiedWebRTC.getLocalState().userId;
    }
    return false;
  }
  
  // DEVICE MANAGEMENT
  
  /**
   * Update input device
   */
  async updateInputDevice(deviceId: string): Promise<void> {
    // Always save to VoiceSettingsService first
    VoiceSettingsService.setInputDevice(deviceId);
    
    if (this.activeService === 'livekit') {
      await livekitWebRTC.updateInputDevice(deviceId);
    } else if (this.activeService === 'p2p') {
      await unifiedWebRTC.updateInputDevice(deviceId);
    }
    
    debug.log('[WebRTCManager] Updated input device:', deviceId);
  }
  
  /**
   * Update output device
   */
  async updateOutputDevice(deviceId: string): Promise<void> {
    // Always save to VoiceSettingsService first
    VoiceSettingsService.setOutputDevice(deviceId);
    
    if (this.activeService === 'livekit') {
      await livekitWebRTC.updateOutputDevice(deviceId);
    } else if (this.activeService === 'p2p') {
      await remoteAudioMixer.setOutputDevice(deviceId);
      await unifiedWebRTC.updateOutputDevice(deviceId);
    }
    
    debug.log('[WebRTCManager] Updated output device:', deviceId);
  }
  
  /**
   * Update video device
   */
  async updateVideoDevice(deviceId: string): Promise<void> {
    // Always save to VoiceSettingsService first
    VoiceSettingsService.setVideoDevice(deviceId);
    
    if (this.activeService === 'livekit') {
      await livekitWebRTC.updateVideoDevice(deviceId);
    } else if (this.activeService === 'p2p') {
      await unifiedWebRTC.updateVideoDevice(deviceId);
    }
    
    debug.log('[WebRTCManager] Updated video device:', deviceId);
  }
  
  /**
   * Get selected devices
   * Falls back to VoiceSettingsService when no active connection
   */
  getSelectedDevices(): { inputDevice: string | null; outputDevice: string | null; videoDevice: string | null } {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.getSelectedDevices();
    } else if (this.activeService === 'p2p') {
      return unifiedWebRTC.getSelectedDevices();
    }
    // Fallback to VoiceSettingsService when no active service
    return VoiceSettingsService.getDevices();
  }
  
  // P2P-SPECIFIC METHODS (passthrough for compatibility)
  
  /**
   * Broadcast a message to all participants
   */
  broadcastMessage(message: any): void {
    if (this.activeService === 'livekit') {
      livekitWebRTC.broadcastMessage(message);
    } else if (this.activeService === 'p2p') {
      (unifiedWebRTC as any).broadcastMessage(message);
    }
  }
  
  /**
   * Set traditional audio enabled (for spatial audio dry/wet switching)
   */
  setTraditionalAudioEnabled(enabled: boolean): void {
    if (this.activeService === 'p2p') {
      unifiedWebRTC.setTraditionalAudioEnabled(enabled);
      remoteAudioMixer.setDryMuted('mic', !enabled);
    } else if (this.activeService === 'livekit') {
      livekitWebRTC.setTraditionalAudioEnabled(enabled);
    }
  }

  // PER-USER AUDIO
  // Both transports play through remoteAudioMixer, which holds volumes and
  // local mutes across joins.

  /**
   * Seeds the mixer before a join so the first frames of every track already
   * play at the listener's level.
   */
  primeAudioPrefs(prefs: {
    micVolumes: Map<string, number>;
    streamVolumes: Map<string, number>;
    mutes: Record<RemoteAudioKind, Set<string>>;
  }): void {
    for (const [userId, volume] of prefs.micVolumes) remoteAudioMixer.setVolume(userId, 'mic', volume);
    for (const [userId, volume] of prefs.streamVolumes) remoteAudioMixer.setVolume(userId, 'screen', volume);
    for (const kind of ['mic', 'screen'] as const) {
      for (const userId of prefs.mutes[kind]) remoteAudioMixer.setLocalMute(userId, kind, true);
    }
  }

  /** Applies every stored preference to the connected transport. */
  applyAudioPrefs(prefs: {
    micVolumes: Map<string, number>;
    streamVolumes: Map<string, number>;
    mutes: Record<RemoteAudioKind, Set<string>>;
  }): void {
    this.primeAudioPrefs(prefs);
    this.syncSpatialVolumes();
  }

  private syncSpatialVolumes(userId?: string): void {
    // The spatial graph renders the mic on its own gain node.
    import('./spatialAudio').then(({ spatialAudioService }) => {
      if (userId) {
        spatialAudioService.setUserVolume(userId, remoteAudioMixer.getEffectiveVolume(userId, 'mic'));
      } else {
        spatialAudioService.syncUserVolumes();
      }
    }).catch(() => {});
  }

  /**
   * Outgoing mic level, percent 0-200, applied after the browser's
   * processing. Both transports hold the value; the connected one applies
   * it live.
   */
  setInputVolume(volume: number): void {
    livekitWebRTC.setInputVolume(volume);
    unifiedWebRTC.setInputVolume(volume);
  }

  /** Master output level, percent 0-200, over every remote track. */
  setMasterVolume(volume: number): void {
    remoteAudioMixer.setMasterVolume(volume);
    this.syncSpatialVolumes();
  }

  /** Microphone volume of a remote user, 0-200 (100 = normal). */
  setUserMicVolume(userId: string, volume: number): void {
    remoteAudioMixer.setVolume(userId, 'mic', volume);
    this.syncSpatialVolumes(userId);
  }

  /** Stream audio volume of a remote user, 0-200 (100 = normal). */
  setUserScreenShareVolume(userId: string, volume: number): void {
    remoteAudioMixer.setVolume(userId, 'screen', volume);
  }

  /** Silences a remote user's mic or stream for this listener only; the volume is kept. */
  setUserLocalMute(userId: string, kind: RemoteAudioKind, muted: boolean): void {
    remoteAudioMixer.setLocalMute(userId, kind, muted);
    if (kind === 'mic') this.syncSpatialVolumes(userId);
  }

  getUserMicVolume(userId: string): number {
    return remoteAudioMixer.getVolume(userId, 'mic');
  }

  getUserScreenShareVolume(userId: string): number {
    return remoteAudioMixer.getVolume(userId, 'screen');
  }

  hasScreenShareAudio(userId: string): boolean {
    return remoteAudioMixer.has(userId, 'screen');
  }

  /** Retries audio the browser refused to autoplay. Call from a user gesture. */
  async startAudio(): Promise<boolean> {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.startAudio();
    }
    return remoteAudioMixer.resume();
  }

  // STREAM WATCHING (LiveKit; P2P always receives streams)

  setAutoWatchStreams(enabled: boolean): void {
    livekitWebRTC.setAutoWatchStreams(enabled);
  }

  supportsStreamWatching(): boolean {
    return this.activeService === 'livekit';
  }

  setStreamWatched(userId: string, watching: boolean): void {
    if (this.activeService === 'livekit') {
      livekitWebRTC.setStreamWatched(userId, watching);
    }
  }

  getWatchedStreams(): string[] {
    return this.activeService === 'livekit' ? livekitWebRTC.getWatchedStreams() : [];
  }

  /** Echo cancellation, noise suppression and gain control; applied to a live mic. */
  async updateAudioConstraints(constraints: { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean }): Promise<void> {
    VoiceSettingsService.setAudioConstraints(constraints);
    if (this.activeService === 'livekit') {
      await livekitWebRTC.updateAudioConstraints(constraints);
    } else if (this.activeService === 'p2p') {
      await unifiedWebRTC.updateAudioConstraints(constraints);
    }
  }
  
  // EVENT SYSTEM
  
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
}

// SINGLETON INSTANCE

export const webrtcManager = new WebRTCManagerService();
export default webrtcManager;

