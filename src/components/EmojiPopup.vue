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
            :class="{ 'native-emoji-item': emoji.native && !emoji.url, 'mutant-emoji-item': emoji.url }"
            :title="`:${emoji.name}:`"
            @click="selectFrequentEmoji(emoji)"
          >
            <!-- Custom/Mutant emoji with URL -->
            <img 
              v-if="emoji.url"
              :src="emoji.url"
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
      <div v-if="mutantLoading" class="emoji-loading">
        <span class="loading-spinner"></span>
        <span>Loading emojis...</span>
      </div>
      
      <div v-for="category in displayedMutantCategories" :key="category.id" class="emoji-section">
        <h3 class="section-title">{{ category.icon }} {{ category.name }}</h3>
        <div class="emoji-list mutant-list">
          <div
            v-for="emoji in category.emojis"
            :key="emoji.shortcode"
            class="emoji-item"
            :class="{ 'mutant-emoji-item': !isNativePack, 'native-emoji-item': isNativePack }"
            :title="`:${emoji.shortcode}:`"
            @click="selectUnifiedEmoji(emoji)"
          >
            <!-- Mutant pack: show SVG -->
            <img 
              v-if="!isNativePack"
              :src="`/assets/emojis/mutant_emojis_svg/${emoji.svgPath}`" 
              :alt="emoji.shortcode"
              loading="lazy"
            />
            <!-- Native pack: show unicode -->
            <span v-else class="native-emoji-char">{{ emoji.unicode }}</span>
          </div>
        </div>
      </div>
      
      <!-- No Results -->
      <div v-if="searchQuery && !filteredEmojiList.length && !displayedMutantCategories.length" class="no-results">
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
import { debug } from '@/utils/debug';

// Legacy interface for backwards compatibility
interface NativeEmojiItem {
  content: string;
  name: string;
}

// --- Types ---

interface FilteredServerEmojiGroup {
  serverId: string;
  server_name: string;
  server_icon?: string;
  emojis: ResolvedEmoji[];
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
  currentPack,
  isLoaded: unifiedLoaded,
  isLoading: unifiedLoading,
  getAllEmojis,
  getCategories,
  searchEmojis,
  resolveEmoji,
  getSvgUrl
} = useUnifiedEmoji();

const emojiPopup = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const searchQuery = ref('');
const hoveredEmojiId = ref<string | null>(null);

// Loading state for unified emoji data
const mutantLoading = computed(() => unifiedLoading.value);
const mutantLoaded = computed(() => unifiedLoaded.value);

// Category icons for display
const categoryIcons: Record<string, string> = {
  'expressions': '😊',
  'food_drink_herbs': '🍕',
  'activities_clothing': '🎮',
  'nature': '🌿',
  'objects': '🔧',
  'symbols': '❤️',
  'travel_places': '✈️',
  'people': '👋',
  'extra': '✨'
};

// --- Composables ---

const triggerElementRef = computed(() => props.triggerElement || null);
const { positionStyle, updatePosition } = usePopupPositioning(
  triggerElementRef,
  { width: 320, height: 400 }, // Dimensions of the popup
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

  // If there's no search query, return all non-empty servers
  if (!query) {
    return allEmojisByServer
      .map(([serverId, data]) => ({ serverId, ...data }))
      .filter((group) => group.emojis.length > 0);
  }

  // If there is a search query, filter emojis within each server group
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
    .filter((group) => group.emojis.length > 0); // Only include groups with matching emojis
});

/**
 * Displayed emoji categories from unified emoji service
 * Works for both native and mutant pack - rendering differs
 */
