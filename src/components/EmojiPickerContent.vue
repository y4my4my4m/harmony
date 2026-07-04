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
      <!-- Favorite Emojis (always visible) -->
      <div v-if="!searchQuery" class="emoji-section">
        <h3
          class="section-title section-title-collapsible"
          @click="toggleSection('favorites')"
        >
          <span class="section-chevron" :class="{ collapsed: isSectionCollapsed('favorites') }">&#9662;</span>
          &#11088; Favorites
        </h3>
        <template v-if="!isSectionCollapsed('favorites')">
          <div v-if="favoriteEmojis.length" class="emoji-list favorite-list">
            <div
              v-for="fav in favoriteEmojis"
              :key="fav.emoji_id"
              class="emoji-item"
              :class="{ 'native-emoji-item': isNativePack && !fav.emoji_url, 'svg-emoji-item': !isNativePack || fav.emoji_url }"
              @click="selectFavoriteEmoji(fav)"
              @contextmenu.prevent="openEmojiCtxFavorite(fav, $event)"
              @touchstart="handleTouchHold($event, (e) => openEmojiCtxFavorite(fav, e))"
              @pointerenter="hoveredEmojiName = fav.emoji_name"
              @pointerleave="hoveredEmojiName = null"
            >
              <img
                v-if="fav.emoji_url"
                :src="getEmojiUrl(fav.emoji_url, 42)"
                :alt="fav.emoji_name"
                class="frequent-emoji-img"
              />
              <img
                v-else-if="!isNativePack && getFavoriteSvgUrl(fav)"
                :src="getFavoriteSvgUrl(fav)!"
                :alt="fav.emoji_name"
                class="frequent-emoji-img"
              />
              <span v-else class="native-emoji-char">{{ fav.emoji_id }}</span>
            </div>
          </div>
          <div v-else class="no-favorites-hint">
            <p>Right-click (or touch and hold) any emoji to add it here.</p>
          </div>
        </template>
      </div>

      <!-- Frequently Used Emojis -->
      <div v-if="!searchQuery && hasFrequentEmojis" class="emoji-section">
        <h3
          class="section-title section-title-collapsible"
          @click="toggleSection('frequent')"
        >
          <span class="section-chevron" :class="{ collapsed: isSectionCollapsed('frequent') }">&#9662;</span>
          ⏱️ Frequently Used
        </h3>
        <div v-if="!isSectionCollapsed('frequent')" class="emoji-list frequent-list">
          <div
            v-for="emoji in topEmojisForPicker"
            :key="emoji.id"
            class="emoji-item"
            :class="{ 'native-emoji-item': isNativePack, 'svg-emoji-item': !isNativePack }"
            @click="selectFrequentEmoji(emoji)"
            @contextmenu.prevent="openEmojiCtxFrequent(emoji, $event)"
            @touchstart="handleTouchHold($event, (e) => openEmojiCtxFrequent(emoji, e))"
            @pointerenter="hoveredEmojiName = emoji.name"
            @pointerleave="hoveredEmojiName = null"
          >
            <template v-if="getFrequentEmojiDisplayUrl(emoji)">
              <svg v-if="brokenEmojiUrls.has(getFrequentEmojiDisplayUrl(emoji)!)" class="emoji-broken-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><line x1="13.5" y1="13.5" x2="6" y2="21"/><line x1="18" y1="12" x2="21" y2="15"/><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/></svg>
              <img v-else :src="getFrequentEmojiDisplayUrl(emoji) ?? undefined" :alt="emoji.name" class="frequent-emoji-img" @error="brokenEmojiUrls.add(getFrequentEmojiDisplayUrl(emoji)!)" />
            </template>
            <img
              v-else-if="!isNativePack && getFrequentEmojiSvgUrl(emoji)"
              :src="getFrequentEmojiSvgUrl(emoji) ?? undefined"
              :alt="emoji.name"
              class="frequent-emoji-img"
            />
            <span v-else-if="emoji.native">{{ emoji.native }}</span>
            <span v-else class="emoji-shortcode">:{{ emoji.name }}:</span>
          </div>
        </div>
      </div>

      <!-- AI Generated Emoji (own category) -->
      <div v-if="showAiSection" class="emoji-section">
        <h3
          class="section-title section-title-collapsible"
          @click="toggleSection('ai-generated')"
        >
          <span class="section-chevron" :class="{ collapsed: isSectionCollapsed('ai-generated') }">&#9662;</span>
          ✨ AI Generated
        </h3>
        <template v-if="!isSectionCollapsed('ai-generated')">
          <div v-if="aiEmojis.length" class="emoji-list">
            <div
              v-for="emoji in aiEmojis"
              :key="emoji.id"
              class="emoji-item"
              @click="selectEmoji(emoji)"
              @contextmenu.prevent="openEmojiCtxServer(emoji, $event)"
              @touchstart="handleTouchHold($event, (e) => openEmojiCtxServer(emoji, e))"
              @pointerenter="hoveredEmojiName = emoji.display_name"
              @pointerleave="hoveredEmojiName = null"
            >
              <svg v-if="brokenEmojiUrls.has(emoji.url)" class="emoji-broken-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><line x1="13.5" y1="13.5" x2="6" y2="21"/><line x1="18" y1="12" x2="21" y2="15"/><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/></svg>
              <img v-else :src="getEmojiUrl(emoji.url, 42)" :alt="emoji.name" @error="brokenEmojiUrls.add(emoji.url)" />
            </div>
          </div>
        </template>
      </div>

      <!-- Server Emojis List -->
      <div v-if="filteredEmojiList.length">
        <div v-for="group in filteredEmojiList" :key="group.serverId" class="emoji-section">
          <h3
            class="section-title section-title-collapsible"
            @click="toggleSection('server-' + group.serverId)"
          >
            <span class="section-chevron" :class="{ collapsed: isSectionCollapsed('server-' + group.serverId) }">&#9662;</span>
            <ServerIcon :src="group.server_icon" size="mini" shape="rounded" :show-title="false" class="section-server-icon" />
            {{ group.server_name }}
          </h3>
          <div v-if="!isSectionCollapsed('server-' + group.serverId)" class="emoji-list">
            <div
              v-for="emoji in group.emojis"
              :key="emoji.id"
              class="emoji-item"
              @click="selectEmoji(emoji)"
              @contextmenu.prevent="openEmojiCtxServer(emoji, $event)"
              @touchstart="handleTouchHold($event, (e) => openEmojiCtxServer(emoji, e))"
              @pointerenter="hoveredEmojiName = emoji.display_name"
              @pointerleave="hoveredEmojiName = null"
            >
              <svg v-if="brokenEmojiUrls.has(emoji.url)" class="emoji-broken-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><line x1="13.5" y1="13.5" x2="6" y2="21"/><line x1="18" y1="12" x2="21" y2="15"/><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/></svg>
              <img v-else :src="getEmojiUrl(emoji.url, 42)" :alt="emoji.name" @error="brokenEmojiUrls.add(emoji.url)" />
            </div>
          </div>
        </div>
      </div>
      
      <!-- Unified Emojis by Category -->
      <div v-if="unifiedLoading" class="emoji-loading">
        <LoadingSpinner :size="16" />
        <span>Loading emojis...</span>
      </div>
      
      <LazyEmojiSection
        v-for="category in displayedCategories"
        :key="category.id"
        :emoji-count="isSectionCollapsed('cat-' + category.id) ? 0 : category.emojis.length"
      >
        <template #header>
          <h3
            class="section-title section-title-collapsible"
            @click="toggleSection('cat-' + category.id)"
          >
            <span class="section-chevron" :class="{ collapsed: isSectionCollapsed('cat-' + category.id) }">&#9662;</span>
            {{ category.icon }} {{ category.name }}
          </h3>
        </template>
        <div v-if="!isSectionCollapsed('cat-' + category.id)" class="emoji-list unified-list">
          <div
            v-for="emoji in category.emojis"
            :key="emoji.shortcode"
            class="emoji-item"
            :class="{ 'svg-emoji-item': !isNativePack, 'native-emoji-item': isNativePack }"
            @click="selectUnifiedEmoji(emoji)"
            @contextmenu.prevent="openEmojiCtxUnified(emoji, $event)"
            @touchstart="handleTouchHold($event, (e) => openEmojiCtxUnified(emoji, e))"
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

    <!-- Favorite toast -->
    <Transition name="fav-toast">
      <div v-if="favToast" class="fav-toast">{{ favToast }}</div>
    </Transition>

    <!-- Emoji right-click context menu -->
    <Teleport to="body">
      <div
        v-if="emojiCtx.visible"
        ref="emojiCtxBackdropRef"
        data-emoji-ctx-backdrop
        class="emoji-ctx-backdrop"
        @click="closeEmojiCtx"
        @contextmenu.prevent="closeEmojiCtx"
      >
        <div
          class="emoji-ctx-menu"
          :style="{ top: emojiCtx.y + 'px', left: emojiCtx.x + 'px' }"
          @click.stop
        >
          <div class="emoji-ctx-item" @click="ctxToggleFavorite">
            <span>{{ emojiCtx.isFav ? 'Unfavorite Emoji' : 'Favorite Emoji' }}</span>
          </div>
          <div class="emoji-ctx-item" @click="ctxCopyId">
            <span>Copy Emoji ID</span>
            <span class="emoji-ctx-badge">ID</span>
          </div>
          <div v-if="emojiCtx.imageUrl" class="emoji-ctx-item" @click="ctxCopyImageLink">
            <span>Copy Image Link</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          </div>
          <div v-if="emojiCtx.isFrequent" class="emoji-ctx-item emoji-ctx-item-danger" @click="ctxRemoveFrequent">
            <span>Remove from frequently used</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, nextTick, watch } from 'vue';
