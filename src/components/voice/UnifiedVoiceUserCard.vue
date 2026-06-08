<template>
  <div
    class="harmony-voice-card"
    :class="{
      speaking: isSpeaking,
      muted: effectiveMuted,
      deafened: effectiveDeafened,
      'video-enabled': hasVideo,
      'screen-sharing': props.userState.isScreenSharing,
      self: isSelf,
      'connection-poor': connectionState === 'disconnected',
      'fullscreen-active': isFullscreenActive,
    }"
    @click="handleCardClick"
    @contextmenu.prevent="handleContextMenu"
  >
    <!-- Video Container -->
    <div v-if="hasVideo || props.userState.isScreenSharing" class="video-container">
      <video
        ref="videoElement"
        autoplay
        playsinline
        :muted="isSelf"
        class="video-stream"
        @loadedmetadata="onVideoLoaded"
      />

      <!-- Video Overlay -->
      <div class="video-overlay">
        <!-- Screen share indicator -->
        <div v-if="props.userState.isScreenSharing" class="screen-share-indicator">
          <Icon name="screen-share" />
          <span>Screen Sharing</span>
          <button 
            @click.stop="togglePIP"
            class="pip-toggle-btn"
            :class="{ active: isPIPActive }"
            :title="isPIPActive ? 'Exit PIP' : 'Enter PIP'"
          >
            <Icon name="picture-in-picture" />
          </button>
        </div>

        <!-- Connection quality indicator - only show if not excellent -->
        <div 
          v-if="connectionQuality !== 'excellent'" 
          class="connection-indicator" 
          :class="connectionQuality"
          :title="`Connection: ${connectionQuality}`"
        >
          <div class="connection-bars">
            <span v-for="i in 4" :key="i" :class="{ active: i <= connectionBars }"></span>
          </div>
        </div>

        <!-- Self controls -->
        <div v-if="isSelf" class="video-controls">
          <button
            @click.stop="emit('toggle-video')"
            class="control-btn"
            :class="{ active: props.userState.isVideoEnabled && !props.userState.isScreenSharing }"
            :title="props.userState.isVideoEnabled && !props.userState.isScreenSharing ? 'Turn off camera' : 'Turn on camera'"
          >
            <Icon :name="props.userState.isVideoEnabled && !props.userState.isScreenSharing ? 'video-off' : 'video'" />
          </button>
          <button
            @click.stop="emit('toggle-screen-share')"
            class="control-btn"
            :class="{ active: props.userState.isScreenSharing }"
            :title="props.userState.isScreenSharing ? 'Stop screen share' : 'Share screen'"
          >
            <Icon name="screen-share" />
          </button>
          <button
            @click.stop="handleCardClick"
            class="control-btn"
            :class="{ active: isFullscreenActive }"
            title="Toggle fullscreen"
          >
            <Icon :name="isFullscreenActive ? 'minimize-2' : 'maximize-2'" />
          </button>
        </div>
        
        <!-- Fullscreen button for remote users (when not showing self controls) -->
        <div v-else class="video-controls remote-controls">
          <button
            @click.stop="handleCardClick"
            class="control-btn"
            :class="{ active: isFullscreenActive }"
            title="Toggle fullscreen"
          >
            <Icon :name="isFullscreenActive ? 'minimize-2' : 'maximize-2'" />
          </button>
        </div>
      </div>
    </div>

    <!-- Avatar Container (when no video) -->
    <div v-else class="avatar-container">
      <div class="avatar-wrapper">
        <!-- User avatar -->
        <div class="avatar-frame" :class="{ speaking: isSpeaking }">
          <Avatar 
            :src="userProfile?.avatar_url || '/default_avatar.webp'" 
            :alt="displayName" 
            size="xl" 
            class="user-avatar" 
          />

          <!-- Voice activity ring -->
          <div class="voice-ring" :style="{ '--intensity': voiceIntensity }">
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

        <!-- Status indicators -->
        <div class="status-indicators">
          <div v-if="effectiveMuted" class="status-badge muted" title="Muted">
            <Icon name="mic-off" />
          </div>
          <div v-if="effectiveDeafened" class="status-badge deafened" title="Deafened">
            <Icon name="headphones-off" />
          </div>
          <div v-if="isLocallyMuted && !isSelf" class="status-badge locally-muted" title="Muted by you">
            <Icon name="volume-x" />
          </div>
          <div v-if="connectionQuality === 'poor'" class="status-badge connection-poor" title="Poor connection">
            <Icon name="wifi-low" />
          </div>
        </div>
      </div>
    </div>

    <!-- User Info -->
    <div class="user-info">
      <div class="username" :class="{ speaking: isSpeaking }">
        <DisplayName :user-id="props.userState.userId" :fallback="displayName" :truncate="true" />
      </div>
      <div class="harmony-voice-card-user-status">
        {{ userStatus }}
      </div>
    </div>

    <!-- Audio Visualizer -->
    <div v-if="isSpeaking && !hasVideo" class="audio-visualizer">
      <div
        v-for="i in 5"
        :key="i"
        class="audio-bar"
        :style="{
          '--delay': `${i * 100}ms`,
          '--height': `${getBarHeight(i)}%`,
        }"
      ></div>
    </div>

    <!-- Context Menu -->
    <VoiceUserContextMenu
      :user-state="props.userState"
      :x="contextMenuPosition.x"
      :y="contextMenuPosition.y"
      :visible="showContextMenu"
      @close="showContextMenu = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { debug } from '@/utils/debug'
