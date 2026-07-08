<template>
  <Teleport to="body">
    <!-- Background blur -->
    <div class="overlay-backdrop" :class="{ 'overlay-entering': isEntering, 'overlay-leaving': isLeaving }"></div>
    <div
      v-if="voiceStore.isOverlayVisible"
      class="voice-overlay"
      :class="{ 'overlay-entering': isEntering, 'overlay-leaving': isLeaving }"
      @click.self="handleBackdropClick"
    >
      <!-- Main container -->
      <div
        ref="containerEl"
        class="voice-container"
        :class="{
          'native-fullscreen': isNativeFullscreen,
          'controls-hidden': isNativeFullscreen && !controlsVisible,
          'rainbow-party': easterEggState.isActive && easterEggState.type === 'rainbow-party',
          'screen-shake': easterEggState.isActive && easterEggState.type === 'rainbow-party',
        }"
        @mousemove="pokeControls"
      >
        <!-- Header -->
        <div class="voice-header">
          <div class="channel-info">
            <div class="channel-icon">
              <Icon name="volume" />
            </div>
            <div class="channel-details">
              <h2 class="channel-name">
                <DisplayName v-if="voiceStore.dmOtherUserId" :user-id="voiceStore.dmOtherUserId" :fallback="props.channelName" />
                <template v-else>{{ props.channelName }}</template>
              </h2>
              <p class="participant-count">
                {{ connectionStats.total }} participant{{ connectionStats.total !== 1 ? 's' : '' }}
                <span v-if="connectionStats.speaking > 0" class="speaking-count">
                  • {{ connectionStats.speaking }} speaking
                </span>
              </p>
            </div>
          </div>

          <div class="header-controls">
            <VoiceEncryptionBadge
              v-if="voiceStore.connectionMode"
              class="overlay-encryption-badge"
              :encrypted="voiceStore.isEncrypted"
              size="md"
              show-label
            />
            <div class="connection-mode-indicator" :class="voiceStore.connectionMode || 'unknown'">
              <Icon :name="voiceStore.connectionMode === 'livekit' ? 'server' : 'users'" />
              <span>{{ voiceStore.connectionMode === 'livekit' ? 'SFU' : 'P2P' }}</span>
            </div>

            <button
              @click="toggleSpatialPanel"
              class="layout-btn spatial-btn"
              :class="{
                active: spatialStore.isPanelVisible,
                'spatial-enabled': spatialStore.settings.enabled
              }"
              :title="spatialStore.settings.enabled ? 'Spatial Audio: ON' : 'Spatial Audio: OFF'"
            >
              <Icon name="audio-lines" />
            </button>
            <button
              @click="toggleSettings"
              class="layout-btn"
              :class="{ active: showSettings }"
              title="Voice Settings"
            >
              <Icon name="settings" />
            </button>
            <button
              @click="toggleNativeFullscreen"
              class="layout-btn"
              :class="{ active: isNativeFullscreen }"
              :title="isNativeFullscreen ? 'Exit fullscreen' : 'Fullscreen'"
            >
              <Icon :name="isNativeFullscreen ? 'minimize' : 'maximize'" />
            </button>
            <button @click="minimizeOverlay" class="minimize-btn" title="Minimize">
              <Icon name="minimize-2" />
            </button>
            <button @click="closeOverlay" class="close-btn" title="Close">
              <Icon name="x" />
            </button>
          </div>
        </div>

        <!-- Stage -->
        <div
          class="stage"
          :class="{ 'full-window-mode': isFullWindowActive }"
          @click="isFullWindowActive && voiceStore.toggleFullWindowMode()"
        >
          <!-- Grid view -->
          <div v-if="!focusedTile" ref="gridEl" class="tile-grid">
            <VoiceTile
              v-for="tile in tiles"
              :key="tile.id"
              :user-state="tile.userState"
              :source="tile.source"
              class="grid-tile"
              :style="tileStyle"
              @expand="focusTile(tile)"
              @request-fullscreen="fullscreenTile(tile)"
            />
          </div>

          <!-- Focus view -->
          <template v-else>
            <div class="focus-area">
              <VoiceTile
                :key="focusedTile.id"
                :user-state="focusedTile.userState"
                :source="focusedTile.source"
                fit="contain"
                class="focus-tile"
                @expand="unfocus"
                @request-fullscreen="toggleNativeFullscreen"
              />
            </div>

            <div v-if="filmstripTiles.length > 0" class="filmstrip-container" @click.stop>
              <button
                class="filmstrip-collapse-btn"
                @click="isFilmstripCollapsed = !isFilmstripCollapsed"
                :title="isFilmstripCollapsed ? 'Show participants' : 'Hide participants'"
              >
                <Icon :name="isFilmstripCollapsed ? 'chevron-up' : 'chevron-down'" />
              </button>
              <div v-if="!isFilmstripCollapsed" class="filmstrip">
                <VoiceTile
                  v-for="tile in filmstripTiles"
                  :key="tile.id"
                  :user-state="tile.userState"
                  :source="tile.source"
                  class="filmstrip-tile"
                  @expand="focusTile(tile)"
                  @request-fullscreen="fullscreenTile(tile)"
                />
              </div>
            </div>
          </template>
        </div>

        <!-- Bottom Controls -->
        <div class="voice-controls">
          <div class="media-controls">
            <!-- Microphone with device selector -->
            <div class="control-group">
              <button
                @click="voiceStore.toggleMute"
                class="control-button"
                :class="{
                  active: !voiceStore.localState.isMuted && (!isPTTMode || isPTTActive),
                  muted: voiceStore.localState.isMuted,
                  'ptt-mode': isPTTMode,
                  'ptt-active': isPTTActive && !voiceStore.localState.isMuted
                }"
                :title="voiceStore.localState.isMuted
                  ? 'Unmute (M)'
                  : isPTTMode
                    ? (isPTTActive ? `Transmitting (${pttKeyDisplay})` : `Push ${pttKeyDisplay} to talk — click to mute`)
                    : 'Mute (M)'"
              >
                <Icon :name="voiceStore.localState.isMuted ? 'mic-off' : 'mic'" />
                <span v-if="isPTTMode && !voiceStore.localState.isMuted" class="ptt-badge" :class="{ active: isPTTActive }">PTT</span>
              </button>
              <DeviceSelector type="input" @open-settings="showSettings = true" />
            </div>

            <!-- Speakers with device selector -->
            <div class="control-group">
              <button
                @click="voiceStore.toggleDeafen"
                class="control-button"
                :class="{
                  active: !voiceStore.localState.isDeafened,
                  deafened: voiceStore.localState.isDeafened
                }"
                :title="voiceStore.localState.isDeafened ? 'Undeafen' : 'Deafen'"
              >
                <Icon :name="voiceStore.localState.isDeafened ? 'headphones-off' : 'headphones'" />
              </button>
              <DeviceSelector type="output" @open-settings="showSettings = true" />
            </div>

            <!-- Camera with device selector (independent of screenshare) -->
            <div class="control-group">
              <button
                @click="voiceStore.toggleVideo"
                class="control-button"
                :class="{ active: voiceStore.localState.isVideoEnabled }"
                :title="voiceStore.localState.isVideoEnabled ? 'Turn off camera' : 'Turn on camera'"
              >
                <Icon :name="voiceStore.localState.isVideoEnabled ? 'video' : 'video-off'" />
              </button>
              <DeviceSelector type="video" @open-settings="showSettings = true" />
            </div>

            <button
              @click="voiceStore.toggleScreenShare"
              class="control-button"
              :class="{ streaming: voiceStore.localState.isScreenSharing }"
              :title="voiceStore.localState.isScreenSharing ? 'Stop screen share' : 'Share screen'"
            >
              <Icon name="screen-share" />
            </button>
          </div>

          <div class="action-controls">
            <button @click="leaveChannel" class="leave-button" title="Leave channel">
              <Icon name="phone-off" />
              <span>Leave</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Voice Settings Panel - Teleported separately for proper z-index -->
    <Teleport to="body">
      <div
        v-if="showSettings"
        class="settings-overlay-wrapper"
        @click.self="showSettings = false"
      >
        <VoiceSettingsPanel
          @close="showSettings = false"
          @update-settings="handleSettingsUpdate"
        />
      </div>
    </Teleport>

    <!-- Spatial Audio Panel -->
    <SpatialAudioPanel :is-under-overlay="true" />

    <!-- Confetti Effect -->
    <ConfettiEffect :is-active="easterEggState.isActive && easterEggState.type === 'rainbow-party'" />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useSpatialAudioStore } from '@/stores/spatialAudio';
