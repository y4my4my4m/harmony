<template>
  <!-- Unified Voice Dock - Combines best of both old and new systems -->
  <div v-if="voiceStore.isConnectedOrJoining" class="unified-voice-dock" :class="[dockMode, { 'is-connecting': voiceStore.isConnecting }]">
    <!-- Compact Mode (floating bar at bottom) -->
    <div 
      v-if="currentMode === 'dock'" 
      ref="dockContainerRef"
      class="dock-container"
      :class="{ 'is-dragging': isDockDragging }"
      :style="dockPositionStyle"
      @mousedown="startDockDrag"
      @touchstart="startDockDrag"
      @click="handleDockClick"
    >
      <!-- User Info - Tappable on mobile to expand -->
      <div 
        class="user-section" 
        @click="handleUserSectionClick"
      >
        <div class="user-avatar-container">
          <Avatar
            :src="currentUserProfile?.avatar_url || '/default_avatar.webp'"
            :alt="currentUserProfile?.display_name || 'User'"
            size="sm"
            class="user-avatar"
            :class="{ speaking: isCurrentUserSpeaking }"
          />
          <!-- Voice activity ring -->
          <div v-if="isCurrentUserSpeaking" class="voice-ring" :style="{ '--intensity': voiceIntensity }">
            <svg class="voice-ring-svg" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="45" class="voice-ring-bg" />
              <circle
                cx="50"
                cy="50"
                r="45"
                class="voice-ring-active"
                :style="{ strokeDashoffset: voiceRingOffset }"
              />
            </svg>
          </div>
        </div>
        <div class="user-details">
          <span class="user-name"><DisplayName v-if="currentUserId" :userId="currentUserId" :fallback="currentUserProfile?.display_name || currentUserProfile?.username || 'Unknown User'" :truncate="true" /></span>
          <span class="channel-name">
            <DisplayName v-if="voiceStore.dmOtherUserId" :user-id="voiceStore.dmOtherUserId" :fallback="channelName" :truncate="true" />
            <template v-else>{{ channelName }}</template>
            <span class="dock-connection-badge" :class="voiceStore.connectionMode || 'unknown'">
              {{ voiceStore.connectionMode === 'livekit' ? 'SFU' : voiceStore.connectionMode === 'p2p' ? 'P2P' : '' }}
            </span>
          </span>
        </div>
      </div>

      <!-- Voice Controls -->
      <div class="voice-controls" @mousedown.stop @touchstart.stop>
        <button
          @click="voiceStore.toggleMute"
          :class="['control-btn', 'mic-btn', { 
            active: !voiceStore.localState.isMuted && !voiceStore.localState.isDeafened,
            muted: voiceStore.localState.isMuted,
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
          <Icon :name="voiceStore.localState.isVideoEnabled && !voiceStore.localState.isScreenSharing ? 'video-off' : 'video'" />
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

      <!-- Video Preview Thumbnail (when someone has video/screenshare) -->
      <div 
        v-if="activeVideoUser && !voiceStore.pipActive" 
        class="dock-video-preview"
        @click="expandToOverlay"
        @mousedown.stop
        @touchstart.stop
        :title="`${activeVideoUserName} is ${activeVideoUser.isScreenSharing ? 'sharing screen' : 'on camera'}`"
      >
        <video
          ref="dockVideoRef"
          autoplay
          playsinline
          muted
          class="dock-video"
        />
        <div class="dock-video-badge">
          <Icon :name="activeVideoUser.isScreenSharing ? 'screen-share' : 'video'" />
        </div>
      </div>

      <!-- Action Controls -->
      <div class="action-controls" @mousedown.stop @touchstart.stop>
        <button
          @click.stop="toggleParticipantsDropdown"
          class="control-btn participants-btn"
          :class="{ active: showParticipantsDropdown }"
          title="Show participants"
        >
          <Icon name="users" />
        </button>

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
    <div 
      v-else-if="currentMode === 'minimized'" 
      ref="minimizedContainerRef"
      class="minimized-container" 
      :class="{ 'is-dragging': isDragging }"
      :style="minimizedPositionStyle"
      @mousedown="handleMinimizedMouseDown"
      @click="handleMinimizedClick"
    >
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
            <Icon :name="activeVideoUser.isScreenSharing ? 'screen-share' : 'video'" />
            <DisplayName v-if="activeVideoUser" :userId="activeVideoUser.userId" :fallback="activeVideoUserName" />
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
        <div 
          class="minimized-info"
          @mousedown="startDrag"
          @touchstart="startDrag"
        >
          <Icon name="volume" class="channel-icon" />
          <span class="channel-name">
            <DisplayName v-if="voiceStore.dmOtherUserId" :user-id="voiceStore.dmOtherUserId" :fallback="channelName" :truncate="true" />
            <template v-else>{{ channelName }}</template>
          </span>
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
            <Icon :name="voiceStore.localState.isMuted || voiceStore.localState.isDeafened ? 'mic-off' : 'mic'" />
          </button>
          
          <button 
            @click.stop="voiceStore.toggleDeafen"
            class="mini-control-btn"
            :class="{ deafened: voiceStore.localState.isDeafened }"
            :title="voiceStore.localState.isDeafened ? 'Undeafen' : 'Deafen'"
          >
            <HeadphonesIcon :isHeadphonesActive="!voiceStore.localState.isDeafened" />
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
    
    <!-- Participants Dropdown for Minimized Mode (only shown when not at default position, outside container) -->
    <div 
      v-if="currentMode === 'minimized' && !isAtDefaultPosition" 
      class="participants-dropdown-container"
      :style="participantsDropdownStyle"
    >
      <button 
        @click.stop="toggleParticipantsDropdown"
        class="participants-dropdown-btn"
        :class="{ active: showParticipantsDropdown }"
        title="Show participants"
      >
        <Icon name="chevron-down" :class="{ rotated: showParticipantsDropdown }" />
      </button>
      
      <Transition name="participants-dropdown">
        <div v-if="showParticipantsDropdown" class="participants-dropdown">
          <VoiceChannelParticipants 
            :participants="voiceStore.allParticipants"
            :session-start-time="voiceStore.callStartTime ? new Date(voiceStore.callStartTime) : null"
          />
        </div>
      </Transition>
    </div>

    <!-- Participants Dropdown for Dock Mode (positioned above the dock) -->
    <div 
      v-if="currentMode === 'dock' && showParticipantsDropdown" 
      class="participants-dropdown-container dock-participants-dropdown"
      :style="dockParticipantsDropdownStyle"
    >
      <Transition name="participants-dropdown">
        <div v-if="showParticipantsDropdown" class="participants-dropdown dock-participants-dropdown-content">
          <VoiceChannelParticipants 
            :participants="voiceStore.allParticipants"
            :session-start-time="voiceStore.callStartTime ? new Date(voiceStore.callStartTime) : null"
          />
        </div>
      </Transition>
    </div>

    <!-- Voice Settings Panel -->
    <VoiceSettingsPanel 
      v-if="showSettings"
      @close="showSettings = false"
    />

    <!-- Spatial Audio Panel (only when NOT in overlay mode; overlay renders its own) -->
    <SpatialAudioPanel 
      v-if="currentMode !== 'overlay'"
      :is-under-dock="currentMode === 'dock'"
    />

    <!-- Full Overlay Mode -->
    <UnifiedVoiceOverlay
      v-if="currentMode === 'overlay'"
      :channel-name="channelName"
      @close="handleOverlayClosed"
      @minimize="collapseToDock"
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
import { useKeybinds } from '@/composables/useKeybinds';
import { userStorage } from '@/utils/userScopedStorage';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';
import DisplayName from '@/components/DisplayName.vue';
import HeadphonesIcon from '@/components/icons/Headphones.vue';

