<template>
  <div
    class="voice-tile"
    :class="{
      speaking: isSpeaking && source === 'camera',
      'has-video': showVideo,
      'is-screen': source === 'screen',
      'needs-watch': needsWatch,
      self: isSelf,
      focused: isFocused,
    }"
    tabindex="0"
    role="group"
    :aria-label="tileLabel"
    :data-user-id="props.userState.userId"
    :data-source="source"
    @click="onTileClick"
    @dblclick="emit('request-fullscreen')"
    @contextmenu.prevent="openMenuAt($event.clientX, $event.clientY)"
    @keydown.enter.self.prevent="onTileClick"
    @keydown.shift.f10.prevent="openMenuFromKeyboard"
    @keydown.context-menu.prevent="openMenuFromKeyboard"
  >
    <!-- Video layer -->
    <video
      v-if="showVideo"
      ref="videoElement"
      autoplay
      playsinline
      :muted="isSelf"
      class="tile-video"
      :class="fitClass"
    />

    <!-- Unwatched stream: nothing is received until the listener opts in -->
    <div v-else-if="needsWatch" class="tile-watch">
      <div
        v-if="userProfile.banner_url"
        class="tile-banner"
        :style="{ backgroundImage: `url(${userProfile.banner_url})` }"
      />
      <Avatar
        :src="userProfile.avatar_url"
        :alt="displayName"
        size="lg"
        class="tile-watch-avatar"
      />
      <button type="button" class="tile-watch-btn" @click.stop="watchAndFocus">
        <Icon name="eye" :size="16" />
        <span>{{ t('voice.watchStream') }}</span>
      </button>
    </div>

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
      <span v-if="source === 'screen'" class="pill-live-badge">{{ t('voice.live') }}</span>
      <Icon v-else-if="effectiveDeafened" name="headphones-off" class="pill-icon danger" :title="t('voice.statusDeafened')" />
      <Icon v-else-if="effectiveMuted" name="mic-off" class="pill-icon danger" :title="t('voice.statusMuted')" />
      <span class="pill-name">
        <DisplayName :user-id="props.userState.userId" :fallback="displayName" :truncate="true" />
      </span>
      <Icon
        v-if="showQualityWarning"
        name="wifi-off"
        class="pill-icon warn"
        :title="t(`voice.quality.${quality}`)"
      />
    </div>

    <!-- Muted for this listener -->
    <div
      v-if="locallyMuted"
      class="tile-corner-badge"
      :title="source === 'screen' ? t('voice.streamMutedByYou') : t('voice.mutedByYou')"
    >
      <Icon name="volume-x" />
    </div>

    <!-- Hover controls: listener volume -->
    <div v-if="volumeKind" class="tile-bottom-actions" @click.stop @dblclick.stop>
      <TileVolumeControl :user-id="props.userState.userId" :kind="volumeKind" />
    </div>

    <!-- Hover controls: view -->
    <div class="tile-actions" @click.stop @dblclick.stop>
      <button
        v-if="source === 'screen' && canStopWatching"
        class="tile-action-btn"
        :title="t('voice.stopWatching')"
        :aria-label="t('voice.stopWatching')"
        @click="voiceStore.stopWatchingStream(props.userState.userId)"
      >
        <Icon name="eye-off" />
      </button>
      <button
        v-if="source === 'screen' && showVideo"
        class="tile-action-btn"
        :class="{ active: isPIPActive }"
        :title="isPIPActive ? t('voice.closePopOut') : t('voice.popOut')"
        :aria-label="isPIPActive ? t('voice.closePopOut') : t('voice.popOut')"
        @click="togglePIP"
      >
        <Icon name="picture-in-picture" />
      </button>
      <button
        v-if="showVideo"
        class="tile-action-btn"
        :title="t('voice.fullScreen')"
        :aria-label="t('voice.fullScreen')"
        @click="emit('request-fullscreen')"
      >
        <Icon name="maximize" />
      </button>
      <button
        class="tile-action-btn"
        :title="isFocused ? t('voice.exitFocus') : t('voice.focus')"
        :aria-label="isFocused ? t('voice.exitFocus') : t('voice.focus')"
        @click="emit('expand')"
      >
        <Icon :name="isFocused ? 'minimize-2' : 'maximize-2'" />
      </button>
      <button
        ref="moreButton"
        class="tile-action-btn"
        :title="t('voice.moreOptions')"
        :aria-label="t('voice.moreOptions')"
        aria-haspopup="menu"
        :aria-expanded="showContextMenu"
        @click="openMenuFromButton"
      >
        <Icon name="more-horizontal" />
      </button>
    </div>

    <!-- Context menu -->
    <VoiceUserContextMenu
      :user-state="props.userState"
      :x="contextMenuPosition.x"
      :y="contextMenuPosition.y"
      :visible="showContextMenu"
      :source="source"
      can-fullscreen
      @close="closeMenu"
      @request-fullscreen="emit('request-fullscreen')"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { debug } from '@/utils/debug';
