<template>
  <Teleport to="body">
    <div
      v-if="isVisible"
      class="context-menu-backdrop"
      @click="close"
      @contextmenu.prevent="close"
    />
    <div
      v-if="isVisible"
      ref="menuRef"
      class="voice-context-menu"
      :style="menuStyle"
      @click.stop
    >
      <!-- User Header -->
      <div class="menu-header">
        <Avatar
          :src="userProfile?.avatar_url || '/default_avatar.webp'"
          :alt="displayName"
          size="sm"
        />
        <div class="user-info">
          <span class="display-name"><DisplayName :userId="props.userState.userId" :fallback="displayName" /></span>
          <span class="user-info-status">{{ userStatus }}</span>
        </div>
      </div>

      <div class="menu-divider" />

      <!-- Volume Control -->
      <div v-if="!isSelf" class="menu-section">
        <div class="section-label">
          <Icon name="mic" />
          <span>Mic Volume</span>
          <span class="volume-value">{{ currentVolume }}%</span>
        </div>
        <div class="volume-slider-container">
          <input
            type="range"
            :value="currentVolume"
            min="0"
            max="200"
            step="1"
            class="volume-slider"
            @input="handleVolumeChange"
          />
          <div class="volume-marks">
            <span>0%</span>
            <span>100%</span>
            <span>200%</span>
          </div>
        </div>
        <div class="volume-presets">
          <button
            class="preset-btn"
            :class="{ active: currentVolume === 0 }"
            @click="setVolume(0)"
            title="Mute"
          >
            <Icon name="volume-x" />
          </button>
          <button
            class="preset-btn"
            :class="{ active: currentVolume === 50 }"
            @click="setVolume(50)"
            title="50%"
          >
            <Icon name="volume-1" />
          </button>
          <button
            class="preset-btn"
            :class="{ active: currentVolume === 100 }"
            @click="setVolume(100)"
            title="Normal"
          >
            <Icon name="volume-2" />
          </button>
          <button
            class="preset-btn"
            :class="{ active: currentVolume === 200 }"
            @click="setVolume(200)"
            title="Max (200%)"
          >
            <Icon name="volume-2" />
            <span class="boost-indicator">+</span>
          </button>
        </div>
      </div>
      
      <!-- Screenshare Volume Control (when user is screensharing) -->
      <div v-if="!isSelf && isScreenSharing" class="menu-section">
        <div class="section-label">
          <Icon name="screen-share" />
          <span>Screenshare Audio</span>
          <span v-if="!hasScreenShareAudio" class="no-audio-hint">(no audio)</span>
          <span class="volume-value">{{ currentScreenShareVolume }}%</span>
        </div>
        <div class="volume-slider-container">
          <input
            type="range"
            :value="currentScreenShareVolume"
            min="0"
            max="200"
            step="1"
            class="volume-slider screenshare-slider"
            @input="handleScreenShareVolumeChange"
          />
          <div class="volume-marks">
            <span>0%</span>
            <span>100%</span>
            <span>200%</span>
          </div>
        </div>
        <div class="volume-presets">
          <button
            class="preset-btn"
            :class="{ active: currentScreenShareVolume === 0 }"
            @click="setScreenShareVolume(0)"
            title="Mute"
          >
            <Icon name="volume-x" />
          </button>
          <button
            class="preset-btn"
            :class="{ active: currentScreenShareVolume === 50 }"
            @click="setScreenShareVolume(50)"
            title="50%"
          >
            <Icon name="volume-1" />
          </button>
          <button
            class="preset-btn"
            :class="{ active: currentScreenShareVolume === 100 }"
            @click="setScreenShareVolume(100)"
            title="Normal"
          >
            <Icon name="volume-2" />
          </button>
          <button
            class="preset-btn"
            :class="{ active: currentScreenShareVolume === 200 }"
            @click="setScreenShareVolume(200)"
            title="Max (200%)"
          >
            <Icon name="volume-2" />
            <span class="boost-indicator">+</span>
          </button>
        </div>
      </div>

      <!-- Actions for other users -->
      <template v-if="!isSelf">
        <div class="menu-divider" />
        <div class="menu-actions">
          <button
            v-if="hasVideo"
            class="menu-action"
            @click="focusUser"
          >
            <Icon name="maximize-2" />
            <span>{{ isFullscreen ? 'Exit Focus' : 'Focus Video' }}</span>
          </button>

          <button
            v-if="isFullscreen"
            class="menu-action"
            @click="toggleFullWindow"
          >
            <Icon name="monitor" />
            <span>{{ isFullWindowMode ? 'Exit Full Window' : 'Full Window' }}</span>
          </button>

          <button
            v-if="isScreenSharing"
            class="menu-action"
            @click="togglePIP"
          >
            <Icon name="picture-in-picture" />
            <span>{{ isPIP ? 'Exit PiP' : 'Picture in Picture' }}</span>
          </button>

          <button
            class="menu-action"
            :class="{ active: currentVolume === 0 }"
            @click="toggleMuteUser"
          >
            <Icon :name="currentVolume === 0 ? 'volume-x' : 'volume-2'" />
            <span>{{ currentVolume === 0 ? 'Unmute User' : 'Mute User' }}</span>
          </button>
        </div>
      </template>

      <!-- Self Actions -->
      <template v-if="isSelf">
        <!-- Stream Quality Settings (when streaming) -->
        <div v-if="hasVideo" class="menu-section">
          <div class="section-label">
            <Icon name="settings" />
            <span>Stream Quality</span>
          </div>
          
          <!-- Resolution -->
          <div class="quality-row">
            <span class="quality-label">Resolution</span>
            <div class="quality-options">
              <button
                v-for="res in resolutionOptions"
                :key="res.value"
                class="quality-btn"
                :class="{ active: currentResolution === res.value }"
                @click="setResolution(res.value)"
                :title="res.label"
              >
                {{ res.short }}
              </button>
            </div>
          </div>
          
          <!-- Frame Rate -->
          <div class="quality-row">
            <span class="quality-label">Frame Rate</span>
            <div class="quality-options">
              <button
                v-for="fps in frameRateOptions"
                :key="fps.value"
                class="quality-btn"
                :class="{ active: currentFrameRate === fps.value }"
                @click="setFrameRate(fps.value)"
                :title="`${fps.value} FPS`"
              >
                {{ fps.value }}
              </button>
            </div>
          </div>
          
          <!-- Audio Bitrate -->
          <div class="quality-row">
            <span class="quality-label">Audio Quality</span>
            <div class="quality-options">
              <button
                v-for="bitrate in audioBitrateOptions"
                :key="bitrate.value"
                class="quality-btn"
                :class="{ active: currentAudioBitrate === bitrate.value }"
                @click="setAudioBitrate(bitrate.value)"
                :title="bitrate.label"
              >
                {{ bitrate.short }}
              </button>
            </div>
          </div>
        </div>
        
        <div class="menu-divider" />
        
        <div class="menu-actions">
          <button class="menu-action" @click="toggleMute">
            <Icon :name="localMuted ? 'mic-off' : 'mic'" />
            <span>{{ localMuted ? 'Unmute' : 'Mute' }}</span>
          </button>
          <button class="menu-action" @click="toggleDeafen">
            <Icon :name="localDeafened ? 'headphones-off' : 'headphones'" />
            <span>{{ localDeafened ? 'Undeafen' : 'Deafen' }}</span>
          </button>
          <button 
            v-if="hasVideo"
            class="menu-action"
            @click="focusUser"
          >
            <Icon name="maximize-2" />
            <span>{{ isFullscreen ? 'Exit Focus' : 'Focus Video' }}</span>
          </button>
        </div>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue';
