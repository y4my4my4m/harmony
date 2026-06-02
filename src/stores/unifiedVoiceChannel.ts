import { defineStore } from 'pinia';
import { nextTick } from 'vue';
import { webrtcManager } from '@/services/webrtcManager';
import type { UserMediaState } from '@/services/unifiedWebRTC';
import { spatialAudioService } from '@/services/spatialAudio';
import { dmCallSignaling } from '@/services/DMCallSignaling';
import { useSpatialAudioStore } from '@/stores/spatialAudio';
import { useAuthStore } from '@/stores/auth';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useServerChannelStore } from './useServerChannel';
import { useThemeStore } from '@/stores/useTheme';
import { useNotificationStore } from '@/stores/useNotification';
import { useUserData } from '@/composables/useUserData';
import { useKeybinds } from '@/composables/useKeybinds';
import { voiceE2EEService } from '@/services/encryption/VoiceE2EEService';
import { supabase } from '@/supabase';
import { debug } from '@/utils/debug';
import { userStorage } from '@/utils/userScopedStorage';
import type { RealtimeChannel } from '@supabase/supabase-js';

// Module-level variable for cross-tab heartbeat (not reactive)
let voiceSessionHeartbeat: ReturnType<typeof setInterval> | null = null;

// Module-level keybind state management
let keybindListenersSetup = false;

// Prevent duplicate WebRTC event listener registration
let webrtcListenersRegistered = false;

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
  dmOtherUserId: string | null; // For DM calls: the other user's profile ID (for DisplayName rendering)
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
  
  // Connection state to prevent double-joining
  isConnecting: boolean;
  connectionAbortController: AbortController | null; // For cancelling connection attempts
  
  // Optimistic UI state - show UI immediately while connecting
  optimisticChannelId: string | null;
  optimisticServerId: string | null;
  optimisticChannelName: string | null;
  
  // Users and their states
  allUsers: UserMediaState[];
  localState: UserMediaState;
  
  // Streams
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  
  // Per-user volume settings (0-200, 100 = normal)
  userVolumes: Map<string, number>;
  userScreenShareVolumes: Map<string, number>;
  
  // Recent speakers (last 5 users who spoke)
  recentSpeakers: RecentSpeaker[];
  
  // UI state
  isOverlayVisible: boolean;
  layoutMode: 'grid' | 'speaker' | 'gallery';
  viewMode: 'normal' | 'maximized' | 'fullscreen';
  fullscreenUserId: string | null;
  isFullWindowMode: boolean; // Stream fills entire viewport in fullscreen mode
  
  // PIP state
  pipActive: boolean;
  pipUserId: string | null;
  pipMode: 'draggable' | 'fixed' | 'native';
  
  // Stream quality settings
  streamSettings: {
    resolution: number; // 720, 1080, -1 (source)
    frameRate: number; // 15, 30, 60
    audioBitrate: number; // 64, 128, 256 (kbps)
  };
  
  // Counter to force reactivity when streams update (Map doesn't trigger Vue reactivity well)
  streamUpdateCounter: number;
  
  // Active WebRTC transport ('livekit' for SFU, 'p2p' for peer-to-peer, null when disconnected)
  connectionMode: 'livekit' | 'p2p' | null;

  // Whether the active call's media is end-to-end encrypted (SFU/LiveKit only for now).
  isEncrypted: boolean;

  // Cache of the last-seen voice-channel user IDs, used to short-circuit
  // `ensureProfilesAvailable` when the membership list has not changed.
  previousUserIds: string[];
}

// =============================================================================
// STORE
// =============================================================================

