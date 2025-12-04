<template>
  <!-- Unified Voice Dock - Combines best of both old and new systems -->
  <div v-if="voiceStore.isConnected" class="unified-voice-dock" :class="dockMode">
    <!-- Compact Mode (floating bar at bottom) -->
    <div v-if="currentMode === 'dock'" class="dock-container">
      <!-- User Info -->
      <div class="user-section">
        <div class="user-avatar-container">
          <Avatar
            :src="currentUserProfile?.avatar_url || '/default_avatar.png'"
            :alt="currentUserProfile?.display_name || 'User'"
            size="sm"
            class="user-avatar"
            :class="{ speaking: isCurrentUserSpeaking }"
          />
          <div v-if="isCurrentUserSpeaking" class="speaking-ring"></div>
        </div>
        <div class="user-details">
          <span class="user-name">{{ currentUserProfile?.display_name || currentUserProfile?.username || 'Unknown User' }}</span>
          <span class="channel-name">{{ channelName }}</span>
        </div>
      </div>

      <!-- Voice Controls -->
      <div class="voice-controls">
        <button
          @click="voiceStore.toggleMute"
          :class="['control-btn', 'mic-btn', { 
            active: !voiceStore.localState.isMuted && !voiceStore.localState.isDeafened,
            muted: voiceStore.localState.isMuted,
            deafened: voiceStore.localState.isDeafened,
            'ptt-mode': isPTTMode,
            'ptt-active': isPTTActive
          }]"
          :title="isPTTMode 
            ? (isPTTActive ? `Transmitting (${pttKeyDisplay})` : `Push ${pttKeyDisplay} to talk`) 
            : (voiceStore.localState.isMuted ? 'Unmute' : 'Mute')"
        >
          <Icon :name="voiceStore.localState.isMuted || voiceStore.localState.isDeafened ? 'mic-off' : 'mic'" />
          <span v-if="isPTTMode" class="ptt-indicator" :class="{ active: isPTTActive }">PTT</span>
        </button>

        <button
          @click="voiceStore.toggleDeafen"
          :class="['control-btn', 'headphones-btn', { 
            active: !voiceStore.localState.isDeafened,
            deafened: voiceStore.localState.isDeafened 
          }]"
          :title="voiceStore.localState.isDeafened ? 'Undeafen' : 'Deafen'"
        >
          <Icon :name="voiceStore.localState.isDeafened ? 'headphones-off' : 'headphones'" />
        </button>

        <button
          @click="voiceStore.toggleVideo"
          :class="['control-btn', 'video-btn', { 
            active: voiceStore.localState.isVideoEnabled && !voiceStore.localState.isScreenSharing
          }]"
          :title="voiceStore.localState.isVideoEnabled && !voiceStore.localState.isScreenSharing ? 'Turn off camera' : 'Turn on camera'"
        >
          <Icon name="camera" />
        </button>

        <button
          @click="voiceStore.toggleScreenShare"
          :class="['control-btn', 'screen-btn', { 
            active: voiceStore.localState.isScreenSharing
          }]"
          :title="voiceStore.localState.isScreenSharing ? 'Stop screen share' : 'Share screen'"
        >
          <Icon name="screen-share" />
        </button>

        <button
          @click="toggleSpatialPanel"
          :class="['control-btn', 'spatial-btn', { 
            active: spatialStore.isPanelVisible,
            'spatial-enabled': spatialStore.settings.enabled
          }]"
          :title="spatialStore.settings.enabled ? 'Spatial Audio: ON' : 'Spatial Audio: OFF'"
        >
          <Icon name="map" />
          <span v-if="spatialStore.settings.enabled" class="spatial-badge">3D</span>
        </button>

        <button
          @click="toggleSettings"
          :class="['control-btn', 'settings-btn', { active: showSettings }]"
          title="Voice Settings"
        >
          <Icon name="settings" />
        </button>
      </div>

      <!-- Action Controls -->
      <div class="action-controls">
        <button
          @click="expandToOverlay"
          class="control-btn expand-btn"
          title="Expand to overlay"
        >
          <Icon name="maximize" />
        </button>
        
        <button
          @click="minimizeDock"
          class="control-btn minimize-btn"
          title="Minimize"
        >
          <Icon name="minimize" />
        </button>

        <button
          @click="leaveChannel"
          class="control-btn leave-btn"
          title="Leave channel"
        >
          <Icon name="phone-off" />
        </button>
      </div>
    </div>

    <!-- Minimized Mode (tiny dock in channel sidebar) -->
    <div v-else-if="currentMode === 'minimized'" class="minimized-container" @click="expandToDock">
      <!-- Mini Video Preview (when someone is sharing video/screen) - hide if PIP is active -->
      <div v-if="activeVideoUser && !voiceStore.pipActive" class="minimized-video-preview" @click.stop="expandToOverlay">
        <video
          ref="minimizedVideoRef"
          autoplay
          playsinline
          muted
          class="mini-video"
        />
        <div class="mini-video-overlay">
          <span class="mini-video-label">
            <Icon :name="activeVideoUser.isScreenSharing ? 'screen-share' : 'camera'" />
            {{ activeVideoUserName }}
          </span>
          <button
            class="mini-pip-btn"
            @click.stop="activatePIPForActiveVideo"
            title="Pop out"
          >
            <Icon name="maximize-2" />
          </button>
        </div>
      </div>

      <div class="minimized-content">
        <div class="minimized-info">
          <Icon name="volume" class="channel-icon" />
          <span class="channel-name">{{ channelName }}</span>
          <span class="participant-count">{{ voiceStore.connectionStats.total }}</span>
          <!-- Recent Speakers -->
          <RecentSpeakers class="recent-speakers-container" :max-speakers="4" />
        </div>
        
        <div class="minimized-controls">
          <button 
            @click.stop="voiceStore.toggleMute"
            class="mini-control-btn"
            :class="{ muted: voiceStore.localState.isMuted }"
            :title="voiceStore.localState.isMuted ? 'Unmute' : 'Mute'"
          >
            <Icon :name="voiceStore.localState.isMuted ? 'mic-off' : 'mic'" />
          </button>
          
          <button 
            @click.stop="voiceStore.toggleDeafen"
            class="mini-control-btn"
            :class="{ deafened: voiceStore.localState.isDeafened }"
            :title="voiceStore.localState.isDeafened ? 'Undeafen' : 'Deafen'"
          >
            <Icon :name="voiceStore.localState.isDeafened ? 'headphones-off' : 'headphones'" />
          </button>
          
          <button 
            @click.stop="leaveChannel"
            class="mini-control-btn leave"
            title="Leave channel"
          >
            <Icon name="phone-off" />
          </button>
        </div>
      </div>
    </div>

    <!-- Voice Settings Panel -->
    <VoiceSettingsPanel 
      v-if="showSettings"
      @close="showSettings = false"
    />

    <!-- Spatial Audio Panel -->
    <SpatialAudioPanel 
      :is-under-dock="currentMode === 'dock'"
      :is-under-overlay="currentMode === 'overlay'"
    />

    <!-- Full Overlay Mode -->
    <UnifiedVoiceOverlay
      v-if="currentMode === 'overlay'"
      :channel-name="channelName"
      @close="handleOverlayClosed"
      @minimize="collapseToMinimized"
    />
    
    <!-- Screenshare PIP - Always rendered when connected, regardless of dock mode -->
    <!-- This allows PIP to work even when dock is minimized -->
    <ScreensharePIP />
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, defineAsyncComponent } from 'vue';
import { debug } from '@/utils/debug'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useSpatialAudioStore } from '@/stores/spatialAudio';
import { useAuthStore } from '@/stores/auth';
import { useUserData } from '@/composables/useUserData';
import { usePushToTalk } from '@/composables/usePushToTalk';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';