const UnifiedVoiceOverlay = defineAsyncComponent(() => import('./UnifiedVoiceOverlay.vue'));
const VoiceSettingsPanel = defineAsyncComponent(() => import('./VoiceSettingsPanel.vue'));
const VoiceChannelParticipants = defineAsyncComponent(() => import('./VoiceChannelParticipants.vue'));

// Centralized keybind system
const keybinds = useKeybinds();
const isPTTMode = keybinds.isPTTMode;
const isPTTActive = keybinds.isPTTActive;
const pttKeyDisplay = computed(() => keybinds.getKeybindDisplay('push-to-talk'));

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
const showParticipantsDropdown = ref(false);
const minimizedVideoRef = ref<HTMLVideoElement | null>(null);
const dockVideoRef = ref<HTMLVideoElement | null>(null);
const minimizedContainerRef = ref<HTMLElement | null>(null);

// Drag state for minimized dock
const isDragging = ref(false);
const dragStartPos = ref({ x: 0, y: 0 });
const dragInitialMousePos = ref({ x: 0, y: 0 }); // Track initial mouse position
const hasMoved = ref(false); // Track if mouse moved significantly during drag
const minimizedPosition = ref({ left: 10, bottom: 90 });
const containerDimensions = ref({ width: 0, height: 0 });
let rafId: number | null = null;
const CLICK_THRESHOLD = 5; // Pixels - if moved less than this, it's a click

// Drag state for standard dock
const isDockDragging = ref(false);
const dockDragStartPos = ref({ x: 0, y: 0 });
const dockDragInitialMousePos = ref({ x: 0, y: 0 });
const dockHasMoved = ref(false);
const dockPosition = ref({ left: 0, bottom: 80 }); // Default: centered (left will be calculated)
const dockContainerRef = ref<HTMLElement | null>(null);
const dockContainerDimensions = ref({ width: 0, height: 0 });
let dockRafId: number | null = null;
let dockShouldPreventClick = false;

// Default dock position (centered at bottom)
const DEFAULT_DOCK_POSITION = { left: 0, bottom: 80 }; // left: 0 means centered (handled by CSS transform)

// =============================================================================
// COMPUTED PROPERTIES
// =============================================================================
const channelName = computed(() => {
  // Use effective channel name which includes optimistic state
  return voiceStore.effectiveChannelName || 'Voice Channel';
});

const currentUserId = computed(() => authStore.session?.user?.id);

const currentUserProfile = computed(() => {
  if (!currentUserId.value) {
    return { display_name: 'Unknown', username: 'Unknown', avatar_url: '/default_avatar.webp' };
  }
  
  try {
    const user = getUser(currentUserId.value)?.value;
    if (!user) {
      return { display_name: 'Unknown', username: 'Unknown', avatar_url: '/default_avatar.webp' };
    }
    
    return {
      display_name: user.displayName || null,
      username: user.username || 'Unknown',
      avatar_url: user.avatarUrl || '/default_avatar.webp'
    };
  } catch (error) {
    debug.warn('Error getting current user profile for voice dock:', error);
    return { display_name: 'Unknown', username: 'Unknown', avatar_url: '/default_avatar.webp' };
  }
});

const isCurrentUserSpeaking = computed(() => {
  return voiceStore.localState.audioLevel > 20 && !voiceStore.localState.isMuted;
});

const voiceIntensity = computed(() => {
  return Math.min(voiceStore.localState.audioLevel / 100, 1);
});

// Voice ring animation
const voiceRingOffset = computed(() => {
  const circumference = 2 * Math.PI * 45; // 2 * pi * radius
  const progress = voiceIntensity.value;
  return circumference - progress * circumference;
});

const dockMode = computed(() => ({
  'dock-mode': currentMode.value === 'dock',
  'minimized-mode': currentMode.value === 'minimized',
  'overlay-mode': currentMode.value === 'overlay'
}));

// Check if dock is at default position
const isAtDefaultPosition = computed(() => {
  const leftDiff = Math.abs(minimizedPosition.value.left - DEFAULT_POSITION.left);
  const bottomDiff = Math.abs(minimizedPosition.value.bottom - DEFAULT_POSITION.bottom);
  return leftDiff < 1 && bottomDiff < 1;
});

