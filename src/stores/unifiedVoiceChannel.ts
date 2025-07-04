import { defineStore } from 'pinia';
import { nextTick } from 'vue';
import { unifiedWebRTC, type UserMediaState } from '@/services/unifiedWebRTC';
import { useAuthStore } from '@/stores/auth';
import { useServerUsersStore } from '@/stores/useServerUsers';

// =============================================================================
// TYPES
// =============================================================================

interface VoiceChannelState {
  // Connection info
  currentChannelId: string | null;
  currentServerId: string | null;
  isConnected: boolean;
  
  // Users and their states
  allUsers: UserMediaState[];
  localState: UserMediaState;
  
  // Streams
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  
  // UI state
  isOverlayVisible: boolean;
  layoutMode: 'grid' | 'speaker' | 'gallery';
}

// =============================================================================
// STORE
// =============================================================================

export const useUnifiedVoiceChannelStore = defineStore('unifiedVoiceChannel', {
  state: (): VoiceChannelState => ({
    currentChannelId: null,
    currentServerId: null,
    isConnected: false,
    
    allUsers: [],
    localState: {
      userId: '',
      isAudioEnabled: true,
      isVideoEnabled: false,
      isScreenSharing: false,
      isMuted: false,
      isDeafened: false,
      audioLevel: 0
    },
    
    localStream: null,
    remoteStreams: new Map(),
    
    isOverlayVisible: false,
    layoutMode: 'grid'
  }),

  // =============================================================================
  // GETTERS
  // =============================================================================
  
  getters: {
    // Get user by ID
    getUser: (state) => (userId: string) => {
      if (userId === state.localState.userId) {
        return state.localState;
      }
      return state.allUsers.find(user => user.userId === userId) || null;
    },

    // Get stream for user
    getUserStream: (state) => (userId: string) => {
      if (userId === state.localState.userId) {
        return state.localStream;
      }
      return state.remoteStreams.get(userId) || null;
    },

    // Get all participants (including self)
    allParticipants: (state) => {
      const participants = [state.localState];
      state.allUsers.forEach(user => {
        if (user.userId !== state.localState.userId) {
          participants.push(user);
        }
      });
      return participants;
    },

    // Get speaking users
    speakingUsers: (state) => {
      return state.allUsers.filter(user => user.audioLevel > 20);
    },

    // Get featured speaker (loudest or screen sharing)
    featuredSpeaker: (state) => {
      // Prioritize screen sharing users
      const screenSharing = state.allUsers.find(user => user.isScreenSharing);
      if (screenSharing) return screenSharing;
      
      // Otherwise, find loudest speaker
      let loudest = state.localState;
      state.allUsers.forEach(user => {
        if (user.audioLevel > loudest.audioLevel) {
          loudest = user;
        }
      });
      
      return loudest.audioLevel > 20 ? loudest : null;
    },

    // Connection stats
    connectionStats: (state) => {
      const total = state.allUsers.length + 1; // +1 for self
      const withVideo = state.allUsers.filter(u => u.isVideoEnabled).length + (state.localState.isVideoEnabled ? 1 : 0);
      const speaking = state.allUsers.filter(u => u.audioLevel > 20).length + (state.localState.audioLevel > 20 ? 1 : 0);
      
      return { total, withVideo, speaking };
    }
  },

  // =============================================================================
  // ACTIONS
  // =============================================================================
  
  actions: {
    /**
     * Join a voice channel
     */
    async joinVoiceChannel(channelId: string, serverId: string): Promise<boolean> {
      try {
        const authStore = useAuthStore();
        const serverUsersStore = useServerUsersStore();
        
        if (!authStore.session?.user) {
          throw new Error('User not authenticated');
        }
        
        const userId = authStore.session.user.id;
        
        console.log('🎯 Joining voice channel:', channelId, 'on server:', serverId);
        
        // Update server presence first
        const presenceSuccess = await serverUsersStore.joinVoiceChannel(serverId, channelId, userId);
        if (!presenceSuccess) {
          throw new Error('Failed to update server presence');
        }
        
        // Setup WebRTC event listeners before joining
        this.setupWebRTCListeners();
        
        // Join WebRTC channel
        const webrtcSuccess = await unifiedWebRTC.joinChannel(channelId, userId);
        if (!webrtcSuccess) {
          // Rollback server presence
          await serverUsersStore.leaveVoiceChannel(serverId, channelId, userId);
          throw new Error('Failed to join WebRTC channel');
        }
        
        // Update store state
        this.currentChannelId = channelId;
        this.currentServerId = serverId;
        this.isConnected = true;
        
        // Get fresh state from WebRTC service
        const newLocalState = unifiedWebRTC.getLocalState();
        
        // Apply any preemptive mute/deafen state
        if (this.localState.isMuted && !newLocalState.isMuted) {
          console.log('Applying preemptive mute state');
          unifiedWebRTC.toggleMute();
        }
        if (this.localState.isDeafened && !newLocalState.isDeafened) {
          console.log('Applying preemptive deafen state');
          unifiedWebRTC.toggleDeafen();
        }
        
        // Update state after applying preemptive settings
        this.localState = unifiedWebRTC.getLocalState();
        this.localStream = unifiedWebRTC.getLocalStream();
        
        // Start in dock mode, not overlay mode
        this.isOverlayVisible = false;
        
        // Play join sound
        this.playSound('voice_connect.mp3');
        
        return true;
      } catch (error) {
        console.error('❌ Failed to join voice channel:', error);
        return false;
      }
    },

    /**
     * Leave voice channel
     */
    async leaveVoiceChannel(): Promise<boolean> {
      try {
        const authStore = useAuthStore();
        const serverUsersStore = useServerUsersStore();
        
        if (!this.currentChannelId || !authStore.session?.user) {
          return true;
        }
        
        const userId = authStore.session.user.id;
        
        console.log('👋 Leaving voice channel');
        
        // Leave WebRTC first
        await unifiedWebRTC.leaveChannel();
        
        // Update server presence
        if (this.currentServerId) {
          await serverUsersStore.leaveVoiceChannel(this.currentServerId, this.currentChannelId, userId);
        }
        
        // Reset state
        this.resetState();
        
        // Play leave sound
        this.playSound('voice_disconnect.mp3');
        
        return true;
      } catch (error) {
        console.error('❌ Failed to leave voice channel:', error);
        return false;
      }
    },

    /**
     * Toggle video on/off
     */
    async toggleVideo(): Promise<boolean> {
      const enabled = await unifiedWebRTC.toggleVideo();
      
      // Force sync with WebRTC service state
      this.localState = unifiedWebRTC.getLocalState();
      this.localStream = unifiedWebRTC.getLocalStream();
      
      // Give UI time to update before playing sound
      setTimeout(() => {
        this.playSound(enabled ? 'camera_on.mp3' : 'camera_off.mp3');
      }, 100);
      
      console.log('📹 Video toggled, local stream updated:', {
        enabled,
        streamId: this.localStream?.id,
        videoTracks: this.localStream?.getVideoTracks().length || 0,
        audioTracks: this.localStream?.getAudioTracks().length || 0
      });
      
      // Force refresh UI reactivity
      this.refreshStreamState();
      
      return enabled;
    },

    /**
     * Toggle screen share on/off
     */
    async toggleScreenShare(): Promise<boolean> {
      const enabled = await unifiedWebRTC.toggleScreenShare();
      
      // Force sync with WebRTC service state
      this.localState = unifiedWebRTC.getLocalState();
      this.localStream = unifiedWebRTC.getLocalStream();
      
      // Give UI time to update before playing sound
      setTimeout(() => {
        this.playSound(enabled ? 'screenshare_on.mp3' : 'screenshare_off.mp3');
      }, 100);
      
      console.log('📺 Screen share toggled, local stream updated:', {
        enabled,
        streamId: this.localStream?.id,
        videoTracks: this.localStream?.getVideoTracks().length || 0,
        audioTracks: this.localStream?.getAudioTracks().length || 0
      });
      
      // Force refresh UI reactivity
      this.refreshStreamState();
      
      return enabled;
    },

    /**
     * Toggle mute on/off
     */
    async toggleMute(): Promise<boolean> {
      // Allow mute/unmute even when not connected (preemptive state)
      if (this.isConnected) {
        const muted = unifiedWebRTC.toggleMute();
        this.localState = unifiedWebRTC.getLocalState();
        this.playSound(muted ? 'mic_off.mp3' : 'mic_on.mp3');
        return muted;
      } else {
        // Toggle local state when not connected
        this.localState.isMuted = !this.localState.isMuted;
        console.log('Setting preemptive mute state:', this.localState.isMuted);
        this.playSound(this.localState.isMuted ? 'mic_off.mp3' : 'mic_on.mp3');
        return this.localState.isMuted;
      }
    },

    /**
     * Toggle deafen on/off
     */
    async toggleDeafen(): Promise<boolean> {
      // Allow deafen/undeafen even when not connected (preemptive state)
      if (this.isConnected) {
        const deafened = unifiedWebRTC.toggleDeafen();
        this.localState = unifiedWebRTC.getLocalState();
        this.playSound(deafened ? 'deafen_on.mp3' : 'deafen_off.mp3');
        return deafened;
      } else {
        // Toggle local state when not connected
        this.localState.isDeafened = !this.localState.isDeafened;
        
        // Deafening also mutes (Discord behavior)
        if (this.localState.isDeafened) {
          this.localState.isMuted = true;
        }
        
        console.log('Setting preemptive deafen state:', this.localState.isDeafened);
        this.playSound(this.localState.isDeafened ? 'deafen_on.mp3' : 'deafen_off.mp3');
        return this.localState.isDeafened;
      }
    },

    /**
     * Show/hide voice overlay
     */
    toggleOverlay(): void {
      this.isOverlayVisible = !this.isOverlayVisible;
    },

    /**
     * Change layout mode
     */
    setLayoutMode(mode: 'grid' | 'speaker' | 'gallery'): void {
      this.layoutMode = mode;
    },

    /**
     * Setup WebRTC event listeners
     */
    setupWebRTCListeners(): void {
      // Channel events
      unifiedWebRTC.on('channel-joined', (data) => {
        console.log('✅ Channel joined:', data);
      });

      unifiedWebRTC.on('channel-left', (data) => {
        console.log('👋 Channel left:', data);
      });

      unifiedWebRTC.on('channel-state-synced', (data) => {
        console.log('🔄 Channel state synced:', data);
        this.allUsers = data.users;
      });

      // User events
      unifiedWebRTC.on('user-joined', (data) => {
        console.log('👋 User joined:', data);
        
        // Add user if not already in list
        const existingIndex = this.allUsers.findIndex(u => u.userId === data.userId);
        if (existingIndex === -1) {
          this.allUsers.push(data.mediaState);
        } else {
          this.allUsers[existingIndex] = data.mediaState;
        }
        
        this.playSound('voice_connect.mp3');
      });

      unifiedWebRTC.on('user-left', (data) => {
        console.log('👋 User left:', data);
        
        // Remove user from list
        this.allUsers = this.allUsers.filter(u => u.userId !== data.userId);
        this.remoteStreams.delete(data.userId);
        
        this.playSound('voice_disconnect.mp3');
      });

      unifiedWebRTC.on('user-state-changed', (data) => {
        console.log('🎛️ User state changed:', data);
        
        // Update user state
        const userIndex = this.allUsers.findIndex(u => u.userId === data.userId);
        if (userIndex !== -1) {
          this.allUsers[userIndex] = data.mediaState;
        }
      });

      unifiedWebRTC.on('user-stream-changed', (data) => {
        console.log('📹 User stream changed:', data.userId, data.stream);
        
        if (data.stream) {
          this.remoteStreams.set(data.userId, data.stream);
        } else {
          this.remoteStreams.delete(data.userId);
        }
      });

      // Local events
      unifiedWebRTC.on('local-state-changed', (state) => {
        console.log('🎛️ Local state changed:', state);
        this.localState = state;
      });
      
      unifiedWebRTC.on('local-stream-changed', (stream) => {
        console.log('📹 Local stream changed:', stream);
        this.localStream = stream;
      });
      
      // Handle generic stream changes (for better compatibility)
      unifiedWebRTC.on('stream-changed', (data) => {
        console.log('📡 Stream changed:', data.userId, data.type, data.stream);
        if (data.type === 'local' && data.userId === this.localState.userId) {
          this.localStream = data.stream;
        } else if (data.type === 'remote') {
          if (data.stream) {
            this.remoteStreams.set(data.userId, data.stream);
          } else {
            this.remoteStreams.delete(data.userId);
          }
        }
      });

      // Audio levels
      unifiedWebRTC.on('audio-level', (data) => {
        if (data.userId === this.localState.userId) {
          this.localState.audioLevel = data.level;
        } else {
          const user = this.allUsers.find(u => u.userId === data.userId);
          if (user) {
            user.audioLevel = data.level;
          }
        }
      });

      // Connection events
      unifiedWebRTC.on('connection-state-changed', (data) => {
        console.log('🔗 Connection state changed:', data);
      });

      // Error handling
      unifiedWebRTC.on('error', (error) => {
        console.error('❌ WebRTC error:', error);
        // Could show notification to user
      });
    },

    /**
     * Play sound effect
     */
    playSound(filename: string): void {
      try {
        const audio = new Audio(`/assets/sounds/${filename}`);
        audio.volume = 0.3;
        audio.play().catch(e => console.log('Could not play sound:', e));
      } catch (error) {
        console.log('Error playing sound:', error);
      }
    },

    /**
     * Reset store state
     */
    resetState(): void {
      this.currentChannelId = null;
      this.currentServerId = null;
      this.isConnected = false;
      this.allUsers = [];
      this.localState = {
        userId: '',
        isAudioEnabled: true,
        isVideoEnabled: false,
        isScreenSharing: false,
        isMuted: false,
        isDeafened: false,
        audioLevel: 0
      };
      this.localStream = null;
      this.remoteStreams.clear();
      this.isOverlayVisible = false;
    },

    /**
     * Get user profile info
     */
    getUserProfile(userId: string) {
      const serverUsersStore = useServerUsersStore();
      return serverUsersStore.userProfiles[userId] || {
        id: userId,
        username: 'Unknown User',
        display_name: 'Unknown User',
        avatar_url: null
      };
    },

    /**
     * Force refresh stream state for UI reactivity
     */
    refreshStreamState(): void {
      // Force Vue reactivity by creating a new reference
      const currentStream = unifiedWebRTC.getLocalStream();
      if (currentStream) {
        this.localStream = null;
        nextTick(() => {
          this.localStream = currentStream;
          console.log('🔄 Forced stream state refresh for UI reactivity');
        });
      }
    }
  }
});