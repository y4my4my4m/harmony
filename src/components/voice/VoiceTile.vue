<template>
  <div
    class="voice-tile"
    :class="{
      speaking: isSpeaking && source === 'camera',
      'has-video': hasActiveVideo,
      'is-screen': source === 'screen',
      self: isSelf,
      focused: isFocused,
    }"
    @click="emit('expand')"
    @dblclick="emit('request-fullscreen')"
    @contextmenu.prevent="handleContextMenu"
  >
    <!-- Video layer (webview transports only; native renders in the call window) -->
    <video
      v-if="hasActiveVideo && !isNativeVideo"
      ref="videoElement"
      autoplay
      playsinline
      :muted="isSelf"
      class="tile-video"
      :class="fitClass"
    />

    <!-- Native transport: video lives in the wgpu call window -->
    <button
      v-else-if="hasActiveVideo && isNativeVideo"
      class="tile-native-video"
      @click.stop="openCallWindow"
    >
      <Icon :name="source === 'screen' ? 'screen-share' : 'video'" class="native-video-icon" />
      <span>{{ source === 'screen' ? 'Screen share' : 'Camera' }} in call window</span>
      <span class="native-video-hint">Click to open</span>
    </button>

    <!-- Avatar fallback (camera tile without video) -->
    <div v-else class="tile-avatar">
      <div
        v-if="userProfile.banner_url"
        class="tile-banner"
        :style="{ backgroundImage: `url(${userProfile.banner_url})` }"
      />
      <div class="avatar-ring" :class="{ speaking: isSpeaking }">
        <Avatar
          :src="userProfile.avatar_url"
          :alt="displayName"
          size="xl"
          class="tile-avatar-img"
        />
      </div>
    </div>

    <!-- Bottom-left identity pill -->
    <div class="tile-pill">
      <Icon v-if="source === 'screen'" name="screen-share" class="pill-icon live" />
      <Icon v-else-if="effectiveDeafened" name="headphones-off" class="pill-icon danger" />
      <Icon v-else-if="effectiveMuted" name="mic-off" class="pill-icon danger" />
      <span class="pill-name">
        <DisplayName :user-id="props.userState.userId" :fallback="displayName" :truncate="true" />
      </span>
      <span v-if="source === 'screen'" class="pill-live-badge">LIVE</span>
    </div>

    <!-- Locally-muted indicator -->
    <div v-if="isLocallyMuted && !isSelf && source === 'camera'" class="tile-corner-badge" title="Muted by you">
      <Icon name="volume-x" />
    </div>

    <!-- Hover controls -->
    <div class="tile-actions" @click.stop @dblclick.stop>
      <button
        class="tile-action-btn"
        :title="isFocused ? 'Exit focus' : 'Focus'"
        @click="emit('expand')"
      >
        <Icon :name="isFocused ? 'minimize-2' : 'maximize-2'" />
      </button>
      <button
        v-if="source === 'screen'"
        class="tile-action-btn"
        :class="{ active: isPIPActive }"
        :title="isPIPActive ? 'Exit picture-in-picture' : 'Picture-in-picture'"
        @click="togglePIP"
      >
        <Icon name="picture-in-picture" />
      </button>
    </div>

    <!-- Context menu -->
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
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue';
import { debug } from '@/utils/debug';
import type { UserMediaState } from '@/services/unifiedWebRTC';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { webrtcManager } from '@/services/webrtcManager';
import { nativeLiveKit } from '@/services/nativeLiveKit';
import { useUserData } from '@/composables/useUserData';
import DisplayName from '@/components/DisplayName.vue';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';
import VoiceUserContextMenu from './VoiceUserContextMenu.vue';
import { getBannerUrl } from '@/utils/bannerUtils';

const props = withDefaults(defineProps<{
  userState: UserMediaState;
  /** Which of the participant's video feeds this tile renders */
  source: 'camera' | 'screen';
  /** cover crops to fill (webcams), contain letterboxes (screenshares) */
  fit?: 'cover' | 'contain';
}>(), {
  fit: undefined,
});

const emit = defineEmits<{
  (e: 'expand'): void;
  (e: 'request-fullscreen'): void;
}>();

const voiceStore = useUnifiedVoiceChannelStore();
const { getUserProfile } = useUserData();

const videoElement = ref<HTMLVideoElement | null>(null);
const showContextMenu = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });

const userProfile = computed(() => {
  const profileData = getUserProfile(props.userState.userId).value as any;
  return {
    display_name: profileData?.display_name || null,
    username: profileData?.username || 'Unknown User',
    avatar_url: profileData?.avatar_url || '/default_avatar.webp',
    banner_url: getBannerUrl(profileData?.bannerUrl || profileData?.banner_url) || null,
  };
});

const displayName = computed(() =>
  userProfile.value.display_name || userProfile.value.username || 'Unknown User'
);

const isSelf = computed(() => props.userState.userId === voiceStore.localState.userId);

// Read from the store for the local user so mute/deafen flips are instant
const liveState = computed(() => {
  if (isSelf.value) return voiceStore.localState;
  return voiceStore.allUsers.find(u => u.userId === props.userState.userId) || props.userState;
});

const effectiveMuted = computed(() => liveState.value.isMuted);
const effectiveDeafened = computed(() => liveState.value.isDeafened);

const isSpeaking = computed(() => {
  if (isSelf.value) {
    return liveState.value.audioLevel > 20 && !effectiveMuted.value;
  }
  return liveState.value.isSpeaking;
});

const hasActiveVideo = computed(() =>
  props.source === 'screen' ? liveState.value.isScreenSharing : liveState.value.isVideoEnabled
);

// native video renders in the wgpu call window, not the webview <video>
const isNativeVideo = computed(() => webrtcManager.isNativeBackend());

