import { defineStore } from 'pinia';
import { nextTick } from 'vue';
import { unifiedWebRTC, type UserMediaState } from '@/services/unifiedWebRTC';
import { spatialAudioService } from '@/services/spatialAudio';
import { useSpatialAudioStore } from '@/stores/spatialAudio';
import { useAuthStore } from '@/stores/auth';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useServerChannelStore } from './useServerChannel';
import { useThemeStore } from '@/stores/useTheme';
import { useUserData } from '@/composables/useUserData';
import { debug } from '@/utils/debug';

// =============================================================================
// TYPES
// =============================================================================

interface VoiceChannelState {
  // Connection info
  currentChannelId: string | null;
  currentServerId: string | null;
  currentChannelName: string | null;
  isConnected: boolean;
  sessionStartTime: Date | null; // Track when the user joined the channel
  callStartTime: Date | null; // Track when the call started (first user joined)
  
  // Users and their states
  allUsers: UserMediaState[];
  localState: UserMediaState;
  
  // Streams
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  
  // UI state
  isOverlayVisible: boolean;
  layoutMode: 'grid' | 'speaker' | 'gallery';
  viewMode: 'normal' | 'maximized' | 'fullscreen';
  fullscreenUserId: string | null;
  
  // PIP state
  pipActive: boolean;
  pipUserId: string | null;
  pipMode: 'draggable' | 'fixed' | 'native';
}

// =============================================================================
// STORE
// =============================================================================

