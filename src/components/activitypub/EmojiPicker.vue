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
              :title="`Current: ${currentPack.name}`"
            >
              <span v-if="isNativePack">🔤</span>
              <span v-else>🎨</span>
            </button>
            <div v-if="showPackMenu" class="pack-menu" v-click-outside="() => showPackMenu = false">
              <div 
                v-for="pack in packs" 
                :key="pack.id"
                class="pack-option"
                :class="{ active: currentPackId === pack.id }"
                @click="switchPack(pack.id)"
              >
                <span class="pack-icon">{{ pack.id === 'native' ? '🔤' : '🎨' }}</span>
                <span class="pack-name">{{ pack.name }}</span>
                <span v-if="currentPackId === pack.id" class="check-mark">✓</span>
              </div>
            </div>
          </div>
          <button @click="$emit('close')" class="close-btn" title="Close">
            <Icon name="x" />
          </button>
        </div>
      </div>
      
      <div class="emoji-picker-content">
        <!-- Frequently used emojis (personalized) -->
        <div v-if="hasFrequentEmojis" class="quick-reactions frequent-section">
          <div class="quick-reactions-title">Frequently used</div>
          <div class="quick-reactions-grid">
            <button
              v-for="emoji in frequentEmojiItems"
              :key="emoji.content"
              class="emoji-btn quick-emoji frequent-emoji"
              @click="selectEmoji(emoji)"
              :title="emoji.name"
            >
              {{ emoji.content }}
            </button>
          </div>
        </div>
        
        <!-- Quick reaction emojis (common ones) -->
        <div class="quick-reactions">
          <div class="quick-reactions-title">Quick reactions</div>
          <div class="quick-reactions-grid">
            <button
              v-for="emoji in quickEmojis"
              :key="emoji.content"
              class="emoji-btn quick-emoji"
              @click="selectEmoji(emoji)"
              :title="emoji.name"
            >
              {{ emoji.content }}
            </button>
          </div>
        </div>
        
        <!-- Emoji categories -->
        <div class="emoji-categories">
          <div class="category-tabs">
            <button
              v-for="category in emojiCategories"
              :key="category.name"
              class="category-tab"
              :class="{ active: selectedCategory === category.name }"
              @click="selectedCategory = category.name"
              :title="category.name"
            >
              {{ category.icon }}
            </button>
          </div>
          
          <div class="category-content">
            <div class="emoji-grid">
              <button
                v-for="emoji in currentCategoryEmojis"
                :key="emoji.content"
                class="emoji-btn"
                @click="selectEmoji(emoji)"
                :title="emoji.name"
              >
                {{ emoji.content }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import Icon from '@/components/common/Icon.vue';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useFrequentEmojis } from '@/composables/useFrequentEmojis';
import { useEmojiPacks, loadPackEmojiIndex, getEmojiPackUrl, type EmojiPackItem } from '@/services/emojiPackService';

interface EmojiItem {
  content: string;
  name: string;
  category?: string;
}

interface EmojiCategory {
  name: string;
  icon: string;
  emojis: EmojiItem[];
}

interface Props {
  post: any; // TimelinePost type
}

const props = defineProps<Props>();

const emit = defineEmits<{
  close: [];
  emojiSelected: [emoji: EmojiItem];
}>();

const selectedCategory = ref('People');

// Quick reaction emojis (most commonly used)
const quickEmojis: EmojiItem[] = [
  { content: '👍', name: 'thumbs up' },
  { content: '❤️', name: 'heart' },
  { content: '😂', name: 'laughing' },
  { content: '😮', name: 'wow' },
  { content: '😢', name: 'sad' },
  { content: '😡', name: 'angry' },
  { content: '🎉', name: 'party' },
  { content: '🔥', name: 'fire' }
];

