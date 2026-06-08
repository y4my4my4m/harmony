<template>
  <div class="gif-picker-content">
    <!-- Category Buttons (Favorites/Trending [+ Generate for AI Emoji]) -->
    <div class="gif-categories">
      <button 
        v-if="!isAiEmoji"
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
        :class="{ active: !showFavorites && !showGenerate }"
        @click="$emit('update:showFavorites', false); showGenerate = false"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M17.09 4.56c-.7-1.03-1.5-1.99-2.4-2.85-.35-.34-.94-.02-.84.46.19.94.39 2.18.39 3.29 0 2.06-1.35 3.73-3.41 3.73-1.54 0-2.8-.93-3.35-2.26-.1-.2-.14-.32-.2-.54-.11-.42-.66-.55-.9-.18-.18.27-.35.56-.51.84A13.74 13.74 0 004 14c0 4.42 3.58 8 8 8s8-3.58 8-8c0-3.49-1.08-6.73-2.91-9.44zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.47-.3 2.98-.93 4.03-1.92.28-.26.74-.14.82.23.23 1.02.35 2.08.35 3.15.01 2.65-2.14 4.8-4.79 4.8z"/>
        </svg>
        {{ $t('gif.trending') }}
      </button>
      <button
        v-if="isAiEmoji && canGenerate"
        class="category-button"
        :class="{ active: showGenerate }"
        @click="showGenerate = !showGenerate"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M11 2 9.2 7.2 4 9l5.2 1.8L11 16l1.8-5.2L18 9l-5.2-1.8L11 2zm7 11-1 2.8L14 17l2.8 1L18 21l1-2.8L22 17l-2.8-1L18 13z"/>
        </svg>
        {{ $t('emoji.aiGenerate') }}
      </button>
    </div>

    <!-- Inline AI emoji generation (AI Emoji tab) -->
    <div v-if="showGenerate && isAiEmoji" class="gif-generate-wrap">
      <form class="gif-generate-form" @submit.prevent="runGenerate">
        <input
          v-model="genPrompt"
          type="text"
          class="search-input gif-generate-input"
          :maxlength="GEN_PROMPT_MAX_LEN"
          :placeholder="$t('emoji.aiGeneratePlaceholder')"
          :disabled="generating || (atLimit && !quota?.isExempt)"
        />
        <button
          type="submit"
          class="gif-generate-button"
          :disabled="generating || !genPrompt.trim() || atLimit"
        >
          {{ generating ? $t('emoji.aiGenerating') : $t('emoji.aiGenerate') }}
        </button>
      </form>
      <p v-if="quotaText" class="gif-generate-quota" :class="{ 'at-limit': atLimit }">
        {{ quotaText }}
      </p>
    </div>

    <!-- Search Input (hidden in AI generate mode; disabled in favorites view) -->
    <div v-if="!(showGenerate && isAiEmoji)" class="gif-search">
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

    <!-- GIF Results / Favorites / AI Generate -->
    <div class="gif-results" ref="resultsRef" @scroll="onResultsScroll">
      <!-- AI Emoji generate mode: user's generated emoji + in-flight reveal -->
      <template v-if="showGenerate && isAiEmoji">
        <div v-if="generating || revealedEmoji" class="ai-gen-hero">
          <Transition name="gen-fade" mode="out-in">
            <div v-if="generating" key="spinner" class="ai-gen-spinner-wrap">
              <LoadingSpinner :size="40" />
            </div>
            <button
              v-else-if="revealedEmoji"
              :key="revealedEmoji.id"
              type="button"
              class="ai-gen-reveal"
              @click="selectGeneratedEmoji(revealedEmoji)"
            >
              <img
                :src="getEmojiUrl(revealedEmoji.url, 128)"
                :alt="`:${revealedEmoji.name}:`"
                class="ai-gen-reveal-img"
              />
            </button>
          </Transition>
        </div>

        <div
          v-if="myGeneratedAiEmojis.length === 0 && !generating && !revealedEmoji"
          class="empty-state"
        >
          <p>{{ $t('emoji.aiGenerateEmpty') }}</p>
          <span class="empty-hint">{{ $t('emoji.aiGenerateEmptyHint') }}</span>
        </div>
        <div v-else-if="gridAiEmojis.length > 0 || revealedEmoji" class="ai-gen-grid">
          <button
            v-for="emoji in gridAiEmojis"
            :key="emoji.id"
            type="button"
            class="ai-gen-item"
            @click="selectGeneratedEmoji(emoji)"
          >
            <img
              :src="getEmojiUrl(emoji.url, 64)"
              :alt="emoji.name"
              class="ai-gen-item-img"
            />
          </button>
        </div>
      </template>

      <!-- Loading State -->
      <div v-else-if="isLoading" class="loading-state">
        <LoadingSpinner :size="24" />
        <span>Loading...</span>
      </div>

      <!-- Favorites View -->
      <template v-else-if="showFavorites">
        <div v-if="favorites.length === 0" class="empty-state">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor" class="empty-icon">
            <path d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"/>
          </svg>
          <p>No favorite {{ mediaNoun }} yet</p>
          <span class="empty-hint">{{ $t('gif.noFavoritesHint') }}</span>
        </div>
        <masonry-wall v-else :items="favorites" :column-width="150" :gap="10">
          <template #default="{ item }">
            <div 
              :key="item.id" 
              class="gif-item" 
              @mouseover="hoveredGif = item.id" 
              @mouseleave="(item.media_type ?? 'gif') === 'clip' ? handleClipItemLeave(item.id, $event) : (hoveredGif = null)"
              @click="selectFavoriteGif(item)"
            >
              <template v-if="(item.media_type ?? 'gif') === 'clip'">
                <video
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
                <button
                  class="clip-audio-button"
                  :class="{ visible: hoveredGif === item.id || isMobile || audioClipId === item.id }"
                  :title="audioClipId === item.id ? $t('gif.clipMute') : $t('gif.clipUnmute')"
                  @click.stop="(e) => toggleClipAudio(item.id, e)"
                >
                  <svg v-if="audioClipId === item.id" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
                  <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                </button>
              </template>
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
          <p>No {{ mediaNoun }} found</p>
          <span class="empty-hint">Try a different search term</span>
        </div>
        <!-- Ads sit in full-width rows between masonry runs (masonry can't column-span). -->
        <div v-else class="gif-results-feed">
          <template v-for="segment in feedSegments" :key="segment.key">
            <GifAdSlot
              v-if="segment.kind === 'ad'"
              layout="banner"
              class="gif-ad-tile"
              :content="segment.ad.content"
              :width="segment.ad.width"
              :height="segment.ad.height"
            />
            <masonry-wall
              v-else
              class="gif-masonry-segment"
              :items="segment.items"
              :column-width="150"
              :gap="10"
              :key="segment.key"
            >
              <template #default="{ item }">
                <div
                  :key="item.id"
                  class="gif-item"
                  @mouseover="hoveredGif = item.id"
                  @mouseleave="isClips ? handleClipItemLeave(item.id, $event) : (hoveredGif = null)"
                  @click="selectGif(item)"
                >
                  <template v-if="isClips">
                    <video
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
                    <button
                      class="clip-audio-button"
                      :class="{ visible: hoveredGif === item.id || isMobile || audioClipId === item.id }"
                      :title="audioClipId === item.id ? $t('gif.clipMute') : $t('gif.clipUnmute')"
                      @click.stop="(e) => toggleClipAudio(item.id, e)"
                    >
                      <svg v-if="audioClipId === item.id" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
                      <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                    </button>
                  </template>
                  <img v-else :src="getGifImageSource(item.id, item.media_formats.gif.url, item.media_formats.gifpreview.url)" :alt="item.title" :class="{ 'sticker-thumb': isStickerLike }">
                  <button
                    v-if="!isAiEmoji"
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
          </template>
        </div>
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
import { useLayoutState } from '@/composables/useLayoutState';
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings';
import { useEmojiCacheStore, PERSONAL_EMOJI_GROUPS } from '@/stores/useEmojiCache';
import { authContextService } from '@/services/AuthContextService';
import { useAiEmojiGeneration } from '@/composables/useAiEmojiGeneration';
import { useFrequentEmojis } from '@/composables/useFrequentEmojis';
import { buildEphemeralEmojiFromGif, registerEphemeralEmoji } from '@/utils/ephemeralEmoji';
import { getEmojiUrl } from '@/utils/emojiUtils';
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
import type { Gif, GifAdItem, GifResultItem, Emoji, ResolvedEmoji } from '@/types';

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
  (e: 'sendEmoji', emoji: Emoji): void;
  (e: 'update:showFavorites', value: boolean): void;
}

