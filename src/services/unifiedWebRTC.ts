import { supabase } from '@/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

// =============================================================================
// TYPES & INTERFACES
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

export interface UserConnection {
  userId: string;
  peerConnection: RTCPeerConnection;
  mediaState: UserMediaState;
  remoteStream: MediaStream | null;
  audioElement: HTMLAudioElement | null;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
}

export interface SignalingMessage {
  type: 'offer' | 'answer' | 'ice-candidate' | 'user-joined' | 'user-left' | 'media-state' | 'state-sync';
  from: string;
  to?: string;
  data: any;
  timestamp: number;
}

export interface ChannelState {
  participants: UserMediaState[];
  channelId: string;
}

// =============================================================================
// MAIN WEBRTC SERVICE
// =============================================================================

export class UnifiedWebRTCService {
  private channelId: string | null = null;
  private currentUserId: string | null = null;
  private signalChannel: RealtimeChannel | null = null;
  
  // Local media and state
  private localStream: MediaStream | null = null;
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
  
  // Remote connections and states
  private connections = new Map<string, UserConnection>();
  private allUserStates = new Map<string, UserMediaState>();
  
  // Event system
  private eventListeners = new Map<string, Function[]>();
  
  // Audio context for level monitoring
  private audioContext: AudioContext | null = null;
  private localAudioAnalyser: AnalyserNode | null = null;
  
  // Audio constraints settings
  private audioConstraints = {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
    sampleRate: 48000
  };

  // Device selection
  private selectedInputDevice: string | null = null;
  private selectedOutputDevice: string | null = null;
  private selectedVideoDevice: string | null = null;
  
  constructor() {
    this.setupCleanup();
    this.loadAudioSettings();
    this.setupSettingsListener();
  }

  // =============================================================================
  // PUBLIC API
  // =============================================================================

