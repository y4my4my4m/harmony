<template>
  <div class="inline-gif-picker">
    <div v-if="isLoading && items.length === 0" class="inline-gif-loading">
      <LoadingSpinner :size="20" />
    </div>
    <div v-else-if="items.length === 0 && query" class="inline-gif-empty">
      No {{ mediaNoun }} found
    </div>
    <div v-else class="inline-gif-grid">
      <template v-for="item in items" :key="item.id">
        <GifAdSlot
          v-if="item.kind === 'ad'"
          class="inline-gif-ad"
          :content="item.content"
          :width="item.width"
          :height="item.height"
        />
        <div 
          v-else
          class="inline-gif-item"
          @click="$emit('selectGif', withGifMessageUrl(item, kind))"
          @mouseover="hoveredGif = item.id"
          @mouseleave="hoveredGif = null"
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
            :title="$t('gif.clipAudioHint')"
            @mouseenter="(e) => playPreview(e)"
            @mouseleave="(e) => pausePreview(e)"
            @contextmenu="toggleClipAudio"
          ></video>
          <img 
            v-else
            :src="inlineGifSrc(item)" 
            :alt="item.title || 'GIF'"
            loading="lazy"
          >
        </div>
      </template>
      <!-- Required KLIPY attribution -->
      <a
        class="inline-gif-attribution"
        href="https://klipy.com"
        target="_blank"
        rel="noopener noreferrer nofollow"
        @click.stop
        title="Powered by KLIPY"
      >KLIPY</a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import GifAdSlot from '@/components/GifAdSlot.vue';
import { gifProvider, type GifMediaType } from '@/services/gifProviderService';
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

defineEmits<{
  (e: 'selectGif', gif: Gif): void;
}>();

const items = ref<GifResultItem[]>([]);
const hoveredGif = ref<string | null>(null);
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

// The clip video currently previewing with audio (via right-click).
const audioClipEl = ref<HTMLVideoElement | null>(null);

const playPreview = (e: Event) => {
  const v = e.target as HTMLVideoElement;
  if (v === audioClipEl.value) return;
  v.muted = true;
  v.play?.().catch(() => {});
};
const pausePreview = (e: Event) => {
  const v = e.target as HTMLVideoElement;
  if (v === audioClipEl.value) return;
  v.pause?.();
  if (v) v.currentTime = 0;
};

// Right-click a clip to preview with sound (again to mute/stop).
const toggleClipAudio = (e: Event) => {
  e.preventDefault();
  const v = e.currentTarget as HTMLVideoElement;
  if (!v) return;
  if (audioClipEl.value === v) {
    v.muted = true;
    v.pause?.();
    v.currentTime = 0;
    audioClipEl.value = null;
    return;
  }
  const prev = audioClipEl.value;
  if (prev && prev !== v) {
    prev.muted = true;
    prev.pause?.();
    prev.currentTime = 0;
  }
  v.muted = false;
  v.volume = 1;
  v.play?.().catch(() => {});
  audioClipEl.value = v;
};

const inlineGifSrc = (item: Gif) => {
  const url =
    hoveredGif.value === item.id
      ? item.media_formats.gif.url
      : item.media_formats.gifpreview.url;
  return stripKlipyAttributionFragment(url);
};
const isLoading = ref(false);
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
let currentRequestId = 0;

const fetchTrending = async () => {
  const requestId = ++currentRequestId;
  isLoading.value = true;
  try {
    const feed = await gifProvider.trending({ perPage: 20 }, props.mediaType);
    if (requestId !== currentRequestId) return;
    items.value = feed.items;
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
    const feed = await gifProvider.search(q, { perPage: 20 }, props.mediaType);
    if (requestId !== currentRequestId) return;
    items.value = feed.items;
  } finally {
    if (requestId === currentRequestId) isLoading.value = false;
  }
};

watch(() => props.query, (q) => {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => searchGifs(q), 300);
});

onMounted(() => {
  if (props.query) {
    searchGifs(props.query);
  } else {
    fetchTrending();
  }
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

.inline-gif-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 4px;
  padding: 6px;
}

.inline-gif-item {
  cursor: pointer;
  border-radius: 4px;
  overflow: hidden;
  aspect-ratio: 1;
  transition: transform 0.12s ease;
}

.inline-gif-item:hover {
  transform: scale(1.05);
  z-index: 1;
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
  aspect-ratio: 1;
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


.inline-gif-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
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