const emit = defineEmits<Emits>();
const { t } = useI18n();
const { isMobile } = useLayoutState();
const instanceSettings = useInstanceSettingsStore();
const emojiCacheStore = useEmojiCacheStore();
const aiGen = useAiEmojiGeneration();
const { recordEmojiUsage } = useFrequentEmojis();

const isAiEmoji = computed(() => props.mediaType === 'ai-emojis');
const canGenerate = computed(() => instanceSettings.gifAiEmojiGenerationEnabled);

// Inline generation form (AI Emoji tab only).
const showGenerate = ref(false);
const genPrompt = ref('');
const GEN_PROMPT_MAX_LEN = 200;
const generating = aiGen.isGenerating;
const quota = aiGen.quota;
/** Latest successfully generated emoji — shown in the hero slot above the list. */
const revealedEmoji = ref<Emoji | null>(null);

// "You have N generation(s) left today" — auto-bounded by the instance cap.
// Admins/owners are exempt from the per-user cap, so we phrase it accordingly.
const quotaText = computed(() => {
  const q = quota.value;
  if (!q) return '';
  if (q.isExempt) {
    return t('emoji.aiQuotaInstance', {
      remaining: q.instanceRemaining,
      total: q.instanceDaily,
    });
  }
  return t('emoji.aiQuotaUser', {
    remaining: q.remaining,
    used: q.userUsed,
    total: q.perUserDaily,
  });
});

