import { defineStore } from 'pinia';
import { nextTick } from 'vue';
import { webrtcManager } from '@/services/webrtcManager';
import { livekitWebRTC } from '@/services/livekitWebRTC';
import type { UserMediaState } from '@/services/unifiedWebRTC';
import { spatialAudioService } from '@/services/spatialAudio';
import { useSpatialAudioStore } from '@/stores/spatialAudio';
import { useAuthStore } from '@/stores/auth';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useServerChannelStore } from './useServerChannel';
import { useThemeStore } from '@/stores/useTheme';
import { useUserData } from '@/composables/useUserData';
import { supabase } from '@/supabase';
import { debug } from '@/utils/debug';
import type { RealtimeChannel } from '@supabase/supabase-js';

// Module-level variable for cross-tab heartbeat (not reactive)
let voiceSessionHeartbeat: ReturnType<typeof setInterval> | null = null;

// =============================================================================
// TYPES
// =============================================================================

interface RecentSpeaker {
  userId: string;
  lastSpokeAt: number;
}

interface VoiceChannelState {
  // Connection info
  currentChannelId: string | null;
  currentServerId: string | null;
  currentChannelName: string | null;
  isConnected: boolean;
  sessionStartTime: Date | null; // Track when the user joined the channel
  callStartTime: Date | null; // Track when the call started (first user joined)
  
  // Federation state
  isFederatedChannel: boolean;
  federatedTokenSubscription: RealtimeChannel | null;
  pendingFederatedJoin: {
    channelId: string;
    serverId: string;
    timeout: ReturnType<typeof setTimeout> | null;
  } | null;
  
  // Users and their states
  allUsers: UserMediaState[];
  localState: UserMediaState;
  
  // Streams
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  
  // Per-user volume settings (0-200, 100 = normal)
  userVolumes: Map<string, number>;
  
  // Recent speakers (last 5 users who spoke)
  recentSpeakers: RecentSpeaker[];
  
  // UI state
  isOverlayVisible: boolean;
  layoutMode: 'grid' | 'speaker' | 'gallery';
  viewMode: 'normal' | 'maximized' | 'fullscreen';
  fullscreenUserId: string | null;
  
  // PIP state
  pipActive: boolean;
  pipUserId: string | null;
  pipMode: 'draggable' | 'fixed' | 'native';
  
  // Stream quality settings
  streamSettings: {
    resolution: number; // 720, 1080, 0 (source)
    frameRate: number; // 15, 30, 60
  };
  
  // Counter to force reactivity when streams update (Map doesn't trigger Vue reactivity well)
  streamUpdateCounter: number;
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
    
    // Federation state
    isFederatedChannel: false,
    federatedTokenSubscription: null,
    pendingFederatedJoin: null,
    
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
    
    // Per-user volume (loaded from localStorage)
    userVolumes: new Map(),
    
    // Recent speakers (last 5 users who spoke)
    recentSpeakers: [],
    
    isOverlayVisible: false,
    layoutMode: 'grid',
    viewMode: 'normal',
    fullscreenUserId: null,
    
    pipActive: false,
    pipUserId: null,
    pipMode: 'native',
    
    streamSettings: {
      resolution: 720,
      frameRate: 30
    },
    
