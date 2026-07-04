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

import { livekitWebRTC, type UserMediaState, type LiveKitConfig } from './livekitWebRTC';
import { unifiedWebRTC } from './unifiedWebRTC';
import { VoiceSettingsService } from './VoiceSettingsService';
import { debug } from '@/utils/debug';

// TYPES

export type WebRTCMode = 'sfu' | 'p2p' | 'hybrid';

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
  attachVideoToElement(userId: string, videoElement: HTMLVideoElement): boolean;
  detachVideoFromElement(userId: string, videoElement: HTMLVideoElement): void;
  
  // Events
  on(event: string, callback: Function): void;
  off(event: string, callback: Function): void;
  
  // Status
  isConnected(): boolean;
  getCurrentMode(): 'sfu' | 'p2p' | null;
  getActiveService(): 'livekit' | 'p2p' | null;
}

// WEBRTC MANAGER SERVICE

class WebRTCManagerService implements WebRTCManager {
  private currentMode: WebRTCMode = 'hybrid';
  private activeService: 'livekit' | 'p2p' | null = null;
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
    debug.log(`🔧 [WebRTCManager] Setting mode to: ${mode}`);
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
  getActiveService(): 'livekit' | 'p2p' | null {
    return this.activeService;
  }
  
  /**
   * Get the current connection mode (what's actually being used)
   */
  getCurrentMode(): 'sfu' | 'p2p' | null {
    if (!this.activeService) return null;
    return this.activeService === 'livekit' ? 'sfu' : 'p2p';
  }
  