import { useKeybinds } from '@/composables/useKeybinds';
import { debug } from '@/utils/debug';
import { useKonamiCode } from '@/composables/useKonamiCode';
import { easterEggService, type EasterEggState } from '@/services/EasterEggService';
import { useAuthStore } from '@/stores/auth';
import type { UserMediaState } from '@/services/unifiedWebRTC';
import VoiceTile from './VoiceTile.vue';
import VoiceSettingsPanel from './VoiceSettingsPanel.vue';
import SpatialAudioPanel from './SpatialAudioPanel.vue';
import DeviceSelector from './DeviceSelector.vue';
import VoiceEncryptionBadge from './VoiceEncryptionBadge.vue';
import ConfettiEffect from '../easteregg/ConfettiEffect.vue';
import Icon from '@/components/common/Icon.vue';
import DisplayName from '@/components/DisplayName.vue';

// Centralized keybind system
const keybinds = useKeybinds();
const isPTTMode = keybinds.isPTTMode;
const isPTTActive = keybinds.isPTTActive;
const pttKeyDisplay = computed(() => keybinds.getKeybindDisplay('push-to-talk'));

interface Props {
  channelName?: string;
}

const props = withDefaults(defineProps<Props>(), {
  channelName: 'Voice Channel',
});

interface Emits {
  (e: 'close'): void;
  (e: 'minimize'): void;
}