    streamUpdateCounter: 0
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
    // Uses spread to create new object references, ensuring Vue detects changes
    allParticipants: (state) => {
      const participants = [{ ...state.localState }];
      state.allUsers.forEach(user => {
        if (user.userId !== state.localState.userId) {
          participants.push({ ...user });
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
    },

    // Get user volume (0-200, 100 = normal)
    getUserVolume: (state) => (userId: string): number => {
      return state.userVolumes.get(userId) ?? 100;
    },

    // Get recent speakers (sorted by most recent, max 5)
    getRecentSpeakers: (state) => {
      return [...state.recentSpeakers]
        .sort((a, b) => b.lastSpokeAt - a.lastSpokeAt)
        .slice(0, 5);
    },

    // Get currently speaking user IDs
    activelySpeakingUserIds: (state) => {
      const speaking: string[] = [];
      if (state.localState.audioLevel > 20 && !state.localState.isMuted) {
        speaking.push(state.localState.userId);
      }
      state.allUsers.forEach(user => {
        if (user.audioLevel > 20) {
          speaking.push(user.userId);
        }
      });
      return speaking;
    }
  },

  // =============================================================================
  // ACTIONS
  // =============================================================================
  
  actions: {
    /**
     * Join a voice channel
     * Automatically leaves any existing voice channel first
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
        
        // Check if already in the same channel
        if (this.isConnected && this.currentChannelId === channelId) {
          debug.log('⚠️ Already connected to this voice channel');
          return true;
        }
        
        // If already in a different voice channel, leave it first
        if (this.isConnected && this.currentChannelId) {
          debug.log('⚠️ Already in a voice channel, leaving first...');
          await this.leaveVoiceChannel();
        }
        
        // Check cross-tab: prevent joining if another tab is already in a voice channel
        const activeVoiceSession = localStorage.getItem('harmony-active-voice-session');
        if (activeVoiceSession) {
          const session = JSON.parse(activeVoiceSession);
          if (session.tabId !== this.getTabId() && Date.now() - session.timestamp < 5000) {
            debug.warn('⚠️ Another tab is already in a voice channel');
            throw new Error('You are already in a voice channel in another tab');
          }
        }
        
        debug.log('🎯 Joining voice channel:', channelId, 'on server:', serverId);
        
        // Check if this is a federated (remote) server
        const isRemoteServer = serverChannelStore.currentServer?.is_local_server === false;
        this.isFederatedChannel = isRemoteServer;
        
        if (isRemoteServer) {
          debug.log('🌐 Joining federated voice channel, waiting for token exchange...');
          return await this.joinFederatedVoiceChannel(channelId, serverId, userId);
        }
        
        // Local server join flow
        return await this.joinLocalVoiceChannel(channelId, serverId, userId);
      } catch (error) {
        debug.error('❌ Failed to join voice channel:', error);
        return false;
      }
    },
    
    /**
     * Join a local (non-federated) voice channel
     */
    async joinLocalVoiceChannel(channelId: string, serverId: string, userId: string): Promise<boolean> {
      const serverUsersStore = useServerUsersStore();
      const serverChannelStore = useServerChannelStore();
      const themeStore = useThemeStore();
      
      // Update server presence first (isLocalServer = true for local channels)
      const presenceSuccess = await serverUsersStore.joinVoiceChannel(serverId, channelId, userId, true);
      if (!presenceSuccess) {
        throw new Error('Failed to update server presence');
      }
      
      // Setup WebRTC event listeners before joining
      this.setupWebRTCListeners();
      
      // Determine room type: DM calls use 'dm_call', server channels use 'voice_channel'
      const roomType = serverId === 'dm' ? 'dm_call' : 'voice_channel';
      
      // Join WebRTC channel (uses LiveKit SFU or P2P based on config)
      const webrtcSuccess = await webrtcManager.joinChannel(channelId, userId, roomType);
      if (!webrtcSuccess) {
        // Rollback server presence
        await serverUsersStore.leaveVoiceChannel(serverId, channelId, userId);
        throw new Error('Failed to join WebRTC channel');
      }
      
      debug.log(`🔌 [VoiceChannel] Connected via ${webrtcManager.getActiveService()?.toUpperCase() || 'unknown'} mode (${roomType})`);
      
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
      
      // Start cross-tab session heartbeat
      this.startVoiceSessionHeartbeat();
      
      // Check if anyone else is in the channel to determine if we're starting the call
      // We'll set call start time after channel state sync
      
      // Get fresh state from WebRTC service
      const newLocalState = webrtcManager.getLocalState();
      
      // Apply any preemptive mute/deafen state
      if (this.localState.isMuted && !newLocalState.isMuted) {
        debug.log('Applying preemptive mute state');
        webrtcManager.toggleMute();
      }
      if (this.localState.isDeafened && !newLocalState.isDeafened) {
        debug.log('Applying preemptive deafen state');
        webrtcManager.toggleDeafen();
      }
      
      // Update state after applying preemptive settings
      this.localState = webrtcManager.getLocalState();
      this.localStream = webrtcManager.getLocalStream();
      
      // Initialize spatial audio
      await this.initializeSpatialAudio(userId);
      
      // Don't reset isOverlayVisible here - it may have been set to true
      // by event handlers (user-joined, user-state-changed) that detected
      // existing video/screenshare. Let the event handlers control this.
      
      // Play join sound
      themeStore.testAudio('voice_connect');
      
      return true;
    },
    
    /**
     * Join a federated (remote server) voice channel
     * This triggers a VoiceChannelJoin activity to be sent via ActivityPub,
     * and waits for the VoiceChannelJoinAccept response with the LiveKit token.
     */
    async joinFederatedVoiceChannel(channelId: string, serverId: string, userId: string): Promise<boolean> {
      const serverUsersStore = useServerUsersStore();
      const serverChannelStore = useServerChannelStore();
      const themeStore = useThemeStore();
      
      return new Promise((resolve, reject) => {
        // Set up listener for federated voice token
        const channelName = `federated-voice:${userId}`;
        
        debug.log('🔔 Subscribing to federated voice token channel:', channelName);
        
        this.federatedTokenSubscription = supabase
          .channel(channelName)
          .on('broadcast', { event: 'voice-token-received' }, async (payload) => {
            debug.log('✅ Received federated voice token:', payload);
            
            // Clear pending state and timeout
            if (this.pendingFederatedJoin?.timeout) {
              clearTimeout(this.pendingFederatedJoin.timeout);
            }
            this.pendingFederatedJoin = null;
            
            // Extract token data
            const { livekitUrl, token, roomName } = payload.payload;
            
            try {
              // Setup WebRTC event listeners before joining
              this.setupWebRTCListeners();
              
              // Connect directly to remote LiveKit using the provided token
              const success = await livekitWebRTC.joinWithToken(livekitUrl, token, channelId, userId);
              
              if (!success) {
                throw new Error('Failed to connect to remote LiveKit server');
              }
              
              debug.log('🔌 [VoiceChannel] Connected to federated voice channel via LiveKit');
              
              // Update store state
              this.currentChannelId = channelId;
              this.currentServerId = serverId;
              const channel = serverChannelStore.channels.find((c: any) => c.id === channelId);
              this.currentChannelName = channel ? channel.name : 'Voice Channel';
              this.isConnected = true;
              this.sessionStartTime = new Date();
              this.callStartTime = new Date();
              
              // Save voice channel state
              this.saveVoiceChannelState();
              this.startVoiceSessionHeartbeat();
              
              // Update state
              this.localState = webrtcManager.getLocalState();
              this.localStream = webrtcManager.getLocalStream();
              
              // Play join sound
              themeStore.testAudio('voice_connect');
              
              resolve(true);
            } catch (error) {
              debug.error('Failed to connect with federated token:', error);
              this.cleanupFederatedSubscription();
              reject(error);
            }
          })
          .on('broadcast', { event: 'voice-join-rejected' }, (payload) => {
            debug.error('❌ Voice join rejected:', payload.payload);
            
            // Clear pending state
            if (this.pendingFederatedJoin?.timeout) {
              clearTimeout(this.pendingFederatedJoin.timeout);
            }
            this.pendingFederatedJoin = null;
            this.cleanupFederatedSubscription();
            
            reject(new Error(payload.payload.reason || 'Voice join rejected by remote server'));
          })
          .subscribe((status) => {
            debug.log(`📡 Federated voice subscription status: ${status}`);
          });
        
        // Call federation-backend to send VoiceChannelJoin activity
        // For remote servers, we don't write to local DB - the remote instance handles that
        const session = await supabase.auth.getSession();
        if (!session.data.session) {
          this.cleanupFederatedSubscription();
          reject(new Error('Not authenticated'));
          return;
        }
        
        fetch('/api/federation/voice/join', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.data.session.access_token}`,
          },
          body: JSON.stringify({ channelId, serverId }),
        })
          .then(async (response) => {
            if (!response.ok) {
              const error = await response.json().catch(() => ({ error: 'Unknown error' }));
              throw new Error(error.error || 'Failed to send voice join request');
            }
            debug.log('📡 Voice join request sent to federation backend');
            
            // Update local presence state (but don't write to DB)
            serverUsersStore.joinVoiceChannel(serverId, channelId, userId, false);
          })
          .catch((error) => {
            this.cleanupFederatedSubscription();
            reject(error);
          });
        
        // Set timeout for token response (30 seconds)
        const timeout = setTimeout(() => {
          debug.error('❌ Timeout waiting for federated voice token');
          this.pendingFederatedJoin = null;
          this.cleanupFederatedSubscription();
          serverUsersStore.leaveVoiceChannel(serverId, channelId, userId);
          reject(new Error('Timeout waiting for voice connection to remote server'));
        }, 30000);
        
        this.pendingFederatedJoin = { channelId, serverId, timeout };
      });
    },
    
    /**
     * Clean up federated voice subscription
     */
    cleanupFederatedSubscription() {
      if (this.federatedTokenSubscription) {
        this.federatedTokenSubscription.unsubscribe();
        this.federatedTokenSubscription = null;
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
        const wasFederated = this.isFederatedChannel;
        const channelId = this.currentChannelId;
        const serverId = this.currentServerId;
        
        debug.log('👋 Leaving voice channel', wasFederated ? '(federated)' : '(local)');
        
        // Clean up federated subscription if active
        this.cleanupFederatedSubscription();
        if (this.pendingFederatedJoin?.timeout) {
          clearTimeout(this.pendingFederatedJoin.timeout);
          this.pendingFederatedJoin = null;
        }
        
        // Clear saved voice channel state (user manually left)
        this.clearVoiceChannelState();
        
        // Leave WebRTC first
        await webrtcManager.leaveChannel();

        // Clean up spatial audio
        this.cleanupSpatialAudio();
        
        // Update server presence
        if (serverId && channelId) {
          // For federated channels, also notify the remote server
          if (wasFederated) {
            const session = await supabase.auth.getSession();
            if (session.data.session) {
              fetch('/api/federation/voice/leave', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${session.data.session.access_token}`,
                },
                body: JSON.stringify({ channelId, serverId }),
              }).catch((error) => {
                debug.warn('Failed to send federated voice leave:', error);
              });
            }
          }
          
          // Update local state (isLocalServer = !wasFederated)
          await serverUsersStore.leaveVoiceChannel(serverId, channelId, userId, !wasFederated);
        }
        