// Emoji categories with basic sets
const emojiCategories: EmojiCategory[] = [
  {
    name: 'People',
    icon: '😀',
    emojis: [
      { content: '😀', name: 'grinning' },
      { content: '😃', name: 'grinning with big eyes' },
      { content: '😄', name: 'grinning with smiling eyes' },
      { content: '😁', name: 'beaming with smiling eyes' },
      { content: '😆', name: 'grinning squinting' },
      { content: '😅', name: 'grinning with sweat' },
      { content: '🤣', name: 'rolling on floor laughing' },
      { content: '😂', name: 'face with tears of joy' },
      { content: '🙂', name: 'slightly smiling' },
      { content: '🙃', name: 'upside-down face' },
      { content: '😉', name: 'winking' },
      { content: '😊', name: 'smiling with smiling eyes' },
      { content: '😇', name: 'smiling with halo' },
      { content: '🥰', name: 'smiling with hearts' },
      { content: '😍', name: 'heart eyes' },
      { content: '🤩', name: 'star-struck' },
      { content: '😘', name: 'face blowing kiss' },
      { content: '😗', name: 'kissing' },
      { content: '😚', name: 'kissing with closed eyes' },
      { content: '😙', name: 'kissing with smiling eyes' },
      { content: '😋', name: 'face savoring food' },
      { content: '😛', name: 'face with tongue' },
      { content: '😜', name: 'winking with tongue' },
      { content: '🤪', name: 'zany face' },
      { content: '😝', name: 'squinting with tongue' },
      { content: '🤑', name: 'money-mouth face' },
      { content: '🤗', name: 'hugging' },
      { content: '🤭', name: 'face with hand over mouth' },
      { content: '🤫', name: 'shushing' },
      { content: '🤔', name: 'thinking' },
      { content: '🤐', name: 'zipper-mouth' },
      { content: '🤨', name: 'face with raised eyebrow' },
      { content: '😐', name: 'neutral' },
      { content: '😑', name: 'expressionless' },
      { content: '😶', name: 'face without mouth' },
      { content: '😒', name: 'unamused' },
      { content: '🙄', name: 'face with rolling eyes' },
      { content: '😬', name: 'grimacing' },
      { content: '🤥', name: 'lying' },
      { content: '😔', name: 'pensive' },
      { content: '😪', name: 'sleepy' },
      { content: '🤤', name: 'drooling' },
      { content: '😴', name: 'sleeping' },
      { content: '😷', name: 'face with medical mask' },
      { content: '🤒', name: 'face with thermometer' },
      { content: '🤕', name: 'face with head-bandage' },
      { content: '🤢', name: 'nauseated' },
      { content: '🤮', name: 'face vomiting' },
      { content: '🤧', name: 'sneezing' },
      { content: '🥵', name: 'hot face' },
      { content: '🥶', name: 'cold face' },
      { content: '🥴', name: 'woozy' },
      { content: '😵', name: 'dizzy' },
      { content: '🤯', name: 'exploding head' },
      { content: '🤠', name: 'cowboy hat face' },
      { content: '🥳', name: 'partying' },
      { content: '😎', name: 'smiling with sunglasses' },
      { content: '🤓', name: 'nerd face' },
      { content: '🧐', name: 'face with monocle' }
    ]
  },
  {
    name: 'Nature',
    icon: '🌱',
    emojis: [
      { content: '🐶', name: 'dog face' },
      { content: '🐱', name: 'cat face' },
      { content: '🐭', name: 'mouse face' },
      { content: '🐹', name: 'hamster face' },
      { content: '🐰', name: 'rabbit face' },
      { content: '🦊', name: 'fox face' },
      { content: '🐻', name: 'bear face' },
      { content: '🐼', name: 'panda face' },
      { content: '🐨', name: 'koala face' },
      { content: '🐯', name: 'tiger face' },
      { content: '🦁', name: 'lion face' },
      { content: '🐮', name: 'cow face' },
      { content: '🐷', name: 'pig face' },
      { content: '🐽', name: 'pig nose' },
      { content: '🐸', name: 'frog face' },
      { content: '🐵', name: 'monkey face' },
      { content: '🙈', name: 'see-no-evil monkey' },
      { content: '🙉', name: 'hear-no-evil monkey' },
      { content: '🙊', name: 'speak-no-evil monkey' },
      { content: '🐒', name: 'monkey' },
      { content: '🐔', name: 'chicken' },
      { content: '🐧', name: 'penguin' },
      { content: '🐦', name: 'bird' },
      { content: '🐤', name: 'baby chick' },
      { content: '🐣', name: 'hatching chick' },
      { content: '🐥', name: 'front-facing baby chick' },
      { content: '🦆', name: 'duck' },
      { content: '🦅', name: 'eagle' },
      { content: '🦉', name: 'owl' },
      { content: '🦇', name: 'bat' },
      { content: '🐺', name: 'wolf face' },
      { content: '🐗', name: 'boar' },
      { content: '🐴', name: 'horse face' },
      { content: '🦄', name: 'unicorn face' },
      { content: '🐝', name: 'honeybee' },
      { content: '🐛', name: 'bug' },
      { content: '🦋', name: 'butterfly' },
      { content: '🐌', name: 'snail' },
      { content: '🐞', name: 'lady beetle' },
      { content: '🐜', name: 'ant' },
      { content: '🦟', name: 'mosquito' },
      { content: '🦗', name: 'cricket' },
      { content: '🕷️', name: 'spider' },
      { content: '🕸️', name: 'spider web' },
      { content: '🦂', name: 'scorpion' }
    ]
  },
  {
    name: 'Objects',
    icon: '⚽',
    emojis: [
      { content: '⚽', name: 'soccer ball' },
      { content: '🏀', name: 'basketball' },
      { content: '🏈', name: 'american football' },
      { content: '⚾', name: 'baseball' },
      { content: '🥎', name: 'softball' },
      { content: '🎾', name: 'tennis' },
      { content: '🏐', name: 'volleyball' },
      { content: '🏉', name: 'rugby football' },
      { content: '🥏', name: 'flying disc' },
      { content: '🎱', name: 'pool 8 ball' },
      { content: '🪀', name: 'yo-yo' },
      { content: '🏓', name: 'ping pong' },
      { content: '🏸', name: 'badminton' },
      { content: '🏒', name: 'ice hockey' },
      { content: '🏑', name: 'field hockey' },
      { content: '🥍', name: 'lacrosse' },
      { content: '🏏', name: 'cricket game' },
      { content: '🪃', name: 'boomerang' },
      { content: '🎣', name: 'fishing pole' },
      { content: '🤿', name: 'diving mask' },
      { content: '🎽', name: 'running shirt' },
      { content: '🎿', name: 'skis' },
      { content: '🛷', name: 'sled' },
      { content: '🥌', name: 'curling stone' }
    ]
  },
  {
    name: 'Symbols',
    icon: '❤️',
    emojis: [
      { content: '❤️', name: 'red heart' },
      { content: '🧡', name: 'orange heart' },
      { content: '💛', name: 'yellow heart' },
      { content: '💚', name: 'green heart' },
      { content: '💙', name: 'blue heart' },
      { content: '💜', name: 'purple heart' },
      { content: '🖤', name: 'black heart' },
      { content: '🤍', name: 'white heart' },
      { content: '🤎', name: 'brown heart' },
      { content: '💔', name: 'broken heart' },
      { content: '❣️', name: 'heart exclamation' },
      { content: '💕', name: 'two hearts' },
      { content: '💖', name: 'sparkling heart' },
      { content: '💗', name: 'growing heart' },
      { content: '💘', name: 'heart with arrow' },
      { content: '💝', name: 'heart with ribbon' },
      { content: '💟', name: 'heart decoration' },
      { content: '☮️', name: 'peace symbol' },
      { content: '✝️', name: 'latin cross' },
      { content: '☪️', name: 'star and crescent' },
      { content: '🕉️', name: 'om' },
      { content: '☸️', name: 'wheel of dharma' },
      { content: '✡️', name: 'star of david' },
      { content: '🔯', name: 'dotted six-pointed star' },
      { content: '🕎', name: 'menorah' },
      { content: '☯️', name: 'yin yang' },
      { content: '☦️', name: 'orthodox cross' },
      { content: '🛐', name: 'place of worship' },
      { content: '⛎', name: 'ophiuchus' },
      { content: '♈', name: 'aries' },
      { content: '♉', name: 'taurus' },
      { content: '♊', name: 'gemini' },
      { content: '♋', name: 'cancer' },
      { content: '♌', name: 'leo' },
      { content: '♍', name: 'virgo' },
      { content: '♎', name: 'libra' },
      { content: '♏', name: 'scorpius' },
      { content: '♐', name: 'sagittarius' },
      { content: '♑', name: 'capricorn' },
      { content: '♒', name: 'aquarius' },
      { content: '♓', name: 'pisces' },
      { content: '🆔', name: 'id' },
      { content: '⚛️', name: 'atom symbol' },
      { content: '🉑', name: 'japanese "acceptable" button' },
      { content: '☢️', name: 'radioactive' },
      { content: '☣️', name: 'biohazard' },
      { content: '📴', name: 'mobile phone off' },
      { content: '📳', name: 'vibration mode' },
      { content: '🈶', name: 'japanese "not free of charge" button' },
      { content: '🈚', name: 'japanese "free of charge" button' },
      { content: '🈸', name: 'japanese "application" button' },
      { content: '🈺', name: 'japanese "open for business" button' },
      { content: '🈷️', name: 'japanese "monthly amount" button' },
      { content: '✴️', name: 'eight-pointed star' },
      { content: '🆚', name: 'vs' },
      { content: '💮', name: 'white flower' },
      { content: '🉐', name: 'japanese "bargain" button' },
      { content: '㊙️', name: 'japanese "secret" button' },
      { content: '㊗️', name: 'japanese "congratulations" button' },
      { content: '🈴', name: 'japanese "passing grade" button' },
      { content: '🈵', name: 'japanese "no vacancy" button' },
      { content: '🈹', name: 'japanese "discount" button' },
      { content: '🈲', name: 'japanese "prohibited" button' },
      { content: '🅰️', name: 'a button (blood type)' },
      { content: '🅱️', name: 'b button (blood type)' },
      { content: '🆎', name: 'ab button (blood type)' },
      { content: '🆑', name: 'cl button' },
      { content: '🅾️', name: 'o button (blood type)' },
      { content: '🆘', name: 'sos' },
      { content: '❌', name: 'cross mark' },
      { content: '⭕', name: 'heavy large circle' },
      { content: '🛑', name: 'stop sign' },
      { content: '⛔', name: 'no entry' },
      { content: '📛', name: 'name badge' },
      { content: '🚫', name: 'prohibited' },
      { content: '💯', name: 'hundred points' },
      { content: '💢', name: 'anger symbol' },
      { content: '♨️', name: 'hot springs' },
      { content: '🚷', name: 'no pedestrians' },
      { content: '🚯', name: 'no littering' },
      { content: '🚳', name: 'no bicycles' },
      { content: '🚱', name: 'non-potable water' },
      { content: '🔞', name: 'no one under eighteen' },
      { content: '📵', name: 'no mobile phones' },
      { content: '🚭', name: 'no smoking' }
    ]
  }
];