const emit = defineEmits<Emits>();

const voiceStore = useUnifiedVoiceChannelStore();
const spatialStore = useSpatialAudioStore();
const authStore = useAuthStore();
const isEntering = ref(false);
const isLeaving = ref(false);
const showSettings = ref(false);
const isFilmstripCollapsed = ref(false);

const containerEl = ref<HTMLElement | null>(null);
const gridEl = ref<HTMLElement | null>(null);

// Easter egg state
const easterEggState = ref<EasterEggState>({
  isActive: false,
  type: null,
  activatedBy: null,
  activatedAt: null,
});

// TILE MODEL
// Every participant gets a camera tile (video or avatar); screensharers get
// an additional dedicated screen tile, exactly like Discord's stream tiles.

interface VoiceTileModel {
  id: string;
  userState: UserMediaState;
  source: 'camera' | 'screen';
}

const tiles = computed<VoiceTileModel[]>(() => {
  const screenTiles: VoiceTileModel[] = [];
  const cameraTiles: VoiceTileModel[] = [];

  for (const p of voiceStore.allParticipants) {
    if (p.isScreenSharing) {
      screenTiles.push({ id: `${p.userId}:screen`, userState: p, source: 'screen' });
    }
    cameraTiles.push({ id: `${p.userId}:camera`, userState: p, source: 'camera' });
  }

  // Streams first: they're what watch parties are there for
  return [...screenTiles, ...cameraTiles];
});

const focusedTile = computed<VoiceTileModel | null>(() => {
  if (voiceStore.viewMode !== 'fullscreen' || !voiceStore.fullscreenUserId) return null;
  const id = `${voiceStore.fullscreenUserId}:${voiceStore.fullscreenSource}`;
  return tiles.value.find(t => t.id === id) || null;
});

const filmstripTiles = computed(() =>
  focusedTile.value ? tiles.value.filter(t => t.id !== focusedTile.value!.id) : []
);

const connectionStats = computed(() => voiceStore.connectionStats);

// FOCUS / FULLSCREEN

const focusTile = (tile: VoiceTileModel) => {
  if (focusedTile.value?.id === tile.id) {
    unfocus();
  } else {
    voiceStore.enterFullscreen(tile.userState.userId, tile.source);
  }
};

const unfocus = () => {
  voiceStore.exitFullscreen();
};

const fullscreenTile = (tile: VoiceTileModel) => {
  voiceStore.enterFullscreen(tile.userState.userId, tile.source);
  if (!isNativeFullscreen.value) {
    void toggleNativeFullscreen();
  }
};

// Exit focus when the focused feed disappears (user left, stream stopped).
// A camera tile without live video is still a valid focus target (avatar),
// so only a missing tile forces the exit.
watch(
  [tiles, () => voiceStore.fullscreenUserId],
  () => {
    if (voiceStore.viewMode !== 'fullscreen' || !voiceStore.fullscreenUserId) return;
    if (!focusedTile.value) {
      debug.log('[Focus] Focused tile gone, exiting focus view');
      voiceStore.exitFullscreen();
    }
  },
  { deep: true }
);

