<template>
  <div class="emoji-picker-overlay" @click.self="$emit('close')">
    <div class="emoji-picker">
      <div class="emoji-picker-header">
        <h3>Choose a reaction</h3>
        <div class="header-actions">
          <!-- Pack Switcher -->
          <div class="pack-switcher">
            <button 
              class="pack-btn"
              :class="{ active: showPackMenu }"
              @click="showPackMenu = !showPackMenu"
              :title="`Current: ${currentPackName}`"
            >
              <span v-if="isNativePack">🔤</span>
              <span v-else-if="isTwemojiPack">🐦</span>
              <span v-else>🎨</span>
            </button>
            <div v-if="showPackMenu" class="pack-menu" v-click-outside="() => showPackMenu = false">
              <div 
                class="pack-option"
                :class="{ active: currentPack === 'twemoji' }"
                @click="switchPack('twemoji')"
              >
                <span class="pack-icon">🐦</span>
                <span class="pack-name">Twemoji</span>
                <span v-if="currentPack === 'twemoji'" class="check-mark">✓</span>
              </div>
              <div 
                class="pack-option"
                :class="{ active: currentPack === 'mutant' }"
                @click="switchPack('mutant')"
              >
                <span class="pack-icon">🎨</span>
                <span class="pack-name">Mutant Standard</span>
                <span v-if="currentPack === 'mutant'" class="check-mark">✓</span>
              </div>
              <div 
                class="pack-option"
                :class="{ active: currentPack === 'native' }"
                @click="switchPack('native')"
              >
                <span class="pack-icon">🔤</span>
                <span class="pack-name">System</span>
                <span v-if="currentPack === 'native'" class="check-mark">✓</span>
              </div>
            </div>
          </div>
          <button @click="$emit('close')" class="close-btn" title="Close">
            <Icon name="x" />
          </button>
        </div>
      </div>
      
      <div class="emoji-picker-content">
        <!-- Loading state -->
        <div v-if="isLoading" class="emoji-loading">
          <span class="loading-spinner"></span>
          <span>Loading emojis...</span>
        </div>

        <template v-else>
          <!-- Frequently used emojis (personalized) -->
          <div v-if="hasFrequentEmojis" class="quick-reactions frequent-section">
            <div class="quick-reactions-title">Frequently used</div>
            <div class="quick-reactions-grid">
              <button
                v-for="emoji in frequentEmojiItems"
                :key="emoji.unicode"
                class="emoji-btn quick-emoji frequent-emoji"
                @click="selectEmoji(emoji)"
                @pointerenter="hoveredEmojiName = emoji.name"
                @pointerleave="hoveredEmojiName = null"
              >
                <img 
                  v-if="!isNativePack && emoji.svgUrl" 
                  :src="emoji.svgUrl" 
                  :alt="emoji.name"
                  class="emoji-img"
                />
                <span v-else>{{ emoji.unicode }}</span>
              </button>
            </div>
          </div>
          
          <!-- Quick reaction emojis (common ones) -->
          <div class="quick-reactions">
            <div class="quick-reactions-title">Quick reactions</div>
            <div class="quick-reactions-grid">
              <button
                v-for="emoji in quickReactionEmojis"
                :key="emoji.unicode"
                class="emoji-btn quick-emoji"
                @click="selectEmoji(emoji)"
                @pointerenter="hoveredEmojiName = emoji.name"
                @pointerleave="hoveredEmojiName = null"
              >
                <img 
                  v-if="!isNativePack && emoji.svgUrl" 
                  :src="emoji.svgUrl" 
                  :alt="emoji.name"
                  class="emoji-img"
                />
                <span v-else>{{ emoji.unicode }}</span>
              </button>
            </div>
          </div>
          
          <!-- Emoji categories -->
          <div class="emoji-categories">
            <div class="category-tabs">
              <button
                v-for="category in displayedCategories"
                :key="category.id"
                class="category-tab"
                :class="{ active: selectedCategory === category.id }"
                @click="selectedCategory = category.id"
                :title="category.name"
              >
                {{ category.icon }}
              </button>
            </div>
            
            <div class="category-content">
              <div class="emoji-grid">
                <button
                  v-for="emoji in currentCategoryEmojis"
                  :key="emoji.unicode"
                  class="emoji-btn"
                  @click="selectEmoji(emoji)"
                  @pointerenter="hoveredEmojiName = emoji.name"
                  @pointerleave="hoveredEmojiName = null"
                >
                  <img 
                    v-if="!isNativePack && emoji.svgUrl" 
                    :src="emoji.svgUrl" 
                    :alt="emoji.name"
                    class="emoji-img"
                    loading="lazy"
                  />
                  <span v-else>{{ emoji.unicode }}</span>
                </button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- Emoji preview bar -->
      <div class="emoji-preview-bar">
        <span v-if="hoveredEmojiName" class="emoji-preview-name">:{{ hoveredEmojiName }}:</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import Icon from '@/components/common/Icon.vue';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useFrequentEmojis } from '@/composables/useFrequentEmojis';
