<template>
  <div class="emoji-picker-content">
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
            @click="selectFrequentEmoji(emoji)"
            @pointerenter="hoveredEmojiName = emoji.name"
            @pointerleave="hoveredEmojiName = null"
          >
            <img 
              v-if="getFrequentEmojiDisplayUrl(emoji)"
              :src="getFrequentEmojiDisplayUrl(emoji)"
              :alt="emoji.name"
              class="frequent-emoji-img"
            />
            <img 
              v-else-if="!isNativePack && getFrequentEmojiSvgUrl(emoji)"
              :src="getFrequentEmojiSvgUrl(emoji)"
              :alt="emoji.name"
              class="frequent-emoji-img"
            />
            <span v-else-if="emoji.native">{{ emoji.native }}</span>
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
              @click="selectEmoji(emoji)"
              @pointerenter="hoveredEmojiName = emoji.display_name"
              @pointerleave="hoveredEmojiName = null"
            >
              <img :src="getEmojiUrl(emoji.url, 42)" :alt="emoji.name" />
            </div>
          </div>
        </div>
      </div>
      
      <!-- Unified Emojis by Category -->
      <div v-if="unifiedLoading" class="emoji-loading">
        <span class="loading-spinner"></span>
        <span>Loading emojis...</span>
      </div>
      
      <LazyEmojiSection
        v-for="category in displayedCategories"
        :key="category.id"
        :emoji-count="category.emojis.length"
      >
        <template #header>
          <h3 class="section-title">{{ category.icon }} {{ category.name }}</h3>
        </template>
        <div class="emoji-list unified-list">
          <div
            v-for="emoji in category.emojis"
            :key="emoji.shortcode"
            class="emoji-item"
            :class="{ 'svg-emoji-item': !isNativePack, 'native-emoji-item': isNativePack }"
            @click="selectUnifiedEmoji(emoji)"
            @pointerenter="hoveredEmojiName = emoji.shortcode"
            @pointerleave="hoveredEmojiName = null"
          >
            <img 
              v-if="!isNativePack"
              :src="getEmojiSvgUrl(emoji)" 
              :alt="emoji.shortcode"
              loading="lazy"
              class="emoji-svg"
            />
            <span v-else class="native-emoji-char">{{ emoji.unicode }}</span>
          </div>
        </div>
      </LazyEmojiSection>
      
      <!-- No Results -->
      <div v-if="searchQuery && !filteredEmojiList.length && !displayedCategories.length" class="no-results">
        <div class="no-results-content">
          <div class="no-results-icon">🔍</div>
          <p>No emojis found for "{{ searchQuery }}"</p>
          <small>Try a different search term.</small>
        </div>
      </div>
    </div>

    <!-- Emoji preview bar -->
    <div class="emoji-preview-bar">
      <span v-if="hoveredEmojiName" class="emoji-preview-name">:{{ hoveredEmojiName }}:</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, nextTick } from 'vue';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import { useFrequentEmojis } from '@/composables/useFrequentEmojis';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useUnifiedEmoji, type EmojiEntry } from '@/services/unifiedEmojiService';
import type { Emoji, ResolvedEmoji } from '@/types';
import { getEmojiUrl } from '@/utils/emojiUtils';
import { EMOJI_CATEGORIES } from '@/utils/emojiConstants';
import { debug } from '@/utils/debug';
import LazyEmojiSection from '@/components/LazyEmojiSection.vue';

// Types
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

// Emits
const emit = defineEmits<{
  (e: 'sendEmoji', emoji: Emoji): void;
}>();

// State & Composables
const emojiCacheStore = useEmojiCacheStore();
const { topEmojisForPicker, hasFrequentEmojis, recordEmojiUsage } = useFrequentEmojis();
const { triggerReaction } = useHapticSettings();
const { 
  isNativePack, 
  isTwemojiPack,
  isLoaded: unifiedLoaded,
  isLoading: unifiedLoading,
  getAllEmojis,
  getCategories,
  resolveEmoji,
  getTwemojiUrl,
} = useUnifiedEmoji();

const searchInput = ref<HTMLInputElement | null>(null);
const searchQuery = ref('');
const hoveredEmojiName = ref<string | null>(null);

// Computed: Filtered emoji list
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

