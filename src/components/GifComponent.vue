<template>
  <div class="gif-popup" ref="gifPopup" :style="positionStyle">
    <!-- Tab Navigation Header -->
    <div class="gif-tabs">
      <button 
        class="tab-button" 
        :class="{ active: activeTab === 'gifs' }"
        @click="activeTab = 'gifs'"
      >
        GIFs
      </button>
      <button 
        class="tab-button" 
        :class="{ active: activeTab === 'stickers' }"
        @click="activeTab = 'stickers'"
        disabled
      >
        Stickers
      </button>
      <button 
        class="tab-button"
        @click="switchToEmoji"
      >
        Emoji
      </button>
      <!-- Favorite toggle in header (only for GIFs tab) -->
      <button 
        v-if="activeTab === 'gifs'"
        class="tab-icon-button"
        :class="{ active: showFavorites }"
        @click="showFavorites = !showFavorites"
        :title="showFavorites ? $t('gif.trending') : $t('gif.favorites')"
      >
        <StarIcon :filled="showFavorites" />
      </button>
    </div>

    <!-- Category Buttons (Favorites/Trending) - Only for GIFs tab -->
    <div v-if="activeTab === 'gifs'" class="gif-categories">
      <button 
        class="category-button"
        :class="{ active: showFavorites }"
        @click="showFavorites = true"
      >
        <StarIcon :filled="true" :size="16" />
        {{ $t('gif.favorites') }}
      </button>
      <button 
        class="category-button"
        :class="{ active: !showFavorites }"
        @click="showFavorites = false"
      >
        <TrendingIcon :size="16" />
        {{ $t('gif.trending') }}
      </button>
    </div>

    <!-- Search Input (hidden in favorites view) -->
    <div v-if="activeTab === 'gifs' && !showFavorites" class="gif-search">
      <div class="search-wrapper">
        <SearchIcon :size="16" class="search-icon" />
        <input 
          type="text" 
          v-model="searchQuery" 
          :placeholder="$t('gif.searchTenor')" 
          class="search-input"
          ref="searchInput"
        >
      </div>
    </div>

    <!-- GIF Results / Favorites -->
    <div class="gif-results">
      <!-- Loading State -->
      <div v-if="isLoading" class="loading-state">
        <div class="loading-spinner"></div>
        <span>Loading...</span>
      </div>

      <!-- Favorites View -->
      <template v-else-if="showFavorites">
        <div v-if="favorites.length === 0" class="empty-state">
          <StarIcon :filled="false" :size="48" class="empty-icon" />
          <p>{{ $t('gif.noFavorites') }}</p>
          <span class="empty-hint">{{ $t('gif.noFavoritesHint') }}</span>
        </div>
        <masonry-wall v-else :items="favorites" :column-width="150" :gap="10">
          <template #default="{ item }">
            <div
              :key="item.id"
              class="gif-item"
              @mouseover="hoveredGif = item.tenor_id ?? null"
              @mouseleave="hoveredGif = null"
              @click="selectFavoriteGif(item)"
            >
              <img :src="getGifImageSource(item.tenor_id ?? '', item.gif_url, item.preview_url)" :alt="item.title || 'GIF'">
              <button
                v-if="item.tenor_id"
                class="favorite-button favorited"
                @click.stop="removeFavorite(item.tenor_id!)"
                :title="$t('gif.removeFromFavorites')"
              >
                <StarIcon :filled="true" :size="16" />
              </button>
            </div>
          </template>
        </masonry-wall>
      </template>

      <!-- Trending/Search Results -->
      <template v-else>
        <div v-if="gifs.length === 0 && !isLoading" class="empty-state">
          <p>{{ $t('gif.noResults') }}</p>
          <span class="empty-hint">Try a different search term</span>
        </div>
        <masonry-wall v-else :items="gifs" :column-width="150" :gap="10">
          <template #default="{ item }">
            <div 
              :key="item.id" 
              class="gif-item" 
              @mouseover="hoveredGif = item.id" 
              @mouseleave="hoveredGif = null"
              @click="selectGif(item)"
            >
              <img :src="getGifImageSource(item.id, item.media_formats.gif.url, item.media_formats.gifpreview.url)" :alt="item.title">
              <button 
                class="favorite-button"
                :class="{ favorited: isFavorited(item.id) }"
                @click.stop="toggleFavorite(item)"
                :title="isFavorited(item.id) ? $t('gif.removeFromFavorites') : $t('gif.addToFavorites')"
              >
                <StarIcon :filled="isFavorited(item.id)" :size="16" />
              </button>
            </div>
          </template>
        </masonry-wall>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick, type Ref } from 'vue';