import { useUnifiedEmoji, type EmojiEntry } from '@/services/unifiedEmojiService';
import { EMOJI_CATEGORIES, QUICK_REACTION_EMOJIS, type EmojiPack } from '@/utils/emojiConstants';

interface DisplayEmoji {
  unicode: string;
  name: string;
  shortcode: string;
  svgUrl?: string;
}

interface Props {
  post: any; // TimelinePost type
}

defineProps<Props>();

const emit = defineEmits<{
  close: [];
  emojiSelected: [emoji: { content: string; name: string }];
}>();

// Composables
const { triggerReaction } = useHapticSettings();
const { topEmojisForPicker, hasFrequentEmojis, recordEmojiUsage } = useFrequentEmojis();
const { 
  currentPack,
  isNativePack,
  isTwemojiPack,
  isLoaded,
  isLoading,
  setEmojiPack,
  getCategories,
  getEmojisByCategory,
  resolveEmoji,
  getTwemojiUrl
} = useUnifiedEmoji();

// State
const selectedCategory = ref('people');
const showPackMenu = ref(false);
const hoveredEmojiName = ref<string | null>(null);

// Computed
const currentPackName = computed(() => {
  switch (currentPack.value) {
    case 'twemoji': return 'Twemoji';
    case 'mutant': return 'Mutant Standard';
    case 'native': return 'System';
    default: return 'Unknown';
  }
});

// Get categories from unified service (sorted by order)
const displayedCategories = computed(() => {
  const cats = getCategories();
  if (cats.length > 0) {
    return cats;
  }
  // Fallback to constants if data not loaded yet
  return EMOJI_CATEGORIES;
});

// Get emojis for current category with SVG URLs resolved
const currentCategoryEmojis = computed((): DisplayEmoji[] => {
  const emojis = getEmojisByCategory(selectedCategory.value);
  return emojis.map(emoji => ({
    unicode: emoji.unicode,
    name: emoji.name || emoji.shortcode,
    shortcode: emoji.shortcode,
    svgUrl: getEmojiSvgUrl(emoji)
  }));
});

// Quick reaction emojis with SVG URLs
const quickReactionEmojis = computed((): DisplayEmoji[] => {
  return QUICK_REACTION_EMOJIS.map(qe => ({
    unicode: qe.unicode,
    name: qe.name,
    shortcode: qe.shortcode,
    svgUrl: getEmojiSvgUrl({ unicode: qe.unicode, shortcode: qe.shortcode } as EmojiEntry)
  }));
});

// Frequent emojis with SVG URLs
const frequentEmojiItems = computed((): DisplayEmoji[] => {
  return topEmojisForPicker.value.map(e => {
    const unicode = e.native || e.name;
    return {
      unicode,
      name: e.name,
      shortcode: e.name,
      svgUrl: getEmojiSvgUrl({ unicode, shortcode: e.name } as EmojiEntry)
    };
  });
});

// Helper to get SVG URL for an emoji based on current pack
function getEmojiSvgUrl(emoji: EmojiEntry): string | undefined {
  if (isNativePack.value) return undefined;
  
  const resolved = resolveEmoji(emoji.unicode);
  if (resolved.display.type === 'svg') {
    return resolved.display.content;
  }
  
  // Fallback: try to get twemoji URL directly
  if (isTwemojiPack.value) {
    return getTwemojiUrl(emoji.unicode) || undefined;
  }
  
  return undefined;
}