const currentCategoryEmojis = computed(() => {
  const category = emojiCategories.find(cat => cat.name === selectedCategory.value);
  return category ? category.emojis : [];
});

const { triggerReaction } = useHapticSettings();
const { topEmojisForPicker, hasFrequentEmojis, recordEmojiUsage } = useFrequentEmojis();
const { currentPackId, currentPack, packs, isNativePack, setCurrentPack } = useEmojiPacks();

// Pack menu state
const showPackMenu = ref(false);
const mutantEmojis = ref<EmojiPackItem[]>([]);
const isLoadingPack = ref(false);

// Load mutant emojis when switching to mutant pack
const loadMutantEmojis = async () => {
  if (mutantEmojis.value.length > 0) return; // Already loaded
  
  isLoadingPack.value = true;
  try {
    mutantEmojis.value = await loadPackEmojiIndex('mutant');
  } catch (error) {
    console.error('Failed to load mutant emojis:', error);
  } finally {
    isLoadingPack.value = false;
  }
};

// Switch pack
const switchPack = (packId: string) => {
  setCurrentPack(packId);
  showPackMenu.value = false;
  
  if (packId === 'mutant') {
    loadMutantEmojis();
  }
};

// Convert frequent emojis to EmojiItem format
const frequentEmojiItems = computed<EmojiItem[]>(() => {
  return topEmojisForPicker.value.map(e => ({
    content: e.native || e.name,
    name: e.name
  }));
});