const atLimit = computed(() => {
  const q = quota.value;
  if (!q) return false;
  return q.remaining <= 0;
});

const myGeneratedAiEmojis = computed((): ResolvedEmoji[] => {
  const group = emojiCacheStore.resolvedEmojis[PERSONAL_EMOJI_GROUPS.ai];
  return group?.emojis ?? [];
});

/** Grid excludes the emoji currently showcased in the hero reveal slot. */
const gridAiEmojis = computed((): ResolvedEmoji[] => {
  const revealId = revealedEmoji.value?.id;
  if (!revealId) return myGeneratedAiEmojis.value;
  return myGeneratedAiEmojis.value.filter((e) => e.id !== revealId);
});

const loadMyAiEmojis = async () => {
  try {
    const ctx = await authContextService.getCurrentContext();
    await emojiCacheStore.loadPersonalEmojis(ctx.profileId ?? null);
  } catch {
    await emojiCacheStore.loadPersonalEmojis(null);
  }
  aiGen.refreshQuota().catch(() => {});
};

const runGenerate = async () => {
  const prompt = genPrompt.value.trim();
  if (!prompt || generating.value) return;
  revealedEmoji.value = null;
  const emoji = await aiGen.generate(prompt);
  if (emoji) {
    genPrompt.value = '';
    revealedEmoji.value = emoji;
  }
};

const selectGeneratedEmoji = (emoji: ResolvedEmoji | Emoji) => {
  recordEmojiUsage({ id: emoji.id, name: emoji.name, url: emoji.url });
  emit('sendEmoji', emoji as Emoji);
};

const kind = computed<KlipyKind>(() => mediaTypeToKind(props.mediaType));
const isClips = computed(() => props.mediaType === 'clips');
// Human-readable noun for empty states (the picker spans several media types).
const mediaNoun = computed(() => {
  switch (props.mediaType) {
    case 'stickers': return 'stickers';
    case 'clips': return 'clips';
    case 'memes': return 'memes';
    case 'ai-emojis': return 'AI emoji';
    default: return 'GIFs';
  }
});
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

// The clip currently previewing with audio (toggled via the mute/unmute icon).
// Tracked by item id (drives the icon state) plus the element (to pause it when
// switching). Only one clip plays audio at a time.
const audioClipId = ref<string | null>(null);
let audioClipEl: HTMLVideoElement | null = null;

const resetClipAudio = () => {
  if (audioClipEl) {
    audioClipEl.muted = true;
    audioClipEl.pause?.();
    audioClipEl.currentTime = 0;
  }
  audioClipEl = null;
  audioClipId.value = null;
};

// Hover play/pause for clip previews. Muted by default; the audio icon opts a
// single clip into sound. Leaving the clip (desktop) stops playback + audio.
const playPreview = (e: Event) => {
  const v = e.target as HTMLVideoElement;
  if (v === audioClipEl) return; // already previewing with audio
  v.muted = true;
  v.play?.().catch(() => {});
};
const pausePreview = (e: Event) => {
  const v = e.target as HTMLVideoElement;
  if (v === audioClipEl) {
    resetClipAudio();
    return;
  }
  v.pause?.();
  v.currentTime = 0;
};

