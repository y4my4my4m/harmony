import { defineStore } from 'pinia';
import { apiUrl } from '@/services/instanceConfig';
import { nextTick, watch, type WatchStopHandle } from 'vue';
import { webrtcManager } from '@/services/webrtcManager';
import type { UserMediaState } from '@/services/unifiedWebRTC';
import type { VideoSource, VoiceConnectionQuality } from '@/services/livekitWebRTC';
import { clampVolume, remoteAudioMixer, type RemoteAudioKind } from '@/services/voice/remoteAudioMixer';
import { loadAudioPrefs as readAudioPrefs, saveMutes, saveVolumes } from '@/services/voice/voiceAudioPrefs';
import { closeVoiceAudioContext } from '@/services/voice/voiceAudioContext';
import { VoiceSettingsService, normalizeOutputVolume } from '@/services/VoiceSettingsService';
import { spatialAudioService } from '@/services/spatialAudio';
import { dmCallSignaling } from '@/services/DMCallSignaling';
import { useSpatialAudioStore } from '@/stores/spatialAudio';
import { useAuthStore } from '@/stores/auth';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useServerChannelStore } from './useServerChannel';
import { setCallServiceActive } from '@/services/callForegroundService';
import { syncOverlayForCall } from '@/services/overlayBridge';
import { useThemeStore } from '@/stores/useTheme';
import { useNotificationStore } from '@/stores/useNotification';
import { useUserData } from '@/composables/useUserData';
import { useKeybinds } from '@/composables/useKeybinds';
import { voiceE2EEService } from '@/services/encryption/VoiceE2EEService';
import { fetchEffectiveChannelEncryption } from '@/services/ChannelEncryptionService';
import { supabase } from '@/supabase';
import { userEventChannel } from '@/services/UserEventChannel';
import { debug } from '@/utils/debug';
import { userStorage } from '@/utils/userScopedStorage';

let voiceSessionHeartbeat: ReturnType<typeof setInterval> | null = null;

let keybindListenersSetup = false;
let inputModeWatchStop: WatchStopHandle | null = null;

let webrtcListenersRegistered = false;

// Handlers for the remote server's answer to a pending federated voice join.
let federatedAnswerUnsubscribe: (() => void) | null = null;

// A link still reconnecting after this long is dropped like a lost one.
// livekit-client 2.16 gives up only minutes in: DefaultReconnectPolicy retries
// 10 times, each attempt bounded by websocketTimeout and peerConnectionTimeout
// (15 s each).
export const VOICE_RECONNECT_GIVE_UP_MS = 45_000;
let reconnectGiveUp: ReturnType<typeof setTimeout> | null = null;

function clearReconnectGiveUp(): void {
  if (reconnectGiveUp) clearTimeout(reconnectGiveUp);
  reconnectGiveUp = null;
}


interface RecentSpeaker {
  userId: string;
  lastSpokeAt: number;
}

interface VoiceChannelState {
  currentChannelId: string | null;
  currentServerId: string | null;
  currentChannelName: string | null;
  dmOtherUserId: string | null;
  isConnected: boolean;
  sessionStartTime: Date | null;
  callStartTime: Date | null;
  
  isFederatedChannel: boolean;
  pendingFederatedJoin: {
    channelId: string;
    serverId: string;
    timeout: ReturnType<typeof setTimeout> | null;
    // Join activity id and host returned by /api/federation/voice/join; only
    // the answer naming both is accepted.
    joinId: string | null;
    serverHost: string | null;
  } | null;
  
  isConnecting: boolean;
  connectionAbortController: AbortController | null;
  
  optimisticChannelId: string | null;
  optimisticServerId: string | null;
  optimisticChannelName: string | null;
  
  allUsers: UserMediaState[];
  localState: UserMediaState;
  
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  
  userVolumes: Map<string, number>;
  userScreenShareVolumes: Map<string, number>;
  // Users silenced for this listener only; their volume is kept.
  userMicMutes: Set<string>;
  userStreamMutes: Set<string>;

  // The browser refused to start remote audio; a user gesture must resume it.
  audioPlaybackBlocked: boolean;
  // Transport link state while in a call.
  connectionState: 'connected' | 'reconnecting' | null;
  connectionQuality: Record<string, VoiceConnectionQuality>;
  // Remote streams this client receives (LiveKit streams are opt-in).
  watchedStreamUserIds: string[];

  recentSpeakers: RecentSpeaker[];
  
  isOverlayVisible: boolean;
  layoutMode: 'grid' | 'speaker' | 'gallery';
  viewMode: 'normal' | 'maximized' | 'fullscreen';
  fullscreenUserId: string | null;
  fullscreenSource: 'camera' | 'screen';
  isFullWindowMode: boolean; // Stream fills entire viewport in fullscreen mode
  
  pipActive: boolean;
  pipUserId: string | null;
  pipMode: 'draggable' | 'fixed' | 'native';
  
  streamSettings: {
    resolution: number;
    frameRate: number;
    audioBitrate: number;
  };
  
  streamUpdateCounter: number;
  
  // Active WebRTC transport ('livekit' for SFU, 'p2p' for peer-to-peer, null when disconnected)
  connectionMode: 'livekit' | 'p2p' | null;

  // End-to-end encryption of call media. Supported on LiveKit only.
  isEncrypted: boolean;

  // Why the last join failed; null after a successful join.
  joinError: string | null;