const UnifiedVoiceOverlay = defineAsyncComponent(() => import('./UnifiedVoiceOverlay.vue'));
const VoiceSettingsPanel = defineAsyncComponent(() => import('./VoiceSettingsPanel.vue'));

// PTT composable
const { isPTTMode, isPTTActive, pttKeyDisplay, shouldBlockShortcut } = usePushToTalk();
const SpatialAudioPanel = defineAsyncComponent(() => import('./SpatialAudioPanel.vue'));
const RecentSpeakers = defineAsyncComponent(() => import('./RecentSpeakers.vue'));
const ScreensharePIP = defineAsyncComponent(() => import('./ScreensharePIP.vue'));

// =============================================================================
// STORE INSTANCES
// =============================================================================
// The original used `any` to avoid leaking private store types, which is preserved here.
const voiceStore: any = useUnifiedVoiceChannelStore();
const spatialStore = useSpatialAudioStore();
const authStore = useAuthStore();
const { getUser } = useUserData();

// =============================================================================
// STATE
// =============================================================================
const currentMode = ref<'dock' | 'minimized' | 'overlay'>('dock');
const showSettings = ref(false);
const minimizedVideoRef = ref<HTMLVideoElement | null>(null);

// =============================================================================
// COMPUTED PROPERTIES
// =============================================================================
const channelName = computed(() => {
  return voiceStore.currentChannelName || 'Voice Channel';
});