import type { UserMediaState } from '@/services/unifiedWebRTC';
import type { RemoteAudioKind } from '@/services/voice/remoteAudioMixer';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useUserData } from '@/composables/useUserData';
import DisplayName from '@/components/DisplayName.vue';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';
import VoiceUserContextMenu from './VoiceUserContextMenu.vue';
import TileVolumeControl from './TileVolumeControl.vue';
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

const { t } = useI18n();
const voiceStore = useUnifiedVoiceChannelStore();
const { getUserProfile } = useUserData();

const videoElement = ref<HTMLVideoElement | null>(null);
const moreButton = ref<HTMLButtonElement | null>(null);
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

const tileLabel = computed(() =>
  props.source === 'screen' ? `${displayName.value}, ${t('voice.live')}` : displayName.value
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
    return liveState.value.audioLevel > 6 && !effectiveMuted.value;
  }
  return liveState.value.isSpeaking;
});

const hasActiveVideo = computed(() =>
  props.source === 'screen' ? liveState.value.isScreenSharing : liveState.value.isVideoEnabled
);

const watching = computed(() => voiceStore.isWatchingStream(props.userState.userId));

// A remote stream shows video only while watched (LiveKit opt-in).
const needsWatch = computed(() => props.source === 'screen' && hasActiveVideo.value && !watching.value);
const showVideo = computed(() => hasActiveVideo.value && !needsWatch.value);
const canStopWatching = computed(() =>
  !isSelf.value && voiceStore.connectionMode === 'livekit' && watching.value
);

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

const quality = computed(() => voiceStore.getConnectionQuality(props.userState.userId));
const showQualityWarning = computed(() => quality.value === 'poor' || quality.value === 'lost');

// Listener volume on hover: mic on the camera tile, stream audio on a watched stream.
const volumeKind = computed<RemoteAudioKind | null>(() => {
  if (isSelf.value) return null;
  if (props.source === 'screen') return showVideo.value ? 'screen' : null;
  return 'mic';
});

const locallyMuted = computed(() => {
  if (isSelf.value) return false;
  const kind: RemoteAudioKind = props.source === 'screen' ? 'screen' : 'mic';
  if (kind === 'screen' && !showVideo.value) return false;
  const volume = kind === 'mic'
    ? voiceStore.getUserVolume(props.userState.userId)
    : voiceStore.getUserScreenShareVolume(props.userState.userId);
  return voiceStore.isUserLocallyMuted(props.userState.userId, kind) || volume === 0;
});

const togglePIP = () => {
  if (isPIPActive.value) {
    voiceStore.togglePIP(null);
  } else {
    voiceStore.togglePIP(props.userState.userId, 'draggable');
  }
};

const watchAndFocus = () => {
  voiceStore.watchStream(props.userState.userId);
  if (!isFocused.value) emit('expand');
};

const onTileClick = () => {
  if (needsWatch.value) {
    watchAndFocus();
    return;
  }
  emit('expand');
};

const openMenuAt = (x: number, y: number) => {
  contextMenuPosition.value = { x, y };
  showContextMenu.value = true;
};

const openMenuFromButton = () => {
  if (showContextMenu.value) {
    showContextMenu.value = false;
    return;
  }
  const rect = moreButton.value?.getBoundingClientRect();
  if (!rect) return;
  openMenuAt(rect.left, rect.bottom + 4);
};

const openMenuFromKeyboard = (event: KeyboardEvent) => {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  openMenuAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
};

const closeMenu = () => {
  showContextMenu.value = false;
};

// VIDEO ATTACHMENT
// Uses LiveKit's track.attach() (via the store) so adaptive streaming keeps
// working; srcObject is only a fallback for the P2P transport.

let attachedEl: HTMLVideoElement | null = null;
let retryCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RETRIES = 5;