// Computed style for minimized dock position
const minimizedPositionStyle = computed((): Record<string, string> => {
  if (currentMode.value !== 'minimized') return {};
  return {
    left: `${minimizedPosition.value.left}px`,
    bottom: `${minimizedPosition.value.bottom}px`,
    transform: 'none',
    position: 'fixed',
  };
});

// Computed style for dock position
const dockPositionStyle = computed((): Record<string, string> => {
  if (currentMode.value !== 'dock') return {};
  // If left is 0, use centered positioning (default)
  if (dockPosition.value.left === 0) {
    return {
      left: '50%',
      bottom: `${dockPosition.value.bottom}px`,
      transform: 'translateX(-50%)',
      position: 'fixed',
    };
  }
  // Otherwise use fixed positioning at the specific location
  return {
    left: `${dockPosition.value.left}px`,
    bottom: `${dockPosition.value.bottom}px`,
    transform: 'none',
    position: 'fixed',
  };
});

// Computed style for participants dropdown (positioned below the minimized dock)
const participantsDropdownStyle = computed((): Record<string, string> => {
  if (currentMode.value !== 'minimized') return {};
  // Position it below the dock, centered
  return {
    left: `${minimizedPosition.value.left + 171.5}px`, // 343px / 2 = 171.5px (center of dock)
    bottom: `${minimizedPosition.value.bottom - 16}px`, // 8px below the dock
    transform: 'translateX(-50%)',
    position: 'fixed',
  };
});

// Computed style for participants dropdown in dock mode (positioned above the dock)
const dockParticipantsDropdownStyle = computed((): Record<string, string> => {
  if (currentMode.value !== 'dock') return {};
  
  // Get dock container dimensions if available
  const dockHeight = dockContainerDimensions.value.height || 80; // Default height estimate
  const dockBottom = dockPosition.value.bottom;
  
  // Position it above the dock, centered
  if (dockPosition.value.left === 0) {
    // Centered dock
    return {
      left: '50%',
      bottom: `${dockBottom + dockHeight + 12}px`, // 12px above the dock
      transform: 'translateX(-50%)',
      position: 'fixed',
    };
  } else {
    // Positioned dock
    const dockWidth = dockContainerDimensions.value.width || 600; // Default width estimate
    return {
      left: `${dockPosition.value.left + dockWidth / 2}px`,
      bottom: `${dockBottom + dockHeight + 12}px`, // 12px above the dock
      transform: 'translateX(-50%)',
      position: 'fixed',
    };
  }
});