/** Leaving a clip card — stop muted preview and any audio on this item. */
const handleClipItemLeave = (itemId: string, e: MouseEvent) => {
  hoveredGif.value = null;
  if (audioClipId.value === itemId) {
    resetClipAudio();
    return;
  }
  const v = (e.currentTarget as HTMLElement).querySelector('video');
  if (v) {
    v.pause?.();
    v.currentTime = 0;
  }
};

// Tap the mute/unmute icon to play a clip with sound (tap again to mute).
const toggleClipAudio = (itemId: string, e: Event) => {
  e.stopPropagation();
  const btn = e.currentTarget as HTMLElement;
  const v = btn.closest('.gif-item')?.querySelector('video') as HTMLVideoElement | null;
  if (!v) return;
  if (audioClipId.value === itemId) {
    resetClipAudio();
    return;
  }
  if (audioClipEl && audioClipEl !== v) {
    audioClipEl.muted = true;
    audioClipEl.pause?.();
    audioClipEl.currentTime = 0;
  }
  v.muted = false;
  v.volume = 1;
  v.play?.().catch(() => {});
  audioClipEl = v;
  audioClipId.value = itemId;
};

const applySuggestion = (term: string) => {
  searchQuery.value = term;
};

/** Masonry can't span columns; split the feed into GIF runs and full-width ad rows. */
type GifFeedSegment =
  | { key: string; kind: 'ad'; ad: GifAdItem }
  | { key: string; kind: 'gifs'; items: Gif[] };

const feedSegments = computed((): GifFeedSegment[] => {
  const segments: GifFeedSegment[] = [];
  let batch: Gif[] = [];
  let batchStart = 0;

  items.value.forEach((item, index) => {
    if (item.kind === 'ad') {
      if (batch.length > 0) {
        segments.push({ key: `gifs-${batchStart}`, kind: 'gifs', items: batch });
        batch = [];
      }
      segments.push({ key: `ad-${item.id}`, kind: 'ad', ad: item });
      return;
    }
    if (batch.length === 0) batchStart = index;
    batch.push(item);
  });

  if (batch.length > 0) {
    segments.push({ key: `gifs-${batchStart}`, kind: 'gifs', items: batch });
  }
  return segments;
});

const applyFeed = (feed: Awaited<ReturnType<typeof gifProvider.trending>>) => {
  items.value = feed.items;
  if (feed.meta?.showAds && !feed.items.some((i) => i.kind === 'ad')) {
    debug.log(
      'GIF feed: ads enabled for this user but Klipy returned no ad slots. ' +
        'Klipy only fills ads on mobile browsers (not desktop). ' +
        'Also try search, confirm KLIPY_API_KEY_ADS has ads on in the Klipy dashboard, and restart the federation backend.',
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
      hasNext.value = feed.hasNext;
    } else {
      // Preserve scroll position: masonry re-layout on append otherwise jumps
      // the container back to the top.
      const el = resultsRef.value;
      const prevScroll = el?.scrollTop ?? 0;
      items.value = [...items.value, ...feed.items];
      hasNext.value = feed.hasNext;
      await nextTick();
      if (el) el.scrollTop = prevScroll;
      requestAnimationFrame(() => { if (el) el.scrollTop = prevScroll; });
    }
  } finally {
    isLoading.value = false;
    loadingMore.value = false;
  }
};