  /**
   * Update input device and restart audio stream
   */
  async updateInputDevice(deviceId: string): Promise<void> {
    console.log('🎤 Updating input device to:', deviceId);
    
    this.selectedInputDevice = deviceId;
    this.saveAudioSettings(); // Use existing method
    
    // If we're currently connected, restart the audio stream with new device
    if (this.localStream && this.channelId) {
      const currentMuteState = this.localMediaState.isMuted;
      
      try {
        // Stop current audio tracks
        const audioTracks = this.localStream.getAudioTracks();
        audioTracks.forEach(track => {
          track.stop();
          this.localStream!.removeTrack(track);
        });
        
        // Get new audio stream with selected device
        const audioConstraints: MediaTrackConstraints = {
          ...this.audioConstraints,
          deviceId: { exact: deviceId }
        };
        
        const newAudioStream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false
        });
        
        const newAudioTrack = newAudioStream.getAudioTracks()[0];
        if (newAudioTrack) {
          // Add new track to local stream
          this.localStream.addTrack(newAudioTrack);
          
          // Apply current mute state
          newAudioTrack.enabled = !currentMuteState;
          
          // Update all peer connections with new audio track
          for (const [userId, conn] of this.connections) {
            try {
              const senders = conn.peerConnection.getSenders();
              const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
              
              if (audioSender) {
                await audioSender.replaceTrack(newAudioTrack);
                console.log('🔄 Replaced audio track for peer:', userId);
              }
            } catch (error) {
              console.error('❌ Error updating audio track for peer', userId, ':', error);
            }
          }
          
          // Restart audio level monitoring
          this.setupAudioLevelMonitoring();
          
          console.log('✅ Input device updated successfully');
          this.emit('local-stream-changed', this.localStream);
          this.emit('stream-changed', { userId: this.currentUserId, stream: this.localStream, type: 'local' });
        }
      } catch (error) {
        console.error('❌ Failed to update input device:', error);
        this.emit('error', error);
        throw error;
      }
    }
  }

  /**
   * Update output device for all remote audio elements
   */
  async updateOutputDevice(deviceId: string): Promise<void> {
    console.log('🔊 Updating output device to:', deviceId);
    
    this.selectedOutputDevice = deviceId;
    this.saveAudioSettings(); // Use existing method
    
    // Update all existing audio elements to use new output device
    for (const [userId, connection] of this.connections) {
      if (connection.audioElement && connection.audioElement.setSinkId) {
        try {
          await connection.audioElement.setSinkId(deviceId);
          console.log('🔊 Updated output device for user:', userId);
        } catch (error) {
          console.error('❌ Failed to update output device for user:', userId, error);
        }
      }
    }
    
    console.log('✅ Output device updated successfully');
  }

  /**
   * Update video device and restart video stream if enabled
   */
  async updateVideoDevice(deviceId: string): Promise<void> {
    console.log('🎥 Updating video device to:', deviceId);
    
    this.selectedVideoDevice = deviceId;
    this.saveAudioSettings(); // Use existing method
    
    // If video is currently enabled, restart with new device
    if (this.localMediaState.isVideoEnabled && this.localStream && this.channelId) {
      try {
        // Stop current video tracks
        const videoTracks = this.localStream.getVideoTracks();
        videoTracks.forEach(track => {
          track.stop();
          this.localStream!.removeTrack(track);
        });
        
        // Get new video stream with selected device
        const videoConstraints: any = {
          video: {
            deviceId: { exact: deviceId },
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 60 }
          },
          audio: false
        };
        
        const newVideoStream = await navigator.mediaDevices.getUserMedia(videoConstraints);
        const newVideoTrack = newVideoStream.getVideoTracks()[0];
        
        if (newVideoTrack) {
          // Add new track to local stream
          this.localStream.addTrack(newVideoTrack);
          
          // Update all peer connections with new video track
          for (const [userId, conn] of this.connections) {
            try {
              const senders = conn.peerConnection.getSenders();
              const videoSender = senders.find(s => s.track && s.track.kind === 'video');
              
              if (videoSender) {
                await videoSender.replaceTrack(newVideoTrack);
                console.log('🔄 Replaced video track for peer:', userId);
              }
            } catch (error) {
              console.error('❌ Error updating video track for peer', userId, ':', error);
            }
          }
          
          console.log('✅ Video device updated successfully');
          this.emit('local-stream-changed', this.localStream);
          this.emit('stream-changed', { userId: this.currentUserId, stream: this.localStream, type: 'local' });
        }
      } catch (error) {
        console.error('❌ Failed to update video device:', error);
        this.emit('error', error);
        throw error;
      }
    }
  }
  /**
   * Join a voice channel - Discord-like experience
   */
  async joinChannel(channelId: string, userId: string): Promise<boolean> {
    console.log('🎯 Joining voice channel:', channelId, 'as user:', userId);
    
    try {
      // Clean previous connection
      if (this.channelId) {
        await this.leaveChannel();
      }
      
      this.channelId = channelId;
      this.currentUserId = userId;
      this.localMediaState.userId = userId;
      
      // 1. Get audio stream immediately (Discord always starts with audio)
      await this.initializeLocalAudio();
      
      // 2. Setup signaling before announcing presence
      await this.setupSignaling();
      
      // 3. Request current channel state from existing users
      await this.requestChannelState();
      
      // 4. Announce our presence after state sync
      setTimeout(() => {
        this.broadcastMessage({
          type: 'user-joined',
          from: userId,
          data: { mediaState: this.localMediaState },
          timestamp: Date.now()
        });
      }, 200);
      
      this.emit('channel-joined', { channelId, userId });
      this.emit('local-state-changed', this.localMediaState);
      
      return true;
    } catch (error) {
      console.error('❌ Failed to join channel:', error);
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Leave current voice channel
   */
  async leaveChannel(): Promise<void> {
    console.log('👋 Leaving voice channel');
    
    if (this.currentUserId && this.channelId) {
      // Notify others we're leaving
      this.broadcastMessage({
        type: 'user-left',
        from: this.currentUserId,
        data: {},
        timestamp: Date.now()
      });
    }
    
    // Close all peer connections and cleanup audio
    this.connections.forEach(conn => {
      this.cleanupRemoteAudio(conn);
      conn.peerConnection.close();
    });
    this.connections.clear();
    this.allUserStates.clear();
    
    // Stop local media
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    
    // Cleanup signaling
    if (this.signalChannel) {
      await this.signalChannel.unsubscribe();
      this.signalChannel = null;
    }
    
    // Cleanup audio context
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
      this.localAudioAnalyser = null;
    }
    
    const oldChannelId = this.channelId;
    this.channelId = null;
    this.currentUserId = null;
    
    this.emit('channel-left', { channelId: oldChannelId });
  }

  /**
   * Toggle video on/off
   */
  async toggleVideo(): Promise<boolean> {
    try {
      if (!this.localMediaState.isVideoEnabled) {
        // Disable screenshare first if active
        if (this.localMediaState.isScreenSharing) {
          console.log('🎥 Disabling screenshare before enabling camera...');
          await this.toggleScreenShare();
        }
        
        // Enable video
        console.log('🎥 Enabling video camera...');
        
        const { videoDevice } = this.getSelectedDevices();
        
        const videoConstraints: any = {
          video: {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 60 }
          },
          audio: false
        };
        
        // Add device ID if specified
        if (videoDevice) {
          videoConstraints.video.deviceId = { exact: videoDevice };
          console.log('🎥 Using selected video device:', videoDevice);
        }
        
        const videoStream = await navigator.mediaDevices.getUserMedia(videoConstraints);
        const videoTrack = videoStream.getVideoTracks()[0];
        
        if (!videoTrack) {
          throw new Error('No video track obtained from camera');
        }
        
        console.log('✅ Video track obtained:', videoTrack.getSettings());
        
        if (this.localStream) {
          // Remove any existing video tracks first (important!)
          const existingVideoTracks = this.localStream.getVideoTracks();
          existingVideoTracks.forEach(track => {
            console.log('🛑 Stopping and removing old video track:', track.id);
            track.stop();
            this.localStream!.removeTrack(track);
          });
          
          // Add new video track to local stream
          this.localStream.addTrack(videoTrack);
          this.localMediaState.isVideoEnabled = true;
          
          console.log('📹 Local stream now has', this.localStream.getTracks().length, 'tracks');
          
          // Add video track to all peer connections with renegotiation
          for (const [userId, conn] of this.connections) {
            try {
              console.log('📹 Adding video track to peer:', userId);
              
              // Check if we already have a video sender
              const existingSenders = conn.peerConnection.getSenders();
              const videoSender = existingSenders.find(s => s.track?.kind === 'video');
              
              if (videoSender && videoSender.track) {
                // Replace existing video track (no renegotiation needed)
                console.log('🔄 Replacing existing video track for peer:', userId);
                await videoSender.replaceTrack(videoTrack);
                console.log('✅ Replaced video track for peer:', userId);
              } else {
                // Add new video track (requires renegotiation)
                console.log('➕ Adding new video track for peer:', userId);
                conn.peerConnection.addTrack(videoTrack, this.localStream);
                console.log('✅ Added new video track for peer:', userId);
              
                // Wait for stable state before renegotiation
                if (conn.peerConnection.signalingState !== 'stable') {
                  console.log('⏳ Waiting for stable signaling state before renegotiation...');
                  await new Promise(resolve => {
                    const checkState = () => {
                      if (conn.peerConnection.signalingState === 'stable') {
                        resolve(true);
                      } else {
                        setTimeout(checkState, 100);
                      }
                    };
                    checkState();
                  });
                }
                
                // Create and send offer for renegotiation
                console.log('🔄 Creating renegotiation offer for peer:', userId);
              const offer = await conn.peerConnection.createOffer();
              await conn.peerConnection.setLocalDescription(offer);
              
              this.sendDirectMessage(userId, {
                type: 'offer',
                from: this.currentUserId!,
                to: userId,
                data: offer,
                timestamp: Date.now()
              });
              
              console.log('✅ Video renegotiation offer sent to:', userId);
              }
            } catch (error) {
              console.error('❌ Error adding video track to peer', userId, ':', error);
            }
          }
          
          // Emit local stream change for UI update (important for self-view)
          this.emit('local-stream-changed', this.localStream);
          console.log('📺 Emitted local-stream-changed event for self-view update');
        }
      } else {
        // Disable video
        console.log('🎥 Disabling video camera...');
        
        if (this.localStream) {
          const videoTracks = this.localStream.getVideoTracks();
          
          for (const track of videoTracks) {
            console.log('🛑 Stopping video track:', track.id);
            track.stop();
            this.localStream.removeTrack(track);
            
            // Remove from peer connections
            for (const [userId, conn] of this.connections) {
              try {
                const senders = conn.peerConnection.getSenders();
                const videoSender = senders.find(s => s.track === track);
                
                if (videoSender) {
                  console.log('📹 Removing video track from peer:', userId);
                  conn.peerConnection.removeTrack(videoSender);
                  
                  // Wait for stable state before renegotiation
                  if (conn.peerConnection.signalingState !== 'stable') {
                    console.log('⏳ Waiting for stable signaling state before renegotiation...');
                    await new Promise(resolve => {
                      const checkState = () => {
                        if (conn.peerConnection.signalingState === 'stable') {
                          resolve(true);
                        } else {
                          setTimeout(checkState, 100);
                        }
                      };
                      checkState();
                    });
                  }
                  
                  // Create and send offer for renegotiation
                  console.log('🔄 Creating renegotiation offer after removing video');
                  const offer = await conn.peerConnection.createOffer();
                  await conn.peerConnection.setLocalDescription(offer);
                  
                  this.sendDirectMessage(userId, {
                    type: 'offer',
                    from: this.currentUserId!,
                    to: userId,
                    data: offer,
                    timestamp: Date.now()
                  });
                  
                  console.log('✅ Video removal renegotiation offer sent to:', userId);
                }
              } catch (error) {
                console.error('❌ Error removing video track from peer', userId, ':', error);
              }
            }
          }
          
          this.localMediaState.isVideoEnabled = false;
          console.log('✅ Video disabled, local stream now has', this.localStream.getTracks().length, 'tracks');
          
          // Emit local stream change for UI update
          this.emit('local-stream-changed', this.localStream);
          console.log('📺 Emitted local-stream-changed event (video disabled)');
        }
      }
      
      await this.broadcastMediaState();
      this.emit('local-state-changed', this.localMediaState);
      
      return this.localMediaState.isVideoEnabled;
    } catch (error) {
      console.error('❌ Error toggling video:', error);
      
      // Reset state on error
      this.localMediaState.isVideoEnabled = false;
      return false;
    }
  }

  /**
   * Toggle screen share on/off
   */
  async toggleScreenShare(): Promise<boolean> {
    try {
      if (!this.localMediaState.isScreenSharing) {
        // Start screen sharing with audio (like Discord)
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30 } },
          audio: true // Include system audio for app streaming
        });
        
        const screenVideoTrack = screenStream.getVideoTracks()[0];
        const screenAudioTrack = screenStream.getAudioTracks()[0]; // System audio
        
        if (this.localStream && screenVideoTrack) {
          // If camera was enabled, turn it off first
          if (this.localMediaState.isVideoEnabled && !this.localMediaState.isScreenSharing) {
            console.log('📷 Camera was enabled, disabling before screenshare...');
            this.localMediaState.isVideoEnabled = false;
          }
          
          // Remove existing video tracks (keep microphone audio)
          const videoTracks = this.localStream.getVideoTracks();
          videoTracks.forEach(track => {
            console.log('🛑 Stopping and removing video track for screenshare:', track.id);
            track.stop();
            this.localStream!.removeTrack(track);
          });
          
          // Add screen video track
          this.localStream.addTrack(screenVideoTrack);
          console.log('✅ Added screen video track');
          
          // Add screen audio track if available (system audio)
          if (screenAudioTrack) {
            this.localStream.addTrack(screenAudioTrack);
            console.log('🔊 Screen sharing with system audio enabled');
          }
          
          this.localMediaState.isScreenSharing = true;
          this.localMediaState.isVideoEnabled = false; // Not camera, it's screenshare!
          
          // Replace tracks in peer connections
          this.connections.forEach(async (conn) => {
            const senders = conn.peerConnection.getSenders();
            
            // Replace video track
            const videoSender = senders.find(s => s.track && s.track.kind === 'video');
            if (videoSender) {
              await videoSender.replaceTrack(screenVideoTrack);
            } else {
              conn.peerConnection.addTrack(screenVideoTrack, this.localStream!);
            }
            
            // Add screen audio track if available
            if (screenAudioTrack) {
              // Check if we need to add a new audio sender for screen audio
              // (we keep the mic audio, this is additional system audio)
              conn.peerConnection.addTrack(screenAudioTrack, this.localStream!);
            }
          });
          
          // Handle screen share ending
          screenVideoTrack.onended = () => {
            this.toggleScreenShare();
          };
        }
      } else {
        // Stop screen sharing
        if (this.localStream) {
          // Remove screen video tracks
          const videoTracks = this.localStream.getVideoTracks();
          videoTracks.forEach(track => {
            track.stop();
            this.localStream!.removeTrack(track);
            
            // Remove from peer connections
            this.connections.forEach(conn => {
              const senders = conn.peerConnection.getSenders();
              const videoSender = senders.find(s => s.track === track);
              if (videoSender) {
                conn.peerConnection.removeTrack(videoSender);
              }
            });
          });
          
          // Remove screen audio tracks (system audio)
          // We need to be careful to only remove non-microphone audio tracks
          const audioTracks = this.localStream.getAudioTracks();
          audioTracks.forEach(track => {
            // Check if this is a screen audio track (has different label/source)
            if (track.label.includes('System Audio') || track.label.includes('Screen') || 
                track.getSettings().deviceId?.includes('screen')) {
              track.stop();
              this.localStream!.removeTrack(track);
              
              // Remove from peer connections
              this.connections.forEach(conn => {
                const senders = conn.peerConnection.getSenders();
                const audioSender = senders.find(s => s.track === track);
                if (audioSender) {
                  conn.peerConnection.removeTrack(audioSender);
                }
              });
              
              console.log('🔇 Removed screen audio track:', track.label);
            }
          });
          
          this.localMediaState.isScreenSharing = false;
          this.localMediaState.isVideoEnabled = false;
        }
      }
      
      await this.broadcastMediaState();
      this.emit('local-state-changed', this.localMediaState);
      
      return this.localMediaState.isScreenSharing;
    } catch (error) {
      console.error('❌ Error toggling screen share:', error);
      return false;
    }
  }

  /**
   * Toggle mute on/off
   */
  toggleMute(): boolean {
    this.localMediaState.isMuted = !this.localMediaState.isMuted;
    
    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !this.localMediaState.isMuted;
      }
    }
    
    this.localMediaState.isSpeaking = this.calculateSpeakingState(this.localMediaState.audioLevel, this.localMediaState.isMuted);
    
    this.broadcastMediaState();
    this.emit('local-state-changed', this.localMediaState);
    
    return this.localMediaState.isMuted;
  }

  /**
   * Toggle deafen on/off
   */
  toggleDeafen(): boolean {
    this.localMediaState.isDeafened = !this.localMediaState.isDeafened;
    
    // When deafened, also mute
    if (this.localMediaState.isDeafened) {
      this.localMediaState.isMuted = true;
      if (this.localStream) {
        const audioTrack = this.localStream.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = false;
        }
      }
    }
    
    // Mute/unmute all remote audio elements
    this.connections.forEach(conn => {
      if (conn.audioElement) {
        conn.audioElement.muted = this.localMediaState.isDeafened;
        console.log('🔊 Audio element for', conn.userId, this.localMediaState.isDeafened ? 'muted' : 'unmuted');
      }
    });
    
    this.broadcastMediaState();
    this.emit('local-state-changed', this.localMediaState);
    
    return this.localMediaState.isDeafened;
  }

  // =============================================================================
  // GETTERS
  // =============================================================================

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getLocalState(): UserMediaState {
    return { ...this.localMediaState };
  }

  getUserStream(userId: string): MediaStream | null {
    if (userId === this.currentUserId) {
      return this.localStream;
    }
    return this.connections.get(userId)?.remoteStream || null;
  }

  getUserState(userId: string): UserMediaState | null {
    if (userId === this.currentUserId) {
      return { ...this.localMediaState };
    }
    return this.allUserStates.get(userId) || null;
  }

  getAllUsers(): UserMediaState[] {
    const users: UserMediaState[] = [{ ...this.localMediaState }];
    this.allUserStates.forEach(state => {
      if (state.userId !== this.currentUserId) {
        users.push({ ...state });
      }
    });
    return users;
  }

  getConnectionState(userId: string): RTCPeerConnectionState | null {
    return this.connections.get(userId)?.connectionState || null;
  }

  getUserAudioElement(userId: string): HTMLAudioElement | null {
    const connection = this.connections.get(userId);
    return connection ? connection.audioElement : null;
  }

  // =============================================================================
  // EVENT SYSTEM
  // =============================================================================

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
      if (index > -1) {
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
          console.error('❌ Error in event listener:', error);
        }
      });
    }
  }

  // =============================================================================
  // PRIVATE METHODS
  // =============================================================================

  /**
   * Calculate speaking state based on audio level and mute status
   */
  private calculateSpeakingState(audioLevel: number, isMuted: boolean): boolean {
    return audioLevel > 20 && !isMuted;
  }

  private async initializeLocalAudio(): Promise<void> {
    try {
      // Get new audio stream with updated constraints and selected device
      const { inputDevice } = this.getSelectedDevices();
      const audioConstraints: MediaTrackConstraints = {
        ...this.audioConstraints
      };

      // Add device ID if specified, but use 'ideal' for graceful fallback
      if (inputDevice) {
        audioConstraints.deviceId = { ideal: inputDevice };
        console.log('🎤 Using selected input device for constraint update:', inputDevice);
      }

      let newAudioStream: MediaStream;

      try {
        // Try with the selected device first
        newAudioStream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false
        });
      } catch (error) {
        console.warn('⚠️ Failed to use selected device during constraint update, falling back to default:', error);
        
        // Clear the invalid device ID and save
        this.selectedInputDevice = null;
        this.saveAudioSettings();
        
        // Fallback to default device
        const fallbackConstraints: MediaTrackConstraints = {
          ...this.audioConstraints
          // No deviceId - let browser choose
        };
        
        newAudioStream = await navigator.mediaDevices.getUserMedia({
          audio: fallbackConstraints,
          video: false
        });
        
        console.log('✅ Using default audio device as fallback during constraint update');
      }

      this.localStream = newAudioStream;

      // Ensure audio track is enabled based on mute state
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !this.localMediaState.isMuted;
        // console.log('🎤 Audio track enabled:', audioTrack.enabled, 'muted:', this.localMediaState.isMuted);
      }
      
      this.setupAudioLevelMonitoring();
      
      // Emit initial local stream for UI
      this.emit('local-stream-changed', this.localStream);
      this.emit('stream-changed', { userId: this.currentUserId, stream: this.localStream, type: 'local' });
    } catch (error) {
      console.error('❌ Failed to get audio stream:', error);
      throw error;
    }
  }
  private setupAudioLevelMonitoring(): void {
    if (!this.localStream) return;
    
    try {
      this.audioContext = new AudioContext();
      this.localAudioAnalyser = this.audioContext.createAnalyser();
      const source = this.audioContext.createMediaStreamSource(this.localStream);
      
      source.connect(this.localAudioAnalyser);
      this.localAudioAnalyser.fftSize = 256;
      
      const dataArray = new Uint8Array(this.localAudioAnalyser.frequencyBinCount);
      
      let lastBroadcast = 0;
      const updateLevel = () => {
        if (this.localAudioAnalyser && this.audioContext?.state === 'running') {
          this.localAudioAnalyser.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
          this.localMediaState.audioLevel = average;
          
          // Calculate speaking state
          const wasSpeaking = this.localMediaState.isSpeaking;
          this.localMediaState.isSpeaking = this.calculateSpeakingState(average, this.localMediaState.isMuted);
          
          this.emit('audio-level', { userId: this.currentUserId, level: average });
          
          // Broadcast audio level to other users every 100ms if speaking
          const now = Date.now();
          if ((average > 20 || now - lastBroadcast > 1000) && now - lastBroadcast > 100) {
            this.broadcastAudioLevel();
            lastBroadcast = now;
          }
          
          // Broadcast media state if speaking state changed (for other peers)
          if (wasSpeaking !== this.localMediaState.isSpeaking) {
            this.broadcastMediaState();
            // Note: We don't emit 'local-state-changed' here to avoid interfering 
            // with component reactivity. The component reacts directly to audioLevel changes.
          }

          requestAnimationFrame(updateLevel);
        }
      };
      
      updateLevel();
    } catch (error) {
      console.warn('⚠️ Audio level monitoring setup failed:', error);
    }
  }

  private async setupSignaling(): Promise<void> {
    if (!this.channelId || !this.currentUserId) {
      throw new Error('Channel ID or User ID not set');
    }
    
    this.signalChannel = supabase.channel(`harmony-voice-${this.channelId}`, {
      config: { broadcast: { self: false } }
    });
    
    this.signalChannel.on('broadcast', { event: 'signal' }, (payload) => {
      this.handleSignalingMessage(payload.payload as SignalingMessage);
    });
    
    this.signalChannel.on('broadcast', { event: 'audio-level' }, (payload) => {
      this.handleAudioLevel(payload.payload);
    });
    
    return new Promise<void>((resolve, reject) => {
      this.signalChannel!.subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          console.log('📡 Signaling channel ready');
          resolve();
        } else if (status === 'CHANNEL_ERROR') {
          reject(new Error('Failed to setup signaling'));
        }
      });
    });
  }

  private async requestChannelState(): Promise<void> {
    if (!this.currentUserId) return;
    
    console.log('🔄 Requesting channel state from existing users');
    
    this.broadcastMessage({
      type: 'state-sync',
      from: this.currentUserId,
      data: { action: 'request' },
      timestamp: Date.now()
    });
  }

  private async handleSignalingMessage(message: SignalingMessage): Promise<void> {
    const { type, from, to, data } = message;
    
    // Ignore our own messages
    if (from === this.currentUserId) return;
    
    // Ignore messages not for us (except broadcasts)
    if (to && to !== this.currentUserId) return;
    
    console.log('📩 Received:', type, 'from:', from);
    
    switch (type) {
      case 'user-joined':
        await this.handleUserJoined(from, data.mediaState);
        break;
        
      case 'user-left':
        await this.handleUserLeft(from);
        break;
        
      case 'media-state':
        this.handleMediaStateUpdate(from, data.mediaState);
        break;
        
      case 'state-sync':
        await this.handleStateSync(from, data);
        break;
        
      case 'offer':
        await this.handleOffer(from, data);
        break;
        
      case 'answer':
        await this.handleAnswer(from, data);
        break;
        
      case 'ice-candidate':
        await this.handleIceCandidate(from, data);
        break;
    }
  }

  private async handleUserJoined(userId: string, mediaState: UserMediaState): Promise<void> {
    console.log('👋 User joined:', userId, mediaState);
    
    // Store their media state
    this.allUserStates.set(userId, mediaState);
    
    // Create peer connection
    await this.createPeerConnection(userId, true); // We initiate since they just joined
    
    this.emit('user-joined', { userId, mediaState });
  }

  private async handleUserLeft(userId: string): Promise<void> {
    console.log('👋 User left:', userId);
    
    const connection = this.connections.get(userId);
    if (connection) {
      this.cleanupRemoteAudio(connection);
      connection.peerConnection.close();
      this.connections.delete(userId);
    }
    
    this.allUserStates.delete(userId);
    this.emit('user-left', { userId });
  }

  private handleMediaStateUpdate(userId: string, mediaState: UserMediaState): void {
    console.log('🎛️ Media state update:', userId, mediaState);
    
    this.allUserStates.set(userId, mediaState);
    this.emit('user-state-changed', { userId, mediaState });
  }

  private handleAudioLevel(data: { userId: string; audioLevel: number; timestamp: number }): void {
    const { userId, audioLevel } = data;
    
    // Update the user's audio level in our state
    const userState = this.allUserStates.get(userId);
    if (userState) {
      const wasSpeaking = userState.isSpeaking;
      userState.audioLevel = audioLevel;
      
      // Calculate speaking state for remote user
      userState.isSpeaking = this.calculateSpeakingState(audioLevel, userState.isMuted);
      
      this.emit('audio-level', { userId, level: audioLevel });
      
      // Emit user state change if speaking state changed
      if (wasSpeaking !== userState.isSpeaking) {
        this.emit('user-state-changed', { userId, mediaState: userState });
      }
    }
  }

  private async handleStateSync(from: string, data: any): Promise<void> {
    if (data.action === 'request') {
      // Someone is requesting current state - send our state
      console.log('📤 Sending our state to:', from);
      
      this.sendDirectMessage(from, {
        type: 'state-sync',
        from: this.currentUserId!,
        to: from,
        data: {
          action: 'response',
          mediaState: this.localMediaState,
          allStates: Array.from(this.allUserStates.values())
        },
        timestamp: Date.now()
      });
    } else if (data.action === 'response') {
      // Someone is sending us the current channel state
      console.log('📥 Received channel state from:', from, data);
      
      // Update our knowledge of all users
      if (data.allStates) {
        data.allStates.forEach((state: UserMediaState) => {
          if (state.userId !== this.currentUserId) {
            this.allUserStates.set(state.userId, state);
          }
        });
      }
      
      // Add the sender's state
      if (data.mediaState) {
        this.allUserStates.set(from, data.mediaState);
      }
      
      this.emit('channel-state-synced', { 
        users: Array.from(this.allUserStates.values()) 
      });
    }
  }

  private async createPeerConnection(userId: string, isInitiator: boolean): Promise<void> {
    console.log('🔗 Creating peer connection with:', userId, 'as initiator:', isInitiator);
    
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      ],
      iceCandidatePoolSize: 10
    });
    
    const connection: UserConnection = {
      userId,
      peerConnection: pc,
      mediaState: this.allUserStates.get(userId) || {
        userId,
        isAudioEnabled: true,
        isVideoEnabled: false,
        isScreenSharing: false,
        isMuted: false,
        isDeafened: false,
        isSpeaking: false,
        audioLevel: 0
      },
      remoteStream: null,
      audioElement: null,
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState
    };
    
    this.connections.set(userId, connection);
    
    // Add local stream tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        console.log('🔗 Adding track to peer', userId, ':', track.kind, 'enabled:', track.enabled);
        pc.addTrack(track, this.localStream!);
      });
      console.log('✅ Added', this.localStream.getTracks().length, 'tracks to peer connection with', userId);
    }
    
    // Handle remote stream
    pc.ontrack = (event) => {
      console.log('📹 Received track from:', userId, event.track.kind, 'Stream ID:', event.streams[0]?.id);
      
      if (event.streams[0]) {
        connection.remoteStream = event.streams[0];
        console.log('📡 Setting remote stream for user:', userId, 'Tracks:', event.streams[0].getTracks().length);
        
        // Create audio element for remote audio playback
        this.setupRemoteAudio(connection, event.streams[0]);
        
        this.emit('user-stream-changed', { userId, stream: event.streams[0] });
        
        // Also emit generic stream change event
        this.emit('stream-changed', { userId, stream: event.streams[0], type: 'remote' });
      }
    };
    
    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendDirectMessage(userId, {
          type: 'ice-candidate',
          from: this.currentUserId!,
          to: userId,
          data: event.candidate,
          timestamp: Date.now()
        });
      }
    };
    
    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      connection.connectionState = pc.connectionState;
      this.emit('connection-state-changed', { userId, state: pc.connectionState });
    };
    
    pc.oniceconnectionstatechange = () => {
      connection.iceConnectionState = pc.iceConnectionState;
      console.log('🧊 ICE state for', userId, ':', pc.iceConnectionState);
    };
    
    // Create offer if we're the initiator
    if (isInitiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        
        this.sendDirectMessage(userId, {
          type: 'offer',
          from: this.currentUserId!,
          to: userId,
          data: offer,
          timestamp: Date.now()
        });
      } catch (error) {
        console.error('❌ Error creating offer for:', userId, error);
      }
    }
  }

  private async handleOffer(from: string, offer: RTCSessionDescriptionInit): Promise<void> {
    console.log('📞 Handling offer from:', from);
    
    let connection = this.connections.get(from);
    if (!connection) {
      await this.createPeerConnection(from, false);
      connection = this.connections.get(from)!;
    }
    
    try {
      await connection.peerConnection.setRemoteDescription(offer);
      const answer = await connection.peerConnection.createAnswer();
      await connection.peerConnection.setLocalDescription(answer);
      
      this.sendDirectMessage(from, {
        type: 'answer',
        from: this.currentUserId!,
        to: from,
        data: answer,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('❌ Error handling offer from:', from, error);
    }
  }

  private async handleAnswer(from: string, answer: RTCSessionDescriptionInit): Promise<void> {
    console.log('📞 Handling answer from:', from);
    
    const connection = this.connections.get(from);
    if (connection) {
      try {
        await connection.peerConnection.setRemoteDescription(answer);
      } catch (error) {
        console.error('❌ Error handling answer from:', from, error);
      }
    }
  }

  private async handleIceCandidate(from: string, candidate: RTCIceCandidateInit): Promise<void> {
    const connection = this.connections.get(from);
    if (connection) {
      try {
        await connection.peerConnection.addIceCandidate(candidate);
      } catch (error) {
        console.error('❌ Error adding ICE candidate from:', from, error);
      }
    }
  }

  private broadcastMessage(message: SignalingMessage): void {
    if (this.signalChannel) {
      this.signalChannel.send({
        type: 'broadcast',
        event: 'signal',
        payload: message
      });
    }
  }

  private sendDirectMessage(to: string, message: SignalingMessage): void {
    if (this.signalChannel) {
      this.signalChannel.send({
        type: 'broadcast',
        event: 'signal',
        payload: { ...message, to }
      });
    }
  }

  private async broadcastMediaState(): Promise<void> {
    this.broadcastMessage({
      type: 'media-state',
      from: this.currentUserId!,
      data: { mediaState: this.localMediaState },
      timestamp: Date.now()
    });
  }

  private broadcastAudioLevel(): void {
    if (!this.signalChannel || !this.currentUserId) return;
    
    this.signalChannel.send({
      type: 'broadcast',
      event: 'audio-level',
      payload: {
        userId: this.currentUserId,
        audioLevel: this.localMediaState.audioLevel,
        timestamp: Date.now()
      }
    });
  }

  private setupRemoteAudio(connection: UserConnection, stream: MediaStream): void {
    const audioTracks = stream.getAudioTracks();
    
    if (audioTracks.length > 0) {
      // Create audio element for remote audio playback
      if (!connection.audioElement) {
        connection.audioElement = new Audio();
        connection.audioElement.autoplay = true;
        // Note: playsInline is for video elements, not needed for audio
      }
      
      // Set the stream
      connection.audioElement.srcObject = stream;
      
      // Apply current deafen state
      connection.audioElement.muted = this.localMediaState.isDeafened;
      
      console.log('🔊 Audio element created for user:', connection.userId, 'muted:', connection.audioElement.muted);
      
      // Handle audio element errors
      connection.audioElement.onerror = (error) => {
        console.error('❌ Audio element error for user', connection.userId, ':', error);
      };
      
      // Log when audio starts playing
      connection.audioElement.onplay = () => {
        console.log('▶️ Audio started playing for user:', connection.userId);
      };
    }
  }

  /**
   * Enable or disable traditional HTMLAudioElement playback
   * This should be called when spatial audio is toggled
   */
  setTraditionalAudioEnabled(enabled: boolean): void {
    console.log(`🔊 Setting traditional audio enabled: ${enabled} for ${this.connections.size} connections`);
    
    this.connections.forEach(connection => {
      if (connection.audioElement) {
        const wasPlaying = !connection.audioElement.muted && !connection.audioElement.paused;
        
        // When spatial audio is enabled, mute the HTMLAudioElement to prevent double audio
        // When spatial audio is disabled, unmute it for normal playback
        connection.audioElement.muted = !enabled || this.localMediaState.isDeafened;
        
        const isNowPlaying = !connection.audioElement.muted && !connection.audioElement.paused;
        
        console.log(`🔊 ${connection.userId}: muted=${connection.audioElement.muted}, ` +
                   `wasPlaying=${wasPlaying}, isNowPlaying=${isNowPlaying}, ` +
                   `deafened=${this.localMediaState.isDeafened}`);
      } else {
        console.warn(`⚠️ No audioElement for user ${connection.userId}`);
      }
    });
  }

  private cleanupRemoteAudio(connection: UserConnection): void {
    if (connection.audioElement) {
      connection.audioElement.pause();
      connection.audioElement.srcObject = null;
      connection.audioElement = null;
      console.log('🔇 Audio element cleaned up for user:', connection.userId);
    }
  }

  private setupCleanup(): void {
    window.addEventListener('beforeunload', () => {
      this.leaveChannel();
    });
  }

  // =============================================================================
  // AUDIO SETTINGS MANAGEMENT
  // =============================================================================

  private getSelectedDevices(): { inputDevice?: string; outputDevice?: string; videoDevice?: string } {
    return {
      inputDevice: this.selectedInputDevice || undefined,
      outputDevice: this.selectedOutputDevice || undefined,
      videoDevice: this.selectedVideoDevice || undefined
    };
  }

  private loadAudioSettings(): void {
    try {
      const stored = localStorage.getItem('harmony-voice-settings');
      if (stored) {
        const settings = JSON.parse(stored);
        
        // Load audio constraints
        if (settings.audioConstraints) {
          this.audioConstraints = {
            ...this.audioConstraints,
            ...settings.audioConstraints
          };
          console.log('🎛️ Loaded audio settings:', this.audioConstraints);
        }
        
        // Load device settings
        this.selectedInputDevice = settings.selectedInputDevice || null;
        this.selectedOutputDevice = settings.selectedOutputDevice || null;
        this.selectedVideoDevice = settings.selectedVideoDevice || null;
        console.log('🎛️ Loaded device settings:', {
          input: this.selectedInputDevice,
          output: this.selectedOutputDevice,
          video: this.selectedVideoDevice
        });
      }
    } catch (error) {
      console.warn('⚠️ Failed to load audio settings:', error);
    }
  }

  private saveAudioSettings(): void {
    try {
      const existing = localStorage.getItem('harmony-voice-settings');
      const settings = existing ? JSON.parse(existing) : {};
      
      // Save audio constraints
      settings.audioConstraints = {
        echoCancellation: this.audioConstraints.echoCancellation,
        noiseSuppression: this.audioConstraints.noiseSuppression,
        autoGainControl: this.audioConstraints.autoGainControl
      };
      
      // Save device settings
      settings.selectedInputDevice = this.selectedInputDevice;
      settings.selectedOutputDevice = this.selectedOutputDevice;
      settings.selectedVideoDevice = this.selectedVideoDevice;
      
      localStorage.setItem('harmony-voice-settings', JSON.stringify(settings));
      console.log('💾 Saved audio and device settings');
    } catch (error) {
      console.warn('⚠️ Failed to save audio settings:', error);
    }
  }

  private setupSettingsListener(): void {
    // Listen for settings updates from the settings panel
    this.on('update-settings', (data: { type: string; value: any }) => {
      if (data.type === 'audioConstraints') {
        this.updateAudioConstraints(data.value);
      }
    });
  }

  /**
   * Update audio constraints and restart audio stream if needed
   */
  async updateAudioConstraints(constraints: { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean }): Promise<void> {
    console.log('🎛️ Updating audio constraints:', constraints);
    
    // Update constraints
    Object.assign(this.audioConstraints, constraints);
    this.saveAudioSettings();
    
    // If we're currently connected, restart the audio stream with new constraints
    if (this.localStream && this.channelId) {
      const currentMuteState = this.localMediaState.isMuted;
      
      try {
        // Stop current audio tracks
        const audioTracks = this.localStream.getAudioTracks();
        audioTracks.forEach(track => {
          track.stop();
          this.localStream!.removeTrack(track);
        });
        
        // Get new audio stream with updated constraints
        const newAudioStream = await navigator.mediaDevices.getUserMedia({
          audio: this.audioConstraints,
          video: false
        });
        
        const newAudioTrack = newAudioStream.getAudioTracks()[0];
        if (newAudioTrack) {
          // Add new track to local stream
          this.localStream.addTrack(newAudioTrack);
          
          // Apply current mute state
          newAudioTrack.enabled = !currentMuteState;
          
          // Update all peer connections with new audio track
          for (const [userId, conn] of this.connections) {
            try {
              const senders = conn.peerConnection.getSenders();
              const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
              
              if (audioSender) {
                await audioSender.replaceTrack(newAudioTrack);
                console.log('🔄 Replaced audio track for peer:', userId);
              }
            } catch (error) {
              console.error('❌ Error updating audio track for peer', userId, ':', error);
            }
          }
          
          // Restart audio level monitoring
          this.setupAudioLevelMonitoring();
          
          console.log('✅ Audio stream updated with new constraints');
          this.emit('local-stream-changed', this.localStream);
        }
      } catch (error) {
        console.error('❌ Failed to update audio constraints:', error);
        // Try to restore previous state if possible
        this.emit('error', error);
      }
    }
  }

  /**
   * Get current audio constraints
   */
  getAudioConstraints(): { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean } {
    return {
      echoCancellation: this.audioConstraints.echoCancellation,
      noiseSuppression: this.audioConstraints.noiseSuppression,
      autoGainControl: this.audioConstraints.autoGainControl
    };
  }
}

// =============================================================================
// SINGLETON EXPORT
// =============================================================================

export const unifiedWebRTC = new UnifiedWebRTCService();