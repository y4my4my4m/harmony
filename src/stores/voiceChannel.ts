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
      return state.remoteStreams.get(userId);
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
        await webRTCService.leaveChannel();
        
        // Leave through server users store
        // Find server ID from current channel (you might need to store this)
        const serverId = this.getServerIdFromChannel(this.currentChannelId);
        if (serverId) {
          await serverUsersStore.leaveVoiceChannel(serverId, this.currentChannelId, userId);
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
      const enabled = await webRTCService.toggleAudio();
      this.isAudioEnabled = enabled;
      
      // Play sound effect
      this.playSound(enabled ? 'mic_on.mp3' : 'mic_off.mp3');
      
      return enabled;
    },
    
    async toggleVideo() {
      const enabled = await webRTCService.toggleVideo();
      this.isVideoEnabled = enabled;
      
      // Play sound effect
      this.playSound(enabled ? 'camera_on.mp3' : 'camera_off.mp3');
      
      return enabled;
    },
    
    async toggleScreenShare() {
      const enabled = await webRTCService.toggleScreenShare();
      this.isScreenSharing = enabled;
      
      // Play sound effect
      this.playSound(enabled ? 'screenshare_on.mp3' : 'screenshare_off.mp3');
      
      return enabled;
    },
    
    toggleMute() {
      this.isMuted = !this.isMuted;
      webRTCService.setMuted(this.isMuted);
      
      // Play sound effect
      this.playSound(this.isMuted ? 'mic_off.mp3' : 'mic_on.mp3');
      
      return this.isMuted;
    },
    
    toggleDeafen() {
      this.isDeafened = !this.isDeafened;
      webRTCService.setDeafened(this.isDeafened);
      
      // If deafened, also mute
      if (this.isDeafened) {
        this.isMuted = true;
        webRTCService.setMuted(true);
      }
      
      return this.isDeafened;
    },
    
    // WebRTC event handlers
    setupWebRTCListeners() {
      webRTCService.on('userJoined', (userId: string) => {
        this.connectedUsers.push(userId);
        this.connectionStates.set(userId, 'connecting');
        this.playSound('voice_connect.mp3');
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
        this.remoteStreams.set(userId, stream);
        this.setupAudioLevelMonitoring(userId, stream);
      });
      
      webRTCService.on('localStreamChanged', (stream: MediaStream) => {
        this.localStream = stream;
        this.setupAudioLevelMonitoring('local', stream);
      });
      
      webRTCService.on('error', (error: Error) => {
        console.error('WebRTC error:', error);
        // Handle error (show notification, etc.)
      });
    },
    
    // Audio level monitoring
    setupAudioLevelMonitoring(userId: string, stream: MediaStream) {
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      const microphone = audioContext.createMediaStreamSource(stream);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      
      microphone.connect(analyser);
      analyser.fftSize = 256;
      
      const updateLevel = () => {
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        this.audioLevels.set(userId, average);
        
        requestAnimationFrame(updateLevel);
      };
      
      updateLevel();
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
    
    // Helper methods
    getServerIdFromChannel(channelId: string): string | null {
      // You'll need to implement this based on your channel structure
      // For now, return null - you might want to store server ID in state
      return null;
    },
    
    resetState() {
      this.currentChannelId = null;
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