const loadMore = () => {
  if (showGenerate.value && isAiEmoji.value) return;
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
const selectGif = (gif: Gif) => {
  // AI emoji behave like emoji: insert into the composer (no autosend) as an
  // ephemeral URL-backed custom emoji, and count toward frequently-used.
  if (isAiEmoji.value) {
    sendAsEmoji(gif);
    return;
  }
  emit('sendGif', withGifMessageUrl(gif, kind.value));
};

// Select and send a favorite GIF/sticker/clip/etc.
const selectFavoriteGif = (favorite: FavoriteGif) => {
  const favKind = (favorite.media_type ?? 'gif') as KlipyKind;
  if (favKind === 'ai-emoji') {
    sendAsEmoji(gifService.favoriteToGif(favorite));
    return;
  }
  emit('sendGif', withGifMessageUrl(gifService.favoriteToGif(favorite), favKind));
};

// Route a Klipy AI emoji through the emoji pipeline instead of the media one.
const sendAsEmoji = (gif: Gif) => {
  const emoji = buildEphemeralEmojiFromGif(gif);
  registerEphemeralEmoji(emoji);
  recordEmojiUsage({ id: emoji.id, name: emoji.name, url: emoji.url });
  emit('sendEmoji', emoji);
};

// Debounced search + suggestions/autocomplete.
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
let suggestTimeout: ReturnType<typeof setTimeout> | null = null;
const refreshSuggestions = async () => {
  suggestions.value = await gifProvider.suggest(searchQuery.value || undefined);
};
watch(searchQuery, () => {
  if (showGenerate.value && isAiEmoji.value) return;
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => fetchPage(true), 300);
  if (suggestTimeout) clearTimeout(suggestTimeout);
  suggestTimeout = setTimeout(refreshSuggestions, 250);
});

watch(showGenerate, (show) => {
  if (show && isAiEmoji.value) {
    loadMyAiEmojis();
  } else {
    revealedEmoji.value = null;
  }
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

/* Inline AI emoji generation form (AI Emoji tab). */
.gif-generate-wrap {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-secondary);
  background: var(--background-senary-alpha);
}

.gif-generate-form {
  display: flex;
  gap: 8px;
  padding: 8px 12px 0;
}

.gif-generate-quota {
  margin: 0;
  padding: 4px 12px 8px;
  font-size: 12px;
  color: var(--text-muted);
}

.gif-generate-quota.at-limit {
  color: var(--status-danger, #f04747);
}

.gif-generate-input {
  flex: 1 1 auto;
  min-width: 0;
}

.gif-generate-button {
  flex: 0 0 auto;
  min-width: 76px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 14px;
  border: none;
  border-radius: 6px;
  background: var(--harmony-primary, #0EA5E9);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s ease, background 0.15s ease;
}

.gif-generate-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* AI generate mode: in-flight spinner + reveal hero above the user's list */
.ai-gen-hero {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px 16px 20px;
  margin: 0 8px 8px;
  border-radius: 8px;
  background: var(--background-senary-alpha);
  min-height: 120px;
}

.ai-gen-spinner-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
}

.ai-gen-reveal {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 8px;
  transition: transform 0.15s ease;
}

.ai-gen-reveal:hover {
  transform: scale(1.06);
}

.ai-gen-reveal-img {
  width: 96px;
  height: 96px;
  object-fit: contain;
}

.gen-fade-enter-active,
.gen-fade-leave-active {
  transition: opacity 0.35s ease, transform 0.35s ease;
}

.gen-fade-enter-from {
  opacity: 0;
  transform: scale(0.85);
}

.gen-fade-leave-to {
  opacity: 0;
  transform: scale(0.92);
}

/* User's previously generated AI emoji grid (no category header) */
.ai-gen-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
  gap: 8px;
  padding: 4px 8px 12px;
}

.ai-gen-item {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  padding: 6px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.15s ease;
}

.ai-gen-item:hover {
  background: var(--background-modifier-hover);
  transform: scale(1.06);
}

.ai-gen-item-img {
  width: 100%;
  height: 100%;
  max-width: 48px;
  max-height: 48px;
  object-fit: contain;
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

/* Feed = alternating full-width ad rows + masonry GIF runs. */
.gif-results-feed {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 8px;
}

.gif-ad-tile {
  width: 100%;
  flex-shrink: 0;
}

.gif-masonry-segment {
  width: 100%;
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

/* Clip audio (mute/unmute) toggle - bottom-right, fades in on hover (desktop);
   forced visible on mobile and whenever this clip is the active audio one. */
.clip-audio-button {
  position: absolute;
  bottom: 6px;
  right: 6px;
  width: 26px;
  height: 26px;
  background: rgba(0, 0, 0, 0.6);
  border: none;
  padding: 0;
  border-radius: 50%;
  cursor: pointer;
  color: var(--text-primary, #fff);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease, transform 0.15s ease;
  z-index: 2;
}

.clip-audio-button.visible {
  opacity: 1;
}

.clip-audio-button:hover {
  background: rgba(0, 0, 0, 0.85);
  transform: scale(1.1);
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