export const useUnifiedVoiceChannelStore = defineStore('unifiedVoiceChannel', {
  state: (): VoiceChannelState => ({
    currentChannelId: null,
    currentServerId: null,
    isConnected: false,
    currentChannelName: null,
    sessionStartTime: null,
    callStartTime: null,
    
    allUsers: [],
    localState: {
      userId: '',
      isAudioEnabled: true,
      isVideoEnabled: false,
      isScreenSharing: false,
      isMuted: false,
      isDeafened: false,
      isSpeaking: false,
      audioLevel: 0
    },
    
    localStream: null,
    remoteStreams: new Map(),
    
    isOverlayVisible: false,
    layoutMode: 'grid',
    viewMode: 'normal',
    fullscreenUserId: null,
    
    pipActive: false,
    pipUserId: null,
    pipMode: 'native'
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
        const serverChannelStore = useServerChannelStore();
        const themeStore = useThemeStore();

        if (!authStore.session?.user) {
          throw new Error('User not authenticated');
        }
        
        const userId = authStore.session.user.id;
        
        debug.log('🎯 Joining voice channel:', channelId, 'on server:', serverId);
        
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
        // FIXME: highly inefficient way to get channel name
        // This should be optimized to avoid fetching all channels every time
        const channel = serverChannelStore.channels.find((c: any) => c.id === channelId);
        this.currentChannelName = channel ? channel.name : 'Voice Channel';
        this.isConnected = true;
        this.sessionStartTime = new Date(); // Track when user joined
        
        // Get call start time from serverUsersStore (synced across all users)
        const existingCallStartTime = serverUsersStore.getCallStartTime(channelId);
        if (existingCallStartTime) {
          this.callStartTime = existingCallStartTime;
          debug.log('🕐 Using existing call start time from serverUsersStore:', this.callStartTime);
        } else {
          // We're the first user - set it now
          this.callStartTime = new Date();
          debug.log('🕐 First user - setting call start time:', this.callStartTime);
        }
        
        // Save voice channel state to localStorage for auto-reconnect
        this.saveVoiceChannelState();
        
        // Check if anyone else is in the channel to determine if we're starting the call
        // We'll set call start time after channel state sync
        
        // Get fresh state from WebRTC service
        const newLocalState = unifiedWebRTC.getLocalState();
        
        // Apply any preemptive mute/deafen state
        if (this.localState.isMuted && !newLocalState.isMuted) {
          debug.log('Applying preemptive mute state');
          unifiedWebRTC.toggleMute();
        }
        if (this.localState.isDeafened && !newLocalState.isDeafened) {
          debug.log('Applying preemptive deafen state');
          unifiedWebRTC.toggleDeafen();
        }
        
        // Update state after applying preemptive settings
        this.localState = unifiedWebRTC.getLocalState();
        this.localStream = unifiedWebRTC.getLocalStream();
        
        // Initialize spatial audio
        await this.initializeSpatialAudio(userId);
        
        // Start in dock mode, not overlay mode
        this.isOverlayVisible = false;
        
        // Play join sound
        themeStore.testAudio('voice_connect');
        
        return true;
      } catch (error) {
        debug.error('❌ Failed to join voice channel:', error);
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
        const themeStore = useThemeStore();

        if (!this.currentChannelId || !authStore.session?.user) {
          return true;
        }
        
        const userId = authStore.session.user.id;
        
        debug.log('👋 Leaving voice channel');
        
        // Clear saved voice channel state (user manually left)
        this.clearVoiceChannelState();
        
        // Leave WebRTC first
        await unifiedWebRTC.leaveChannel();

        // Clean up spatial audio
        this.cleanupSpatialAudio();
        
        // Update server presence
        if (this.currentServerId) {
          await serverUsersStore.leaveVoiceChannel(this.currentServerId, this.currentChannelId, userId);
        }
        
        // Reset state
        this.resetState();
        
        // Play leave sound
        themeStore.testAudio('voice_disconnect');

        return true;
      } catch (error) {
        debug.error('❌ Failed to leave voice channel:', error);
        return false;
      }
    },

    /**
     * Toggle video on/off
     */
    async toggleVideo(): Promise<boolean> {
      const themeStore = useThemeStore();
      const enabled = await unifiedWebRTC.toggleVideo();
      
      // Force sync with WebRTC service state
      this.localState = unifiedWebRTC.getLocalState();
      this.localStream = unifiedWebRTC.getLocalStream();
      
      // Give UI time to update before playing sound
      setTimeout(() => {
        themeStore.testAudio(enabled ? 'camera_on' : 'camera_off');
      }, 100);
      
      debug.log('📹 Video toggled, local stream updated:', {
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
      const themeStore = useThemeStore();
      
      // Force sync with WebRTC service state
      this.localState = unifiedWebRTC.getLocalState();
      this.localStream = unifiedWebRTC.getLocalStream();
      
      // Give UI time to update before playing sound
      setTimeout(() => {
        themeStore.testAudio(enabled ? 'screenshare_on' : 'screenshare_off');
      }, 100);
      
      debug.log('📺 Screen share toggled, local stream updated:', {
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
      const themeStore = useThemeStore();
      // Allow mute/unmute even when not connected (preemptive state)
      if (this.isConnected) {
        const muted = unifiedWebRTC.toggleMute();
        this.localState = unifiedWebRTC.getLocalState();
        themeStore.testAudio(muted ? 'mic_off' : 'mic_on');
        return muted;
      } else {
        // Toggle local state when not connected
        this.localState.isMuted = !this.localState.isMuted;
        debug.log('Setting preemptive mute state:', this.localState.isMuted);
        themeStore.testAudio(this.localState.isMuted ? 'mic_off' : 'mic_on');
        return this.localState.isMuted;
      }
    },

    /**
     * Toggle deafen on/off
     */
    async toggleDeafen(): Promise<boolean> {
      const themeStore = useThemeStore();
      // Allow deafen/undeafen even when not connected (preemptive state)
      if (this.isConnected) {
        const deafened = unifiedWebRTC.toggleDeafen();
        this.localState = unifiedWebRTC.getLocalState();
        themeStore.testAudio(deafened ? 'deafen_on' : 'deafen_off');
        return deafened;
      } else {
        // Toggle local state when not connected
        this.localState.isDeafened = !this.localState.isDeafened;
        
        // Deafening also mutes (Discord behavior)
        if (this.localState.isDeafened) {
          this.localState.isMuted = true;
        }
        
        debug.log('Setting preemptive deafen state:', this.localState.isDeafened);
        themeStore.testAudio(this.localState.isDeafened ? 'deafen_on' : 'deafen_off');
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
     * Change view mode
     */
    setViewMode(mode: 'normal' | 'maximized' | 'fullscreen'): void {
      this.viewMode = mode;
      if (mode !== 'fullscreen') {
        this.fullscreenUserId = null;
      }
    },

    /**
     * Enter fullscreen mode for a specific user
     */
    enterFullscreen(userId: string): void {
      this.viewMode = 'fullscreen';
      this.fullscreenUserId = userId;
    },

    /**
     * Exit fullscreen mode
     */
    exitFullscreen(): void {
      this.viewMode = 'normal';
      this.fullscreenUserId = null;
    },

    /**
     * Toggle PIP mode for screenshare
     */
    togglePIP(userId: string | null, mode: 'draggable' | 'fixed' | 'native' = 'native'): void {
      if (this.pipActive && this.pipUserId === userId) {
        this.pipActive = false;
        this.pipUserId = null;
      } else {
        this.pipActive = true;
        this.pipUserId = userId;
        this.pipMode = mode;
      }
    },

    /**
     * Set call start time (synced across all participants)
     */
    setCallStartTime(timestamp: Date | null): void {
      this.callStartTime = timestamp;
    },

    /**
     * Setup WebRTC event listeners
     */
    setupWebRTCListeners(): void {
      const themeStore = useThemeStore();
      // Channel events
      unifiedWebRTC.on('channel-joined', (data) => {
        debug.log('✅ Channel joined:', data);
      });

      unifiedWebRTC.on('channel-left', (data) => {
        debug.log('👋 Channel left:', data);
      });

      unifiedWebRTC.on('channel-state-synced', async (data) => {
        debug.log('🔄 Channel state synced:', data);
        this.allUsers = data.users;
        
        // Handle call start time syncing
        if (data.users.length === 0) {
          // We're the first/only user - broadcast our call start time
          debug.log('🕐 First user in channel - broadcasting call start time');
          this.broadcastCallStartTime();
        } else {
          // Others already in call - request their call start time to sync
          debug.log('🕐 Joining existing call - requesting call start time');
          this.requestCallStartTime();
        }
        
        // Ensure all users' profile data is loaded through unified system
        const { ensureProfilesAvailable } = useUserData();
        const userIds = data.users.map((user: any) => user.userId);
        
        // Check if user list has changed
        const userIdsChanged = !this.previousUserIds || userIds.length !== this.previousUserIds.length || 
          userIds.some((id, index) => id !== this.previousUserIds[index]);
        
        if (userIdsChanged && userIds.length > 0) {
          try {
            await ensureProfilesAvailable(userIds);
            debug.log('✅ Loaded profiles for all voice users:', userIds.length);
            this.previousUserIds = userIds; // Update cache
          } catch (error) {
            debug.warn('⚠️ Failed to load profiles for voice users:', error);
          }
        } else {
          debug.log('ℹ️ No changes in user list, skipping profile load.');
        }
      });

      // User events
      unifiedWebRTC.on('user-joined', async (data) => {
        debug.log('👋 User joined:', data);
        
        // Add user if not already in list
        const existingIndex = this.allUsers.findIndex(u => u.userId === data.userId);
        if (existingIndex === -1) {
          this.allUsers.push(data.mediaState);
        } else {
          this.allUsers[existingIndex] = data.mediaState;
        }

        // Request call start time from existing participants
        if (!this.callStartTime) {
          debug.log('🕐 Requesting call start time from existing participants');
          this.requestCallStartTime();
        }

        // Ensure user profile data is loaded through unified system
        const { ensureProfilesAvailable } = useUserData();
        try {
          await ensureProfilesAvailable([data.userId]);
          debug.log('✅ Loaded profile for voice user:', data.userId);
        } catch (error) {
          debug.warn('⚠️ Failed to load profile for voice user:', data.userId, error);
        }

        themeStore.testAudio('voice_connect');
      });

      unifiedWebRTC.on('user-left', (data) => {
        debug.log('👋 User left:', data);
        
        // Remove user from list
        this.allUsers = this.allUsers.filter(u => u.userId !== data.userId);
        this.remoteStreams.delete(data.userId);
        
        // Remove from spatial audio
        this.removeUserFromSpatialAudio(data.userId);

        // Reset call start time if everyone left
        const totalUsers = this.allUsers.length + 1; // +1 for local user
        if (totalUsers === 1) {
          debug.log('🕐 Last user left - resetting call start time');
          this.callStartTime = null;
        }

        themeStore.testAudio('voice_disconnect');
      });

      unifiedWebRTC.on('user-state-changed', (data) => {
        debug.log('🎛️ User state changed:', data);
        
        // Update user state
        const userIndex = this.allUsers.findIndex(u => u.userId === data.userId);
        if (userIndex !== -1) {
          this.allUsers[userIndex] = data.mediaState;
        }
      });

      unifiedWebRTC.on('user-stream-changed', (data) => {
        // debug.log('📹 User stream changed:', data.userId, data.stream);
        
        if (data.stream) {
          this.remoteStreams.set(data.userId, data.stream);
          // Add to spatial audio
          this.addUserToSpatialAudio(data.userId);
        } else {
          this.remoteStreams.delete(data.userId);
          // Remove from spatial audio
          this.removeUserFromSpatialAudio(data.userId);
        }
      });

      // Local events
      unifiedWebRTC.on('local-state-changed', (state) => {
        // debug.log('🎛️ Local state changed in store:', state);
        // debug.log('🗣️ Local speaking state in store:', state.isSpeaking, 'audioLevel:', state.audioLevel);
        this.localState = state;
      });
      
      unifiedWebRTC.on('local-stream-changed', (stream) => {
        // debug.log('📹 Local stream changed:', stream);
        this.localStream = stream;
      });
      
      // Handle generic stream changes (for better compatibility)
      unifiedWebRTC.on('stream-changed', (data) => {
        // debug.log('📡 Stream changed:', data.userId, data.type, data.stream);
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
      unifiedWebRTC.on('connection-state-changed', () => {
        // debug.log('🔗 Connection state changed:', data);
      });

      // Error handling
      unifiedWebRTC.on('error', (error) => {
        debug.error('❌ WebRTC error:', error);
        // Could show notification to user
      });

      // Call start time sync
      unifiedWebRTC.on('call-start-time', (data: { timestamp: string; from: string }) => {
        this.handleCallStartTime(data.timestamp);
      });

      unifiedWebRTC.on('request-call-start-time', (data: { from: string }) => {
        // Respond with our call start time if we have it
        if (this.callStartTime) {
          this.broadcastCallStartTime();
        }
      });
    },

    /**
     * Play sound effect
     */
    playSound(filename: string): void {
      try {
        const audio = new Audio(`/assets/sounds/${filename}`);
        audio.volume = 0.3;
        audio.play().catch(e => debug.log('Could not play sound:', e));
      } catch (error) {
        debug.log('Error playing sound:', error);
      }
    },

    /**
     * Broadcast call start time to all participants
     */
    broadcastCallStartTime(): void {
      if (!this.currentChannelId || !this.callStartTime) return;
      
      unifiedWebRTC.broadcastMessage({
        type: 'call-start-time',
        from: this.localState.userId,
        data: { timestamp: this.callStartTime.toISOString() },
        timestamp: Date.now()
      });
    },

    /**
     * Request call start time from existing participants
     */
    requestCallStartTime(): void {
      if (!this.currentChannelId) return;
      
      unifiedWebRTC.broadcastMessage({
        type: 'request-call-start-time',
        from: this.localState.userId,
        data: {},
        timestamp: Date.now()
      });
    },

    /**
     * Handle call start time from other participants
     */
    handleCallStartTime(timestamp: string): void {
      if (!this.callStartTime) {
        this.callStartTime = new Date(timestamp);
        debug.log('🕐 Received call start time:', this.callStartTime);
      }
    },

    /**
     * Save voice channel state to localStorage for auto-reconnect
     */
    saveVoiceChannelState(): void {
      if (this.currentChannelId && this.currentServerId) {
        const voiceState = {
          channelId: this.currentChannelId,
          serverId: this.currentServerId,
          channelName: this.currentChannelName,
          timestamp: Date.now()
        };
        localStorage.setItem('voiceChannelState', JSON.stringify(voiceState));
        debug.log('💾 Saved voice channel state for auto-reconnect');
      }
    },

    /**
     * Clear voice channel state from localStorage (manual leave)
     */
    clearVoiceChannelState(): void {
      localStorage.removeItem('voiceChannelState');
      debug.log('🗑️ Cleared voice channel state');
    },

    /**
     * Attempt to reconnect to previous voice channel
     */
    async reconnectToVoiceChannel(): Promise<boolean> {
      const savedState = localStorage.getItem('voiceChannelState');
      if (!savedState) {
        debug.log('ℹ️ No saved voice channel state found');
        return false;
      }

      try {
        const { channelId, serverId, channelName, timestamp } = JSON.parse(savedState);
        
        // Check if saved state is recent (within last 24 hours)
        const dayInMs = 24 * 60 * 60 * 1000;
        if (Date.now() - timestamp > dayInMs) {
          debug.log('⏰ Saved voice channel state too old, clearing');
          this.clearVoiceChannelState();
          return false;
        }

        debug.log('🔄 Attempting to reconnect to voice channel:', channelName);
        
        // Attempt to rejoin the channel
        const success = await this.joinVoiceChannel(channelId, serverId);
        
        if (success) {
          debug.log('✅ Successfully reconnected to voice channel');
        } else {
          debug.log('❌ Failed to reconnect, clearing saved state');
          this.clearVoiceChannelState();
        }
        
        return success;
      } catch (error) {
        debug.error('❌ Error reconnecting to voice channel:', error);
        this.clearVoiceChannelState();
        return false;
      }
    },

    /**
     * Initialize spatial audio system
     */
    async initializeSpatialAudio(userId: string): Promise<void> {
      try {
        const spatialStore = useSpatialAudioStore();
        
        // Initialize spatial audio service with direct MediaStream integration
        await spatialAudioService.initialize();
        spatialAudioService.setListener(userId);
        
        debug.log('🎧 Spatial audio initialized for user:', userId);
        
        // If spatial audio is enabled in settings, activate it now
        if (spatialStore.settings.enabled) {
          debug.log('🎧 Spatial audio is enabled in settings - activating on load...');
          
          // Initialize local user position at center
          if (!spatialStore.userPositions.has(userId)) {
            spatialStore.initializeUserPosition(userId, true); // true = isLocalUser (at center)
          }
          
          // Enable spatial audio (will start the update loop)
          await spatialAudioService.enableSpatialAudio();
          
          // IMMEDIATELY mute traditional audio to prevent double audio (dry + wet)
          // This is critical - must happen right after enabling, not in the timeout!
          unifiedWebRTC.setTraditionalAudioEnabled(false);
          debug.log('🔇 Traditional audio muted immediately after spatial audio enabled');
          
          // Wait a bit for streams to be ready, then setup spatial audio for any existing users
          // This delay is important because streams might not be immediately available on join
          setTimeout(async () => {
            const allUsers = unifiedWebRTC.getAllUsers();
            const localUserId = unifiedWebRTC.getLocalState().userId;
            
            // Setup spatial audio for existing remote users
            for (const user of allUsers) {
              if (user.userId !== localUserId) {
                // Initialize remote user position
                if (!spatialStore.userPositions.has(user.userId)) {
                  spatialStore.initializeUserPosition(user.userId, false); // false = remote user
                }
                
                // Setup spatial audio with their stream
                const userStream = unifiedWebRTC.getUserStream(user.userId);
                if (userStream) {
                  await spatialAudioService.setupSpatialForUser(user.userId, userStream);
                  debug.log(`🎧 Setup spatial audio on load for user: ${user.userId}`);
                } else {
                  debug.warn(`⚠️ Stream not ready yet for user: ${user.userId}`);
                }
              }
            }
            
            // Force spatial effects update
            spatialAudioService.updateSpatialEffects();
            
            debug.log('✅ Spatial audio activated on load with all users');
          }, 300); // 300ms delay to ensure streams are ready
        }
        
      } catch (error) {
        debug.error('Failed to initialize spatial audio:', error);
      }
    },

    /**
     * Add user to spatial audio using MediaStream directly
     */
    addUserToSpatialAudio(userId: string): void {
      // Initialize remote user position if not set (never local user here)
      const spatialStore = useSpatialAudioStore();
      if (!spatialStore.userPositions.has(userId)) {
        spatialStore.initializeUserPosition(userId, false); // false = remote user
        debug.log('🎧 Initialized position for new user:', userId);
      }
      
      // Small delay to ensure MediaStream is properly set up
      setTimeout(() => {
        // Get the MediaStream for this user from WebRTC service
        const userStream = unifiedWebRTC.getUserStream(userId);
        if (userStream) {
          spatialAudioService.setupSpatialForUser(userId, userStream);
          
          // If spatial audio is enabled, mute traditional audio for this user
          const spatialStore = useSpatialAudioStore();
          if (spatialStore.settings.enabled) {
            debug.log('🔇 Muting traditional audio for user (spatial audio active):', userId);
            unifiedWebRTC.setTraditionalAudioEnabled(false);
            
            // Force spatial effects update for new user
            spatialAudioService.updateSpatialEffects();
          }
        } else {
          debug.warn('No media stream found for user:', userId, '- retrying in 100ms');
          // Retry once more if stream isn't ready
          setTimeout(() => {
            const retryUserStream = unifiedWebRTC.getUserStream(userId);
            if (retryUserStream) {
              spatialAudioService.setupSpatialForUser(userId, retryUserStream);
              
              // Mute traditional audio if spatial is enabled
              const spatialStore = useSpatialAudioStore();
              if (spatialStore.settings.enabled) {
                debug.log('🔇 Muting traditional audio for user (spatial audio active, retry):', userId);
                unifiedWebRTC.setTraditionalAudioEnabled(false);
                
                // Force spatial effects update for new user
                spatialAudioService.updateSpatialEffects();
              }
            } else {
              debug.warn('Media stream still not found for user:', userId);
            }
          }, 100);
        }
      }, 50);
    },

    /**
     * Remove user from spatial audio
     */
    removeUserFromSpatialAudio(userId: string): void {
      spatialAudioService.removeUser(userId);
    },

    /**
     * Clean up spatial audio
     */
    cleanupSpatialAudio(): void {
      spatialAudioService.destroy();
    },

    /**
     * Reset store state
     */
    resetState(): void {
      this.currentChannelId = null;
      this.currentServerId = null;
      this.isConnected = false;
      this.sessionStartTime = null;
      this.callStartTime = null;
      this.allUsers = [];
      this.localState = {
        userId: '',
        isAudioEnabled: true,
        isVideoEnabled: false,
        isScreenSharing: false,
        isMuted: false,
        isDeafened: false,
        isSpeaking: false,
        audioLevel: 0
      };
      this.localStream = null;
      this.remoteStreams.clear();
      this.isOverlayVisible = false;
      this.viewMode = 'normal';
      this.fullscreenUserId = null;
      this.pipActive = false;
      this.pipUserId = null;
    },

    /**
     * Get user profile info - uses unified userDataService
     */
    getUserProfile(userId: string) {
      const { getUserProfile } = useUserData();
      const profile = getUserProfile(userId).value;
      
      return profile || {
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
          debug.log('🔄 Forced stream state refresh for UI reactivity');
        });
      }
    }
  }
});