  /**
   * Whether media for the active connection is end-to-end encrypted.
   * Currently only the LiveKit (SFU) transport encrypts media; P2P E2EE
   * activation is a follow-up.
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
      debug.log(`🔧 [WebRTCManager] LiveKit available: ${isAvailable}`);
      return isAvailable;
    } catch (error) {
      debug.warn('⚠️ [WebRTCManager] Failed to check LiveKit availability:', error);
      return false;
    }
  }
  
  // CONNECTION METHODS
  
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
    debug.log(`🎯 [WebRTCManager] Joining channel: ${channelId} as: ${userId}, E2EE: ${requireE2EE}`);
    
    // Voice E2EE is currently implemented only on the LiveKit (SFU) transport.
    // If a channel requires it, the P2P fallback can't satisfy the guarantee,
    // so we force SFU and refuse rather than silently downgrading.
    if (requireE2EE && this.currentMode === 'p2p') {
      this.emit('error', new Error('This channel requires end-to-end encrypted voice, which needs the SFU transport.'));
      return false;
    }
    
    // Check for cancellation before starting
    if (abortSignal?.aborted) {
      debug.log('🚫 [WebRTCManager] Connection cancelled before starting');
      return false;
    }
    
    // Leave any existing connection
    if (this.activeService) {
      await this.leaveChannel();
    }
    
    // Check for cancellation after cleanup
    if (abortSignal?.aborted) {
      debug.log('🚫 [WebRTCManager] Connection cancelled after cleanup');
      return false;
    }
    
    const useSFU = await this.shouldUseSFU();
    
    // Check for cancellation after checking SFU availability
    if (abortSignal?.aborted) {
      debug.log('🚫 [WebRTCManager] Connection cancelled after SFU check');
      return false;
    }
    
    if (useSFU) {
      // Try LiveKit first
      debug.log('🔄 [WebRTCManager] Attempting LiveKit connection...');
      
      // Set activeService BEFORE joining so events are forwarded during connection
      this.activeService = 'livekit';
      
      try {
        const success = await livekitWebRTC.joinChannel(channelId, userId, roomType, abortSignal, requireE2EE);
        
        // Check for cancellation after LiveKit join attempt
        if (abortSignal?.aborted) {
          if (success) {
            await livekitWebRTC.leaveChannel();
          }
          this.activeService = null;
          debug.log('🚫 [WebRTCManager] Connection cancelled after LiveKit join');
          return false;
        }
        
        if (success) {
          debug.log('✅ [WebRTCManager] Connected via LiveKit SFU');
          return true;
        }
        
        // Connection failed, reset activeService
        this.activeService = null;
      } catch (error) {
        // Check if this was a cancellation
        if (error instanceof Error && error.name === 'AbortError') {
          this.activeService = null;
          debug.log('🚫 [WebRTCManager] LiveKit connection cancelled');
          return false;
        }
        debug.warn('⚠️ [WebRTCManager] LiveKit connection failed:', error);
        this.activeService = null;
      }
      
      // If SFU-only mode, don't fallback
      if (this.currentMode === 'sfu') {
        debug.error('❌ [WebRTCManager] SFU connection failed and mode is sfu-only');
        this.emit('error', new Error('SFU connection failed'));
        return false;
      }
      
      // E2EE-required channels must not fall back to the (currently
      // unencrypted) P2P transport.
      if (requireE2EE) {
        debug.error('❌ [WebRTCManager] SFU failed and channel requires E2EE; not falling back to P2P');
        this.emit('error', new Error('Could not establish an end-to-end encrypted call'));
        return false;
      }
      
      debug.log('🔄 [WebRTCManager] Falling back to P2P...');
    }
    
    // Check for cancellation before trying P2P
    if (abortSignal?.aborted) {
      debug.log('🚫 [WebRTCManager] Connection cancelled before P2P attempt');
      return false;
    }
    
    // Use P2P (unifiedWebRTC)
    // Set activeService BEFORE joining so events are forwarded during connection
    this.activeService = 'p2p';
    
    try {
      const success = await unifiedWebRTC.joinChannel(channelId, userId, abortSignal);
      
      // Check for cancellation after P2P join attempt
      if (abortSignal?.aborted) {
        if (success) {
          await unifiedWebRTC.leaveChannel();
        }
        this.activeService = null;
        debug.log('🚫 [WebRTCManager] Connection cancelled after P2P join');
        return false;
      }
      
      if (success) {
        debug.log('✅ [WebRTCManager] Connected via P2P');
        return true;
      }
      
      this.activeService = null;
    } catch (error) {
      // Check if this was a cancellation
      if (error instanceof Error && error.name === 'AbortError') {
        this.activeService = null;
        debug.log('🚫 [WebRTCManager] P2P connection cancelled');
        return false;
      }
      debug.error('❌ [WebRTCManager] P2P connection failed:', error);
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
    debug.log(`🌐 [WebRTCManager] Joining federated channel: ${channelId} with remote token`);
    
    // Leave any existing connection
    if (this.activeService) {
      await this.leaveChannel();
    }
    
    // Set activeService BEFORE joining so events are forwarded during connection
    this.activeService = 'livekit';
    
    try {
      const success = await livekitWebRTC.joinWithToken(wsUrl, token, channelId, userId);
      
      if (success) {
        debug.log('✅ [WebRTCManager] Connected to federated LiveKit server');
        return true;
      }
      
      // Connection failed, reset activeService
      this.activeService = null;
      return false;
    } catch (error) {
      debug.error('❌ [WebRTCManager] Federated connection failed:', error);
      this.activeService = null;
      this.emit('error', error);
      return false;
    }
  }
  
  /**
   * Leave current voice channel
   */
  async leaveChannel(): Promise<void> {
    debug.log('👋 [WebRTCManager] Leaving channel');
    
    try {
      if (this.activeService === 'livekit') {
        await livekitWebRTC.leaveChannel();
      } else if (this.activeService === 'p2p') {
        await unifiedWebRTC.leaveChannel();
      }
    } catch (e) {
      debug.warn('⚠️ [WebRTCManager] Error during leaveChannel (forcing cleanup):', e);
    }
    
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
   * Set mute state directly (for Push-to-Talk)
   */
  setMuted(muted: boolean): void {
    if (this.activeService === 'livekit') {
      livekitWebRTC.setMuted(muted);
    } else if (this.activeService === 'p2p') {
      unifiedWebRTC.setMuted(muted);
    }
  }
  
  /**
   * Toggle deafen
   */
  toggleDeafen(): boolean {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.toggleDeafen();
    } else if (this.activeService === 'p2p') {
      return unifiedWebRTC.toggleDeafen();
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
   * Attach video track to element (required for LiveKit adaptive streaming)
   */
  attachVideoToElement(userId: string, videoElement: HTMLVideoElement): boolean {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.attachVideoToElement(userId, videoElement);
    } else if (this.activeService === 'p2p') {
      // For P2P, just use srcObject directly
      const stream = unifiedWebRTC.getUserStream(userId);
      if (stream) {
        videoElement.srcObject = stream;
        return true;
      }
    }
    return false;
  }

  /**
   * Detach video from element
   */
  detachVideoFromElement(userId: string, videoElement: HTMLVideoElement): void {
    if (this.activeService === 'livekit') {
      livekitWebRTC.detachVideoFromElement(userId, videoElement);
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
      debug.warn('⚠️ No active WebRTC service to update stream quality');
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
    
    debug.log('🎤 [WebRTCManager] Updated input device:', deviceId);
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
      await unifiedWebRTC.updateOutputDevice(deviceId);
    }
    
    debug.log('🔊 [WebRTCManager] Updated output device:', deviceId);
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
    
    debug.log('📹 [WebRTCManager] Updated video device:', deviceId);
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
   * Broadcast a message (P2P only)
   */
  broadcastMessage(message: any): void {
    if (this.activeService === 'p2p') {
      (unifiedWebRTC as any).broadcastMessage(message);
    }
  }
  
  /**
   * Set traditional audio enabled (for spatial audio dry/wet switching)
   */
  setTraditionalAudioEnabled(enabled: boolean): void {
    if (this.activeService === 'p2p') {
      unifiedWebRTC.setTraditionalAudioEnabled(enabled);
    } else if (this.activeService === 'livekit') {
      livekitWebRTC.setTraditionalAudioEnabled(enabled);
    }
  }

  /**
   * Set volume for a user's microphone audio (0-200, 100 = normal)
   */
  setUserMicVolume(userId: string, volume: number): void {
    if (this.activeService === 'livekit') {
      livekitWebRTC.setUserMicVolume(userId, volume);
    } else if (this.activeService === 'p2p') {
      (unifiedWebRTC as any).setUserVolume?.(userId, volume / 100); // P2P uses 0-1 scale
    }
    
    // Also apply to spatial audio chain (operates on the outputGain node,
    // so it works even when traditional audio elements are muted)
    import('./spatialAudio').then(({ spatialAudioService }) => {
      spatialAudioService.setUserVolume(userId, volume);
    }).catch(() => {});
  }
  
  /**
   * Set volume for a user's screenshare audio (0-200, 100 = normal)
   */
  setUserScreenShareVolume(userId: string, volume: number): void {
    if (this.activeService === 'livekit') {
      livekitWebRTC.setUserScreenShareVolume(userId, volume);
    }
    // P2P doesn't support screenshare audio separately yet
  }
  
  /**
   * Get mic volume for a user (0-200)
   */
  getUserMicVolume(userId: string): number {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.getUserMicVolume(userId);
    }
    return 100;
  }
  
  /**
   * Get screenshare volume for a user (0-200)
   */
  getUserScreenShareVolume(userId: string): number {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.getUserScreenShareVolume(userId);
    }
    return 100;
  }
  
  /**
   * Check if a user has screenshare audio available
   */
  hasScreenShareAudio(userId: string): boolean {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.hasScreenShareAudio(userId);
    }
    return false;
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

