import SimplePeer from 'simple-peer';
// @ts-ignore
if (typeof global === 'undefined') {
  (window as any).global = window;
}
// @ts-ignore
if (typeof process === 'undefined') {
  (window as any).process = { 
    env: {},
    nextTick: (callback: Function, ...args: any[]) => {
      setTimeout(() => callback(...args), 0);
    }
  };
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

export interface UserState {
  userId: string;
  audio: boolean;
  video: boolean;
  screen: boolean;
  connectionState: 'connecting' | 'connected' | 'disconnected';
}

export interface ChannelState {
  participants: UserState[];
  requesterId: string;
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

  // Replace stream in all peer connections
  private replaceStreamInPeers(newStream: MediaStream): void {
    console.log('Replacing stream in', this.state.users.size, 'peer connections');
    
    this.state.users.forEach((user, userId) => {
      try {
        // Simple approach: use the replaceStream method if available
        if (typeof (user.peer as any).replaceStream === 'function') {
          console.log('Using replaceStream for user:', userId);
          (user.peer as any).replaceStream(newStream);
        } else {
          // Fallback: recreate the peer connection with new stream
          console.log('Recreating peer connection for user:', userId);
          const wasInitiator = (user.peer as any).initiator;
          user.peer.destroy();
          this.state.users.delete(userId);
          
          // Recreate with new stream
          setTimeout(() => {
            this.createPeerConnection(userId, wasInitiator);
          }, 100);
        }
      } catch (error) {
        console.warn('Error replacing stream for user', userId, ':', error);
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
      })
      .on('broadcast', { event: 'state-request' }, (payload) => {
        this.handleStateRequest(payload.payload.requesterId);
      })
      .on('broadcast', { event: 'state-response' }, (payload) => {
        this.handleStateResponse(payload.payload as ChannelState);
      });

    // Subscribe to channel
    await new Promise<void>((resolve, reject) => {
      this.signalChannel!.subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          // First request current state from existing participants
          this.signalChannel!.send({
            type: 'broadcast',
            event: 'state-request',
            payload: { requesterId: userId },
          });
          
          // Small delay then announce joining
          setTimeout(() => {
            this.signalChannel!.send({
              type: 'broadcast',
              event: 'user-joined',
              payload: { userId },
            });
          }, 100);
          
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

    // Always emit userJoined to update UI first
    this.emit('userJoined', userId);

    // Simple deterministic peer creation: higher user ID initiates
    const shouldInitiate = currentUserId > userId;
    console.log('Should initiate connection to', userId, ':', shouldInitiate);
    
    if (shouldInitiate) {
      this.createPeerConnection(userId, true);
    }
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

  // Get screen sharing state for a user
  isUserScreenSharing(userId: string): boolean {
    const user = this.state.users.get(userId);
    return user?.isScreenSharing || false;
  }

  // Handle state request from new joiner
  private handleStateRequest(requesterId: string): void {
    const currentUserId = this.getCurrentUserId();
    
    // Only respond if we're not the requester
    if (requesterId === currentUserId) {
      return;
    }

    console.log('Responding to state request from:', requesterId);
    
    // Build current participants state
    const participants: UserState[] = [
      // Include ourselves
      {
        userId: currentUserId,
        audio: this.state.isAudioEnabled,
        video: this.state.isVideoEnabled,
        screen: this.state.isScreenSharing,
        connectionState: 'connected'
      },
      // Include all connected users
      ...Array.from(this.state.users.entries()).map(([userId, user]) => ({
        userId,
        audio: user.isAudioEnabled,
        video: user.isVideoEnabled,
        screen: user.isScreenSharing,
        connectionState: 'connected' as const
      }))
    ];

    // Send state response
    this.signalChannel?.send({
      type: 'broadcast',
      event: 'state-response',
      payload: {
        participants,
        requesterId
      }
    });
  }

  // Handle state response with current participants
  private handleStateResponse(data: ChannelState): void {
    const currentUserId = this.getCurrentUserId();
    
    // Only process if this response is for us
    if (data.requesterId !== currentUserId) {
      return;
    }

    console.log('Received channel state:', data.participants);
    
    // Update our knowledge of existing participants
    data.participants.forEach(participant => {
      if (participant.userId === currentUserId) {
        return; // Skip ourselves
      }

      // Create user state if we don't have it
      if (!this.state.users.has(participant.userId)) {
        // Don't create peer connection yet, just track the user
        console.log('Learning about existing participant:', participant.userId);
      }

      // Update/create user state
      const existingUser = this.state.users.get(participant.userId);
      if (existingUser) {
        existingUser.isAudioEnabled = participant.audio;
        existingUser.isVideoEnabled = participant.video;
        existingUser.isScreenSharing = participant.screen;
      }

      // Emit to update UI
      this.emit('userJoined', participant.userId);
    });
  }

  // Create peer connection
  private createPeerConnection(userId: string, initiator: boolean): void {
    console.log('=== Creating peer connection ===');
    console.log('User:', userId, 'Initiator:', initiator);
    console.log('Local stream available:', !!this.state.localStream);
    console.log('Local stream tracks:', this.state.localStream?.getTracks().length || 0);
    
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

    peer.on('track', (track, stream) => {
      console.log('Received track from user:', userId, 'Track kind:', track.kind, 'Stream ID:', stream.id);
      // This handles individual track additions/removals
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
        // Enable video - get new stream with video
        const newStream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
          }
        });
        
        // Stop old stream
        if (this.state.localStream) {
          this.state.localStream.getTracks().forEach(track => track.stop());
        }
        
        // Set new stream
        this.state.localStream = newStream;
        this.state.isVideoEnabled = true;
        
        console.log('Video enabled - new stream tracks:', newStream.getTracks().length);
        
        // Update all peer connections with new stream
        this.replaceStreamInPeers(newStream);
        
      } else {
        // Disable video - get audio-only stream
        const newStream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false
        });
        
        // Stop old stream
        if (this.state.localStream) {
          this.state.localStream.getTracks().forEach(track => track.stop());
        }
        
        // Set new stream
        this.state.localStream = newStream;
        this.state.isVideoEnabled = false;
        
        console.log('Video disabled - new stream tracks:', newStream.getTracks().length);
        
        // Update all peer connections with new stream
        this.replaceStreamInPeers(newStream);
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
        // Start screen sharing - get screen + audio stream
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
        
        // Add audio from current stream if available
        if (this.state.localStream) {
          const audioTrack = this.state.localStream.getAudioTracks()[0];
          if (audioTrack) {
            screenStream.addTrack(audioTrack.clone());
          }
        }
        
        // Stop old stream
        if (this.state.localStream) {
          this.state.localStream.getTracks().forEach(track => track.stop());
        }
        
        // Set screen share stream
        this.state.localStream = screenStream;
        this.state.isScreenSharing = true;
        this.state.isVideoEnabled = true;
        
        // Handle screen share ending
        const videoTrack = screenStream.getVideoTracks()[0];
        videoTrack.onended = () => {
          this.toggleScreenShare();
        };
        
        console.log('Screen sharing enabled - stream tracks:', screenStream.getTracks().length);
        
        // Update all peer connections
        this.replaceStreamInPeers(screenStream);
        
      } else {
        // Stop screen sharing - get audio-only stream
        const audioStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false
        });
        
        // Stop old stream
        if (this.state.localStream) {
          this.state.localStream.getTracks().forEach(track => track.stop());
        }
        
        // Set audio-only stream
        this.state.localStream = audioStream;
        this.state.isScreenSharing = false;
        this.state.isVideoEnabled = false;
        
        console.log('Screen sharing disabled - stream tracks:', audioStream.getTracks().length);
        
        // Update all peer connections
        this.replaceStreamInPeers(audioStream);
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