// Load mutant emojis on mount if that's the current pack
onMounted(() => {
  if (currentPackId.value === 'mutant') {
    loadMutantEmojis();
  }
});

const selectEmoji = (emoji: EmojiItem) => {
  // Haptic feedback when selecting an emoji for reaction
  triggerReaction();
  
  // Record usage for frequently used emojis
  recordEmojiUsage({
    native: emoji.content,
    name: emoji.name
  });
  
  emit('emojiSelected', emoji);
  emit('close');
};
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
  background: var(--color-bg-primary);
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
  min-width: 160px;
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
  background: rgba(88, 101, 242, 0.15);
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
  color: #5865f2;
  font-size: 14px;
  border-bottom: 1px solid var(--color-border);
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

.quick-reactions {
  margin-bottom: 1.5rem;
}

.quick-reactions-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-text-secondary);
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
  padding: 0.75rem;
  cursor: pointer;
  font-size: 1.5rem;
  line-height: 1;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
}

.emoji-btn:hover {
  background: var(--color-bg-hover);
  border-color: var(--color-primary);
  transform: scale(1.05);
}

.quick-emoji {
  font-size: 1.75rem;
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
  color: white;
}

.emoji-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 0.5rem;
}

.emoji-grid .emoji-btn {
  font-size: 1.25rem;
  padding: 0.5rem;
  min-height: 40px;
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
}

/* Dark mode adjustments */
@media (prefers-color-scheme: dark) {
  .emoji-picker {
    background: #1a1a1a;
    border-color: #333;
  }
  
  .emoji-btn {
    background: #2a2a2a;
    border-color: #444;
  }
  
  .emoji-btn:hover {
    background: #3a3a3a;
    border-color: #5865f2;
  }
  
  .category-tab {
    background: #2a2a2a;
    border-color: #444;
  }
}
</style>