// Auto-focus a newly started remote screenshare when nothing is focused yet
const knownScreenTileIds = ref<Set<string>>(new Set());
watch(
  () => tiles.value.filter(t => t.source === 'screen').map(t => t.id),
  (ids) => {
    const previous = knownScreenTileIds.value;
    const fresh = ids.filter(id => !previous.has(id));
    knownScreenTileIds.value = new Set(ids);

    if (fresh.length === 0 || voiceStore.viewMode === 'fullscreen') return;
    const newTile = tiles.value.find(
      t => t.id === fresh[0] && t.userState.userId !== voiceStore.localState.userId
    );
    if (newTile) {
      debug.log('[Focus] Auto-focusing new remote screenshare:', newTile.id);
      voiceStore.enterFullscreen(newTile.userState.userId, 'screen');
    }
  },
  { immediate: true }
);

// NATIVE FULLSCREEN

const isNativeFullscreen = ref(false);

const toggleNativeFullscreen = async () => {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (containerEl.value) {
      await containerEl.value.requestFullscreen();
    }
  } catch (error) {
    debug.warn('[Fullscreen] Native fullscreen request failed:', error);
  }
};

// Esc both exits browser fullscreen and triggers our exit-fullscreen keybind;
// remember when native fullscreen ended so the keybind doesn't also drop focus
let lastNativeFullscreenExit = 0;

const onFullscreenChange = () => {
  const wasFullscreen = isNativeFullscreen.value;
  isNativeFullscreen.value = document.fullscreenElement === containerEl.value;
  if (isNativeFullscreen.value) {
    pokeControls();
  } else {
    if (wasFullscreen) {
      lastNativeFullscreenExit = Date.now();
    }
    controlsVisible.value = true;
    if (controlsHideTimer) clearTimeout(controlsHideTimer);
  }
};

// Auto-hide chrome while in native fullscreen (Discord-style)
const controlsVisible = ref(true);
let controlsHideTimer: ReturnType<typeof setTimeout> | null = null;

const pokeControls = () => {
  if (!isNativeFullscreen.value) return;
  controlsVisible.value = true;
  if (controlsHideTimer) clearTimeout(controlsHideTimer);
  controlsHideTimer = setTimeout(() => {
    controlsVisible.value = false;
  }, 2500);
};

// Legacy "full window" mode (still reachable from the user context menu):
// the focused tile covers the viewport without the browser fullscreen API
const isFullWindowActive = computed(() => voiceStore.isFullWindowMode && !!focusedTile.value);

// ADAPTIVE GRID
// Best-fit solver: pick the column count that maximizes 16:9 tile size
// within the observed stage dimensions.

const stageSize = ref({ width: 0, height: 0 });
let resizeObserver: ResizeObserver | null = null;

watch(gridEl, (el) => {
  resizeObserver?.disconnect();
  if (el) {
    resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) {
        stageSize.value = { width: rect.width, height: rect.height };
      }
    });
    resizeObserver.observe(el);
    const rect = el.getBoundingClientRect();
    stageSize.value = { width: rect.width, height: rect.height };
  }
});

const GRID_GAP = 8;
const TILE_ASPECT = 16 / 9;

const tileStyle = computed(() => {
  const { width, height } = stageSize.value;
  const count = tiles.value.length;
  if (!width || !height || count === 0) {
    return { width: '320px', height: '180px' };
  }

  let best = { w: 0, h: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    let w = (width - GRID_GAP * (cols - 1)) / cols;
    let h = w / TILE_ASPECT;
    const maxH = (height - GRID_GAP * (rows - 1)) / rows;
    if (h > maxH) {
      h = maxH;
      w = h * TILE_ASPECT;
    }
    if (w > best.w) {
      best = { w, h };
    }
  }

  return {
    width: `${Math.max(Math.floor(best.w), 120)}px`,
    height: `${Math.max(Math.floor(best.h), 68)}px`,
  };
});

// METHODS

const handleBackdropClick = () => {
  minimizeOverlay();
};

const minimizeOverlay = () => {
  isLeaving.value = true;
  setTimeout(() => {
    voiceStore.toggleOverlay();
    isLeaving.value = false;
    emit('minimize');
  }, 300);
};

const closeOverlay = () => {
  minimizeOverlay();
};

const leaveChannel = async () => {
  const success = await voiceStore.leaveVoiceChannel();
  if (success) {
    emit('close');
  }
};

const toggleSettings = () => {
  showSettings.value = !showSettings.value;
};

