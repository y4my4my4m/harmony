import { defineStore } from 'pinia';
import { webRTCService } from '@/services/webrtc';
import type { Profile } from '@/types';
import { useAuthStore } from '@/stores/auth';
import { useServerUsersStore } from '@/stores/useServerUsers';

interface ProfilePosition {
  x: number;
  y: number;
}

interface VoiceChannelState {
  profiles: Profile[];
  positions: Record<string, ProfilePosition>;
  currentChannelId: string | null;
  currentServerId: string | null;
  currentUserId: string | null;
  isConnected: boolean;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  connectedUsers: string[];
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  audioLevels: Map<string, number>;
  connectionStates: Map<string, 'connecting' | 'connected' | 'disconnected'>;
}

export const useVoiceChannelStore = defineStore('voiceChannel', {
  state: (): VoiceChannelState => ({
    profiles: [],
    positions: {},
    currentChannelId: null,
    currentServerId: null,
    currentUserId: null,
    isConnected: false,
    isAudioEnabled: true,
    isVideoEnabled: false,
    isScreenSharing: false,
    isMuted: false,
    isDeafened: false,
    connectedUsers: [],
    localStream: null,
    remoteStreams: new Map(),
    audioLevels: new Map(),
    connectionStates: new Map(),
  }),
  
  getters: {
    isUserConnected: (state) => (userId: string) => {
      return state.connectedUsers.includes(userId);
    },
    
    getUserStream: (state) => (userId: string) => {
      // Return local stream for current user, remote stream for others
      if (userId === state.currentUserId) {
        return state.localStream;
      }
      return state.remoteStreams.get(userId);
    },
    
    getAllParticipants: (state) => {
      // Include current user in participants list
      const participants = [...state.connectedUsers];
      if (state.currentUserId && !participants.includes(state.currentUserId)) {
        participants.unshift(state.currentUserId); // Add self at the beginning
      }
      return participants;
    },
    
    getConnectionState: (state) => (userId: string) => {
      return state.connectionStates.get(userId) || 'disconnected';
    },
    
    getAudioLevel: (state) => (userId: string) => {
      return state.audioLevels.get(userId) || 0;
    },
  },
  
  actions: {
    // Position management
    setProfilePosition(profileId: string, position: ProfilePosition) {
      this.positions[profileId] = position;
    },
    
    // WebRTC connection management
    async joinVoiceChannel(channelId: string, serverId: string) {
      try {
        const authStore = useAuthStore();
        const serverUsersStore = useServerUsersStore();
        
        if (!authStore.session?.user) {
          throw new Error('User not authenticated');
        }
        
        const userId = authStore.session.user.id;
        this.currentUserId = userId; // Store current user ID
        
        // Join through server users store for presence
        const success = await serverUsersStore.joinVoiceChannel(serverId, channelId, userId);
        if (!success) {
          throw new Error('Failed to join voice channel');
        }
        
        // Connect WebRTC
        const webrtcSuccess = await webRTCService.joinChannel(channelId, userId);
        if (!webrtcSuccess) {
          // Rollback server join
          await serverUsersStore.leaveVoiceChannel(serverId, channelId, userId);
          throw new Error('Failed to connect WebRTC');
        }
        
        this.currentChannelId = channelId;
        this.currentServerId = serverId;
        this.isConnected = true;
        
        // Setup WebRTC event listeners
        this.setupWebRTCListeners();
        
        // Apply any preemptive mute/deafen state
        if (this.isMuted) {
          console.log('Applying preemptive mute state');
          await webRTCService.toggleMute();
        }
        if (this.isDeafened) {
          console.log('Applying preemptive deafen state');
          await webRTCService.toggleDeafen();
        }
        
        return true;
      } catch (error) {
        console.error('Error joining voice channel:', error);
        return false;
      }
    },
    
    async leaveVoiceChannel() {
      try {
        const authStore = useAuthStore();
        const serverUsersStore = useServerUsersStore();
        
        if (!authStore.session?.user || !this.currentChannelId) {
          return true;
        }
        
        const userId = authStore.session.user.id;
        
        // Leave WebRTC first
        await webRTCService.leaveChannel();
        
        // Leave through server users store
        // Use stored server ID
        if (this.currentServerId) {
          await serverUsersStore.leaveVoiceChannel(this.currentServerId, this.currentChannelId, userId);
        }
        
        this.resetState();
        
        return true;
      } catch (error) {
        console.error('Error leaving voice channel:', error);
        return false;
      }
    },
    
    // Media controls
    async toggleAudio() {
      // Toggle mute (unified behavior)
      const isMuted = await webRTCService.toggleMute();
      this.isAudioEnabled = !isMuted;
      this.isMuted = isMuted;
      
      // Play sound effect
      this.playSound(isMuted ? 'mic_off.mp3' : 'mic_on.mp3');
      
      return this.isAudioEnabled;
    },
    
    async toggleVideo() {
      // Video is not supported in this Discord-style voice-only implementation
      console.log('Video chat not implemented in Discord-style voice service');
      return false;
    },
    
    async toggleScreenShare() {
      // Screen sharing is not supported in this Discord-style voice-only implementation
      console.log('Screen sharing not implemented in Discord-style voice service');
      return false;
    },
    
    async toggleMute() {
      // Allow mute/unmute even when not connected (preemptive state)
      if (this.isConnected) {
        const isMuted = await webRTCService.toggleMute();
        this.isMuted = isMuted;
        this.isAudioEnabled = !isMuted;
      } else {
        // Toggle local state when not connected
        this.isMuted = !this.isMuted;
        this.isAudioEnabled = !this.isMuted;
        console.log('Setting preemptive mute state:', this.isMuted);
      }
      
      // Play sound effect
      this.playSound(this.isMuted ? 'mic_off.mp3' : 'mic_on.mp3');
      
      return this.isMuted;
    },
    
    async toggleDeafen() {
      // Allow deafen/undeafen even when not connected (preemptive state)
      if (this.isConnected) {
        const isDeafened = await webRTCService.toggleDeafen();
        this.isDeafened = isDeafened;
        
        // Deafening also mutes in connected state
        if (isDeafened) {
          this.isMuted = true;
          this.isAudioEnabled = false;
        }
      } else {
        // Toggle local state when not connected
        this.isDeafened = !this.isDeafened;
        
        // Deafening also mutes (Discord behavior)
        if (this.isDeafened) {
          this.isMuted = true;
          this.isAudioEnabled = false;
        }
        
        console.log('Setting preemptive deafen state:', this.isDeafened);
      }
      
      return this.isDeafened;
    },
    
    // WebRTC event handlers
    setupWebRTCListeners() {
      webRTCService.on('userJoined', (userId: string) => {
        // Prevent duplicates
        if (!this.connectedUsers.includes(userId)) {
          this.connectedUsers.push(userId);
          this.connectionStates.set(userId, 'connecting');
          this.playSound('voice_connect.mp3');
        }
      });
      
      webRTCService.on('userLeft', (userId: string) => {
        this.connectedUsers = this.connectedUsers.filter(id => id !== userId);
        this.remoteStreams.delete(userId);
        this.connectionStates.delete(userId);
        this.audioLevels.delete(userId);
        this.playSound('voice_disconnect.mp3');
      });
      
      webRTCService.on('userConnected', (userId: string) => {
        this.connectionStates.set(userId, 'connected');
      });
      
      webRTCService.on('userDisconnected', (userId: string) => {
        this.connectionStates.set(userId, 'disconnected');
      });
      
      webRTCService.on('userStreamChanged', (userId: string, stream: MediaStream) => {
        console.log('Voice store received stream for user:', userId, 'Audio tracks:', stream.getAudioTracks().length);
        this.remoteStreams.set(userId, stream);
        this.setupAudioLevelMonitoring(userId, stream);
      });
      
      webRTCService.on('channelJoined', (channelId: string) => {
        console.log('Joined voice channel:', channelId);
        this.localStream = webRTCService.getLocalStream();
        if (this.localStream) {
          this.setupAudioLevelMonitoring('local', this.localStream);
        }
      });
      
      webRTCService.on('muteToggled', (isMuted: boolean) => {
        this.isMuted = isMuted;
        this.isAudioEnabled = !isMuted;
      });
      
      webRTCService.on('deafenToggled', (isDeafened: boolean) => {
        this.isDeafened = isDeafened;
        if (isDeafened) {
          this.isMuted = true;
          this.isAudioEnabled = false;
        }
      });
      
      webRTCService.on('userSpeakingChanged', (userId: string, isSpeaking: boolean) => {
        console.log('User speaking changed:', userId, isSpeaking);
        // Force UI update by triggering reactivity
        this.connectedUsers = [...this.connectedUsers];
      });
      
      webRTCService.on('connectionStateChanged', (state: string) => {
        console.log('Connection state changed:', state);
        this.isConnected = state === 'connected';
      });
      
      webRTCService.on('error', (error: Error) => {
        console.error('WebRTC error:', error);
        // Handle error (show notification, etc.)
      });
    },
    
    // Audio level monitoring - simplified for Discord-style service
    setupAudioLevelMonitoring(userId: string, stream: MediaStream) {
      try {
        const audioContext = new AudioContext();
        const analyser = audioContext.createAnalyser();
        const microphone = audioContext.createMediaStreamSource(stream);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        
        microphone.connect(analyser);
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        
        let isActive = true;
        
        const updateLevel = () => {
          if (!isActive) return;
          
          try {
            analyser.getByteFrequencyData(dataArray);
            const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
            this.audioLevels.set(userId, average);
            
            requestAnimationFrame(updateLevel);
          } catch (error) {
            console.warn('Error updating audio level:', error);
            isActive = false;
          }
        };
        
        updateLevel();
        
        // Cleanup when stream ends
        stream.addEventListener('inactive', () => {
          isActive = false;
          try {
            audioContext.close();
          } catch (error) {
            console.warn('Error closing audio context:', error);
          }
        });
      } catch (error) {
        console.warn('Error setting up audio level monitoring:', error);
      }
    },
    
    // Sound effects
    playSound(filename: string) {
      try {
        const audio = new Audio(`/assets/sounds/${filename}`);
        audio.volume = 0.5;
        audio.play().catch(e => console.log('Could not play sound:', e));
      } catch (error) {
        console.log('Error playing sound:', error);
      }
    },
    
    resetState() {
      this.currentChannelId = null;
      this.currentServerId = null;
      this.currentUserId = null;
      this.isConnected = false;
      this.isAudioEnabled = true;
      this.isVideoEnabled = false;
      this.isScreenSharing = false;
      this.isMuted = false;
      this.isDeafened = false;
      this.connectedUsers = [];
      this.localStream = null;
      this.remoteStreams.clear();
      this.audioLevels.clear();
      this.connectionStates.clear();
    },
    
    // Get user info
    getConnectedUserInfo(userId: string) {
      const serverUsersStore = useServerUsersStore();
      return serverUsersStore.userProfiles[userId];
    },
    
    // Voice-specific methods
    isUserSpeaking(userId: string): boolean {
      return webRTCService.isUserSpeaking(userId);
    },
    
    getUserAudioLevel(userId: string): number {
      return webRTCService.getUserAudioLevel(userId);
    },
    
    setInputVolume(volume: number) {
      webRTCService.setInputVolume(volume);
    },
    
    setOutputVolume(volume: number) {
      webRTCService.setOutputVolume(volume);
    },
  },
});
