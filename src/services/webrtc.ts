import SimplePeer from 'simple-peer';
// @ts-ignore
if (typeof global === 'undefined') {
  (window as any).global = window;
}
import { supabase } from '@/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface WebRTCUser {
  id: string;
  peer: SimplePeer.Instance;
  stream?: MediaStream;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
}

export interface WebRTCState {
  localStream: MediaStream | null;
  users: Map<string, WebRTCUser>;
  isConnected: boolean;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  currentChannelId: string | null;
}

export interface SignalData {
  from: string;
  to: string;
  signal: SimplePeer.SignalData;
  type: 'offer' | 'answer' | 'ice-candidate';
}

export interface MediaToggle {
  userId: string;
  audio: boolean;
  video: boolean;
  screen: boolean;
}

export class WebRTCService {
  private state: WebRTCState = {
    localStream: null,
    users: new Map(),
    isConnected: false,
    isAudioEnabled: true,
    isVideoEnabled: false,
    isScreenSharing: false,
    isMuted: false,
    isDeafened: false,
    currentChannelId: null,
  };

  private signalChannel: RealtimeChannel | null = null;
  private eventCallbacks: Map<string, Function[]> = new Map();

  constructor() {
    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    // Handle page unload to cleanup connections
    window.addEventListener('beforeunload', () => {
      this.disconnect();
    });
  }

  // Event system
  on(event: string, callback: Function) {
    if (!this.eventCallbacks.has(event)) {
      this.eventCallbacks.set(event, []);
    }
    this.eventCallbacks.get(event)!.push(callback);
  }

  off(event: string, callback: Function) {
    const callbacks = this.eventCallbacks.get(event);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  private emit(event: string, ...args: any[]) {
    const callbacks = this.eventCallbacks.get(event);
    if (callbacks) {
      callbacks.forEach(callback => callback(...args));
    }
  }

  // Get current state
  getState(): WebRTCState {
    return { ...this.state };
  }

  // Join a voice channel
  async joinChannel(channelId: string, userId: string): Promise<boolean> {
    try {
      // Leave current channel first
      if (this.state.currentChannelId) {
        await this.leaveChannel();
      }

      this.state.currentChannelId = channelId;
      
      // Get user media
      await this.getUserMedia();
      
      // Setup signaling channel
      await this.setupSignalingChannel(channelId, userId);
      
      this.state.isConnected = true;
      this.emit('channelJoined', channelId);
      
      return true;
    } catch (error) {
      console.error('Error joining channel:', error);
      this.emit('error', error);
      return false;
    }
  }

  // Leave current voice channel
  async leaveChannel(): Promise<void> {
    try {
      // Close all peer connections
      this.state.users.forEach(user => {
        user.peer.destroy();
      });
      this.state.users.clear();

      // Stop local stream
      if (this.state.localStream) {
        this.state.localStream.getTracks().forEach(track => {
          track.stop();
        });
        this.state.localStream = null;
      }

      // Cleanup signaling channel
      if (this.signalChannel) {
        await this.signalChannel.unsubscribe();
        this.signalChannel = null;
      }

      const channelId = this.state.currentChannelId;
      this.state.currentChannelId = null;
      this.state.isConnected = false;
      
      this.emit('channelLeft', channelId);
    } catch (error) {
      console.error('Error leaving channel:', error);
      this.emit('error', error);
    }
  }

  // Get user media (audio/video)
  private async getUserMedia(): Promise<MediaStream> {
    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: this.state.isVideoEnabled ? {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        } : false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.state.localStream = stream;
      
      this.emit('localStreamChanged', stream);
      return stream;
    } catch (error) {
      console.error('Error getting user media:', error);
      throw error;
    }
  }