const handleSettingsUpdate = (event: { type: string; value: any }) => {
  switch (event.type) {
    case 'streamQuality':
      voiceStore.updateStreamQuality(event.value);
      break;
    case 'saveAll':
      if (event.value.videoQuality || event.value.frameRate || event.value.audioBitrate) {
        const qualityToResolution: Record<string, number> = {
          '360p': 360,
          '480p': 480,
          '720p': 720,
          '1080p': 1080,
          'source': -1,
        };
        voiceStore.updateStreamQuality({
          resolution: qualityToResolution[event.value.videoQuality] ?? 720,
          frameRate: parseInt(event.value.frameRate) || 30,
          audioBitrate: parseInt(event.value.audioBitrate) || 128
        });
      }
      break;
    // Other event types can be handled here if needed
  }
};

const toggleSpatialPanel = () => {
  spatialStore.togglePanel();
};

// LIFECYCLE

// Konami code and easter egg
const konamiEnabled = ref(true)
let konamiDetector: ReturnType<typeof useKonamiCode> | null = null

const handleKonamiActivate = () => {
  // Don't activate if konami is disabled or game is already active
  if (!konamiEnabled.value || easterEggState.value.isActive) {
    return
  }

  const currentUserId = voiceStore.localState.userId || authStore.session?.user?.id
  if (!currentUserId) {
    debug.warn('[Konami] No user ID available')
    return
  }

  debug.log('[Konami] Activating rainbow party!')
  konamiEnabled.value = false // Disable konami code detection

  if (konamiDetector) {
    konamiDetector.reset()
  }

  easterEggService.activate('rainbow-party', currentUserId)

  // Auto-deactivate after confetti duration (10 seconds default)
  setTimeout(() => {
    easterEggService.deactivate()
  }, 10000)
}

watch(() => easterEggState.value.isActive, (isActive) => {
  if (!isActive && easterEggState.value.type === 'rainbow-party') {
    konamiEnabled.value = true // Re-enable konami code detection
    // Reset the existing konami detector (don't recreate - composables must be called at top level)
    if (konamiDetector) {
      konamiDetector.reset()
    }
    debug.log('[Konami] Rainbow party closed, re-enabling konami code detection')
  }
})

const initializeEasterEgg = () => {
  const channelId = voiceStore.currentChannelId || voiceStore.optimisticChannelId
  if (channelId) {
    const currentUserId = voiceStore.localState.userId || authStore.session?.user?.id
    if (currentUserId) {
      easterEggService.initialize(channelId, currentUserId)

      if (!easterEggState.value.activatedBy) {
        easterEggService.subscribe((state) => {
          easterEggState.value = state
        })
      }
    }
  }
}

watch(
  () => voiceStore.currentChannelId || voiceStore.optimisticChannelId,
  () => {
    initializeEasterEgg()
  },
  { immediate: true }
)

// Konami code detector
konamiDetector = useKonamiCode(handleKonamiActivate)

onMounted(() => {
  isEntering.value = true;
  setTimeout(() => {
    isEntering.value = false;
  }, 300);

  document.addEventListener('fullscreenchange', onFullscreenChange);

  // Activate voice-overlay context for keybinds
  keybinds.activateContext('voice-overlay');

  // Register keybind handlers
  keybinds.registerHandler('toggle-mute', () => voiceStore.toggleMute());
  keybinds.registerHandler('toggle-deafen', () => voiceStore.toggleDeafen());
  keybinds.registerHandler('toggle-camera', () => voiceStore.toggleVideo());
  keybinds.registerHandler('toggle-screenshare', () => voiceStore.toggleScreenShare());
  keybinds.registerHandler('toggle-voice-settings', () => toggleSettings());
  keybinds.registerHandler('exit-fullscreen', () => {
    // Priority order: native fullscreen > full window > focus > settings > minimize
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (Date.now() - lastNativeFullscreenExit < 300) {
      // Browser already consumed this Esc to leave native fullscreen
    } else if (voiceStore.isFullWindowMode) {
      voiceStore.toggleFullWindowMode();
    } else if (voiceStore.viewMode === 'fullscreen') {
      voiceStore.exitFullscreen();
    } else if (showSettings.value) {
      showSettings.value = false;
    } else {
      minimizeOverlay();
    }
  });
});

onUnmounted(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  resizeObserver?.disconnect();
  if (controlsHideTimer) clearTimeout(controlsHideTimer);

  // Deactivate context and unregister handlers
  keybinds.deactivateContext('voice-overlay');
  keybinds.unregisterHandler('toggle-mute');
  keybinds.unregisterHandler('toggle-deafen');
  keybinds.unregisterHandler('toggle-camera');
  keybinds.unregisterHandler('toggle-screenshare');
  keybinds.unregisterHandler('toggle-voice-settings');
  keybinds.unregisterHandler('exit-fullscreen');

  easterEggService.cleanup();
});
</script>