import type { UserMediaState } from '@/services/unifiedWebRTC';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useUserData } from '@/composables/useUserData';
import DisplayName from '@/components/DisplayName.vue';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';
import VoiceUserContextMenu from './VoiceUserContextMenu.vue';

// =============================================================================
// PROPS & EMITS
// =============================================================================

const props = defineProps<{
  userState: UserMediaState;
}>();

const emit = defineEmits<{
  (e: 'toggle-video'): void;
  (e: 'toggle-screen-share'): void;
}>();

// =============================================================================
// STORES & COMPOSABLES
// =============================================================================

const voiceStore = useUnifiedVoiceChannelStore();
const { getUserProfile } = useUserData();

// =============================================================================
// REFS
// =============================================================================

const videoElement = ref<HTMLVideoElement | null>(null);

// Context menu state
const showContextMenu = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });

// =============================================================================
// COMPUTED PROPERTIES
// =============================================================================

// Get user profile data
const userProfile = computed(() => {
  try {
    // getUserProfile returns a computed ref, so we need to access .value
    const profileData = getUserProfile(props.userState.userId).value;
    
    // Debug logging for troubleshooting
    if (!profileData) {
      debug.warn(`No profile data found for user ${props.userState.userId}`);
    }
    
    // Ensure we always return a valid profile object
    const result = {
      display_name: profileData?.display_name || null,
      username: profileData?.username || 'Unknown User',
      avatar_url: profileData?.avatar_url || '/default_avatar.webp'
    };
    
    return result;
  } catch (error) {
    debug.warn('Error getting user profile for voice card:', error);
    return {
      display_name: null,
      username: 'Unknown User',
      avatar_url: '/default_avatar.webp'
    };
  }
});

// Get user stream
const userStream = computed(() => {
  return voiceStore.getUserStream(props.userState.userId);
});

// Check if this is the current user
const isSelf = computed(() => {
  return props.userState.userId === voiceStore.localState.userId;
});

// Effective mute/deafen state - isolates local user state from remote users
// For self: always use voiceStore.localState for immediate reactivity
// For others: use their broadcasted state from props.userState
const effectiveMuted = computed(() => {
  if (isSelf.value) {
    return voiceStore.localState.isMuted;
  }
  return props.userState.isMuted;
});

const effectiveDeafened = computed(() => {
  if (isSelf.value) {
    return voiceStore.localState.isDeafened;
  }
  return props.userState.isDeafened;
});

// Get connection state
const connectionState = computed(() => {
  // For self, always connected when in channel
  if (isSelf.value) {
    return voiceStore.isConnected ? 'connected' : 'disconnected';
  }
  
  // For others, would need to track from WebRTC service
  return 'connected'; // Simplified for now
});

const displayName = computed(() => {
  const profile = userProfile.value;
  if (!profile) return 'Unknown User';
  return profile.display_name || profile.username || 'Unknown User';
});

const isSpeaking = computed(() => {
  if (isSelf.value) {
    // For self user, use audioLevel-based detection to feel more responsive
    // Use effectiveMuted to ensure proper state isolation
    return props.userState.audioLevel > 20 && !effectiveMuted.value;
  }
  // For peer users, rely on the state provided by the WebRTC service
  return props.userState.isSpeaking;
});

