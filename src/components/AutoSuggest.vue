<template>
  <div
    v-if="props.isVisible && props.suggestions.length > 0"
    ref="suggestContainer"
    id="auto-suggest-listbox"
    role="listbox"
    class="auto-suggest"
    :class="{ 'auto-suggest-commands': isCommandList }"
    :style="positionStyle"
  >
    <div v-if="props.headerText" class="suggest-header">
      {{ props.headerText }}
    </div>
    <div
      v-for="(suggestion, index) in props.suggestions"
      :key="getSuggestionKey(suggestion)"
      :id="'suggest-' + index"
      role="option"
      :aria-selected="index === props.selectedIndex"
      class="suggest-item"
      :class="{ 'selected': index === props.selectedIndex }"
      @click="selectSuggestion(suggestion)"
      @mouseenter="emit('update:selectedIndex', index)"
    >
      <slot :suggestion="suggestion" :selected="index === props.selectedIndex">
        <!-- Default fallback rendering -->
        <div class="suggest-item-default">
          <!-- Command icon -->
          <div v-if="suggestion.isCommand" class="suggest-icon command-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>
            </svg>
          </div>
          <!-- Role icon -->
          <div 
            v-else-if="suggestion.isRole" 
            class="suggest-icon role-icon"
            :style="{ backgroundColor: suggestion.roleColor || '#99AAB5' }"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/>
            </svg>
          </div>
          <Avatar
            v-else-if="suggestion.avatar"
            :src="suggestion.avatar"
            :alt="suggestion.name || suggestion.display_name"
            class="suggest-icon suggest-avatar"
            size="xs"
          />
          <img
            v-else-if="suggestion.emoji && suggestion.url"
            :src="suggestion.url"
            alt="Emoji"
            class="suggest-icon emoji-icon"
          />
          <span
            v-else-if="suggestion.emoji && suggestion.native"
            class="suggest-icon native-emoji-icon"
          >{{ suggestion.native }}</span>
          <div class="suggest-text">
            <!-- Commands: name + param on one line (never truncated), description below -->
            <template v-if="suggestion.isCommand">
              <div class="suggest-command-block">
                <div class="suggest-command-top">
                  <span class="suggest-name command-name">
                    {{ suggestion.display_name || `/${suggestion.name}` }}
                  </span>
                  <span v-if="suggestion.commandParams?.length" class="suggest-command-params">
                    <span
                      v-for="param in suggestion.commandParams"
                      :key="param.name"
                      class="suggest-param-tag"
                    >{{ param.name }}</span>
                  </span>
                </div>
                <span v-if="suggestion.description" class="suggest-command-description">
                  {{ suggestion.description }}
                </span>
              </div>
            </template>
            <template v-else>
              <div class="suggest-name-row">
                <span v-if="suggestion.isRole" class="suggest-name role-name" :style="{ color: suggestion.roleColor || '#99AAB5' }">
                  @{{ (suggestion.display_name || suggestion.name || '').replace(/^@/, '') }}
                </span>
                <DisplayName v-else-if="!suggestion.emoji && suggestion.id" class="suggest-name" :userId="suggestion.id" :fallback="suggestion.display_name || suggestion.name" :truncate="true" />
                <span class="suggest-name" v-else>:{{ suggestion.emoji.name || suggestion.name }}:</span>
                <span v-if="suggestion.isRole" class="bridge-badge role-badge" title="Role">
                  Role
                </span>
                <span v-else-if="suggestion.isBridged && suggestion.bridgeSource === 'discord'" class="bridge-badge discord" title="Discord user">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09c-.01-.02-.04-.03-.07-.03c-1.5.26-2.93.71-4.27 1.33c-.01 0-.02.01-.03.02c-2.72 4.07-3.47 8.03-3.1 11.95c0 .02.01.04.03.05c1.8 1.32 3.53 2.12 5.24 2.65c.03.01.06 0 .07-.02c.4-.55.76-1.13 1.07-1.74c.02-.04 0-.08-.04-.09c-.57-.22-1.11-.48-1.64-.78c-.04-.02-.04-.08-.01-.11c.11-.08.22-.17.33-.25c.02-.02.05-.02.07-.01c3.44 1.57 7.15 1.57 10.55 0c.02-.01.05-.01.07.01c.11.09.22.17.33.26c.04.03.04.09-.01.11c-.52.31-1.07.56-1.64.78c-.04.01-.05.06-.04.09c.32.61.68 1.19 1.07 1.74c.03.01.06.02.09.01c1.72-.53 3.45-1.33 5.25-2.65c.02-.01.03-.03.03-.05c.44-4.53-.73-8.46-3.1-11.95c-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.83 2.12-1.89 2.12z"/>
                  </svg>
                </span>
              </div>
              <span v-if="suggestion.username && !suggestion.isRole" class="suggest-username">{{ suggestion.username }}</span>
              <span v-if="suggestion.server_name" class="suggest-server">{{ suggestion.server_name }}</span>
            </template>
          </div>
        </div>
      </slot>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import DisplayName from '@/components/DisplayName.vue';

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
const isCommandList = computed(
  () => props.suggestions.length > 0 && props.suggestions.every((s) => s.isCommand),
);

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
  background: var(--background-tertiary);
  border-radius: 8px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  border: 1px solid var(--h-black-lighter);
  overflow-y: auto;
  min-width: 200px;
  max-width: 300px;
}