<style scoped>
.voice-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  animation: overlay-enter 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.voice-overlay.overlay-leaving {
  animation: overlay-leave 0.3s cubic-bezier(0.55, 0.06, 0.68, 0.19);
}

.overlay-backdrop {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  backdrop-filter: blur(10px);
  transition: all 0.3s ease;
  opacity: 1;
}
.overlay-backdrop.overlay-entering {
  opacity: 1;
}
.overlay-backdrop.overlay-leaving {
  opacity: 0;
}

.voice-container {
  position: relative;
  background: linear-gradient(145deg, color-mix(in srgb, var(--background-tertiary) 60%, #000), color-mix(in srgb, var(--background-secondary) 55%, #000));
  backdrop-filter: blur(20px);
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow:
    0 20px 60px rgba(0, 0, 0, 0.6),
    0 8px 32px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  width: 100%;
  height: 100%;
  max-width: 1600px;
  max-height: 94vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 10000;
}

/* Native fullscreen: stage is everything, chrome floats over it */
.voice-container.native-fullscreen {
  max-width: none;
  max-height: none;
  border-radius: 0;
  border: none;
  background: #000;
}

.voice-container.native-fullscreen .voice-header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 20;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.75), transparent);
  border-bottom: none;
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.voice-container.native-fullscreen .voice-controls {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 20;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.75), transparent);
  border-top: none;
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.voice-container.native-fullscreen.controls-hidden .voice-header {
  opacity: 0;
  transform: translateY(-12px);
  pointer-events: none;
}

.voice-container.native-fullscreen.controls-hidden .voice-controls {
  opacity: 0;
  transform: translateY(12px);
  pointer-events: none;
}

.voice-container.native-fullscreen.controls-hidden {
  cursor: none;
}

/* Header */
.voice-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.connection-mode-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.connection-mode-indicator.livekit {
  background: rgba(87, 242, 135, 0.15);
  color: #57f287;
  border: 1px solid rgba(87, 242, 135, 0.3);
}

.connection-mode-indicator.p2p {
  background: rgba(14, 165, 233, 0.15);
  color: #0EA5E9;
  border: 1px solid rgba(14, 165, 233, 0.3);
}

.connection-mode-indicator.unknown {
  background: rgba(255, 255, 255, 0.1);
  color: #b9bbbe;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.connection-mode-indicator :deep(span) {
  display: flex;
}

.connection-mode-indicator :deep(svg) {
  width: 12px;
  height: 12px;
}

.channel-info {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.channel-icon {
  width: 36px;
  height: 36px;
  background: linear-gradient(145deg, #0EA5E9, #0284C7);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
  font-size: 16px;
  flex-shrink: 0;
}

.channel-name {
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 2px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.participant-count {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
}

.speaking-count {
  color: #00d4aa;
  font-weight: 600;
}

.header-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.layout-btn,
.minimize-btn,
.close-btn {
  width: 36px;
  height: 36px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}

.layout-btn:hover,
.minimize-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
  border-color: rgba(255, 255, 255, 0.3);
}

.layout-btn.active {
  background: linear-gradient(145deg, #0EA5E9, #0284C7);
  color: var(--text-primary);
  border-color: rgba(14, 165, 233, 0.6);
}

.spatial-btn.spatial-enabled {
  background: linear-gradient(145deg, #00d4aa, #00b894);
  color: var(--text-primary);
  border-color: rgba(0, 212, 170, 0.6);
  box-shadow: 0 0 12px rgba(0, 212, 170, 0.4);
}

.spatial-btn.spatial-enabled:hover {
  background: linear-gradient(145deg, #00e5b8, #00c9a0);
}

.close-btn:hover {
  background: #ed4245;
  color: var(--text-primary);
  border-color: #ed4245;
}

/* Stage */
.stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px;
  background: color-mix(in srgb, #000 35%, transparent);
}

.voice-container.native-fullscreen .stage {
  padding: 0;
  background: #000;
}

/* Grid view: best-fit sized tiles, centered */
.tile-grid {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  align-content: center;
  justify-content: center;
}

.grid-tile {
  flex: 0 0 auto;
}

/* Focus view */
.focus-area {
  flex: 1;
  min-height: 0;
  display: flex;
}

.focus-tile {
  flex: 1;
  min-height: 0;
}

.filmstrip-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  padding-top: 4px;
}

.filmstrip-collapse-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 18px;
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px 4px 0 0;
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  transition: all 0.2s ease;
  margin-bottom: 4px;
}

.filmstrip-collapse-btn:hover {
  background: rgba(0, 0, 0, 0.7);
  color: var(--text-primary);
}

.filmstrip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  max-width: 100%;
  padding: 2px;
  flex-shrink: 0;
}

.filmstrip-tile {
  flex: 0 0 auto;
  width: 178px;
  height: 100px;
}

/* Legacy full-window mode (context menu): focused tile covers the viewport */
.stage.full-window-mode {
  position: fixed;
  inset: 0;
  z-index: 10002;
  padding: 0;
  background: #000;
  cursor: pointer;
}

.stage.full-window-mode .focus-tile {
  border-radius: 0;
}

.stage.full-window-mode .filmstrip-container {
  display: none;
}

/* Voice Controls */
.voice-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.media-controls {
  display: flex;
  gap: 12px;
}

.control-group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.control-button {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.2);
  background: rgba(0, 0, 0, 0.3);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  backdrop-filter: blur(10px);
}

.control-button:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
  border-color: rgba(255, 255, 255, 0.4);
  transform: scale(1.05);
}

