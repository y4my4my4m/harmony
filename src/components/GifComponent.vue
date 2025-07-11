<template>
  <div class="gif-popup" ref="gifPopup" :style="positionStyle">
    <div class="gif-search">
      <input 
        type="text" 
        v-model="searchQuery" 
        placeholder="Search GIFs..." 
        class="search-input"
        ref="searchInput"
      >
    </div>
    <div class="gif-results">
      <masonry-wall :items="gifs" :column-width="150" :gap="10">
        <template #default="{ item }">
          <div :key="item.id" class="gif-item" 
            @mouseover="hoveredGif = item.id" 
            @mouseleave="hoveredGif = null"
            @click="selectGif(item)">
            <img :src="getImageSource(item)" :alt="item.title">
          </div>
        </template>
      </masonry-wall>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { usePopupPositioning, type PopupPosition } from '@/composables/usePopupPositioning';
import type { Gif } from '@/types';

interface Props {
  closeGiphy?: () => void;
  gifIconClicked?: boolean;
  // Positioning props
  position?: PopupPosition;
  triggerElement?: HTMLElement;
  customPosition?: { x: number; y: number };
}

const props = withDefaults(defineProps<Props>(), {
  gifIconClicked: false,
  position: 'above',
});

interface Emits {
  (e: 'sendGif', gif: Gif): void;
  (e: 'resetGifIconClicked'): void;
}

const emit = defineEmits<Emits>();

const searchQuery = ref('');
const gifs = ref<Gif[]>([]);
const hoveredGif = ref<string | null>(null);
const gifPopup = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);

// Popup positioning
const POPUP_DIMENSIONS = { width: 400, height: 500 };
const triggerElementRef = ref<HTMLElement | null>(null);

// Set trigger element from props
watch(() => props.triggerElement, (newTrigger) => {
  triggerElementRef.value = newTrigger || null;
}, { immediate: true });

const { positionStyle, updatePosition } = usePopupPositioning(
  triggerElementRef,
  POPUP_DIMENSIONS,
  {
    position: props.position,
    offset: 8,
    viewport: { padding: 10 }
  }
);

// Update position when triggerElement changes
watch(() => props.triggerElement, () => {
  nextTick(() => {
    updatePosition();
  });
});

const getImageSource = (gif: Gif) => {
  return hoveredGif.value === gif.id ? gif.media_formats.gif.url : gif.media_formats.gifpreview.url;
};

        const fetchTrendingGifs = async () => {
            try {
                const response = await fetch(`https://tenor.googleapis.com/v2/featured?key=${import.meta.env.VITE_TENOR_API_KEY}&limit=18`);
                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }
                const data = await response.json();
                gifs.value = data.results;
            } catch (error) {
                console.error('Fetch error:', error);
            }
        };

        const searchGifs = async () => {
            if (!searchQuery.value.trim()) {
                console.log('empty search');
                await fetchTrendingGifs();
            } else {
                try {
                    const response = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(searchQuery.value)}&key=${import.meta.env.VITE_TENOR_API_KEY}&limit=18`);
                    if (!response.ok) {
                        throw new Error('Network response was not ok');
                    }
                    const data = await response.json();
                    gifs.value = data.results;
                } catch (error) {
                    console.error('Fetch error:', error);
                }
            }
        };

const handleClickOutside = (event: MouseEvent) => {
  if (gifPopup.value && !gifPopup.value.contains(event.target as Node)) {
    props.closeGiphy?.();
  }
};

// Handle escape key to close
const handleKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    props.closeGiphy?.();
  }
};

onMounted(() => {
  // Add event listeners with a small delay to prevent immediate closure
  setTimeout(() => {
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
  }, 100);
  fetchTrendingGifs();
  
  // Focus search input and update position
  nextTick(() => {
    searchInput.value?.focus();
    updatePosition();
  });
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleKeyDown);
});
        
        // Watcher on searchQuery with debounce for better performance
        watch(searchQuery, () => {
            searchGifs();
        });

        const selectGif = (gif: Gif) => {
            emit('sendGif', gif);
        };
</script>
<style scoped>
.gif-popup {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  width: 400px;
  max-height: 500px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  backdrop-filter: blur(10px);
}

.gif-search {
  padding: 12px;
  border-bottom: 1px solid var(--color-border);
}

.search-input {
  width: 100%;
  padding: 8px 12px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text-primary);
  font-size: 14px;
  outline: none;
}

.search-input:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px rgba(88, 101, 242, 0.2);
}

.search-input::placeholder {
  color: var(--color-text-secondary);
}

.gif-results {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.gif-item {
  cursor: pointer;
  border-radius: 4px;
  transition: transform 0.2s ease;
  transform: scale(1);
  width: 100%;
  height: auto;
  overflow: hidden;
}

.gif-item:hover {
  transform: scale(1.05);
}

.gif-item img {
  width: 100%;
  height: auto;
  display: block;
  border-radius: 4px;
}

/* Scrollbar styling */
.gif-results::-webkit-scrollbar {
  width: 8px;
}

.gif-results::-webkit-scrollbar-track {
  background: transparent;
}

.gif-results::-webkit-scrollbar-thumb {
  background: var(--color-bg-tertiary);
  border-radius: 4px;
}

.gif-results::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-tertiary);
}

@media (max-width: 768px) {
  .gif-popup {
    width: 90vw;
    max-width: 400px;
    max-height: 70vh;
  }
}
</style>

