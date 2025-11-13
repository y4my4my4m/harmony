<template>
  <div
    class="harmony-voice-card"
    :class="{
      speaking: isSpeaking,
      muted: props.userState.isMuted,
      deafened: props.userState.isDeafened,
      'video-enabled': hasVideo,
      'screen-sharing': props.userState.isScreenSharing,
      self: isSelf,
      'connection-poor': connectionState === 'disconnected',
    }"
  >
    <!-- Video Container -->
    <div v-if="hasVideo || props.userState.isScreenSharing" class="video-container">
      <video
        ref="videoElement"
        :srcObject="userStream"
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
        </div>

        <!-- Connection quality indicator -->
        <div class="connection-indicator" :class="connectionQuality">
          <div class="connection-dots">
            <span v-for="i in 3" :key="i"></span>
          </div>
        </div>

        <!-- Self controls -->
        <div v-if="isSelf" class="video-controls">
          <button
            @click="emit('toggle-video')"
            class="control-btn"
            :class="{ active: props.userState.isVideoEnabled && !props.userState.isScreenSharing }"
            :title="props.userState.isVideoEnabled && !props.userState.isScreenSharing ? 'Turn off camera' : 'Turn on camera'"
          >
            <Icon name="camera" />
          </button>
          <button
            @click="emit('toggle-screen-share')"
            class="control-btn"
            :class="{ active: props.userState.isScreenSharing }"
            :title="props.userState.isScreenSharing ? 'Stop screen share' : 'Share screen'"
          >
            <Icon name="screen-share" />
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
            :src="userProfile?.avatar_url || '/default_avatar.png'" 
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
          <div v-if="props.userState.isMuted" class="status-badge muted" title="Muted">
            <Icon name="mic-off" />
          </div>
          <div v-if="props.userState.isDeafened" class="status-badge deafened" title="Deafened">
            <Icon name="headphones-off" />
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
        {{ displayName }}
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
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { UserMediaState } from '@/services/unifiedWebRTC';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useUserData } from '@/composables/useUserData';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';

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
      console.warn(`No profile data found for user ${props.userState.userId}`);
    }
    
    // Ensure we always return a valid profile object
    const result = {
      display_name: profileData?.display_name || null,
      username: profileData?.username || 'Unknown User',
      avatar_url: profileData?.avatar_url || '/default_avatar.png'
    };
    
    return result;
  } catch (error) {
    console.warn('Error getting user profile for voice card:', error);
    return {
      display_name: null,
      username: 'Unknown User',
      avatar_url: '/default_avatar.png'
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
    return props.userState.audioLevel > 20 && !props.userState.isMuted;
  }
  // For peer users, rely on the state provided by the WebRTC service
  return props.userState.isSpeaking;
});

const voiceIntensity = computed(() => {
  return Math.min(props.userState.audioLevel / 100, 1);
});

const hasVideo = computed(() => {
  const hasVideoTracks = userStream.value?.getVideoTracks().length ?? 0;
  const stateIndicatesVideo = props.userState.isVideoEnabled || props.userState.isScreenSharing;
  
  // Show video if tracks exist OR state says video is on
  // This handles both turn-on (state first) and turn-off (tracks removed first)
  return hasVideoTracks > 0 || stateIndicatesVideo;
});

const connectionQuality = computed(() => {
  const state = connectionState.value;
  // Note: This is a simplistic check. Real-world quality might come from WebRTC stats.
  if (props.userState.audioLevel > 30) return 'excellent';
  if (props.userState.audioLevel > 15) return 'good';
  if (state === 'disconnected') return 'poor';
  return 'fair';
});

