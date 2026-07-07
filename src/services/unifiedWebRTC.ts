import { supabase } from '@/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { debug } from '@/utils/debug';
import { userStorage } from '@/utils/userScopedStorage';
import { VoiceSettingsService } from './VoiceSettingsService';

// TYPES & INTERFACES

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
  /** The peer's screenshare stream (separate MediaStream so camera + screen can run concurrently) */
  remoteScreenStream: MediaStream | null;
  /** Every remote stream seen in ontrack, keyed by stream id, so streams can be (re)classified once the peer announces its screen stream id */
  knownStreams: Map<string, MediaStream>;
  audioElement: HTMLAudioElement | null;
  /** Separate playback element for screenshare audio (never spatialized) */
  screenAudioElement: HTMLAudioElement | null;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  /**
   * BUGS.md H20: ICE candidates that arrive before `setRemoteDescription`
   * (common with trickle ICE) must be queued and flushed afterwards.
   * `RTCPeerConnection.addIceCandidate` throws `InvalidStateError` when
   * called before `remoteDescription` is set, causing flaky / failed P2P
   * connections on slower networks.
   */
  pendingIceCandidates: RTCIceCandidateInit[];
}

export interface SignalingMessage {
  type: 'offer' | 'answer' | 'ice-candidate' | 'user-joined' | 'user-left' | 'media-state' | 'state-sync' | 'call-start-time' | 'request-call-start-time';
  from: string;
  to?: string;
  data: any;
  timestamp: number;
}

export interface ChannelState {
  participants: UserMediaState[];
  channelId: string;
}

// MAIN WEBRTC SERVICE

export class UnifiedWebRTCService {
  private channelId: string | null = null;
  private currentUserId: string | null = null;
  private signalChannel: RealtimeChannel | null = null;
  
  // Local media and state
  // localStream carries mic + camera; the screenshare gets its own stream so
  // both video feeds can be published at once and told apart by stream id.
  private localStream: MediaStream | null = null;
  private localScreenStream: MediaStream | null = null;
  private cameraVideoTrackId: string | null = null;
  // Screen stream ids announced by peers (via media-state / state-sync),
  // used to classify incoming streams as camera/mic vs screenshare
  private announcedScreenStreamIds = new Map<string, string | null>();
  // PTT gate: closed = mic track disabled without touching the user's explicit mute state
  private pttGateOpen = true;
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
  // BUGS.md H21: track the RAF so device-changes / constraint-changes can
  // cancel the previous loop before starting a new one. Otherwise multiple
  // overlapping RAF loops would all read from `localAudioAnalyser` and
  // broadcast audio levels in lockstep.
  private audioLevelRafId: number | null = null;
  
  // Audio constraints settings
  private audioConstraints = {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: true,
    sampleRate: 48000
  };

  // Stream quality settings (shared format with LiveKit)
  private streamQualitySettings = {
    resolution: 720,    // Default 720p
    frameRate: 30,      // Default 30fps
    audioBitrate: 128,  // Default 128kbps
  };

  // Device selection
  private selectedInputDevice: string | null = null;
  private selectedOutputDevice: string | null = null;
  private selectedVideoDevice: string | null = null;
  
  constructor() {
    this.setupCleanup();
    this.loadAudioSettings();
    this.loadStreamQualitySettings();
    this.setupSettingsListener();
  }

  /**
   * Load stream quality settings from localStorage
   */
  private loadStreamQualitySettings(): void {
    try {
      const saved = userStorage.getItem('stream-quality');
      if (saved) {
        const settings = JSON.parse(saved);
        this.streamQualitySettings = {
          resolution: settings.resolution ?? 720,
          frameRate: settings.frameRate ?? 30,
          audioBitrate: settings.audioBitrate ?? 128,
        };
        debug.log('📊 [P2P] Loaded stream quality settings:', this.streamQualitySettings);
      }
    } catch (error) {
      debug.warn('⚠️ [P2P] Failed to load stream quality settings:', error);
    }
  }

  /**
   * Save stream quality settings to localStorage
   */
  private saveStreamQualitySettings(): void {
    try {
      userStorage.setItem('stream-quality', JSON.stringify(this.streamQualitySettings));
    } catch (error) {
      debug.warn('⚠️ [P2P] Failed to save stream quality settings:', error);
    }
  }