const voiceIntensity = computed(() => {
  // `audioLevel` is the average of a 0..255 byte-frequency array. In
  // practice human speech almost never fills the whole spectrum to 255,
  // so the average tops out around ~50-70 even when shouting. Mapping
  // it linearly to [0..100] meant the ring would only ever fill to ~50%.
  // Remap so that the speaking-detection threshold (20) reads as 0% and
  // a realistic loud-speech peak (~65) reads as 100%.
  const SPEAKING_FLOOR = 20;
  const SPEAKING_PEAK = 65;
  const level = props.userState.audioLevel;
  if (level <= SPEAKING_FLOOR) return 0;
  return Math.min((level - SPEAKING_FLOOR) / (SPEAKING_PEAK - SPEAKING_FLOOR), 1);
});

// Get user state directly from store for reactivity
// This bypasses any issues with props not updating correctly
const storeUserState = computed(() => {
  const userId = props.userState.userId;
  
  // For local user, use localState
  if (userId === voiceStore.localState.userId) {
    return voiceStore.localState;
  }
  
  // For remote users, find in allUsers
  const user = voiceStore.allUsers.find(u => u.userId === userId);
  return user || props.userState;
});

const hasVideo = computed(() => {
  // Read directly from store state for better reactivity
  const state = storeUserState.value;
  return state.isVideoEnabled || state.isScreenSharing;
});

const connectionQuality = computed(() => {
  const state = connectionState.value;
  // Connection quality based on connection state
  // TODO: In the future, integrate actual WebRTC stats (RTT, packet loss, etc.)
  if (state === 'disconnected') return 'poor';
  // Default to excellent for connected users - only show indicator if there's an issue
  return 'excellent';
});

const userStatus = computed(() => {
  if (props.userState.isScreenSharing) return 'Screen sharing';
  if (props.userState.isVideoEnabled && !props.userState.isScreenSharing) return 'Camera on';
  if (effectiveDeafened.value) return 'Deafened';
  if (effectiveMuted.value) return 'Muted';
  if (isSpeaking.value) return 'Speaking';
  return 'In voice';
});

// Check if this card is in fullscreen mode
const isFullscreenActive = computed(() => {
  return voiceStore.viewMode === 'fullscreen' && voiceStore.fullscreenUserId === props.userState.userId;
});

// Check if PIP is active for this user
const isPIPActive = computed(() => {
  return voiceStore.pipActive && voiceStore.pipUserId === props.userState.userId;
});

// Check if this user is locally muted (volume set to 0 by local user)
const isLocallyMuted = computed(() => {
  return voiceStore.getUserVolume(props.userState.userId) === 0;
});

// Connection bars count for indicator
const connectionBars = computed(() => {
  switch (connectionQuality.value) {
    case 'excellent': return 4;
    case 'poor': return 1;
    default: return 4; // Default to excellent
  }
});

// Voice ring animation
const voiceRingOffset = computed(() => {
  const circumference = 2 * Math.PI * 45; // 2 * pi * radius
  const progress = voiceIntensity.value;
  return circumference - progress * circumference;
});

// =============================================================================
// METHODS
// =============================================================================

// Audio bar heights for visualization
const getBarHeight = (barIndex: number) => {
  const baseHeight = 20;
  const intensity = voiceIntensity.value;
  // Add some pseudo-random variation to make it look more dynamic
  const variation = Math.sin(Date.now() / 150 + barIndex * 0.5) * 0.4;
  return Math.max(baseHeight + intensity * 80 + variation * 30, 15);
};

const onVideoLoaded = () => {
  debug.log('📹 Video loaded for user:', props.userState.userId);
};

/**
 * Handle card click - toggle fullscreen for videos
 */
const handleCardClick = () => {
  // Check both sources to match the v-if condition on video container
  // hasVideo uses store state, props.userState uses props - they might be momentarily out of sync
  const canShowVideo = hasVideo.value || props.userState.isVideoEnabled || props.userState.isScreenSharing;
  
  if (!canShowVideo) {
    debug.log('📺 [FullScreen] No video to fullscreen', {
      hasVideo: hasVideo.value,
      propsVideoEnabled: props.userState.isVideoEnabled,
      propsScreenSharing: props.userState.isScreenSharing
    });
    return;
  }
  
  // Toggle fullscreen mode
  if (isFullscreenActive.value) {
    voiceStore.exitFullscreen();
  } else {
    voiceStore.enterFullscreen(props.userState.userId);
  }
};

