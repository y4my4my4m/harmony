<template>
  <div ref="pickerRef" class="inline-gif-picker">
    <div v-if="isLoading && items.length === 0" class="inline-gif-loading">
      <LoadingSpinner :size="20" />
    </div>
    <EmptyState
      v-else-if="items.length === 0 && query"
      size="sm"
      icon="search"
      :title="$t('gif.noneFound', { kind: mediaNoun })"
    />
    <div
      v-else
      ref="gridRef"
      class="inline-gif-grid"
      :class="{ docked: dockActive }"
      data-testid="inline-gif-grid"
      role="group"
      :aria-label="$t('gif.results', { kind: mediaNoun })"
      v-bind="dock.stripListeners"
      @wheel="onGridWheel"
      @keydown="onGridKeydown"
    >
      <template v-for="item in items" :key="item.id">
        <GifAdSlot
          v-if="item.kind === 'ad'"
          :data-dock-item="item.id"
          layout="inline"
          :content="item.content"
          :width="item.width"
          :height="item.height"
        />
        <div
          v-else
          class="inline-gif-item"
          :data-dock-item="item.id"
          @mouseover="hoveredGif = item.id"
          @mouseleave="isClips ? handleClipItemLeave(item.id, $event) : (hoveredGif = null)"
        >
          <button
            type="button"
            class="inline-gif-pick"
            :data-gif-tile="item.id"
            :aria-label="isClips ? item.title || $t('gif.clip') : undefined"
            @click="$emit('selectGif', withGifMessageUrl(item, kind))"
          >
            <video
              v-if="isClips"
              :src="stripFragment(item.media_formats.mp4.url)"
              :poster="stripFragment(item.media_formats.gifpreview.url)"
              class="inline-gif-media"
              muted
              loop
              playsinline
              preload="metadata"
              @mouseenter="(e) => playPreview(e)"
              @mouseleave="(e) => pausePreview(e)"
            ></video>
            <img
              v-else
              :src="inlineGifSrc(item)"
              :alt="item.title || 'GIF'"
              loading="lazy"
              draggable="false"
            >
          </button>
          <button
            v-if="isClips"
            type="button"
            class="clip-audio-button"
            :class="{ visible: hoveredGif === item.id || isMobile || audioClipId === item.id }"
            :title="audioClipId === item.id ? $t('gif.clipMute') : $t('gif.clipUnmute')"
            @click.stop="(e) => toggleClipAudio(item.id, e)"
          >
            <svg v-if="audioClipId === item.id" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
            <svg v-else viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
          </button>
        </div>
      </template>
      <!-- Required KLIPY attribution -->
      <a
        class="inline-gif-attribution"
        data-dock-item="attribution"
        href="https://klipy.com"
        target="_blank"
        rel="noopener noreferrer nofollow"
        @click.stop="activateStoppedLink"
        title="Powered by KLIPY"
      >KLIPY</a>
    </div>
    <InlineGifDock
      :strip="gridRef"
      :bounds="pickerRef"
      :items="dockItems"
      :state="dock.state.value"
      :tile-listeners="dock.tileListeners"
      @select="selectById"
      @wheel="onGridWheel"
      @active="onDockActive"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue';
import { useLayoutState } from '@/composables/useLayoutState';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import GifAdSlot from '@/components/GifAdSlot.vue';
import InlineGifDock, { type DockMedia } from '@/components/InlineGifDock.vue';
import { useGifDock } from '@/composables/useGifDock';
import { useRovingTabindex } from '@/composables/useRovingTabindex';
import { gifProvider, type GifMediaType } from '@/services/gifProviderService';
import { debug } from '@/utils/debug';
import { horizontalWheelDelta } from '@/utils/wheelToHorizontal';
import { activateStoppedLink } from '@/services/outsideLinks';
import {
  stripKlipyAttributionFragment,
  withGifMessageUrl,
  mediaTypeToKind,
} from '@/utils/klipyAttribution';
import type { Gif, GifResultItem } from '@/types';

interface Props {
  query: string;
  mediaType?: GifMediaType;
}

const props = withDefaults(defineProps<Props>(), {
  mediaType: 'gifs',
});

const emit = defineEmits<{
  (e: 'selectGif', gif: Gif): void;
  /** Keyboard focus leaves the results for the composer (Escape, or Down from the strip). */
  (e: 'exit'): void;
}>();

const { isMobile } = useLayoutState();

const items = ref<GifResultItem[]>([]);
const hoveredGif = ref<string | null>(null);
const gridRef = ref<HTMLElement | null>(null);
// True while the magnification covers the strip; the strip's own tiles are hidden under it.
const dockActive = ref(false);
const kind = computed(() => mediaTypeToKind(props.mediaType));
const isClips = computed(() => props.mediaType === 'clips');
const mediaNoun = computed(() => {
  switch (props.mediaType) {
    case 'stickers': return 'stickers';
    case 'clips': return 'clips';
    case 'memes': return 'memes';
    case 'ai-emojis': return 'AI emoji';
    default: return 'GIFs';
  }
});