        // Reset state
        this.isFederatedChannel = false;
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
      const enabled = await webrtcManager.toggleVideo();
      
      // Force sync with WebRTC service state
      this.localState = webrtcManager.getLocalState();
      this.localStream = webrtcManager.getLocalStream();
      
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
      const enabled = await webrtcManager.toggleScreenShare();
      const themeStore = useThemeStore();
      
      // Force sync with WebRTC service state
      this.localState = webrtcManager.getLocalState();
      this.localStream = webrtcManager.getLocalStream();
      
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
        const muted = webrtcManager.toggleMute();
        this.localState = webrtcManager.getLocalState();
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
        const deafened = webrtcManager.toggleDeafen();
        this.localState = webrtcManager.getLocalState();
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
     * Attach video track to a video element using LiveKit's proper method.
     * This is REQUIRED for adaptive streaming to work - using srcObject directly
     * causes LiveKit to disable all simulcast layers (frozen video).
     */
    attachVideoToElement(userId: string, videoElement: HTMLVideoElement): boolean {
      return webrtcManager.attachVideoToElement(userId, videoElement);
    },

    /**
     * Detach video from element
     */
    detachVideoFromElement(userId: string, videoElement: HTMLVideoElement): void {
      webrtcManager.detachVideoFromElement(userId, videoElement);
    },

