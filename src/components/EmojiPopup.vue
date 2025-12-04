<template>
  <div ref="emojiPopup" class="emoji-popup" :style="positionStyle">
    <!-- Search Input -->
    <div class="emoji-search">
      <input
        ref="searchInput"
        v-model="searchQuery"
        type="text"
        :placeholder="$t('emoji.searchEmojis')"
        class="search-input"
      />
    </div>

    <!-- Emoji Content Area -->
    <div class="emoji-content">
      <!-- Frequently Used Emojis -->
      <div v-if="!searchQuery && hasFrequentEmojis" class="emoji-section">
        <h3 class="section-title">⏱️ Frequently Used</h3>
        <div class="emoji-list frequent-list">
          <div
            v-for="emoji in topEmojisForPicker"
            :key="emoji.id"
            class="emoji-item"
            :class="{ 'native-emoji-item': isNativePack, 'svg-emoji-item': !isNativePack }"
            :title="`:${emoji.name}:`"
            @click="selectFrequentEmoji(emoji)"
          >
            <!-- Custom server emoji with URL (not a local asset path) -->
            <img 
              v-if="getFrequentEmojiDisplayUrl(emoji)"
              :src="getFrequentEmojiDisplayUrl(emoji)"
              :alt="emoji.name"
              class="frequent-emoji-img"
            />
            <!-- SVG pack emoji -->
            <img 
              v-else-if="!isNativePack && getFrequentEmojiSvgUrl(emoji)"
              :src="getFrequentEmojiSvgUrl(emoji)"
              :alt="emoji.name"
              class="frequent-emoji-img"
            />
            <!-- Native unicode emoji -->
            <span v-else-if="emoji.native">{{ emoji.native }}</span>
            <!-- Fallback to name -->
            <span v-else class="emoji-shortcode">:{{ emoji.name }}:</span>
          </div>
        </div>
      </div>

      <!-- Server Emojis List -->
      <div v-if="filteredEmojiList.length">
        <div v-for="group in filteredEmojiList" :key="group.serverId">
          <h3 class="section-title">{{ group.server_name }}</h3>
          <div class="emoji-list">
            <div
              v-for="emoji in group.emojis"
              :key="emoji.id"
              class="emoji-item"
              :title="`:${emoji.display_name}:`"
              @click="selectEmoji(emoji)"
              @mouseover="hoveredEmojiId = emoji.id"
              @mouseleave="hoveredEmojiId = null"
            >
              <img :src="getEmojiUrl(emoji.url, 42)" :alt="emoji.name" />
            </div>
          </div>
        </div>
      </div>
      
      <!-- Unified Emojis by Category (from unified emoji service) -->
      <div v-if="unifiedLoading" class="emoji-loading">
        <span class="loading-spinner"></span>
        <span>Loading emojis...</span>
      </div>
      
      <div v-for="category in displayedCategories" :key="category.id" class="emoji-section">
        <h3 class="section-title">{{ category.icon }} {{ category.name }}</h3>
        <div class="emoji-list unified-list">
          <div
            v-for="emoji in category.emojis"
            :key="emoji.shortcode"
            class="emoji-item"
            :class="{ 'svg-emoji-item': !isNativePack, 'native-emoji-item': isNativePack }"
            :title="`:${emoji.shortcode}:`"
            @click="selectUnifiedEmoji(emoji)"
          >
            <!-- SVG pack (twemoji or mutant): show SVG -->
            <img 
              v-if="!isNativePack"
              :src="getEmojiSvgUrl(emoji)" 
              :alt="emoji.shortcode"
              loading="lazy"
              class="emoji-svg"
            />
            <!-- Native pack: show unicode -->
            <span v-else class="native-emoji-char">{{ emoji.unicode }}</span>
          </div>
        </div>
      </div>
      
      <!-- No Results -->
      <div v-if="searchQuery && !filteredEmojiList.length && !displayedCategories.length" class="no-results">
        <div class="no-results-content">
          <div class="no-results-icon">{{ noResultsInfo.icon }}</div>
          <p>{{ noResultsInfo.title }}</p>
          <small>{{ noResultsInfo.subtitle }}</small>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick, watch } from 'vue';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import { usePopupPositioning } from '@/composables/usePopupPositioning';
import { useFrequentEmojis } from '@/composables/useFrequentEmojis';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useUnifiedEmoji, type EmojiEntry } from '@/services/unifiedEmojiService';
import type { Emoji, ResolvedEmoji } from '@/types';
import { getEmojiUrl } from '@/utils/emojiUtils';
import { EMOJI_CATEGORIES, CATEGORY_ORDER } from '@/utils/emojiConstants';

// --- Types ---

interface FilteredServerEmojiGroup {
  serverId: string;
  server_name: string;
  server_icon?: string;
  emojis: ResolvedEmoji[];
}

