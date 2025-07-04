import { defineStore } from 'pinia';
import { nativeWebRTCService } from '@/services/nativeWebRTC';
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
        const webrtcSuccess = await nativeWebRTCService.joinChannel(channelId, userId);
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
        await nativeWebRTCService.leaveChannel();
        
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
      const enabled = nativeWebRTCService.toggleAudio();
      this.isAudioEnabled = enabled;
      
      // Play sound effect
      this.playSound(enabled ? 'mic_on.mp3' : 'mic_off.mp3');
      
      return enabled;
    },
    
    async toggleVideo() {
      const enabled = await nativeWebRTCService.toggleVideo();
      this.isVideoEnabled = enabled;
      
      // Play sound effect
      this.playSound(enabled ? 'camera_on.mp3' : 'camera_off.mp3');
      
      return enabled;
    },
    
    async toggleScreenShare() {
      const enabled = await nativeWebRTCService.toggleScreenShare();
      this.isScreenSharing = enabled;
      
      // Play sound effect
      this.playSound(enabled ? 'screenshare_on.mp3' : 'screenshare_off.mp3');
      
      return enabled;
    },
    
    toggleMute() {
      this.isMuted = !this.isMuted;
      nativeWebRTCService.setMuted(this.isMuted);
      
      // Play sound effect
      this.playSound(this.isMuted ? 'mic_off.mp3' : 'mic_on.mp3');
      
      return this.isMuted;
    },
    
    toggleDeafen() {
      this.isDeafened = !this.isDeafened;
      nativeWebRTCService.setDeafened(this.isDeafened);
      
      // If deafened, also mute
      if (this.isDeafened) {
        this.isMuted = true;
        nativeWebRTCService.setMuted(true);
      }
      
      return this.isDeafened;
    },
    
    // WebRTC event handlers
    setupWebRTCListeners() {
      nativeWebRTCService.on('userJoined', (userId: string) => {
        // Prevent duplicates
        if (!this.connectedUsers.includes(userId)) {
          this.connectedUsers.push(userId);
          this.connectionStates.set(userId, 'connecting');
          this.playSound('voice_connect.mp3');
        }
      });
      
      nativeWebRTCService.on('userLeft', (userId: string) => {
        this.connectedUsers = this.connectedUsers.filter(id => id !== userId);
        this.remoteStreams.delete(userId);
        this.connectionStates.delete(userId);
        this.audioLevels.delete(userId);
        this.playSound('voice_disconnect.mp3');
      });
      
      nativeWebRTCService.on('userConnected', (userId: string) => {
        this.connectionStates.set(userId, 'connected');
      });
      
      nativeWebRTCService.on('userDisconnected', (userId: string) => {
        this.connectionStates.set(userId, 'disconnected');
      });
      
      nativeWebRTCService.on('userStreamChanged', (userId: string, stream: MediaStream) => {
        console.log('Voice store received stream for user:', userId, 'Video tracks:', stream.getVideoTracks().length);
        this.remoteStreams.set(userId, stream);
        this.setupAudioLevelMonitoring(userId, stream);
      });
      
      nativeWebRTCService.on('localStreamChanged', (stream: MediaStream) => {
        console.log('Local stream changed in voice store:', stream?.getTracks().length || 0, 'tracks');
        this.localStream = stream;
        if (stream) {
          this.setupAudioLevelMonitoring('local', stream);
        }
      });
      
      nativeWebRTCService.on('userMediaToggled', (state: any) => {
        console.log('User media toggled:', state);
        // Force UI update by triggering reactivity
        // This ensures the UI components see the media state changes
        this.connectedUsers = [...this.connectedUsers];
      });
      
      nativeWebRTCService.on('error', (error: Error) => {
        console.error('WebRTC error:', error);
        // Handle error (show notification, etc.)
      });
    },
    
    // Audio level monitoring
    setupAudioLevelMonitoring(userId: string, stream: MediaStream) {
      try {
        const audioContext = new AudioContext();
        const analyser = audioContext.createAnalyser();
        const microphone = audioContext.createMediaStreamSource(stream);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        
        microphone.connect(analyser);
        analyser.fftSize = 256;
        
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
  },
});
