<template>
  <div
    v-if="props.isVisible && props.suggestions.length > 0"
    ref="suggestContainer"
    class="auto-suggest"
    :style="positionStyle"
  >
    <div v-if="props.headerText" class="suggest-header">
      {{ props.headerText }}
    </div>
    <div
      v-for="(suggestion, index) in props.suggestions"
      :key="getSuggestionKey(suggestion)"
      class="suggest-item"
      :class="{ 'selected': index === props.selectedIndex }"
      @click="selectSuggestion(suggestion)"
      @mouseenter="emit('update:selectedIndex', index)"
    >
      <slot :suggestion="suggestion" :selected="index === props.selectedIndex">
        <!-- Default fallback rendering -->
        <div class="suggest-item-default">
          <Avatar
            v-if="suggestion.avatar"
            :src="suggestion.avatar || suggestion.url"
            :alt="suggestion.name || suggestion.display_name"
            class="suggest-icon"
            size="sm"
          />
          <img
            v-else-if="suggestion.emoji"
            :src="suggestion.url"
            alt="Emoji"
            class="suggest-icon emoji-icon"
          />
          <div class="suggest-text">
            <span class="suggest-name" v-if="!suggestion.emoji">{{ suggestion.display_name || suggestion.name }}</span>
            <span class="suggest-name" v-else>:{{ suggestion.emoji.name }}:</span>
            <span v-if="suggestion.username" class="suggest-username">{{ suggestion.username }}</span>
            <span v-if="suggestion.server_name" class="suggest-server">{{ suggestion.server_name }}</span>
          </div>
        </div>
      </slot>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import Avatar from '@/components/common/Avatar.vue';

// TYPE DEFINITIONS
// These interfaces can be exported directly from <script setup>
export interface SuggestionItem {
  id: string;
  name?: string;
  display_name?: string;
  username?: string;
  avatar?: string;
  url?: string;
  domain?: string;
  isLocal?: boolean; // Indicates if the user is local to the server
  [key: string]: any;
}

export interface SuggestionPosition {
  x: number;
  y: number;
}

// PROPS
// Using a dedicated interface for props improves type safety
interface Props {
  isVisible?: boolean;
  suggestions?: SuggestionItem[];
  position?: SuggestionPosition;
  selectedIndex?: number;
  headerText?: string;
  maxHeight?: number;
}

// `withDefaults` is used to provide default values for the defined props.
const props = withDefaults(defineProps<Props>(), {
  isVisible: false,
  suggestions: () => [],
  position: () => ({ x: 0, y: 0 }),
  selectedIndex: 0,
  headerText: '',
  maxHeight: 200,
});

// EMITS
// `defineEmits` provides type-safe event emission.
const emit = defineEmits<{
  (e: 'select', suggestion: SuggestionItem): void;
  (e: 'update:selectedIndex', index: number): void;
}>();

// REFS
const suggestContainer = ref<HTMLElement | null>(null);

// COMPUTED PROPERTIES
const positionStyle = computed(() => ({
  position: 'fixed' as const,
  left: `${props.position.x}px`,
  top: `${props.position.y}px`,
  maxHeight: `${props.maxHeight}px`,
  zIndex: 9999, // Much higher z-index to ensure visibility
}));

// METHODS
const selectSuggestion = (suggestion: SuggestionItem) => {
  emit('select', suggestion);
};

const getSuggestionKey = (suggestion: SuggestionItem): string => {
  return suggestion.id || `${suggestion.name || suggestion.display_name}-${Math.random()}`;
};

// WATCHERS
// Auto-scroll selected item into view
watch(() => props.selectedIndex, (newIndex) => {
  nextTick(() => {
    if (suggestContainer.value && newIndex >= 0) {
      const selectedItem = suggestContainer.value.children[newIndex + (props.headerText ? 1 : 0)] as HTMLElement;
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: 'nearest' });
      }
    }
  });
});
</script>

<style>
.auto-suggest {
  background: #2f3136;
  border-radius: 8px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  border: 1px solid #40444b;
  overflow-y: auto;
  min-width: 200px;
  max-width: 300px;
}

.suggest-header {
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: #b9bbbe;
  background: #36393f;
  border-bottom: 1px solid #40444b;
}

.suggest-item {
  padding: 8px 12px;
  cursor: pointer;
  transition: background-color 0.1s ease;
  border-bottom: 1px solid transparent;
}

.suggest-item:hover,
.suggest-item.selected {
  background: #40444b;
}

.suggest-item.selected {
  background: #5865f2;
}

.suggest-item.selected .suggest-server {
  color: #dcddde !important; /* Better contrast on selected background */
}

.suggest-item:hover .suggest-server {
  color: #dcddde; /* Better contrast on hover background */
}

.suggest-item-default {
  display: flex;
  align-items: center;
  gap: 8px;
}

.suggest-icon {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  flex-shrink: 0;
}

.emoji-icon {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

/* Auto-suggest item styling */
.suggest-item-content {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.suggest-icon {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  flex-shrink: 0;
}

.suggest-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}


.suggest-name {
  font-weight: 500;
  color: #ffffff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.suggest-username {
  font-size: 12px;
  color: #b9bbbe;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.suggest-server {
  font-size: 12px;
  color: #72767d;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.suggest-domain {
  font-size: 12px;
  color: #72767d;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.selected .suggest-server,
.selected .suggest-domain {
  color: rgba(255, 255, 255, 0.5);
}
/* Scrollbar styling */
.auto-suggest::-webkit-scrollbar {
  width: 4px;
}

.auto-suggest::-webkit-scrollbar-track {
  background: transparent;
}

.auto-suggest::-webkit-scrollbar-thumb {
  background: #40444b;
  border-radius: 2px;
}

.auto-suggest::-webkit-scrollbar-thumb:hover {
  background: #4f545c;
}
</style>