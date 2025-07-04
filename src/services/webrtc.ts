// Native WebRTC implementation without SimplePeer for better control and Discord-like behavior
import { supabase } from '@/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface WebRTCUser {
  id: string;
  peer: RTCPeerConnection;
  stream?: MediaStream;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
  audioLevel: number;
  connectionState: 'connecting' | 'connected' | 'disconnected' | 'failed';
}

export interface WebRTCState {
  localStream: MediaStream | null;
  users: Map<string, WebRTCUser>;
  isConnected: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  currentChannelId: string | null;
  connectionQuality: 'excellent' | 'good' | 'poor' | 'disconnected';
  audioContext: AudioContext | null;
}

export interface SignalData {
  from: string;
  to: string;
  data: RTCSessionDescriptionInit | RTCIceCandidateInit;
  type: 'offer' | 'answer' | 'ice-candidate';
}

export interface UserStateUpdate {
  userId: string;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
  timestamp: number;
}

export interface UserState {
  userId: string;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
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
    isMuted: false,
    isDeafened: false,
    currentChannelId: null,
    connectionQuality: 'disconnected',
    audioContext: null,
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

  // Join voice channel with robust error handling
  async joinChannel(channelId: string, userId: string): Promise<boolean> {
    try {
      // Leave current channel first
      if (this.state.isConnected) {
        await this.leaveChannel();
      }

      this.state.currentChannelId = channelId;
      this.currentUserId = userId;
      
      console.log('🎤 Joining voice channel:', channelId);
      
      // Initialize audio context
      await this.initializeAudioContext();
      
      // Get audio stream - critical for voice chat
      await this.getUserMedia();
      
      if (!this.state.localStream || this.state.localStream.getAudioTracks().length === 0) {
        throw new Error('Failed to obtain audio stream - microphone access required for voice chat');
      }
      
      // Setup signaling channel
      await this.setupSignalingChannel(channelId, userId);
      
      this.state.isConnected = true;
      this.state.connectionQuality = 'good';
      
      this.emit('channelJoined', channelId);
      this.emit('connectionStateChanged', 'connected');
      
      return true;
    } catch (error) {
      console.error('❌ Failed to join voice channel:', error);
      this.cleanup();
      this.emit('error', error);
      return false;
    }
  }

  // Leave voice channel with proper cleanup
  async leaveChannel(): Promise<void> {
    try {
      console.log('👋 Leaving voice channel');
      
      // Announce leaving
      if (this.signalChannel) {
        this.signalChannel.send({
          type: 'broadcast',
          event: 'user-left',
          payload: { userId: this.currentUserId },
        });
      }
      
      this.cleanup();
      
      const channelId = this.state.currentChannelId;
      this.emit('channelLeft', channelId);
      this.emit('connectionStateChanged', 'disconnected');
      
    } catch (error) {
      console.error('❌ Error leaving channel:', error);
      this.emit('error', error);
    }
  }

  // Cleanup all resources
  private cleanup(): void {
    // Stop audio monitoring
    if (this.audioLevelCheckInterval) {
      clearInterval(this.audioLevelCheckInterval);
      this.audioLevelCheckInterval = null;
    }
    
    // Close all peer connections
    this.state.users.forEach(user => {
      try {
        user.peer.close();
      } catch (error) {
        console.warn('Error closing peer connection:', error);
      }
    });
    this.state.users.clear();

    // Stop local stream
    if (this.state.localStream) {
      this.state.localStream.getTracks().forEach(track => {
        track.stop();
      });
      this.state.localStream = null;
    }

    // Close audio context
    if (this.state.audioContext) {
      this.state.audioContext.close();
      this.state.audioContext = null;
    }

    // Cleanup signaling channel
    if (this.signalChannel) {
      this.signalChannel.unsubscribe();
      this.signalChannel = null;
    }

    // Reset state
    this.state.currentChannelId = null;
    this.state.isConnected = false;
    this.state.connectionQuality = 'disconnected';
    this.state.isMuted = false;
    this.state.isDeafened = false;
    this.currentUserId = 'anonymous';
  }

  // Initialize audio context for advanced audio processing
  private async initializeAudioContext(): Promise<void> {
    try {
      this.state.audioContext = new AudioContext();
      console.log('✅ Audio context initialized');
    } catch (error) {
      console.error('❌ Failed to initialize audio context:', error);
    }
  }

