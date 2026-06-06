<template>
  <div class="gif-picker-content">
    <!-- Category Buttons (Favorites/Trending) -->
    <div class="gif-categories">
      <button 
        class="category-button"
        :class="{ active: showFavorites }"
        @click="$emit('update:showFavorites', true)"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
        </svg>
        {{ $t('gif.favorites') }}
      </button>
      <button 
        class="category-button"
        :class="{ active: !showFavorites }"
        @click="$emit('update:showFavorites', false)"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M17.09 4.56c-.7-1.03-1.5-1.99-2.4-2.85-.35-.34-.94-.02-.84.46.19.94.39 2.18.39 3.29 0 2.06-1.35 3.73-3.41 3.73-1.54 0-2.8-.93-3.35-2.26-.1-.2-.14-.32-.2-.54-.11-.42-.66-.55-.9-.18-.18.27-.35.56-.51.84A13.74 13.74 0 004 14c0 4.42 3.58 8 8 8s8-3.58 8-8c0-3.49-1.08-6.73-2.91-9.44zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.47-.3 2.98-.93 4.03-1.92.28-.26.74-.14.82.23.23 1.02.35 2.08.35 3.15.01 2.65-2.14 4.8-4.79 4.8z"/>
        </svg>
        {{ $t('gif.trending') }}
      </button>
    </div>

    <!-- Search Input (disabled in favorites view to maintain consistent height) -->
    <div class="gif-search">
      <div class="search-wrapper">
        <svg class="search-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
        </svg>
        <input 
          type="text" 
          v-model="searchQuery" 
          :placeholder="gifSearchPlaceholder" 
          class="search-input"
          ref="searchInput"
          :disabled="showFavorites"
        >
      </div>
      <!-- Klipy search suggestions / autocomplete -->
      <div v-if="!showFavorites && suggestions.length" class="gif-suggestions">
        <button
          v-for="term in suggestions"
          :key="term"
          type="button"
          class="gif-suggestion-chip"
          @click="applySuggestion(term)"
        >{{ term }}</button>
      </div>
    </div>

    <!-- GIF Results / Favorites -->
    <div class="gif-results" ref="resultsRef" @scroll="onResultsScroll">
      <!-- Loading State -->
      <div v-if="isLoading" class="loading-state">
        <LoadingSpinner :size="24" />
        <span>Loading...</span>
      </div>

      <!-- Favorites View -->
      <template v-else-if="showFavorites">
        <div v-if="favorites.length === 0" class="empty-state">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor" class="empty-icon">
            <path d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"/>
          </svg>
          <p>{{ $t('gif.noFavorites') }}</p>
          <span class="empty-hint">{{ $t('gif.noFavoritesHint') }}</span>
        </div>
        <masonry-wall v-else :items="favorites" :column-width="150" :gap="10">
          <template #default="{ item }">
            <div 
              :key="item.id" 
              class="gif-item" 
              @mouseover="hoveredGif = item.id" 
              @mouseleave="hoveredGif = null"
              @click="selectFavoriteGif(item)"
            >
              <video
                v-if="(item.media_type ?? 'gif') === 'clip'"
                :src="stripFragment(item.gif_url)"
                :poster="stripFragment(item.preview_url)"
                class="gif-video"
                muted
                loop
                playsinline
                preload="metadata"
                @mouseenter="(e) => playPreview(e)"
                @mouseleave="(e) => pausePreview(e)"
              ></video>
              <img v-else :src="getGifImageSource(item.id, item.gif_url, item.preview_url)" :alt="item.title || 'GIF'" :class="{ 'sticker-thumb': isStickerLike }">
              <button 
                class="favorite-button favorited"
                @click.stop="removeFavorite(item.id)"
                :title="$t('gif.removeFromFavorites')"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
                </svg>
              </button>
            </div>
          </template>
        </masonry-wall>
      </template>

      <!-- Trending/Search Results -->
      <template v-else>
        <div v-if="items.length === 0 && !isLoading" class="empty-state">
          <p>{{ $t('gif.noResults') }}</p>
          <span class="empty-hint">Try a different search term</span>
        </div>
        <masonry-wall v-else :items="items" :column-width="150" :gap="10">
          <template #default="{ item }">
            <GifAdSlot
              v-if="item.kind === 'ad'"
              :key="item.id"
              :content="item.content"
              :width="item.width"
              :height="item.height"
            />
            <div 
              v-else
              :key="item.id" 
              class="gif-item" 
              @mouseover="hoveredGif = item.id" 
              @mouseleave="hoveredGif = null"
              @click="selectGif(item)"
            >
              <video
                v-if="isClips"
                :src="stripFragment(item.media_formats.mp4.url)"
                :poster="stripFragment(item.media_formats.gifpreview.url)"
                class="gif-video"
                muted
                loop
                playsinline
                preload="metadata"
                @mouseenter="(e) => playPreview(e)"
                @mouseleave="(e) => pausePreview(e)"
              ></video>
              <img v-else :src="getGifImageSource(item.id, item.media_formats.gif.url, item.media_formats.gifpreview.url)" :alt="item.title" :class="{ 'sticker-thumb': isStickerLike }">
              <button 
                class="favorite-button"
                :class="{ favorited: isFavorited(item.media_formats.gif.url) }"
                @click.stop="toggleFavorite(item)"
                :title="isFavorited(item.media_formats.gif.url) ? $t('gif.removeFromFavorites') : $t('gif.addToFavorites')"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path v-if="isFavorited(item.media_formats.gif.url)" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
                  <path v-else d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"/>
                </svg>
              </button>
            </div>
          </template>
        </masonry-wall>
        <div v-if="loadingMore" class="loading-more">
          <LoadingSpinner :size="20" />
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, nextTick, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import GifAdSlot from '@/components/GifAdSlot.vue';
import { debug } from '@/utils/debug';
import { gifService, type FavoriteGif } from '@/services/GifService';
import { gifProvider, type GifMediaType } from '@/services/gifProviderService';
import {
  stripKlipyAttributionFragment,
  withGifMessageUrl,
  mediaTypeToKind,
  type KlipyKind,
} from '@/utils/klipyAttribution';
import type { Gif, GifResultItem } from '@/types';