const openCallWindow = () => {
  nativeLiveKit.openCallWindow();
};

const fitClass = computed(() => {
  const fit = props.fit ?? (props.source === 'screen' ? 'contain' : 'cover');
  return fit === 'contain' ? 'fit-contain' : 'fit-cover';
});

const isFocused = computed(() =>
  voiceStore.viewMode === 'fullscreen' &&
  voiceStore.fullscreenUserId === props.userState.userId &&
  voiceStore.fullscreenSource === props.source
);

const isPIPActive = computed(() =>
  voiceStore.pipActive && voiceStore.pipUserId === props.userState.userId
);

const isLocallyMuted = computed(() => voiceStore.getUserVolume(props.userState.userId) === 0);

const togglePIP = () => {
  if (isPIPActive.value) {
    voiceStore.togglePIP(null);
  } else {
    voiceStore.togglePIP(props.userState.userId, 'draggable');
  }
};

const handleContextMenu = (event: MouseEvent) => {
  contextMenuPosition.value = { x: event.clientX, y: event.clientY };
  showContextMenu.value = true;
};

// VIDEO ATTACHMENT
// Uses LiveKit's track.attach() (via the store) so adaptive streaming keeps
// working; srcObject is only a fallback for the P2P transport.

let isAttached = false;
let retryCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RETRIES = 5;

const detach = () => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (isAttached && videoElement.value) {
    voiceStore.detachVideoFromElement(props.userState.userId, videoElement.value, props.source);
    videoElement.value.srcObject = null;
    isAttached = false;
  }
  retryCount = 0;
};

const attach = () => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  // Native transport has no MediaStream in the webview — nothing to attach.
  if (isNativeVideo.value) return;

  if (!hasActiveVideo.value) {
    detach();
    return;
  }
  if (!videoElement.value) return;

  const el = videoElement.value;
  // Source-aware on both transports: LiveKit picks the publication,
  // P2P wraps the right stream's video track
  const attached = voiceStore.attachVideoToElement(props.userState.userId, el, props.source);
  if (attached) {
    isAttached = true;
    retryCount = 0;
    return;
  }

  // Track may not be published/subscribed yet - retry briefly
  if (retryCount < MAX_RETRIES) {
    retryCount++;
    retryTimer = setTimeout(attach, 150 * retryCount);
  } else {
    debug.warn(`📺 [VoiceTile] Failed to attach ${props.source} video for`, props.userState.userId);
  }
};

watch(
  [hasActiveVideo, videoElement, () => voiceStore.streamUpdateCounter],
  () => nextTick(attach),
  { immediate: true }
);

onBeforeUnmount(detach);
</script>

<style scoped>
.voice-tile {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 10px;
  overflow: hidden;
  background: var(--background-secondary);
  cursor: pointer;
  outline: 2px solid transparent;
  outline-offset: -2px;
  transition: outline-color 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}

.voice-tile.is-screen {
  background: #000;
}

.tile-native-video {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 100%;
  border: none;
  background: linear-gradient(135deg, var(--background-tertiary), var(--background-secondary));
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.85rem;
}

.tile-native-video:hover {
  color: var(--text-primary);
}

.native-video-icon {
  width: 28px;
  height: 28px;
  opacity: 0.8;
}

.native-video-hint {
  font-size: 0.72rem;
  opacity: 0.6;
}

.voice-tile.speaking {
  outline-color: #00d4aa;
}

.tile-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background: #000;
}

.tile-video.fit-cover {
  object-fit: cover;
}

.tile-video.fit-contain {
  object-fit: contain;
}

/* Avatar fallback */
.tile-avatar {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.tile-banner {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  filter: blur(18px) brightness(0.4);
  transform: scale(1.2);
  z-index: 0;
}

.tile-avatar .avatar-ring {
  position: relative;
  z-index: 1;
}

.avatar-ring {
  /* flex kills the inline-block baseline gap under the avatar, which
     otherwise makes this box taller than wide and the ring elliptical */
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  border-radius: 50%;
  padding: 4px;
  transition: box-shadow 0.15s ease;
}

.avatar-ring.speaking {
  box-shadow: 0 0 0 3px #00d4aa, 0 0 24px rgba(0, 212, 170, 0.4);
}

/* Identity pill */
.tile-pill {
  position: absolute;
  bottom: 8px;
  left: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 16px);
  padding: 4px 10px;
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(6px);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.2;
  pointer-events: none;
  z-index: 2;
}

.pill-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pill-icon {
  display: flex;
  flex-shrink: 0;
}

.pill-icon :deep(svg) {
  width: 14px;
  height: 14px;
}

.pill-icon.danger {
  color: #ed4245;
}

.pill-icon.live {
  color: #57f287;
}

.pill-live-badge {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: 4px;
  background: #ed4245;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

/* Corner badge (locally muted) */
.tile-corner-badge {
  position: absolute;
  bottom: 8px;
  right: 8px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.65);
  color: #ed4245;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}

.tile-corner-badge :deep(svg) {
  width: 13px;
  height: 13px;
}

/* Hover actions */
.tile-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 6px;
  opacity: 0;
  transition: opacity 0.15s ease;
  z-index: 3;
}

.voice-tile:hover .tile-actions,
.voice-tile:focus-within .tile-actions {
  opacity: 1;
}

.tile-action-btn {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: none;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(6px);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s ease;
}

.tile-action-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.tile-action-btn.active {
  background: var(--harmony-primary, #0ea5e9);
}

.tile-action-btn :deep(svg) {
  width: 15px;
  height: 15px;
}

/* Touch devices: hover state unavailable, keep actions visible */
@media (hover: none) {
  .tile-actions {
    opacity: 1;
  }
}
</style>