const currentUserId = computed(() => authStore.session?.user?.id);

const currentUserProfile = computed(() => {
  if (!currentUserId.value) {
    return { display_name: 'Unknown', username: 'Unknown', avatar_url: '/default_avatar.png' };
  }
  
  try {
    const user = getUser(currentUserId.value)?.value;
    if (!user) {
      return { display_name: 'Unknown', username: 'Unknown', avatar_url: '/default_avatar.png' };
    }
    
    return {
      display_name: user.displayName || null,
      username: user.username || 'Unknown',
      avatar_url: user.avatarUrl || '/default_avatar.png'
    };
  } catch (error) {
    debug.warn('Error getting current user profile for voice dock:', error);
    return { display_name: 'Unknown', username: 'Unknown', avatar_url: '/default_avatar.png' };
  }
});

const isCurrentUserSpeaking = computed(() => {
  return voiceStore.localState.audioLevel > 20 && !voiceStore.localState.isMuted;
});

const dockMode = computed(() => ({
  'dock-mode': currentMode.value === 'dock',
  'minimized-mode': currentMode.value === 'minimized',
  'overlay-mode': currentMode.value === 'overlay'
}));

// Get first user with active video or screenshare (for minimized preview)
const activeVideoUser = computed(() => {
  // First check for screensharing users (higher priority)
  const screensharing = voiceStore.allParticipants.find((p: any) => p.isScreenSharing);
  if (screensharing) return screensharing;
  
  // Then check for video-enabled users
  const withVideo = voiceStore.allParticipants.find((p: any) => p.isVideoEnabled && !p.isScreenSharing);
  return withVideo || null;
});

const activeVideoStream = computed(() => {
  if (!activeVideoUser.value) return null;
  return voiceStore.getUserStream(activeVideoUser.value.userId);
});

const activeVideoUserName = computed(() => {
  if (!activeVideoUser.value) return '';
  const profile = getUser(activeVideoUser.value.userId)?.value;
  return profile?.displayName || profile?.username || 'User';
});

// =============================================================================
// METHODS
// =============================================================================
const expandToOverlay = () => {
  currentMode.value = 'overlay';
  voiceStore.isOverlayVisible = true;
};

const expandToDock = () => {
  currentMode.value = 'dock';
  voiceStore.isOverlayVisible = false;
};

const minimizeDock = () => {
  currentMode.value = 'minimized';
  voiceStore.isOverlayVisible = false;
};

const collapseToMinimized = () => {
  currentMode.value = 'minimized';
  voiceStore.isOverlayVisible = false;
};

const toggleSettings = () => {
  showSettings.value = !showSettings.value;
};

const toggleSpatialPanel = () => {
  spatialStore.togglePanel();
};

const leaveChannel = async () => {
  await voiceStore.leaveVoiceChannel();
  currentMode.value = 'dock'; // Reset to default state after leaving
};

const handleOverlayClosed = () => {
  // When the overlay is closed, return to the docked mode.
  currentMode.value = 'dock';
};

const activatePIPForActiveVideo = () => {
  if (activeVideoUser.value) {
    // Activate PIP directly - works from any mode (minimized, dock, or overlay)
    // The floating video will appear while keeping current dock state
    // Use 'draggable' mode so users can move and resize it
    voiceStore.togglePIP(activeVideoUser.value.userId, 'draggable');
  }
};

// =============================================================================
// WATCHERS
// =============================================================================