import { useEmojiCacheStore, PERSONAL_EMOJI_GROUPS } from '@/stores/useEmojiCache';
import { KLIPY_EPHEMERAL_GROUP, registerEphemeralEmoji } from '@/utils/ephemeralEmoji';
import { authContextService } from '@/services/AuthContextService';
import { useFrequentEmojis } from '@/composables/useFrequentEmojis';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useUnifiedEmoji, type EmojiEntry } from '@/services/unifiedEmojiService';
import { emojiFavoriteService, type EmojiFavorite } from '@/services/EmojiFavoriteService';
import type { Emoji, ResolvedEmoji } from '@/types';
import { getEmojiUrl } from '@/utils/emojiUtils';
import { EMOJI_CATEGORIES } from '@/utils/emojiConstants';
import { debug } from '@/utils/debug';
import LazyEmojiSection from '@/components/LazyEmojiSection.vue';
import ServerIcon from '@/components/common/ServerIcon.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { useServerChannelStore } from '@/stores/useServerChannel';

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

// Props
defineProps<{
  showFavorites?: boolean;
}>();

// Emits
const emit = defineEmits<{
  (e: 'sendEmoji', emoji: Emoji): void;
  (e: 'update:showFavorites', value: boolean): void;
}>();

// State & Composables
const brokenEmojiUrls = ref(new Set<string>());
const emojiCacheStore = useEmojiCacheStore();
const serverChannelStore = useServerChannelStore();