    /**
     * Update stream quality settings (resolution/framerate)
     * Applies to camera and screenshare
     */
    async updateStreamQuality(settings: { resolution?: number; frameRate?: number }): Promise<void> {
      const newSettings = { ...this.streamSettings, ...settings };
      this.streamSettings = newSettings;
      
      debug.log('🎬 Updating stream quality:', newSettings);
      
      // Apply to active video/screenshare if any
      if (this.localState.isVideoEnabled || this.localState.isScreenSharing) {
        try {
          await webrtcManager.updateStreamQuality?.(newSettings);
          debug.log('✅ Stream quality updated');
        } catch (error) {
          debug.error('❌ Failed to update stream quality:', error);
        }
      }
      
      // Persist settings
      try {
        localStorage.setItem('harmony-stream-settings', JSON.stringify(newSettings));
      } catch (error) {
        debug.warn('Failed to save stream settings:', error);
      }
    },

    /**
     * Load stream settings from localStorage
     */
    loadStreamSettings(): void {
      try {
        const saved = localStorage.getItem('harmony-stream-settings');
        if (saved) {
          const settings = JSON.parse(saved);
          // Handle -1 (source/native) as valid, only default if truly undefined
          this.streamSettings = {
            resolution: settings.resolution !== undefined ? settings.resolution : 720,
            frameRate: settings.frameRate || 30
          };
        }
      } catch (error) {
        debug.warn('Failed to load stream settings:', error);
      }
    },