const stripFragment = (url: string) => stripKlipyAttributionFragment(url);

// Also bound to the magnified tiles, which sit over the strip.
const onGridWheel = (event: WheelEvent) => {
  const grid = gridRef.value;
  if (!grid) return;
  const px = horizontalWheelDelta(event, grid);
  if (px === null) return;
  grid.scrollLeft += px;
  event.preventDefault();
};

// The clip currently previewing with audio (toggled via the mute/unmute icon).
const audioClipId = ref<string | null>(null);
let audioClipEl: HTMLVideoElement | null = null;

const resetClipAudio = () => {
  if (audioClipEl) {
    audioClipEl.muted = true;
    audioClipEl.pause?.();
    audioClipEl.currentTime = 0;
  }
  audioClipEl = null;
  audioClipId.value = null;
};

const playPreview = (e: Event) => {
  const v = e.target as HTMLVideoElement;
  if (v === audioClipEl || dockActive.value) return;
  v.muted = true;
  v.play?.().catch(() => {});
};
const pausePreview = (e: Event) => {
  const v = e.target as HTMLVideoElement;
  if (v === audioClipEl) {
    resetClipAudio();
    return;
  }
  v.pause?.();
  v.currentTime = 0;
};

const handleClipItemLeave = (itemId: string, e: MouseEvent) => {
  hoveredGif.value = null;
  if (audioClipId.value === itemId) {
    resetClipAudio();
    return;
  }
  const v = (e.currentTarget as HTMLElement).querySelector('video');
  if (v) {
    v.pause?.();
    v.currentTime = 0;
  }
};

// Tap the mute/unmute icon to play a clip with sound (tap again to mute).
const toggleClipAudio = (itemId: string, e: Event) => {
  e.stopPropagation();
  const btn = e.currentTarget as HTMLElement;
  const v = btn.closest('.inline-gif-item')?.querySelector('video') as HTMLVideoElement | null;
  if (!v) return;
  if (audioClipId.value === itemId) {
    resetClipAudio();
    return;
  }
  if (audioClipEl && audioClipEl !== v) {
    audioClipEl.muted = true;
    audioClipEl.pause?.();
    audioClipEl.currentTime = 0;
  }
  v.muted = false;
  v.volume = 1;
  v.play?.().catch(() => {});
  audioClipEl = v;
  audioClipId.value = itemId;
};

const isLoading = ref(false);
const pickerRef = ref<HTMLElement | null>(null);

// The strip shows thumbnails; a result's full rendition loads in the magnification, for the one in focus.
const inlineGifSrc = (item: Gif) => stripKlipyAttributionFragment(item.media_formats.gifpreview.url);

const dockItems = computed<DockMedia[]>(() => [
  ...items.value.map((item): DockMedia =>
    item.kind === 'ad'
      ? { id: item.id, kind: 'ad' }
      : {
          id: item.id,
          kind: 'gif',
          thumb: stripKlipyAttributionFragment(item.media_formats.gifpreview.url),
          full: stripKlipyAttributionFragment(isClips.value ? item.media_formats.mp4.url : item.media_formats.gif.url),
          video: isClips.value,
        },
  ),
  { id: 'attribution', kind: 'attribution' },
]);

const dock = useGifDock({
  hovering: () => !!gridRef.value?.matches(':hover') || !!document.querySelector('[data-dock-tile]:hover'),
  keyboardTile: () => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || !gridRef.value?.contains(el) || !el.matches(':focus-visible')) return null;
    return el.getAttribute('data-gif-tile');
  },
});

// Clips in the strip stop while the magnification plays the one in focus.
const onDockActive = (active: boolean) => {
  dockActive.value = active;
  if (!active) return;
  resetClipAudio();
  gridRef.value?.querySelectorAll('video').forEach((v) => {
    v.pause?.();
    v.currentTime = 0;
  });
};

const selectById = (id: string) => {
  const item = items.value.find((i) => i.kind !== 'ad' && i.id === id);
  if (item && item.kind !== 'ad') emit('selectGif', withGifMessageUrl(item, kind.value));
};

const roving = useRovingTabindex(gridRef, {
  itemSelector: '[data-gif-tile]',
  orientation: 'horizontal',
  loop: false,
  onActivate: (el) => el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }),
});

const leaveResults = () => {
  dock.collapse();
  emit('exit');
};

const onGridKeydown = (event: KeyboardEvent) => {
  if (event.defaultPrevented) return;
  const onTile = (event.target as HTMLElement | null)?.hasAttribute?.('data-gif-tile');
  if (event.key === 'Escape' || (onTile && event.key === 'ArrowDown')) {
    event.preventDefault();
    event.stopPropagation();
    leaveResults();
    return;
  }
  // Up has nowhere to go from the strip; it scrolls nothing either.
  if (onTile && event.key === 'ArrowUp') {
    event.preventDefault();
    return;
  }
  roving.onKeydown(event);
};