const { topEmojisForPicker, hasFrequentEmojis, recordEmojiUsage, removeFrequentEmoji, isFrequentEmoji } = useFrequentEmojis();
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
const favoriteEmojis = ref<EmojiFavorite[]>([]);
// The instance emoji set can be large and is rarely the user's first choice, so
// it starts collapsed - its images aren't mounted/fetched until expanded.
const collapsedSections = ref(new Set<string>([`server-${PERSONAL_EMOJI_GROUPS.instance}`]));

const toggleSection = (id: string) => {
  const s = new Set(collapsedSections.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  collapsedSections.value = s;
};

const isSectionCollapsed = (id: string) => {
  // During an active search, force every section open so users actually
  // see the matching results. Otherwise a collapsed category that happens
  // to contain a match would look like it found nothing (the section
  // header would render but the emoji list would stay hidden).
  // The user's manual collapse state is preserved in `collapsedSections`
  // and re-applies once the query is cleared.
  if (searchQuery.value.trim()) return false;
  return collapsedSections.value.has(id);
};

// Computed: Filtered emoji list (current server first)
const filteredEmojiList = computed((): FilteredServerEmojiGroup[] => {
  const query = searchQuery.value.toLowerCase().trim();
  // AI Generated has its own dedicated section below; everything else (servers,
  // plus the synthetic "My Emoji" / "Instance Emoji" groups) renders here.
  const allEmojisByServer = Object.entries(emojiCacheStore.resolvedEmojis)
    .filter(([serverId]) => serverId !== PERSONAL_EMOJI_GROUPS.ai && serverId !== KLIPY_EPHEMERAL_GROUP);
  const currentId = serverChannelStore.currentServerId;

  const sortCurrentFirst = (list: FilteredServerEmojiGroup[]) =>
    list.sort((a, b) => {
      if (a.serverId === currentId) return -1;
      if (b.serverId === currentId) return 1;
      return 0;
    });

  if (!query) {
    return sortCurrentFirst(
      allEmojisByServer
        .map(([serverId, data]) => ({ serverId, ...data }))
        .filter((group) => group.emojis.length > 0)
    );
  }

  return sortCurrentFirst(
    allEmojisByServer
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
      .filter((group) => group.emojis.length > 0)
  );
});

// The viewer's AI-generated emoji (filtered by the active search query).
const aiEmojis = computed((): ResolvedEmoji[] => {
  const group = emojiCacheStore.resolvedEmojis[PERSONAL_EMOJI_GROUPS.ai];
  const list = group?.emojis ?? [];
  const query = searchQuery.value.toLowerCase().trim();
  if (!query) return list;
  return list.filter(
    (e) => e.name.toLowerCase().includes(query) || e.display_name.toLowerCase().includes(query),
  );
});

const showAiSection = computed(() => aiEmojis.value.length > 0);

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
  
  const resolved = resolveEmoji(emoji.unicode);
  return resolved.display.type === 'svg' ? resolved.display.content : '';
}

