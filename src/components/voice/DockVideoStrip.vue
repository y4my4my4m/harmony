<template>
  <Transition name="dock-strip" mode="out-in">
    <section
      v-if="tiles.length > 0 && !collapsed && !hidden"
      key="strip"
      ref="stripRef"
      class="dock-video-strip"
      :aria-label="onVideoLabel"
      data-block-sidebar-gestures
    >
      <header class="strip-header">
        <span class="strip-count">
          <Icon name="video" :size="14" />
          <span>{{ onVideoLabel }}</span>
        </span>
        <div class="strip-actions">
          <button
            v-if="popOutTarget"
            type="button"
            class="strip-btn strip-popout"
            :class="{ active: isPoppedOut }"
            :title="isPoppedOut ? t('voice.closePopOut') : t('voice.popOut')"
            :aria-label="isPoppedOut ? t('voice.closePopOut') : t('voice.popOut')"
            :aria-pressed="isPoppedOut"
            @click="togglePopOut"
          >
            <Icon name="picture-in-picture" :size="14" />
          </button>
          <button
            type="button"
            class="strip-btn strip-collapse"
            :title="t('voice.hideVideo')"
            :aria-label="t('voice.hideVideo')"
            aria-expanded="true"
            @click="emit('update:collapsed', true)"
          >
            <Icon name="chevron-down" :size="14" />
          </button>
        </div>
      </header>
      <div class="strip-row" @wheel="onWheel">
        <DockVideoTile
          v-for="(tile, i) in tiles"
          :key="tile.id"
          :user-state="tile.userState"
          :source="tile.source"
          :style="{ width: `${layout.widths[i]}px`, height: `${layout.height}px` }"
          @aspect="setAspect(tile.id, $event)"
          @open="emit('open', tile.userState.userId, tile.source)"
          @watch="voiceStore.watchStream(tile.userState.userId)"
        />
      </div>
    </section>

    <button
      v-else-if="tiles.length > 0 && !hidden"
      key="expand"
      type="button"
      class="strip-expand"
      :title="t('voice.showVideo')"
      :aria-label="t('voice.showVideo')"
      aria-expanded="false"
      @click="emit('update:collapsed', false)"
    >
      <Icon name="chevron-up" :size="14" />
      <span>{{ onVideoLabel }}</span>
    </button>
  </Transition>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import Icon from '@/components/common/Icon.vue';
import { useViewport } from '@/composables/useViewport';
import DockVideoTile from './DockVideoTile.vue';
import { layoutDockVideoTiles } from './dockVideoLayout';
import type { DockVideoSource, DockVideoTileModel } from './useDockVideoStrip';

const props = defineProps<{
  tiles: DockVideoTileModel[];
  /** Persisted preference: only the expand button renders. */
  collapsed: boolean;
  /** Transient: nothing renders, e.g. while the mobile keyboard is open. */
  hidden: boolean;
}>();

const emit = defineEmits<{
  (e: 'open', userId: string, source: DockVideoSource): void;
  (e: 'update:collapsed', value: boolean): void;
}>();

const { t } = useI18n();
const voiceStore = useUnifiedVoiceChannelStore();

const onVideoCount = computed(() => new Set(props.tiles.map(tile => tile.userState.userId)).size);
const onVideoLabel = computed(() => t('voice.onVideo', { n: onVideoCount.value }));

// POP-OUT
// The PiP frame renders screen shares only. Target: the stream already popped
// out, else the stream focused in the overlay, else the first received stream.

const popOutTarget = computed<DockVideoTileModel | null>(() => {
  const streams = props.tiles.filter(
    tile => tile.source === 'screen' && voiceStore.isWatchingStream(tile.userState.userId)
  );
  if (streams.length === 0) return null;
  const byUser = (userId: string | null) => streams.find(tile => tile.userState.userId === userId);
  const popped = voiceStore.pipActive ? byUser(voiceStore.pipUserId) : undefined;
  const focused = voiceStore.viewMode === 'fullscreen' && voiceStore.fullscreenSource === 'screen'
    ? byUser(voiceStore.fullscreenUserId)
    : undefined;
  return popped ?? focused ?? streams[0];
});

const isPoppedOut = computed(() =>
  !!popOutTarget.value && voiceStore.pipActive && voiceStore.pipUserId === popOutTarget.value.userState.userId
);

const togglePopOut = () => {
  if (!popOutTarget.value) return;
  voiceStore.togglePIP(popOutTarget.value.userState.userId, 'draggable');
};

// TILE GEOMETRY
// Tiles take their video's aspect at a shared row height; see dockVideoLayout.
// The strip hugs its tiles, so the available width is that of its parent.

