<template>
  <div ref="emojiPopup" class="emoji-popup" :style="positionStyle">
    <!-- Search Input -->
    <div class="emoji-search">
      <input
        ref="searchInput"
        v-model="searchQuery"
        type="text"
        placeholder="Search emojis..."
        class="search-input"
      />
    </div>

    <!-- Emoji Content Area -->
    <div class="emoji-content">
      <!-- No Results State -->
      <div v-if="!filteredEmojiList.length" class="no-results">
        <div class="no-results-content">
          <div class="no-results-icon">{{ noResultsInfo.icon }}</div>
          <p>{{ noResultsInfo.title }}</p>
          <small>{{ noResultsInfo.subtitle }}</small>
        </div>
      </div>

      <!-- Emoji List -->
      <div v-else>
        <div v-for="group in filteredEmojiList" :key="group.serverId">
          <h3 class="server-name">{{ group.server_name }}</h3>
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick, watch } from 'vue';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import { usePopupPositioning } from '@/composables/usePopupPositioning';
import type { Emoji, ResolvedEmoji } from '@/types';
import { getEmojiUrl } from '@/utils/emojiUtils';

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
const emojiPopup = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const searchQuery = ref('');
const hoveredEmojiId = ref<string | null>(null); // Renamed for clarity

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

const selectEmoji = (emoji: Emoji): void => {
  emit('sendEmoji', emoji);
};

const handleClickOutside = (event: MouseEvent): void => {
  if (emojiPopup.value && !emojiPopup.value.contains(event.target as Node)) {
    // This specific logic allows the parent to control closing behavior
    // when the popup was opened via a persistent icon toggle.
    if (props.emojiIconClicked) {
      emit('resetEmojiIconClicked');
    } else {
      props.closeEmojiList?.();
    }
  }
};

const handleKeyDown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') {
    props.closeEmojiList?.();
  }
};

// --- Lifecycle Hooks ---

onMounted(() => {
  // Delay adding the click-outside listener to prevent the opening click from immediately closing it
  nextTick(() => {
    setTimeout(() => {
      document.addEventListener('click', handleClickOutside, true); // Use capture phase to prevent race conditions
    }, 100); // Small delay to let the opening click finish
  });
  
  document.addEventListener('keydown', handleKeyDown);

  nextTick(() => {
    updatePosition();
    searchInput.value?.focus();
  });
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside, true);
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

.server-name {
  font-size: 12px;
  font-weight: 600;
  color: #b9bbbe;
  text-transform: uppercase;
  margin: 16px 0 8px 0;
  letter-spacing: 0.02em;
}

.server-name:first-of-type {
  margin-top: 8px;
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