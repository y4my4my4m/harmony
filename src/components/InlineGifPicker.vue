<template>
  <div class="inline-gif-picker">
    <div v-if="isLoading && gifs.length === 0" class="inline-gif-loading">
      <div class="loading-spinner"></div>
    </div>
    <div v-else-if="gifs.length === 0 && query" class="inline-gif-empty">
      No GIFs found
    </div>
    <div v-else class="inline-gif-grid">
      <div 
        v-for="gif in gifs" 
        :key="gif.id" 
        class="inline-gif-item"
        @click="$emit('selectGif', gif)"
        @mouseover="hoveredGif = gif.id"
        @mouseleave="hoveredGif = null"
      >
        <img 
          :src="hoveredGif === gif.id ? gif.media_formats.gif.url : gif.media_formats.gifpreview.url" 
          :alt="gif.title || 'GIF'"
          loading="lazy"
        >
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import type { Gif } from '@/types';

interface Props {
  query: string;
}

const props = defineProps<Props>();

defineEmits<{
  (e: 'selectGif', gif: Gif): void;
}>();

const gifs = ref<Gif[]>([]);
const hoveredGif = ref<string | null>(null);
const isLoading = ref(false);
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
let currentRequestId = 0;

const fetchTrending = async () => {
  const requestId = ++currentRequestId;
  isLoading.value = true;
  try {
    const response = await fetch(
      `https://tenor.googleapis.com/v2/featured?key=${import.meta.env.VITE_TENOR_API_KEY}&limit=20`
    );
    if (!response.ok || requestId !== currentRequestId) return;
    const data = await response.json();
    gifs.value = data.results;
  } catch { /* ignore */ } finally {
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
    const response = await fetch(
      `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&key=${import.meta.env.VITE_TENOR_API_KEY}&limit=20`
    );
    if (!response.ok || requestId !== currentRequestId) return;
    const data = await response.json();
    gifs.value = data.results;
  } catch { /* ignore */ } finally {
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

.loading-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-color, #0EA5E9);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
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