function isLocalAssetUrl(url: string): boolean {
  return url.startsWith('/assets/') || 
         url.includes('/twemoji/');
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
    // Ephemeral (Klipy/remote) emoji use their URL as the id and aren't in the
    // session cache after a reload - re-register so the :shortcode: resolves.
    if (emoji.id.startsWith('http')) {
      registerEphemeralEmoji(emojiObj);
    }
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

// Favorites
async function loadFavorites() {
  favoriteEmojis.value = await emojiFavoriteService.getFavorites();
}

function getFavoriteSvgUrl(fav: EmojiFavorite): string | null {
  if (isNativePack.value) return null;
  if (fav.emoji_url) return null;
  const resolved = resolveEmoji(fav.emoji_id);
  return resolved.display.type === 'svg' ? resolved.display.content : null;
}

function selectFavoriteEmoji(fav: EmojiFavorite) {
  triggerReaction();
  recordEmojiUsage({ id: fav.emoji_id, name: fav.emoji_name, url: fav.emoji_url || undefined });
  emit('sendEmoji', {
    id: fav.emoji_id,
    name: fav.emoji_name,
    url: fav.emoji_url || '',
    created_at: new Date(),
    uploader: '',
    server_id: fav.emoji_server_id || ''
  } as Emoji);
}

// eslint-disable-next-line unused-imports/no-unused-vars
async function removeFavoriteEmoji(emojiId: string) {
  await emojiFavoriteService.removeFavorite(emojiId);
  favoriteEmojis.value = favoriteEmojis.value.filter(f => f.emoji_id !== emojiId);
}

const favToast = ref<string | null>(null);
let favToastTimer: ReturnType<typeof setTimeout> | null = null;

function showFavToast(msg: string) {
  favToast.value = msg;
  if (favToastTimer) clearTimeout(favToastTimer);
  favToastTimer = setTimeout(() => { favToast.value = null; }, 1500);
}

// eslint-disable-next-line unused-imports/no-unused-vars
async function toggleFavoriteUnified(emoji: EmojiEntry) {
  try {
    const result = await emojiFavoriteService.toggleFavorite(emoji.unicode, emoji.shortcode, null, null);
    showFavToast(result.isFavorite ? `⭐ Added :${emoji.shortcode}:` : `Removed :${emoji.shortcode}:`);
    await loadFavorites();
  } catch (e) {
    debug.error('Failed to toggle favorite:', e);
  }
}

// eslint-disable-next-line unused-imports/no-unused-vars
async function toggleFavoriteServer(emoji: ResolvedEmoji) {
  try {
    const url = emoji.url ? getEmojiUrl(emoji.url, 42) : null;
    const result = await emojiFavoriteService.toggleFavorite(emoji.id, emoji.name, url, emoji.server_id || null);
    showFavToast(result.isFavorite ? `⭐ Added :${emoji.name}:` : `Removed :${emoji.name}:`);
    await loadFavorites();
  } catch (e) {
    debug.error('Failed to toggle favorite:', e);
  }
}

// eslint-disable-next-line unused-imports/no-unused-vars
async function toggleFavoriteFrequent(emoji: { id: string; native?: string; name: string; url?: string }) {
  try {
    const emojiId = emoji.native || emoji.id;
    const url = getFrequentEmojiDisplayUrl(emoji);
    const result = await emojiFavoriteService.toggleFavorite(emojiId, emoji.name, url, null);
    showFavToast(result.isFavorite ? `⭐ Added :${emoji.name}:` : `Removed :${emoji.name}:`);
    await loadFavorites();
  } catch (e) {
    debug.error('Failed to toggle favorite:', e);
  }
}

// --- Emoji Context Menu ---
interface EmojiCtxState {
  visible: boolean;
  x: number;
  y: number;
  emojiId: string;
  emojiName: string;
  imageUrl: string | null;
  serverIdOrNull: string | null;
  isFav: boolean;
  isFrequent: boolean;
}

const emojiCtx = ref<EmojiCtxState>({
  visible: false, x: 0, y: 0,
  emojiId: '', emojiName: '', imageUrl: null, serverIdOrNull: null, isFav: false, isFrequent: false,
});

function positionCtxMenu(event: MouseEvent | Touch): { x: number; y: number } {
  const menuW = 200, menuH = 120;
  let x = event.clientX;
  let y = event.clientY;
  // On touch: position menu well above finger so it's not hidden under the thumb
  const isTouch = !('button' in event);
  if (isTouch) {
    y = Math.max(8, y - menuH - 80);
  }
  if (x + menuW > window.innerWidth - 8) x = window.innerWidth - menuW - 8;
  if (x < 8) x = 8;
  if (y + menuH > window.innerHeight - 8) y = window.innerHeight - menuH - 8;
  if (y < 8) y = 8;
  return { x, y };
}

let holdTimeoutId: ReturnType<typeof setTimeout> | null = null;
let holdListenersAdded = false;

function clearHold() {
  if (holdTimeoutId) {
    clearTimeout(holdTimeoutId);
    holdTimeoutId = null;
  }
  if (holdListenersAdded) {
    document.removeEventListener('touchend', onHoldTouchEnd);
    document.removeEventListener('touchmove', onHoldTouchMove);
    holdListenersAdded = false;
  }
}

function onHoldTouchEnd() {
  clearHold();
}

function onHoldTouchMove() {
  clearHold();
}

function handleTouchHold(event: TouchEvent, ctxHandler: (e: MouseEvent | Touch) => void) {
  const touch = event.touches[0];
  if (!touch) return;
  clearHold();
  holdTimeoutId = setTimeout(() => {
    holdTimeoutId = null;
    clearHold();
    event.preventDefault();
    ctxHandler(touch);
    // Prevent the upcoming touchend from firing a synthetic click (which would select the emoji)
    const preventClick = (e: TouchEvent) => {
      e.preventDefault();
      document.removeEventListener('touchend', preventClick, { capture: true });
    };
    document.addEventListener('touchend', preventClick, { capture: true, once: true });
  }, 500);
  document.addEventListener('touchend', onHoldTouchEnd);
  document.addEventListener('touchmove', onHoldTouchMove, { passive: true });
  holdListenersAdded = true;
}

function openEmojiCtxUnified(emoji: EmojiEntry, event: MouseEvent | Touch) {
  const pos = positionCtxMenu(event);
  const imgUrl = isNativePack.value ? null : getEmojiSvgUrl(emoji);
  const emojiId = emoji.unicode;
  emojiCtx.value = {
    visible: true, ...pos,
    emojiId, emojiName: emoji.shortcode,
    imageUrl: imgUrl, serverIdOrNull: null,
    isFav: emojiFavoriteService.isFavorite(emojiId),
    isFrequent: isFrequentEmoji(emojiId),
  };
}

function openEmojiCtxServer(emoji: ResolvedEmoji, event: MouseEvent | Touch) {
  const pos = positionCtxMenu(event);
  const imgUrl = emoji.url ? getEmojiUrl(emoji.url, 42) : null;
  emojiCtx.value = {
    visible: true, ...pos,
    emojiId: emoji.id, emojiName: emoji.name,
    imageUrl: imgUrl, serverIdOrNull: emoji.server_id || null,
    isFav: emojiFavoriteService.isFavorite(emoji.id),
    isFrequent: isFrequentEmoji(emoji.id),
  };
}

function openEmojiCtxFrequent(emoji: { id: string; native?: string; name: string; url?: string }, event: MouseEvent | Touch) {
  const pos = positionCtxMenu(event);
  const emojiId = emoji.native || emoji.id;
  const imgUrl = getFrequentEmojiDisplayUrl(emoji) || (isNativePack.value ? null : getFrequentEmojiSvgUrl(emoji));
  emojiCtx.value = {
    visible: true, ...pos,
    emojiId, emojiName: emoji.name,
    imageUrl: imgUrl, serverIdOrNull: null,
    isFav: emojiFavoriteService.isFavorite(emojiId),
    isFrequent: true,
  };
}

function openEmojiCtxFavorite(fav: EmojiFavorite, event: MouseEvent | Touch) {
  const pos = positionCtxMenu(event);
  const imgUrl = fav.emoji_url || (isNativePack.value ? null : getFavoriteSvgUrl(fav));
  const emojiId = fav.emoji_id;
  emojiCtx.value = {
    visible: true, ...pos,
    emojiId, emojiName: fav.emoji_name,
    imageUrl: imgUrl, serverIdOrNull: fav.emoji_server_id || null,
    isFav: true,
    isFrequent: isFrequentEmoji(emojiId),
  };
}

function closeEmojiCtx() {
  emojiCtx.value = { ...emojiCtx.value, visible: false };
}

async function ctxToggleFavorite() {
  const ctx = emojiCtx.value;
  closeEmojiCtx();
  try {
    const result = await emojiFavoriteService.toggleFavorite(ctx.emojiId, ctx.emojiName, ctx.imageUrl, ctx.serverIdOrNull);
    showFavToast(result.isFavorite ? `⭐ Added :${ctx.emojiName}:` : `Removed :${ctx.emojiName}:`);
    await loadFavorites();
  } catch (e) {
    debug.error('Failed to toggle favorite:', e);
  }
}

async function ctxCopyId() {
  const ctx = emojiCtx.value;
  closeEmojiCtx();
  try {
    await navigator.clipboard.writeText(ctx.emojiId);
    showFavToast(`Copied :${ctx.emojiName}:`);
  } catch { /* no-op */ }
}

async function ctxCopyImageLink() {
  const ctx = emojiCtx.value;
  closeEmojiCtx();
  if (!ctx.imageUrl) return;
  try {
    await navigator.clipboard.writeText(ctx.imageUrl);
    showFavToast('Copied image link');
  } catch { /* no-op */ }
}

function ctxRemoveFrequent() {
  const ctx = emojiCtx.value;
  closeEmojiCtx();
  removeFrequentEmoji(ctx.emojiId);
  showFavToast(`Removed :${ctx.emojiName}: from frequently used`);
}

// Collapse all unified emoji categories by default once loaded
let categoriesInitialized = false;
watch(displayedCategories, (cats) => {
  if (!categoriesInitialized && cats.length > 0) {
    categoriesInitialized = true;
    const s = new Set(collapsedSections.value);
    for (const cat of cats) {
      s.add('cat-' + cat.id);
    }
    collapsedSections.value = s;
  }
}, { immediate: true });

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
  
  await emojiFavoriteService.initializeCache();
  loadFavorites();

  // Load the viewer's personal + instance emoji (incl. AI Generated) so they
  // appear as picker categories and resolve in :shortcode: at send time.
  authContextService.getCurrentContext()
    .then((ctx) => emojiCacheStore.loadPersonalEmojis(ctx.profileId ?? null))
    .catch(() => emojiCacheStore.loadPersonalEmojis(null));

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
  position: relative;
}