/* Klipy slash commands need room for "/aiemoji" + "Search KLIPY for …" */
.auto-suggest.auto-suggest-commands {
  min-width: 300px;
  max-width: 400px;
}

.suggest-header {
  padding: 8px 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-secondary);
  background: var(--background-secondary);
  border-bottom: 1px solid var(--h-black-lighter);
}

.suggest-item {
  padding: 8px 12px;
  cursor: pointer;
  transition: background-color 0.1s ease;
  border-bottom: 1px solid transparent;
}

.suggest-item:hover,
.suggest-item.selected {
  background: var(--h-black-lighter);
}

.suggest-item.selected {
  background: var(--harmony-primary);
}

.suggest-item.selected .suggest-server, .suggest-item.selected .suggest-name {
  color: #dcddde !important; /* Better contrast on selected background */
}

.suggest-item:hover .suggest-server, .suggest-item:hover .suggest-name {
  color: var(--text-secondary); /* Better contrast on hover background */
}

.suggest-item.selected .suggest-description {
  color: var(--text-secondary) !important; /* Better contrast on selected background */
}

.suggest-item:hover .suggest-description {
  color: var(--text-secondary); /* Better contrast on hover background */
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

.suggest-avatar {
  width: 24px !important;
  height: 24px !important;
}

.native-emoji-icon {
  width: 24px;
  height: 24px;
  font-size: 20px;
  line-height: 24px;
  text-align: center;
  flex-shrink: 0;
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


.suggest-name-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.suggest-name {
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bridge-badge {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}

.bridge-badge.discord {
  color: #5865F2; /* Discord blurple */
}

.bridge-badge.role-badge {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  padding: 2px 4px;
  border-radius: 3px;
  background: rgba(14, 165, 233, 0.2);
  color: #0EA5E9;
}

.role-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--text-primary);
}

.role-name {
  font-weight: 600;
}

.command-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent-color, #0EA5E9);
  color: var(--text-primary);
}

.command-name {
  font-weight: 600;
  color: var(--accent-color, #0EA5E9);
  flex-shrink: 0;
  overflow: visible;
  text-overflow: clip;
  max-width: 20ch; /* longest command is well under 20 chars */
}

.suggest-command-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.suggest-command-top {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
}

.suggest-command-description {
  font-size: 0.75rem;
  color: var(--text-muted, #949ba4);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.suggest-item.selected .suggest-command-description {
  color: var(--text-secondary) !important;
}

.suggest-item:hover .suggest-command-description {
  color: var(--text-secondary);
}

.suggest-command-params {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.suggest-param-tag {
  font-size: 0.7rem;
  padding: 1px 6px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--text-primary) 12%, transparent);
  color: var(--text-secondary);
  font-weight: 500;
}

.suggest-description {
  font-size: 0.75rem;
  color: var(--text-muted, #949ba4);
  margin-left: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.selected .bridge-badge {
  color: var(--text-primary);
}

.selected .bridge-badge.role-badge {
  background: rgba(255, 255, 255, 0.2);
}

.suggest-username {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.suggest-server {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.suggest-domain {
  font-size: 12px;
  color: var(--text-muted);
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
  background: var(--h-black-lighter);
  border-radius: 2px;
}

.auto-suggest::-webkit-scrollbar-thumb:hover {
  background: #4f545c;
}
</style>