// Get the best user to show in the minimized preview.
// Prefer remote participants -- showing your own camera in a tiny preview is rarely useful.
const activeVideoUser = computed(() => {
  const localId = voiceStore.localState?.userId;
  const all = voiceStore.allParticipants;
  const remote = all.filter((p: any) => p.userId !== localId);
  
  // 1. Remote screenshare (highest priority)
  const remoteScreen = remote.find((p: any) => p.isScreenSharing);
  if (remoteScreen) return remoteScreen;
  
  // 2. Remote camera
  const remoteVideo = remote.find((p: any) => p.isVideoEnabled && !p.isScreenSharing);
  if (remoteVideo) return remoteVideo;
  
  // 3. Local screenshare (useful to confirm what you're sharing)
  const local = all.find((p: any) => p.userId === localId);
  if (local?.isScreenSharing) return local;
  
  // 4. Local camera only if no one else has video
  if (local?.isVideoEnabled) return local;
  
  return null;
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

const collapseToDock = () => {
  currentMode.value = 'dock';
  voiceStore.isOverlayVisible = false;
};

const toggleSettings = () => {
  showSettings.value = !showSettings.value;
};

const toggleParticipantsDropdown = () => {
  showParticipantsDropdown.value = !showParticipantsDropdown.value;
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

// Handle user section click - expand to overlay on mobile
const handleUserSectionClick = () => {
  if (window.innerWidth <= 480) {
    expandToOverlay();
  }
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
// DRAG FUNCTIONALITY FOR MINIMIZED DOCK
// =============================================================================
const STORAGE_KEY_MINIMIZED_POSITION = 'voice-dock-minimized-position';
const STORAGE_KEY_DOCK_POSITION = 'voice-dock-position';

// Default position (matches CSS default)
const DEFAULT_POSITION = { left: 10, bottom: 90 };
// Magnetic snap threshold (pixels) - snap if within this distance
const SNAP_THRESHOLD = 80; // Increased from 30 to 80 for better snap range
// Only enable magnetic snap on desktop (not mobile)
const isDesktop = computed(() => window.innerWidth > 768);

const loadMinimizedPosition = () => {
  try {
    const saved = userStorage.getItem(STORAGE_KEY_MINIMIZED_POSITION);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (typeof parsed.left === 'number' && typeof parsed.bottom === 'number') {
        minimizedPosition.value = { left: parsed.left, bottom: parsed.bottom };
      }
    } else {
      // Use default position if no saved position
      minimizedPosition.value = { ...DEFAULT_POSITION };
    }
  } catch (error) {
    debug.warn('Failed to load minimized dock position:', error);
    minimizedPosition.value = { ...DEFAULT_POSITION };
  }
};

const loadDockPosition = () => {
  try {
    const saved = userStorage.getItem(STORAGE_KEY_DOCK_POSITION);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (typeof parsed.left === 'number' && typeof parsed.bottom === 'number') {
        dockPosition.value = { left: parsed.left, bottom: parsed.bottom };
      }
    } else {
      // Use default position (centered)
      dockPosition.value = { ...DEFAULT_DOCK_POSITION };
    }
  } catch (error) {
    debug.warn('Failed to load dock position:', error);
    dockPosition.value = { ...DEFAULT_DOCK_POSITION };
  }
};

const saveMinimizedPosition = () => {
  try {
    // Only save if position is different from default (user has moved it)
    const isAtDefault = 
      Math.abs(minimizedPosition.value.left - DEFAULT_POSITION.left) < 1 &&
      Math.abs(minimizedPosition.value.bottom - DEFAULT_POSITION.bottom) < 1;
    
    if (isAtDefault) {
      // Remove saved position to use default
      userStorage.removeItem(STORAGE_KEY_MINIMIZED_POSITION);
    } else {
      userStorage.setItem(STORAGE_KEY_MINIMIZED_POSITION, JSON.stringify(minimizedPosition.value));
    }
  } catch (error) {
    debug.warn('Failed to save minimized dock position:', error);
  }
};

const saveDockPosition = () => {
  try {
    // Only save if position is different from default (centered)
    // left: 0 means centered, so check for that
    const isAtDefault = 
      (dockPosition.value.left === 0 || Math.abs(dockPosition.value.left) < 1) &&
      Math.abs(dockPosition.value.bottom - DEFAULT_DOCK_POSITION.bottom) < 1;
    
    if (isAtDefault) {
      // Remove saved position to use default (centered)
      userStorage.removeItem(STORAGE_KEY_DOCK_POSITION);
    } else {
      userStorage.setItem(STORAGE_KEY_DOCK_POSITION, JSON.stringify(dockPosition.value));
    }
  } catch (error) {
    debug.warn('Failed to save dock position:', error);
  }
};

const startDrag = (e: MouseEvent | TouchEvent) => {
  // Prevent click event from firing
  e.preventDefault();
  e.stopPropagation();
  
  isDragging.value = true;
  hasMoved.value = false; // Reset movement tracking
  
  // Cache container dimensions to avoid recalculating on every move
  const container = minimizedContainerRef.value;
  if (container) {
    const rect = container.getBoundingClientRect();
    containerDimensions.value = { width: rect.width, height: rect.height };
  }
  
  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
  
  // Store initial mouse position to detect movement
  dragInitialMousePos.value = { x: clientX, y: clientY };
  
  dragStartPos.value = {
    x: clientX - minimizedPosition.value.left,
    y: window.innerHeight - clientY - minimizedPosition.value.bottom
  };
  
  // Use passive: false to allow preventDefault
  document.addEventListener('mousemove', handleDrag, { passive: false });
  document.addEventListener('mouseup', stopDrag);
  document.addEventListener('touchmove', handleDrag, { passive: false });
  document.addEventListener('touchend', stopDrag);
  
  // Prevent text selection while dragging using CSS class
  document.body.classList.add('is-dragging-voice-dock');
  
  // Disable transitions during drag for smooth movement
  if (container) {
    container.style.transition = 'none';
  }
};

const handleDrag = (e: MouseEvent | TouchEvent) => {
  if (!isDragging.value) return;
  
  e.preventDefault();
  
  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
  
  // Check if mouse has moved significantly from initial position
  const deltaX = Math.abs(clientX - dragInitialMousePos.value.x);
  const deltaY = Math.abs(clientY - dragInitialMousePos.value.y);
  const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  
  if (distance > CLICK_THRESHOLD) {
    hasMoved.value = true; // Mark as moved if beyond threshold
  }
  
  // Cancel any pending animation frame
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
  }
  
  // Use requestAnimationFrame for smooth updates
  rafId = requestAnimationFrame(() => {
    if (!isDragging.value) return;
    
    // Calculate new position (no snapping during drag - allow free movement)
    const newLeft = clientX - dragStartPos.value.x;
    const newBottom = window.innerHeight - clientY - dragStartPos.value.y;
    
    // Constrain to viewport bounds using cached dimensions
    const maxLeft = window.innerWidth - containerDimensions.value.width;
    const maxBottom = window.innerHeight - containerDimensions.value.height;
    
    minimizedPosition.value = {
      left: Math.max(0, Math.min(newLeft, maxLeft)),
      bottom: Math.max(0, Math.min(newBottom, maxBottom))
    };
    
    rafId = null;
  });
};

const stopDrag = () => {
  if (!isDragging.value) return;
  
  // Cancel any pending animation frame
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  
  // If we moved, prevent the click event from firing
  if (hasMoved.value) {
    shouldPreventClick = true;
    // Use a small timeout to ensure click event is prevented
    setTimeout(() => {
      shouldPreventClick = false;
      hasMoved.value = false; // Reset for next interaction
    }, 100);
  }
  
  isDragging.value = false;
  
  // Remove dragging class from body
  document.body.classList.remove('is-dragging-voice-dock');
  
  // Re-enable transitions after drag for smooth magnetic snap animation
  const container = minimizedContainerRef.value;
  if (container) {
    container.style.transition = 'left 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94), bottom 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
  }
  
  // Magnetic snap check on release (desktop only) - smoothly animate to default if close enough
  if (isDesktop.value) {
    const distanceToDefault = Math.sqrt(
      Math.pow(minimizedPosition.value.left - DEFAULT_POSITION.left, 2) + 
      Math.pow(minimizedPosition.value.bottom - DEFAULT_POSITION.bottom, 2)
    );
    
    if (distanceToDefault < SNAP_THRESHOLD) {
      // Smoothly animate to default position (transition is now enabled)
      minimizedPosition.value = { ...DEFAULT_POSITION };
      
      // Disable transition after animation completes
      setTimeout(() => {
        if (container) {
          container.style.transition = '';
        }
      }, 300); // Match transition duration
    } else {
      // Not close enough - disable transition immediately
      if (container) {
        container.style.transition = '';
      }
    }
  } else {
    // Mobile - disable transition immediately
    if (container) {
      container.style.transition = '';
    }
  }
  
  saveMinimizedPosition();
  
  document.removeEventListener('mousemove', handleDrag);
  document.removeEventListener('mouseup', stopDrag);
  document.removeEventListener('touchmove', handleDrag);
  document.removeEventListener('touchend', stopDrag);
  
  // Restore text selection
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
};

// Track if we should prevent the click event
let shouldPreventClick = false;

const handleMinimizedMouseDown = (e: MouseEvent) => {
  // If mousedown is on the drag handle or info area, don't prevent click yet
  // We'll check in handleDrag if movement occurred
  const target = e.target as HTMLElement;
  const isOnDragArea = target.closest('.minimized-info') !== null;
  
  if (!isOnDragArea) {
    // If clicking outside drag area, allow normal click behavior
    shouldPreventClick = false;
  }
};

const handleMinimizedClick = (e: MouseEvent) => {
  // Prevent click if we just finished dragging
  if (shouldPreventClick || hasMoved.value) {
    e.preventDefault();
    e.stopPropagation();
    shouldPreventClick = false; // Reset for next interaction
    return;
  }
  
  // Only expand if it was a genuine click (no drag occurred)
  expandToDock();
};

// =============================================================================
// DRAG FUNCTIONALITY FOR STANDARD DOCK
// =============================================================================

const startDockDrag = (e: MouseEvent | TouchEvent) => {
  // Don't start drag if clicking on interactive elements (buttons, etc.)
  const target = e.target as HTMLElement;
  if (target.closest('button') || target.closest('.dock-video-preview')) {
    return; // Let buttons and video preview handle their own clicks
  }
  
  // Prevent click event from firing
  e.preventDefault();
  e.stopPropagation();
  
  isDockDragging.value = true;
  dockHasMoved.value = false;
  
  // Cache container dimensions
  const container = dockContainerRef.value;
  if (container) {
    const rect = container.getBoundingClientRect();
    dockContainerDimensions.value = { width: rect.width, height: rect.height };
  }
  
  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
  
  // Store initial mouse position
  dockDragInitialMousePos.value = { x: clientX, y: clientY };
  
  // Calculate current position (account for centered positioning)
  const currentLeft = dockPosition.value.left === 0 
    ? window.innerWidth / 2 - (dockContainerDimensions.value.width / 2)
    : dockPosition.value.left;
  
  dockDragStartPos.value = {
    x: clientX - currentLeft,
    y: window.innerHeight - clientY - dockPosition.value.bottom
  };
  
  // Use passive: false to allow preventDefault
  document.addEventListener('mousemove', handleDockDrag, { passive: false });
  document.addEventListener('mouseup', stopDockDrag);
  document.addEventListener('touchmove', handleDockDrag, { passive: false });
  document.addEventListener('touchend', stopDockDrag);
  
  // Prevent text selection while dragging
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'grabbing';
  
  // Disable transitions during drag
  if (container) {
    container.style.transition = 'none';
  }
};

const handleDockDrag = (e: MouseEvent | TouchEvent) => {
  if (!isDockDragging.value) return;
  
  e.preventDefault();
  
  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
  
  // Check if mouse has moved significantly
  const deltaX = Math.abs(clientX - dockDragInitialMousePos.value.x);
  const deltaY = Math.abs(clientY - dockDragInitialMousePos.value.y);
  const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  
  if (distance > CLICK_THRESHOLD) {
    dockHasMoved.value = true;
  }
  
  // Cancel any pending animation frame
  if (dockRafId !== null) {
    cancelAnimationFrame(dockRafId);
  }
  
  // Use requestAnimationFrame for smooth updates
  dockRafId = requestAnimationFrame(() => {
    if (!isDockDragging.value) return;
    
    // Calculate new position (no snapping during drag)
    const newLeft = clientX - dockDragStartPos.value.x;
    const newBottom = window.innerHeight - clientY - dockDragStartPos.value.y;
    
    // Constrain to viewport bounds
    const maxLeft = window.innerWidth - dockContainerDimensions.value.width;
    const maxBottom = window.innerHeight - dockContainerDimensions.value.height;
    
    dockPosition.value = {
      left: Math.max(0, Math.min(newLeft, maxLeft)),
      bottom: Math.max(0, Math.min(newBottom, maxBottom))
    };
    
    dockRafId = null;
  });
};

const stopDockDrag = () => {
  if (!isDockDragging.value) return;
  
  // Cancel any pending animation frame
  if (dockRafId !== null) {
    cancelAnimationFrame(dockRafId);
    dockRafId = null;
  }
  
  // If we moved, prevent the click event from firing
  if (dockHasMoved.value) {
    dockShouldPreventClick = true;
    setTimeout(() => {
      dockShouldPreventClick = false;
      dockHasMoved.value = false;
    }, 100);
  }
  
  isDockDragging.value = false;
  
  // Re-enable transitions for smooth magnetic snap animation
  const container = dockContainerRef.value;
  if (container) {
    container.style.transition = 'left 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94), bottom 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94), transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)';
  }
  
  // Magnetic snap check on release (desktop only)
  if (isDesktop.value) {
    // Calculate distance to default (centered) position
    const currentLeft = dockPosition.value.left === 0 
      ? window.innerWidth / 2 - (dockContainerDimensions.value.width / 2)
      : dockPosition.value.left;
    
    const centerX = window.innerWidth / 2 - dockContainerDimensions.value.width / 2;
    const distanceToDefault = Math.sqrt(
      Math.pow(currentLeft - centerX, 2) + 
      Math.pow(dockPosition.value.bottom - DEFAULT_DOCK_POSITION.bottom, 2)
    );
    
    if (distanceToDefault < SNAP_THRESHOLD) {
      // Smoothly animate to default position (centered, left: 0 means centered)
      dockPosition.value = { left: 0, bottom: DEFAULT_DOCK_POSITION.bottom };
      
      // Disable transition after animation completes
      setTimeout(() => {
        if (container) {
          container.style.transition = '';
        }
      }, 300);
    } else {
      // Not close enough - disable transition immediately
      if (container) {
        container.style.transition = '';
      }
    }
  } else {
    // Mobile - disable transition immediately
    if (container) {
      container.style.transition = '';
    }
  }
  
  saveDockPosition();
  
  document.removeEventListener('mousemove', handleDockDrag);
  document.removeEventListener('mouseup', stopDockDrag);
  document.removeEventListener('touchmove', handleDockDrag);
  document.removeEventListener('touchend', stopDockDrag);
  
  // Restore text selection
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
};

const handleDockClick = (e: MouseEvent) => {
  // Don't prevent clicks on buttons or interactive elements
  const target = e.target as HTMLElement;
  if (target.closest('button') || target.closest('.dock-video-preview')) {
    return; // Let these elements handle their own clicks
  }
  
  // Prevent click if we just finished dragging
  if (dockShouldPreventClick || dockHasMoved.value) {
    e.preventDefault();
    e.stopPropagation();
    dockShouldPreventClick = false;
    return;
  }
};

// =============================================================================
// WATCHERS
// =============================================================================

// Track last attached user to prevent flashing from repeated attachments
let lastAttachedUserId: string | null = null;
let lastAttachedElement: HTMLVideoElement | null = null;
let lastDockAttachedUserId: string | null = null;

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
        (videoEl as HTMLVideoElement).srcObject = activeVideoStream.value;
      }
      lastAttachedUserId = userId;
      lastAttachedElement = videoEl as any;
    } else if (videoEl) {
      // Clean up when no active video user
      voiceStore.detachVideoFromElement(lastAttachedUserId || '', videoEl as unknown as HTMLVideoElement);
      (videoEl as HTMLVideoElement).srcObject = null;
      lastAttachedUserId = null;
      lastAttachedElement = null;
    }
  },
  { immediate: true }
);