  /**
   * Get MediaTrackConstraints for video based on resolution setting
   * @param resolution - Resolution in pixels (360, 480, 720, 1080, or -1 for source)
   */
  private getVideoConstraints(resolution: number = this.streamQualitySettings.resolution): MediaTrackConstraints {
    const frameRate = this.streamQualitySettings.frameRate;
    
    switch (resolution) {
      case 360:
        return { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: frameRate } };
      case 480:
        return { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: frameRate } };
      case 720:
        return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: frameRate } };
      case 1080:
        return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: frameRate } };
      case -1: // Source/Native - use max available
        return { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: frameRate } };
      default: {
        const width = Math.round(resolution * 16 / 9);
        return { width: { ideal: width }, height: { ideal: resolution }, frameRate: { ideal: frameRate } };
      }
    }
  }

  /**
   * Update stream quality settings
   * Applies to currently active video/screenshare tracks
   */
  async updateStreamQuality(settings: { resolution?: number; frameRate?: number; audioBitrate?: number }): Promise<void> {
    debug.log('📊 [P2P] Updating stream quality:', settings);
    
    if (settings.resolution !== undefined) {
      this.streamQualitySettings.resolution = settings.resolution;
    }
    if (settings.frameRate !== undefined) {
      this.streamQualitySettings.frameRate = settings.frameRate;
    }
    if (settings.audioBitrate !== undefined) {
      this.streamQualitySettings.audioBitrate = settings.audioBitrate;
    }
    
    this.saveStreamQualitySettings();
    
    if (this.localStream) {
      const videoTracks = this.localStream.getVideoTracks();
      for (const track of videoTracks) {
        try {
          const constraints = this.getVideoConstraints();
          await track.applyConstraints(constraints);
          debug.log('📊 [P2P] Applied video constraints:', constraints);
        } catch (error) {
          debug.warn('⚠️ [P2P] Failed to apply video constraints:', error);
        }
      }
    }
    
    debug.log('📊 [P2P] Stream quality updated:', this.streamQualitySettings);
  }

  // PUBLIC API

  /**
   * Update input device and restart audio stream
   */
  async updateInputDevice(deviceId: string): Promise<void> {
    debug.log('🎤 Updating input device to:', deviceId);
    
    this.selectedInputDevice = deviceId;
    this.saveAudioSettings(); // Use existing method
    
    // If we're currently connected, restart the audio stream with new device
    if (this.localStream && this.channelId) {
      const currentMuteState = this.localMediaState.isMuted;

      // BUGS.md H22: previously the code stopped+removed the OLD audio
      // tracks BEFORE calling `getUserMedia` for the new device. If the
      // new `getUserMedia` failed (permission revoked, device gone,
      // OverconstrainedError), the call had no mic at all - the user
      // would silently lose audio with no recovery until they rejoined
      // the channel. Acquire the new stream FIRST, then swap.
      try {
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
          // Only NOW do we stop the previous tracks - the swap is committed.
          const oldAudioTracks = this.localStream.getAudioTracks();
          oldAudioTracks.forEach(track => {
            track.stop();
            this.localStream!.removeTrack(track);
          });
          this.localStream.addTrack(newAudioTrack);
          
          newAudioTrack.enabled = !currentMuteState;
          
          for (const [userId, conn] of this.connections) {
            try {
              const senders = conn.peerConnection.getSenders();
              const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
              
              if (audioSender) {
                await audioSender.replaceTrack(newAudioTrack);
                debug.log('🔄 Replaced audio track for peer:', userId);
              }
            } catch (error) {
              debug.error('❌ Error updating audio track for peer', userId, ':', error);
            }
          }
          
          // Restart audio level monitoring
          this.setupAudioLevelMonitoring();
          
          debug.log('✅ Input device updated successfully');
          this.emit('local-stream-changed', this.localStream);
          this.emit('stream-changed', { userId: this.currentUserId, stream: this.localStream, type: 'local' });
        }
      } catch (error) {
        debug.error('❌ Failed to update input device:', error);
        this.emit('error', error);
        throw error;
      }
    }
  }

  /**
   * Update output device for all remote audio elements
   */
  async updateOutputDevice(deviceId: string): Promise<void> {
    debug.log('🔊 Updating output device to:', deviceId);
    
    this.selectedOutputDevice = deviceId;
    this.saveAudioSettings(); // Use existing method
    
    // Update all existing audio elements to use new output device.
    // setSinkId is part of the Audio Output Devices API and isn't in the lib.dom
    // HTMLAudioElement type yet, so cast to any.
    for (const [userId, connection] of this.connections) {
      const audioEl = connection.audioElement as any;
      if (audioEl && audioEl.setSinkId) {
        try {
          await audioEl.setSinkId(deviceId);
          debug.log('🔊 Updated output device for user:', userId);
        } catch (error) {
          debug.error('❌ Failed to update output device for user:', userId, error);
        }
      }
    }
    
    debug.log('✅ Output device updated successfully');
  }

  /**
   * Update video device and restart video stream if enabled
   */
  async updateVideoDevice(deviceId: string): Promise<void> {
    debug.log('🎥 Updating video device to:', deviceId);
    
    this.selectedVideoDevice = deviceId;
    this.saveAudioSettings(); // Use existing method
    
    // If video is currently enabled, restart with new device
    if (this.localMediaState.isVideoEnabled && this.localStream && this.channelId) {
      try {
        const videoTracks = this.localStream.getVideoTracks();
        videoTracks.forEach(track => {
          track.stop();
          this.localStream!.removeTrack(track);
        });
        
        const baseVideoConstraints = this.getVideoConstraints();
        const videoConstraints: any = {
          video: {
            deviceId: { exact: deviceId },
            ...baseVideoConstraints
          },
          audio: false
        };
        
        const newVideoStream = await navigator.mediaDevices.getUserMedia(videoConstraints);
        const newVideoTrack = newVideoStream.getVideoTracks()[0];
        
        if (newVideoTrack) {
          this.localStream.addTrack(newVideoTrack);
          const previousCameraTrackId = this.cameraVideoTrackId;
          this.cameraVideoTrackId = newVideoTrack.id;

          for (const [userId, conn] of this.connections) {
            try {
              const senders = conn.peerConnection.getSenders();
              // Only swap the camera sender - never the screenshare sender
              const videoSender = senders.find(
                s => s.track?.kind === 'video' &&
                     s.track.id !== this.screenShareVideoTrackId &&
                     (previousCameraTrackId === null || s.track.id === previousCameraTrackId || s.track.readyState === 'ended')
              );

              if (videoSender) {
                await videoSender.replaceTrack(newVideoTrack);
                debug.log('🔄 Replaced camera track for peer:', userId);
              }
            } catch (error) {
              debug.error('❌ Error updating video track for peer', userId, ':', error);
            }
          }
          
          debug.log('✅ Video device updated successfully');
          this.emit('local-stream-changed', this.localStream);
          this.emit('stream-changed', { userId: this.currentUserId, stream: this.localStream, type: 'local' });
        }
      } catch (error) {
        debug.error('❌ Failed to update video device:', error);
        this.emit('error', error);
        throw error;
      }
    }
  }
  /**
   * Join a voice channel - Discord-like experience
   */
  async joinChannel(channelId: string, userId: string, abortSignal?: AbortSignal): Promise<boolean> {
    debug.log('🎯 Joining voice channel:', channelId, 'as user:', userId);
    
    try {
      // Check for cancellation
      if (abortSignal?.aborted) {
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      // Clean previous connection
      if (this.channelId) {
        await this.leaveChannel();
      }
      
      // Check for cancellation after cleanup
      if (abortSignal?.aborted) {
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      this.channelId = channelId;
      this.currentUserId = userId;
      this.localMediaState.userId = userId;
      
      // 1. Get audio stream immediately (Discord always starts with audio)
      await this.initializeLocalAudio();
      // fresh tracks start enabled; re-apply mute/PTT gate before audio flows
      this.applyMicGate();

      // Check for cancellation after getting audio
      if (abortSignal?.aborted) {
        await this.leaveChannel();
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      // 2. Setup signaling before announcing presence
      await this.setupSignaling();
      
      // Check for cancellation after setting up signaling
      if (abortSignal?.aborted) {
        await this.leaveChannel();
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      // 3. Request current channel state from existing users
      await this.requestChannelState();
      
      // Check for cancellation after requesting state
      if (abortSignal?.aborted) {
        await this.leaveChannel();
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      // 4. Announce our presence after state sync
      setTimeout(() => {
        if (!abortSignal?.aborted) {
          this.broadcastMessage({
            type: 'user-joined',
            from: userId,
            data: { mediaState: this.localMediaState },
            timestamp: Date.now()
          });
        }
      }, 200);
      
      // Final cancellation check
      if (abortSignal?.aborted) {
        await this.leaveChannel();
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      this.emit('channel-joined', { channelId, userId });
      this.emit('local-state-changed', this.localMediaState);
      
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        debug.log('🚫 [P2P] Connection cancelled');
        throw error; // Re-throw to propagate cancellation
      }
      debug.error('❌ Failed to join channel:', error);
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Leave current voice channel
   */
  async leaveChannel(): Promise<void> {
    debug.log('👋 Leaving voice channel');
    
    if (this.currentUserId && this.channelId) {
      this.broadcastMessage({
        type: 'user-left',
        from: this.currentUserId,
        data: {},
        timestamp: Date.now()
      });
    }
    
    this.connections.forEach(conn => {
      this.cleanupRemoteAudio(conn);
      conn.peerConnection.close();
    });
    this.connections.clear();
    this.allUserStates.clear();
    
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach(track => track.stop());
      this.localScreenStream = null;
    }
    this.announcedScreenStreamIds.clear();
    this.cameraVideoTrackId = null;
    this.screenShareVideoTrackId = null;
    this.screenShareAudioTrackId = null;
    this.localMediaState.isVideoEnabled = false;
    this.localMediaState.isScreenSharing = false;

    if (this.signalChannel) {
      await this.signalChannel.unsubscribe();
      this.signalChannel = null;
    }
    
    // Cleanup audio context + level-monitoring RAF
    // BUGS.md H21 v2: cancel the RAF explicitly, symmetric with the setup
    // path. The RAF self-terminates next frame via the `else` branch in
    // `updateLevel` (because `audioContext` becomes null below), so this is
    // not an active leak, but the asymmetry would silently regress if the
    // `else` branch is ever removed.
    if (this.audioLevelRafId !== null) {
      cancelAnimationFrame(this.audioLevelRafId);
      this.audioLevelRafId = null;
    }
    if (this.localAudioAnalyser) {
      try { this.localAudioAnalyser.disconnect(); } catch { /* noop */ }
      this.localAudioAnalyser = null;
    }
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
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
        // Enable video (screenshare, if active, keeps its own stream/senders)
        debug.log('🎥 Enabling video camera...');
        
        const { videoDevice } = this.getSelectedDevices();
        
        // Use stream quality settings
        const baseVideoConstraints = this.getVideoConstraints();
        const videoConstraints: any = {
          video: { ...baseVideoConstraints },
          audio: false
        };
        
        if (videoDevice) {
          videoConstraints.video.deviceId = { exact: videoDevice };
          debug.log('🎥 Using selected video device:', videoDevice);
        }
        
        const videoStream = await navigator.mediaDevices.getUserMedia(videoConstraints);
        const videoTrack = videoStream.getVideoTracks()[0];
        
        if (!videoTrack) {
          throw new Error('No video track obtained from camera');
        }
        
        debug.log('✅ Video track obtained:', videoTrack.getSettings());
        
        if (this.localStream) {
          // Remove any existing video tracks first (important!)
          const existingVideoTracks = this.localStream.getVideoTracks();
          existingVideoTracks.forEach(track => {
            debug.log('🛑 Stopping and removing old video track:', track.id);
            track.stop();
            this.localStream!.removeTrack(track);
          });
          
          this.localStream.addTrack(videoTrack);
          this.cameraVideoTrackId = videoTrack.id;
          this.localMediaState.isVideoEnabled = true;

          debug.log('📹 Local stream now has', this.localStream.getTracks().length, 'tracks');

          for (const [userId, conn] of this.connections) {
            try {
              // Never touch the screenshare sender - only reuse a camera sender
              const existingSenders = conn.peerConnection.getSenders();
              const cameraSender = existingSenders.find(
                s => s.track?.kind === 'video' && s.track.id !== this.screenShareVideoTrackId
              );

              if (cameraSender && cameraSender.track) {
                // Replace existing camera track (no renegotiation needed)
                debug.log('🔄 Replacing existing camera track for peer:', userId);
                await cameraSender.replaceTrack(videoTrack);
              } else {
                debug.log('➕ Adding camera track for peer:', userId);
                conn.peerConnection.addTrack(videoTrack, this.localStream);
                await this.renegotiateWithPeer(userId, conn);
              }
            } catch (error) {
              debug.error('❌ Error adding video track to peer', userId, ':', error);
            }
          }
          
          // Emit local stream change for UI update (important for self-view)
          this.emit('local-stream-changed', this.localStream);
          debug.log('📺 Emitted local-stream-changed event for self-view update');
        }
      } else {
        // Disable video
        debug.log('🎥 Disabling video camera...');
        
        if (this.localStream) {
          const videoTracks = this.localStream.getVideoTracks();

          for (const track of videoTracks) {
            debug.log('🛑 Stopping video track:', track.id);
            track.stop();
            this.localStream.removeTrack(track);

            for (const [userId, conn] of this.connections) {
              try {
                const senders = conn.peerConnection.getSenders();
                const videoSender = senders.find(s => s.track === track);

                if (videoSender) {
                  debug.log('📹 Removing video track from peer:', userId);
                  conn.peerConnection.removeTrack(videoSender);
                  await this.renegotiateWithPeer(userId, conn);
                }
              } catch (error) {
                debug.error('❌ Error removing video track from peer', userId, ':', error);
              }
            }
          }

          this.cameraVideoTrackId = null;
          this.localMediaState.isVideoEnabled = false;
          debug.log('✅ Video disabled, local stream now has', this.localStream.getTracks().length, 'tracks');
          
          this.emit('local-stream-changed', this.localStream);
          debug.log('📺 Emitted local-stream-changed event (video disabled)');
        }
      }
      
      await this.broadcastMediaState();
      this.emit('local-state-changed', this.localMediaState);
      
      return this.localMediaState.isVideoEnabled;
    } catch (error) {
      debug.error('❌ Error toggling video:', error);
      
      this.localMediaState.isVideoEnabled = false;
      return false;
    }
  }

  /**
   * Toggle screen share on/off
   */
  private screenShareVideoTrackId: string | null = null;
  private screenShareAudioTrackId: string | null = null;
  
  async toggleScreenShare(): Promise<boolean> {
    try {
      if (!this.localMediaState.isScreenSharing) {
        // Start screen sharing with audio (like Discord)
        // Use stream quality settings for resolution and framerate
        const screenVideoConstraints = this.getVideoConstraints();
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: screenVideoConstraints.width,
            height: screenVideoConstraints.height,
            frameRate: screenVideoConstraints.frameRate
          },
          audio: true // Include system audio for app streaming
        });
        
        const screenVideoTrack = screenStream.getVideoTracks()[0];
        const screenAudioTrack = screenStream.getAudioTracks()[0]; // System audio
        
        this.screenShareVideoTrackId = screenVideoTrack?.id || null;
        this.screenShareAudioTrackId = screenAudioTrack?.id || null;
        
        debug.log('📺 Screen share tracks:', {
          video: screenVideoTrack?.id,
          audio: screenAudioTrack?.id,
          audioLabel: screenAudioTrack?.label
        });
        
        if (screenVideoTrack) {
          // Screenshare lives in its own MediaStream: the stream id travels in
          // the SDP msid, so receivers can tell it apart from the camera feed.
          // Camera state is untouched - both can be live at once.
          this.localScreenStream = new MediaStream([screenVideoTrack]);
          debug.log('✅ Created screen stream:', this.localScreenStream.id);

          if (screenAudioTrack) {
            this.localScreenStream.addTrack(screenAudioTrack);
            debug.log('🔊 Screen sharing with system audio enabled');
          }

          this.localMediaState.isScreenSharing = true;

          // Add both screen tracks to every peer, then renegotiate once
          for (const [userId, conn] of this.connections) {
            try {
              conn.peerConnection.addTrack(screenVideoTrack, this.localScreenStream);
              if (screenAudioTrack) {
                conn.peerConnection.addTrack(screenAudioTrack, this.localScreenStream);
              }
              debug.log('➕ Added screen track(s) to peer:', userId);
              await this.renegotiateWithPeer(userId, conn);
            } catch (error) {
              debug.error('❌ Error updating screen share for peer', userId, ':', error);
            }
          }

          screenVideoTrack.onended = () => {
            debug.log('📺 Screen video track ended');
            if (this.localMediaState.isScreenSharing) {
              this.toggleScreenShare();
            }
          };
          
          if (screenAudioTrack) {
            screenAudioTrack.onended = () => {
              debug.log('🔊 Screen audio track ended');
              // Don't auto-stop screenshare when audio ends (video might still be going)
              // Just mark that audio is gone
              this.screenShareAudioTrackId = null;
            };
          }
        }
      } else {
        debug.log('🛑 Stopping screen share, cleaning up tracks:', {
          videoTrackId: this.screenShareVideoTrackId,
          audioTrackId: this.screenShareAudioTrackId
        });

        if (this.localScreenStream) {
          const screenTrackIds = new Set(
            this.localScreenStream.getTracks().map(t => t.id)
          );

          this.localScreenStream.getTracks().forEach(track => {
            debug.log('🛑 Stopping screen track:', track.kind, track.id);
            track.stop();
          });
          this.localScreenStream = null;

          // Remove the screen senders from every peer, then renegotiate once
          for (const [userId, conn] of this.connections) {
            try {
              let removed = false;
              for (const sender of conn.peerConnection.getSenders()) {
                if (sender.track && screenTrackIds.has(sender.track.id)) {
                  conn.peerConnection.removeTrack(sender);
                  removed = true;
                  debug.log('🛑 Removed screen sender from peer:', userId, sender.track.kind);
                }
              }
              if (removed) {
                await this.renegotiateWithPeer(userId, conn);
              }
            } catch (error) {
              debug.error('❌ Error removing screen tracks from peer', userId, ':', error);
            }
          }
        }

        this.screenShareVideoTrackId = null;
        this.screenShareAudioTrackId = null;
        this.localMediaState.isScreenSharing = false;
      }
      
      await this.broadcastMediaState();
      this.emit('local-state-changed', this.localMediaState);
      
      return this.localMediaState.isScreenSharing;
    } catch (error) {
      debug.error('❌ Error toggling screen share:', error);
      return false;
    }
  }

  // mic track transmits only when unmuted AND (voice activity mode OR PTT held)
  private isMicGated(): boolean {
    return this.localMediaState.isMuted || !this.pttGateOpen;
  }

  private applyMicGate(): void {
    const audioTrack = this.localStream?.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !this.isMicGated();
    }
    this.localMediaState.isSpeaking = this.calculateSpeakingState(this.localMediaState.audioLevel, this.isMicGated());
  }

  /**
   * Toggle mute on/off
   */
  toggleMute(): boolean {
    this.setMuted(!this.localMediaState.isMuted);
    return this.localMediaState.isMuted;
  }

  /**
   * Set explicit mute state (user intent — broadcast to peers)
   */
  setMuted(muted: boolean): void {
    if (this.localMediaState.isMuted === muted) return; // No change

    this.localMediaState.isMuted = muted;
    this.applyMicGate();

    this.broadcastMediaState();
    this.emit('local-state-changed', this.localMediaState);
  }

  /**
   * Open/close the PTT transmit gate — no mute state change, nothing broadcast
   */
  setTransmitGate(open: boolean): void {
    if (this.pttGateOpen === open) return;
    this.pttGateOpen = open;
    this.applyMicGate();
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
    
    // Check spatial audio state to avoid double audio on undeafen
    let isSpatialAudioActive = false;
    try {
      const { useSpatialAudioStore } = require('@/stores/spatialAudio');
      const { spatialAudioService } = require('@/services/spatialAudio');
      const spatialStore = useSpatialAudioStore();
      const spatialStatus = spatialAudioService.getStatus();
      isSpatialAudioActive = spatialStore.settings.enabled && spatialStatus.isInitialized;
      
      // Mute/unmute the spatial audio master output
      spatialAudioService.setDeafened(this.localMediaState.isDeafened);
    } catch (e) {
      // Spatial audio not available, ignore
    }
    
    // Mute/unmute traditional audio elements
    // When undeafening, keep traditional audio muted if spatial audio is active
    this.connections.forEach(conn => {
      if (conn.audioElement) {
        conn.audioElement.muted = this.localMediaState.isDeafened || isSpatialAudioActive;
        debug.log('🔊 Audio element for', conn.userId, conn.audioElement.muted ? 'muted' : 'unmuted',
                  '(deafened:', this.localMediaState.isDeafened, 'spatialActive:', isSpatialAudioActive, ')');
      }
      // Screen audio is never spatialized - only deafen affects it
      if (conn.screenAudioElement) {
        conn.screenAudioElement.muted = this.localMediaState.isDeafened;
      }
    });
    
    this.broadcastMediaState();
    this.emit('local-state-changed', this.localMediaState);
    
    return this.localMediaState.isDeafened;
  }

  // GETTERS

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

  /** The user's screenshare stream (camera/mic live in getUserStream) */
  getUserScreenStream(userId: string): MediaStream | null {
    if (userId === this.currentUserId) {
      return this.localScreenStream;
    }
    return this.connections.get(userId)?.remoteScreenStream || null;
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
          debug.error('❌ Error in event listener:', error);
        }
      });
    }
  }

  // PRIVATE METHODS

  /**
   * Calculate speaking state based on audio level and mute status
   */
  private calculateSpeakingState(audioLevel: number, isMuted: boolean): boolean {
    return audioLevel > 20 && !isMuted;
  }

  private async initializeLocalAudio(): Promise<void> {
    try {
      const { inputDevice } = this.getSelectedDevices();
      const audioConstraints: MediaTrackConstraints = {
        ...this.audioConstraints
      };

      // Add device ID if specified, but use 'ideal' for graceful fallback
      if (inputDevice) {
        audioConstraints.deviceId = { ideal: inputDevice };
        debug.log('🎤 Using selected input device for constraint update:', inputDevice);
      }

      let newAudioStream: MediaStream;

      try {
        // Try with the selected device first
        newAudioStream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
          video: false
        });
      } catch (error) {
        debug.warn('⚠️ Failed to use selected device during constraint update, falling back to default:', error);
        
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
        
        debug.log('✅ Using default audio device as fallback during constraint update');
      }

      this.localStream = newAudioStream;

      // Ensure audio track is enabled based on mute state
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !this.localMediaState.isMuted;
      }
      
      this.setupAudioLevelMonitoring();
      
      this.emit('local-stream-changed', this.localStream);
      this.emit('stream-changed', { userId: this.currentUserId, stream: this.localStream, type: 'local' });
    } catch (error) {
      debug.error('❌ Failed to get audio stream:', error);
      throw error;
    }
  }
  private setupAudioLevelMonitoring(): void {
    if (!this.localStream) return;

    // BUGS.md H21: previously each call (incl. on device-change /
    // constraint-change paths via `updateInputDevice`) created a NEW
    // AudioContext and left the prior one - plus its RAF loop - running.
    // Mid-call device switches therefore leaked AudioContexts until
    // `leaveChannel()`. Tear down the previous context + cancel its RAF
    // before constructing the new one.
    if (this.audioLevelRafId !== null) {
      cancelAnimationFrame(this.audioLevelRafId);
      this.audioLevelRafId = null;
    }
    if (this.localAudioAnalyser) {
      try { this.localAudioAnalyser.disconnect(); } catch { /* noop */ }
      this.localAudioAnalyser = null;
    }
    if (this.audioContext) {
      const prev = this.audioContext;
      this.audioContext = null;
      prev.close().catch(err => debug.warn('⚠️ Failed to close prior AudioContext:', err));
    }

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
          
          const wasSpeaking = this.localMediaState.isSpeaking;
          this.localMediaState.isSpeaking = this.calculateSpeakingState(average, this.isMicGated());
          
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

          this.audioLevelRafId = requestAnimationFrame(updateLevel);
        } else {
          this.audioLevelRafId = null;
        }
      };
      
      this.audioLevelRafId = requestAnimationFrame(updateLevel);
    } catch (error) {
      debug.warn('⚠️ Audio level monitoring setup failed:', error);
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
          debug.log('📡 Signaling channel ready');
          resolve();
        } else if (status === 'CHANNEL_ERROR') {
          reject(new Error('Failed to setup signaling'));
        }
      });
    });
  }

  private async requestChannelState(): Promise<void> {
    if (!this.currentUserId) return;
    
    debug.log('🔄 Requesting channel state from existing users');
    
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
    
    debug.log('📩 Received:', type, 'from:', from);
    
    switch (type) {
      case 'user-joined':
        await this.handleUserJoined(from, data.mediaState);
        break;
        
      case 'user-left':
        await this.handleUserLeft(from);
        break;
        
      case 'media-state':
        this.handleMediaStateUpdate(from, data.mediaState, data.screenStreamId);
        break;
        
      case 'state-sync':
        await this.handleStateSync(from, data);
        break;
        
      case 'call-start-time':
        // Forward to store
        this.emit('call-start-time', { timestamp: data.timestamp, from });
        break;
        
      case 'request-call-start-time':
        // Forward to store to handle
        this.emit('request-call-start-time', { from });
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
    debug.log('👋 User joined:', userId, mediaState);
    
    this.allUserStates.set(userId, mediaState);

    await this.createPeerConnection(userId, true); // We initiate since they just joined
    
    this.emit('user-joined', { userId, mediaState });
  }

  private async handleUserLeft(userId: string): Promise<void> {
    debug.log('👋 User left:', userId);

    const connection = this.connections.get(userId);
    if (connection) {
      this.cleanupRemoteAudio(connection);
      connection.peerConnection.close();
      this.connections.delete(userId);
    }

    this.allUserStates.delete(userId);
    this.announcedScreenStreamIds.delete(userId);
    this.emit('user-left', { userId });
  }

  private handleMediaStateUpdate(userId: string, mediaState: UserMediaState, screenStreamId?: string | null): void {
    debug.log('🎛️ Media state update:', userId, mediaState, 'screenStreamId:', screenStreamId);

    this.allUserStates.set(userId, mediaState);

    // Screen stream announcement may arrive before or after the tracks do;
    // re-classify whatever streams we already have from this peer
    if (screenStreamId !== undefined) {
      const previous = this.announcedScreenStreamIds.get(userId);
      this.announcedScreenStreamIds.set(userId, screenStreamId);
      if (previous !== screenStreamId) {
        const connection = this.connections.get(userId);
        if (connection) {
          this.classifyRemoteStreams(connection);
        }
      }
    }

    this.emit('user-state-changed', { userId, mediaState });
  }

  private handleAudioLevel(data: { userId: string; audioLevel: number; timestamp: number }): void {
    const { userId, audioLevel } = data;
    
    const userState = this.allUserStates.get(userId);
    if (userState) {
      const wasSpeaking = userState.isSpeaking;
      userState.audioLevel = audioLevel;
      
      userState.isSpeaking = this.calculateSpeakingState(audioLevel, userState.isMuted);
      
      this.emit('audio-level', { userId, level: audioLevel });
      
      if (wasSpeaking !== userState.isSpeaking) {
        this.emit('user-state-changed', { userId, mediaState: userState });
      }
    }
  }

  private async handleStateSync(from: string, data: any): Promise<void> {
    if (data.action === 'request') {
      // Someone is requesting current state - send our state
      debug.log('📤 Sending our state to:', from);
      
      this.sendDirectMessage(from, {
        type: 'state-sync',
        from: this.currentUserId!,
        to: from,
        data: {
          action: 'response',
          mediaState: this.localMediaState,
          screenStreamId: this.localScreenStream?.id ?? null,
          allStates: Array.from(this.allUserStates.values())
        },
        timestamp: Date.now()
      });
    } else if (data.action === 'response') {
      // Someone is sending us the current channel state
      debug.log('📥 Received channel state from:', from, data);
      
      if (data.allStates) {
        data.allStates.forEach((state: UserMediaState) => {
          if (state.userId !== this.currentUserId) {
            this.allUserStates.set(state.userId, state);
          }
        });
      }
      
      if (data.mediaState) {
        this.allUserStates.set(from, data.mediaState);
      }

      if (data.screenStreamId !== undefined) {
        this.announcedScreenStreamIds.set(from, data.screenStreamId);
        const connection = this.connections.get(from);
        if (connection) {
          this.classifyRemoteStreams(connection);
        }
      }

      this.emit('channel-state-synced', {
        users: Array.from(this.allUserStates.values())
      });
    }
  }

  private async createPeerConnection(userId: string, isInitiator: boolean): Promise<void> {
    debug.log('🔗 Creating peer connection with:', userId, 'as initiator:', isInitiator);
    
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      ],
      iceCandidatePoolSize: 10,
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
      remoteScreenStream: null,
      knownStreams: new Map(),
      audioElement: null,
      screenAudioElement: null,
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      pendingIceCandidates: []
    };

    this.connections.set(userId, connection);

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        debug.log('🔗 Adding track to peer', userId, ':', track.kind, 'enabled:', track.enabled);
        pc.addTrack(track, this.localStream!);
      });
      debug.log('✅ Added', this.localStream.getTracks().length, 'tracks to peer connection with', userId);
    }

    // If we're mid-screenshare when this peer appears, include those tracks too
    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach(track => {
        debug.log('🔗 Adding screen track to peer', userId, ':', track.kind);
        pc.addTrack(track, this.localScreenStream!);
      });
    }

    pc.ontrack = async (event) => {
      debug.log('📹 Received track from:', userId, event.track.kind, 'Stream ID:', event.streams[0]?.id);

      const stream = event.streams[0];
      if (stream) {
        connection.knownStreams.set(stream.id, stream);
        await this.classifyRemoteStreams(connection);
      }
    };
    
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
    
    pc.onconnectionstatechange = () => {
      connection.connectionState = pc.connectionState;
      this.emit('connection-state-changed', { userId, state: pc.connectionState });
    };
    
    pc.oniceconnectionstatechange = () => {
      connection.iceConnectionState = pc.iceConnectionState;
      debug.log('🧊 ICE state for', userId, ':', pc.iceConnectionState);
    };
    
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
        debug.error('❌ Error creating offer for:', userId, error);
      }
    }
  }

  private async handleOffer(from: string, offer: RTCSessionDescriptionInit): Promise<void> {
    debug.log('📞 Handling offer from:', from);
    
    let connection = this.connections.get(from);
    if (!connection) {
      await this.createPeerConnection(from, false);
      connection = this.connections.get(from)!;
    }
    
    // Ensure user is tracked in allUserStates so they appear in the participant list.
    // Offers can arrive before the state-sync response that normally adds users.
    if (!this.allUserStates.has(from)) {
      const defaultState: UserMediaState = {
        userId: from,
        isAudioEnabled: true,
        isVideoEnabled: false,
        isScreenSharing: false,
        isMuted: false,
        isDeafened: false,
        isSpeaking: false,
        audioLevel: 0,
      };
      this.allUserStates.set(from, defaultState);
      this.emit('user-joined', { userId: from, mediaState: defaultState });
      debug.log('👤 Added user from offer to allUserStates:', from);
    }
    
    try {
      await connection.peerConnection.setRemoteDescription(offer);
      // BUGS.md H20: flush ICE candidates that arrived between the offer
      // being received and us setting the remote description.
      await this.flushPendingIceCandidates(from);
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
      debug.error('❌ Error handling offer from:', from, error);
    }
  }

  private async handleAnswer(from: string, answer: RTCSessionDescriptionInit): Promise<void> {
    debug.log('📞 Handling answer from:', from);
    
    const connection = this.connections.get(from);
    if (connection) {
      try {
        await connection.peerConnection.setRemoteDescription(answer);
        // BUGS.md H20: flush any ICE candidates that arrived before we
        // processed the answer.
        await this.flushPendingIceCandidates(from);
      } catch (error) {
        debug.error('❌ Error handling answer from:', from, error);
      }
    }
  }

  private async handleIceCandidate(from: string, candidate: RTCIceCandidateInit): Promise<void> {
    const connection = this.connections.get(from);
    if (!connection) return;

    // BUGS.md H20: with trickle ICE, candidates frequently arrive before the
    // remote SDP has been processed. Calling `addIceCandidate` before
    // `setRemoteDescription` throws `InvalidStateError`. Queue until the
    // remote description is set, then flush in `flushPendingIceCandidates`.
    if (!connection.peerConnection.remoteDescription) {
      // BUGS.md H20 v2: cap the queue. An authenticated peer in the same
      // Supabase voice channel can flood `ice-candidate` messages without
      // ever sending an offer, growing this array indefinitely. 100 is
      // generous (real-world ICE candidate counts per peer are <30) and
      // turns a memory-DoS into a noisy warning.
      const MAX_PENDING_ICE = 100;
      if (connection.pendingIceCandidates.length >= MAX_PENDING_ICE) {
        debug.warn(
          `⚠️ Dropping ICE candidate from ${from}: queue full (${MAX_PENDING_ICE}). Peer is sending candidates without an offer.`,
        );
        return;
      }
      connection.pendingIceCandidates.push(candidate);
      return;
    }

    try {
      await connection.peerConnection.addIceCandidate(candidate);
    } catch (error) {
      debug.error('❌ Error adding ICE candidate from:', from, error);
    }
  }

  /**
   * Flush any ICE candidates queued by `handleIceCandidate` while the
   * remote description was missing. Called from both `handleOffer` (callee
   * side, after setRemoteDescription on the offer) and `handleAnswer`
   * (caller side, after setRemoteDescription on the answer).
   */
  private async flushPendingIceCandidates(from: string): Promise<void> {
    const connection = this.connections.get(from);
    if (!connection || connection.pendingIceCandidates.length === 0) return;

    const queued = connection.pendingIceCandidates.splice(0);
    debug.log(`🧊 Flushing ${queued.length} queued ICE candidates from ${from}`);
    for (const candidate of queued) {
      try {
        await connection.peerConnection.addIceCandidate(candidate);
      } catch (error) {
        debug.warn('⚠️ Error adding queued ICE candidate from:', from, error);
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

  /**
   * Wait for a stable signaling state, then send a fresh offer to the peer.
   * Used after addTrack/removeTrack (renegotiation).
   */
  private async renegotiateWithPeer(userId: string, conn: UserConnection): Promise<void> {
    if (conn.peerConnection.signalingState !== 'stable') {
      debug.log('⏳ Waiting for stable signaling state before renegotiation...');
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

    const offer = await conn.peerConnection.createOffer();
    await conn.peerConnection.setLocalDescription(offer);

    this.sendDirectMessage(userId, {
      type: 'offer',
      from: this.currentUserId!,
      to: userId,
      data: offer,
      timestamp: Date.now()
    });

    debug.log('✅ Renegotiation offer sent to:', userId);
  }

  private async broadcastMediaState(): Promise<void> {
    this.broadcastMessage({
      type: 'media-state',
      from: this.currentUserId!,
      data: {
        mediaState: this.localMediaState,
        // Lets receivers classify our streams: camera/mic vs screenshare
        screenStreamId: this.localScreenStream?.id ?? null,
      },
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

  /**
   * Sort a peer's known streams into mic/camera vs screenshare using the
   * screen stream id the peer announced. Called from ontrack (streams may
   * arrive before the announcement) and from media-state / state-sync
   * handlers (the announcement may arrive before the streams).
   */
  private async classifyRemoteStreams(connection: UserConnection): Promise<void> {
    const userId = connection.userId;
    const screenStreamId = this.announcedScreenStreamIds.get(userId) ?? null;

    // Drop streams whose tracks have all ended
    for (const [id, stream] of connection.knownStreams) {
      const tracks = stream.getTracks();
      if (tracks.length > 0 && tracks.every(t => t.readyState === 'ended')) {
        connection.knownStreams.delete(id);
      }
    }

    const previousMicStream = connection.remoteStream;
    const previousScreenStream = connection.remoteScreenStream;

    connection.remoteScreenStream = screenStreamId
      ? connection.knownStreams.get(screenStreamId) ?? null
      : null;
    connection.remoteStream =
      [...connection.knownStreams.values()].find(s => s.id !== screenStreamId) ?? null;

    if (connection.remoteStream && connection.remoteStream !== previousMicStream) {
      debug.log('📡 Mic/camera stream for user:', userId, 'tracks:', connection.remoteStream.getTracks().length);
      await this.setupRemoteAudio(connection, connection.remoteStream);
    }

    if (connection.remoteScreenStream !== previousScreenStream) {
      debug.log('📡 Screen stream for user:', userId, 'present:', !!connection.remoteScreenStream);
      this.setupScreenAudio(connection);
    }

    this.emit('user-stream-changed', { userId, stream: connection.remoteStream });
    this.emit('stream-changed', { userId, stream: connection.remoteStream, type: 'remote' });
  }

  /**
   * Screenshare audio plays through its own element - it must never be
   * spatialized or muted along with the dry mic path.
   */
  private setupScreenAudio(connection: UserConnection): void {
    if (connection.screenAudioElement) {
      connection.screenAudioElement.pause();
      connection.screenAudioElement.srcObject = null;
      connection.screenAudioElement = null;
    }

    const audioTracks = connection.remoteScreenStream?.getAudioTracks() ?? [];
    if (audioTracks.length === 0) return;

    const audioElement = new Audio();
    audioElement.autoplay = true;
    audioElement.srcObject = new MediaStream(audioTracks);
    audioElement.muted = this.localMediaState.isDeafened;
    const sinkCapable = audioElement as any;
    if (this.selectedOutputDevice && sinkCapable.setSinkId) {
      sinkCapable.setSinkId(this.selectedOutputDevice).catch(() => { /* best effort */ });
    }
    connection.screenAudioElement = audioElement;
    debug.log('🔊 Screen audio element created for user:', connection.userId);
  }

  private async setupRemoteAudio(connection: UserConnection, stream: MediaStream): Promise<void> {
    const audioTracks = stream.getAudioTracks();
    
    if (audioTracks.length > 0) {
      if (!connection.audioElement) {
        connection.audioElement = new Audio();
        connection.audioElement.autoplay = true;
        // Note: playsInline is for video elements, not needed for audio
      }
      
      connection.audioElement.srcObject = stream;
      
      const { useSpatialAudioStore } = await import('@/stores/spatialAudio');
      const { spatialAudioService } = await import('@/services/spatialAudio');
      const spatialStore = useSpatialAudioStore();
      const spatialStatus = spatialAudioService.getStatus();
      const isSpatialAudioActive = spatialStore.settings.enabled && spatialStatus.isInitialized;
      
      // Apply current deafen state AND check spatial audio
      // When spatial audio is ACTIVE (enabled + initialized), mute HTMLAudioElement to prevent double audio (dry + wet)
      // Otherwise, keep it unmuted so we hear the normal audio through the HTMLAudioElement
      connection.audioElement.muted = this.localMediaState.isDeafened || isSpatialAudioActive;
      
      debug.log('🔊 Audio element created for user:', connection.userId, 
                  'muted:', connection.audioElement.muted,
                  'spatialEnabled:', spatialStore.settings.enabled,
                  'spatialInitialized:', spatialStatus.isInitialized,
                  'spatialActive:', isSpatialAudioActive,
                  'deafened:', this.localMediaState.isDeafened);
      
      connection.audioElement.onerror = (error) => {
        debug.error('❌ Audio element error for user', connection.userId, ':', error);
      };
      
      connection.audioElement.onplay = () => {
        debug.log('▶️ Audio started playing for user:', connection.userId);
      };
    }
  }

  /**
   * Enable or disable traditional HTMLAudioElement playback
   * This should be called when spatial audio is toggled
   */
  setTraditionalAudioEnabled(enabled: boolean): void {
    debug.log(`🔊 Setting traditional audio enabled: ${enabled} for ${this.connections.size} connections`);
    
    this.connections.forEach(connection => {
      if (connection.audioElement) {
        const wasPlaying = !connection.audioElement.muted && !connection.audioElement.paused;
        
        // When spatial audio is enabled, mute the HTMLAudioElement to prevent double audio
        // When spatial audio is disabled, unmute it for normal playback
        connection.audioElement.muted = !enabled || this.localMediaState.isDeafened;
        
        const isNowPlaying = !connection.audioElement.muted && !connection.audioElement.paused;
        
        debug.log(`🔊 ${connection.userId}: muted=${connection.audioElement.muted}, ` +
                   `wasPlaying=${wasPlaying}, isNowPlaying=${isNowPlaying}, ` +
                   `deafened=${this.localMediaState.isDeafened}`);
      } else {
        debug.warn(`⚠️ No audioElement for user ${connection.userId}`);
      }
    });
  }

  private cleanupRemoteAudio(connection: UserConnection): void {
    if (connection.audioElement) {
      connection.audioElement.pause();
      connection.audioElement.srcObject = null;
      connection.audioElement = null;
      debug.log('🔇 Audio element cleaned up for user:', connection.userId);
    }
    if (connection.screenAudioElement) {
      connection.screenAudioElement.pause();
      connection.screenAudioElement.srcObject = null;
      connection.screenAudioElement = null;
      debug.log('🔇 Screen audio element cleaned up for user:', connection.userId);
    }
  }

  private setupCleanup(): void {
    window.addEventListener('beforeunload', () => {
      this.leaveChannel();
    });
  }

  // AUDIO SETTINGS MANAGEMENT

  /**
   * Get selected devices
   */
  getSelectedDevices(): { inputDevice: string | null; outputDevice: string | null; videoDevice: string | null } {
    return {
      inputDevice: this.selectedInputDevice,
      outputDevice: this.selectedOutputDevice,
      videoDevice: this.selectedVideoDevice
    };
  }

  private loadAudioSettings(): void {
    try {
      const devices = VoiceSettingsService.getDevices();
      const constraints = VoiceSettingsService.getAudioConstraints();
      
      this.audioConstraints = {
        ...this.audioConstraints,
        echoCancellation: constraints.echoCancellation,
        noiseSuppression: constraints.noiseSuppression,
        autoGainControl: constraints.autoGainControl,
      };
      debug.log('🎛️ [P2P] Loaded audio settings:', this.audioConstraints);
      
      this.selectedInputDevice = devices.inputDevice;
      this.selectedOutputDevice = devices.outputDevice;
      this.selectedVideoDevice = devices.videoDevice;
      debug.log('🎛️ [P2P] Loaded device settings:', devices);
    } catch (error) {
      debug.warn('⚠️ [P2P] Failed to load audio settings:', error);
    }
  }

  private saveAudioSettings(): void {
    try {
      VoiceSettingsService.setAudioConstraints({
        echoCancellation: this.audioConstraints.echoCancellation,
        noiseSuppression: this.audioConstraints.noiseSuppression,
        autoGainControl: this.audioConstraints.autoGainControl
      });
      
      if (this.selectedInputDevice) {
        VoiceSettingsService.setInputDevice(this.selectedInputDevice);
      }
      if (this.selectedOutputDevice) {
        VoiceSettingsService.setOutputDevice(this.selectedOutputDevice);
      }
      if (this.selectedVideoDevice) {
        VoiceSettingsService.setVideoDevice(this.selectedVideoDevice);
      }
      
      debug.log('💾 [P2P] Saved audio and device settings via VoiceSettingsService');
    } catch (error) {
      debug.warn('⚠️ [P2P] Failed to save audio settings:', error);
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
    debug.log('🎛️ Updating audio constraints:', constraints);
    
    Object.assign(this.audioConstraints, constraints);
    this.saveAudioSettings();
    
    // If we're currently connected, restart the audio stream with new constraints
    if (this.localStream && this.channelId) {
      const currentMuteState = this.localMediaState.isMuted;

      // BUGS.md H22 v2: same fix as `updateInputDevice` - acquire the new
      // stream FIRST, then stop and remove the old tracks. The previous
      // order would silently kill the user's mic when `getUserMedia` failed
      // for the new constraints (e.g. AGC toggled to a value the device
      // doesn't support, or permission flipped between settings save and
      // apply). BUGS.md H22 explicitly cites this method (range 1837-1883
      // in the audit) as a second site that needed the same ordering fix.
      try {
        const newAudioStream = await navigator.mediaDevices.getUserMedia({
          audio: this.audioConstraints,
          video: false
        });

        const newAudioTrack = newAudioStream.getAudioTracks()[0];
        if (newAudioTrack) {
          // Only NOW swap - the old tracks are stopped after the new
          // stream is committed.
          const oldAudioTracks = this.localStream.getAudioTracks();
          oldAudioTracks.forEach(track => {
            track.stop();
            this.localStream!.removeTrack(track);
          });
          this.localStream.addTrack(newAudioTrack);
          
          newAudioTrack.enabled = !currentMuteState;
          
          for (const [userId, conn] of this.connections) {
            try {
              const senders = conn.peerConnection.getSenders();
              const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
              
              if (audioSender) {
                await audioSender.replaceTrack(newAudioTrack);
                debug.log('🔄 Replaced audio track for peer:', userId);
              }
            } catch (error) {
              debug.error('❌ Error updating audio track for peer', userId, ':', error);
            }
          }
          
          // Restart audio level monitoring
          this.setupAudioLevelMonitoring();
          
          debug.log('✅ Audio stream updated with new constraints');
          this.emit('local-stream-changed', this.localStream);
        }
      } catch (error) {
        debug.error('❌ Failed to update audio constraints:', error);
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

// SINGLETON EXPORT

export const unifiedWebRTC = new UnifiedWebRTCService();