import type { UserMediaState } from '@/services/unifiedWebRTC';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useUserData } from '@/composables/useUserData';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';
import DisplayName from '@/components/DisplayName.vue';

interface Props {
  userState: UserMediaState;
  x: number;
  y: number;
  visible: boolean;
}

const props = defineProps<Props>();

interface Emits {
  (e: 'close'): void;
}

const emit = defineEmits<Emits>();

const voiceStore = useUnifiedVoiceChannelStore();
const { getUserProfile } = useUserData();

const menuRef = ref<HTMLElement | null>(null);
// Initialize with props to prevent flash at 0,0
const adjustedPosition = ref({ x: 0, y: 0 });

const isVisible = computed(() => props.visible);

const userProfile = computed(() => {
  const profile = getUserProfile(props.userState.userId).value;
  return profile || {
    display_name: null,
    username: 'Unknown User',
    avatar_url: '/default_avatar.webp'
  };
});

const displayName = computed(() => {
  return userProfile.value.display_name || userProfile.value.username || 'Unknown User';
});

const isSelf = computed(() => {
  return props.userState.userId === voiceStore.localState.userId;
});

const userStatus = computed(() => {
  if (props.userState.isScreenSharing) return 'Screen sharing';
  if (props.userState.isVideoEnabled) return 'Camera on';
  if (props.userState.isDeafened) return 'Deafened';
  if (props.userState.isMuted) return 'Muted';
  if (props.userState.isSpeaking) return 'Speaking';
  return 'In voice';
});

const hasVideo = computed(() => {
  return props.userState.isVideoEnabled || props.userState.isScreenSharing;
});