    /**
     * Set per-user volume (0-200, 100 = normal)
     * Persisted to localStorage and applied to audio
     */
    setUserVolume(userId: string, volume: number): void {
      // Clamp volume to valid range
      const clampedVolume = Math.max(0, Math.min(200, volume));
      this.userVolumes.set(userId, clampedVolume);
      
      // Apply volume to the user's audio stream
      webrtcManager.setUserVolume?.(userId, clampedVolume / 100);
      
      // Persist to localStorage
      this.saveUserVolumes();
      
      debug.log(`🔊 Set volume for user ${userId}: ${clampedVolume}%`);
    },

    /**
     * Save user volumes to localStorage
     */
    saveUserVolumes(): void {
      try {
        const volumeObj: Record<string, number> = {};
        this.userVolumes.forEach((volume, odUserId) => {
          volumeObj[odUserId] = volume;
        });
        localStorage.setItem('harmony-user-volumes', JSON.stringify(volumeObj));
      } catch (error) {
        debug.warn('Failed to save user volumes:', error);
      }
    },

    /**
     * Load user volumes from localStorage
     */
    loadUserVolumes(): void {
      try {
        const saved = localStorage.getItem('harmony-user-volumes');
        if (saved) {
          const volumeObj = JSON.parse(saved) as Record<string, number>;
          Object.entries(volumeObj).forEach(([odUserId, volume]) => {
            this.userVolumes.set(odUserId, volume);
          });
          debug.log('🔊 Loaded user volumes from localStorage');
        }
      } catch (error) {
        debug.warn('Failed to load user volumes:', error);
      }
    },

    /**
     * Update recent speakers list when someone speaks
     */
    updateRecentSpeakers(userId: string): void {
      const now = Date.now();
      const existingIndex = this.recentSpeakers.findIndex(s => s.userId === userId);
      
      if (existingIndex !== -1) {
        // Update timestamp for existing speaker
        this.recentSpeakers[existingIndex].lastSpokeAt = now;
      } else {
        // Add new speaker
        this.recentSpeakers.push({ userId, lastSpokeAt: now });
        
        // Keep only the last 10 speakers (we display 5, but keep more for rotation)
        if (this.recentSpeakers.length > 10) {
          this.recentSpeakers.sort((a, b) => b.lastSpokeAt - a.lastSpokeAt);
          this.recentSpeakers = this.recentSpeakers.slice(0, 10);
        }
      }
    },