/**
 * Toggle PIP mode for screenshare
 * Always use draggable mode for consistent drag/resize behavior
 */
const togglePIP = () => {
  if (isPIPActive.value) {
    voiceStore.togglePIP(null);
  } else {
    // Use draggable mode for consistent drag/resize behavior
    voiceStore.togglePIP(props.userState.userId, 'draggable');
  }
};

/**
 * Handle right-click context menu
 */
const handleContextMenu = (event: MouseEvent) => {
  contextMenuPosition.value = { x: event.clientX, y: event.clientY };
  showContextMenu.value = true;
};

// =============================================================================
// WATCHERS
// =============================================================================

// Function to attach video to element
// Track last attached state to prevent unnecessary re-attachments
let lastAttachedVideoState = { isVideoEnabled: false, isScreenSharing: false };
let lastAttachedStreamId: string | null = null;
let isVideoAttached = false;
let pendingAttachment = false; // Track if we need to attach when element becomes available
let attachmentRetryCount = 0;
const MAX_ATTACHMENT_RETRIES = 5;

const attachVideo = (forceReattach = false) => {
  const userId = props.userState.userId;
  const state = storeUserState.value;
  const stream = userStream.value;
  
  if (!videoElement.value) {
    // Mark that we have a pending attachment for when the element becomes available
    const shouldShowVideo = state.isVideoEnabled || state.isScreenSharing;
    if (shouldShowVideo) {
      pendingAttachment = true;
      debug.log(`📹 Video element not ready for ${userId}, marking pending attachment`);
    }
    return;
  }
  
  pendingAttachment = false;
  
  const shouldShowVideo = state.isVideoEnabled || state.isScreenSharing;
  const currentStreamId = stream?.id || null;
  
  // Check if we need to reattach - either state changed OR stream changed OR forced
  const stateChanged = 
    lastAttachedVideoState.isVideoEnabled !== state.isVideoEnabled ||
    lastAttachedVideoState.isScreenSharing !== state.isScreenSharing;
  const streamChanged = currentStreamId !== lastAttachedStreamId;
  
  // Skip if video is already attached and nothing changed (unless forced)
  if (!forceReattach && isVideoAttached && shouldShowVideo && !stateChanged && !streamChanged) {
    return;
  }
  
  // Vue's ref unwrapping treats HTMLVideoElement as a structural type that
  // doesn't satisfy the nominal HTMLVideoElement parameter; cast once here.
  const videoEl = videoElement.value as HTMLVideoElement;
  if (shouldShowVideo) {
    // If stream changed OR state changed OR forced, we MUST reattach
    if ((streamChanged || stateChanged || forceReattach) && isVideoAttached) {
      debug.log(`📹 ${forceReattach ? 'Force' : 'State/Stream'} reattachment for ${userId}`);
      // Clear old attachment
      voiceStore.detachVideoFromElement(userId, videoEl);
      videoElement.value.srcObject = null;
      isVideoAttached = false;
    }
    
    // Use LiveKit's proper attach method - this is CRITICAL for adaptive streaming
    // Using srcObject directly causes LiveKit to disable all simulcast layers (frozen video)
    const attached = voiceStore.attachVideoToElement(userId, videoEl);
    if (attached) {
      isVideoAttached = true;
      lastAttachedVideoState = { isVideoEnabled: state.isVideoEnabled, isScreenSharing: state.isScreenSharing };
      lastAttachedStreamId = currentStreamId;
      attachmentRetryCount = 0;
      debug.log(`📹 ✅ Attached video for user ${userId}`);
    } else {
      // Fallback to srcObject for P2P mode or if attach fails
      if (stream && stream.getVideoTracks().length > 0) {
        videoElement.value.srcObject = stream;
        isVideoAttached = true;
        lastAttachedVideoState = { isVideoEnabled: state.isVideoEnabled, isScreenSharing: state.isScreenSharing };
        lastAttachedStreamId = currentStreamId;
        attachmentRetryCount = 0;
        debug.log(`📹 ⚠️ Fallback: srcObject for user ${userId}`);
      } else if (shouldShowVideo && attachmentRetryCount < MAX_ATTACHMENT_RETRIES) {
        // Retry attachment after a short delay - track might not be ready yet
        attachmentRetryCount++;
        debug.log(`📹 ⏳ Retry ${attachmentRetryCount}/${MAX_ATTACHMENT_RETRIES} for ${userId}`);
        setTimeout(() => {
          if (videoElement.value && (storeUserState.value.isVideoEnabled || storeUserState.value.isScreenSharing)) {
            attachVideo(true);
          }
        }, 100 * attachmentRetryCount);
      }
    }
  } else if (isVideoAttached) {
    // Detach video properly when turning off
    voiceStore.detachVideoFromElement(userId, videoEl);
    // Clear the video element completely
    videoElement.value.srcObject = null;
    videoElement.value.src = '';
    videoElement.value.load(); // Force reload to clear any cached frames
    isVideoAttached = false;
    lastAttachedVideoState = { isVideoEnabled: false, isScreenSharing: false };
    lastAttachedStreamId = null;
    attachmentRetryCount = 0;
    debug.log(`📹 Detached video for user ${userId}`);
  }
};