const isScreenSharing = computed(() => props.userState.isScreenSharing);

const isFullscreen = computed(() => {
  return voiceStore.viewMode === 'fullscreen' && voiceStore.fullscreenUserId === props.userState.userId;
});

const isFullWindowMode = computed(() => voiceStore.isFullWindowMode);

const isPIP = computed(() => {
  return voiceStore.pipActive && voiceStore.pipUserId === props.userState.userId;
});

const currentVolume = computed(() => {
  return voiceStore.getUserVolume(props.userState.userId);
});

const currentScreenShareVolume = computed(() => {
  return voiceStore.getUserScreenShareVolume(props.userState.userId);
});

const hasScreenShareAudio = computed(() => {
  return voiceStore.hasScreenShareAudio(props.userState.userId);
});

const localMuted = computed(() => voiceStore.localState.isMuted);
const localDeafened = computed(() => voiceStore.localState.isDeafened);

const menuStyle = computed(() => ({
  left: `${adjustedPosition.value.x}px`,
  top: `${adjustedPosition.value.y}px`,
}));

// -1 = Source (native resolution), other values are specific resolutions
const resolutionOptions = [
  { value: 360, label: '360p (Low)', short: '360p' },
  { value: 480, label: '480p (SD)', short: '480p' },
  { value: 720, label: '720p (HD)', short: '720p' },
  { value: 1080, label: '1080p (Full HD)', short: '1080p' },
  { value: 1440, label: '1440p (QHD)', short: '1440p' },
  { value: 2160, label: '2160p (4K)', short: '4K' },
  { value: -1, label: 'Source (Native)', short: 'Source' }, // -1 = native resolution
];

const frameRateOptions = [
  { value: 10, label: '10 FPS (Low)' },
  { value: 15, label: '15 FPS' },
  { value: 24, label: '24 FPS (Cinema)' },
  { value: 30, label: '30 FPS' },
  { value: 60, label: '60 FPS' },
];

const audioBitrateOptions = [
  { value: 32, label: '32 kbps (Low)', short: '32k' },
  { value: 64, label: '64 kbps (Voice)', short: '64k' },
  { value: 128, label: '128 kbps (Standard)', short: '128k' },
  { value: 256, label: '256 kbps (High)', short: '256k' },
];

// Handle -1 (source) as a valid value, default to 720 only if undefined/null
const currentResolution = computed(() => {
  const res = voiceStore.streamSettings?.resolution;
  return res !== undefined && res !== null ? res : 720;
});
const currentFrameRate = computed(() => voiceStore.streamSettings?.frameRate || 30);
const currentAudioBitrate = computed(() => voiceStore.streamSettings?.audioBitrate || 128);

const setResolution = async (resolution: number) => {
  await voiceStore.updateStreamQuality({ resolution });
};

const setFrameRate = async (frameRate: number) => {
  await voiceStore.updateStreamQuality({ frameRate });
};

const setAudioBitrate = async (audioBitrate: number) => {
  await voiceStore.updateStreamQuality({ audioBitrate });
};

const close = () => {
  emit('close');
};

const handleVolumeChange = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const volume = parseInt(target.value, 10);
  voiceStore.setUserVolume(props.userState.userId, volume);
};

const setVolume = (volume: number) => {
  voiceStore.setUserVolume(props.userState.userId, volume);
};

const handleScreenShareVolumeChange = (event: Event) => {
  const target = event.target as HTMLInputElement;
  const volume = parseInt(target.value, 10);
  voiceStore.setUserScreenShareVolume(props.userState.userId, volume);
};

const setScreenShareVolume = (volume: number) => {
  voiceStore.setUserScreenShareVolume(props.userState.userId, volume);
};

const toggleMuteUser = () => {
  if (currentVolume.value === 0) {
    setVolume(100);
  } else {
    setVolume(0);
  }
};

const focusUser = () => {
  if (isFullscreen.value) {
    voiceStore.exitFullscreen();
  } else {
    voiceStore.enterFullscreen(props.userState.userId);
  }
  close();
};

const toggleFullWindow = () => {
  voiceStore.toggleFullWindowMode();
  close();
};

const togglePIP = () => {
  if (isPIP.value) {
    voiceStore.togglePIP(null);
  } else {
    // Use draggable mode for consistent drag/resize behavior
    voiceStore.togglePIP(props.userState.userId, 'draggable');
  }
  close();
};

const toggleMute = () => {
  voiceStore.toggleMute();
  close();
};

const toggleDeafen = () => {
  voiceStore.toggleDeafen();
  close();
};