  // Get high-quality audio stream for voice chat
  private async getUserMedia(): Promise<MediaStream> {
    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1,
          latency: 0
        },
        video: false
      };

      console.log('🎤 Requesting audio stream...');
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error('No audio tracks available - microphone access required');
      }
      
      console.log('✅ Audio stream obtained:', audioTracks.length, 'tracks');
      this.state.localStream = stream;
      
      // Setup audio monitoring
      this.setupAudioLevelMonitoring();
      
      this.emit('localStreamChanged', stream);
      return stream;
    } catch (error) {
      console.error('❌ Error getting audio stream:', error);
      throw error;
    }
  }

  // Setup audio level monitoring and speaking detection
  private setupAudioLevelMonitoring(): void {
    if (!this.state.audioContext || !this.state.localStream) return;

    try {
      const source = this.state.audioContext.createMediaStreamSource(this.state.localStream);
      const analyser = this.state.audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      
      source.connect(analyser);
      
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      
      this.audioLevelCheckInterval = window.setInterval(() => {
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
        const audioLevel = Math.round(average);
        
        // Speaking detection
        const isSpeaking = audioLevel > this.speakingThreshold && !this.state.isMuted;
        
        this.emit('audioLevel', audioLevel);
        this.emit('speaking', isSpeaking);
      }, 100);
      
    } catch (error) {
      console.error('Failed to setup audio monitoring:', error);
    }
  }

  // Audio-only implementation - video methods removed for voice chat

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
      .on('broadcast', { event: 'user-state' }, (payload) => {
        this.handleUserStateUpdate(payload.payload as UserStateUpdate);
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
  private async handleSignalingMessage(data: SignalData): Promise<void> {
    const { from, to, data: signalData, type } = data;
    const currentUserId = this.getCurrentUserId();
    
    // Only process signals meant for us
    if (to && to !== currentUserId) {
      return;
    }
    
    console.log('📥 Received signal from:', from, 'Type:', type);
    
    let user = this.state.users.get(from);
    
    // If we don't have a peer connection yet, create one (incoming connection)
    if (!user) {
      console.log('🔗 Creating peer connection for incoming signal from:', from);
      user = this.createPeerConnection(from, false); // We are not the initiator
    }
    
    if (user) {
      try {
        const peerConnection = user.peer;
        
        switch (type) {
          case 'offer':
            await peerConnection.setRemoteDescription(signalData as RTCSessionDescriptionInit);
            await this.createAndSendAnswer(peerConnection, from);
            break;
            
          case 'answer':
            await peerConnection.setRemoteDescription(signalData as RTCSessionDescriptionInit);
            break;
            
          case 'ice-candidate':
            const candidate = new RTCIceCandidate(signalData as RTCIceCandidateInit);
            await peerConnection.addIceCandidate(candidate);
            break;
            
          default:
            console.warn('Unknown signal type:', type);
        }
      } catch (error) {
        console.error('❌ Error processing signal from', from, ':', error);
        this.emit('peerError', from, error);
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
    const shouldInitiate = currentUserId.localeCompare(userId) > 0;
    console.log('Should initiate connection to', userId, ':', shouldInitiate);
    console.log('Current user ID:', currentUserId);
    console.log('Other user ID:', userId);
    console.log('Comparison result:', currentUserId.localeCompare(userId));
    
    // Only create peer connection if we should initiate
    if (shouldInitiate) {
      console.log('Creating outgoing peer connection as initiator');
      this.createPeerConnection(userId, true);
    } else {
      console.log('Not initiating - waiting for incoming connection from', userId);
    }
  }

  // Handle user leaving
  private handleUserLeft(userId: string): void {
    const user = this.state.users.get(userId);
    if (user) {
      user.peer.close();
      this.state.users.delete(userId);
      this.emit('userLeft', userId);
    }
  }

  // Handle user state updates
  private handleUserStateUpdate(data: UserStateUpdate): void {
    const user = this.state.users.get(data.userId);
    if (user) {
      user.isMuted = data.isMuted;
      user.isDeafened = data.isDeafened;
      user.isSpeaking = data.isSpeaking;
      this.emit('userStateChanged', data);
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

  // Create native WebRTC peer connection
  private createPeerConnection(userId: string, initiator: boolean): WebRTCUser {
    console.log('🔗 Creating peer connection:', { userId, initiator });
    
    if (!this.state.localStream) {
      throw new Error('No local stream available for peer connection');
    }

    const peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
      ],
    });

    const webrtcUser: WebRTCUser = {
      id: userId,
      peer: peerConnection,
      isMuted: false,
      isDeafened: false,
      isSpeaking: false,
      audioLevel: 0,
      connectionState: 'connecting',
    };

    this.state.users.set(userId, webrtcUser);

    // Add local stream tracks to peer connection
    this.state.localStream.getTracks().forEach(track => {
      console.log('➕ Adding track to peer connection:', track.kind, 'for user:', userId);
      peerConnection.addTrack(track, this.state.localStream!);
    });

    // Setup peer connection event handlers
    this.setupPeerEventHandlers(peerConnection, webrtcUser, initiator);

    return webrtcUser;
  }

  // Setup comprehensive peer event handlers
  private setupPeerEventHandlers(peerConnection: RTCPeerConnection, webrtcUser: WebRTCUser, initiator: boolean): void {
    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('🧊 Sending ICE candidate to', webrtcUser.id);
        this.sendSignal(webrtcUser.id, {
          type: 'ice-candidate',
          data: event.candidate.toJSON()
        });
      }
    };

    // Handle incoming stream
    peerConnection.ontrack = (event) => {
      console.log('🎵 Received track from:', webrtcUser.id, 'Kind:', event.track.kind);
      const [remoteStream] = event.streams;
      if (remoteStream) {
        webrtcUser.stream = remoteStream;
        console.log('📡 Remote stream set for user:', webrtcUser.id, 'Audio tracks:', remoteStream.getAudioTracks().length);
        this.setupRemoteAudioProcessing(webrtcUser, remoteStream);
        this.emit('userStreamChanged', webrtcUser.id, remoteStream);
      }
    };

    // Handle connection state changes
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      console.log('🔄 Connection state changed for', webrtcUser.id, ':', state);
      
      switch (state) {
        case 'connected':
          webrtcUser.connectionState = 'connected';
          this.emit('userConnected', webrtcUser.id);
          break;
        case 'disconnected':
        case 'failed':
          webrtcUser.connectionState = 'disconnected';
          this.emit('userDisconnected', webrtcUser.id);
          break;
      }
      
      this.updateConnectionQuality();
    };

    // Handle ICE connection state changes
    peerConnection.oniceconnectionstatechange = () => {
      console.log('🧊 ICE connection state for', webrtcUser.id, ':', peerConnection.iceConnectionState);
      
      if (peerConnection.iceConnectionState === 'failed') {
        console.error('❌ ICE connection failed for', webrtcUser.id);
        this.emit('peerError', webrtcUser.id, new Error('ICE connection failed'));
      }
    };

    // If we're the initiator, create and send offer
    if (initiator) {
      this.createAndSendOffer(peerConnection, webrtcUser.id);
    }
  }

  // Create and send offer
  private async createAndSendOffer(peerConnection: RTCPeerConnection, userId: string): Promise<void> {
    try {
      console.log('📝 Creating offer for', userId);
      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      
      await peerConnection.setLocalDescription(offer);
      
      console.log('📤 Sending offer to', userId);
      this.sendSignal(userId, {
        type: 'offer',
        data: offer
      });
    } catch (error) {
      console.error('❌ Error creating offer for', userId, ':', error);
    }
  }

  // Create and send answer
  private async createAndSendAnswer(peerConnection: RTCPeerConnection, userId: string): Promise<void> {
    try {
      console.log('📝 Creating answer for', userId);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      
      console.log('📤 Sending answer to', userId);
      this.sendSignal(userId, {
        type: 'answer',
        data: answer
      });
    } catch (error) {
      console.error('❌ Error creating answer for', userId, ':', error);
    }
  }

  // Setup remote audio processing and speaking detection
  private setupRemoteAudioProcessing(webrtcUser: WebRTCUser, stream: MediaStream): void {
    if (!this.state.audioContext || !stream.getAudioTracks().length) {
      return;
    }

    try {
      const source = this.state.audioContext.createMediaStreamSource(stream);
      const analyser = this.state.audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      
      source.connect(analyser);
      
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      
      const checkAudioLevel = () => {
        if (webrtcUser.connectionState === 'disconnected') return;
        
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
        const audioLevel = Math.round(average);
        
        webrtcUser.audioLevel = audioLevel;
        
        // Speaking detection
        const isSpeaking = audioLevel > this.speakingThreshold && !webrtcUser.isMuted;
        if (isSpeaking !== webrtcUser.isSpeaking) {
          webrtcUser.isSpeaking = isSpeaking;
          this.emit('userSpeakingChanged', webrtcUser.id, isSpeaking);
        }
        
        requestAnimationFrame(checkAudioLevel);
      };
      
      checkAudioLevel();
    } catch (error) {
      console.error('Failed to setup remote audio processing:', error);
    }
  }

  // Send signaling message
  private sendSignal(to: string, signalData: { type: string; data: any }): void {
    if (!this.signalChannel) return;

    const message: SignalData = {
      from: this.getCurrentUserId(),
      to,
      data: signalData.data,
      type: signalData.type as any,
    };
    
    console.log('📤 Sending signal to:', to, 'Type:', signalData.type);

    this.signalChannel.send({
      type: 'broadcast',
      event: 'webrtc-signal',
      payload: message,
    });
  }

  // Unified mute control (Discord-style)
  async toggleMute(): Promise<boolean> {
    if (!this.state.localStream) {
      console.error('❌ No local stream available to toggle mute');
      return false;
    }

    const audioTrack = this.state.localStream.getAudioTracks()[0];
    if (audioTrack) {
      this.state.isMuted = !this.state.isMuted;
      audioTrack.enabled = !this.state.isMuted;
      
      console.log('🎤 Mute toggled:', this.state.isMuted);
      
      this.broadcastUserState();
      this.emit('muteToggled', this.state.isMuted);
      
      return this.state.isMuted;
    } else {
      console.error('❌ No audio track found in local stream');
      return false;
    }
  }

  // Unified deafen control (Discord-style)
  async toggleDeafen(): Promise<boolean> {
    this.state.isDeafened = !this.state.isDeafened;
    
    // Discord behavior: deafening also mutes
    if (this.state.isDeafened && !this.state.isMuted) {
      await this.toggleMute();
    }
    
    // Mute/unmute all remote audio
    this.state.users.forEach(user => {
      if (user.stream) {
        user.stream.getAudioTracks().forEach(track => {
          track.enabled = !this.state.isDeafened;
        });
      }
    });
    
    console.log('🔇 Deafen toggled:', this.state.isDeafened);
    
    this.broadcastUserState();
    this.emit('deafenToggled', this.state.isDeafened);
    
    return this.state.isDeafened;
  }

  // Video not supported in voice-only implementation
  async toggleVideo(): Promise<boolean> {
    console.log('Video not supported in voice-only implementation');
    return false;
  }

  async toggleScreenShare(): Promise<boolean> {
    console.log('Screen sharing not supported in voice-only implementation');
    return false;
  }

  // Broadcast user state to other users
  private broadcastUserState(): void {
    if (!this.signalChannel) return;

    const update: UserStateUpdate = {
      userId: this.getCurrentUserId(),
      isMuted: this.state.isMuted,
      isDeafened: this.state.isDeafened,
      isSpeaking: false, // Will be updated by audio monitoring
      timestamp: Date.now(),
    };

    this.signalChannel.send({
      type: 'broadcast',
      event: 'user-state',
      payload: update,
    });
  }

  // Legacy mute/deafen setters (for compatibility)
  setMuted(muted: boolean): void {
    if (muted !== this.state.isMuted) {
      this.toggleMute();
    }
  }

  setDeafened(deafened: boolean): void {
    if (deafened !== this.state.isDeafened) {
      this.toggleDeafen();
    }
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
  private pendingSignals: Map<string, RTCSessionDescriptionInit[]> = new Map();
  private speakingThreshold = 30;
  private audioLevelCheckInterval: number | null = null;

  // Update connection quality based on peer states
  private updateConnectionQuality(): void {
    const connectedUsers = Array.from(this.state.users.values()).filter(
      user => user.connectionState === 'connected'
    );
    
    if (connectedUsers.length === 0) {
      this.state.connectionQuality = 'disconnected';
    } else if (connectedUsers.length === this.state.users.size) {
      this.state.connectionQuality = 'excellent';
    } else {
      this.state.connectionQuality = 'good';
    }
    
    this.emit('connectionQualityChanged', this.state.connectionQuality);
  }

  // Getters for external access
  getUserStream(userId: string): MediaStream | undefined {
    return this.state.users.get(userId)?.stream;
  }

  getLocalStream(): MediaStream | null {
    return this.state.localStream;
  }

  getConnectedUsers(): string[] {
    return Array.from(this.state.users.keys());
  }

  getUserAudioLevel(userId: string): number {
    return this.state.users.get(userId)?.audioLevel || 0;
  }

  isUserSpeaking(userId: string): boolean {
    return this.state.users.get(userId)?.isSpeaking || false;
  }

  isUserMuted(userId: string): boolean {
    return this.state.users.get(userId)?.isMuted || false;
  }

  isUserDeafened(userId: string): boolean {
    return this.state.users.get(userId)?.isDeafened || false;
  }

  // Volume controls (simplified for now)
  setInputVolume(volume: number): void {
    console.log('Setting input volume:', volume);
    // Implementation would involve audio processing
  }

  setOutputVolume(volume: number): void {
    console.log('Setting output volume:', volume);
    // Implementation would involve audio processing
  }

  // Legacy compatibility methods (will be removed)
  async toggleVideo(): Promise<boolean> {
    console.log('Video not supported in voice-only implementation');
    return false;
  }

  async toggleScreenShare(): Promise<boolean> {
    console.log('Screen sharing not supported in voice-only implementation');
    return false;
  }

  // Legacy mute/deafen setters (for compatibility)
  setMuted(muted: boolean): void {
    if (muted !== this.state.isMuted) {
      this.toggleMute();
    }
  }

  setDeafened(deafened: boolean): void {
    if (deafened !== this.state.isDeafened) {
      this.toggleDeafen();
    }
  }

  // Cleanup
  async disconnect(): Promise<void> {
    await this.leaveChannel();
    this.eventCallbacks.clear();
  }
}

// Singleton instance
export const webRTCService = new WebRTCService();