// Track last attached user to prevent flashing from repeated attachments
let lastAttachedUserId: string | null = null;
let lastAttachedElement: HTMLVideoElement | null = null;

// Attach video to minimized preview using LiveKit's proper method
// Only re-attach when the user actually changes, not on every counter update
watch(
  [activeVideoUser, minimizedVideoRef],
  ([user, videoEl]) => {
    const userId = user?.userId || null;
    
    // Skip if same user is already attached to same element
    if (userId === lastAttachedUserId && videoEl === lastAttachedElement && videoEl?.srcObject) {
      return;
    }
    
    if (user && videoEl) {
      const attached = voiceStore.attachVideoToElement(user.userId, videoEl);
      if (!attached && activeVideoStream.value) {
        // Fallback to srcObject if attach fails (P2P mode)
        videoEl.srcObject = activeVideoStream.value;
      }
      lastAttachedUserId = userId;
      lastAttachedElement = videoEl;
    } else if (videoEl) {
      // Clean up when no active video user
      voiceStore.detachVideoFromElement(lastAttachedUserId || '', videoEl);
      videoEl.srcObject = null;
      lastAttachedUserId = null;
      lastAttachedElement = null;
    }
  },
  { immediate: true }
);

// Only react to stream counter when user changes or stream is lost
watch(
  () => voiceStore.streamUpdateCounter,
  () => {
    const user = activeVideoUser.value;
    const videoEl = minimizedVideoRef.value;
    
    // Only re-attach if we have a user but no video is playing
    if (user && videoEl && !videoEl.srcObject) {
      const attached = voiceStore.attachVideoToElement(user.userId, videoEl);
      if (!attached && activeVideoStream.value) {
        videoEl.srcObject = activeVideoStream.value;
      }
    }
  }
);

// Sync store's isOverlayVisible with local currentMode
// This ensures when the store auto-opens overlay (e.g., when video is detected), the dock responds
watch(
  () => voiceStore.isOverlayVisible,
  (shouldShowOverlay) => {
    if (shouldShowOverlay && currentMode.value !== 'overlay') {
      currentMode.value = 'overlay';
      debug.log('📺 [Dock] Auto-switching to overlay mode from store');
    }
  },
  { immediate: true }
);

// =============================================================================
// LIFECYCLE & EVENT LISTENERS
// =============================================================================
onMounted(() => {
  // Start in dock mode ONLY if the store doesn't want overlay visible
  // (e.g., when auto-opening for video detection)
  if (!voiceStore.isOverlayVisible) {
    currentMode.value = 'dock';
  } else {
    currentMode.value = 'overlay';
  }
  
  // Keyboard shortcuts
  const handleKeyPress = (event: KeyboardEvent) => {
    // Ignore keypresses in input fields
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    
    // Don't handle shortcuts that conflict with PTT keybind
    if (shouldBlockShortcut(event)) {
      return;
    }
    
    // Only handle shortcuts when not in overlay mode
    if (currentMode.value !== 'overlay') {
      switch (event.key.toLowerCase()) {
        case 'm':
          voiceStore.toggleMute();
          break;
        case 'd':
          voiceStore.toggleDeafen();
          break;
        case 'v':
          voiceStore.toggleVideo();
          break;
        case 's':
          if (event.ctrlKey || event.metaKey) return; // Don't interfere with save shortcut
          voiceStore.toggleScreenShare();
          break;
      }
    }
  };
  
  document.addEventListener('keydown', handleKeyPress);
  
  // Clean up the event listener when the component is unmounted
  onUnmounted(() => {
    document.removeEventListener('keydown', handleKeyPress);
  });
});
</script>

<style scoped>
/* Base dock positioning */
.unified-voice-dock {
  position: fixed;
  z-index: 1000;
}

/* Compact Mode - floating bar centered at bottom */
.unified-voice-dock.dock-mode {
  bottom: 0px;
  left: 50%;
  transform: translateX(-50%);
}

/* Minimized Mode - tiny dock in channel sidebar */
.unified-voice-dock.minimized-mode {
  bottom: 72px; /* Height of UserProfileComponent */
  left: 72px;   /* Offset from ServerSidebar (72px width) */
  width: 240px; /* Width of channel sidebar */
  transform: none;
  z-index: 10;  /* Above UserProfileComponent but below global overlays */
}