import { debug } from '@/utils/debug';
import { usePopupPositioning, type PopupPosition } from '@/composables/usePopupPositioning';
import { gifService, type FavoriteGif } from '@/services/GifService';
import type { Gif } from '@/types';

// Icons as inline components for DRY code
const StarIcon = {
  props: { filled: { type: Boolean, default: false }, size: { type: Number, default: 18 } },
  template: `
    <svg :width="size" :height="size" viewBox="0 0 24 24" fill="currentColor">
      <path v-if="filled" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
      <path v-else d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"/>
    </svg>
  `
};

const TrendingIcon = {
  props: { size: { type: Number, default: 18 } },
  template: `
    <svg :width="size" :height="size" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.09 4.56c-.7-1.03-1.5-1.99-2.4-2.85-.35-.34-.94-.02-.84.46.19.94.39 2.18.39 3.29 0 2.06-1.35 3.73-3.41 3.73-1.54 0-2.8-.93-3.35-2.26-.1-.2-.14-.32-.2-.54-.11-.42-.66-.55-.9-.18-.18.27-.35.56-.51.84A13.74 13.74 0 004 14c0 4.42 3.58 8 8 8s8-3.58 8-8c0-3.49-1.08-6.73-2.91-9.44zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.47-.3 2.98-.93 4.03-1.92.28-.26.74-.14.82.23.23 1.02.35 2.08.35 3.15.01 2.65-2.14 4.8-4.79 4.8z"/>
    </svg>
  `
};

const SearchIcon = {
  props: { size: { type: Number, default: 18 } },
  template: `
    <svg :width="size" :height="size" viewBox="0 0 24 24" fill="currentColor">
      <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
    </svg>
  `
};

// Props
interface Props {
  closeGiphy?: () => void;
  gifIconClicked?: boolean;
  position?: PopupPosition;
  triggerElement?: HTMLElement;
  customPosition?: { x: number; y: number };
}

const props = withDefaults(defineProps<Props>(), {
  gifIconClicked: false,
  position: 'above',
});

// Emits
interface Emits {
  (e: 'sendGif', gif: Gif): void;
  (e: 'resetGifIconClicked'): void;
  (e: 'switchToEmoji'): void;
}

const emit = defineEmits<Emits>();

// State
const activeTab = ref<'gifs' | 'stickers' | 'emoji'>('gifs');
const showFavorites = ref(false);
const searchQuery = ref('');
const gifs = ref<Gif[]>([]);
const favorites = ref<FavoriteGif[]>([]);
const hoveredGif = ref<string | null>(null);
const gifPopup = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const isLoading = ref(false);
const favoriteTenorIds = ref<Set<string>>(new Set());

// Popup positioning
const POPUP_DIMENSIONS = { width: 400, height: 500 };
const triggerElementRef = ref<HTMLElement | null>(null);

watch(() => props.triggerElement, (newTrigger) => {
  triggerElementRef.value = newTrigger || null;
  nextTick(() => updatePosition());
}, { immediate: true });

const { positionStyle, updatePosition } = usePopupPositioning(
  triggerElementRef as unknown as Ref<HTMLElement | null>,
  POPUP_DIMENSIONS,
  { position: props.position, offset: 8, viewport: { padding: 10 } }
);

// Unified image source helper - DRY
const getGifImageSource = (id: string, gifUrl: string, previewUrl: string): string => {
  return hoveredGif.value === id ? gifUrl : previewUrl;
};