// Computed: Displayed categories from unified emoji service
const displayedCategories = computed((): DisplayCategory[] => {
  if (!unifiedLoaded.value) return [];
  
  const query = searchQuery.value.toLowerCase().trim();
  const allEmojis = getAllEmojis();
  
  const categoryMap = new Map<string, EmojiEntry[]>();
  for (const emoji of allEmojis) {
    const catId = emoji.category;
    if (!categoryMap.has(catId)) {
      categoryMap.set(catId, []);
    }
    categoryMap.get(catId)!.push(emoji);
  }
  
  const serviceCats = getCategories();
  const categoryMetadata = serviceCats.length > 0 ? serviceCats : EMOJI_CATEGORIES;
  
  const categories: DisplayCategory[] = [];
  
  for (const meta of categoryMetadata) {
    const emojis = categoryMap.get(meta.id) || [];
    if (emojis.length === 0) continue;
    
    let filteredEmojis = emojis;
    
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
  
  return categories.sort((a, b) => a.order - b.order);
});

// Helper functions
function getEmojiSvgUrl(emoji: EmojiEntry): string {
  if (isNativePack.value) return '';
  
  if (isTwemojiPack.value) {
    const url = getTwemojiUrl(emoji.unicode);
    if (url) return url;
  }
  
  if (emoji.svgPath) {
    return `/assets/emojis/mutant_emojis_svg/${emoji.svgPath}`;
  }
  
  const resolved = resolveEmoji(emoji.unicode);
  return resolved.display.type === 'svg' ? resolved.display.content : '';
}

function isLocalAssetUrl(url: string): boolean {
  return url.startsWith('/assets/') || 
         url.includes('/twemoji/') || 
         url.includes('/mutant_emojis_svg/');
}

function isCustomServerEmoji(emoji: { id: string; native?: string; name: string; url?: string }): boolean {
  if (emoji.url && !isLocalAssetUrl(emoji.url)) return true;
  if (!emoji.native && emoji.id) {
    if (emoji.id.includes('-')) return true;
    if (emoji.id === emoji.name && !/[\u{1F300}-\u{1F9FF}]/u.test(emoji.id)) return true;
  }
  return false;
}

function getFrequentEmojiDisplayUrl(emoji: { id: string; native?: string; name: string; url?: string }): string | null {
  if (emoji.url && !isLocalAssetUrl(emoji.url)) return getEmojiUrl(emoji.url, 42);
  if (!isCustomServerEmoji(emoji)) return null;
  
  const allServerIds = Array.from(emojiCacheStore.serverCaches.keys());
  for (const serverId of allServerIds) {
    const serverEmojis = emojiCacheStore.getServerEmojis(serverId);
    if (serverEmojis && serverEmojis.length > 0) {
      const cachedEmoji = serverEmojis.find(e => e.name === emoji.name);
      if (cachedEmoji && cachedEmoji.url) return getEmojiUrl(cachedEmoji.url, 42);
    }
  }
  return null;
}

function getFrequentEmojiSvgUrl(emoji: { id: string; native?: string; name: string; url?: string }): string | null {
  if (isNativePack.value) return null;
  if (isCustomServerEmoji(emoji)) return null;
  
  const unicode = emoji.native || emoji.id;
  if (!unicode) return null;
  
  const resolved = resolveEmoji(unicode);
  return resolved.display.type === 'svg' ? resolved.display.content : null;
}

// Selection handlers
const selectUnifiedEmoji = (emoji: EmojiEntry): void => {
  triggerReaction();
  
  recordEmojiUsage({
    id: emoji.unicode,
    native: emoji.unicode,
    name: emoji.shortcode
  });
  
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
  
  recordEmojiUsage({
    id: emoji.id,
    name: emoji.name,
    url: emoji.url
  });
  
  emit('sendEmoji', emoji);
};

const selectFrequentEmoji = (emoji: { id: string; native?: string; name: string; url?: string }): void => {
  triggerReaction();
  
  let unicode = emoji.native || emoji.id;
  
  if (unicode.startsWith('mutant:')) {
    const resolved = resolveEmoji(unicode);
    unicode = resolved.unicode;
  }
  
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

// Lifecycle
onMounted(async () => {
  const { triggerEmojiDataLoad } = await import('@/composables/useEmojiLoader');
  triggerEmojiDataLoad();
  
  if (!unifiedLoaded.value && !unifiedLoading.value) {
    import('@/services/unifiedEmojiService').then(({ loadEmojiData }) => {
      loadEmojiData().catch(err => {
        debug.warn('Failed to load unified emoji data:', err);
      });
    });
  }
  
  nextTick(() => {
    searchInput.value?.focus();
  });
});
</script>

<style scoped>
.emoji-picker-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.emoji-search {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  background: var(--harmony-senary-alpha);
}

.search-input {
  width: 100%;
  padding: 8px 12px;
  background: var(--harmony-senary-alpha);
  border: none;
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  transition: background 0.15s ease;
}

.search-input:focus {
  background: var(--background-secondary);
}

.search-input::placeholder {
  color: var(--text-muted);
}

.emoji-content {
  flex: 1;
  overflow-y: scroll;
  padding: 8px;
  scrollbar-gutter: stable;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
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
  color: var(--text-secondary);
  word-break: break-all;
}

/* Loading state */
.emoji-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--text-secondary);
  font-size: 13px;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: var(--color-primary);
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
  color: var(--text-secondary);
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
  color: var(--text-muted);
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
  background: var(--harmony-senary-alpha, rgba(10, 11, 13, 0.8));
  border-radius: 4px;
}

.emoji-content::-webkit-scrollbar-thumb:hover {
  background: var(--background-senary, #0a0b0d);
}

.emoji-preview-bar {
  height: 28px;
  padding: 0 12px;
  border-top: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.emoji-preview-name {
  font-size: 12px;
  color: var(--color-text-secondary, var(--text-secondary));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