/* Overlay Mode - full screen view with all participants */
.unified-voice-dock.overlay-mode {
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  transform: none;
}

/* =============================================================================
   COMPACT MODE (Floating bar at bottom)
   ============================================================================= */

.dock-container {
  background: linear-gradient(145deg, #2f3136, #36393f);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 400px;
  box-shadow: 
    0 8px 32px rgba(0, 0, 0, 0.6),
    0 4px 16px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(20px);
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  margin-bottom: 80px;
}

.dock-container:hover {
  background: linear-gradient(145deg, #36393f, #40444b);
  transform: translateY(-2px);
  box-shadow: 
    0 12px 40px rgba(0, 0, 0, 0.7),
    0 6px 20px rgba(0, 0, 0, 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
}

/* User Section */
.user-section {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.user-avatar-container {
  position: relative;
  width: 48px;
  height: 48px;
}

.user-avatar {
  /* width: 100%;
  height: 100%; */
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid #40444b;
  transition: all 0.3s ease;
}

.user-avatar.speaking {
  border-color: #00d4aa;
  box-shadow: 0 0 20px rgba(0, 212, 170, 0.4);
}

.speaking-ring {
  position: absolute;
  top: -4px;
  left: -4px;
  right: -4px;
  bottom: -4px;
  border: 2px solid #00d4aa;
  border-radius: 50%;
  animation: pulse-ring 2s infinite;
}

.user-details {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.user-name {
  /* color: #ffffff; */
  color: var(--text-primary);
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.channel-name {
  /* color: var(--text-secondary); */
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Voice Controls */
.voice-controls {
  display: flex;
  gap: 8px;
}

.control-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(0, 0, 0, 0.3);
  /* color: var(--text-secondary); */
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  backdrop-filter: blur(10px);
}

.control-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.3);
  transform: scale(1.05);
}

.control-btn.active {
  background: linear-gradient(145deg, #00d4aa, #00b894);
  color: white;
  border-color: rgba(0, 212, 170, 0.6);
  box-shadow: 0 4px 12px rgba(0, 212, 170, 0.3);
}

.control-btn.muted {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: white;
  border-color: rgba(237, 66, 69, 0.6);
  box-shadow: 0 4px 12px rgba(237, 66, 69, 0.3);
}

/* PTT Mode Styles */
.control-btn.ptt-mode {
  position: relative;
}

.control-btn.ptt-active {
  background: linear-gradient(145deg, #00d4aa, #00b894) !important;
  color: white !important;
  border-color: rgba(0, 212, 170, 0.6) !important;
  box-shadow: 0 4px 12px rgba(0, 212, 170, 0.4), 0 0 20px rgba(0, 212, 170, 0.3) !important;
  animation: ptt-pulse 0.5s ease-in-out infinite;
}

@keyframes ptt-pulse {
  0%, 100% {
    box-shadow: 0 4px 12px rgba(0, 212, 170, 0.4), 0 0 20px rgba(0, 212, 170, 0.3);
  }
  50% {
    box-shadow: 0 4px 16px rgba(0, 212, 170, 0.6), 0 0 30px rgba(0, 212, 170, 0.4);
  }
}

.ptt-indicator {
  position: absolute;
  top: -6px;
  right: -6px;
  font-size: 8px;
  font-weight: 700;
  padding: 2px 4px;
  background: rgba(0, 0, 0, 0.6);
  color: #888;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.ptt-indicator.active {
  background: #00d4aa;
  color: white;
}

.control-btn.deafened {
  background: linear-gradient(145deg, #faa61a, #e67e22);
  color: white;
  border-color: rgba(250, 166, 26, 0.6);
  box-shadow: 0 4px 12px rgba(250, 166, 26, 0.3);
}

/* Spatial audio button with indicator */
.control-btn.spatial-btn {
  position: relative;
}

.control-btn.spatial-enabled {
  background: linear-gradient(145deg, #00d4aa, #00b894);
  color: white;
  border-color: rgba(0, 212, 170, 0.6);
  box-shadow: 0 0 10px rgba(0, 212, 170, 0.4);
}

.control-btn.spatial-enabled:hover {
  background: linear-gradient(145deg, #00e5b8, #00c9a0);
}

.spatial-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: #00d4aa;
  color: #000;
  font-size: 7px;
  font-weight: 800;
  padding: 2px 3px;
  border-radius: 3px;
  line-height: 1;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}

/* Action Controls */
.action-controls {
  display: flex;
  gap: 6px;
}

.expand-btn:hover {
  background: linear-gradient(145deg, #5865f2, #4752c4);
  color: white;
  border-color: rgba(88, 101, 242, 0.6);
}

.minimize-btn:hover {
  background: linear-gradient(145deg, #faa61a, #e67e22);
  color: white;
  border-color: rgba(250, 166, 26, 0.6);
}

.leave-btn:hover {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: white;
  border-color: rgba(237, 66, 69, 0.6);
}

/* =============================================================================
   MINIMIZED MODE (Tiny dock in channel sidebar)
   ============================================================================= */

.minimized-container {
  background: linear-gradient(145deg, #2f3136, #36393f);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 12px 16px;
  cursor: pointer;
  transition: all 0.3s ease;
  width: 100%; /* Use full width of minimized dock container */
  box-shadow: 
    0 6px 20px rgba(0, 0, 0, 0.4),
    0 2px 8px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(10px);
  margin-bottom: 0; /* Remove bottom margin for tight positioning */
}

.minimized-container:hover {
  background: linear-gradient(145deg, #36393f, #40444b);
  transform: translateY(-1px);
  box-shadow: 
    0 8px 25px rgba(0, 0, 0, 0.5),
    0 3px 10px rgba(0, 0, 0, 0.4);
}

/* Minimized Video Preview */
.minimized-video-preview {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  max-height: 120px;
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 10px;
  background: #000;
  cursor: default;
}

.mini-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.mini-video-overlay {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.8));
}

.mini-video-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #fff;
  font-weight: 500;
}

.mini-pip-btn {
  background: rgba(255, 255, 255, 0.2);
  border: none;
  border-radius: 4px;
  padding: 4px 6px;
  color: #fff;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 12px;
}

.mini-pip-btn:hover {
  background: rgba(255, 255, 255, 0.3);
  transform: scale(1.05);
}

.minimized-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.minimized-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.channel-icon {
  color: #5865f2;
  font-size: 16px;
}

.minimized-info .channel-name {
  color: #ffffff;
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.participant-count {
  background: rgba(88, 101, 242, 0.2);
  color: #5865f2;
  padding: 2px 6px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 600;
  min-width: 20px;
  text-align: center;
}

.recent-speakers-container {
  margin-left: 4px;
  flex-shrink: 0;
}

.minimized-controls {
  display: flex;
  gap: 6px;
}

.mini-control-btn {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(0, 0, 0, 0.3);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}

.mini-control-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.3);
}

.mini-control-btn.muted {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: white;
  border-color: rgba(237, 66, 69, 0.6);
}

.mini-control-btn.deafened {
  background: linear-gradient(145deg, #faa61a, #e67e22);
  color: white;
  border-color: rgba(250, 166, 26, 0.6);
}

.mini-control-btn.leave {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: white;
  border-color: rgba(237, 66, 69, 0.6);
}

/* =============================================================================
   ANIMATIONS
   ============================================================================= */

@keyframes pulse-ring {
  0% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.1); opacity: 0.7; }
  100% { transform: scale(1.2); opacity: 0; }
}

/* =============================================================================
   RESPONSIVE DESIGN
   ============================================================================= */

@media (max-width: 768px) {
  .unified-voice-dock {
    bottom: 10px;
    left: 10px;
    right: 10px;
  }
  .unified-voice-dock.dock-mode {
    left: 10px;
    transform: translateX(0);
  }
  
  .dock-container {
    min-width: auto;
    width: 100%;
  }
  
  .minimized-container {
    min-width: auto;
    width: 100%;
  }
  
  .user-section {
    flex: 0 1 auto;
  }
  
  .voice-controls {
    gap: 6px;
  }
  
  .control-btn {
    width: 32px;
    height: 32px;
    font-size: 12px;
  }
}

@media (max-width: 480px) {
  .dock-container {
    /* flex-direction: column; */
    gap: 12px;
    padding: 12px;
  }
  
  .user-section {
    width: 100%;
  }
  
  .voice-controls,
  .action-controls {
    justify-content: center;
  }
}
</style>