    /**
     * Clear recent speakers (when leaving channel)
     */
    clearRecentSpeakers(): void {
      this.recentSpeakers = [];
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
      webrtcManager.on('channel-joined', (data) => {
        debug.log('✅ Channel joined:', data);
      });

      webrtcManager.on('channel-left', (data) => {
        debug.log('👋 Channel left:', data);
      });

      webrtcManager.on('channel-state-synced', async (data) => {
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
      webrtcManager.on('user-joined', async (data) => {
        debug.log('👋 User joined:', data);
        
        // Add user if not already in list
        const existingIndex = this.allUsers.findIndex(u => u.userId === data.userId);
        if (existingIndex === -1) {
          this.allUsers.push(data.mediaState);
        } else {
          this.allUsers[existingIndex] = data.mediaState;
        }

        // Auto-open overlay if joining user has video/screenshare (for late-joiners seeing existing streams)
        if (data.mediaState?.isVideoEnabled || data.mediaState?.isScreenSharing) {
          if (!this.isOverlayVisible) {
            this.isOverlayVisible = true;
            debug.log('📺 Auto-opening overlay - existing video/screenshare user detected:', data.userId);
          }
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

      webrtcManager.on('user-left', (data) => {
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

      webrtcManager.on('user-state-changed', (data) => {
        debug.log('🎛️ User state changed:', data, 'isVideoEnabled:', data.mediaState?.isVideoEnabled);
        
        // Update user state
        const userIndex = this.allUsers.findIndex(u => u.userId === data.userId);
        if (userIndex !== -1) {
          // Direct assignment - Vue 3/Pinia should handle reactivity
          this.allUsers[userIndex] = data.mediaState;
        } else if (data.mediaState && data.mediaState.userId) {
          // User not in list yet - add them
          debug.log('➕ User not in list, adding:', data.userId);
          this.allUsers.push(data.mediaState);
        }
        
        // Force reactivity by incrementing counter
        this.streamUpdateCounter = (this.streamUpdateCounter || 0) + 1;
        
        // NOTE: Don't auto-open overlay here - this fires on every state change
        // Auto-open only happens in user-joined for initial sync when joining
      });

      webrtcManager.on('user-stream-changed', (data) => {
        debug.log('📹 User stream changed:', data.userId, 'hasStream:', !!data.stream);
        
        if (data.stream) {
          this.remoteStreams.set(data.userId, data.stream);
          // Add to spatial audio
          this.addUserToSpatialAudio(data.userId);
        } else {
          this.remoteStreams.delete(data.userId);
          // Remove from spatial audio
          this.removeUserFromSpatialAudio(data.userId);
        }
        
        // Force reactivity update by incrementing a counter
        this.streamUpdateCounter = (this.streamUpdateCounter || 0) + 1;
      });

      // Local events
      webrtcManager.on('local-state-changed', (state) => {
        debug.log('🎛️ Local state changed in store:', {
          isVideoEnabled: state.isVideoEnabled,
          isScreenSharing: state.isScreenSharing,
          isMuted: state.isMuted
        });
        this.localState = state;
      });
      
      webrtcManager.on('local-stream-changed', (stream) => {
        // debug.log('📹 Local stream changed:', stream);
        this.localStream = stream;
      });
      
      // Handle generic stream changes (for better compatibility)
      webrtcManager.on('stream-changed', (data) => {
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
      webrtcManager.on('audio-level', (data) => {
        if (data.userId === this.localState.userId) {
          this.localState.audioLevel = data.level;
          // Track recent speakers when audio level exceeds threshold
          if (data.level > 20 && !this.localState.isMuted) {
            this.updateRecentSpeakers(data.userId);
          }
        } else {
          const user = this.allUsers.find(u => u.userId === data.userId);
          if (user) {
            user.audioLevel = data.level;
            // Track recent speakers when audio level exceeds threshold
            if (data.level > 20) {
              this.updateRecentSpeakers(data.userId);
            }
          }
        }
      });

      // Connection events
      webrtcManager.on('connection-state-changed', () => {
        // debug.log('🔗 Connection state changed:', data);
      });

      // Error handling
      webrtcManager.on('error', (error) => {
        debug.error('❌ WebRTC error:', error);
        // Could show notification to user
      });

      // Call start time sync
      webrtcManager.on('call-start-time', (data: { timestamp: string; from: string }) => {
        this.handleCallStartTime(data.timestamp);
      });

      webrtcManager.on('request-call-start-time', (data: { from: string }) => {
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
      
      webrtcManager.broadcastMessage({
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
      
      webrtcManager.broadcastMessage({
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
     * Get unique tab ID (persistent for this tab session)
     */
    getTabId(): string {
      let tabId = sessionStorage.getItem('harmony-tab-id');
      if (!tabId) {
        tabId = `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        sessionStorage.setItem('harmony-tab-id', tabId);
      }
      return tabId;
    },

    /**
     * Save voice channel state to localStorage for auto-reconnect
     * Also tracks active voice session for cross-tab prevention
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
        
        // Track active voice session for cross-tab prevention
        const activeSession = {
          tabId: this.getTabId(),
          channelId: this.currentChannelId,
          timestamp: Date.now()
        };
        localStorage.setItem('harmony-active-voice-session', JSON.stringify(activeSession));
        
        debug.log('💾 Saved voice channel state for auto-reconnect');
      }
    },

    /**
     * Start heartbeat to maintain cross-tab session
     */
    startVoiceSessionHeartbeat(): void {
      // Stop any existing heartbeat first
      this.stopVoiceSessionHeartbeat();
      
      // Update session timestamp every 2 seconds
      voiceSessionHeartbeat = setInterval(() => {
        if (this.isConnected && this.currentChannelId) {
          const activeSession = {
            tabId: this.getTabId(),
            channelId: this.currentChannelId,
            timestamp: Date.now()
          };
          localStorage.setItem('harmony-active-voice-session', JSON.stringify(activeSession));
        }
      }, 2000);
    },

    /**
     * Stop heartbeat
     */
    stopVoiceSessionHeartbeat(): void {
      if (voiceSessionHeartbeat) {
        clearInterval(voiceSessionHeartbeat);
        voiceSessionHeartbeat = null;
      }
    },

    /**
     * Clear voice channel state from localStorage (manual leave)
     */
    clearVoiceChannelState(): void {
      localStorage.removeItem('voiceChannelState');
      localStorage.removeItem('harmony-active-voice-session');
      this.stopVoiceSessionHeartbeat();
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
          webrtcManager.setTraditionalAudioEnabled(false);
          debug.log('🔇 Traditional audio muted immediately after spatial audio enabled');
          
          // Wait a bit for streams to be ready, then setup spatial audio for any existing users
          // This delay is important because streams might not be immediately available on join
          setTimeout(async () => {
            const allUsers = webrtcManager.getAllUsers();
            const localUserId = webrtcManager.getLocalState().userId;
            
            // Setup spatial audio for existing remote users
            for (const user of allUsers) {
              if (user.userId !== localUserId) {
                // Initialize remote user position
                if (!spatialStore.userPositions.has(user.userId)) {
                  spatialStore.initializeUserPosition(user.userId, false); // false = remote user
                }
                
                // Setup spatial audio with their stream
                const userStream = webrtcManager.getUserStream(user.userId);
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
        const userStream = webrtcManager.getUserStream(userId);
        if (userStream) {
          spatialAudioService.setupSpatialForUser(userId, userStream);
          
          // If spatial audio is enabled, mute traditional audio for this user
          const spatialStore = useSpatialAudioStore();
          if (spatialStore.settings.enabled) {
            debug.log('🔇 Muting traditional audio for user (spatial audio active):', userId);
            webrtcManager.setTraditionalAudioEnabled(false);
            
            // Force spatial effects update for new user
            spatialAudioService.updateSpatialEffects();
          }
        } else {
          debug.warn('No media stream found for user:', userId, '- retrying in 100ms');
          // Retry once more if stream isn't ready
          setTimeout(() => {
            const retryUserStream = webrtcManager.getUserStream(userId);
            if (retryUserStream) {
              spatialAudioService.setupSpatialForUser(userId, retryUserStream);
              
              // Mute traditional audio if spatial is enabled
              const spatialStore = useSpatialAudioStore();
              if (spatialStore.settings.enabled) {
                debug.log('🔇 Muting traditional audio for user (spatial audio active, retry):', userId);
                webrtcManager.setTraditionalAudioEnabled(false);
                
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
      const currentStream = webrtcManager.getLocalStream();
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