const detach = () => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  // The element may already be unmounted; LiveKit still holds it until detached.
  if (attachedEl) {
    voiceStore.detachVideoFromElement(props.userState.userId, attachedEl, props.source);
    attachedEl.srcObject = null;
    attachedEl = null;
  }
  retryCount = 0;
};

const attach = () => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  if (!showVideo.value || !videoElement.value) {
    detach();
    return;
  }

  const el = videoElement.value;
  if (attachedEl && attachedEl !== el) detach();
  // Source-aware on both transports: LiveKit picks the publication,
  // P2P wraps the right stream's video track
  const attached = voiceStore.attachVideoToElement(props.userState.userId, el, props.source);
  if (attached) {
    attachedEl = el;
    retryCount = 0;
    return;
  }

  // Track may not be published/subscribed yet - retry briefly
  if (retryCount < MAX_RETRIES) {
    retryCount++;
    retryTimer = setTimeout(attach, 150 * retryCount);
  } else {
    debug.warn(`[VoiceTile] Failed to attach ${props.source} video for`, props.userState.userId);
  }
};

watch(
  [showVideo, videoElement, () => voiceStore.streamUpdateCounter],
  () => nextTick(attach),
  { immediate: true }
);

onBeforeUnmount(detach);
</script>

<style scoped>
.voice-tile {
  position: relative;
  container-type: size;
  width: 100%;
  height: 100%;
  border-radius: var(--radius-md);
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

.voice-tile.speaking {
  outline-color: var(--success);
}

/* above the banner/video which fill the tile */
.voice-tile.speaking::after {
  content: '';
  position: absolute;
  inset: 0;
  border: 2px solid var(--success);
  border-radius: var(--radius-md);
  pointer-events: none;
  z-index: 3;
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
  box-shadow: 0 0 0 3px var(--success);
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
  border-radius: var(--radius-full);
  background: rgba(0, 0, 0, 0.65);
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
  color: var(--error);
}

.pill-icon.live {
  color: var(--success);
}

.pill-live-badge {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  background: var(--error);
  color: var(--text-on-primary);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
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
  color: var(--error);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
  transition: opacity 0.15s ease;
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
  border-radius: var(--radius-md);
  border: none;
  background: rgba(0, 0, 0, 0.65);
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
  background: var(--harmony-primary);
}

.tile-action-btn :deep(svg) {
  width: 15px;
  height: 15px;
}

/* Listener volume, bottom-right */
.tile-bottom-actions {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 3;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.voice-tile:hover .tile-bottom-actions,
.voice-tile:focus-within .tile-bottom-actions {
  opacity: 1;
}

/* The volume control shows the mute state while visible. */
.voice-tile:hover .tile-corner-badge,
.voice-tile:focus-within .tile-corner-badge {
  opacity: 0;
}

.voice-tile:focus-visible {
  outline-color: var(--harmony-primary);
}

.pill-icon.warn {
  color: var(--warning);
}

/* Unwatched stream */
.tile-watch {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  overflow: hidden;
  background: var(--background-tertiary);
}

.tile-watch .tile-banner {
  z-index: 0;
}

.tile-watch-avatar,
.tile-watch-btn {
  position: relative;
  z-index: 1;
}

.tile-watch-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border: none;
  border-radius: var(--radius-full);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--shadow-medium);
  transition: background-color 0.15s ease, transform 0.15s ease;
}

.tile-watch-btn:hover,
.tile-watch-btn:focus-visible {
  background: var(--harmony-primary-hover);
  outline: none;
}

.voice-tile:hover .tile-watch-btn {
  transform: scale(1.04);
}

/* Small tiles (filmstrip) show the button without the avatar. */
@container (max-height: 140px) {
  .tile-watch-avatar { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .voice-tile,
  .tile-actions,
  .tile-bottom-actions,
  .tile-watch-btn,
  .avatar-ring {
    transition: none;
  }
  .voice-tile:hover .tile-watch-btn {
    transform: none;
  }
}

:root[data-reduce-motion="true"] .voice-tile:hover .tile-watch-btn {
  transform: none;
}

/* Touch devices: hover state unavailable, keep actions visible */
@media (hover: none) {
  .tile-actions,
  .tile-bottom-actions {
    opacity: 1;
  }
  .tile-corner-badge {
    display: none;
  }
}
</style>