const { isMobileViewport, viewportHeight } = useViewport();

// Row height caps, px. A screen share in the row raises the cap; text stays legible.
const MAX_H_CAMERA = { desktop: 140, mobile: 96 };
const MAX_H_SCREEN = { desktop: 260, mobile: 160 };
const MIN_H = { desktop: 72, mobile: 56 };
const MIN_TILE_W = { desktop: 72, mobile: 56 };
const TILE_GAP = 8;
// Fraction of the viewport height the row may take.
const MAX_H_VIEWPORT_FRACTION = 0.3;

const aspects = reactive<Record<string, number | null>>({});
const setAspect = (id: string, aspect: number | null) => {
  aspects[id] = aspect;
};

watch(
  () => props.tiles.map(tile => tile.id),
  ids => {
    for (const id of Object.keys(aspects)) {
      if (!ids.includes(id)) delete aspects[id];
    }
  }
);

const stripRef = ref<HTMLElement | null>(null);
const availableWidth = ref(0);

const measure = () => {
  const strip = stripRef.value;
  const parent = strip?.parentElement;
  if (!strip || !parent) return;
  const cs = getComputedStyle(strip);
  const px = (v: string) => parseFloat(v) || 0;
  const chrome = px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
  availableWidth.value = Math.max(0, parent.clientWidth - chrome);
};

// Absent in test DOMs; the layout then uses the height cap alone.
let observer: ResizeObserver | null = null;
watch(stripRef, strip => {
  observer?.disconnect();
  observer = null;
  if (!strip?.parentElement || typeof ResizeObserver === 'undefined') return;
  observer = new ResizeObserver(measure);
  observer.observe(strip.parentElement);
  measure();
}, { flush: 'post' });

onBeforeUnmount(() => observer?.disconnect());

const layout = computed(() => {
  const form = isMobileViewport.value ? 'mobile' : 'desktop';
  const hasScreen = props.tiles.some(tile => tile.source === 'screen');
  const cap = (hasScreen ? MAX_H_SCREEN : MAX_H_CAMERA)[form];
  const maxHeight = Math.min(cap, Math.max(MIN_H[form], viewportHeight.value * MAX_H_VIEWPORT_FRACTION));
  return layoutDockVideoTiles({
    containerWidth: availableWidth.value,
    aspects: props.tiles.map(tile => aspects[tile.id]),
    maxHeight,
    minHeight: MIN_H[form],
    gap: TILE_GAP,
    minTileWidth: MIN_TILE_W[form],
  });
});

// Vertical wheel scrolls the row; trackpads already send deltaX.
const onWheel = (e: WheelEvent) => {
  const row = e.currentTarget as HTMLElement;
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || row.scrollWidth <= row.clientWidth) return;
  row.scrollLeft += e.deltaY;
  e.preventDefault();
};
</script>

<style scoped>
.dock-video-strip {
  --tile-gap: 8px;
  width: fit-content;
  min-width: min(220px, 100%);
  max-width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background: var(--background-floating);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-large);
}

.strip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 2px;
}

.strip-count {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.strip-actions {
  display: flex;
  gap: 4px;
}

.strip-btn {
  width: 26px;
  height: 26px;
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.strip-btn:hover,
.strip-btn:focus-visible {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.strip-btn.active {
  background: var(--harmony-primary);
  color: var(--text-on-primary);
}

.strip-row {
  display: flex;
  gap: var(--tile-gap);
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scroll-snap-type: x proximity;
  scrollbar-width: thin;
  scrollbar-color: var(--background-quaternary) transparent;
}

/* Centered when the row fits; auto margins never clip an overflowing start. */
.strip-row > :first-child {
  margin-left: auto;
}

.strip-row > :last-child {
  margin-right: auto;
}

.strip-expand {
  align-self: flex-end;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: var(--background-floating);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--shadow-medium);
  transition: background-color 0.15s ease, color 0.15s ease;
}

.strip-expand:hover,
.strip-expand:focus-visible {
  color: var(--text-primary);
  background: color-mix(in srgb, var(--background-floating) 92%, var(--text-primary));
}

.dock-strip-enter-active,
.dock-strip-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.dock-strip-enter-from,
.dock-strip-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (prefers-reduced-motion: reduce) {
  .dock-strip-enter-active,
  .dock-strip-leave-active,
  .strip-btn,
  .strip-expand {
    transition: none;
  }
}

:root[data-reduce-motion="true"] .dock-strip-enter-active,
:root[data-reduce-motion="true"] .dock-strip-leave-active {
  transition: none;
}
</style>