const displayedMutantCategories = computed(() => {
  if (!mutantLoaded.value) return [];
  
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
  
  // Convert to array with category metadata
  const categories = Array.from(categoryMap.entries()).map(([catId, emojis]) => ({
    id: catId,
    name: catId.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
    icon: categoryIcons[catId] || '📦',
    emojis
  }));
  
  if (!query) {
    return categories;
  }
  
  // Filter emojis when searching
  return categories
    .map(cat => ({
      ...cat,
      emojis: cat.emojis.filter(emoji => 
        emoji.shortcode.toLowerCase().includes(query) ||
        emoji.description.toLowerCase().includes(query) ||
        emoji.keywords?.some(kw => kw.toLowerCase().includes(query))
      )
    }))
    .filter(cat => cat.emojis.length > 0);
});

/**
 * Provides content for the "no results" message, adapting to the context.
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
  
  // ALWAYS send the unicode character - rendering will be handled by the display component
  // based on user's pack preference
  const emojiObj = {
    id: emoji.unicode,  // Unicode character for storage
    name: emoji.shortcode,
    url: '',  // Empty - rendering handled by resolveEmoji at display time
    created_at: new Date(),
    uploader: '',
    server_id: ''
  } as Emoji;
  emit('sendEmoji', emojiObj);
};

// Alias for backwards compatibility with template
const selectMutantEmoji = selectUnifiedEmoji;

const selectEmoji = (emoji: Emoji): void => {
  triggerReaction();
  emit('sendEmoji', emoji);
};

// Select from frequently used emojis (handles all types)
const selectFrequentEmoji = (emoji: { id: string; native?: string; name: string; url?: string }): void => {
  triggerReaction();
  
  // Determine the unicode to use
  let unicode = emoji.native || emoji.id;
  
  // If it's a legacy mutant:path format, try to resolve to unicode
  if (unicode.startsWith('mutant:')) {
    const resolved = resolveEmoji(unicode);
    unicode = resolved.unicode;
  }
  
  // Custom server emoji with URL (not from unified pack)
  if (emoji.url && !emoji.url.includes('/mutant_emojis_svg/')) {
    const emojiObj = {
      id: emoji.id,
      name: emoji.name,
      url: emoji.url,
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
  // Close the popup when clicking outside
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
  // Add event listeners with a small delay to prevent immediate closure
  setTimeout(() => {
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
  }, 100);

  nextTick(() => {
    updatePosition();
    searchInput.value?.focus();
  });
  
  // Unified emoji data is loaded automatically by the service
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleKeyDown);
});

// --- Watchers ---

/**
 * Clear the search query when the popup is re-opened.
 */
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
  border: 1px solid var(--border-color);
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

.server-name,
.section-title {
  font-size: 11px;
  font-weight: 600;
  color: #b9bbbe;
  text-transform: uppercase;
  margin: 12px 0 6px 0;
  letter-spacing: 0.02em;
}

.server-name:first-of-type,
.section-title:first-of-type {
  margin-top: 4px;
}

.emoji-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, 32px);
  gap: 8px;
  justify-content: space-between;
  margin-bottom: 8px;
}

.emoji-item {
  cursor: pointer;
  transition: transform 0.2s ease;
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

.emoji-item img {
  width: 28px;
  height: 28px;
  border-radius: 2px;
  object-fit: contain;
}

.emoji-section {
  margin-bottom: 8px;
}

.native-list {
  grid-template-columns: repeat(auto-fill, 36px);
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

/* Mutant emoji styles */
.mutant-list {
  grid-template-columns: repeat(auto-fill, 36px);
}

.mutant-emoji-item {
  width: 36px;
  height: 36px;
}

.mutant-emoji-item img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

/* Frequent emoji list */
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
  color: var(--text-secondary, #b9bbbe);
  word-break: break-all;
}

/* Loading state */
.emoji-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--text-secondary, #b9bbbe);
  font-size: 13px;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: var(--h-primary, #5865f2);
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
  color: #72767d;
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
  color: #6f7177;
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
  background: #40444b;
  border-radius: 4px;
}

.emoji-content::-webkit-scrollbar-thumb:hover {
  background: #4f545c;
}

@media (max-width: 768px) {
  .emoji-popup {
    width: 280px;
    height: 350px;
  }
}
</style>