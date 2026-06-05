<template>
  <div class="inline-gif-picker">
    <div v-if="isLoading && items.length === 0" class="inline-gif-loading">
      <LoadingSpinner :size="20" />
    </div>
    <div v-else-if="items.length === 0 && query" class="inline-gif-empty">
      No GIFs found
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
          @click="$emit('selectGif', withGifMessageUrl(item))"
          @mouseover="hoveredGif = item.id"
          @mouseleave="hoveredGif = null"
        >
          <img 
            :src="inlineGifSrc(item)" 
            :alt="item.title || 'GIF'"
            loading="lazy"
          >
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import GifAdSlot from '@/components/GifAdSlot.vue';
import { gifProvider, type GifMediaType } from '@/services/gifProviderService';
import { stripKlipyAttributionFragment, withGifMessageUrl } from '@/utils/klipyAttribution';
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

.inline-gif-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
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