interface DisplayCategory {
  id: string;
  name: string;
  icon: string;
  order: number;
  emojis: EmojiEntry[];
}

// --- Props & Emits ---

const props = withDefaults(
  defineProps<{
    /** Function to call to close the popup. */
    closeEmojiList?: () => void;
    /** Flag indicating if the popup was opened via the icon click. */
    emojiIconClicked?: boolean;
    /** Determines if the emoji is for a reaction (future use). */
    isReaction?: boolean;
    /** The element that triggers the popup for positioning. */
    triggerElement?: HTMLElement;
    /** The desired position relative to the trigger element. */
    position?: 'above' | 'below' | 'left' | 'right';
  }>(),
  {
    emojiIconClicked: false,
    isReaction: false,
    position: 'above',
    triggerElement: undefined,
    closeEmojiList: () => {},
  },
);

const emit = defineEmits<{
  /** Emits the selected emoji object. */
  (e: 'sendEmoji', emoji: Emoji): void;
  /** Notifies the parent to reset the emojiIconClicked flag. */
  (e: 'resetEmojiIconClicked'): void;
}>();

// --- State ---

const emojiCacheStore = useEmojiCacheStore();
const { topEmojisForPicker, hasFrequentEmojis, recordEmojiUsage } = useFrequentEmojis();
const { triggerReaction } = useHapticSettings();
const { 
  isNativePack, 
  isTwemojiPack,
  currentPack,
  isLoaded: unifiedLoaded,
  isLoading: unifiedLoading,
  getAllEmojis,
  getCategories,
  searchEmojis,
  resolveEmoji,
  getTwemojiUrl,
  getMutantSvgUrl
} = useUnifiedEmoji();

const emojiPopup = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const searchQuery = ref('');
const hoveredEmojiId = ref<string | null>(null);

// --- Composables ---

const triggerElementRef = computed(() => props.triggerElement || null);
const { positionStyle, updatePosition } = usePopupPositioning(
  triggerElementRef,
  { width: 320, height: 400 },
  { position: props.position },
);

// --- Computed ---

/**
 * Filters the emoji list based on the search query.
 * Groups emojis by server and removes servers with no matching emojis.
 */
const filteredEmojiList = computed((): FilteredServerEmojiGroup[] => {
  const query = searchQuery.value.toLowerCase().trim();
  const allEmojisByServer = Object.entries(emojiCacheStore.resolvedEmojis);

  if (!query) {
    return allEmojisByServer
      .map(([serverId, data]) => ({ serverId, ...data }))
      .filter((group) => group.emojis.length > 0);
  }

  return allEmojisByServer
    .map(([serverId, data]) => {
      const matchingEmojis = data.emojis.filter(
        (emoji) =>
          emoji.name.toLowerCase().includes(query) ||
          emoji.display_name.toLowerCase().includes(query),
      );
      return {
        serverId,
        server_name: data.server_name,
        server_icon: data.server_icon,
        emojis: matchingEmojis,
      };
    })
    .filter((group) => group.emojis.length > 0);
});

/**
 * Displayed emoji categories from unified emoji service
 * Sorted by Unicode standard order (People, Nature, Food, etc.)
 */
const displayedCategories = computed((): DisplayCategory[] => {
  if (!unifiedLoaded.value) return [];
  
  const query = searchQuery.value.toLowerCase().trim();
  const allEmojis = getAllEmojis();
  
  // Group emojis by category
  const categoryMap = new Map<string, EmojiEntry[]>();
  for (const emoji of allEmojis) {
    const catId = emoji.category;
    if (!categoryMap.has(catId)) {
      categoryMap.set(catId, []);
    }
    categoryMap.get(catId)!.push(emoji);
  }
  
  // Get category metadata from service or constants
  const serviceCats = getCategories();
  const categoryMetadata = serviceCats.length > 0 
    ? serviceCats 
    : EMOJI_CATEGORIES;
  
  // Build categories with emojis, sorted by order
  const categories: DisplayCategory[] = [];
  
  for (const meta of categoryMetadata) {
    const emojis = categoryMap.get(meta.id) || [];
    if (emojis.length === 0) continue;
    
    let filteredEmojis = emojis;
    
    // Filter by search query if present
    if (query) {
      filteredEmojis = emojis.filter(emoji => 
        emoji.shortcode.toLowerCase().includes(query) ||
        (emoji.name && emoji.name.toLowerCase().includes(query)) ||
        emoji.keywords?.some(kw => kw.toLowerCase().includes(query))
      );
      if (filteredEmojis.length === 0) continue;
    }
    
    categories.push({
      id: meta.id,
      name: meta.name,
      icon: meta.icon,
      order: meta.order,
      emojis: filteredEmojis
    });
  }
  
  // Sort by order
  return categories.sort((a, b) => a.order - b.order);
});

