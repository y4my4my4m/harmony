<template>
  <div
    class="media-picker-popup"
    :class="{
      'media-picker-popup--mobile': isMobile,
      'media-picker-popup--keyboard-open': isMobile && keyboardOpen,
    }"
    data-block-sidebar-gestures
    ref="popupRef"
    :style="popupStyle"
  >
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
      <!-- Favorite toggle (media tabs only - Emoji + AI Emoji manage their own) -->
      <button 
        v-if="activeTab !== 'emoji' && activeTab !== 'ai-emojis'"
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
      @send-emoji="handleSendEmoji"
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
import { useLayoutState } from '@/composables/useLayoutState';
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
const { isMobile } = useLayoutState();

// Tabs: GIFs + Stickers are always available; Clips/Memes/AI Emoji are
// gated by per-instance admin toggles. Emoji is the built-in picker.
const tabs = computed<{ id: PickerTab; label: string }[]>(() => {
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

const initialTab: PickerTab = props.initialTab;
const isEnabledTab = tabs.value.some((t) => t.id === initialTab);
const activeTab = ref<PickerTab>(isEnabledTab ? initialTab : 'gifs');
const showFavorites = ref(false);
const tabsScrollRef = ref<HTMLElement | null>(null);

watch(activeTab, () => { showFavorites.value = false; });

// Desktop: vertical wheel over the tab strip scrolls it horizontally.
const onTabsWheel = (e: WheelEvent) => {
  const el = tabsScrollRef.value;
  if (!el || el.scrollWidth <= el.clientWidth) return;
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  el.scrollLeft += e.deltaY;
  e.preventDefault();
};

// Mobile: claim horizontal swipes on the tab strip so the browser doesn't navigate back/forward.
let tabsTouchStartX = 0;
let tabsTouchStartY = 0;

const onTabsTouchStart = (e: TouchEvent) => {
  const t = e.touches[0];
  if (!t) return;
  tabsTouchStartX = t.clientX;
  tabsTouchStartY = t.clientY;
  e.stopPropagation();
};

const onTabsTouchMove = (e: TouchEvent) => {
  const el = tabsScrollRef.value;
  if (!el || el.scrollWidth <= el.clientWidth) return;
  const t = e.touches[0];
  if (!t) return;
  const dx = t.clientX - tabsTouchStartX;
  const dy = t.clientY - tabsTouchStartY;
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 4) {
    e.preventDefault();
    e.stopPropagation();
    el.scrollLeft -= dx;
    tabsTouchStartX = t.clientX;
    tabsTouchStartY = t.clientY;
  }
};

const popupRef = ref<HTMLElement | null>(null);

const POPUP_DIMENSIONS = { width: 400, height: 500 };
const triggerElementRef = ref<HTMLElement | null>(null);

watch(() => props.triggerElement, (newTrigger) => {
  triggerElementRef.value = newTrigger || null;
  nextTick(() => updatePosition());
}, { immediate: true });

const { positionStyle, updatePosition } = usePopupPositioning(
  triggerElementRef as unknown as Ref<HTMLElement | null>,
  POPUP_DIMENSIONS,
  { position: props.position, offset: 8, viewport: { padding: 10 } },
);

/** Tracks the visible viewport (shrinks when the mobile keyboard opens). */
const visualViewportRect = ref({
  top: 0,
  left: 0,
  width: typeof window !== 'undefined' ? window.innerWidth : 400,
  height: typeof window !== 'undefined' ? window.innerHeight : 700,
});

const layoutHeight = ref(typeof window !== 'undefined' ? window.innerHeight : 700);

const KEYBOARD_OPEN_THRESHOLD = 120;

const syncVisualViewport = () => {
  layoutHeight.value = window.innerHeight;
  const vv = window.visualViewport;
  if (!vv) {
    visualViewportRect.value = {
      top: 0,
      left: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };
    return;
  }
  visualViewportRect.value = {
    top: vv.offsetTop,
    left: vv.offsetLeft,
    width: vv.width,
    height: vv.height,
  };
};

/** True when the soft keyboard is consuming viewport height. */
const keyboardOpen = computed(() => {
  if (!isMobile.value) return false;
  return layoutHeight.value - visualViewportRect.value.height > KEYBOARD_OPEN_THRESHOLD;
});

/**
 * Mobile positioning:
 * - Keyboard open → compact panel pinned to the top of the visible viewport.
 * - Keyboard closed → taller bottom-anchored panel that uses more of the screen.
 */
const mobilePopupStyle = computed(() => {
  const pad = 12;
  const bottomPad = 16;
  const vv = visualViewportRect.value;
  const width = Math.min(400, Math.round(vv.width - pad * 2));
  const left = vv.left + (vv.width - width) / 2;

  let maxHeight: number;
  let top: number;

  if (keyboardOpen.value) {
    maxHeight = Math.min(420, Math.round(vv.height - pad * 2));
    top = vv.top + pad;
  } else {
    maxHeight = Math.min(560, Math.round(vv.height * 0.78));
    top = vv.top + vv.height - maxHeight - bottomPad;
  }

  return {
    position: 'fixed' as const,
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`,
    zIndex: 1050,
    visibility: 'visible' as const,
  };
});

const popupStyle = computed(() => (isMobile.value ? mobilePopupStyle.value : positionStyle.value));

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
  if ((target as Element).closest?.('[data-emoji-ctx-backdrop]')) return;
  props.closePopup?.();
};

const handleKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    props.closePopup?.();
  }
};

let tabsTouchMoveHandler: ((e: TouchEvent) => void) | null = null;

onMounted(() => {
  setTimeout(() => {
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
  }, 100);

  syncVisualViewport();
  window.visualViewport?.addEventListener('resize', syncVisualViewport);
  window.visualViewport?.addEventListener('scroll', syncVisualViewport);
  window.addEventListener('resize', syncVisualViewport);

  nextTick(() => {
    updatePosition();
    const el = tabsScrollRef.value;
    if (el) {
      tabsTouchMoveHandler = onTabsTouchMove;
      el.addEventListener('touchstart', onTabsTouchStart, { passive: true });
      el.addEventListener('touchmove', tabsTouchMoveHandler, { passive: false });
    }
  });
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleKeyDown);
  window.visualViewport?.removeEventListener('resize', syncVisualViewport);
  window.visualViewport?.removeEventListener('scroll', syncVisualViewport);
  window.removeEventListener('resize', syncVisualViewport);
  const el = tabsScrollRef.value;
  if (el && tabsTouchMoveHandler) {
    el.removeEventListener('touchstart', onTabsTouchStart);
    el.removeEventListener('touchmove', tabsTouchMoveHandler);
  }
});
</script>

<style scoped>
.media-picker-popup {
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
  overscroll-behavior: contain;
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
  touch-action: pan-x;
  overscroll-behavior-x: contain;
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
  flex-shrink: 0;
}

.tab-icon-button:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.tab-icon-button.active {
  color: var(--color-warning);
}

@media (max-width: 768px) {
  .media-picker-popup--mobile {
    border-radius: 12px;
    transition: top 0.22s ease, max-height 0.22s ease;
  }

  .tab-button {
    padding: 6px 12px;
    font-size: 13px;
  }
}
</style>