.control-button.active {
  background: linear-gradient(145deg, #00d4aa, #00b894);
  color: var(--text-primary);
  border-color: rgba(0, 212, 170, 0.6);
  box-shadow: 0 4px 16px rgba(0, 212, 170, 0.3);
}

.control-button.muted {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: var(--text-primary);
  border-color: rgba(237, 66, 69, 0.6);
  box-shadow: 0 4px 16px rgba(237, 66, 69, 0.3);
}

/* Active screenshare: red like Discord's stop-streaming affordance */
.control-button.streaming {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: var(--text-primary);
  border-color: rgba(237, 66, 69, 0.6);
  box-shadow: 0 4px 16px rgba(237, 66, 69, 0.3);
}

/* PTT Mode Styles */
.control-button.ptt-mode {
  position: relative;
}

.control-button.ptt-active {
  background: linear-gradient(145deg, #00d4aa, #00b894) !important;
  color: var(--text-primary) !important;
  border-color: rgba(0, 212, 170, 0.6) !important;
  box-shadow: 0 4px 16px rgba(0, 212, 170, 0.4), 0 0 20px rgba(0, 212, 170, 0.3) !important;
  animation: ptt-transmit 0.5s ease-in-out infinite;
}

@keyframes ptt-transmit {
  0%, 100% {
    box-shadow: 0 4px 16px rgba(0, 212, 170, 0.4), 0 0 20px rgba(0, 212, 170, 0.3);
  }
  50% {
    box-shadow: 0 4px 20px rgba(0, 212, 170, 0.6), 0 0 30px rgba(0, 212, 170, 0.4);
  }
}

.ptt-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  font-size: 9px;
  font-weight: 700;
  padding: 2px 5px;
  background: rgba(0, 0, 0, 0.7);
  color: #888;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.ptt-badge.active {
  background: #00d4aa;
  color: var(--text-primary);
}

.control-button.deafened {
  background: linear-gradient(145deg, #faa61a, #e67e22);
  color: var(--text-primary);
  border-color: rgba(250, 166, 26, 0.6);
  box-shadow: 0 4px 16px rgba(250, 166, 26, 0.3);
}

.leave-button {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: var(--text-primary);
  border: none;
  border-radius: 25px;
  padding: 12px 24px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
  box-shadow: 0 4px 16px rgba(237, 66, 69, 0.3);
}

.leave-button:hover {
  background: linear-gradient(145deg, #c73e1d, #a0281a);
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(237, 66, 69, 0.4);
}

/* Animations */
@keyframes overlay-enter {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes overlay-leave {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.95);
  }
}

/* ============================================
   MOBILE RESPONSIVE STYLES
   ============================================ */

/* Tablet landscape */
@media (max-width: 768px) {
  .voice-overlay {
    padding: 8px;
    padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
  }

  .voice-container {
    max-width: 100%;
    max-height: 100%;
    border-radius: 12px;
  }

  .voice-header {
    padding: 10px 12px;
    gap: 8px;
  }

  .channel-icon {
    width: 32px;
    height: 32px;
    font-size: 14px;
  }

  .channel-name {
    font-size: 15px;
  }

  .participant-count {
    font-size: 12px;
  }

  /* Hide connection mode text on tablet */
  .connection-mode-indicator span {
    display: none;
  }

  .connection-mode-indicator {
    padding: 6px;
  }

  .header-controls {
    gap: 6px;
  }

  .layout-btn,
  .minimize-btn,
  .close-btn {
    width: 36px;
    height: 36px;
    font-size: 14px;
  }

  .voice-controls {
    padding: 10px 12px;
    padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
    flex-wrap: wrap;
    gap: 12px;
  }

  .media-controls {
    gap: 8px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .leave-button {
    padding: 10px 20px;
    font-size: 13px;
  }

  .filmstrip-tile {
    width: 142px;
    height: 80px;
  }
}

/* Mobile portrait */
@media (max-width: 480px) {
  .voice-overlay {
    padding: 0;
    align-items: stretch;
  }

  .voice-container {
    border-radius: 0;
    max-height: 100vh;
    height: 100%;
  }

  .voice-header {
    padding: 10px 12px;
  }

  .speaking-count {
    display: none;
  }

  /* Native fullscreen adds little on small phones; keep minimize/close only */
  .minimize-btn {
    display: none;
  }

  .stage {
    padding: 4px;
  }

  /* Voice controls - bottom sheet style */
  .voice-controls {
    padding: 12px;
    padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    flex-direction: column;
    gap: 12px;
  }

  .media-controls {
    width: 100%;
    justify-content: center;
    gap: 10px;
  }

  .control-group {
    flex-direction: column;
    gap: 2px;
  }

  .control-button {
    width: 52px;
    height: 52px;
    font-size: 20px;
  }

  .action-controls {
    width: 100%;
  }

  .leave-button {
    width: 100%;
    justify-content: center;
    padding: 14px 24px;
    font-size: 14px;
    border-radius: 12px;
  }

  .ptt-badge {
    font-size: 8px;
    padding: 1px 4px;
  }

  .filmstrip-tile {
    width: 106px;
    height: 60px;
  }
}

/* Settings Panel Wrapper - Ensures proper z-index layering */
.settings-overlay-wrapper {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10001; /* Higher than voice overlay (9999) */
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
}

/* Override the VoiceSettingsPanel styles when inside our wrapper */
.settings-overlay-wrapper :deep(.settings-overlay) {
  position: static;
  width: auto;
  height: auto;
  background: transparent;
  backdrop-filter: none;
  z-index: auto;
}

/* Mobile settings wrapper */
@media (max-width: 480px) {
  .settings-overlay-wrapper {
    padding: 0;
    align-items: stretch;
  }

  .settings-overlay-wrapper :deep(.settings-panel) {
    width: 100%;
    max-width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
  }
}

/* ============================================
   EASTER EGG: RAINBOW PARTY MODE
   ============================================ */

.voice-container.rainbow-party {
  animation: rainbow-border 3s linear infinite;
  box-shadow:
    0 20px 60px rgba(0, 0, 0, 0.6),
    0 8px 32px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.1),
    0 0 40px rgba(255, 0, 150, 0.5);
}

.voice-container.rainbow-party .grid-tile {
  animation: rainbow-glow 2s ease-in-out infinite;
}

.voice-container.screen-shake {
  animation: screen-shake 0.5s ease-in-out;
  animation-fill-mode: forwards;
}

@keyframes rainbow-border {
  0% { border-color: #ff6b6b; }
  14% { border-color: #4ecdc4; }
  28% { border-color: #45b7d1; }
  42% { border-color: #f9ca24; }
  57% { border-color: #f0932b; }
  71% { border-color: #eb4d4b; }
  85% { border-color: #6c5ce7; }
  100% { border-color: #a29bfe; }
}

@keyframes rainbow-glow {
  0%, 100% {
    filter: brightness(1) saturate(1);
    transform: scale(1);
  }
  50% {
    filter: brightness(1.2) saturate(1.3);
    transform: scale(1.02);
  }
}

@keyframes screen-shake {
  0%, 100% { transform: translate(0, 0); }
  10% { transform: translate(-2px, -2px); }
  20% { transform: translate(2px, 2px); }
  30% { transform: translate(-2px, 2px); }
  40% { transform: translate(2px, -2px); }
  50% { transform: translate(-1px, -1px); }
  60% { transform: translate(1px, 1px); }
  70% { transform: translate(-1px, 1px); }
  80% { transform: translate(1px, -1px); }
  90% { transform: translate(0, 0); }
}
</style>