// Update video element when stream OR state changes
// Uses LiveKit's proper track.attach() method for adaptive streaming to work correctly
watch(
  [
    () => userStream.value, 
    () => storeUserState.value.isVideoEnabled, 
    () => storeUserState.value.isScreenSharing,
    () => voiceStore.streamUpdateCounter
  ],
  () => {
    // Use nextTick to ensure DOM is updated before attaching
    nextTick(() => attachVideo());
  },
  { immediate: true }
);

// Watch for when video element becomes available (v-if renders it)
// This is crucial for the case where state changes trigger v-if to render the element
watch(videoElement, (newEl, oldEl) => {
  if (newEl && !oldEl) {
    // Element just became available - check for pending attachment
    debug.log(`📹 Video element now available for ${props.userState.userId}, pending: ${pendingAttachment}`);
    // Always try to attach when element becomes available if we should show video
    const shouldShowVideo = storeUserState.value.isVideoEnabled || storeUserState.value.isScreenSharing;
    if (shouldShowVideo) {
      // Small delay to ensure element is fully in DOM
      setTimeout(() => attachVideo(true), 0);
    }
  }
});

// Specific watcher for screenshare state changes
// Handles both starting and stopping of screenshare
watch(
  () => storeUserState.value.isScreenSharing,
  (newVal, oldVal) => {
    if (newVal && !oldVal) {
      // Screenshare just started - force reattachment after a short delay
      // to ensure LiveKit has published the track
      debug.log(`📹 🖥️ Screenshare started for ${props.userState.userId}, scheduling forced attachment`);
      setTimeout(() => {
        if (videoElement.value) {
          attachVideo(true);
        }
      }, 150);
    } else if (!newVal && oldVal) {
      // Screenshare just stopped - immediately clean up video element
      debug.log(`📹 🖥️ Screenshare stopped for ${props.userState.userId}, cleaning up video`);
      if (videoElement.value) {
        voiceStore.detachVideoFromElement(props.userState.userId, videoElement.value as HTMLVideoElement);
        videoElement.value.srcObject = null;
        videoElement.value.src = '';
        videoElement.value.load();
        isVideoAttached = false;
        lastAttachedVideoState = { isVideoEnabled: false, isScreenSharing: false };
        lastAttachedStreamId = null;
        attachmentRetryCount = 0;
      }
    }
  }
);

// Watch for video state changes to immediately clean up when video stops
watch(
  () => storeUserState.value.isVideoEnabled,
  (newVal, oldVal) => {
    if (!newVal && oldVal && !storeUserState.value.isScreenSharing) {
      // Video stopped and not screensharing - clean up
      debug.log(`📹 Camera stopped for ${props.userState.userId}, cleaning up video`);
      if (videoElement.value && isVideoAttached) {
        voiceStore.detachVideoFromElement(props.userState.userId, videoElement.value as HTMLVideoElement);
        videoElement.value.srcObject = null;
        videoElement.value.src = '';
        videoElement.value.load();
        isVideoAttached = false;
        lastAttachedVideoState = { isVideoEnabled: false, isScreenSharing: false };
        lastAttachedStreamId = null;
        attachmentRetryCount = 0;
      }
    }
  }
);
</script>