  // Setup signaling channel for WebRTC
  private async setupSignalingChannel(channelId: string, userId: string): Promise<void> {
    this.signalChannel = supabase.channel(`voice-${channelId}`, {
      config: {
        broadcast: { self: false },
      },
    });

    // Listen for WebRTC signaling messages
    this.signalChannel
      .on('broadcast', { event: 'webrtc-signal' }, (payload) => {
        this.handleSignalingMessage(payload.payload as SignalData);
      })
      .on('broadcast', { event: 'user-joined' }, (payload) => {
        this.handleUserJoined(payload.payload.userId);
      })
      .on('broadcast', { event: 'user-left' }, (payload) => {
        this.handleUserLeft(payload.payload.userId);
      })
      .on('broadcast', { event: 'media-toggle' }, (payload) => {
        this.handleMediaToggle(payload.payload as MediaToggle);
      });

    // Subscribe to channel
    await new Promise<void>((resolve, reject) => {
      this.signalChannel!.subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          // Announce joining
          this.signalChannel!.send({
            type: 'broadcast',
            event: 'user-joined',
            payload: { userId },
          });
          resolve();
        } else if (status === 'CHANNEL_ERROR') {
          reject(new Error('Failed to subscribe to signaling channel'));
        }
      });
    });
  }

  // Handle signaling messages
  private handleSignalingMessage(data: SignalData): void {
    const { from, signal } = data;
    
    const user = this.state.users.get(from);
    if (user) {
      user.peer.signal(signal);
    }
  }

  // Handle user joining
  private handleUserJoined(userId: string): void {
    if (userId === this.getCurrentUserId() || this.state.users.has(userId)) {
      return;
    }

    this.createPeerConnection(userId, true);
  }

  // Handle user leaving
  private handleUserLeft(userId: string): void {
    const user = this.state.users.get(userId);
    if (user) {
      user.peer.destroy();
      this.state.users.delete(userId);
      this.emit('userLeft', userId);
    }
  }

  // Handle media toggle events
  private handleMediaToggle(data: MediaToggle): void {
    const user = this.state.users.get(data.userId);
    if (user) {
      user.isAudioEnabled = data.audio;
      user.isVideoEnabled = data.video;
      user.isScreenSharing = data.screen;
      this.emit('userMediaToggled', data);
    }
  }

  // Create peer connection
  private createPeerConnection(userId: string, initiator: boolean): void {
    const peer = new SimplePeer({
      initiator,
      stream: this.state.localStream || undefined,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      },
    });

    const webrtcUser: WebRTCUser = {
      id: userId,
      peer,
      isAudioEnabled: true,
      isVideoEnabled: false,
      isScreenSharing: false,
    };

    this.state.users.set(userId, webrtcUser);

    // Handle peer events
    peer.on('signal', (signal) => {
      this.sendSignal(userId, signal);
    });

    peer.on('stream', (stream) => {
      webrtcUser.stream = stream;
      this.emit('userStreamChanged', userId, stream);
    });

    peer.on('connect', () => {
      console.log('Peer connected:', userId);
      this.emit('userConnected', userId);
    });

    peer.on('close', () => {
      console.log('Peer disconnected:', userId);
      this.state.users.delete(userId);
      this.emit('userDisconnected', userId);
    });

    peer.on('error', (error) => {
      console.error('Peer error:', error);
      this.emit('peerError', userId, error);
    });

    this.emit('userJoined', userId);
  }

  // Send signaling message
  private sendSignal(to: string, signal: SimplePeer.SignalData): void {
    if (!this.signalChannel) return;

    this.signalChannel.send({
      type: 'broadcast',
      event: 'webrtc-signal',
      payload: {
        from: this.getCurrentUserId(),
        to,
        signal,
        type: signal.type,
      },
    });
  }

  // Media control methods
  async toggleAudio(): Promise<boolean> {
    if (!this.state.localStream) return false;

    const audioTrack = this.state.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      this.state.isAudioEnabled = audioTrack.enabled;
      this.broadcastMediaToggle();
      this.emit('audioToggled', this.state.isAudioEnabled);
    }
    
    return this.state.isAudioEnabled;
  }

  async toggleVideo(): Promise<boolean> {
    try {
      if (!this.state.isVideoEnabled) {
        // Enable video
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const videoTrack = videoStream.getVideoTracks()[0];
        
        if (this.state.localStream) {
          this.state.localStream.addTrack(videoTrack);
        }
        
        this.state.isVideoEnabled = true;
      } else {
        // Disable video
        if (this.state.localStream) {
          const videoTracks = this.state.localStream.getVideoTracks();
          videoTracks.forEach(track => {
            track.stop();
            this.state.localStream!.removeTrack(track);
          });
        }
        
        this.state.isVideoEnabled = false;
      }
      
      this.broadcastMediaToggle();
      this.emit('videoToggled', this.state.isVideoEnabled);
      this.emit('localStreamChanged', this.state.localStream);
      
      return this.state.isVideoEnabled;
    } catch (error) {
      console.error('Error toggling video:', error);
      return false;
    }
  }

  async toggleScreenShare(): Promise<boolean> {
    try {
      if (!this.state.isScreenSharing) {
        // Start screen sharing
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
        
        // Replace video track with screen share
        if (this.state.localStream) {
          const videoTracks = this.state.localStream.getVideoTracks();
          videoTracks.forEach(track => {
            track.stop();
            this.state.localStream!.removeTrack(track);
          });
          
          const screenTrack = screenStream.getVideoTracks()[0];
          this.state.localStream.addTrack(screenTrack);
          
          // Handle screen share ending
          screenTrack.onended = () => {
            this.toggleScreenShare();
          };
        }
        
        this.state.isScreenSharing = true;
      } else {
        // Stop screen sharing
        if (this.state.localStream) {
          const videoTracks = this.state.localStream.getVideoTracks();
          videoTracks.forEach(track => {
            track.stop();
            this.state.localStream!.removeTrack(track);
          });
        }
        
        this.state.isScreenSharing = false;
      }
      
      this.broadcastMediaToggle();
      this.emit('screenShareToggled', this.state.isScreenSharing);
      this.emit('localStreamChanged', this.state.localStream);
      
      return this.state.isScreenSharing;
    } catch (error) {
      console.error('Error toggling screen share:', error);
      return false;
    }
  }

  // Broadcast media toggle to other users
  private broadcastMediaToggle(): void {
    if (!this.signalChannel) return;

    this.signalChannel.send({
      type: 'broadcast',
      event: 'media-toggle',
      payload: {
        userId: this.getCurrentUserId(),
        audio: this.state.isAudioEnabled,
        video: this.state.isVideoEnabled,
        screen: this.state.isScreenSharing,
      },
    });
  }

  // Mute/deafen controls
  setMuted(muted: boolean): void {
    this.state.isMuted = muted;
    if (this.state.localStream) {
      const audioTrack = this.state.localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !muted;
      }
    }
    this.emit('muteToggled', muted);
  }

  setDeafened(deafened: boolean): void {
    this.state.isDeafened = deafened;
    // Mute all remote streams
    this.state.users.forEach(user => {
      if (user.stream) {
        user.stream.getAudioTracks().forEach(track => {
          track.enabled = !deafened;
        });
      }
    });
    this.emit('deafenToggled', deafened);
  }

  // Get user stream
  getUserStream(userId: string): MediaStream | undefined {
    return this.state.users.get(userId)?.stream;
  }

  // Get local stream
  getLocalStream(): MediaStream | null {
    return this.state.localStream;
  }

  // Get connected users
  getConnectedUsers(): string[] {
    return Array.from(this.state.users.keys());
  }

  // Helper to get current user ID
  private getCurrentUserId(): string {
    // Import useAuthStore dynamically to avoid circular dependencies
    const { useAuthStore } = require('@/stores/auth');
    const authStore = useAuthStore();
    return authStore.session?.user?.id || 'anonymous';
  }

  // Cleanup
  async disconnect(): Promise<void> {
    await this.leaveChannel();
    this.eventCallbacks.clear();
  }
}

// Singleton instance
export const webRTCService = new WebRTCService();