// Position adjustment to keep menu on screen
const adjustPosition = async () => {
  await nextTick();
  
  if (!menuRef.value) {
    adjustedPosition.value = { x: props.x, y: props.y };
    return;
  }
  
  const rect = menuRef.value.getBoundingClientRect();
  const padding = 10;
  
  let x = props.x;
  let y = props.y;
  
  // Adjust if menu goes off-screen right
  if (x + rect.width + padding > window.innerWidth) {
    x = window.innerWidth - rect.width - padding;
  }
  
  // Adjust if menu goes off-screen bottom
  if (y + rect.height + padding > window.innerHeight) {
    y = window.innerHeight - rect.height - padding;
  }
  
  // Ensure minimum position
  x = Math.max(padding, x);
  y = Math.max(padding, y);
  
  adjustedPosition.value = { x, y };
};

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    close();
  }
};

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
});

watch(
  () => props.visible,
  async (visible) => {
    if (visible) {
      adjustedPosition.value = { x: props.x, y: props.y };
      await adjustPosition();
    }
  },
  { immediate: true }
);

watch(
  () => [props.x, props.y],
  async () => {
    if (props.visible) {
      adjustedPosition.value = { x: props.x, y: props.y };
      await adjustPosition();
    }
  }
);
</script>

<style scoped>
.context-menu-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10005;
}

.voice-context-menu {
  position: fixed;
  z-index: 10006;
  background: linear-gradient(145deg, var(--background-tertiary), var(--background-secondary));
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  box-shadow: 
    0 8px 32px rgba(0, 0, 0, 0.6),
    0 4px 16px rgba(0, 0, 0, 0.4);
  min-width: 280px;
  max-width: 340px;
  overflow: hidden;
  animation: menu-appear 0.15s ease-out;
}

@keyframes menu-appear {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(-4px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

/* Header */
.menu-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: rgba(0, 0, 0, 0.2);
}

.user-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
  flex: 1;
  min-width: 0; /* Allow text truncation */
}

.display-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.user-info-status {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Divider */
.menu-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.1);
  margin: 0 0 4px 0;
}

/* Volume Section */
.menu-section {
  padding: 12px 16px;
}

.section-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}

.volume-value {
  margin-left: auto;
  color: #0EA5E9;
  font-weight: 700;
}

.no-audio-hint {
  font-size: 10px;
  color: var(--text-muted);
  opacity: 0.7;
}

.volume-slider-container {
  margin-bottom: 12px;
}

.volume-slider {
  width: 100%;
  height: 6px;
  appearance: none;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  outline: none;
  cursor: pointer;
}

.volume-slider::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  background: var(--harmony-primary);
  border-radius: 50%;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(14, 165, 233, 0.4);
  transition: transform 0.15s ease;
}

.volume-slider::-webkit-slider-thumb:hover {
  transform: scale(1.1);
}

/* Screenshare slider - purple/violet accent */
.volume-slider.screenshare-slider::-webkit-slider-thumb {
  background: var(--harmony-accent);;
  box-shadow: 0 2px 6px var(--harmony-accent-alpha);
}

.volume-slider.screenshare-slider::-webkit-slider-runnable-track {
  /* background: linear-gradient(to right, rgba(155, 89, 182, 0.3), rgba(155, 89, 182, 0.5)); */
}

.volume-marks {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 10px;
  color: var(--text-muted);
}

.volume-presets {
  display: flex;
  gap: 8px;
  justify-content: center;
}

.preset-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  width: 36px;
  height: 36px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.preset-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
  border-color: rgba(255, 255, 255, 0.2);
}

.preset-btn.active {
  background: var(--harmony-primary);
  color: var(--text-primary);
  border-color: #0EA5E9;
}

.boost-indicator {
  position: absolute;
  top: 2px;
  right: 2px;
  font-size: 12px;
  font-weight: 700;
  color: #00d4aa;
}

.preset-btn.active .boost-indicator {
  color: var(--text-primary);
}

/* Stream Quality Options */
.quality-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  gap: 12px;
}

.quality-row:last-child {
  margin-bottom: 0;
}

.quality-label {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
}

.quality-options {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.quality-btn {
  padding: 5px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  min-width: 42px;
  text-align: center;
}

.quality-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
  border-color: rgba(255, 255, 255, 0.2);
}

.quality-btn.active {
  background: var(--harmony-primary);
  color: var(--text-primary);
  border-color: #0EA5E9;
}

/* Actions */
.menu-actions {
  padding: 8px;
}

.menu-action {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
  text-align: left;
}

.menu-action:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-primary);
}

.menu-action.active {
  background: rgba(237, 66, 69, 0.15);
  color: #ed4245;
}

.menu-action.active:hover {
  background: rgba(237, 66, 69, 0.25);
}
</style>