  // Last-seen voice-channel user IDs; short-circuits
  // `ensureProfilesAvailable` when membership has not changed.
  previousUserIds: string[];
}


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
    
    optimisticChannelId: null,
    optimisticServerId: null,
    optimisticChannelName: null,
    
    isFederatedChannel: false,
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
    
    userVolumes: new Map(),
    userScreenShareVolumes: new Map(),
    userMicMutes: new Set(),
    userStreamMutes: new Set(),

    audioPlaybackBlocked: false,
    connectionState: null,
    connectionQuality: {},
    watchedStreamUserIds: [],

    recentSpeakers: [],
    
    isOverlayVisible: false,
    layoutMode: 'grid',
    viewMode: 'normal',
    fullscreenUserId: null,
    fullscreenSource: 'camera',
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
    joinError: null,

    previousUserIds: [],
  }),

  
  getters: {
    getUser: (state) => (userId: string) => {
      if (userId === state.localState.userId) {
        return state.localState;
      }
      return state.allUsers.find(user => user.userId === userId) || null;
    },

    getUserStream: (state) => (userId: string) => {
      if (userId === state.localState.userId) {
        return state.localStream;
      }
      return state.remoteStreams.get(userId) || null;
    },

    allParticipants: (state) => {
      const participants = [state.localState];
      state.allUsers.forEach(user => {
        if (user.userId !== state.localState.userId) {
          participants.push(user);
        }
      });
      return participants;
    },

    speakingUsers: (state) => {
      return state.allUsers.filter(user => user.audioLevel > 20);
    },

    featuredSpeaker: (state) => {
      const screenSharing = state.allUsers.find(user => user.isScreenSharing);
      if (screenSharing) return screenSharing;
      
      let loudest = state.localState;
      state.allUsers.forEach(user => {
        if (user.audioLevel > loudest.audioLevel) {
          loudest = user;
        }
      });
      
      return loudest.audioLevel > 20 ? loudest : null;
    },

    isConnectedOrJoining: (state) => {
      return state.isConnected || state.optimisticChannelId !== null;
    },
    
    effectiveChannelId: (state) => {
      return state.currentChannelId || state.optimisticChannelId;
    },
    
    effectiveServerId: (state) => {
      return state.currentServerId || state.optimisticServerId;
    },
    
    effectiveChannelName: (state) => {
      return state.currentChannelName || state.optimisticChannelName;
    },

    /** Badge text. Null while not connected. */
    transportLabel: (state): 'SFU' | 'P2P' | null => {
      if (state.connectionMode === 'p2p') return 'P2P';
      if (state.connectionMode === 'livekit') return 'SFU';
      return null;
    },

    connectionStats: (state) => {
      const total = state.allUsers.length + 1;
      const withVideo = state.allUsers.filter(u => u.isVideoEnabled).length + (state.localState.isVideoEnabled ? 1 : 0);
      const speaking = state.allUsers.filter(u => u.audioLevel > 20).length + (state.localState.audioLevel > 20 ? 1 : 0);
      
      return { total, withVideo, speaking };
    },

    getUserVolume: (state) => (userId: string): number => {
      return state.userVolumes.get(userId) ?? 100;
    },
    
    getUserScreenShareVolume: (state) => (userId: string): number => {
      return state.userScreenShareVolumes.get(userId) ?? 100;
    },
    
    hasScreenShareAudio: (state) => (userId: string): boolean => {
      const user = state.allUsers.find(u => u.userId === userId);
      return !!user?.hasScreenShareAudio || webrtcManager.hasScreenShareAudio(userId);
    },

    isUserLocallyMuted: (state) => (userId: string, kind: RemoteAudioKind = 'mic'): boolean => {
      return (kind === 'mic' ? state.userMicMutes : state.userStreamMutes).has(userId);
    },

    /** Own stream and P2P streams are always received; while a LiveKit join is in flight
     *  (connectionMode null) only streams in the watch set count. */
    isWatchingStream: (state) => (userId: string): boolean => {
      if (userId === state.localState.userId) return true;
      if (state.connectionMode === 'p2p') return true;
      return state.watchedStreamUserIds.includes(userId);
    },

    getConnectionQuality: (state) => (userId: string): VoiceConnectionQuality => {
      return state.connectionQuality[userId] ?? 'unknown';
    },

    getRecentSpeakers: (state) => {
      return [...state.recentSpeakers]
        .sort((a, b) => b.lastSpokeAt - a.lastSpokeAt)
        .slice(0, 5);
    },

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

  
  actions: {
    /**
     * Leaves any current voice channel before joining. `livekit` carries
     * credentials another instance issued, used instead of a token from this
     * one: the callee's side of a federated DM call.
     */
    async joinVoiceChannel(
      channelId: string,
      serverId: string,
      opts: { livekit?: { wsUrl: string; token: string } } = {},
    ): Promise<boolean> {
      this.joinError = null;
      try {
        const authStore = useAuthStore();
        const serverChannelStore = useServerChannelStore();

        if (!authStore.session?.user) {
          throw new Error('User not authenticated');
        }
        
        const userId = authStore.session.user.id;
        
        if (this.isConnecting) {
          debug.log('Already attempting to connect, please wait...');
          return false;
        }
        
        if (this.isConnected && this.currentChannelId === channelId) {
          debug.log('Already connected to this voice channel');
          return true;
        }
        
        // Must run BEFORE isConnecting and the abort controller are set;
        // otherwise leaveVoiceChannel takes its cancel-ongoing-connection path.
        if (this.isConnected && this.currentChannelId) {
          debug.log('Already in a voice channel, leaving first...');
          const leaveOk = await this.leaveVoiceChannel();
          if (!leaveOk) {
            debug.warn('leaveVoiceChannel returned false - forcing cleanup');
            await webrtcManager.leaveChannel();
            this.resetState();
          }
        }
        
        this.connectionAbortController = new AbortController();
        const abortSignal = this.connectionAbortController.signal;

        // Listener preferences are in place before the first remote track plays.
        this.loadAudioPrefs();
        this.loadStreamSettings();
        const voiceSettings = VoiceSettingsService.getAll();
        webrtcManager.setAutoWatchStreams(voiceSettings.autoWatchStreams);
        webrtcManager.setMasterVolume(normalizeOutputVolume(voiceSettings.outputVolume));
        
        const channel = serverChannelStore.channels.find((c: any) => c.id === channelId);
        this.optimisticChannelId = channelId;
        this.optimisticServerId = serverId;
        this.optimisticChannelName = channel?.name || 'Voice Channel';
        this.isConnecting = true;
        // Library download overlaps the presence and token round trips.
        webrtcManager.preloadTransport();

        // Optimistic roster of self plus known occupants. Replaced by
        // authoritative webrtc state on channel-state-synced.
        this.localState.userId = userId;
        const occupants = useServerUsersStore()
          .getUsersInVoiceChannel(channelId)
          .filter((id: string) => id !== userId);
        this.allUsers = occupants.map((id: string) => ({
          userId: id,
          isAudioEnabled: true,
          isVideoEnabled: false,
          isScreenSharing: false,
          isMuted: false,
          isDeafened: false,
          isSpeaking: false,
          audioLevel: 0,
        }));
        if (occupants.length > 0) {
          // Resolves during the handshake so tiles never render "Unknown User".
          const { ensureProfilesAvailable } = useUserData();
          void ensureProfilesAvailable(occupants).catch(() => {});
        }

        debug.log('[Optimistic] Voice dock should be visible now for:', channelId);
        
        const activeVoiceSession = userStorage.getItem('active-voice-session');
        if (activeVoiceSession) {
          const session = JSON.parse(activeVoiceSession);
          if (session.tabId !== this.getTabId() && Date.now() - session.timestamp < 5000) {
            debug.warn('Another tab is already in a voice channel');
            throw new Error('You are already in a voice channel in another tab');
          }
        }
        
        debug.log('Joining voice channel:', channelId, 'on server:', serverId);
        
        // DM calls never go through a remote server's voice join, whichever
        // server was viewed last.
        const isRemoteServer = serverId !== 'dm'
          && serverChannelStore.currentServer?.is_local_server === false;
        this.isFederatedChannel = isRemoteServer;
        
        if (isRemoteServer) {
          debug.log('Joining federated voice channel, waiting for token exchange...');
          return await this.joinFederatedVoiceChannel(channelId, serverId, userId, abortSignal);
        }
        
        return await this.joinLocalVoiceChannel(channelId, serverId, userId, abortSignal, opts.livekit);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          debug.log('Connection attempt cancelled by user');
          return false;
        }
        
        debug.error('Failed to join voice channel:', error);
        this.joinError = error instanceof Error && error.message ? error.message : 'Could not join the call.';
        this.isConnecting = false;
        this.connectionAbortController = null;
        this.optimisticChannelId = null;
        this.optimisticServerId = null;
        this.optimisticChannelName = null;
        this.allUsers = [];
        return false;
      }
    },
    
    /**
     * The channel's effective voice encryption (effective_channel_encryption
     * voice_encrypted). DM calls (serverId === 'dm') have no channel policy
     * and return false.
     */
    async resolveVoiceE2EERequired(serverId: string, channelId: string): Promise<boolean> {
      if (!serverId || serverId === 'dm' || !channelId) return false;
      try {
        const state = await fetchEffectiveChannelEncryption(channelId);
        return state?.voiceEncrypted === true;
      } catch (err) {
        debug.warn('[VoiceChannel] Failed to read channel voice encryption:', err);
        return false;
      }
    },
    
    async joinLocalVoiceChannel(
      channelId: string,
      serverId: string,
      userId: string,
      abortSignal?: AbortSignal,
      livekit?: { wsUrl: string; token: string },
    ): Promise<boolean> {
      const serverUsersStore = useServerUsersStore();
      const serverChannelStore = useServerChannelStore();
      
      const presenceSuccess = await serverUsersStore.joinVoiceChannel(serverId, channelId, userId, true);
      if (!presenceSuccess) {
        throw new Error('Failed to update server presence');
      }
      
      if (abortSignal?.aborted) {
        await serverUsersStore.leaveVoiceChannel(serverId, channelId, userId);
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      this.setupWebRTCListeners();
      
      const roomType = serverId === 'dm' ? 'dm_call' : 'voice_channel';
      
      // Fail closed: a client that cannot encrypt is refused rather than
      // joined into a plaintext call.
      const requireE2EE = await this.resolveVoiceE2EERequired(serverId, channelId);
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
      
      // Gate must be current before the mic publishes; a PTT join must not go out hot.
      this.syncTransmitGate();
      const webrtcSuccess = livekit
        ? await webrtcManager.joinWithToken(livekit.wsUrl, livekit.token, channelId, userId)
        : await webrtcManager.joinChannel(channelId, userId, roomType, abortSignal, requireE2EE);
      
      if (abortSignal?.aborted) {
        if (webrtcSuccess) {
          await webrtcManager.leaveChannel();
        }
        await serverUsersStore.leaveVoiceChannel(serverId, channelId, userId);
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      if (!webrtcSuccess) {
        await serverUsersStore.leaveVoiceChannel(serverId, channelId, userId);
        throw new Error(webrtcManager.getLastJoinError() ?? 'Could not connect to the call.');
      }
      
      this.connectionMode = webrtcManager.getActiveService();
      this.connectionState = 'connected';
      this.isEncrypted = webrtcManager.isE2EEEnabled();
      this.applyAudioPrefs();
      if (this.connectionMode === 'p2p' && serverId !== 'dm') {
        void serverUsersStore.markVoiceTransport(channelId, userId, 'p2p');
      }
      debug.log(`[VoiceChannel] Connected via ${this.connectionMode?.toUpperCase() || 'unknown'} mode (${roomType}), E2EE: ${this.isEncrypted}`);
      
      if (abortSignal?.aborted) {
        await webrtcManager.leaveChannel();
        await serverUsersStore.leaveVoiceChannel(serverId, channelId, userId);
        throw new DOMException('Connection cancelled', 'AbortError');
      }
      
      this.currentChannelId = channelId;
      this.currentServerId = serverId;
      const isDMChannel = serverId === 'dm' && (channelId.startsWith('dm-') || channelId.startsWith('federated-dm-'));
      if (isDMChannel) {
        let conversationId: string;
        const federatedMatch = channelId.match(/^federated-dm-([a-f0-9-]{36})/i);
        if (federatedMatch) {
          conversationId = dmCallSignaling.conversationForRoom(channelId) ?? federatedMatch[1];
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

        // Realtime presence announces membership for local calls only;
        // federated participants live on another instance. Presence expires
        // with the socket, so a refresh or crash leaves no ghost call.
        if (!federatedMatch) {
          try {
            const { authContextService } = await import('@/services/AuthContextService');
            const profileId = await authContextService.getCurrentProfileId();
            if (profileId) {
              const activeCall = dmCallSignaling.getActiveCall(conversationId);
              await dmCallSignaling.trackCallPresence(conversationId, {
                callType: activeCall?.callType ?? 'voice',
                isCaller: activeCall?.callerId === profileId,
                systemMessageId: activeCall?.systemMessageId ?? null,
              });
            }
          } catch (e) {
            debug.warn('Failed to track DM call presence:', e);
          }
        }
      } else {
        this.dmOtherUserId = null;
        this.currentChannelName = (serverChannelStore as any).getChannelNameById?.(channelId) || 'Voice Channel';
      }
      this.isConnected = true;
      this.isConnecting = false;
      this.connectionAbortController = null;
      setCallServiceActive(true);
      syncOverlayForCall(true);
      this.sessionStartTime = new Date();
      
      this.optimisticChannelId = null;
      this.optimisticServerId = null;
      this.optimisticChannelName = null;
      
      const existingCallStartTime = serverUsersStore.getCallStartTime(channelId);
      if (existingCallStartTime) {
        this.callStartTime = existingCallStartTime;
        debug.log('Using existing call start time from serverUsersStore:', this.callStartTime);
      } else {
        this.callStartTime = new Date();
        debug.log('First user - setting call start time:', this.callStartTime);
      }
      
      this.saveVoiceChannelState();
      
      this.startVoiceSessionHeartbeat();

      const newLocalState = webrtcManager.getLocalState();
      
      if (this.localState.isMuted && !newLocalState.isMuted) {
        debug.log('Applying preemptive mute state');
        webrtcManager.toggleMute();
      }
      if (this.localState.isDeafened && !newLocalState.isDeafened) {
        debug.log('Applying preemptive deafen state');
        webrtcManager.toggleDeafen();
      }
      
      this.localState = webrtcManager.getLocalState();
      this.localStream = webrtcManager.getLocalStream();
      
      await this.initializeSpatialAudio(userId);
      
      this.setupPushToTalk();
      
      // isOverlayVisible is owned by the user-joined / user-state-changed
      // handlers, which set it on detecting existing video or screenshare.

      // Join sound is played by ChannelSidebar for optimistic UX.

      return true;
    },

    /**
     * Sends a VoiceChannelJoin activity over ActivityPub and waits for the
     * VoiceChannelJoinAccept carrying the LiveKit token.
     */
    async joinFederatedVoiceChannel(channelId: string, serverId: string, userId: string, abortSignal?: AbortSignal): Promise<boolean> {
      const serverUsersStore = useServerUsersStore();
      const serverChannelStore = useServerChannelStore();
      
      return new Promise((resolve, reject) => {
        if (abortSignal?.aborted) {
          reject(new DOMException('Connection cancelled', 'AbortError'));
          return;
        }
        
        const abortHandler = () => {
          debug.log('Federated connection attempt cancelled');
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
        
        // The answer arrives on the private user channel (federation-backend
        // broadcast_user_event). It counts only when it names the pending join id
        // and the host the join went to. Answers arriving before the join id is
        // known wait in `early`.
        const answersPendingJoin = (p: any): boolean => {
          const pending = this.pendingFederatedJoin;
          return !!pending?.joinId && !!pending.serverHost
            && p?.originalJoinId === pending.joinId && p?.serverHost === pending.serverHost;
        };
        const early: Array<{ event: 'token' | 'rejected'; payload: any }> = [];
        const holdEarly = (event: 'token' | 'rejected', p: any): boolean => {
          if (this.pendingFederatedJoin && !this.pendingFederatedJoin.joinId) {
            if (early.length < 8) early.push({ event, payload: p });
            return true;
          }
          return false;
        };

        const acceptToken = async (tokenPayload: any) => {
          if (abortSignal?.aborted) {
            abortHandler();
            return;
          }

          const { livekitUrl, token } = tokenPayload ?? {};
          if (typeof livekitUrl !== 'string' || !/^wss?:\/\//i.test(livekitUrl) || typeof token !== 'string' || !token) {
            debug.warn('Ignoring malformed federated voice token');
            return;
          }
          
          // The payload carries a LiveKit access token; log only its shape.
          debug.log('Received federated voice token for room:', tokenPayload?.roomName ?? '(unknown)');
          
          if (this.pendingFederatedJoin?.timeout) {
            clearTimeout(this.pendingFederatedJoin.timeout);
          }
          this.pendingFederatedJoin = null;
          
          if (abortSignal) {
            abortSignal.removeEventListener('abort', abortHandler);
          }
          
          try {
            this.setupWebRTCListeners();
            
            // Gate must be current before the mic publishes.
            this.syncTransmitGate();
            const success = await webrtcManager.joinWithToken(livekitUrl, token, channelId, userId);
            
            if (abortSignal?.aborted) {
              if (success) {
                await webrtcManager.leaveChannel();
              }
              abortHandler();
              return;
            }
            
            if (!success) {
              throw new Error(webrtcManager.getLastJoinError() ?? 'Could not connect to the remote voice server.');
            }
            
            this.connectionMode = webrtcManager.getActiveService() ?? 'livekit';
            this.connectionState = 'connected';
            this.isEncrypted = webrtcManager.isE2EEEnabled();
            this.applyAudioPrefs();
            debug.log('[VoiceChannel] Connected to federated voice channel via LiveKit');
            
            this.currentChannelId = channelId;
            this.currentServerId = serverId;
            const channel = serverChannelStore.channels.find((c: any) => c.id === channelId);
            this.currentChannelName = channel ? channel.name : 'Voice Channel';
            this.isConnected = true;
            this.isConnecting = false;
            this.connectionAbortController = null;
            setCallServiceActive(true);
            syncOverlayForCall(true);
            this.sessionStartTime = new Date();
            this.callStartTime = new Date();
            
            this.optimisticChannelId = null;
            this.optimisticServerId = null;
            this.optimisticChannelName = null;
            
            this.saveVoiceChannelState();
            this.startVoiceSessionHeartbeat();
            
            this.localState = webrtcManager.getLocalState();
            this.localStream = webrtcManager.getLocalStream();
            
            this.setupPushToTalk();
            
            // Join sound is played by ChannelSidebar for optimistic UX.

            resolve(true);
          } catch (error) {
            debug.error('Failed to connect with federated token:', error);
            this.cleanupFederatedSubscription();
            reject(error);
          }
        };

        const acceptRejection = (rejectPayload: any) => {
          debug.error('Voice join rejected:', rejectPayload);
          
          if (this.pendingFederatedJoin?.timeout) {
            clearTimeout(this.pendingFederatedJoin.timeout);
          }
          this.pendingFederatedJoin = null;
          this.cleanupFederatedSubscription();
          
          reject(new Error(rejectPayload?.reason || 'Voice join rejected by remote server'));
        };

        this.cleanupFederatedSubscription();
        const offToken = userEventChannel.on('federated_voice:token', async (payload) => {
          if (holdEarly('token', payload)) return;
          if (!answersPendingJoin(payload)) {
            debug.warn('Ignoring federated voice token that does not answer the pending join');
            return;
          }
          await acceptToken(payload);
        });
        const offRejected = userEventChannel.on('federated_voice:rejected', (payload) => {
          if (holdEarly('rejected', payload)) return;
          if (!answersPendingJoin(payload)) return;
          acceptRejection(payload);
        });
        federatedAnswerUnsubscribe = () => {
          offToken();
          offRejected();
        };
        
        // The federation backend sends the VoiceChannelJoin activity. Remote
        // servers own their own membership rows; nothing is written locally.
        (async () => {
          try {
            const session = await supabase.auth.getSession();
            if (!session.data.session) {
              this.cleanupFederatedSubscription();
              reject(new Error('Not authenticated'));
              return;
            }
            
            const response = await fetch(apiUrl('/api/federation/voice/join'), {
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

            const sent = await response.json().catch(() => ({}));
            if (typeof sent?.joinId !== 'string' || typeof sent?.serverHost !== 'string') {
              throw new Error('Voice join request returned no join id');
            }
            
            debug.log('Voice join request sent to federation backend');
            
            serverUsersStore.joinVoiceChannel(serverId, channelId, userId, false);

            if (this.pendingFederatedJoin) {
              this.pendingFederatedJoin.joinId = sent.joinId;
              this.pendingFederatedJoin.serverHost = sent.serverHost;
              const answer = early.find((e) => answersPendingJoin(e.payload));
              early.length = 0;
              if (answer?.event === 'token') await acceptToken(answer.payload);
              else if (answer?.event === 'rejected') acceptRejection(answer.payload);
            }
          } catch (error) {
            this.isConnecting = false;
            this.optimisticChannelId = null;
            this.optimisticServerId = null;
            this.optimisticChannelName = null;
            this.cleanupFederatedSubscription();
            reject(error);
          }
        })();
        
        const timeout = setTimeout(() => {
          if (abortSignal?.aborted) {
            return; // abortHandler already ran.
          }
          
          debug.error('Timeout waiting for federated voice token');
          if (abortSignal) {
            abortSignal.removeEventListener('abort', abortHandler);
          }
          this.pendingFederatedJoin = null;
          this.isConnecting = false;
          this.connectionAbortController = null;
          this.optimisticChannelId = null;
          this.optimisticServerId = null;
          this.optimisticChannelName = null;
          this.cleanupFederatedSubscription();
          serverUsersStore.leaveVoiceChannel(serverId, channelId, userId);
          reject(new Error('Timeout waiting for voice connection to remote server'));
        }, 20000);
        
        this.pendingFederatedJoin = { channelId, serverId, timeout, joinId: null, serverHost: null };
      });
    },
    
    cleanupFederatedSubscription() {
      if (federatedAnswerUnsubscribe) {
        federatedAnswerUnsubscribe();
        federatedAnswerUnsubscribe = null;
      }
    },

    async leaveVoiceChannel(): Promise<boolean> {
      try {
        const authStore = useAuthStore();
        const serverUsersStore = useServerUsersStore();
        const themeStore = useThemeStore();

        // A leave during connect cancels the attempt instead of disconnecting.
        if (this.isConnecting && this.connectionAbortController) {
          debug.log('Cancelling ongoing connection attempt...');
          
          const optimisticChannelId = this.optimisticChannelId;
          const optimisticServerId = this.optimisticServerId;
          
          this.connectionAbortController.abort();
          this.connectionAbortController = null;
          this.isConnecting = false;
          
          this.optimisticChannelId = null;
          this.optimisticServerId = null;
          this.optimisticChannelName = null;
          
          this.cleanupFederatedSubscription();
          if (this.pendingFederatedJoin?.timeout) {
            clearTimeout(this.pendingFederatedJoin.timeout);
            this.pendingFederatedJoin = null;
          }
          
          // Roll back presence recorded by the optimistic join.
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
          
          await webrtcManager.leaveChannel();
          
          // Signals the callee so their incoming-call modal dismisses.
          const isCancelledDMCall = optimisticChannelId?.startsWith('dm-') || optimisticChannelId?.startsWith('federated-dm-');
          if (isCancelledDMCall) {
            try {
              const { authContextService } = await import('@/services/AuthContextService');
              const profileId = await authContextService.getCurrentProfileId();
              if (optimisticChannelId?.startsWith('federated-dm-')) {
                const conversationId = dmCallSignaling.conversationForRoom(optimisticChannelId);
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
          
          debug.log('Connection attempt cancelled');
          return true;
        }

        if (!this.currentChannelId || !authStore.session?.user) {
          return true;
        }
        
        const userId = authStore.session.user.id;
        const wasFederated = this.isFederatedChannel;
        const channelId = this.currentChannelId;
        const serverId = this.currentServerId;
        debug.log('Leaving voice channel', wasFederated ? '(federated)' : '(local)');
        this.isConnected = false;
        setCallServiceActive(false);
        syncOverlayForCall(false);
        
        this.cleanupFederatedSubscription();
        if (this.pendingFederatedJoin?.timeout) {
          clearTimeout(this.pendingFederatedJoin.timeout);
          this.pendingFederatedJoin = null;
        }
        
        if (this.connectionAbortController) {
          this.connectionAbortController = null;
        }
        
        this.clearVoiceChannelState();
        
        const isDMCall = serverId === 'dm' || channelId?.startsWith('dm-') || channelId?.startsWith('federated-dm-');
        if (isDMCall) {
          try {
            const { authContextService } = await import('@/services/AuthContextService');
            const profileId = await authContextService.getCurrentProfileId();

            // Federated DM room: federated-dm-{caller's conversationId}-{timestamp}.
            // Ends via ActivityPub rather than local signaling.
            if (channelId?.startsWith('federated-dm-')) {
              const conversationId = dmCallSignaling.conversationForRoom(channelId);
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
        
        await webrtcManager.leaveChannel();

        this.cleanupSpatialAudio();
        void closeVoiceAudioContext();

        this.cleanupPushToTalk();
        
        if (serverId && channelId) {
          if (wasFederated) {
            const session = await supabase.auth.getSession();
            if (session.data.session) {
              fetch(apiUrl('/api/federation/voice/leave'), {
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
          
          await serverUsersStore.leaveVoiceChannel(serverId, channelId, userId, !wasFederated);
        }
        
        this.isFederatedChannel = false;
        this.resetState();
        
        themeStore.playAudio('voice_disconnect');

        return true;
      } catch (error) {
        debug.error('Failed to leave voice channel:', error);
        return false;
      }
    },

    async toggleVideo(): Promise<boolean> {
      const enabled = await webrtcManager.toggleVideo();

      this.localState = webrtcManager.getLocalState();
      this.localStream = webrtcManager.getLocalStream();

      debug.log('Video toggled, local stream updated:', {
        enabled,
        streamId: this.localStream?.id,
        videoTracks: this.localStream?.getVideoTracks().length || 0,
        audioTracks: this.localStream?.getAudioTracks().length || 0
      });
      
      this.refreshStreamState();
      
      return enabled;
    },

    async toggleScreenShare(): Promise<boolean> {
      const enabled = await webrtcManager.toggleScreenShare();

      this.localState = webrtcManager.getLocalState();
      this.localStream = webrtcManager.getLocalStream();

      debug.log('Screen share toggled, local stream updated:', {
        enabled,
        streamId: this.localStream?.id,
        videoTracks: this.localStream?.getVideoTracks().length || 0,
        audioTracks: this.localStream?.getAudioTracks().length || 0
      });

      this.refreshStreamState();

      return enabled;
    },

    /**
     * Toggles explicit mute. In PTT mode unmuting only re-arms the key; the
     * transmit gate stays closed until the key is held.
     */
    async toggleMute(): Promise<boolean> {
      const themeStore = useThemeStore();

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
        this.localState.isMuted = !this.localState.isMuted;
        debug.log('Setting preemptive mute state:', this.localState.isMuted);
        themeStore.playAudio(this.localState.isMuted ? 'mic_off' : 'mic_on');
        return this.localState.isMuted;
      }
    },

    setMuted(muted: boolean, playSound: boolean = false): void {
      const themeStore = useThemeStore();

      if (this.isConnected) {
        const currentMuted = this.localState.isMuted;
        if (currentMuted !== muted) {
          webrtcManager.setMuted(muted);
          this.localState = webrtcManager.getLocalState();
          if (playSound) {
            themeStore.playAudio(muted ? 'mic_off' : 'mic_on');
          }
          debug.log('[PTT] Set muted state:', muted);
        }
      } else {
        if (this.localState.isMuted !== muted) {
          this.localState.isMuted = muted;
          if (playSound) {
            themeStore.playAudio(muted ? 'mic_off' : 'mic_on');
          }
          debug.log('[PTT] Set preemptive muted state:', muted);
        }
      }
    },

    async toggleDeafen(): Promise<boolean> {
      const themeStore = useThemeStore();
      // Works while disconnected; the state is applied on the next join.
      if (this.isConnected) {
        const deafened = webrtcManager.toggleDeafen();
        this.localState = webrtcManager.getLocalState();
        themeStore.playAudio(deafened ? 'deafen_on' : 'deafen_off');
        return deafened;
      } else {
        this.localState.isDeafened = !this.localState.isDeafened;
        
        // Deafening implies mute.
        if (this.localState.isDeafened) {
          this.localState.isMuted = true;
        }
        
        debug.log('Setting preemptive deafen state:', this.localState.isDeafened);
        themeStore.playAudio(this.localState.isDeafened ? 'deafen_on' : 'deafen_off');
        return this.localState.isDeafened;
      }
    },

    toggleOverlay(): void {
      this.isOverlayVisible = !this.isOverlayVisible;
    },

    setLayoutMode(mode: 'grid' | 'speaker' | 'gallery'): void {
      this.layoutMode = mode;
    },

    setViewMode(mode: 'normal' | 'maximized' | 'fullscreen'): void {
      this.viewMode = mode;
      if (mode !== 'fullscreen') {
        this.fullscreenUserId = null;
      }
    },

    enterFullscreen(userId: string, source?: 'camera' | 'screen'): void {
      this.viewMode = 'fullscreen';
      this.fullscreenUserId = userId;
      // Screenshare wins over camera when both are live.
      const user = this.getUser(userId);
      this.fullscreenSource = source ?? (user?.isScreenSharing ? 'screen' : 'camera');
    },

    exitFullscreen(): void {
      this.viewMode = 'normal';
      this.fullscreenUserId = null;
      this.fullscreenSource = 'camera';
      this.isFullWindowMode = false;
    },

    toggleFullWindowMode(): void {
      this.isFullWindowMode = !this.isFullWindowMode;
    },

    /** A null userId closes PIP; the active userId toggles it off. */
    togglePIP(userId: string | null, mode: 'draggable' | 'fixed' | 'native' = 'native'): void {
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
     * Attaches via LiveKit's track.attach(). Setting srcObject directly makes
     * LiveKit disable every simulcast layer, which freezes the video.
     */
    attachVideoToElement(userId: string, videoElement: HTMLVideoElement, source: VideoSource = 'auto'): boolean {
      return webrtcManager.attachVideoToElement(userId, videoElement, source);
    },

    detachVideoFromElement(userId: string, videoElement: HTMLVideoElement, source: VideoSource = 'auto'): void {
      webrtcManager.detachVideoFromElement(userId, videoElement, source);
    },

    /**
     * Resolution (px height, -1 source), frame rate and stream audio bitrate
     * (kbps). Persisted; applied live to camera and screen tracks, and
     * used by the next capture otherwise.
     */
    async updateStreamQuality(settings: { resolution?: number; frameRate?: number; audioBitrate?: number }): Promise<void> {
      const newSettings = { ...this.streamSettings, ...settings };
      this.streamSettings = newSettings;

      try {
        userStorage.setItem('stream-settings', JSON.stringify(newSettings));
      } catch (error) {
        debug.warn('Failed to save stream settings:', error);
      }

      try {
        await webrtcManager.updateStreamQuality(settings);
      } catch (error) {
        debug.error('Failed to update stream quality:', error);
      }
    },

    loadStreamSettings(): void {
      try {
        const saved = userStorage.getItem('stream-settings');
        if (saved) {
          const settings = JSON.parse(saved);
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

    // PER-USER AUDIO (listener-side; persisted per user id)

    // Percent, clamped to 0-200; 100 is unity gain.
    setUserVolume(userId: string, volume: number): void {
      const clampedVolume = clampVolume(volume);
      this.userVolumes.set(userId, clampedVolume);
      webrtcManager.setUserMicVolume(userId, clampedVolume);
      this.persistAudioPrefs('mic');
    },

    // Percent, clamped to 0-200; 100 is unity gain.
    setUserScreenShareVolume(userId: string, volume: number): void {
      const clampedVolume = clampVolume(volume);
      this.userScreenShareVolumes.set(userId, clampedVolume);
      webrtcManager.setUserScreenShareVolume(userId, clampedVolume);
      this.persistAudioPrefs('screen');
    },

    setUserLocalMute(userId: string, kind: RemoteAudioKind, muted: boolean): void {
      const set = kind === 'mic' ? this.userMicMutes : this.userStreamMutes;
      if (muted) set.add(userId);
      else set.delete(userId);
      webrtcManager.setUserLocalMute(userId, kind, muted);
      this.persistAudioPrefs('mutes');
    },

    toggleUserLocalMute(userId: string, kind: RemoteAudioKind = 'mic'): boolean {
      const muted = !this.isUserLocallyMuted(userId, kind);
      this.setUserLocalMute(userId, kind, muted);
      return muted;
    },

    persistAudioPrefs(which: 'mic' | 'screen' | 'mutes'): void {
      try {
        if (which === 'mic') saveVolumes(userStorage, 'mic', this.userVolumes);
        else if (which === 'screen') saveVolumes(userStorage, 'screen', this.userScreenShareVolumes);
        else saveMutes(userStorage, { mic: this.userMicMutes, screen: this.userStreamMutes });
      } catch (error) {
        debug.warn('Failed to save audio preferences:', error);
      }
    },

    /** Reads stored volumes and mutes and seeds the mixer ahead of a join. */
    loadAudioPrefs(): void {
      try {
        const prefs = readAudioPrefs(userStorage);
        this.userVolumes = prefs.micVolumes;
        this.userScreenShareVolumes = prefs.streamVolumes;
        this.userMicMutes = prefs.mutes.mic;
        this.userStreamMutes = prefs.mutes.screen;
        webrtcManager.primeAudioPrefs(prefs);
      } catch (error) {
        debug.warn('Failed to load audio preferences:', error);
      }
    },

    /** Pushes stored preferences to the connected transport (native included). */
    applyAudioPrefs(): void {
      webrtcManager.applyAudioPrefs({
        micVolumes: this.userVolumes,
        streamVolumes: this.userScreenShareVolumes,
        mutes: { mic: this.userMicMutes, screen: this.userStreamMutes },
      });
    },

    /** Tears down a session whose link is gone, like a leave, and says so. */
    async dropLostVoiceConnection(): Promise<void> {
      clearReconnectGiveUp();
      if (!this.isConnected) return;
      debug.warn('Voice connection lost; leaving channel');
      await this.leaveVoiceChannel();
      useNotificationStore().showToast(
        'server_update',
        'Disconnected from voice',
        'The connection to the voice server was lost.',
        6000
      );
    },

    /** Resumes audio the browser blocked. Bound to a click. */
    async unlockAudio(): Promise<boolean> {
      const ok = await webrtcManager.startAudio();
      this.audioPlaybackBlocked = !ok;
      return ok;
    },

    // STREAM WATCHING

    watchStream(userId: string): void {
      if (!webrtcManager.supportsStreamWatching()) return;
      webrtcManager.setStreamWatched(userId, true);
    },

    stopWatchingStream(userId: string): void {
      if (this.fullscreenUserId === userId && this.fullscreenSource === 'screen') {
        this.exitFullscreen();
      }
      if (this.pipActive && this.pipUserId === userId) {
        this.togglePIP(null);
      }
      if (!webrtcManager.supportsStreamWatching()) return;
      webrtcManager.setStreamWatched(userId, false);
    },

    /** Echo cancellation, noise suppression, gain control; applied mid-call. */
    async updateAudioProcessing(constraints: { echoCancellation?: boolean; noiseSuppression?: boolean; autoGainControl?: boolean }): Promise<void> {
      await webrtcManager.updateAudioConstraints(constraints);
    },

    updateRecentSpeakers(userId: string): void {
      const now = Date.now();
      const existingIndex = this.recentSpeakers.findIndex(s => s.userId === userId);
      
      if (existingIndex !== -1) {
        this.recentSpeakers[existingIndex].lastSpokeAt = now;
      } else {
        this.recentSpeakers.push({ userId, lastSpokeAt: now });
        
        // Capped at 10; the UI shows 5, the rest cover rotation.
        if (this.recentSpeakers.length > 10) {
          this.recentSpeakers.sort((a, b) => b.lastSpokeAt - a.lastSpokeAt);
          this.recentSpeakers = this.recentSpeakers.slice(0, 10);
        }
      }
    },

    clearRecentSpeakers(): void {
      this.recentSpeakers = [];
    },

    setCallStartTime(timestamp: Date | null): void {
      this.callStartTime = timestamp;
    },

    setupWebRTCListeners(): void {
      if (webrtcListenersRegistered) return;
      webrtcListenersRegistered = true;

      const themeStore = useThemeStore();
      const serverUsersStore = useServerUsersStore();
      const authStore = useAuthStore();
      
      // From authStore: localState.userId can still be empty here.
      const currentUserId = authStore.session?.user?.id;

      // A closing page leaves its server voice channel; a crash or kill is left to the
      // server's LiveKit reconciliation.
      if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', () => {
          const serverId = this.currentServerId;
          const channelId = this.currentChannelId;
          if (!this.isConnected || !serverId || !channelId || serverId === 'dm' || this.isFederatedChannel) return;
          serverUsersStore.leaveVoiceChannelOnUnload(
            serverId, channelId, this.localState.userId, authStore.session?.access_token);
        });
      }
      
      webrtcManager.on('channel-joined', (data: any) => {
        debug.log('Channel joined:', data);
        this.connectionMode = webrtcManager.getActiveService();
        this.isEncrypted = webrtcManager.isE2EEEnabled();
        // The optimistic roster came from voice presence; from here on the
        // roster is whoever the media transport connects. P2P lists the local
        // user among its users; allUsers holds remote users only.
        const self = data?.userId || this.localState.userId;
        this.allUsers = webrtcManager.getAllUsers().filter((u) => u.userId !== self);
      });

      webrtcManager.on('channel-left', (data: any) => {
        debug.log('Channel left:', data);
        this.isEncrypted = false;
      });

      webrtcManager.on('e2ee-status-changed', (data: { enabled: boolean }) => {
        debug.log('E2EE status changed:', data);
        this.isEncrypted = !!data?.enabled;
      });

      webrtcManager.on('channel-state-synced', async (data: any) => {
        debug.log('Channel state synced:', data);
        this.allUsers = data.users;
        
        if (data.users.length === 0) {
          debug.log('First user in channel - broadcasting call start time');
          this.broadcastCallStartTime();
        } else {
          debug.log('Joining existing call - requesting call start time');
          this.requestCallStartTime();
        }

        const { ensureProfilesAvailable } = useUserData();
        const userIds = data.users.map((user: any) => user.userId);
        
        const userIdsChanged = !this.previousUserIds || userIds.length !== this.previousUserIds.length ||
          userIds.some((id: string, index: number) => id !== this.previousUserIds[index]);
        
        if (userIdsChanged && userIds.length > 0) {
          try {
            await ensureProfilesAvailable(userIds);
            debug.log('Loaded profiles for all voice users:', userIds.length);
            this.previousUserIds = userIds;
          } catch (error) {
            debug.warn('Failed to load profiles for voice users:', error);
          }
        } else {
          debug.log('ℹNo changes in user list, skipping profile load.');
        }
      });

      webrtcManager.on('user-joined', async (data: any) => {
        debug.log('User joined:', data);
        
        const existingIndex = this.allUsers.findIndex(u => u.userId === data.userId);
        if (existingIndex === -1) {
          this.allUsers.push(data.mediaState);
        } else {
          this.allUsers[existingIndex] = data.mediaState;
        }

        // Late joiners open the overlay on the first user already streaming.
        if (data.mediaState?.isVideoEnabled || data.mediaState?.isScreenSharing) {
          if (!this.isOverlayVisible) {
            this.isOverlayVisible = true;
            debug.log('Auto-opening overlay - existing video/screenshare user detected:', data.userId);
          }
        }

        if (!this.callStartTime) {
          debug.log('Requesting call start time from existing participants');
          this.requestCallStartTime();
        }

        const { ensureProfilesAvailable } = useUserData();
        try {
          await ensureProfilesAvailable([data.userId]);
          debug.log('Loaded profile for voice user:', data.userId);
        } catch (error) {
          debug.warn('Failed to load profile for voice user:', data.userId, error);
        }

        // Self-join sound is played by ChannelSidebar for optimistic UX.
        if (currentUserId && data.userId !== currentUserId) {
          themeStore.playAudio('voice_connect');
        }
      });

      webrtcManager.on('user-left', (data: any) => {
        debug.log('User left:', data);
        
        this.allUsers = this.allUsers.filter(u => u.userId !== data.userId);
        this.remoteStreams.delete(data.userId);
        if (data.userId in this.connectionQuality) {
          const { [data.userId]: _gone, ...rest } = this.connectionQuality;
          this.connectionQuality = rest;
        }
        
        this.removeUserFromSpatialAudio(data.userId);

        // Covers crashes and drops that skip a graceful leave. Federated
        // participants are cleaned up by their host instance.
        if (this.currentChannelId && this.currentServerId && !this.isFederatedChannel) {
          serverUsersStore.cleanupDisconnectedUser(
            this.currentServerId, 
            this.currentChannelId, 
            data.userId
          );
        }

        const totalUsers = this.allUsers.length + 1;
        if (totalUsers === 1) {
          debug.log('Last user left - resetting call start time');
          this.callStartTime = null;
        }

        // Self-disconnect sound is played by leaveVoiceChannel / ChannelSidebar.
        if (currentUserId && data.userId !== currentUserId) {
          themeStore.playAudio('voice_disconnect');
        }
      });

      webrtcManager.on('user-state-changed', (data: any) => {
        const userIndex = this.allUsers.findIndex(u => u.userId === data.userId);
        const oldState = userIndex !== -1 ? this.allUsers[userIndex] : null;
        const videoStateChanged = oldState && (
          oldState.isVideoEnabled !== data.mediaState.isVideoEnabled ||
          oldState.isScreenSharing !== data.mediaState.isScreenSharing
        );
        
        if (userIndex !== -1) {
          // splice, not index assignment: computed properties over allUsers
          // need the mutation to be tracked.
          this.allUsers.splice(userIndex, 1, data.mediaState);
        } else if (data.mediaState && data.mediaState.userId) {
          debug.log('User not in list, adding:', data.userId);
          this.allUsers.push(data.mediaState);
        }
        
        // Counter tracks video/screenshare changes only. Audio level updates
        // arrive 20+ times per second and must not bump it.
        if (videoStateChanged || !oldState) {
          this.streamUpdateCounter = (this.streamUpdateCounter || 0) + 1;
          debug.log('Video state changed for', data.userId, '- counter:', this.streamUpdateCounter,
            'video:', data.mediaState.isVideoEnabled, 'screen:', data.mediaState.isScreenSharing);
          // Screenshare toggles do not touch spatial audio: only the mic is
          // spatialized (addUserToSpatialAudio takes the mic-only stream) and
          // screenshare audio plays through its own stereo element.
        }

        // No overlay auto-open here; this fires on every state change.
        // Auto-open belongs to user-joined.
      });

      webrtcManager.on('user-stream-changed', (data: any) => {
        debug.log('User stream changed:', data.userId, 'hasStream:', !!data.stream);
        
        if (data.stream) {
          this.remoteStreams.set(data.userId, data.stream);
          this.addUserToSpatialAudio(data.userId);
        } else {
          this.remoteStreams.delete(data.userId);
          this.removeUserFromSpatialAudio(data.userId);
        }
        
        this.streamUpdateCounter = (this.streamUpdateCounter || 0) + 1;
      });

      webrtcManager.on('local-state-changed', (state: any) => {
        debug.log('Local state changed in store:', {
          isVideoEnabled: state.isVideoEnabled,
          isScreenSharing: state.isScreenSharing,
          isMuted: state.isMuted
        });

        const wasSharing = this.localState.isScreenSharing;
        const hadVideo = this.localState.isVideoEnabled;
        this.localState = state;

        if (!this.isConnected) return;
        const themeStore = useThemeStore();
        if (wasSharing !== state.isScreenSharing) {
          themeStore.playAudio(state.isScreenSharing ? 'screenshare_on' : 'screenshare_off');
        }
        if (hadVideo !== state.isVideoEnabled) {
          themeStore.playAudio(state.isVideoEnabled ? 'camera_on' : 'camera_off');
        }
      });
      
      webrtcManager.on('local-stream-changed', (stream: any) => {
        this.localStream = stream;
      });
      
      webrtcManager.on('stream-changed', (data: any) => {
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

      // Also drives the speaking indicator; threshold is level > 20.
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

      webrtcManager.on('connection-state-changed', (data: { state?: string }) => {
        if (!this.isConnected) return;
        const state = data?.state;
        if (state === 'reconnecting' || state === 'signalReconnecting') {
          this.connectionState = 'reconnecting';
          reconnectGiveUp ??= setTimeout(() => {
            reconnectGiveUp = null;
            void this.dropLostVoiceConnection();
          }, VOICE_RECONNECT_GIVE_UP_MS);
        } else if (state === 'connected') {
          this.connectionState = 'connected';
          clearReconnectGiveUp();
        }
      });

      // The transport gave up (server gone, network lost past the retry
      // window, duplicate session).
      webrtcManager.on('connection-lost', () => this.dropLostVoiceConnection());

      // Joined listen-only: the microphone never came up.
      webrtcManager.on('microphone-unavailable', () => {
        if (!this.isConnectedOrJoining) return;
        useNotificationStore().showToast(
          'server_update',
          'Microphone unavailable',
          'Joined muted: the microphone could not be opened.',
          6000
        );
      });

      webrtcManager.on('connection-quality-changed', (data: { userId: string; quality: VoiceConnectionQuality }) => {
        if (!data?.userId) return;
        this.connectionQuality = { ...this.connectionQuality, [data.userId]: data.quality };
      });

      webrtcManager.on('stream-watch-changed', (data: { userId: string; watching: boolean }) => {
        if (!data?.userId) return;
        const others = this.watchedStreamUserIds.filter(id => id !== data.userId);
        this.watchedStreamUserIds = data.watching ? [...others, data.userId] : others;
        if (!data.watching && this.pipActive && this.pipUserId === data.userId) {
          this.togglePIP(null);
        }
      });

      remoteAudioMixer.onBlockedChange((blocked) => {
        this.audioPlaybackBlocked = blocked && this.isConnectedOrJoining;
      });

      webrtcManager.on('error', (error: any) => {
        debug.error('WebRTC error:', error);
        // Logged only; no user-facing notification.
      });

      webrtcManager.on('call-start-time', (data: { timestamp: string; from: string }) => {
        this.handleCallStartTime(data.timestamp);
      });

      webrtcManager.on('request-call-start-time', (_data: { from: string }) => {
        if (this.callStartTime) {
          this.broadcastCallStartTime();
        }
      });
    },

    broadcastCallStartTime(): void {
      if (!this.currentChannelId || !this.callStartTime) return;
      
      webrtcManager.broadcastMessage({
        type: 'call-start-time',
        from: this.localState.userId,
        data: { timestamp: this.callStartTime.toISOString() },
        timestamp: Date.now()
      });
    },

    requestCallStartTime(): void {
      if (!this.currentChannelId) return;
      
      webrtcManager.broadcastMessage({
        type: 'request-call-start-time',
        from: this.localState.userId,
        data: {},
        timestamp: Date.now()
      });
    },

    handleCallStartTime(timestamp: string): void {
      if (!this.callStartTime) {
        this.callStartTime = new Date(timestamp);
        debug.log('Received call start time:', this.callStartTime);
      }
    },

    getTabId(): string {
      let tabId = sessionStorage.getItem('harmony-tab-id');
      if (!tabId) {
        tabId = `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        sessionStorage.setItem('harmony-tab-id', tabId);
      }
      return tabId;
    },

    // Persists reconnect state and the active-session marker used to block
    // a second tab from joining.
    saveVoiceChannelState(): void {
      if (this.currentChannelId && this.currentServerId) {
        const voiceState = {
          channelId: this.currentChannelId,
          serverId: this.currentServerId,
          channelName: this.currentChannelName,
          timestamp: Date.now()
        };
        // BUGS.md Pattern B / item #2: `userStorage` scopes the key to the
        // current user. An unscoped `localStorage` key survives logout, so on
        // a shared device the next user auto-reconnects to the previous
        // user's voice channel.
        userStorage.setItem('voiceChannelState', JSON.stringify(voiceState));

        const activeSession = {
          tabId: this.getTabId(),
          channelId: this.currentChannelId,
          timestamp: Date.now()
        };
        userStorage.setItem('active-voice-session', JSON.stringify(activeSession));
        
        debug.log('Saved voice channel state for auto-reconnect');
      }
    },

    startVoiceSessionHeartbeat(): void {
      this.stopVoiceSessionHeartbeat();
      
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

    stopVoiceSessionHeartbeat(): void {
      if (voiceSessionHeartbeat) {
        clearInterval(voiceSessionHeartbeat);
        voiceSessionHeartbeat = null;
      }
    },

    clearVoiceChannelState(): void {
      // Removes both the legacy unscoped key and the user-scoped one.
      localStorage.removeItem('voiceChannelState');
      userStorage.removeItem('voiceChannelState');
      userStorage.removeItem('active-voice-session');
      this._spatialMicTrackIds = {};
      this.stopVoiceSessionHeartbeat();
      debug.log('Cleared voice channel state');
    },

    async reconnectToVoiceChannel(): Promise<boolean> {
      // User-scoped storage first; the legacy global localStorage entry is a
      // fallback for sessions started before the key was scoped, and is
      // cleared by the next `clearVoiceChannelState()`.
      const savedState =
        userStorage.getItem('voiceChannelState') ?? localStorage.getItem('voiceChannelState');
      if (!savedState) {
        debug.log('ℹNo saved voice channel state found');
        return false;
      }

      try {
        const { channelId, serverId, channelName, timestamp } = JSON.parse(savedState);
        
        const dayInMs = 24 * 60 * 60 * 1000;
        if (Date.now() - timestamp > dayInMs) {
          debug.log('⏰ Saved voice channel state too old, clearing');
          this.clearVoiceChannelState();
          return false;
        }

        debug.log('Attempting to reconnect to voice channel:', channelName);
        
        const success = await this.joinVoiceChannel(channelId, serverId);
        
        if (success) {
          debug.log('Successfully reconnected to voice channel');
        } else {
          debug.log('Failed to reconnect, clearing saved state');
          this.clearVoiceChannelState();
        }
        
        return success;
      } catch (error) {
        debug.error('Error reconnecting to voice channel:', error);
        this.clearVoiceChannelState();
        return false;
      }
    },

    async initializeSpatialAudio(userId: string): Promise<void> {
      try {
        const spatialStore = useSpatialAudioStore();
        
        await spatialAudioService.initialize();
        spatialAudioService.setListener(userId);
        
        debug.log('Spatial audio initialized for user:', userId);
        
        if (spatialStore.settings.enabled) {
          debug.log('Spatial audio is enabled in settings - activating on load...');
          
          if (!spatialStore.userPositions.has(userId)) {
            spatialStore.initializeUserPosition(userId, true);
          }
          
          // Starts the update loop.
          await spatialAudioService.enableSpatialAudio();

          // Dry audio must be muted in the same tick as the enable, not in
          // the timeout below; otherwise dry and wet play together.
          webrtcManager.setTraditionalAudioEnabled(false);
          debug.log('Traditional audio muted immediately after spatial audio enabled');
          
          // 300ms: remote streams are not available at join time.
          setTimeout(async () => {
            const allUsers = webrtcManager.getAllUsers();
            const localUserId = webrtcManager.getLocalState().userId;
            
            for (const user of allUsers) {
              if (user.userId !== localUserId) {
                if (!spatialStore.userPositions.has(user.userId)) {
                  spatialStore.initializeUserPosition(user.userId, false);
                }
                
                // Mic only; screenshare audio stays stereo and out of the graph.
                const micStream = webrtcManager.getUserMicStream(user.userId);
                const micTrackId = micStream?.getAudioTracks()[0]?.id;
                if (micStream && micTrackId) {
                  await spatialAudioService.setupSpatialForUser(user.userId, micStream);
                  this._spatialMicTrackIds[user.userId] = micTrackId;
                  debug.log(`Setup spatial audio on load for user: ${user.userId}`);
                } else {
                  debug.warn(`Mic stream not ready yet for user: ${user.userId}`);
                }
              }
            }
            
            spatialAudioService.updateSpatialEffects();
            
            debug.log('Spatial audio activated on load with all users');
          }, 300);
        }
        
      } catch (error) {
        debug.error('Failed to initialize spatial audio:', error);
      }
    },

    // Per-user debounce timers for spatial audio setup.
    _spatialAudioDebounceTimers: {} as Record<string, ReturnType<typeof setTimeout>>,
    // Mic track currently wired into the spatial graph, per user. Lets
    // camera/screenshare toggles skip a rebuild.
    _spatialMicTrackIds: {} as Record<string, string>,

    /**
     * Wires a user's microphone into the spatial audio graph. Only the mic is
     * spatialized; screenshare audio has its own stereo element and never
     * enters the graph, so a screensharer's voice stays spatial.
     */
    addUserToSpatialAudio(userId: string): void {
      const spatialStore = useSpatialAudioStore();
      if (!spatialStore.settings.enabled) {
        return;
      }

      // BUGS.md #8: screen-share lifecycle paths (such as dismissing the
      // browser picker mid-flight) can re-enable the dry `<audio>` playback,
      // which then plays alongside the spatial graph. Dry mute is re-asserted
      // here so the two never overlap.
      try {
        webrtcManager.setTraditionalAudioEnabled(false);
      } catch (e) {
        debug.warn('Failed to mute traditional audio before re-adding spatial user:', e);
      }

      if (!spatialStore.userPositions.has(userId)) {
        spatialStore.initializeUserPosition(userId, false);
        debug.log('Initialized position for new user:', userId);
      }

      if (this._spatialAudioDebounceTimers[userId]) {
        clearTimeout(this._spatialAudioDebounceTimers[userId]);
      }

      // 50ms lets the MediaStream finish setup.
      this._spatialAudioDebounceTimers[userId] = setTimeout(async () => {
        delete this._spatialAudioDebounceTimers[userId];

        // Settings can change during the delay.
        if (!useSpatialAudioStore().settings.enabled) {
          return;
        }

        const micStream = webrtcManager.getUserMicStream(userId);
        const micTrackId = micStream?.getAudioTracks()[0]?.id;
        if (!micStream || !micTrackId) {
          debug.warn('No mic stream found for user:', userId);
          return;
        }

        // Same mic already in the graph. Stream-changed events fire on every
        // video toggle; rebuilding the audio chain there is audible.
        if (this._spatialMicTrackIds[userId] === micTrackId) {
          debug.log('Mic track unchanged for', userId, '- skipping spatial rebuild');
          return;
        }

        await spatialAudioService.setupSpatialForUser(userId, micStream);
        this._spatialMicTrackIds[userId] = micTrackId;
        spatialAudioService.updateSpatialEffects();
      }, 50);
    },

    removeUserFromSpatialAudio(userId: string): void {
      if (this._spatialAudioDebounceTimers[userId]) {
        clearTimeout(this._spatialAudioDebounceTimers[userId]);
        delete this._spatialAudioDebounceTimers[userId];
      }
      delete this._spatialMicTrackIds[userId];
      spatialAudioService.removeUser(userId);
    },

    cleanupSpatialAudio(): void {
      spatialAudioService.destroy();
    },

    /**
     * Transmit gate = not in PTT mode, or the PTT key is held. Explicit mute
     * is applied on top of this by the services.
     */
    syncTransmitGate(): void {
      const keybinds = useKeybinds();
      webrtcManager.setTransmitGate(!keybinds.isPTTMode.value || keybinds.isPTTActive.value);
    },

    // Registers the voice keybind handlers under the 'voice-connected' context.
    setupPushToTalk(): void {
      if (keybindListenersSetup) return;

      const keybinds = useKeybinds();

      keybinds.activateContext('voice-connected');

      keybinds.registerHandler('push-to-talk', () => this.syncTransmitGate());

      // The overlay registers its own handlers, which take priority while open.
      keybinds.registerHandler('toggle-mute', () => this.toggleMute());
      keybinds.registerHandler('toggle-deafen', () => this.toggleDeafen());
      keybinds.registerHandler('toggle-camera', () => this.toggleVideo());
      keybinds.registerHandler('toggle-screenshare', () => this.toggleScreenShare());

      keybinds.setupListeners();

      this.syncTransmitGate();
      inputModeWatchStop = watch(keybinds.isPTTMode, () => this.syncTransmitGate());

      keybindListenersSetup = true;
      debug.log('[Keybinds] Voice keybinds integrated with voice channel');
    },

    cleanupPushToTalk(): void {
      if (!keybindListenersSetup) return;

      const keybinds = useKeybinds();

      keybinds.deactivateContext('voice-connected');

      keybinds.unregisterHandler('push-to-talk');
      keybinds.unregisterHandler('toggle-mute');
      keybinds.unregisterHandler('toggle-deafen');
      keybinds.unregisterHandler('toggle-camera');
      keybinds.unregisterHandler('toggle-screenshare');

      keybinds.cleanupListeners();

      inputModeWatchStop?.();
      inputModeWatchStop = null;

      keybindListenersSetup = false;
      debug.log('[Keybinds] Voice keybinds cleanup complete');
    },

    resetState(): void {
      this.currentChannelId = null;
      this.currentServerId = null;
      this.dmOtherUserId = null;
      this.isConnected = false;
      this.isConnecting = false;
      this.connectionAbortController = null;
      setCallServiceActive(false);
      syncOverlayForCall(false);
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
      this.connectionState = null;
      clearReconnectGiveUp();
      this.connectionQuality = {};
      this.watchedStreamUserIds = [];
      this.audioPlaybackBlocked = false;
    },

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

    refreshStreamState(): void {
      const currentStream = webrtcManager.getLocalStream();
      if (currentStream) {
        this.localStream = null;
        nextTick(() => {
          this.localStream = currentStream;
          debug.log('Forced stream state refresh for UI reactivity');
        });
      }
    }
  }
});