// Check if a GIF is favorited
const isFavorited = (tenorId: string): boolean => favoriteTenorIds.value.has(tenorId);

// Switch to emoji picker
const switchToEmoji = () => {
  props.closeGiphy?.();
  emit('switchToEmoji');
};

// Fetch trending GIFs from Tenor API
const fetchTrendingGifs = async () => {
  isLoading.value = true;
  try {
    const response = await fetch(
      `https://tenor.googleapis.com/v2/featured?key=${import.meta.env.VITE_TENOR_API_KEY}&limit=18`
    );
    if (!response.ok) throw new Error('Network response was not ok');
    const data = await response.json();
    gifs.value = data.results;
  } catch (error) {
    debug.error('Failed to fetch trending GIFs:', error);
  } finally {
    isLoading.value = false;
  }
};

// Search GIFs from Tenor API
const searchGifs = async () => {
  if (!searchQuery.value.trim()) {
    await fetchTrendingGifs();
    return;
  }
  
  isLoading.value = true;
  try {
    const response = await fetch(
      `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(searchQuery.value)}&key=${import.meta.env.VITE_TENOR_API_KEY}&limit=18`
    );
    if (!response.ok) throw new Error('Network response was not ok');
    const data = await response.json();
    gifs.value = data.results;
  } catch (error) {
    debug.error('Failed to search GIFs:', error);
  } finally {
    isLoading.value = false;
  }
};

// Load user's favorite GIFs
const loadFavorites = async () => {
  isLoading.value = true;
  try {
    favorites.value = await gifService.getFavorites();
    favoriteTenorIds.value = new Set(favorites.value.map(f => f.tenor_id ?? '').filter(Boolean));
  } catch (error) {
    debug.error('Failed to load favorites:', error);
  } finally {
    isLoading.value = false;
  }
};

// Toggle favorite status for a GIF
const toggleFavorite = async (gif: Gif) => {
  // eslint-disable-next-line unused-imports/no-unused-vars
  const wasAlreadyFavorite = isFavorited(gif.id);
  const result = await gifService.toggleFavorite(gif);
  
  if (result.error) {
    debug.error('Failed to toggle favorite:', result.error);
    return;
  }
  
  // Update local state immediately for responsive UI
  if (result.isFavorite) {
    favoriteTenorIds.value.add(gif.id);
    // Add to favorites array for immediate display when switching to favorites view
    favorites.value.unshift({
      id: crypto.randomUUID(), // Temporary ID until reload
      // `user_id` is required by `GifFavorite` but unknown at optimistic-insert
      // time; the row is replaced once `loadFavorites()` reloads from the DB.
      user_id: '',
      tenor_id: gif.id,
      gif_url: gif.media_formats.gif.url,
      preview_url: gif.media_formats.gifpreview.url,
      title: gif.title || null,
      created_at: new Date().toISOString()
    });
  } else {
    favoriteTenorIds.value.delete(gif.id);
    favorites.value = favorites.value.filter(f => f.tenor_id !== gif.id);
  }
  
  // Trigger reactivity
  favoriteTenorIds.value = new Set(favoriteTenorIds.value);
};

// Remove a favorite GIF
const removeFavorite = async (tenorId: string) => {
  const result = await gifService.removeFavorite(tenorId);
  if (result.success) {
    favorites.value = favorites.value.filter(f => f.tenor_id !== tenorId);
    favoriteTenorIds.value.delete(tenorId);
    favoriteTenorIds.value = new Set(favoriteTenorIds.value);
  }
};

// Select and send a GIF
const selectGif = (gif: Gif) => emit('sendGif', gif);

// Select and send a favorite GIF (convert to Gif type)
const selectFavoriteGif = (favorite: FavoriteGif) => {
  emit('sendGif', gifService.favoriteToGif(favorite));
};

// Event handlers
const handleClickOutside = (event: MouseEvent) => {
  if (gifPopup.value && !gifPopup.value.contains(event.target as Node)) {
    props.closeGiphy?.();
  }
};

const handleKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    props.closeGiphy?.();
  }
};

// Debounced search
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
watch(searchQuery, () => {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(searchGifs, 300);
});