<style scoped>
.harmony-voice-card {
  position: relative;
  background: linear-gradient(145deg, var(--background-tertiary), var(--background-secondary));
  border-radius: 16px;
  padding: 16px;
  border: 2px solid transparent;
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  /* `overflow: hidden` clips the speaking glow on the avatar (which lives
     inside the card and emits a soft box-shadow). The video container
     below sets its own `overflow: hidden` + border-radius for clipping
     the actual stream, so we don't need it on the card itself. */
  overflow: visible;
  min-height: 200px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3), 0 1px 4px rgba(0, 0, 0, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
  display: flex;
  flex-direction: column;
  flex-wrap: nowrap;
  align-content: center;
  justify-content: center;
  align-items: center;
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
}

/* Clickable cursor for video cards */
.harmony-voice-card.video-enabled,
.harmony-voice-card.screen-sharing {
  cursor: pointer;
}

.harmony-voice-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 4px 16px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

/* Speaking state */
.harmony-voice-card.speaking {
  border-color: #00d4aa;
  background: linear-gradient(145deg, #1a2f2a80, #2a4a3f80);
  box-shadow: 0 4px 16px rgba(0, 212, 170, 0.3), 0 0 32px rgba(0, 212, 170, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

/* Self user */
.harmony-voice-card.self {
  border-color: #0EA5E9;
  background: linear-gradient(145deg, #1e214080, #2a2d5080);
}

/* Connection states */
.harmony-voice-card.connection-poor {
  border-color: #ed4245;
  background: linear-gradient(145deg, #3a252880, #4a2f3280);
}

/* Video Container - sized to the camera's natural aspect ratio */
.video-container {
  position: relative;
  width: 100%;
  max-width: 480px;
  max-height: 360px;
  border-radius: 12px;
  overflow: hidden;
  background: #000;
  margin: 0 auto 12px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.5);
}

/* Webcam video - show at native aspect ratio */
.video-stream {
  width: 100%;
  height: auto;
  display: block;
  object-fit: contain;
  background: #000;
}

/* Screenshare video - preserve full content */
.harmony-voice-card.screen-sharing .video-container {
  max-width: 100%;
  max-height: 400px;
}

.harmony-voice-card.screen-sharing .video-stream {
  object-fit: contain;
}

.video-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.1) 0%, transparent 30%, transparent 70%, rgba(0, 0, 0, 0.8) 100%);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 12px;
  pointer-events: none;
}

.screen-share-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(87, 242, 135, 0.9);
  color: #000;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  align-self: flex-start;
  pointer-events: auto;
  /* Auto-hide animation - fades out after 3 seconds */
  animation: indicator-fade-out 3s ease-in-out forwards;
  opacity: 1;
  transition: opacity 0.2s ease;
}

/* Show indicator on hover over the video container */
.video-container:hover .screen-share-indicator {
  animation: none;
  opacity: 1;
}

@keyframes indicator-fade-out {
  0% { opacity: 1; }
  66% { opacity: 1; }
  100% { opacity: 0; }
}

.pip-toggle-btn {
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(0, 0, 0, 0.4);
  border-radius: 4px;
  color: #000;
  cursor: pointer;
  padding: 2px 4px;
  margin-left: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.pip-toggle-btn:hover {
  background: rgba(0, 0, 0, 0.5);
  color: var(--text-primary);
}

.pip-toggle-btn.active {
  background: var(--harmony-primary);
  border-color: #0EA5E9;
  color: var(--text-primary);
}

/* Connection quality indicator - bars style */
.connection-indicator {
  position: absolute;
  top: 8px;
  right: 8px;
  background: rgba(0, 0, 0, 0.6);
  padding: 4px 6px;
  border-radius: 4px;
  backdrop-filter: blur(4px);
}

.connection-bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 12px;
}

.connection-bars span {
  width: 3px;
  background: var(--background-quinary);
  border-radius: 1px;
  transition: all 0.3s ease;
}

.connection-bars span:nth-child(1) { height: 4px; }
.connection-bars span:nth-child(2) { height: 6px; }
.connection-bars span:nth-child(3) { height: 9px; }
.connection-bars span:nth-child(4) { height: 12px; }

.connection-bars span.active {
  background: var(--text-secondary);
}

.connection-indicator.good .connection-bars span.active {
  background: #00d4aa;
}