/**
 * Get SVG URL for an emoji based on current pack
 */
function getEmojiSvgUrl(emoji: EmojiEntry): string {
  if (isNativePack.value) return '';
  
  // For twemoji, use codepoint-based URL
  if (isTwemojiPack.value) {
    const url = getTwemojiUrl(emoji.unicode);
    if (url) return url;
  }
  
  // For mutant, use svgPath if available
  if (emoji.svgPath) {
    return `/assets/emojis/mutant_emojis_svg/${emoji.svgPath}`;
  }
  
  // Fallback to resolve
  const resolved = resolveEmoji(emoji.unicode);
  return resolved.display.type === 'svg' ? resolved.display.content : '';
}

/**
 * Check if a URL is a local emoji pack asset (not a custom/remote emoji)
 */
function isLocalAssetUrl(url: string): boolean {
  return url.startsWith('/assets/') || 
         url.includes('/twemoji/') || 
         url.includes('/mutant_emojis_svg/');
}

/**
 * Check if an emoji is a custom server emoji (not a unified pack emoji)
 */
function isCustomServerEmoji(emoji: { id: string; native?: string; name: string; url?: string }): boolean {
  // Has a URL that's not from our local emoji packs
  if (emoji.url && !isLocalAssetUrl(emoji.url)) {
    return true;
  }
  
  // Has no native unicode character and ID looks like a UUID or custom ID
  if (!emoji.native && emoji.id) {
    // UUIDs have hyphens, unicode emojis don't
    if (emoji.id.includes('-')) return true;
    // If the ID is the same as the name and not a unicode character, it's likely custom
    if (emoji.id === emoji.name && !/[\u{1F300}-\u{1F9FF}]/u.test(emoji.id)) return true;
  }
  
  return false;
}

/**
 * Get the display URL for a frequently used emoji
 * Handles custom server emojis by checking stored URL or looking up in emoji cache
 */
function getFrequentEmojiDisplayUrl(emoji: { id: string; native?: string; name: string; url?: string }): string | null {
  // If it has a custom URL (not a local asset), use it
  if (emoji.url && !isLocalAssetUrl(emoji.url)) {
    return emoji.url;
  }
  
  // If it's not identified as a custom emoji, return null (let other handlers deal with it)
  if (!isCustomServerEmoji(emoji)) {
    return null;
  }
  
  // Try to look up the emoji in the cache by name
  const allServerIds = Array.from(emojiCacheStore.serverCaches.keys());
  for (const serverId of allServerIds) {
    const serverEmojis = emojiCacheStore.getServerEmojis(serverId);
    if (serverEmojis && serverEmojis.length > 0) {
      const cachedEmoji = serverEmojis.find(e => e.name === emoji.name);
      if (cachedEmoji && cachedEmoji.url) {
        return cachedEmoji.url;
      }
    }
  }
  
  return null;
}

/**
 * Get SVG URL for a frequent emoji
 * Only works for unified pack emojis (twemoji/mutant), not custom server emojis
 */
function getFrequentEmojiSvgUrl(emoji: { id: string; native?: string; name: string; url?: string }): string | null {
  if (isNativePack.value) return null;
  
  // Don't try to resolve custom server emojis as unified pack emojis
  if (isCustomServerEmoji(emoji)) return null;
  
  const unicode = emoji.native || emoji.id;
  if (!unicode) return null;
  
  const resolved = resolveEmoji(unicode);
  return resolved.display.type === 'svg' ? resolved.display.content : null;
}

/**
 * Provides content for the "no results" message.
 */
const noResultsInfo = computed(() => {
  if (searchQuery.value.trim()) {
    return {
      icon: '🔍',
      title: `No emojis found for "${searchQuery.value}"`,
      subtitle: 'Try a different search term.',
    };
  }
  return {
    icon: '😔',
    title: 'No custom emojis available',
    subtitle: 'Ask your server admin to add some emojis!',
  };
});

// --- Logic & Handlers ---

/**
 * Select an emoji from the unified emoji data
 * ALWAYS stores the UNICODE character for portability across packs
 */
const selectUnifiedEmoji = (emoji: EmojiEntry): void => {
  triggerReaction();
  
  // Record usage with the unicode character
  recordEmojiUsage({
    id: emoji.unicode,
    native: emoji.unicode,
    name: emoji.shortcode
  });
  
  // ALWAYS send the unicode character - rendering handled by display component
  const emojiObj = {
    id: emoji.unicode,
    name: emoji.shortcode,
    url: '',
    created_at: new Date(),
    uploader: '',
    server_id: ''
  } as Emoji;
  emit('sendEmoji', emojiObj);
};