// Load favorites when switching to favorites view
watch(showFavorites, (show) => {
  if (show && favorites.value.length === 0) {
    loadFavorites();
  }
});

// Lifecycle
let listenerSetupTimer: ReturnType<typeof setTimeout> | null = null;

onMounted(async () => {
  listenerSetupTimer = setTimeout(() => {
    listenerSetupTimer = null;
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
  }, 100);
  
  await loadFavorites();
  
  fetchTrendingGifs();
  
  nextTick(() => {
    searchInput.value?.focus();
    updatePosition();
  });
});

onUnmounted(() => {
  if (listenerSetupTimer) {
    clearTimeout(listenerSetupTimer);
    listenerSetupTimer = null;
  }
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleKeyDown);
  if (searchTimeout) clearTimeout(searchTimeout);
});
</script>

<style scoped>
.gif-popup {
  background: var(--background-primary-alpha);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  width: 400px;
  max-height: 500px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  backdrop-filter: blur(10px);
}

/* Tab Navigation */
.gif-tabs {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  gap: 4px;
}

.tab-button {
  background: none;
  border: none;
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.tab-button:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.tab-button.active {
  background: var(--background-modifier-selected);
  color: var(--text-primary);
}

.tab-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tab-icon-button {
  margin-left: auto;
  background: none;
  border: none;
  padding: 8px;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tab-icon-button:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.tab-icon-button.active {
  color: var(--color-warning);
}

/* Category Buttons */
.gif-categories {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-secondary);
  background: var(--background-senary-alpha);
}

.category-button {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--background-secondary);
  border: none;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 16px;
  transition: all 0.15s ease;
}

.category-button:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.category-button.active {
  background: var(--color-primary);
  color: var(--text-primary);
}

.category-button svg {
  opacity: 0.8;
}

/* Search */
.gif-search {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-senary-alpha);
}

.search-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-muted);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 8px 12px 8px 36px;
  background: var(--background-senary-alpha);
  border: none;
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
}

.search-input:focus {
  background: var(--background-secondary);
}

.search-input::placeholder {
  color: var(--text-muted);
}

/* Results Area */
.gif-results {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  min-height: 200px;
}

.gif-item {
  position: relative;
  cursor: pointer;
  border-radius: 4px;
  transition: transform 0.15s ease;
  width: 100%;
  height: auto;
  overflow: hidden;
}

.gif-item:hover {
  transform: scale(1.03);
}

.gif-item img {
  width: 100%;
  height: auto;
  display: block;
  border-radius: 4px;
}

/* Favorite Button on GIF Items */
.favorite-button {
  position: absolute;
  top: 6px;
  right: 6px;
  background: rgba(0, 0, 0, 0.6);
  border: none;
  padding: 6px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: all 0.15s ease;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.gif-item:hover .favorite-button {
  opacity: 1;
}

.favorite-button:hover {
  background: rgba(0, 0, 0, 0.8);
  transform: scale(1.1);
}

.favorite-button.favorited {
  color: var(--color-warning);
  opacity: 1;
}

/* Loading State */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
  color: var(--text-secondary);
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border-color);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Empty State */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 20px;
  text-align: center;
  color: var(--text-secondary);
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: 8px;
}

.empty-state p {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
}

.empty-hint {
  font-size: 13px;
  color: var(--text-muted);
}

/* Scrollbar styling */
.gif-results::-webkit-scrollbar {
  width: 8px;
}

.gif-results::-webkit-scrollbar-track {
  background: transparent;
}

.gif-results::-webkit-scrollbar-thumb {
  background: var(--background-senary-alpha, rgba(10, 11, 13, 0.8));
  border-radius: 4px;
}

.gif-results::-webkit-scrollbar-thumb:hover {
  background: var(--background-senary, #0a0b0d);
}

@media (max-width: 768px) {
  .gif-popup {
    width: 90vw;
    max-width: 400px;
    max-height: 70vh;
  }
  
  .tab-button {
    padding: 6px 12px;
    font-size: 13px;
  }
}
</style>