// Switch pack
function switchPack(packId: EmojiPack) {
  setEmojiPack(packId);
  showPackMenu.value = false;
}

// Select emoji
function selectEmoji(emoji: DisplayEmoji) {
  triggerReaction();
  
  // Record usage for frequently used emojis
  recordEmojiUsage({
    native: emoji.unicode,
    name: emoji.name
  });
  
  // Emit in the expected format
  emit('emojiSelected', { 
    content: emoji.unicode, 
    name: emoji.name 
  });
  emit('close');
}

// Set initial category when data loads
watch(isLoaded, (loaded) => {
  if (loaded && displayedCategories.value.length > 0) {
    selectedCategory.value = displayedCategories.value[0].id;
  }
});

onMounted(() => {
  // Set initial category
  if (displayedCategories.value.length > 0) {
    selectedCategory.value = displayedCategories.value[0].id;
  }
});
</script>

<style scoped>
.emoji-picker-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.emoji-picker {
  border-radius: 12px;
  width: 90vw;
  max-width: 400px;
  max-height: 80vh;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
  border: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
}

.emoji-picker-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--color-border);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pack-switcher {
  position: relative;
}

.pack-btn {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: none;
  background: var(--color-bg-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  transition: all 0.15s ease;
}

.pack-btn:hover,
.pack-btn.active {
  background: var(--color-bg-tertiary);
}

.pack-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  min-width: 180px;
  z-index: 100;
  overflow: hidden;
}

.pack-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.pack-option:hover {
  background: var(--color-bg-secondary);
}

.pack-option.active {
  background: rgba(14, 165, 233, 0.15);
}

.pack-icon {
  font-size: 16px;
}

.pack-name {
  flex: 1;
  font-size: 13px;
  color: var(--color-text-primary);
}

.check-mark {
  color: #0EA5E9;
  font-size: 14px;
}

.emoji-picker-header h3 {
  margin: 0;
  font-size: 1.1rem;
  color: var(--color-text-primary);
}

.close-btn {
  background: none;
  border: none;
  color: var(--color-text-secondary);
  cursor: pointer;
  padding: 0.25rem;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.2s ease;
}

.close-btn:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.emoji-picker-content {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
}

.emoji-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 48px;
  color: var(--color-text-secondary);
}

.loading-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.quick-reactions {
  margin-bottom: 1.5rem;
}

.quick-reactions-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 0.75rem;
}

.quick-reactions-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.5rem;
}

.emoji-btn {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 0.5rem;
  cursor: pointer;
  font-size: 1.5rem;
  line-height: 1;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
}

.emoji-btn:hover {
  background: var(--color-bg-hover);
  border-color: var(--color-primary);
  transform: scale(1.05);
}

.emoji-img {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

.quick-emoji {
  font-size: 1.75rem;
}

.quick-emoji .emoji-img {
  width: 28px;
  height: 28px;
}

.category-tabs {
  display: flex;
  gap: 0.25rem;
  margin-bottom: 1rem;
  overflow-x: auto;
  padding-bottom: 0.25rem;
}

.category-tab {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  font-size: 1.25rem;
  min-width: 40px;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.category-tab:hover,
.category-tab.active {
  background: var(--color-primary);
  border-color: var(--color-primary);
}

.emoji-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 0.5rem;
}

.emoji-grid .emoji-btn {
  font-size: 1.25rem;
  padding: 0.4rem;
  min-height: 40px;
}

.emoji-grid .emoji-img {
  width: 22px;
  height: 22px;
}

/* Mobile responsive */
@media (max-width: 480px) {
  .emoji-picker {
    width: 95vw;
    max-height: 70vh;
  }
  
  .quick-reactions-grid {
    grid-template-columns: repeat(4, 1fr);
  }
  
  .emoji-grid {
    grid-template-columns: repeat(5, 1fr);
  }
  
  .emoji-btn {
    font-size: 1.1rem;
    padding: 0.4rem;
    min-height: 36px;
  }

  .emoji-img {
    width: 20px;
    height: 20px;
  }
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