const selectEmoji = (emoji: Emoji): void => {
  triggerReaction();
  
  // Record usage for frequently used list (with URL for custom emojis)
  recordEmojiUsage({
    id: emoji.id,
    name: emoji.name,
    url: emoji.url
  });
  
  emit('sendEmoji', emoji);
};

// Select from frequently used emojis (handles all types)
const selectFrequentEmoji = (emoji: { id: string; native?: string; name: string; url?: string }): void => {
  triggerReaction();
  
  let unicode = emoji.native || emoji.id;
  
  // Handle legacy mutant:path format
  if (unicode.startsWith('mutant:')) {
    const resolved = resolveEmoji(unicode);
    unicode = resolved.unicode;
  }
  
  // Custom server emoji - check stored URL or look up from cache
  const emojiUrl = getFrequentEmojiDisplayUrl(emoji);
  if (emojiUrl) {
    const emojiObj = {
      id: emoji.id,
      name: emoji.name,
      url: emojiUrl,
      created_at: new Date(),
      uploader: '',
      server_id: ''
    } as Emoji;
    emit('sendEmoji', emojiObj);
  } else {
    // Native or unified pack emoji - send unicode
    const emojiObj = {
      id: unicode,
      name: emoji.name,
      url: '',
      created_at: new Date(),
      uploader: '',
      server_id: ''
    } as Emoji;
    emit('sendEmoji', emojiObj);
  }
};

const handleClickOutside = (event: MouseEvent): void => {
  if (emojiPopup.value && !emojiPopup.value.contains(event.target as Node)) {
    props.closeEmojiList?.();
  }
};

const handleKeyDown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') {
    props.closeEmojiList?.();
  }
};

// --- Lifecycle Hooks ---

onMounted(() => {
  setTimeout(() => {
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
  }, 100);

  nextTick(() => {
    updatePosition();
    searchInput.value?.focus();
  });
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleKeyDown);
});

// --- Watchers ---

watch(
  () => props.emojiIconClicked,
  (isClicked) => {
    if (isClicked) {
      searchQuery.value = '';
    }
  },
);
</script>

<style scoped>
.emoji-popup {
  width: 320px;
  height: 400px;
  background: var(--background-primary-alpha);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  backdrop-filter: blur(10px);
}

.emoji-search {
  padding: 12px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
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
  transition: border-color 0.15s ease;
}

.search-input:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px rgba(88, 101, 242, 0.2);
}

.search-input::placeholder {
  color: var(--color-text-secondary);
}

.emoji-content {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary, var(--text-secondary));
  text-transform: uppercase;
  margin: 12px 0 6px 0;
  letter-spacing: 0.02em;
}

.section-title:first-of-type {
  margin-top: 4px;
}

.emoji-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, 36px);
  gap: 6px;
  justify-content: start;
  margin-bottom: 8px;
}

.emoji-item {
  cursor: pointer;
  transition: transform 0.15s ease, background-color 0.15s ease;
  border-radius: 4px;
  padding: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.emoji-item:hover {
  transform: scale(1.2);
  background-color: rgba(255, 255, 255, 0.1);
}

.emoji-item img,
.emoji-svg {
  width: 28px;
  height: 28px;
  border-radius: 2px;
  object-fit: contain;
}

.emoji-section {
  margin-bottom: 8px;
}

.native-emoji-item {
  width: 36px;
  height: 36px;
}

.native-emoji-item span,
.native-emoji-char {
  font-size: 24px;
  line-height: 1;
}

.svg-emoji-item {
  width: 36px;
  height: 36px;
}

.svg-emoji-item img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

.frequent-list {
  grid-template-columns: repeat(auto-fill, 36px);
}

.frequent-emoji-img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

.emoji-shortcode {
  font-size: 10px;
  color: var(--color-text-secondary, var(--text-secondary));
  word-break: break-all;
}

/* Loading state */
.emoji-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--color-text-secondary, var(--text-secondary));
  font-size: 13px;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: var(--color-primary, #5865f2);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.no-results {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--color-text-secondary, #72767d);
  font-size: 14px;
  text-align: center;
  padding: 16px;
}

.no-results-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.no-results-icon {
  font-size: 32px;
}

.no-results p {
  margin: 0;
  font-weight: 500;
}

.no-results small {
  color: var(--color-text-muted, #6f7177);
  font-size: 12px;
}

/* Scrollbar styling */
.emoji-content::-webkit-scrollbar {
  width: 8px;
}

.emoji-content::-webkit-scrollbar-track {
  background: transparent;
}

.emoji-content::-webkit-scrollbar-thumb {
  background: var(--color-bg-tertiary, #40444b);
  border-radius: 4px;
}

.emoji-content::-webkit-scrollbar-thumb:hover {
  background: var(--color-bg-hover, #4f545c);
}

@media (max-width: 768px) {
  .emoji-popup {
    width: 280px;
    height: 350px;
  }
}
</style>
