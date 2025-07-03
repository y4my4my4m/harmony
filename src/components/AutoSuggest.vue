<template>
  <div
    v-if="isVisible && suggestions.length > 0"
    ref="suggestContainer"
    class="auto-suggest"
    :style="positionStyle"
  >
    <div class="suggest-header" v-if="headerText">
      {{ headerText }}
    </div>
    <div
      v-for="(suggestion, index) in suggestions"
      :key="getSuggestionKey(suggestion)"
      class="suggest-item"
      :class="{ 'selected': index === selectedIndex }"
      @click="selectSuggestion(suggestion)"
      @mouseenter="$emit('update:selectedIndex', index)"
    >
      <slot :suggestion="suggestion" :selected="index === selectedIndex">
        <!-- Default fallback rendering -->
        <div class="suggest-item-default">
          <img 
            v-if="suggestion.avatar || suggestion.url" 
            :src="suggestion.avatar || suggestion.url" 
            :alt="suggestion.name || suggestion.display_name"
            class="suggest-icon"
          />
          <span class="suggest-name">{{ suggestion.name || suggestion.display_name }}</span>
          <span v-if="suggestion.username" class="suggest-username">{{ suggestion.username }}</span>
        </div>
      </slot>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, watch, nextTick } from 'vue';
import type { PropType } from 'vue';

export interface SuggestionItem {
  id: string;
  name?: string;
  display_name?: string;
  username?: string;
  avatar?: string;
  url?: string;
  [key: string]: any;
}

export interface SuggestionPosition {
  x: number;
  y: number;
}

export default defineComponent({
  name: 'AutoSuggest',
  props: {
    isVisible: {
      type: Boolean,
      default: false
    },
    suggestions: {
      type: Array as PropType<SuggestionItem[]>,
      default: () => []
    },
    position: {
      type: Object as PropType<SuggestionPosition>,
      default: () => ({ x: 0, y: 0 })
    },
    selectedIndex: {
      type: Number,
      default: 0
    },
    headerText: {
      type: String,
      default: ''
    },
    maxHeight: {
      type: Number,
      default: 200
    }
  },
  emits: ['select', 'update:selectedIndex'],
  setup(props, { emit }) {
    const suggestContainer = ref<HTMLElement | null>(null);

    const positionStyle = computed(() => ({
      position: 'fixed' as const,
      left: `${props.position.x}px`,
      top: `${props.position.y}px`,
      maxHeight: `${props.maxHeight}px`,
      zIndex: 9999 // Much higher z-index to ensure visibility
    }));

    const selectSuggestion = (suggestion: SuggestionItem) => {
      emit('select', suggestion);
    };

    const getSuggestionKey = (suggestion: SuggestionItem): string => {
      return suggestion.id || `${suggestion.name || suggestion.display_name}-${Math.random()}`;
    };

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

    return {
      suggestContainer,
      positionStyle,
      selectSuggestion,
      getSuggestionKey
    };
  }
});
</script>

<style scoped>
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

.suggest-name {
  font-weight: 500;
  color: #ffffff;
  flex: 1;
}

.suggest-username {
  font-size: 12px;
  color: #b9bbbe;
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