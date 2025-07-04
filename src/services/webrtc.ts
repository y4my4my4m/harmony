import SimplePeer from 'simple-peer';
// @ts-ignore
if (typeof global === 'undefined') {
  (window as any).global = window;
}
// @ts-ignore
if (typeof process === 'undefined') {
  (window as any).process = { env: {} };
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
      this.currentUserId = userId; // Store user ID for later use
      
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
      this.currentUserId = 'anonymous'; // Reset user ID
      
      this.emit('channelLeft', channelId);
    } catch (error) {
      console.error('Error leaving channel:', error);
      this.emit('error', error);
    }
  }

  // Get user media (audio/video)
  private async getUserMedia(): Promise<MediaStream> {
    try {
      // Always start with audio only, video will be added when toggled
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false, // We'll add video separately when needed
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

  // Update all peer connections with current local stream
  private updatePeerStreams(): void {
    if (!this.state.localStream) return;
    
    this.state.users.forEach((user) => {
      try {
        // Access the underlying RTCPeerConnection
        const pc = (user.peer as any)._pc;
        if (pc && pc.getSenders) {
          const senders = pc.getSenders();
          
          // Replace video track if it exists
          const videoSender = senders.find((s: RTCRtpSender) => 
            s.track && s.track.kind === 'video'
          );
          
          const localVideoTrack = this.state.localStream.getVideoTracks()[0];
          
          if (videoSender && localVideoTrack) {
            // Replace existing video track
            videoSender.replaceTrack(localVideoTrack);
          } else if (localVideoTrack && !videoSender) {
            // Add new video track
            pc.addTrack(localVideoTrack, this.state.localStream);
          } else if (!localVideoTrack && videoSender) {
            // Remove video track
            pc.removeTrack(videoSender);
          }
        }
      } catch (error) {
        console.warn('Error updating peer stream for user', user.id, ':', error);
        // Fallback: signal a renegotiation
        this.signalRenegotiation(user.id);
      }
    });
  }

  // Signal renegotiation (fallback)
  private signalRenegotiation(userId: string): void {
    const user = this.state.users.get(userId);
    if (user) {
      // Send a custom signal to indicate stream change
      this.sendSignal(userId, { type: 'renegotiate' } as any);
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
    const { from, to, signal } = data;
    const currentUserId = this.getCurrentUserId();
    
    // Only process signals meant for us
    if (to && to !== currentUserId) {
      return;
    }
    
    console.log('Received signal from:', from, 'Type:', signal.type);
    
    let user = this.state.users.get(from);
    
    // If we don't have a peer connection yet, create one (incoming connection)
    if (!user) {
      console.log('Creating peer connection for incoming signal from:', from);
      this.createPeerConnection(from, false); // We are not the initiator
      user = this.state.users.get(from);
    }
    
    if (user) {
      try {
        user.peer.signal(signal);
      } catch (error) {
        console.error('Error processing signal from', from, ':', error);
        // Store signal for later if peer isn't ready
        if (!this.pendingSignals.has(from)) {
          this.pendingSignals.set(from, []);
        }
        this.pendingSignals.get(from)!.push(signal);
      }
    }
  }

  // Handle user joining
  private handleUserJoined(userId: string): void {
    const currentUserId = this.getCurrentUserId();
    console.log('User joined:', userId, 'Current user:', currentUserId);
    
    // Don't create peer connection with ourselves
    if (userId === currentUserId) {
      console.log('Ignoring self join event');
      return;
    }
    
    // Don't create duplicate connections
    if (this.state.users.has(userId)) {
      console.log('Peer connection already exists for:', userId);
      return;
    }

    // Only create outgoing connection if we have the "higher" user ID (deterministic)
    // This prevents duplicate peer connections
    const shouldInitiate = currentUserId > userId;
    console.log('Should initiate connection to', userId, ':', shouldInitiate);
    
    this.createPeerConnection(userId, shouldInitiate);
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
    console.log('Creating peer connection with user:', userId, 'Initiator:', initiator, 'Local stream tracks:', this.state.localStream?.getTracks().length || 0);
    
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
      console.log('Received stream from user:', userId, 'Video tracks:', stream.getVideoTracks().length, 'Audio tracks:', stream.getAudioTracks().length);
      webrtcUser.stream = stream;
      this.emit('userStreamChanged', userId, stream);
    });

    peer.on('connect', () => {
      console.log('Peer connected:', userId);
      
      // Process any pending signals
      const pendingSignals = this.pendingSignals.get(userId);
      if (pendingSignals && pendingSignals.length > 0) {
        console.log('Processing', pendingSignals.length, 'pending signals for', userId);
        pendingSignals.forEach(signal => {
          try {
            peer.signal(signal);
          } catch (error) {
            console.warn('Error processing pending signal:', error);
          }
        });
        this.pendingSignals.delete(userId);
      }
      
      this.emit('userConnected', userId);
    });

    peer.on('close', () => {
      console.log('Peer disconnected:', userId);
      this.state.users.delete(userId);
      this.pendingSignals.delete(userId);
      this.emit('userDisconnected', userId);
    });

    peer.on('error', (error) => {
      console.error('Peer error for', userId, ':', error);
      this.state.users.delete(userId);
      this.pendingSignals.delete(userId);
      this.emit('peerError', userId, error);
    });

    this.emit('userJoined', userId);
  }

  // Send signaling message
  private sendSignal(to: string, signal: SimplePeer.SignalData): void {
    if (!this.signalChannel) return;

    const signalData = {
      from: this.getCurrentUserId(),
      to,
      signal,
      type: signal.type,
    };
    
    console.log('Sending signal to:', to, 'Type:', signal.type);

    this.signalChannel.send({
      type: 'broadcast',
      event: 'webrtc-signal',
      payload: signalData,
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
        const videoStream = await navigator.mediaDevices.getUserMedia({ 
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
          }
        });
        const videoTrack = videoStream.getVideoTracks()[0];
        
        if (this.state.localStream) {
          this.state.localStream.addTrack(videoTrack);
          // Update all existing peer connections with the new video track
          this.updatePeerStreams();
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
          // Update all existing peer connections
          this.updatePeerStreams();
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
          
          // Update all peer connections
          this.updatePeerStreams();
        }
        
        this.state.isScreenSharing = true;
        this.state.isVideoEnabled = true; // Screen sharing counts as video
      } else {
        // Stop screen sharing
        if (this.state.localStream) {
          const videoTracks = this.state.localStream.getVideoTracks();
          videoTracks.forEach(track => {
            track.stop();
            this.state.localStream!.removeTrack(track);
          });
          // Update all peer connections
          this.updatePeerStreams();
        }
        
        this.state.isScreenSharing = false;
        this.state.isVideoEnabled = false;
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
    return this.currentUserId || 'anonymous';
  }
  
  private currentUserId: string = 'anonymous';
  private pendingSignals: Map<string, SimplePeer.SignalData[]> = new Map();

  // Cleanup
  async disconnect(): Promise<void> {
    await this.leaveChannel();
    this.eventCallbacks.clear();
  }
}

// Singleton instance
export const webRTCService = new WebRTCService();