/** Moves keyboard focus to the strip's Tab stop. False when there are no results. */
const focusResults = () => {
  const list = roving.items();
  if (list.length === 0) return false;
  const stop = list.findIndex((el) => el.getAttribute('tabindex') === '0');
  roving.focusItem(stop < 0 ? 0 : stop);
  return list.includes(document.activeElement as HTMLElement);
};

defineExpose({ focusResults });
const adSlotWidth = ref<number | undefined>();
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
let currentRequestId = 0;
let resizeObserver: ResizeObserver | null = null;

const measureAdSlot = () => {
  adSlotWidth.value = pickerRef.value?.clientWidth || undefined;
};

const fetchOpts = () => ({
  perPage: 20,
  adSlotWidth: props.mediaType === 'gifs' ? adSlotWidth.value : undefined,
});

const applyFeed = (feed: Awaited<ReturnType<typeof gifProvider.trending>>) => {
  items.value = feed.items;
  if (
    props.mediaType === 'gifs' &&
    feed.meta?.showAds &&
    !feed.items.some((i) => i.kind === 'ad')
  ) {
    debug.log(
      'Inline GIF feed: ads enabled but Klipy returned no ad slots. ' +
        'Klipy only fills ads on mobile browsers (not desktop).',
    );
  }
};

const fetchTrending = async () => {
  const requestId = ++currentRequestId;
  isLoading.value = true;
  try {
    const feed = await gifProvider.trending(fetchOpts(), props.mediaType);
    if (requestId !== currentRequestId) return;
    applyFeed(feed);
  } finally {
    if (requestId === currentRequestId) isLoading.value = false;
  }
};

const searchGifs = async (q: string) => {
  if (!q.trim()) {
    await fetchTrending();
    return;
  }
  const requestId = ++currentRequestId;
  isLoading.value = true;
  try {
    const feed = await gifProvider.search(q, fetchOpts(), props.mediaType);
    if (requestId !== currentRequestId) return;
    applyFeed(feed);
  } finally {
    if (requestId === currentRequestId) isLoading.value = false;
  }
};

watch(() => props.query, (q) => {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => searchGifs(q), 300);
});

onMounted(() => {
  measureAdSlot();
  if (typeof ResizeObserver !== 'undefined' && pickerRef.value) {
    resizeObserver = new ResizeObserver(measureAdSlot);
    resizeObserver.observe(pickerRef.value);
  }
  if (props.query) {
    searchGifs(props.query);
  } else {
    fetchTrending();
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<style scoped>
.inline-gif-picker {
  max-height: 250px;
  overflow-y: auto;
  overflow-x: hidden;
  border-top-left-radius: 8px;
  border-top-right-radius: 8px;
  background: var(--background-quaternary);
  border-bottom: none;
  scrollbar-gutter: stable;
}

/* Horizontal strip: [gif][gif][ wider ad ][gif]… */
.inline-gif-grid {
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
  padding: 6px;
  overflow-x: auto;
  overflow-y: hidden;
}

.inline-gif-item {
  position: relative;
  cursor: pointer;
  border-radius: 4px;
  overflow: hidden;
  flex: 0 0 88px;
  width: 88px;
  height: 88px;
  transition: filter 0.12s ease;
}

/* Clip audio toggle - bottom-right, fades in on hover; forced visible on
   mobile and while this clip is the active audio one. */
.clip-audio-button {
  position: absolute;
  bottom: 4px;
  right: 4px;
  width: 22px;
  height: 22px;
  background: rgba(0, 0, 0, 0.6);
  border: none;
  padding: 0;
  border-radius: 50%;
  cursor: pointer;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease;
  z-index: 2;
}

.clip-audio-button.visible {
  opacity: 1;
}

.clip-audio-button:hover {
  background: rgba(0, 0, 0, 0.85);
}

.inline-gif-item:hover {
  filter: brightness(1.1);
}

.inline-gif-grid.docked > * {
  opacity: 0;
}

.inline-gif-pick {
  display: block;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: inherit;
  background: none;
  color: inherit;
  cursor: pointer;
  -webkit-touch-callout: none;
  user-select: none;
}

.inline-gif-pick:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}

.inline-gif-item img,
.inline-gif-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  background: #000;
}

/* Required KLIPY attribution, sits as a subtle tile at the end of the strip. */
.inline-gif-attribution {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 88px;
  width: 88px;
  height: 88px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  background: var(--background-senary-alpha);
  text-decoration: none;
  transition: color 0.15s ease, background 0.15s ease;
}

.inline-gif-attribution:hover {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.inline-gif-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}


.inline-gif-picker::-webkit-scrollbar {
  width: 6px;
}

.inline-gif-picker::-webkit-scrollbar-track {
  background: transparent;
}

.inline-gif-picker::-webkit-scrollbar-thumb {
  background: var(--background-senary-alpha, rgba(10, 11, 13, 0.5));
  border-radius: 3px;
}
</style>
