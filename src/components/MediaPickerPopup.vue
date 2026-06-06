<template>
  <div class="media-picker-popup" ref="popupRef" :style="positionStyle">
    <!-- Tab Navigation Header (horizontally scrollable) -->
    <div class="picker-tabs">
      <div class="picker-tabs-scroll" ref="tabsScrollRef" @wheel="onTabsWheel">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="tab-button"
          :class="{ active: activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>
      <!-- Favorite toggle (media tabs only - Emoji favorites are always inline) -->
      <button 
        v-if="activeTab !== 'emoji'"
        class="tab-icon-button"
        :class="{ active: showFavorites }"
        @click="showFavorites = !showFavorites"
        :title="showFavorites ? $t('gif.trending') : $t('gif.favorites')"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path v-if="showFavorites" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
          <path v-else d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"/>
        </svg>
      </button>
    </div>

    <!-- Klipy media content (gifs/stickers/clips/memes/ai-emojis) -->
    <GifPickerContent
      v-if="activeTab !== 'emoji'"
      :key="activeTab"
      :show-favorites="showFavorites"
      :media-type="activeTab"
      :initial-search-query="activeTab === 'gifs' ? initialSearchQuery : ''"
      @update:show-favorites="showFavorites = $event"
      @send-gif="handleSendGif"
    />

    <!-- Emoji Content -->
    <EmojiPickerContent
      v-else
      @send-emoji="handleSendEmoji"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick, computed, type Ref } from 'vue';
import { usePopupPositioning, type PopupPosition } from '@/composables/usePopupPositioning';
import GifPickerContent from '@/components/GifPickerContent.vue';
import EmojiPickerContent from '@/components/EmojiPickerContent.vue';
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings';
import type { GifMediaType } from '@/services/gifProviderService';
import type { Gif, Emoji } from '@/types';

type PickerTab = GifMediaType | 'emoji';

interface Props {
  closePopup?: () => void;
  position?: PopupPosition;
  triggerElement?: HTMLElement;
  initialTab?: PickerTab;
  initialSearchQuery?: string;
}

const props = withDefaults(defineProps<Props>(), {
  position: 'above',
  initialTab: 'gifs',
  initialSearchQuery: '',
});

interface Emits {
  (e: 'sendGif', gif: Gif): void;
  (e: 'sendEmoji', emoji: Emoji): void;
}

const emit = defineEmits<Emits>();

const instanceSettings = useInstanceSettingsStore();

// Tabs: GIFs + Stickers are always available; Clips/Memes/AI Emoji are
// gated by per-instance admin toggles. Emoji is the built-in picker.
const tabs = computed<{ id: PickerTab; label: string }[]>(() => {
  // Order: GIFs, Stickers, Emoji, then the optional Klipy types.
  const list: { id: PickerTab; label: string }[] = [
    { id: 'gifs', label: 'GIFs' },
    { id: 'stickers', label: 'Stickers' },
    { id: 'emoji', label: 'Emoji' },
  ];
  if (instanceSettings.gifClipsEnabled) list.push({ id: 'clips', label: 'Clips' });
  if (instanceSettings.gifMemesEnabled) list.push({ id: 'memes', label: 'Memes' });
  if (instanceSettings.gifAiEmojisEnabled) list.push({ id: 'ai-emojis', label: 'AI Emoji' });
  return list;
});

// State
const initialTab: PickerTab = props.initialTab;
const isEnabledTab = tabs.value.some((t) => t.id === initialTab);
const activeTab = ref<PickerTab>(isEnabledTab ? initialTab : 'gifs');
const showFavorites = ref(false);
const tabsScrollRef = ref<HTMLElement | null>(null);

// Reset the favorites view when switching tabs so each picker opens on trending.
watch(activeTab, () => { showFavorites.value = false; });

// Desktop: vertical wheel over the tab strip scrolls it horizontally.
const onTabsWheel = (e: WheelEvent) => {
  const el = tabsScrollRef.value;
  if (!el || el.scrollWidth <= el.clientWidth) return;
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  el.scrollLeft += e.deltaY;
  e.preventDefault();
};

const popupRef = ref<HTMLElement | null>(null);

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

// Event handlers
const handleSendGif = (gif: Gif) => {
  emit('sendGif', gif);
  props.closePopup?.();
};

const handleSendEmoji = (emoji: Emoji) => {
  emit('sendEmoji', emoji);
  props.closePopup?.();
};

const handleClickOutside = (event: MouseEvent) => {
  if (!popupRef.value) return;
  const target = event.target as Node;
  if (popupRef.value.contains(target)) return;
  // Don't close when interacting with emoji context menu (teleported to body)
  if ((target as Element).closest?.('[data-emoji-ctx-backdrop]')) return;
  props.closePopup?.();
};

const handleKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    props.closePopup?.();
  }
};

onMounted(() => {
  setTimeout(() => {
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
  }, 100);
  
  nextTick(() => updatePosition());
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleKeyDown);
});
</script>

<style scoped>
.media-picker-popup {
  /* background: var(--background-primary-alpha); */
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  width: 400px;
  max-height: 500px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  backdrop-filter: blur(8px);
  z-index: 1000;
}

.picker-tabs {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-secondary);
  gap: 4px;
  flex-shrink: 0;
  background: var(--background-senary-alpha);
  min-width: 0;
}

/* Horizontally scrollable strip; keeps the popup width fixed. */
.picker-tabs-scroll {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  overflow-y: hidden;
  flex: 1 1 auto;
  min-width: 0;
  scrollbar-width: none;
  -ms-overflow-style: none;
  scroll-behavior: smooth;
  -webkit-overflow-scrolling: touch;
}

.picker-tabs-scroll::-webkit-scrollbar {
  display: none;
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
  white-space: nowrap;
  flex: 0 0 auto;
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

@media (max-width: 768px) {
  .media-picker-popup {
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