interface Props {
  showFavorites: boolean;
  initialSearchQuery?: string;
  mediaType?: GifMediaType;
}

const props = withDefaults(defineProps<Props>(), {
  mediaType: 'gifs',
});

interface Emits {
  (e: 'sendGif', gif: Gif): void;
  (e: 'update:showFavorites', value: boolean): void;
}

const emit = defineEmits<Emits>();
const { t } = useI18n();

const kind = computed<KlipyKind>(() => mediaTypeToKind(props.mediaType));
const isClips = computed(() => props.mediaType === 'clips');
// Stickers and AI emojis are small, transparent, sticker-like media.
const isStickerLike = computed(
  () => props.mediaType === 'stickers' || props.mediaType === 'ai-emojis',
);

// "Search KLIPY" is required attribution per Klipy's terms, so it is always
// shown regardless of the optional watermark setting.
const gifSearchPlaceholder = computed(() =>
  props.showFavorites ? t('gif.favorites') : t('gif.searchKlipy'),
);

// State
const searchQuery = ref(props.initialSearchQuery || '');
const items = ref<GifResultItem[]>([]);
const favorites = ref<FavoriteGif[]>([]);
const hoveredGif = ref<string | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const resultsRef = ref<HTMLElement | null>(null);
const isLoading = ref(false);
const loadingMore = ref(false);
const favoriteUrls = ref<Set<string>>(new Set());
const suggestions = ref<string[]>([]);

// Pagination state for trending/search infinite scroll.
const page = ref(1);
const hasNext = ref(false);
const PER_PAGE = 24;

const stripFragment = (url: string): string => stripKlipyAttributionFragment(url);

// Unified image source helper
const getGifImageSource = (id: string, gifUrl: string, previewUrl: string): string => {
  const src = hoveredGif.value === id ? gifUrl : previewUrl;
  return stripKlipyAttributionFragment(src);
};

// Hover play/pause for clip (video) previews.
const playPreview = (e: Event) => {
  const v = e.target as HTMLVideoElement;
  v.play?.().catch(() => {});
};
const pausePreview = (e: Event) => {
  const v = e.target as HTMLVideoElement;
  v.pause?.();
  if (v) v.currentTime = 0;
};

const applySuggestion = (term: string) => {
  searchQuery.value = term;
};

const applyFeed = (feed: Awaited<ReturnType<typeof gifProvider.trending>>) => {
  items.value = feed.items;
  if (feed.meta?.showAds && !feed.items.some((i) => i.kind === 'ad')) {
    debug.log(
      'GIF feed: ads enabled for this user but Klipy returned no ad slots. ' +
        'Try search, confirm KLIPY_API_KEY_ADS has ads on in the Klipy dashboard, and restart the federation backend.',
    );
  }
};

// Check if a GIF is favorited (by URL)
const isFavorited = (gifUrl: string): boolean => favoriteUrls.value.has(gifUrl);

// Fetch a page of trending/search results. `reset` replaces the list and
// resets pagination; otherwise the page is appended (infinite scroll).
const fetchPage = async (reset: boolean) => {
  if (reset) {
    page.value = 1;
    isLoading.value = true;
  } else {
    if (loadingMore.value || isLoading.value || !hasNext.value) return;
    loadingMore.value = true;
  }

  const query = searchQuery.value.trim();
  const opts = { perPage: PER_PAGE, page: page.value };
  try {
    const feed = query
      ? await gifProvider.search(query, opts, props.mediaType)
      : await gifProvider.trending(opts, props.mediaType);
    if (reset) {
      applyFeed(feed);
    } else {
      items.value = [...items.value, ...feed.items];
    }
    hasNext.value = feed.hasNext;
  } finally {
    isLoading.value = false;
    loadingMore.value = false;
  }
};

const loadMore = () => {
  if (props.showFavorites || loadingMore.value || isLoading.value || !hasNext.value) return;
  page.value += 1;
  fetchPage(false);
};

// Trigger the next page when the user scrolls near the bottom.
const onResultsScroll = () => {
  const el = resultsRef.value;
  if (!el) return;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 320) loadMore();
};