.emoji-search {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  background: var(--background-senary-alpha);
}

.search-input {
  width: 100%;
  padding: 8px 12px;
  background: var(--background-senary-alpha);
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

.section-title-collapsible {
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  border-radius: 4px;
  transition: background 0.12s ease;
}

.section-title-collapsible:hover {
  background: rgba(255, 255, 255, 0.06);
}

.section-server-icon {
  vertical-align: middle;
  flex-shrink: 0;
}

.section-chevron {
  display: inline-block;
  font-size: 10px;
  line-height: 1;
  transition: transform 0.15s ease;
}

.section-chevron.collapsed {
  transform: rotate(-90deg);
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
  -webkit-touch-callout: none; /* Prevent iOS image selection/callout on long press */
  -webkit-user-select: none;
  user-select: none;
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
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-user-drag: none;
  user-drag: none;
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
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
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

.emoji-broken-icon {
  width: 22px;
  height: 22px;
  color: var(--text-muted, #72767d);
  opacity: 0.5;
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

/* AI generation form */
.ai-gen-form {
  display: flex;
  gap: 6px;
  margin: 2px 0 8px;
}

.ai-gen-input {
  flex: 1;
  padding: 6px 10px;
  font-size: 13px;
}

.ai-gen-button {
  flex: 0 0 auto;
  min-width: 72px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--harmony-primary, var(--harmony-primary-alpha));
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s ease;
}

.ai-gen-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ai-gen-error {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--color-danger, #f23f42);
}

/* Favorites */
.favorite-list {
  grid-template-columns: repeat(auto-fill, 36px);
}

.no-favorites-hint {
  padding: 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}

.no-favorites-hint p {
  margin: 0;
}

/* Scrollbar styling */
.emoji-content::-webkit-scrollbar {
  width: 8px;
}

.emoji-content::-webkit-scrollbar-track {
  background: transparent;
}

.emoji-content::-webkit-scrollbar-thumb {
  background: var(--background-senary-alpha, rgba(10, 11, 13, 0.8));
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

.fav-toast {
  position: absolute;
  bottom: 36px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--background-tertiary);
  color: var(--text-primary);
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid var(--border-color);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  pointer-events: none;
  z-index: 10;
  white-space: nowrap;
}

.fav-toast-enter-active { transition: all 0.15s ease; }
.fav-toast-leave-active { transition: all 0.2s ease; }
.fav-toast-enter-from { opacity: 0; transform: translateX(-50%) translateY(4px); }
.fav-toast-leave-to { opacity: 0; }
</style>

