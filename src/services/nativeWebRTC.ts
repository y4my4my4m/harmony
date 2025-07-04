import { supabase } from '@/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface WebRTCUser {
  id: string;
  connection: RTCPeerConnection;
  stream?: MediaStream;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
}

export interface SignalData {
  from: string;
  to: string;
  type: 'offer' | 'answer' | 'ice-candidate';
  data: any;
}

export interface MediaState {
  userId: string;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
}

export interface StateRequest {
  requesterId: string;
}

export interface StateResponse {
  requesterId: string;
  participants: MediaState[];
}

export class NativeWebRTCService {
  private localStream: MediaStream | null = null;
  private users: Map<string, WebRTCUser> = new Map();
  private signalChannel: RealtimeChannel | null = null;
  private currentChannelId: string | null = null;
  private currentUserId: string = 'anonymous';
  private eventCallbacks: Map<string, Function[]> = new Map();
  
  private isConnected: boolean = false;
  private isAudioEnabled: boolean = true;
  private isVideoEnabled: boolean = false;
  private isScreenSharing: boolean = false;

  constructor() {
    this.setupEventHandlers();
  }

  private setupEventHandlers() {
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

  // Join a voice channel
  async joinChannel(channelId: string, userId: string): Promise<boolean> {
    try {
      console.log('=== Native WebRTC: Joining channel ===');
      console.log('Channel:', channelId, 'User:', userId);

      // Leave current channel first
      if (this.currentChannelId) {
        await this.leaveChannel();
      }

      this.currentChannelId = channelId;
      this.currentUserId = userId;
      
      // Get audio stream first
      await this.getUserMedia();
      console.log('Local stream obtained:', this.localStream?.getTracks().length, 'tracks');
      
      // Setup signaling
      await this.setupSignalingChannel(channelId, userId);
      
      this.isConnected = true;
      this.emit('channelJoined', channelId);
      this.emit('localStreamChanged', this.localStream);
      
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
      console.log('=== Native WebRTC: Leaving channel ===');
      
      // Close all peer connections
      this.users.forEach(user => {
        user.connection.close();
      });
      this.users.clear();

      // Stop local stream
      if (this.localStream) {
        this.localStream.getTracks().forEach(track => track.stop());
        this.localStream = null;
      }

      // Cleanup signaling
      if (this.signalChannel) {
        await this.signalChannel.unsubscribe();
        this.signalChannel = null;
      }

      const channelId = this.currentChannelId;
      this.currentChannelId = null;
      this.isConnected = false;
      
      this.emit('channelLeft', channelId);
    } catch (error) {
      console.error('Error leaving channel:', error);
    }
  }

  // Get user media
  private async getUserMedia(): Promise<MediaStream> {
    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
        },
        video: false, // Start with audio only
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.localStream = stream;
      
      return stream;
    } catch (error) {
      console.error('Error getting user media:', error);
      throw error;
    }
  }

  // Setup signaling channel
  private async setupSignalingChannel(channelId: string, userId: string): Promise<void> {
    this.signalChannel = supabase.channel(`native-voice-${channelId}`, {
      config: {
        broadcast: { self: false },
      },
    });

    // Listen for signaling messages
    this.signalChannel
      .on('broadcast', { event: 'signal' }, (payload) => {
        this.handleSignal(payload.payload as SignalData);
      })
      .on('broadcast', { event: 'user-joined' }, (payload) => {
        this.handleUserJoined(payload.payload.userId);
      })
      .on('broadcast', { event: 'user-left' }, (payload) => {
        this.handleUserLeft(payload.payload.userId);
      })
      .on('broadcast', { event: 'state-request' }, (payload) => {
        this.handleStateRequest(payload.payload as StateRequest);
      })
      .on('broadcast', { event: 'state-response' }, (payload) => {
        this.handleStateResponse(payload.payload as StateResponse);
      })
      .on('broadcast', { event: 'media-toggle' }, (payload) => {
        this.handleMediaToggle(payload.payload as MediaState);
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

  // Handle user joining
  private async handleUserJoined(userId: string): Promise<void> {
    console.log('=== User joined:', userId, '===');
    
    if (userId === this.currentUserId) {
      console.log('Ignoring self join');
      return;
    }

    if (this.users.has(userId)) {
      console.log('User already exists');
      return;
    }

    this.emit('userJoined', userId);

    // Create peer connection
    await this.createPeerConnection(userId);
  }

  // Handle user leaving
  private handleUserLeft(userId: string): void {
    console.log('User left:', userId);
    
    const user = this.users.get(userId);
    if (user) {
      user.connection.close();
      this.users.delete(userId);
      this.emit('userLeft', userId);
    }
  }

  // Handle state request from new joiner
  private handleStateRequest(request: StateRequest): void {
    const { requesterId } = request;
    
    // Don't respond to our own request
    if (requesterId === this.currentUserId) {
      return;
    }

    console.log('Responding to state request from:', requesterId);
    
    // Build current state
    const participants: MediaState[] = [
      // Include ourselves
      {
        userId: this.currentUserId,
        isAudioEnabled: this.isAudioEnabled,
        isVideoEnabled: this.isVideoEnabled,
        isScreenSharing: this.isScreenSharing,
      },
      // Include all connected users
      ...Array.from(this.users.entries()).map(([userId, user]) => ({
        userId,
        isAudioEnabled: user.isAudioEnabled,
        isVideoEnabled: user.isVideoEnabled,
        isScreenSharing: user.isScreenSharing,
      }))
    ];

    // Send state response
    this.signalChannel?.send({
      type: 'broadcast',
      event: 'state-response',
      payload: {
        requesterId,
        participants,
      },
    });
  }

  // Handle state response with current participants
  private handleStateResponse(response: StateResponse): void {
    const { requesterId, participants } = response;
    
    // Only process if this response is for us
    if (requesterId !== this.currentUserId) {
      return;
    }

    console.log('Received channel state:', participants);
    
    // Update our knowledge of existing participants
    participants.forEach(participant => {
      if (participant.userId === this.currentUserId) {
        return; // Skip ourselves
      }

      // Update user state
      const existingUser = this.users.get(participant.userId);
      if (existingUser) {
        existingUser.isAudioEnabled = participant.isAudioEnabled;
        existingUser.isVideoEnabled = participant.isVideoEnabled;
        existingUser.isScreenSharing = participant.isScreenSharing;
      }

      // Emit to update UI
      this.emit('userJoined', participant.userId);
    });
  }

  // Handle media toggle events
  private handleMediaToggle(state: MediaState): void {
    const { userId, isAudioEnabled, isVideoEnabled, isScreenSharing } = state;
    
    if (userId === this.currentUserId) {
      return; // Ignore our own media toggles
    }

    console.log('User media toggled:', userId, 'Video:', isVideoEnabled, 'Screen:', isScreenSharing);
    
    const user = this.users.get(userId);
    if (user) {
      user.isAudioEnabled = isAudioEnabled;
      user.isVideoEnabled = isVideoEnabled;
      user.isScreenSharing = isScreenSharing;
      
      // Emit media change event
      this.emit('userMediaToggled', state);
    }
  }

  // Create peer connection
  private async createPeerConnection(userId: string): Promise<void> {
    console.log('=== Creating peer connection with:', userId, '===');

    const configuration: RTCConfiguration = {
      iceServers: [
        // Google STUN servers
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        
        // OpenRelay TURN servers (free)
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        {
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        
        // Additional reliable TURN servers
        {
          urls: 'turn:relay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        {
          urls: 'turn:relay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        {
          urls: 'turn:relay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
      ],
      iceCandidatePoolSize: 10,
      iceTransportPolicy: 'all', // Use all available transport methods
      bundlePolicy: 'max-bundle', // Bundle all media on single connection
      rtcpMuxPolicy: 'require', // Multiplex RTP and RTCP on same port
    };

    const pc = new RTCPeerConnection(configuration);
    
    const user: WebRTCUser = {
      id: userId,
      connection: pc,
      isAudioEnabled: true,
      isVideoEnabled: false,
      isScreenSharing: false,
    };

    this.users.set(userId, user);

    // Add local stream to peer connection
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        console.log('Adding track to peer connection:', track.kind);
        pc.addTrack(track, this.localStream!);
      });
    }

    // Handle incoming streams
    pc.ontrack = (event) => {
      console.log('=== Received track from', userId, '===');
      console.log('Track kind:', event.track.kind);
      console.log('Streams:', event.streams.length);
      
      if (event.streams.length > 0) {
        const stream = event.streams[0];
        user.stream = stream;
        console.log('Stream tracks:', stream.getTracks().length);
        this.emit('userStreamChanged', userId, stream);
      }
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('Sending ICE candidate to:', userId);
        this.sendSignal(userId, 'ice-candidate', event.candidate);
      }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      console.log('Connection state changed for', userId, ':', pc.connectionState);
      
      if (pc.connectionState === 'connected') {
        this.emit('userConnected', userId);
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this.emit('userDisconnected', userId);
      }
    };

    // Handle ICE connection state changes
    pc.oniceconnectionstatechange = () => {
      console.log('ICE connection state for', userId, ':', pc.iceConnectionState);
      
      if (pc.iceConnectionState === 'failed') {
        console.warn('ICE connection failed for user:', userId);
        console.warn('Consider using a TURN server for NAT traversal');
      } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        console.log('ICE connection established for user:', userId);
      }
    };

    // Handle ICE gathering state changes
    pc.onicegatheringstatechange = () => {
      console.log('ICE gathering state for', userId, ':', pc.iceGatheringState);
    };

    // Create and send offer
    try {
      console.log('Creating offer for:', userId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal(userId, 'offer', offer);
    } catch (error) {
      console.error('Error creating offer for', userId, ':', error);
    }
  }

  // Handle signaling messages
  private async handleSignal(data: SignalData): Promise<void> {
    const { from, to, type, data: signalData } = data;
    
    if (to !== this.currentUserId) {
      return; // Not for us
    }

    console.log('=== Received signal ===');
    console.log('From:', from, 'Type:', type);

    let user = this.users.get(from);
    
    // If we don't have a peer connection, create one
    if (!user) {
      console.log('Creating peer connection for incoming signal from:', from);
      await this.createPeerConnection(from);
      user = this.users.get(from);
    }

    if (!user) {
      console.error('Failed to create peer connection for:', from);
      return;
    }

    const pc = user.connection;

    try {
      switch (type) {
        case 'offer':
          console.log('Processing offer from:', from);
          await pc.setRemoteDescription(signalData);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.sendSignal(from, 'answer', answer);
          break;

        case 'answer':
          console.log('Processing answer from:', from);
          await pc.setRemoteDescription(signalData);
          break;

        case 'ice-candidate':
          console.log('Adding ICE candidate from:', from);
          await pc.addIceCandidate(signalData);
          break;
      }
    } catch (error) {
      console.error('Error processing signal from', from, ':', error);
    }
  }

  // Send signaling message
  private sendSignal(to: string, type: string, data: any): void {
    if (!this.signalChannel) return;

    const signalData: SignalData = {
      from: this.currentUserId,
      to,
      type: type as any,
      data,
    };

    console.log('Sending signal to:', to, 'Type:', type);

    this.signalChannel.send({
      type: 'broadcast',
      event: 'signal',
      payload: signalData,
    });
  }

  // Media controls
  async toggleVideo(): Promise<boolean> {
    try {
      if (!this.isVideoEnabled) {
        // Add video track
        const videoStream = await navigator.mediaDevices.getUserMedia({ 
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 },
          },
          audio: false
        });
        
        const videoTrack = videoStream.getVideoTracks()[0];
        
        if (this.localStream && videoTrack) {
          this.localStream.addTrack(videoTrack);
          
          // Add track to all peer connections
          this.users.forEach((user) => {
            if (this.localStream) {
              user.connection.addTrack(videoTrack, this.localStream);
            }
          });
          
          this.isVideoEnabled = true;
          console.log('Video enabled');
        }
      } else {
        // Remove video tracks
        if (this.localStream) {
          const videoTracks = this.localStream.getVideoTracks();
          videoTracks.forEach(track => {
            track.stop();
            this.localStream!.removeTrack(track);
            
            // Remove from peer connections
            this.users.forEach((user) => {
              const senders = user.connection.getSenders();
              const videoSender = senders.find(s => s.track === track);
              if (videoSender) {
                user.connection.removeTrack(videoSender);
              }
            });
          });
          
          this.isVideoEnabled = false;
          console.log('Video disabled');
        }
      }
      
      // Broadcast media state change to other participants
      this.broadcastMediaToggle();
      
      this.emit('videoToggled', this.isVideoEnabled);
      this.emit('localStreamChanged', this.localStream);
      
      return this.isVideoEnabled;
    } catch (error) {
      console.error('Error toggling video:', error);
      return false;
    }
  }

  async toggleScreenShare(): Promise<boolean> {
    try {
      if (!this.isScreenSharing) {
        // Start screen sharing
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        });
        
        const screenTrack = screenStream.getVideoTracks()[0];
        
        if (this.localStream && screenTrack) {
          // Remove existing video tracks
          const videoTracks = this.localStream.getVideoTracks();
          videoTracks.forEach(track => {
            track.stop();
            this.localStream!.removeTrack(track);
          });
          
          // Add screen track
          this.localStream.addTrack(screenTrack);
          
          // Replace video track in peer connections
          this.users.forEach((user) => {
            const senders = user.connection.getSenders();
            const videoSender = senders.find(s => s.track && s.track.kind === 'video');
            
            if (videoSender) {
              videoSender.replaceTrack(screenTrack);
            } else if (this.localStream) {
              user.connection.addTrack(screenTrack, this.localStream);
            }
          });
          
          // Handle screen share ending
          screenTrack.onended = () => {
            this.toggleScreenShare();
          };
          
          this.isScreenSharing = true;
          this.isVideoEnabled = true;
          console.log('Screen sharing enabled');
        }
      } else {
        // Stop screen sharing
        if (this.localStream) {
          const videoTracks = this.localStream.getVideoTracks();
          videoTracks.forEach(track => {
            track.stop();
            this.localStream!.removeTrack(track);
            
            // Remove from peer connections
            this.users.forEach((user) => {
              const senders = user.connection.getSenders();
              const videoSender = senders.find(s => s.track === track);
              if (videoSender) {
                user.connection.removeTrack(videoSender);
              }
            });
          });
          
          this.isScreenSharing = false;
          this.isVideoEnabled = false;
          console.log('Screen sharing disabled');
        }
      }
      
      // Broadcast media state change to other participants
      this.broadcastMediaToggle();
      
      this.emit('screenShareToggled', this.isScreenSharing);
      this.emit('localStreamChanged', this.localStream);
      
      return this.isScreenSharing;
    } catch (error) {
      console.error('Error toggling screen share:', error);
      return false;
    }
  }

  // Broadcast media toggle to other participants
  private broadcastMediaToggle(): void {
    if (!this.signalChannel) return;

    const mediaState: MediaState = {
      userId: this.currentUserId,
      isAudioEnabled: this.isAudioEnabled,
      isVideoEnabled: this.isVideoEnabled,
      isScreenSharing: this.isScreenSharing,
    };

    console.log('Broadcasting media state:', mediaState);

    this.signalChannel.send({
      type: 'broadcast',
      event: 'media-toggle',
      payload: mediaState,
    });
  }

  // Audio toggle (mute/unmute)
  toggleAudio(): boolean {
    this.isAudioEnabled = !this.isAudioEnabled;
    
    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = this.isAudioEnabled;
        console.log('Audio track enabled:', audioTrack.enabled);
      }
    }
    
    // Broadcast media state change to other participants
    this.broadcastMediaToggle();
    
    this.emit('audioToggled', this.isAudioEnabled);
    return this.isAudioEnabled;
  }

  // Mute controls
  setMuted(muted: boolean): void {
    console.log('Setting muted:', muted);
    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !muted;
        console.log('Audio track enabled:', audioTrack.enabled);
      }
    }
    this.emit('muteToggled', muted);
  }

  setDeafened(deafened: boolean): void {
    console.log('Setting deafened:', deafened);
    this.users.forEach(user => {
      if (user.stream) {
        user.stream.getAudioTracks().forEach(track => {
          track.enabled = !deafened;
        });
      }
    });
    this.emit('deafenToggled', deafened);
  }

  // Getters
  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getUserStream(userId: string): MediaStream | undefined {
    return this.users.get(userId)?.stream;
  }

  getConnectedUsers(): string[] {
    return Array.from(this.users.keys());
  }

  getState() {
    return {
      isConnected: this.isConnected,
      isAudioEnabled: this.isAudioEnabled,
      isVideoEnabled: this.isVideoEnabled,
      isScreenSharing: this.isScreenSharing,
      localStream: this.localStream,
      users: this.users,
    };
  }

  async disconnect(): Promise<void> {
    await this.leaveChannel();
    this.eventCallbacks.clear();
  }
}

// Export singleton
export const nativeWebRTCService = new NativeWebRTCService();