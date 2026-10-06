<template>
  <div
    class="dock-tile"
    :class="{ 'is-screen': source === 'screen', speaking: isSpeaking }"
    role="group"
    tabindex="0"
    :aria-label="tileLabel"
    :data-user-id="userState.userId"
    :data-source="source"
    @click="emit('open')"
    @keydown.enter.self.prevent="emit('open')"
  >
    <video
      v-if="showVideo"
      ref="videoRef"
      autoplay
      playsinline
      muted
      class="dock-tile-video"
      :class="{ mirrored: isSelf && source === 'camera', contain: source === 'screen' }"
    />

    <!-- Unwatched stream: nothing is received until the listener opts in -->
    <div v-else-if="needsWatch" class="dock-tile-placeholder">
      <Avatar :src="avatarUrl" :alt="fallbackName" size="sm" class="dock-tile-avatar" />
      <button type="button" class="dock-tile-watch" @click.stop="emit('watch')">
        <Icon name="eye" :size="14" />
        <span>{{ t('voice.watchStream') }}</span>
      </button>
    </div>

    <!-- Native transport: video renders in the call window, not the webview -->
    <button v-else type="button" class="dock-tile-placeholder dock-tile-native" @click.stop="openCallWindow">
      <Icon :name="source === 'screen' ? 'screen-share' : 'video'" :size="18" />
      <span>{{ t('voice.inCallWindow') }}</span>
    </button>

    <div class="dock-tile-label">
      <Icon :name="source === 'screen' ? 'screen-share' : 'video'" :size="12" class="dock-tile-label-icon" />
      <span class="dock-tile-name">
        <DisplayName :user-id="userState.userId" :fallback="fallbackName" :truncate="true" />
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import type { UserMediaState } from '@/services/unifiedWebRTC';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { nativeLiveKit } from '@/services/nativeLiveKit';
import { useUserData } from '@/composables/useUserData';
import { debug } from '@/utils/debug';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';
import DisplayName from '@/components/DisplayName.vue';

const props = defineProps<{
  userState: UserMediaState;
  source: 'camera' | 'screen';
}>();

const emit = defineEmits<{
  (e: 'open'): void;
  (e: 'watch'): void;
}>();

const { t } = useI18n();
const voiceStore = useUnifiedVoiceChannelStore();
const { getUserAvatarUrl, getUserDisplayName } = useUserData();

const videoRef = ref<HTMLVideoElement | null>(null);

const avatarUrl = computed(() => getUserAvatarUrl(props.userState.userId).value || '/default_avatar.webp');
const fallbackName = computed(() => getUserDisplayName(props.userState.userId).value || 'User');
const tileLabel = computed(() =>
  `${fallbackName.value}, ${props.source === 'screen' ? t('voice.live') : t('voice.camera')}`
);

const isSelf = computed(() => props.userState.userId === voiceStore.localState.userId);

// Thresholds match VoiceTile: local level is raw, remote carries the transport's flag.
const isSpeaking = computed(() => {
  if (props.source !== 'camera') return false;
  if (isSelf.value) return voiceStore.localState.audioLevel > 6 && !voiceStore.localState.isMuted;
  return !!props.userState.isSpeaking;
});

const needsWatch = computed(() =>
  props.source === 'screen' && !voiceStore.isWatchingStream(props.userState.userId)
);
const isNative = computed(() => voiceStore.connectionMode === 'native');
const showVideo = computed(() => !needsWatch.value && !isNative.value);

const openCallWindow = () => {
  nativeLiveKit.openCallWindow();
};

// VIDEO ATTACHMENT
// Through the store: LiveKit track.attach() keeps adaptive stream informed of
// the element; P2P sets srcObject to a video-only MediaStream.

let attachedEl: HTMLVideoElement | null = null;
let retryCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RETRIES = 5;

const clearRetry = () => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
};

const detach = () => {
  clearRetry();
  retryCount = 0;
  if (!attachedEl) return;
  voiceStore.detachVideoFromElement(props.userState.userId, attachedEl, props.source);
  attachedEl.srcObject = null;
  attachedEl = null;
};

// P2P attach wraps the track in a new MediaStream per call; re-attaching a
// live element restarts playback and flashes.
const holdsLiveVideo = (el: HTMLVideoElement): boolean => {
  const stream = el.srcObject as MediaStream | null;
  return !!stream?.getVideoTracks?.().some(track => track.readyState === 'live');
};

const attach = () => {
  clearRetry();
  const el = videoRef.value;
  if (!el || !showVideo.value) {
    detach();
    return;
  }
  if (attachedEl && attachedEl !== el) detach();
  if (attachedEl === el && holdsLiveVideo(el)) return;

  if (voiceStore.attachVideoToElement(props.userState.userId, el, props.source)) {
    attachedEl = el;
    retryCount = 0;
    return;
  }

  // State flag can lead the track subscription.
  if (retryCount < MAX_RETRIES) {
    retryCount++;
    retryTimer = setTimeout(attach, 150 * retryCount);
  } else {
    debug.warn(`[DockVideoTile] Failed to attach ${props.source} video for`, props.userState.userId);
  }
};

watch(
  [showVideo, videoRef, () => voiceStore.streamUpdateCounter],
  () => attach(),
  { immediate: true, flush: 'post' }
);

onBeforeUnmount(detach);
</script>

<style scoped>
.dock-tile {
  position: relative;
  flex: 0 0 var(--tile-w);
  height: var(--tile-h);
  max-width: 100%;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--background-secondary);
  cursor: pointer;
  scroll-snap-align: start;
  outline: 2px solid transparent;
  outline-offset: -2px;
}

.dock-tile.is-screen {
  flex-basis: calc(var(--tile-w) * 2 + var(--tile-gap));
  background: #000;
}

.dock-tile:focus-visible {
  outline-color: var(--harmony-primary);
}

/* Above the video, which fills the tile */
.dock-tile.speaking::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 2px solid var(--success);
  border-radius: var(--radius-md);
  pointer-events: none;
  z-index: 2;
}

.dock-tile-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: #000;
}

.dock-tile-video.contain {
  object-fit: contain;
}

/* Self view reads as a mirror; the published track is not flipped. */
.dock-tile-video.mirrored {
  transform: scaleX(-1);
}

.dock-tile-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--background-tertiary);
  color: var(--text-secondary);
}

.dock-tile-native {
  border: none;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.dock-tile-native:hover {
  color: var(--text-primary);
}

.dock-tile-watch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-full);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--shadow-medium);
}

.dock-tile-watch:hover,
.dock-tile-watch:focus-visible {
  background: var(--harmony-primary-hover);
  outline: none;
}

.dock-tile-label {
  position: absolute;
  left: 6px;
  bottom: 6px;
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: calc(100% - 12px);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.3;
  pointer-events: none;
  z-index: 1;
}

.dock-tile-label-icon {
  flex-shrink: 0;
}

.dock-tile-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .dock-tile-avatar {
    display: none;
  }
}
</style>