// Attach video to dock preview (compact mode)
watch(
  [activeVideoUser, dockVideoRef],
  ([user, videoEl]) => {
    const userId = user?.userId || null;
    
    // Skip if same user is already attached
    if (userId === lastDockAttachedUserId && videoEl?.srcObject) {
      return;
    }
    
    if (user && videoEl) {
      const attached = voiceStore.attachVideoToElement(user.userId, videoEl);
      if (!attached && activeVideoStream.value) {
        videoEl.srcObject = activeVideoStream.value;
      }
      lastDockAttachedUserId = userId;
    } else if (videoEl) {
      voiceStore.detachVideoFromElement(lastDockAttachedUserId || '', videoEl);
      videoEl.srcObject = null;
      lastDockAttachedUserId = null;
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
// Close participants dropdown when clicking outside
let handleClickOutside: ((e: MouseEvent) => void) | null = null;

onMounted(() => {
  // Start in dock mode ONLY if the store doesn't want overlay visible
  // (e.g., when auto-opening for video detection)
  if (!voiceStore.isOverlayVisible) {
    currentMode.value = 'dock';
  } else {
    currentMode.value = 'overlay';
  }
  
  // Load saved positions
  loadMinimizedPosition();
  loadDockPosition();
  
  // Close participants dropdown when clicking outside
  handleClickOutside = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (showParticipantsDropdown.value && 
        !target.closest('.participants-dropdown-container') &&
        !target.closest('.participants-dropdown') &&
        !target.closest('.participants-btn')) {
      showParticipantsDropdown.value = false;
    }
  };
  
  document.addEventListener('click', handleClickOutside);
  
  // Keybind handlers are registered in UnifiedVoiceOverlay when overlay is open
  // When in dock mode (not overlay), we still want these shortcuts to work
  // The keybind system handles this through context - 'voice-connected' is active here
  
  // Note: Keybind handlers are registered once globally in the voice store when connected.
  // The dock doesn't need its own handlers - the centralized system handles everything.
});

onUnmounted(() => {
  // Clean up drag listeners
  stopDrag();
  stopDockDrag();
  
  // Cancel any pending animation frames
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (dockRafId !== null) {
    cancelAnimationFrame(dockRafId);
    dockRafId = null;
  }
  
  // Remove click outside listener
  if (handleClickOutside) {
    document.removeEventListener('click', handleClickOutside);
    handleClickOutside = null;
  }
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
  position: fixed;
  /* Position is set dynamically via inline styles */
}

/* Minimized Mode - tiny dock in channel sidebar */
.unified-voice-dock.minimized-mode {
  width: 343px; /* Width of channel sidebar */
  transform: none;
  z-index: 10;  /* Above UserProfileComponent but below global overlays */
  /* Position is set dynamically via inline styles */
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
  /* background: linear-gradient(145deg, var(--background-tertiary), var(--background-secondary));  */
  background: linear-gradient(145deg, color-mix(in srgb, var(--background-tertiary) 39%, transparent), color-mix(in srgb, var(--background-secondary) 35%, transparent));
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
  cursor: grab; /* Default cursor for entire dock */
  user-select: none; /* Prevent text selection while dragging */
}

.dock-container * {
  cursor: inherit; /* All children inherit grab cursor */
}

.dock-container:hover:not(.is-dragging) {
  background: linear-gradient(145deg, color-mix(in srgb, var(--background-secondary) 39%, transparent), color-mix(in srgb, var(--h-black-lighter) 35%, transparent));
  transform: translateY(-2px);
  box-shadow: 
    0 12px 40px rgba(0, 0, 0, 0.7),
    0 6px 20px rgba(0, 0, 0, 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
}

.dock-container.is-dragging {
  cursor: grabbing;
  transition: none !important;
  z-index: 10001; /* Above everything while dragging */
  will-change: transform;
}

/* User Section */
.user-section {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
  /* Inherits cursor: grab from parent */
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
  border: 2px solid var(--h-black-lighter);
  transition: all 0.3s ease;
}

.user-avatar.speaking {
  border-color: #00d4aa;
  box-shadow: 0 0 20px rgba(0, 212, 170, 0.4);
}

.voice-ring {
  position: absolute;
  top: -6px;
  left: -6px;
  width: calc(100% + 12px);
  height: calc(100% + 12px);
  pointer-events: none;
  opacity: 1;
}

.voice-ring-svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.voice-ring-bg {
  fill: none;
  stroke: rgba(0, 212, 170, 0.3);
  stroke-width: 2;
}

.voice-ring-active {
  fill: none;
  stroke: #00d4aa;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-dasharray: 283; /* Circumference of a circle with r=45 */
  transition: stroke-dashoffset 0.1s ease;
}

.user-details {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.user-name {
  /* color: var(--text-primary); */
  color: var(--text-primary);
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.channel-name {
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 65px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.dock-connection-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 0 4px;
  border-radius: 3px;
  line-height: 14px;
  flex-shrink: 0;
}

.dock-connection-badge.livekit {
  background: rgba(87, 242, 135, 0.2);
  color: #57f287;
}

.dock-connection-badge.p2p {
  background: rgba(14, 165, 233, 0.2);
  color: #0EA5E9;
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
  cursor: pointer !important; /* Override parent grab cursor for buttons */
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  backdrop-filter: blur(10px);
}

.control-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
  border-color: rgba(255, 255, 255, 0.3);
  transform: scale(1.05);
}

.control-btn.active {
  background: linear-gradient(145deg, #00d4aa, #00b894);
  color: var(--text-primary);
  border-color: rgba(0, 212, 170, 0.6);
  box-shadow: 0 4px 12px rgba(0, 212, 170, 0.3);
}

.control-btn.muted {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: var(--text-primary);
  border-color: rgba(237, 66, 69, 0.6);
  box-shadow: 0 4px 12px rgba(237, 66, 69, 0.3);
}

/* PTT Mode Styles */
.control-btn.ptt-mode {
  position: relative;
}

.control-btn.ptt-active {
  background: linear-gradient(145deg, #00d4aa, #00b894) !important;
  color: var(--text-primary) !important;
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
  color: var(--text-primary);
}

.control-btn.deafened {
  background: linear-gradient(145deg, #faa61a, #e67e22);
  color: var(--text-primary);
  border-color: rgba(250, 166, 26, 0.6);
  box-shadow: 0 4px 12px rgba(250, 166, 26, 0.3);
}

/* Spatial audio button with indicator */
.control-btn.spatial-btn {
  position: relative;
}

.control-btn.spatial-enabled {
  background: linear-gradient(145deg, #00d4aa, #00b894);
  color: var(--text-primary);
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

/* Dock Video Preview (small thumbnail in dock mode) */
.dock-video-preview {
  position: relative;
  width: 64px;
  height: 48px;
  border-radius: 8px;
  overflow: hidden;
  background: #000;
  cursor: pointer !important;
  transition: all 0.2s ease;
  border: 2px solid color-mix(in srgb, var(--harmony-primary) 40%, transparent);
  flex-shrink: 0;
}

.dock-video-preview:hover {
  transform: scale(1.05);
  border-color: color-mix(in srgb, var(--harmony-primary) 80%, transparent);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--harmony-primary) 30%, transparent);
}

.dock-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.dock-video-badge {
  position: absolute;
  bottom: 2px;
  right: 2px;
  background: rgba(87, 242, 135, 0.9);
  color: #000;
  border-radius: 4px;
  padding: 2px 4px;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dock-video-badge :deep(svg) {
  width: 10px;
  height: 10px;
}

/* Action Controls */
.action-controls {
  display: flex;
  gap: 6px;
}

.expand-btn:hover {
  background: linear-gradient(145deg, #0EA5E9, #0284C7);
  color: var(--text-primary);
  border-color: rgba(14, 165, 233, 0.6);
}

.minimize-btn:hover {
  background: linear-gradient(145deg, #faa61a, #e67e22);
  color: var(--text-primary);
  border-color: rgba(250, 166, 26, 0.6);
}

.leave-btn:hover {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: var(--text-primary);
  border-color: rgba(237, 66, 69, 0.6);
}

/* =============================================================================
   MINIMIZED MODE (Tiny dock in channel sidebar)
   ============================================================================= */

.minimized-container {
  position: relative;
  z-index: 200;
  /* background: linear-gradient(145deg, var(--background-tertiary), var(--background-secondary)); */
  background: linear-gradient(145deg, color-mix(in srgb, var(--background-tertiary) 39%, transparent), color-mix(in srgb, var(--background-secondary) 35%, transparent));
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 12px 16px;
  cursor: pointer;
  transition: all 0.3s ease;
  width: 343px; /* Use full width of minimized dock container */
  box-sizing: border-box; /* Include padding in width calculation */
  box-shadow: 
    0 6px 20px rgba(0, 0, 0, 0.4),
    0 2px 8px rgba(0, 0, 0, 0.3);
  margin-bottom: 0; /* Remove bottom margin for tight positioning */
}

.minimized-container:hover:not(.is-dragging) {
  /* background: linear-gradient(145deg, var(--background-secondary), var(--h-black-lighter)); */
  background: linear-gradient(145deg, color-mix(in srgb, var(--background-secondary) 39%, transparent), color-mix(in srgb, var(--h-black-lighter) 35%, transparent));
  transform: translateY(-1px);
  box-shadow: 
    0 8px 25px rgba(0, 0, 0, 0.5),
    0 3px 10px rgba(0, 0, 0, 0.4);
}

.minimized-container.is-dragging {
  cursor: grabbing !important;
  transition: none !important; /* Disable all transitions during drag */
  z-index: 10000; /* Above everything while dragging */
  will-change: transform; /* Optimize for position changes */
}

/* Minimized Video Preview */
.minimized-video-preview {
  position: relative;
  width: 100%;
  max-height: 200px;
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 10px;
  background: #000;
  cursor: default;
}

.mini-video {
  width: 100%;
  height: auto;
  display: block;
  object-fit: contain;
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
  color: var(--text-primary);
  font-weight: 500;
}

.mini-pip-btn {
  background: rgba(255, 255, 255, 0.2);
  border: none;
  border-radius: 4px;
  padding: 4px 6px;
  color: var(--text-primary);
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
  cursor: grab;
  user-select: none;
}

.minimized-info:active {
  cursor: grabbing;
}

.drag-handle {
  color: var(--text-tertiary);
  font-size: 14px;
  cursor: grab;
  opacity: 0.5;
  transition: opacity 0.2s ease;
}

.minimized-info:hover .drag-handle {
  opacity: 1;
}

.channel-icon {
  background: rgba(14, 165, 233, 0.2);
  border-radius: 10px;
  color: #0EA5E9;
  width: 24px;
  height: 24px;
  padding: 4px;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.minimized-info .channel-name {
  color: var(--text-primary);
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.participant-count {
  background: rgba(14, 165, 233, 0.2);
  color: #0EA5E9;
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
  color: var(--text-primary);
  border-color: rgba(255, 255, 255, 0.3);
}

.mini-control-btn.muted {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: var(--text-primary);
  border-color: rgba(237, 66, 69, 0.6);
}

.mini-control-btn.deafened {
  background: linear-gradient(145deg, #faa61a, #e67e22);
  color: var(--text-primary);
  border-color: rgba(250, 166, 26, 0.6);
}

.mini-control-btn.leave {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: var(--text-primary);
  border-color: rgba(237, 66, 69, 0.6);
}

/* Participants Dropdown - positioned outside and below the container */
.participants-dropdown-container {
  z-index: 100;
  pointer-events: none; /* Allow clicks to pass through container, but not button/dropdown */
}

.participants-dropdown-btn {
  width: 40px;
  height: 20px;
  border-radius: 0 0 10px 10px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-top: none;
  background: linear-gradient(145deg, color-mix(in srgb, var(--background-tertiary) 39%, transparent), color-mix(in srgb, var(--background-secondary) 35%, transparent));
  backdrop-filter: blur(8px);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  padding: 0;
  font-size: 10px;
  pointer-events: auto; /* Button is clickable */
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.participants-dropdown-btn:hover:not(.active) {
  background: linear-gradient(145deg, color-mix(in srgb, var(--background-secondary) 39%, transparent), color-mix(in srgb, var(--h-black-lighter) 35%, transparent));
  color: var(--text-primary);
  border-color: rgba(255, 255, 255, 0.3);
  transform: translateY(2px);
}

.participants-dropdown-btn.active {
  background: linear-gradient(145deg, color-mix(in srgb, var(--background-secondary) 39%, transparent), color-mix(in srgb, var(--h-black-lighter) 35%, transparent));
  color: var(--text-primary);
  border-color: rgba(255, 255, 255, 0.4);
  transform: translateY(2px);
}

.participants-dropdown-btn .rotated {
  transform: rotate(180deg);
}

.participants-dropdown {
  position: absolute;
  top: 20px; /* Below the button */
  left: 50%;
  transform: translateX(-50%);
  width: 300px;
  max-height: 400px;
  overflow-y: auto;
  background: linear-gradient(145deg, color-mix(in srgb, var(--background-tertiary) 39%, transparent), color-mix(in srgb, var(--background-secondary) 35%, transparent));
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  box-shadow: 
    0 8px 32px rgba(0, 0, 0, 0.6),
    0 4px 16px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(20px);
  z-index: 101;
  pointer-events: auto; /* Dropdown is clickable */
  margin-top: 4px; /* Small gap from button */
}

/* Dock mode participants dropdown - positioned above the dock */
.dock-participants-dropdown {
  pointer-events: none;
  z-index: 100;
}

.dock-participants-dropdown .participants-dropdown {
  position: relative;
  top: 110px;
  left: 50%;
  transform: translateX(-50%);
  margin-top: 0;
}

.participants-dropdown .voice-participants {
  background: none;
}

/* Dropdown transition - slides down from under */
.participants-dropdown-enter-active {
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.participants-dropdown-leave-active {
  transition: all 0.2s ease;
}

.participants-dropdown-enter-from {
  opacity: 0;
  transform: translateX(-50%) translateY(-20px);
  max-height: 0;
  margin-top: 0;
}

.participants-dropdown-enter-to {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
  max-height: 400px;
  margin-top: 4px;
}

.participants-dropdown-leave-from {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
  max-height: 400px;
  margin-top: 4px;
}

.participants-dropdown-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-20px);
  max-height: 0;
  margin-top: 0;
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
  .unified-voice-dock.minimized-mode {
    bottom: 80px;
    width: calc(100% - 20px);
  }
  
  .dock-container {
    min-width: auto;
    width: 100%;
  }
  
  .minimized-container {
    min-width: auto;
    width: 80%;
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
  .unified-voice-dock.dock-mode {
    left: 8px;
    right: 8px;
    bottom: 70px; /* Above message input */
    transform: none;
  }
  
  .dock-container {
    flex-direction: column;
    gap: 10px;
    padding: 12px 16px;
    padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
    margin-bottom: 0;
    min-width: auto;
    width: calc(100% - 20px);
    position: relative;
  }
  
  /* User info centered above buttons on mobile - tappable to expand */
  .user-section {
    width: 100%;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 6px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 8px;
    transition: background 0.2s ease;
  }
  
  .user-section:active {
    background: rgba(255, 255, 255, 0.1);
  }
  
  .user-avatar-container {
    width: 36px;
    height: 36px;
  }
  
  .user-avatar {
    width: 36px;
    height: 36px;
  }
  
  .user-details {
    align-items: center;
    gap: 1px;
  }
  
  .user-name {
    font-size: 14px;
    text-align: center;
  }
  
  .channel-name {
    font-size: 11px;
    text-align: center;
    color: #00d4aa;
  }
  
  /* Controls centered below user info */
  .voice-controls {
    justify-content: center;
    gap: 8px;
  }
  
  .control-btn {
    width: 42px;
    height: 42px;
    font-size: 15px;
  }
  
  /* Hide video preview on mobile dock - save space */
  .dock-video-preview {
    display: none;
  }
  
  /* Action controls row */
  .action-controls {
    position: absolute;
    top: 8px;
    right: 8px;
    gap: 4px;
  }
  
  .action-controls .control-btn {
    width: 28px;
    height: 28px;
    font-size: 11px;
  }
  
  /* Show expand button on mobile, hide minimize */
  .expand-btn {
    display: flex;
  }
  
}

/* Connecting state - subtle pulse animation */
.unified-voice-dock.is-connecting {
  animation: connecting-pulse 1.5s ease-in-out infinite;
}

.unified-voice-dock.is-connecting .channel-name::after {
  content: '...';
  animation: connecting-dots 1.5s ease-in-out infinite;
}

@keyframes connecting-pulse {
  /* 0%, 100% { opacity: 1;} */
  /* 50% { opacity: 0.7; } */
}

@keyframes connecting-dots {
  0% { content: '.'; }
  33% { content: '..'; }
  66% { content: '...'; }
}
</style>

<style>
/* Global style for voice dock dragging - prevents interference with other components */
body.is-dragging-voice-dock {
  user-select: none;
  cursor: grabbing;
}
</style>