export const useUnifiedVoiceChannelStore = defineStore('unifiedVoiceChannel', {
  state: (): VoiceChannelState => ({
    currentChannelId: null,
    currentServerId: null,
    isConnected: false,
    isConnecting: false,
    connectionAbortController: null,
    currentChannelName: null,
    dmOtherUserId: null,
    sessionStartTime: null,
    callStartTime: null,
    
    // Optimistic UI state
    optimisticChannelId: null,
    optimisticServerId: null,
    optimisticChannelName: null,
    
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
    userScreenShareVolumes: new Map(),
    
    // Recent speakers (last 5 users who spoke)
    recentSpeakers: [],
    
    isOverlayVisible: false,
    layoutMode: 'grid',
    viewMode: 'normal',
    fullscreenUserId: null,
    isFullWindowMode: false,
    
    pipActive: false,
    pipUserId: null,
    pipMode: 'native',
    
    streamSettings: {
      resolution: 720,
      frameRate: 30,
      audioBitrate: 128
    },
    
    streamUpdateCounter: 0,
    
    connectionMode: null,
    isEncrypted: false,

    previousUserIds: [],
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
    // Returns stable references to avoid reactivity loops
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

    // Optimistic connection state - true if connected or optimistically joining
    isConnectedOrJoining: (state) => {
      return state.isConnected || state.optimisticChannelId !== null;
    },
    
    // Effective channel ID (optimistic or real)
    effectiveChannelId: (state) => {
      return state.currentChannelId || state.optimisticChannelId;
    },
    
    // Effective server ID (optimistic or real)
    effectiveServerId: (state) => {
      return state.currentServerId || state.optimisticServerId;
    },
    
    // Effective channel name (optimistic or real)
    effectiveChannelName: (state) => {
      return state.currentChannelName || state.optimisticChannelName;
    },

    // Connection stats
    connectionStats: (state) => {
      const total = state.allUsers.length + 1; // +1 for self
      const withVideo = state.allUsers.filter(u => u.isVideoEnabled).length + (state.localState.isVideoEnabled ? 1 : 0);
      const speaking = state.allUsers.filter(u => u.audioLevel > 20).length + (state.localState.audioLevel > 20 ? 1 : 0);
      
      return { total, withVideo, speaking };
    },

    // Get user mic volume (0-200, 100 = normal)
    getUserVolume: (state) => (userId: string): number => {
      return state.userVolumes.get(userId) ?? 100;
    },
    
    // Get user screenshare volume (0-200, 100 = normal)
    getUserScreenShareVolume: (state) => (userId: string): number => {
      return state.userScreenShareVolumes.get(userId) ?? 100;
    },
    
    // Check if user has screenshare audio
    hasScreenShareAudio: () => (userId: string): boolean => {
      return webrtcManager.hasScreenShareAudio(userId);
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
    },
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
        const serverChannelStore = useServerChannelStore();

        if (!authStore.session?.user) {
          throw new Error('User not authenticated');
        }
        
        const userId = authStore.session.user.id;
        
        // Prevent double-joining while connecting
        if (this.isConnecting) {
          debug.log('⚠️ Already attempting to connect, please wait...');
          return false;
        }
        
        // Check if already in the same channel
        if (this.isConnected && this.currentChannelId === channelId) {
          debug.log('⚠️ Already connected to this voice channel');
          return true;
        }
        
        // If already in a different voice channel, leave it first.
        // Must happen BEFORE setting isConnecting/abort controller, otherwise
        // leaveVoiceChannel enters the "cancel ongoing connection" path.
        if (this.isConnected && this.currentChannelId) {
          debug.log('⚠️ Already in a voice channel, leaving first...');
          const leaveOk = await this.leaveVoiceChannel();
          if (!leaveOk) {
            debug.warn('⚠️ leaveVoiceChannel returned false - forcing cleanup');
            await webrtcManager.leaveChannel();
            this.resetState();
          }
        }
        
        // Create abort controller for this connection attempt
        this.connectionAbortController = new AbortController();
        const abortSignal = this.connectionAbortController.signal;
        
        // Set optimistic state for instant UI feedback
        const channel = serverChannelStore.channels.find((c: any) => c.id === channelId);
        this.optimisticChannelId = channelId;
        this.optimisticServerId = serverId;
        this.optimisticChannelName = channel?.name || 'Voice Channel';
        this.isConnecting = true;
        
        debug.log('🎯 [Optimistic] Voice dock should be visible now for:', channelId);
        
        // Check cross-tab: prevent joining if another tab is already in a voice channel
        const activeVoiceSession = userStorage.getItem('active-voice-session');
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
          return await this.joinFederatedVoiceChannel(channelId, serverId, userId, abortSignal);
        }
        
        // Local server join flow
        return await this.joinLocalVoiceChannel(channelId, serverId, userId, abortSignal);
      } catch (error) {
        // Check if this was a cancellation
        if (error instanceof Error && error.name === 'AbortError') {
          debug.log('🚫 Connection attempt cancelled by user');
          return false;
        }
        
        debug.error('❌ Failed to join voice channel:', error);
        this.isConnecting = false; // Reset on failure
        this.connectionAbortController = null;
        // Clear optimistic state on failure
        this.optimisticChannelId = null;
        this.optimisticServerId = null;
        this.optimisticChannelName = null;
        return false;
      }
    },
    
    /**
     * Resolve whether a server mandates E2E-encrypted voice/video.
     * DM calls (serverId === 'dm') have no server policy and default to off.
     */
    async resolveVoiceE2EERequired(serverId: string): Promise<boolean> {
      if (!serverId || serverId === 'dm') return false;
      try {
        const { data, error } = await supabase
          .from('server_encryption_settings')
          .select('voice_encryption_mode')
          .eq('server_id', serverId)
          .maybeSingle();
        if (error) {
          debug.warn('⚠️ [VoiceChannel] Failed to read voice_encryption_mode:', error);
          return false;
        }
        return data?.voice_encryption_mode === 'required';
      } catch (err) {
        debug.warn('⚠️ [VoiceChannel] resolveVoiceE2EERequired error:', err);
        return false;
      }
    },
    
    /**
     * Join a local (non-federated) voice channel
     */
    async joinLocalVoiceChannel(channelId: string, serverId: string, userId: string, abortSignal?: AbortSignal): Promise<boolean> {
      const serverUsersStore = useServerUsersStore();
      const serverChannelStore = useServerChannelStore();
      
      // Update server presence first (isLocalServer = true for local channels)
      const presenceSuccess = await serverUsersStore.joinVoiceChannel(serverId, channelId, userId, true);
      if (!presenceSuccess) {
        throw new Error('Failed to update server presence');
      }
      
      // Check for cancellation before proceeding
      if (abortSignal?.aborted) {
        await serverUsersStore.leaveVoiceChannel(serverId, channelId, userId);
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      // Setup WebRTC event listeners before joining
      this.setupWebRTCListeners();
      
      // Determine room type: DM calls use 'dm_call', server channels use 'voice_channel'
      const roomType = serverId === 'dm' ? 'dm_call' : 'voice_channel';
      
      // Resolve whether this server requires E2E-encrypted voice. If it does and
      // this client can't participate (no encryption set up / locked), refuse the
      // join with a clear message rather than dropping into a plaintext call.
      const requireE2EE = await this.resolveVoiceE2EERequired(serverId);
      if (requireE2EE && !voiceE2EEService.canParticipate()) {
        await serverUsersStore.leaveVoiceChannel(serverId, channelId, userId);
        useNotificationStore().showToast(
          'server_update',
          'End-to-end encryption required',
          'This channel requires encrypted voice. Set up encryption (and unlock it) to join.',
          6000
        );
        throw new Error('Voice E2EE required but not available on this device');
      }
      
      // Join WebRTC channel (uses LiveKit SFU or P2P based on config)
      // Pass abort signal to allow cancellation
      const webrtcSuccess = await webrtcManager.joinChannel(channelId, userId, roomType, abortSignal, requireE2EE);
      
      // Check for cancellation after join attempt
      if (abortSignal?.aborted) {
        if (webrtcSuccess) {
          // If we connected but then cancelled, leave immediately
          await webrtcManager.leaveChannel();
        }
        await serverUsersStore.leaveVoiceChannel(serverId, channelId, userId);
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      if (!webrtcSuccess) {
        // Rollback server presence
        await serverUsersStore.leaveVoiceChannel(serverId, channelId, userId);
        throw new Error('Failed to join WebRTC channel');
      }
      
      this.connectionMode = webrtcManager.getActiveService();
      this.isEncrypted = webrtcManager.isE2EEEnabled();
      debug.log(`🔌 [VoiceChannel] Connected via ${this.connectionMode?.toUpperCase() || 'unknown'} mode (${roomType}), E2EE: ${this.isEncrypted}`);
      
      // Final cancellation check before marking as connected
      if (abortSignal?.aborted) {
        await webrtcManager.leaveChannel();
        await serverUsersStore.leaveVoiceChannel(serverId, channelId, userId);
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      // Update store state
      this.currentChannelId = channelId;
      this.currentServerId = serverId;
      // For DM calls, derive name from the conversation; for server channels, use serverChannelStore
      const isDMChannel = serverId === 'dm' && (channelId.startsWith('dm-') || channelId.startsWith('federated-dm-'));
      if (isDMChannel) {
        let conversationId: string;
        const federatedMatch = channelId.match(/^federated-dm-([a-f0-9-]{36})/i);
        if (federatedMatch) {
          conversationId = federatedMatch[1];
        } else {
          conversationId = channelId.replace('dm-', '');
        }
        const { useDMStore } = await import('@/stores/useDM');
        const dmStore = useDMStore();
        const conv = dmStore.conversations.find((c: any) => c.id === conversationId);
        this.dmOtherUserId = conv?.other_user?.id || null;
        this.currentChannelName = conv?.name
          || conv?.other_user?.display_name
          || conv?.other_user?.username
          || 'DM Call';
      } else {
        this.dmOtherUserId = null;
        this.currentChannelName = (serverChannelStore as any).getChannelNameById?.(channelId) || 'Voice Channel';
      }
      this.isConnected = true;
      this.isConnecting = false; // Connection attempt complete
      this.connectionAbortController = null; // Clear abort controller on success
      this.sessionStartTime = new Date(); // Track when user joined
      
      // Clear optimistic state - real connection is established
      this.optimisticChannelId = null;
      this.optimisticServerId = null;
      this.optimisticChannelName = null;
      
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
      
      // Initialize Push-to-Talk
      this.setupPushToTalk();
      
      // Don't reset isOverlayVisible here - it may have been set to true
      // by event handlers (user-joined, user-state-changed) that detected
      // existing video/screenshare. Let the event handlers control this.
      
      // Note: Join sound is now played immediately in ChannelSidebar for optimistic UX
      // Don't play it again here to avoid duplicate sounds
      
      return true;
    },
    
    /**
     * Join a federated (remote server) voice channel
     * This triggers a VoiceChannelJoin activity to be sent via ActivityPub,
     * and waits for the VoiceChannelJoinAccept response with the LiveKit token.
     */
    async joinFederatedVoiceChannel(channelId: string, serverId: string, userId: string, abortSignal?: AbortSignal): Promise<boolean> {
      const serverUsersStore = useServerUsersStore();
      const serverChannelStore = useServerChannelStore();
      
      return new Promise((resolve, reject) => {
        // Check for cancellation before starting
        if (abortSignal?.aborted) {
          reject(new DOMException('Connection cancelled', 'AbortError'));
          return;
        }
        
        // Set up abort listener
        const abortHandler = () => {
          debug.log('🚫 Federated connection attempt cancelled');
          if (this.pendingFederatedJoin?.timeout) {
            clearTimeout(this.pendingFederatedJoin.timeout);
          }
          this.pendingFederatedJoin = null;
          this.cleanupFederatedSubscription();
          this.isConnecting = false;
          this.connectionAbortController = null;
          this.optimisticChannelId = null;
          this.optimisticServerId = null;
          this.optimisticChannelName = null;
          reject(new DOMException('Connection cancelled', 'AbortError'));
        };
        
        if (abortSignal) {
          abortSignal.addEventListener('abort', abortHandler);
        }
        
        // Set up listener for federated voice token
        const channelName = `federated-voice:${userId}`;
        
        debug.log('🔔 Subscribing to federated voice token channel:', channelName);
        
        this.federatedTokenSubscription = supabase
          .channel(channelName)
          .on('broadcast', { event: 'voice-token-received' }, async (payload) => {
            // Check for cancellation before processing token
            if (abortSignal?.aborted) {
              abortHandler();
              return;
            }
            
            debug.log('✅ Received federated voice token:', payload);
            
            // Clear pending state and timeout
            if (this.pendingFederatedJoin?.timeout) {
              clearTimeout(this.pendingFederatedJoin.timeout);
            }
            this.pendingFederatedJoin = null;
            
            // Remove abort listener since we're proceeding
            if (abortSignal) {
              abortSignal.removeEventListener('abort', abortHandler);
            }
            
            // Extract token data
            const { livekitUrl, token } = payload.payload;
            
            try {
              // Setup WebRTC event listeners before joining
              this.setupWebRTCListeners();
              
              // Connect to remote LiveKit via webrtcManager (which will set activeService='livekit')
              const success = await webrtcManager.joinWithToken(livekitUrl, token, channelId, userId);
              
              // Check for cancellation after connection
              if (abortSignal?.aborted) {
                if (success) {
                  await webrtcManager.leaveChannel();
                }
                abortHandler();
                return;
              }
              
              if (!success) {
                throw new Error('Failed to connect to remote LiveKit server');
              }
              
              this.connectionMode = 'livekit';
              this.isEncrypted = webrtcManager.isE2EEEnabled();
              debug.log('🔌 [VoiceChannel] Connected to federated voice channel via LiveKit');
              
              // Update store state
              this.currentChannelId = channelId;
              this.currentServerId = serverId;
              const channel = serverChannelStore.channels.find((c: any) => c.id === channelId);
              this.currentChannelName = channel ? channel.name : 'Voice Channel';
              this.isConnected = true;
              this.isConnecting = false; // Connection attempt complete
              this.connectionAbortController = null; // Clear abort controller on success
              this.sessionStartTime = new Date();
              this.callStartTime = new Date();
              
              // Clear optimistic state - real connection is established
              this.optimisticChannelId = null;
              this.optimisticServerId = null;
              this.optimisticChannelName = null;
              
              // Save voice channel state
              this.saveVoiceChannelState();
              this.startVoiceSessionHeartbeat();
              
              // Update state from webrtcManager (now properly set to livekit)
              this.localState = webrtcManager.getLocalState();
              this.localStream = webrtcManager.getLocalStream();
              
              // Initialize Push-to-Talk
              this.setupPushToTalk();
              
              // Note: Join sound is now played immediately in ChannelSidebar for optimistic UX
              // Don't play it again here to avoid duplicate sounds
              
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
        (async () => {
          try {
            const session = await supabase.auth.getSession();
            if (!session.data.session) {
              this.cleanupFederatedSubscription();
              reject(new Error('Not authenticated'));
              return;
            }
            
            const response = await fetch('/api/federation/voice/join', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.data.session.access_token}`,
              },
              body: JSON.stringify({ channelId, serverId }),
            });
            
            if (!response.ok) {
              const error = await response.json().catch(() => ({ error: 'Unknown error' }));
              throw new Error(error.error || 'Failed to send voice join request');
            }
            
            debug.log('📡 Voice join request sent to federation backend');
            
            // Update local presence state (but don't write to DB)
            serverUsersStore.joinVoiceChannel(serverId, channelId, userId, false);
          } catch (error) {
            this.isConnecting = false; // Reset on error
            // Clear optimistic state on failure
            this.optimisticChannelId = null;
            this.optimisticServerId = null;
            this.optimisticChannelName = null;
            this.cleanupFederatedSubscription();
            reject(error);
          }
        })();
        
        // Set timeout for token response (20 seconds, reduced from 30)
        const timeout = setTimeout(() => {
          // Check if already cancelled
          if (abortSignal?.aborted) {
            return; // Already handled by abort handler
          }
          
          debug.error('❌ Timeout waiting for federated voice token');
          if (abortSignal) {
            abortSignal.removeEventListener('abort', abortHandler);
          }
          this.pendingFederatedJoin = null;
          this.isConnecting = false; // Reset on timeout
          this.connectionAbortController = null;
          // Clear optimistic state on timeout
          this.optimisticChannelId = null;
          this.optimisticServerId = null;
          this.optimisticChannelName = null;
          this.cleanupFederatedSubscription();
          serverUsersStore.leaveVoiceChannel(serverId, channelId, userId);
          reject(new Error('Timeout waiting for voice connection to remote server'));
        }, 20000);
        
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

        // If we're connecting, cancel the connection attempt
        if (this.isConnecting && this.connectionAbortController) {
          debug.log('🚫 Cancelling ongoing connection attempt...');
          
          // Save optimistic values before clearing them (for presence rollback)
          const optimisticChannelId = this.optimisticChannelId;
          const optimisticServerId = this.optimisticServerId;
          
          // Abort the connection attempt
          this.connectionAbortController.abort();
          this.connectionAbortController = null;
          this.isConnecting = false;
          
          // Clean up optimistic state
          this.optimisticChannelId = null;
          this.optimisticServerId = null;
          this.optimisticChannelName = null;
          
          // Clean up federated subscription if active
          this.cleanupFederatedSubscription();
          if (this.pendingFederatedJoin?.timeout) {
            clearTimeout(this.pendingFederatedJoin.timeout);
            this.pendingFederatedJoin = null;
          }
          
          // If we had started presence, roll it back
          if (optimisticChannelId && optimisticServerId) {
            const userId = authStore.session?.user?.id;
            if (userId) {
              await serverUsersStore.leaveVoiceChannel(
                optimisticServerId,
                optimisticChannelId,
                userId
              );
            }
          }
          
          // Leave WebRTC if it was partially connected
          await webrtcManager.leaveChannel();
          
          // If this was a DM call, notify the callee so their incoming modal dismisses
          const isCancelledDMCall = optimisticChannelId?.startsWith('dm-') || optimisticChannelId?.startsWith('federated-dm-');
          if (isCancelledDMCall) {
            try {
              const { authContextService } = await import('@/services/AuthContextService');
              const profileId = await authContextService.getCurrentProfileId();
              if (optimisticChannelId?.startsWith('federated-dm-')) {
                const parts = optimisticChannelId.replace('federated-dm-', '').split('-');
                const conversationId = parts.slice(0, -1).join('-');
                if (profileId && conversationId) {
                  await dmCallSignaling.endFederatedCall(conversationId, profileId);
                }
              } else {
                const conversationId = optimisticChannelId?.replace('dm-', '');
                if (profileId && conversationId) {
                  await dmCallSignaling.leaveCall(conversationId, profileId);
                }
              }
            } catch (e) {
              debug.warn('Failed to signal DM call leave during cancel:', e);
            }
          }
          
          debug.log('✅ Connection attempt cancelled');
          return true;
        }

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
        
        // Clear abort controller if it exists
        if (this.connectionAbortController) {
          this.connectionAbortController = null;
        }
        
        // Clear saved voice channel state (user manually left)
        this.clearVoiceChannelState();
        
        // If this is a DM call, notify the signaling layer
        const isDMCall = serverId === 'dm' || channelId?.startsWith('dm-') || channelId?.startsWith('federated-dm-');
        if (isDMCall) {
          try {
            const { authContextService } = await import('@/services/AuthContextService');
            const profileId = await authContextService.getCurrentProfileId();

            // For federated DM calls (room name like "federated-dm-{conversationId}-{timestamp}"),
            // extract the conversationId and end via ActivityPub
            if (channelId?.startsWith('federated-dm-')) {
              const parts = channelId.replace('federated-dm-', '').split('-');
              // conversationId is a UUID (5 parts joined by hyphens), timestamp is the last segment
              const conversationId = parts.slice(0, -1).join('-');
              if (profileId && conversationId) {
                await dmCallSignaling.endFederatedCall(conversationId, profileId);
              }
            } else {
              const conversationId = channelId?.replace('dm-', '');
              if (profileId && conversationId) {
                await dmCallSignaling.leaveCall(conversationId, profileId);
              }
            }
          } catch (e) {
            debug.warn('Failed to send DM call leave signal:', e);
          }
        }
        
        // Leave WebRTC (webrtcManager handles both local and federated)
        await webrtcManager.leaveChannel();

        // Clean up spatial audio
        this.cleanupSpatialAudio();
        
        // Clean up Push-to-Talk
        this.cleanupPushToTalk();
        
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
        themeStore.playAudio('voice_disconnect');

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
        themeStore.playAudio(enabled ? 'camera_on' : 'camera_off');
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
      const themeStore = useThemeStore();
      const enabled = await webrtcManager.toggleScreenShare();
      
      // Force sync with WebRTC service state
      this.localState = webrtcManager.getLocalState();
      this.localStream = webrtcManager.getLocalStream();
      
      // Give UI time to update before playing sound
      setTimeout(() => {
        themeStore.playAudio(enabled ? 'screenshare_on' : 'screenshare_off');
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
     * IMPORTANT: In PTT mode, this only allows MUTING, not unmuting via button click.
     * Unmuting in PTT mode happens only via the PTT key.
     * This prevents accidental audio leaks when user clicks unmute button.
     */
    async toggleMute(): Promise<boolean> {
      const themeStore = useThemeStore();
      const keybinds = useKeybinds();
      
      // In PTT mode, clicking the mute button should:
      // - If currently transmitting (PTT held): mute immediately (safety)
      // - If muted (PTT not held): stay muted, do NOT unmute via button
      //   This prevents accidental voice activation when user clicks unmute
      if (keybinds.isPTTMode.value) {
        const currentlyMuted = this.localState.isMuted;
        
        if (!currentlyMuted) {
          // User is unmuted (PTT is held) - allow muting for safety/privacy
          if (this.isConnected) {
            webrtcManager.setMuted(true);
            this.localState = webrtcManager.getLocalState();
          } else {
            this.localState.isMuted = true;
          }
          themeStore.playAudio('mic_off');
          debug.log('🎤 [PTT] Muted via button while transmitting');
          return true;
        } else {
          // User is muted (PTT not held) - DON'T unmute via button click!
          // They need to hold the PTT key to transmit
          debug.log('🎤 [PTT] Ignoring unmute button - use PTT key to transmit');
          // Play a subtle sound to indicate the action was blocked
          // themeStore.playAudio('error'); // Optional: play error sound
          return true; // Stay muted
        }
      }
      
      // Voice Activity mode - normal toggle behavior
      if (this.isConnected) {
        // eslint-disable-next-line unused-imports/no-unused-vars
        const muted = webrtcManager.toggleMute();
        const newState = webrtcManager.getLocalState();
        if (newState.userId) {
          this.localState = newState;
        } else {
          this.localState.isMuted = !this.localState.isMuted;
        }
        themeStore.playAudio(this.localState.isMuted ? 'mic_off' : 'mic_on');
        return this.localState.isMuted;
      } else {
        // Toggle local state when not connected
        this.localState.isMuted = !this.localState.isMuted;
        debug.log('Setting preemptive mute state:', this.localState.isMuted);
        themeStore.playAudio(this.localState.isMuted ? 'mic_off' : 'mic_on');
        return this.localState.isMuted;
      }
    },

    /**
     * Set mute state directly (for Push-to-Talk)
     * Unlike toggleMute, this doesn't play sound effects (to avoid spam during PTT)
     * @param muted - Whether to mute (true) or unmute (false)
     * @param playSound - Whether to play the mute/unmute sound effect (default: false)
     */
    setMuted(muted: boolean, playSound: boolean = false): void {
      const themeStore = useThemeStore();
      
      if (this.isConnected) {
        // Only call webrtcManager if state is actually different
        const currentMuted = this.localState.isMuted;
        if (currentMuted !== muted) {
          webrtcManager.setMuted(muted);
          this.localState = webrtcManager.getLocalState();
          if (playSound) {
            themeStore.playAudio(muted ? 'mic_off' : 'mic_on');
          }
          debug.log('🎤 [PTT] Set muted state:', muted);
        }
      } else {
        // Update local state when not connected
        if (this.localState.isMuted !== muted) {
          this.localState.isMuted = muted;
          if (playSound) {
            themeStore.playAudio(muted ? 'mic_off' : 'mic_on');
          }
          debug.log('🎤 [PTT] Set preemptive muted state:', muted);
        }
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
        themeStore.playAudio(deafened ? 'deafen_on' : 'deafen_off');
        return deafened;
      } else {
        // Toggle local state when not connected
        this.localState.isDeafened = !this.localState.isDeafened;
        
        // Deafening also mutes (Discord behavior)
        if (this.localState.isDeafened) {
          this.localState.isMuted = true;
        }
        
        debug.log('Setting preemptive deafen state:', this.localState.isDeafened);
        themeStore.playAudio(this.localState.isDeafened ? 'deafen_on' : 'deafen_off');
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
      this.isFullWindowMode = false;
    },

    /**
     * Toggle full window mode (video fills entire viewport in fullscreen)
     */
    toggleFullWindowMode(): void {
      this.isFullWindowMode = !this.isFullWindowMode;
    },

    /**
     * Toggle PIP mode for screenshare
     * Pass null to close PIP, or a userId to open/toggle PIP for that user
     */
    togglePIP(userId: string | null, mode: 'draggable' | 'fixed' | 'native' = 'native'): void {
      // Close PIP if null is passed or same user is toggled
      if (userId === null || (this.pipActive && this.pipUserId === userId)) {
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
     * Update stream quality settings (resolution/framerate/audioBitrate)
     * Applies to camera, screenshare, and audio
     */
    async updateStreamQuality(settings: { resolution?: number; frameRate?: number; audioBitrate?: number }): Promise<void> {
      const newSettings = { ...this.streamSettings, ...settings };
      this.streamSettings = newSettings;
      
      debug.log('🎬 Updating stream quality:', newSettings);
      
      // Apply to active video/screenshare/audio if any
      if (this.localState.isVideoEnabled || this.localState.isScreenSharing || !this.localState.isMuted) {
        try {
          await webrtcManager.updateStreamQuality({
            resolution: newSettings.resolution,
            frameRate: newSettings.frameRate,
            audioBitrate: newSettings.audioBitrate
          });
          debug.log('✅ Stream quality updated successfully');
        } catch (error) {
          debug.error('❌ Failed to update stream quality:', error);
        }
      } else {
        debug.log('ℹ️ Stream quality settings saved, will apply when video/audio is enabled');
      }
      
      // Persist settings
      try {
        userStorage.setItem('stream-settings', JSON.stringify(newSettings));
      } catch (error) {
        debug.warn('Failed to save stream settings:', error);
      }
    },

    /**
     * Load stream settings from localStorage
     */
    loadStreamSettings(): void {
      try {
        const saved = userStorage.getItem('stream-settings');
        if (saved) {
          const settings = JSON.parse(saved);
          // Handle -1 (source/native) as valid, only default if truly undefined
          this.streamSettings = {
            resolution: settings.resolution !== undefined ? settings.resolution : 720,
            frameRate: settings.frameRate || 30,
            audioBitrate: settings.audioBitrate || 128
          };
        }
      } catch (error) {
        debug.warn('Failed to load stream settings:', error);
      }
    },

    /**
     * Set per-user mic volume (0-200, 100 = normal)
     * Persisted to localStorage and applied to audio
     */
    setUserVolume(userId: string, volume: number): void {
      // Clamp volume to valid range
      const clampedVolume = Math.max(0, Math.min(200, volume));
      this.userVolumes.set(userId, clampedVolume);
      
      // Apply volume to the user's mic audio stream
      webrtcManager.setUserMicVolume(userId, clampedVolume);
      
      // Persist to localStorage
      this.saveUserVolumes();
      
      debug.log(`🔊 Set mic volume for user ${userId}: ${clampedVolume}%`);
    },
    
    /**
     * Set per-user screenshare volume (0-200, 100 = normal)
     * Persisted to localStorage and applied to screenshare audio
     */
    setUserScreenShareVolume(userId: string, volume: number): void {
      // Clamp volume to valid range
      const clampedVolume = Math.max(0, Math.min(200, volume));
      this.userScreenShareVolumes.set(userId, clampedVolume);
      
      // Apply volume to the user's screenshare audio stream
      webrtcManager.setUserScreenShareVolume(userId, clampedVolume);
      
      // Persist to localStorage
      this.saveScreenShareVolumes();
      
      debug.log(`🔊 Set screenshare volume for user ${userId}: ${clampedVolume}%`);
    },

    /**
     * Save user mic volumes to localStorage
     */
    saveUserVolumes(): void {
      try {
        const volumeObj: Record<string, number> = {};
        this.userVolumes.forEach((volume, odUserId) => {
          volumeObj[odUserId] = volume;
        });
        userStorage.setItem('user-volumes', JSON.stringify(volumeObj));
      } catch (error) {
        debug.warn('Failed to save user volumes:', error);
      }
    },
    
    /**
     * Save user screenshare volumes to localStorage
     */
    saveScreenShareVolumes(): void {
      try {
        const volumeObj: Record<string, number> = {};
        this.userScreenShareVolumes.forEach((volume, odUserId) => {
          volumeObj[odUserId] = volume;
        });
        userStorage.setItem('user-screenshare-volumes', JSON.stringify(volumeObj));
      } catch (error) {
        debug.warn('Failed to save screenshare volumes:', error);
      }
    },

    /**
     * Load user volumes from localStorage
     */
    loadUserVolumes(): void {
      try {
        const saved = userStorage.getItem('user-volumes');
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
     * Load screenshare volumes from localStorage
     */
    loadScreenShareVolumes(): void {
      try {
        const saved = userStorage.getItem('user-screenshare-volumes');
        if (saved) {
          const volumeObj = JSON.parse(saved) as Record<string, number>;
          Object.entries(volumeObj).forEach(([odUserId, volume]) => {
            this.userScreenShareVolumes.set(odUserId, volume);
          });
          debug.log('🔊 Loaded screenshare volumes from localStorage');
        }
      } catch (error) {
        debug.warn('Failed to load screenshare volumes:', error);
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
     * Setup WebRTC event listeners (idempotent - only registers once)
     */
    setupWebRTCListeners(): void {
      if (webrtcListenersRegistered) return;
      webrtcListenersRegistered = true;

      const themeStore = useThemeStore();
      const serverUsersStore = useServerUsersStore();
      const authStore = useAuthStore();
      
      // Get the current user's ID reliably from auth store
      // (localState.userId might be empty at this point)
      const currentUserId = authStore.session?.user?.id;
      
      // Channel events
      webrtcManager.on('channel-joined', (data: any) => {
        debug.log('✅ Channel joined:', data);
        this.connectionMode = webrtcManager.getActiveService();
        this.isEncrypted = webrtcManager.isE2EEEnabled();
      });

      webrtcManager.on('channel-left', (data: any) => {
        debug.log('👋 Channel left:', data);
        this.isEncrypted = false;
      });

      webrtcManager.on('e2ee-status-changed', (data: { enabled: boolean }) => {
        debug.log('🔐 E2EE status changed:', data);
        this.isEncrypted = !!data?.enabled;
      });

      webrtcManager.on('channel-state-synced', async (data: any) => {
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
          userIds.some((id: string, index: number) => id !== this.previousUserIds[index]);
        
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
      webrtcManager.on('user-joined', async (data: any) => {
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

        // Only play sound for OTHER users joining, not for self
        // (self sound is played immediately in ChannelSidebar for optimistic UX)
        // Use currentUserId from authStore since localState.userId might be empty
        if (currentUserId && data.userId !== currentUserId) {
          themeStore.playAudio('voice_connect');
        }
      });

      webrtcManager.on('user-left', (data: any) => {
        debug.log('👋 User left:', data);
        
        // Remove user from list
        this.allUsers = this.allUsers.filter(u => u.userId !== data.userId);
        this.remoteStreams.delete(data.userId);
        
        // Remove from spatial audio
        this.removeUserFromSpatialAudio(data.userId);

        // Clean up database state for the disconnected user
        // This handles the case where a user crashes/disconnects without graceful leave
        if (this.currentChannelId && this.currentServerId && !this.isFederatedChannel) {
          // Only cleanup local server participants - federated cleanup is handled by the host
          serverUsersStore.cleanupDisconnectedUser(
            this.currentServerId, 
            this.currentChannelId, 
            data.userId
          );
        }

        // Reset call start time if everyone left
        const totalUsers = this.allUsers.length + 1; // +1 for local user
        if (totalUsers === 1) {
          debug.log('🕐 Last user left - resetting call start time');
          this.callStartTime = null;
        }

        // Only play sound for OTHER users leaving, not for self
        // (self disconnect sound is handled in leaveVoiceChannel/ChannelSidebar)
        // Use currentUserId from authStore since localState.userId might be empty
        if (currentUserId && data.userId !== currentUserId) {
          themeStore.playAudio('voice_disconnect');
        }
      });

      webrtcManager.on('user-state-changed', (data: any) => {
        // Update user state
        const userIndex = this.allUsers.findIndex(u => u.userId === data.userId);
        // Check if video/screenshare state changed (not just audio level)
        const oldState = userIndex !== -1 ? this.allUsers[userIndex] : null;
        const videoStateChanged = oldState && (
          oldState.isVideoEnabled !== data.mediaState.isVideoEnabled ||
          oldState.isScreenSharing !== data.mediaState.isScreenSharing
        );
        
        if (userIndex !== -1) {
          // Use splice to ensure Vue detects the change (more reliable than direct assignment)
          // This creates a new array reference for computed properties that depend on allUsers
          this.allUsers.splice(userIndex, 1, data.mediaState);
        } else if (data.mediaState && data.mediaState.userId) {
          // User not in list yet - add them
          debug.log('➕ User not in list, adding:', data.userId);
          this.allUsers.push(data.mediaState);
        }
        
        // Only increment counter when video/screenshare state actually changes
        // NOT for audio level changes (which happen 20+ times per second)
        if (videoStateChanged || !oldState) {
          this.streamUpdateCounter = (this.streamUpdateCounter || 0) + 1;
          debug.log('📹 Video state changed for', data.userId, '- counter:', this.streamUpdateCounter, 
            'video:', data.mediaState.isVideoEnabled, 'screen:', data.mediaState.isScreenSharing);
          
          // Handle screenshare state change for spatial audio
          // Screenshare audio uses its own separate audio element, so we only
          // need to add/remove the user from spatial processing -- NOT toggle
          // traditional audio globally (that would clobber all other users).
          if (oldState && oldState.isScreenSharing !== data.mediaState.isScreenSharing) {
            const spatialStore = useSpatialAudioStore();
            if (data.mediaState.isScreenSharing) {
              debug.log('🔊 User started screensharing, removing from spatial audio:', data.userId);
              this.removeUserFromSpatialAudio(data.userId);
            } else if (spatialStore.settings.enabled) {
              debug.log('🎧 User stopped screensharing, restoring spatial audio:', data.userId);
              this.addUserToSpatialAudio(data.userId);
            }
          }
        }
        
        // NOTE: Don't auto-open overlay here - this fires on every state change
        // Auto-open only happens in user-joined for initial sync when joining
      });

      webrtcManager.on('user-stream-changed', (data: any) => {
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
      webrtcManager.on('local-state-changed', (state: any) => {
        debug.log('🎛️ Local state changed in store:', {
          isVideoEnabled: state.isVideoEnabled,
          isScreenSharing: state.isScreenSharing,
          isMuted: state.isMuted
        });
        this.localState = state;
      });
      
      webrtcManager.on('local-stream-changed', (stream: any) => {
        // debug.log('📹 Local stream changed:', stream);
        this.localStream = stream;
      });
      
      // Handle generic stream changes (for better compatibility)
      webrtcManager.on('stream-changed', (data: any) => {
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

      // Audio levels (also drives the speaking indicator for remote users)
      webrtcManager.on('audio-level', (data: any) => {
        const speaking = data.level > 20;
        if (data.userId === this.localState.userId) {
          this.localState.audioLevel = data.level;
          if (speaking && !this.localState.isMuted) {
            this.updateRecentSpeakers(data.userId);
          }
        } else {
          const user = this.allUsers.find(u => u.userId === data.userId);
          if (user) {
            user.audioLevel = data.level;
            user.isSpeaking = speaking;
            if (speaking) {
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
      webrtcManager.on('error', (error: any) => {
        debug.error('❌ WebRTC error:', error);
        // Could show notification to user
      });

      // Call start time sync
      webrtcManager.on('call-start-time', (data: { timestamp: string; from: string }) => {
        this.handleCallStartTime(data.timestamp);
      });

      webrtcManager.on('request-call-start-time', (_data: { from: string }) => {
        // Respond with our call start time if we have it
        if (this.callStartTime) {
          this.broadcastCallStartTime();
        }
      });
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
        // BUGS.md Pattern B / item #2: persist this under `userStorage` so it
        // is scoped to the current user. Previously the unscoped
        // `localStorage` key meant logout-without-leave would leave the
        // state for the next user, and on shared devices the NEXT user
        // would auto-reconnect to the PREVIOUS user's voice channel.
        userStorage.setItem('voiceChannelState', JSON.stringify(voiceState));
        
        // Track active voice session for cross-tab prevention
        const activeSession = {
          tabId: this.getTabId(),
          channelId: this.currentChannelId,
          timestamp: Date.now()
        };
        userStorage.setItem('active-voice-session', JSON.stringify(activeSession));
        
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
          userStorage.setItem('active-voice-session', JSON.stringify(activeSession));
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
      // Best-effort: remove both legacy unscoped and current user-scoped
      // versions of the key so previously-persisted leaks are also cleared.
      localStorage.removeItem('voiceChannelState');
      userStorage.removeItem('voiceChannelState');
      userStorage.removeItem('active-voice-session');
      this.stopVoiceSessionHeartbeat();
      debug.log('🗑️ Cleared voice channel state');
    },

    /**
     * Attempt to reconnect to previous voice channel
     */
    async reconnectToVoiceChannel(): Promise<boolean> {
      // Prefer user-scoped storage (current). Fall back to legacy global
      // localStorage entry so existing in-flight sessions still reconnect on
      // first deploy. The legacy entry will be migrated/cleared on next
      // `clearVoiceChannelState()`.
      const savedState =
        userStorage.getItem('voiceChannelState') ?? localStorage.getItem('voiceChannelState');
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

    // Debounce timers for spatial audio setup per user
    _spatialAudioDebounceTimers: {} as Record<string, ReturnType<typeof setTimeout>>,
    
    /**
     * Add user to spatial audio using MediaStream directly
     * Note: Skips spatial audio when user is screensharing - screenshare audio
     * (music, videos, games) should play in stereo, not be spatially positioned
     */
    addUserToSpatialAudio(userId: string): void {
      const spatialStore = useSpatialAudioStore();
      if (!spatialStore.settings.enabled) {
        return;
      }

      // BUGS.md #8 - if spatial audio was supposed to be active but the
      // traditional `<audio>` (dry) playback got turned back on by some
      // screen-share lifecycle path (e.g. the user dismissed the
      // browser's screen-share picker mid-flight), we end up hearing the
      // user through both the spatial graph AND the dry audio element
      // simultaneously. Re-assert the dry-mute right before adding the
      // user back into the spatial graph so the two never overlap.
      try {
        webrtcManager.setTraditionalAudioEnabled(false);
      } catch (e) {
        debug.warn('Failed to mute traditional audio before re-adding spatial user:', e);
      }

      // Check if user is screensharing - if so, skip spatial audio
      // Screenshare audio plays through its own separate audio element
      const userState = this.allUsers.find(u => u.userId === userId);
      if (userState?.isScreenSharing) {
        debug.log('🎧 Skipping spatial audio for screensharing user:', userId);
        return;
      }
      
      // Initialize remote user position if not set (never local user here)
      if (!spatialStore.userPositions.has(userId)) {
        spatialStore.initializeUserPosition(userId, false); // false = remote user
        debug.log('🎧 Initialized position for new user:', userId);
      }
      
      // Clear any pending setup timer for this user
      if (this._spatialAudioDebounceTimers[userId]) {
        clearTimeout(this._spatialAudioDebounceTimers[userId]);
      }
      
      // Small delay to ensure MediaStream is properly set up
      this._spatialAudioDebounceTimers[userId] = setTimeout(async () => {
        delete this._spatialAudioDebounceTimers[userId];
        
        // Double-check screenshare status (might have changed)
        const currentUserState = this.allUsers.find(u => u.userId === userId);
        if (currentUserState?.isScreenSharing) {
          debug.log('🎧 User started screensharing, skipping spatial audio:', userId);
          return;
        }
        
        // Re-check that spatial audio is still enabled (may have changed during the delay)
        if (!useSpatialAudioStore().settings.enabled) {
          return;
        }
        
        // Get the MediaStream for this user from WebRTC service
        const userStream = webrtcManager.getUserStream(userId);
        if (userStream) {
          await spatialAudioService.setupSpatialForUser(userId, userStream);
          spatialAudioService.updateSpatialEffects();
        } else {
          debug.warn('No media stream found for user:', userId);
        }
      }, 50);
    },

    /**
     * Remove user from spatial audio
     */
    removeUserFromSpatialAudio(userId: string): void {
      // Clear any pending debounce timer
      if (this._spatialAudioDebounceTimers[userId]) {
        clearTimeout(this._spatialAudioDebounceTimers[userId]);
        delete this._spatialAudioDebounceTimers[userId];
      }
      spatialAudioService.removeUser(userId);
    },

    /**
     * Clean up spatial audio
     */
    cleanupSpatialAudio(): void {
      spatialAudioService.destroy();
    },

    /**
     * Setup keybind integration for voice controls
     * Registers handlers for all voice-related keybinds (PTT, mute, etc.)
     */
    setupPushToTalk(): void {
      if (keybindListenersSetup) return;
      
      const keybinds = useKeybinds();
      
      // Activate the voice-connected context
      keybinds.activateContext('voice-connected');
      
      // Register PTT handler (hold mode - callback receives isPressed)
      keybinds.registerHandler('push-to-talk', (isPressed: boolean) => {
        this.setMuted(!isPressed, false); // When pressed, unmute; when released, mute
      });
      
      // Register voice toggle handlers (these work when overlay is NOT open)
      // When overlay IS open, it registers its own handlers that take priority
      keybinds.registerHandler('toggle-mute', () => {
        // Only handle if not in PTT mode (PTT mode handles mute differently)
        if (!keybinds.isPTTMode.value) {
          this.toggleMute();
        }
      });
      keybinds.registerHandler('toggle-deafen', () => this.toggleDeafen());
      keybinds.registerHandler('toggle-camera', () => this.toggleVideo());
      keybinds.registerHandler('toggle-screenshare', () => this.toggleScreenShare());
      
      // Setup global key listeners
      keybinds.setupListeners();
      
      // If PTT mode is active, start muted
      if (keybinds.isPTTMode.value) {
        this.setMuted(true, false);
      }
      
      keybindListenersSetup = true;
      debug.log('⌨️ [Keybinds] Voice keybinds integrated with voice channel');
    },

    /**
     * Cleanup keybind integration
     */
    cleanupPushToTalk(): void {
      if (!keybindListenersSetup) return;
      
      const keybinds = useKeybinds();
      
      // Deactivate the voice-connected context
      keybinds.deactivateContext('voice-connected');
      
      // Unregister all voice handlers
      keybinds.unregisterHandler('push-to-talk');
      keybinds.unregisterHandler('toggle-mute');
      keybinds.unregisterHandler('toggle-deafen');
      keybinds.unregisterHandler('toggle-camera');
      keybinds.unregisterHandler('toggle-screenshare');
      
      keybinds.cleanupListeners();
      
      keybindListenersSetup = false;
      debug.log('⌨️ [Keybinds] Voice keybinds cleanup complete');
    },

    /**
     * Reset store state
     */
    resetState(): void {
      this.currentChannelId = null;
      this.currentServerId = null;
      this.dmOtherUserId = null;
      this.isConnected = false;
      this.isConnecting = false;
      this.connectionAbortController = null;
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
      this.connectionMode = null;
      this.isEncrypted = false;
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