.connection-indicator.fair .connection-bars span.active {
  background: #faa61a;
}

.connection-indicator.poor .connection-bars span.active {
  background: #ed4245;
}

.video-controls {
  display: flex;
  gap: 8px;
  align-self: center;
  margin-top: auto;
  pointer-events: auto;
}

.control-btn {
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 50%;
  width: 36px;
  height: 36px;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}

.control-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  transform: scale(1.05);
}

.control-btn.active {
  background: linear-gradient(145deg, #0EA5E9, #0284C7);
  border-color: rgba(14, 165, 233, 0.6);
  box-shadow: 0 2px 8px rgba(14, 165, 233, 0.4);
}

/* Avatar Container */
.avatar-container {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0; /* Prevent container from shrinking */
}

.avatar-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.avatar-frame {
  position: relative;
  width: 82px;
  height: 82px;
  border-radius: 50%;
  background: linear-gradient(145deg, var(--background-quinary), var(--background-tertiary));
  transition: all 0.3s ease;
  padding: 4px;
  display: flex;
  justify-content: center;
  align-items: center;
  flex-shrink: 0; /* Prevent avatar from shrinking */
}

.avatar-frame.speaking {
  background: linear-gradient(145deg, #00d4aa, #00b894);
  box-shadow: 0 0 20px rgba(0, 212, 170, 0.4);
}

.user-avatar {
  padding: 2px;
}
/* Voice Ring */
.voice-ring {
  position: absolute;
  top: -8px;
  left: -8px;
  width: calc(100% + 16px);
  height: calc(100% + 16px);
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
}

.harmony-voice-card.speaking .voice-ring {
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
  stroke-width: 3;
  stroke-linecap: round;
  stroke-dasharray: 283; /* Circumference of a circle with r=45 */
  transition: stroke-dashoffset 0.15s ease;
  filter: drop-shadow(0 0 6px #00d4aa);
}

/* Status Indicators */
.status-indicators {
  position: absolute;
  bottom: -2px;
  right: -2px;
  display: flex;
  gap: 4px;
}

.status-badge {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  border: 2px solid var(--background-tertiary);
  color: var(--text-primary);
}

.status-badge.muted {
  background: #ed4245;
}

.status-badge.deafened {
  background: #faa61a;
}

.status-badge.locally-muted {
  background: var(--harmony-primary);
}

.status-badge.connection-poor {
  background: #ed4245;
}

/* User Info */
.user-info {
  text-align: center;
  position: relative;
  padding-bottom: 0px;
  top: 10px;
  margin: 0 auto;
  width: 100%;
}
.video-enabled .user-info,
.screen-sharing .user-info {
  padding-bottom: 20px;
  bottom: 0px;
}

.username {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 4px;
  transition: color 0.3s ease;
  line-height: 1.2;
}

.username.speaking {
  color: #00d4aa;
  text-shadow: 0 0 8px rgba(0, 212, 170, 0.3);
}

.harmony-voice-card-user-status {
  font-size: 12px;
  color: var(--text-secondary);
  opacity: 0.8;
}

/* Audio Visualizer */
.audio-visualizer {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 2px;
  align-items: flex-end;
  height: 20px;
}

.audio-bar {
  width: 3px;
  background: linear-gradient(to top, #00d4aa, #00f5d4);
  border-radius: 2px;
  transition: height 0.1s ease;
  animation: audioWave 1s ease-in-out infinite;
  animation-delay: var(--delay);
  height: var(--height);
  min-height: 4px;
  max-height: 20px;
}

/* Animations */
@keyframes pulse {
  0%,
  100% {
    opacity: 0.4;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.1);
  }
}

@keyframes audioWave {
  0%,
  100% {
    transform: scaleY(1);
  }
  50% {
    transform: scaleY(1.4);
  }
}

/* ============================================
   MOBILE RESPONSIVE STYLES
   ============================================ */

/* Tablet */
@media (max-width: 768px) {
  .harmony-voice-card {
    min-height: 150px;
    padding: 12px;
    border-radius: 12px;
  }

  .video-container {
    min-height: 120px;
    max-height: 250px;
    border-radius: 10px;
    margin-bottom: 10px;
  }

  .avatar-container {
    height: 60px;
    width: 60px;
  }

  .avatar-frame {
    width: 56px;
    height: 56px;
  }

  .voice-ring {
    top: -6px;
    left: -6px;
    width: calc(100% + 12px);
    height: calc(100% + 12px);
    overflow: visible;
  }

  .status-indicators {
    bottom: -1px;
    right: -1px;
  }

  .status-badge {
    width: 18px;
    height: 18px;
    font-size: 9px;
  }

  .user-info {
    top: 4px;
  }

  .username {
    font-size: 13px;
  }

  .harmony-voice-card-user-status {
    font-size: 11px;
  }

  .video-controls {
    gap: 6px;
  }

  .control-btn {
    width: 32px;
    height: 32px;
    font-size: 12px;
  }

  .audio-visualizer {
    bottom: 12px;
    height: 16px;
  }

  .audio-bar {
    width: 2px;
    max-height: 16px;
  }
}

/* Mobile portrait */
@media (max-width: 480px) {
  .harmony-voice-card {
    min-height: 120px;
    padding: 10px;
    border-radius: 10px;
    border-width: 1px;
  }

  .harmony-voice-card:hover {
    transform: none; /* Disable hover lift on touch */
  }

  .video-container {
    border-radius: 8px;
    margin-bottom: 8px;
    border-width: 1px;
  }

  .video-overlay {
    padding: 8px;
  }

  .screen-share-indicator {
    padding: 3px 6px;
    font-size: 10px;
    gap: 4px;
  }

  .pip-toggle-btn {
    padding: 2px 3px;
  }

  .connection-indicator {
    top: 6px;
    right: 6px;
    padding: 3px 5px;
  }

  .connection-bars {
    height: 10px;
    gap: 1px;
  }

  .connection-bars span {
    width: 2px;
  }

  .connection-bars span:nth-child(1) { height: 3px; }
  .connection-bars span:nth-child(2) { height: 5px; }
  .connection-bars span:nth-child(3) { height: 7px; }
  .connection-bars span:nth-child(4) { height: 10px; }

  .video-controls {
    gap: 8px;
  }

  /* Larger touch targets for controls */
  .control-btn {
    width: 36px;
    height: 36px;
    font-size: 14px;
  }

  .control-btn:active {
    transform: scale(0.95);
    background: rgba(255, 255, 255, 0.15);
  }

  .avatar-container {
    height: 53px;
    width: 53px;
  }

  .avatar-frame {
    width: 48px;
    height: 48px;
  }

  .voice-ring {
    top: -5px;
    left: -5px;
    width: calc(100% + 10px);
    height: calc(100% + 10px);
  }

  .user-info {
    margin-bottom: 20px;
  }

  .voice-ring-bg {
    stroke-width: 1.5;
  }

  .voice-ring-active {
    stroke-width: 2;
  }

  .status-indicators {
    gap: 2px;
  }

  .status-badge {
    width: 16px;
    height: 16px;
    font-size: 8px;
    border-width: 1.5px;
  }

  .user-info {
    top: 6px;
    padding-bottom: 0;
  }

  .video-enabled .user-info,
  .screen-sharing .user-info {
    padding-bottom: 16px;
  }

  .username {
    font-size: 12px;
    margin-bottom: 2px;
  }

  .harmony-voice-card-user-status {
    font-size: 10px;
  }

  .audio-visualizer {
    bottom: 10px;
    height: 14px;
    gap: 1px;
  }

  .audio-bar {
    width: 2px;
    max-height: 14px;
  }
}

/* Very small mobile */
@media (max-width: 360px) {
  .harmony-voice-card {
    min-height: 100px;
    padding: 8px;
  }

  .video-container {
    min-height: 80px;
    max-height: 160px;
    margin-bottom: 6px;
  }

  .avatar-container {
    margin-bottom: 16px;
  }

  .avatar-frame {
    width: 40px;
    height: 40px;
  }

  .status-badge {
    width: 14px;
    height: 14px;
    font-size: 7px;
  }

  .username {
    font-size: 11px;
  }

  .harmony-voice-card-user-status {
    font-size: 9px;
  }

  .control-btn {
    width: 32px;
    height: 32px;
    font-size: 12px;
  }

  .audio-visualizer {
    bottom: 8px;
    height: 12px;
  }
}

/* Larger screens - allow taller video containers */
@media (min-width: 1200px) {
  .video-container {
    max-height: 500px;
  }
}
</style>