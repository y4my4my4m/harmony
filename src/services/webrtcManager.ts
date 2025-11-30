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
import { debug } from '@/utils/debug';

// =============================================================================
// TYPES
// =============================================================================

export type WebRTCMode = 'sfu' | 'p2p' | 'hybrid';

export interface WebRTCManager {
  // Connection
  joinChannel(channelId: string, userId: string, roomType?: 'voice_channel' | 'dm_call' | 'stage'): Promise<boolean>;
  leaveChannel(): Promise<void>;
  
  // Media controls
  toggleVideo(): Promise<boolean>;
  toggleScreenShare(): Promise<boolean>;
  toggleMute(): boolean;
  toggleDeafen(): boolean;
  
  // Stream access
  getLocalStream(): MediaStream | null;
  getUserStream(userId: string): MediaStream | null;
  getLocalState(): UserMediaState;
  getAllUsers(): UserMediaState[];
  
  // Events
  on(event: string, callback: Function): void;
  off(event: string, callback: Function): void;
  
  // Status
  isConnected(): boolean;
  getCurrentMode(): 'sfu' | 'p2p' | null;
  getActiveService(): 'livekit' | 'p2p' | null;
}

// =============================================================================
// WEBRTC MANAGER SERVICE
// =============================================================================

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
  
  // =============================================================================
  // CONNECTION METHODS
  // =============================================================================
  
  /**
   * Join a voice channel
   * Automatically selects the best available transport
   */
  async joinChannel(
    channelId: string,
    userId: string,
    roomType: 'voice_channel' | 'dm_call' | 'stage' = 'voice_channel'
  ): Promise<boolean> {
    debug.log(`🎯 [WebRTCManager] Joining channel: ${channelId} as: ${userId}`);
    
    // Leave any existing connection
    if (this.activeService) {
      await this.leaveChannel();
    }
    
    const useSFU = await this.shouldUseSFU();
    
    if (useSFU) {
      // Try LiveKit first
      debug.log('🔄 [WebRTCManager] Attempting LiveKit connection...');
      
      // Set activeService BEFORE joining so events are forwarded during connection
      this.activeService = 'livekit';
      
      try {
        const success = await livekitWebRTC.joinChannel(channelId, userId, roomType);
        
        if (success) {
          debug.log('✅ [WebRTCManager] Connected via LiveKit SFU');
          return true;
        }
        
        // Connection failed, reset activeService
        this.activeService = null;
      } catch (error) {
        debug.warn('⚠️ [WebRTCManager] LiveKit connection failed:', error);
        this.activeService = null;
      }
      
      // If SFU-only mode, don't fallback
      if (this.currentMode === 'sfu') {
        debug.error('❌ [WebRTCManager] SFU connection failed and mode is sfu-only');
        this.emit('error', new Error('SFU connection failed'));
        return false;
      }
      
      debug.log('🔄 [WebRTCManager] Falling back to P2P...');
    }
    
    // Use P2P (unifiedWebRTC)
    // Set activeService BEFORE joining so events are forwarded during connection
    this.activeService = 'p2p';
    
    try {
      const success = await unifiedWebRTC.joinChannel(channelId, userId);
      
      if (success) {
        debug.log('✅ [WebRTCManager] Connected via P2P');
        return true;
      }
      
      this.activeService = null;
    } catch (error) {
      debug.error('❌ [WebRTCManager] P2P connection failed:', error);
      this.activeService = null;
      this.emit('error', error);
    }
    
    return false;
  }
  
  /**
   * Leave current voice channel
   */
  async leaveChannel(): Promise<void> {
    debug.log('👋 [WebRTCManager] Leaving channel');
    
    if (this.activeService === 'livekit') {
      await livekitWebRTC.leaveChannel();
    } else if (this.activeService === 'p2p') {
      await unifiedWebRTC.leaveChannel();
    }
    
    this.activeService = null;
  }
  
  // =============================================================================
  // MEDIA CONTROLS
  // =============================================================================
  
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
  
  // =============================================================================
  // STREAM ACCESS
  // =============================================================================
  
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
  
  // =============================================================================
  // STATUS
  // =============================================================================
  
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
  
  // =============================================================================
  // DEVICE MANAGEMENT
  // =============================================================================
  
  /**
   * Update input device
   */
  async updateInputDevice(deviceId: string): Promise<void> {
    if (this.activeService === 'livekit') {
      await livekitWebRTC.updateInputDevice(deviceId);
    } else if (this.activeService === 'p2p') {
      await unifiedWebRTC.updateInputDevice(deviceId);
    }
  }
  
  /**
   * Update output device
   */
  async updateOutputDevice(deviceId: string): Promise<void> {
    if (this.activeService === 'livekit') {
      await livekitWebRTC.updateOutputDevice(deviceId);
    } else if (this.activeService === 'p2p') {
      await unifiedWebRTC.updateOutputDevice(deviceId);
    }
  }
  
  /**
   * Update video device
   */
  async updateVideoDevice(deviceId: string): Promise<void> {
    if (this.activeService === 'livekit') {
      await livekitWebRTC.updateVideoDevice(deviceId);
    } else if (this.activeService === 'p2p') {
      await unifiedWebRTC.updateVideoDevice(deviceId);
    }
  }
  
  /**
   * Get selected devices
   */
  getSelectedDevices(): { inputDevice: string | null; outputDevice: string | null; videoDevice: string | null } {
    if (this.activeService === 'livekit') {
      return livekitWebRTC.getSelectedDevices();
    } else if (this.activeService === 'p2p') {
      return unifiedWebRTC.getSelectedDevices();
    }
    return { inputDevice: null, outputDevice: null, videoDevice: null };
  }
  
  // =============================================================================
  // P2P-SPECIFIC METHODS (passthrough for compatibility)
  // =============================================================================
  
  /**
   * Broadcast a message (P2P only)
   */
  broadcastMessage(message: any): void {
    if (this.activeService === 'p2p') {
      unifiedWebRTC.broadcastMessage(message);
    }
  }
  
  /**
   * Set traditional audio enabled (P2P only, for spatial audio)
   */
  setTraditionalAudioEnabled(enabled: boolean): void {
    if (this.activeService === 'p2p') {
      unifiedWebRTC.setTraditionalAudioEnabled(enabled);
    }
  }

  /**
   * Set volume for a specific user (0-2, where 1 = normal)
   * Used for per-user volume control
   */
  setUserVolume(userId: string, volume: number): void {
    if (this.activeService === 'livekit') {
      livekitWebRTC.setUserVolume?.(userId, volume);
    } else if (this.activeService === 'p2p') {
      unifiedWebRTC.setUserVolume?.(userId, volume);
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
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const webrtcManager = new WebRTCManagerService();
export default webrtcManager;