const userStatus = computed(() => {
  if (props.userState.isScreenSharing) return 'Screen sharing';
  if (props.userState.isVideoEnabled && !props.userState.isScreenSharing) return 'Camera on';
  if (props.userState.isDeafened) return 'Deafened';
  if (props.userState.isMuted) return 'Muted';
  if (isSpeaking.value) return 'Speaking';
  return 'In voice';
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
  console.log('📹 Video loaded for user:', props.userState.userId);
};

// =============================================================================
// WATCHERS
// =============================================================================

// Update video element when stream changes
watch(
  () => userStream.value,
  (newStream) => {
    if (videoElement.value) {
      const hasVideoTracks = newStream?.getVideoTracks().length ?? 0;
      
      if (hasVideoTracks > 0) {
        // Has video tracks - update srcObject
        videoElement.value.srcObject = newStream;
        console.log(`📹 Updating video stream for user ${props.userState.userId}. Video tracks: ${hasVideoTracks}`);
      } else if (!props.userState.isVideoEnabled && !props.userState.isScreenSharing) {
        // No video tracks AND state says off - clear to remove frozen frame
        videoElement.value.srcObject = null;
        console.log(`📹 Clearing video stream for user ${props.userState.userId} (camera off)`);
      }
      // else: No tracks yet but state says on - keep old srcObject temporarily (negotiation in progress)
    }
  },
  { immediate: true }
);
</script>


<style scoped>
.harmony-voice-card {
  position: relative;
  background: linear-gradient(145deg, #2f3136, #36393f);
  border-radius: 16px;
  padding: 16px;
  border: 2px solid transparent;
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  overflow: hidden;
  min-height: 200px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3), 0 1px 4px rgba(0, 0, 0, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

.harmony-voice-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 4px 16px rgba(0, 0, 0, 0.3),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

/* Speaking state */
.harmony-voice-card.speaking {
  border-color: #00d4aa;
  background: linear-gradient(145deg, #1a2f2a, #2a4a3f);
  box-shadow: 0 4px 16px rgba(0, 212, 170, 0.3), 0 0 32px rgba(0, 212, 170, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

/* Self user */
.harmony-voice-card.self {
  border-color: #5865f2;
  background: linear-gradient(145deg, #1e2140, #2a2d50);
}

/* Connection states */
.harmony-voice-card.connection-poor {
  border-color: #ed4245;
  background: linear-gradient(145deg, #3a2528, #4a2f32);
}

/* Video Container */
.video-container {
  position: relative;
  width: 100%;
  height: 160px;
  border-radius: 12px;
  overflow: hidden;
  background: #000;
  margin-bottom: 12px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  box-shadow: inset 0 2px 8px rgba(0, 0, 0, 0.5);
}

.video-stream {
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: #000;
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
}

.connection-indicator {
  position: absolute;
  top: 12px;
  right: 12px;
}

.connection-dots {
  display: flex;
  gap: 3px;
}

.connection-dots span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #40444b;
  transition: all 0.3s ease;
}

.connection-indicator.excellent .connection-dots span {
  background: #00d4aa;
}

.connection-indicator.good .connection-dots span:nth-child(-n + 2) {
  background: #faa61a;
}

.connection-indicator.fair .connection-dots span:first-child {
  background: #faa61a;
}

.connection-indicator.poor .connection-dots span:first-child {
  background: #ed4245;
}

.connection-indicator.connecting .connection-dots span {
  background: #5865f2;
  animation: pulse 1s infinite;
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
  color: #fff;
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
  background: linear-gradient(145deg, #5865f2, #4752c4);
  border-color: rgba(88, 101, 242, 0.6);
  box-shadow: 0 2px 8px rgba(88, 101, 242, 0.4);
}

/* Avatar Container */
.avatar-container {
  display: flex;
  align-items: center;
  justify-content: center;
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
  background: linear-gradient(145deg, #40444b, #2f3136);
  transition: all 0.3s ease;
  padding: 4px;
  display: flex;
  justify-content: center;
  align-items: center;
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
  border: 2px solid #2f3136;
  color: white;
}

.status-badge.muted {
  background: #ed4245;
}

.status-badge.deafened {
  background: #faa61a;
}

.status-badge.connection-poor {
  background: #ed4245;
}

/* User Info */
.user-info {
  text-align: center;
  position: relative;
  padding-bottom: 0px;
  top: 20px;
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
  color: #dcddde;
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
  color: #b9bbbe;
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

/* Responsive */
@media (max-width: 768px) {
  .harmony-voice-card {
    min-height: 160px;
    padding: 12px;
  }

  .video-container {
    height: 120px;
  }

  .avatar-container {
    height: auto;
    margin-bottom: 30px;
  }

  .avatar-frame {
    width: 60px;
    height: 60px;
  }

  .username {
    font-size: 13px;
  }

  .harmony-voice-card-user-status {
    font-size: 11px;
  }
}
</style>