// Load user's favorite GIFs
const loadFavorites = async () => {
  isLoading.value = true;
  try {
    favorites.value = await gifService.getFavorites(kind.value);
    favoriteUrls.value = new Set(favorites.value.map(f => f.gif_url));
  } catch (error) {
    debug.error('Failed to load favorites:', error);
  } finally {
    isLoading.value = false;
  }
};

// Toggle favorite status for a GIF
const toggleFavorite = async (gif: Gif) => {
  const gifUrl = gif.media_formats.gif.url;
  const previewUrl = gif.media_formats.gifpreview.url;
  // eslint-disable-next-line unused-imports/no-unused-vars
  const wasAlreadyFavorite = isFavorited(gifUrl);
  
  const result = await gifService.toggleFavoriteByUrl(
    gifUrl,
    previewUrl,
    gif.title || null,
    kind.value
  );
  
  if (result.error) {
    debug.error('Failed to toggle favorite:', result.error);
    return;
  }
  
  // Update local state immediately
  if (result.isFavorite) {
    favoriteUrls.value.add(gifUrl);
    favorites.value.unshift({
      id: crypto.randomUUID(),
      user_id: '',
      gif_url: gifUrl,
      preview_url: previewUrl,
      title: gif.title || null,
      media_type: kind.value,
      created_at: new Date().toISOString()
    });
  } else {
    favoriteUrls.value.delete(gifUrl);
    favorites.value = favorites.value.filter(f => f.gif_url !== gifUrl);
  }
  
  favoriteUrls.value = new Set(favoriteUrls.value);
};

// Remove a favorite GIF
const removeFavorite = async (favoriteId: string) => {
  const favorite = favorites.value.find(f => f.id === favoriteId);
  if (!favorite) return;
  
  const result = await gifService.removeFavoriteByUrl(favorite.gif_url);
  if (result.success) {
    favorites.value = favorites.value.filter(f => f.id !== favoriteId);
    favoriteUrls.value.delete(favorite.gif_url);
    favoriteUrls.value = new Set(favoriteUrls.value);
  }
};

// Select and send a GIF
const selectGif = (gif: Gif) => emit('sendGif', withGifMessageUrl(gif, kind.value));

// Select and send a favorite GIF/sticker/clip/etc.
const selectFavoriteGif = (favorite: FavoriteGif) => {
  const favKind = (favorite.media_type ?? 'gif') as KlipyKind;
  emit('sendGif', withGifMessageUrl(gifService.favoriteToGif(favorite), favKind));
};

// Debounced search + suggestions/autocomplete.
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
let suggestTimeout: ReturnType<typeof setTimeout> | null = null;
const refreshSuggestions = async () => {
  suggestions.value = await gifProvider.suggest(searchQuery.value || undefined);
};
watch(searchQuery, () => {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => fetchPage(true), 300);
  if (suggestTimeout) clearTimeout(suggestTimeout);
  suggestTimeout = setTimeout(refreshSuggestions, 250);
});

// Load favorites when switching to favorites view
watch(() => props.showFavorites, (show) => {
  if (show && favorites.value.length === 0) {
    loadFavorites();
  }
});

// Initialize
onMounted(async () => {
  await loadFavorites();
  fetchPage(true);
  refreshSuggestions();
  
  nextTick(() => {
    searchInput.value?.focus();
  });
});
</script>

<style scoped>
.gif-picker-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

/* Category Buttons */
.gif-categories {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-secondary);
  flex-shrink: 0;
  background: var(--background-senary-alpha);
}

.category-button {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 16px;
  transition: all 0.15s ease;
}

.category-button:hover {
  background: var(--background-tertiary-alpha);
  color: var(--text-primary);
}

.category-button.active {
  background: var(--harmony-primary-alpha);
  color: var(--text-primary);
}

.category-button svg {
  opacity: 0.8;
}

/* Search */
.gif-search {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
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

.search-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Search suggestions / autocomplete chips */
.gif-suggestions {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  margin-top: 8px;
  overflow-x: auto;
  scrollbar-width: none;
  padding-bottom: 2px;
}

.gif-suggestions::-webkit-scrollbar {
  display: none;
}

.gif-suggestion-chip {
  flex: 0 0 auto;
  background: var(--background-senary-alpha);
  border: 1px solid var(--border-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease;
}

.gif-suggestion-chip:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

/* Infinite-scroll loading indicator */
.loading-more {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 0 16px;
}

/* Clip (video) previews share the GIF item sizing. */
.gif-video {
  width: 100%;
  height: auto;
  max-height: 250px;
  object-fit: cover;
  display: block;
  border-radius: 4px;
  background: #000;
}

/* Results Area */
.gif-results {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 0 8px 8px;
  min-height: 0;
  scrollbar-gutter: stable;
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
  max-height: 250px;
  object-fit: cover;
  display: block;
  border-radius: 4px;
}

/* Stickers are transparent: show them whole on no background, not cropped. */
.gif-item img.sticker-thumb {
  object-fit: contain;
  max-height: 140px;
  border-radius: 0;
  background: transparent;
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
</style>

