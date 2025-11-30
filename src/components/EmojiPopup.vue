<template>
  <div ref="emojiPopup" class="emoji-popup" :style="positionStyle">
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
      <!-- Frequently Used Emojis -->
      <div v-if="!searchQuery && hasFrequentEmojis" class="emoji-section">
        <h3 class="section-title">⏱️ Frequently Used</h3>
        <div class="emoji-list frequent-list">
          <div
            v-for="emoji in topEmojisForPicker"
            :key="emoji.id"
            class="emoji-item"
            :class="{ 'native-emoji-item': emoji.native && !emoji.url, 'mutant-emoji-item': emoji.url }"
            :title="`:${emoji.name}:`"
            @click="selectFrequentEmoji(emoji)"
          >
            <!-- Custom/Mutant emoji with URL -->
            <img 
              v-if="emoji.url"
              :src="emoji.url"
              :alt="emoji.name"
              class="frequent-emoji-img"
            />
            <!-- Native unicode emoji -->
            <span v-else-if="emoji.native">{{ emoji.native }}</span>
            <!-- Fallback to name -->
            <span v-else class="emoji-shortcode">:{{ emoji.name }}:</span>
          </div>
        </div>
      </div>

      <!-- Server Emojis List -->
      <div v-if="filteredEmojiList.length">
        <div v-for="group in filteredEmojiList" :key="group.serverId">
          <h3 class="section-title">{{ group.server_name }}</h3>
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
      
      <!-- Standard Unicode Emojis by Category (only when native pack selected) -->
      <div v-for="category in displayedNativeCategories" :key="category.name" class="emoji-section">
        <h3 class="section-title">{{ category.icon }} {{ category.name }}</h3>
        <div class="emoji-list native-list">
          <div
            v-for="emoji in category.emojis"
            :key="emoji.content"
            class="emoji-item native-emoji-item"
            :title="emoji.name"
            @click="selectQuickEmoji(emoji)"
          >
            <span>{{ emoji.content }}</span>
          </div>
        </div>
      </div>
      
      <!-- Mutant Standard Emojis by Category -->
      <div v-if="mutantLoading" class="emoji-loading">
        <span class="loading-spinner"></span>
        <span>Loading emojis...</span>
      </div>
      
      <div v-for="category in displayedMutantCategories" :key="category.id" class="emoji-section">
        <h3 class="section-title">{{ category.icon }} {{ category.name }}</h3>
        <div class="emoji-list mutant-list">
          <div
            v-for="emoji in category.emojis"
            :key="emoji.id"
            class="emoji-item mutant-emoji-item"
            :title="`:${emoji.name}:`"
            @click="selectMutantEmoji(emoji)"
          >
            <img 
              :src="`/assets/emojis/mutant_emojis_svg/${emoji.path}`" 
              :alt="emoji.name"
              loading="lazy"
            />
          </div>
        </div>
      </div>
      
      <!-- No Results -->
      <div v-if="searchQuery && !filteredEmojiList.length && !displayedNativeCategories.length && !displayedMutantCategories.length" class="no-results">
        <div class="no-results-content">
          <div class="no-results-icon">{{ noResultsInfo.icon }}</div>
          <p>{{ noResultsInfo.title }}</p>
          <small>{{ noResultsInfo.subtitle }}</small>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick, watch } from 'vue';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import { usePopupPositioning } from '@/composables/usePopupPositioning';
import { useFrequentEmojis } from '@/composables/useFrequentEmojis';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useEmojiPacks, loadPackEmojiIndex, type EmojiPackItem } from '@/services/emojiPackService';
import type { Emoji, ResolvedEmoji } from '@/types';
import { getEmojiUrl } from '@/utils/emojiUtils';
import { debug } from '@/utils/debug';

// Native emoji item interface
interface NativeEmojiItem {
  content: string;
  name: string;
}

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
const { topEmojisForPicker, hasFrequentEmojis, recordEmojiUsage } = useFrequentEmojis();
const { triggerReaction } = useHapticSettings();
const { currentPack, isNativePack, currentPackId } = useEmojiPacks();
const emojiPopup = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const searchQuery = ref('');
const hoveredEmojiId = ref<string | null>(null);

// Mutant emoji pack data
const mutantEmojis = ref<EmojiPackItem[]>([]);
const mutantCategories = ref<{ id: string; name: string; icon: string; count: number }[]>([]);
const mutantLoading = ref(false);
const mutantLoaded = ref(false);

// Quick reaction emojis (native unicode)
const quickReactionEmojis: NativeEmojiItem[] = [
  { content: '👍', name: 'thumbs up' },
  { content: '❤️', name: 'heart' },
  { content: '😂', name: 'laughing' },
  { content: '😮', name: 'wow' },
  { content: '😢', name: 'sad' },
  { content: '😡', name: 'angry' },
  { content: '🎉', name: 'party' },
  { content: '🔥', name: 'fire' },
  { content: '👀', name: 'eyes' },
  { content: '🤔', name: 'thinking' },
  { content: '💯', name: '100' },
  { content: '✨', name: 'sparkles' },
];

// Extended native emojis for search
const allNativeEmojis: NativeEmojiItem[] = [
  // Smileys
  { content: '😀', name: 'grinning' },
  { content: '😃', name: 'smiley' },
  { content: '😄', name: 'smile' },
  { content: '😁', name: 'grin' },
  { content: '😆', name: 'laughing squint' },
  { content: '😅', name: 'sweat smile' },
  { content: '🤣', name: 'rofl' },
  { content: '😂', name: 'joy tears' },
  { content: '🙂', name: 'slightly smiling' },
  { content: '🙃', name: 'upside down' },
  { content: '😉', name: 'wink' },
  { content: '😊', name: 'blush' },
  { content: '😇', name: 'innocent' },
  { content: '🥰', name: 'smiling hearts' },
  { content: '😍', name: 'heart eyes' },
  { content: '🤩', name: 'star struck' },
  { content: '😘', name: 'kiss' },
  { content: '😗', name: 'kissing' },
  { content: '😚', name: 'kissing closed eyes' },
  { content: '😋', name: 'yum' },
  { content: '😛', name: 'tongue out' },
  { content: '😜', name: 'winking tongue' },
  { content: '🤪', name: 'zany' },
  { content: '😝', name: 'squinting tongue' },
  { content: '🤑', name: 'money face' },
  { content: '🤗', name: 'hugging' },
  { content: '🤭', name: 'hand over mouth' },
  { content: '🤫', name: 'shushing' },
  { content: '🤔', name: 'thinking' },
  { content: '🤐', name: 'zipper mouth' },
  { content: '🤨', name: 'raised eyebrow' },
  { content: '😐', name: 'neutral' },
  { content: '😑', name: 'expressionless' },
  { content: '😶', name: 'no mouth' },
  { content: '😏', name: 'smirk' },
  { content: '😒', name: 'unamused' },
  { content: '🙄', name: 'eye roll' },
  { content: '😬', name: 'grimace' },
  { content: '🤥', name: 'lying' },
  { content: '😌', name: 'relieved' },
  { content: '😔', name: 'pensive' },
  { content: '😪', name: 'sleepy' },
  { content: '🤤', name: 'drooling' },
  { content: '😴', name: 'sleeping' },
  { content: '😷', name: 'mask' },
  { content: '🤒', name: 'thermometer' },
  { content: '🤕', name: 'head bandage' },
  { content: '🤢', name: 'nauseated' },
  { content: '🤮', name: 'vomiting' },
  { content: '🤧', name: 'sneezing' },
  { content: '🥵', name: 'hot' },
  { content: '🥶', name: 'cold' },
  { content: '🥴', name: 'woozy' },
  { content: '😵', name: 'dizzy' },
  { content: '🤯', name: 'exploding head' },
  { content: '🤠', name: 'cowboy' },
  { content: '🥳', name: 'partying' },
  { content: '😎', name: 'cool sunglasses' },
  { content: '🤓', name: 'nerd' },
  { content: '🧐', name: 'monocle' },
  { content: '😕', name: 'confused' },
  { content: '😟', name: 'worried' },
  { content: '🙁', name: 'slightly frowning' },
  { content: '😮', name: 'open mouth' },
  { content: '😯', name: 'hushed' },
  { content: '😲', name: 'astonished' },
  { content: '😳', name: 'flushed' },
  { content: '🥺', name: 'pleading' },
  { content: '😦', name: 'frowning open mouth' },
  { content: '😧', name: 'anguished' },
  { content: '😨', name: 'fearful' },
  { content: '😰', name: 'anxious sweat' },
  { content: '😥', name: 'sad relieved' },
  { content: '😢', name: 'crying' },
  { content: '😭', name: 'loudly crying' },
  { content: '😱', name: 'screaming' },
  { content: '😖', name: 'confounded' },
  { content: '😣', name: 'persevering' },
  { content: '😞', name: 'disappointed' },
  { content: '😓', name: 'downcast sweat' },
  { content: '😩', name: 'weary' },
  { content: '😫', name: 'tired' },
  { content: '🥱', name: 'yawning' },
  { content: '😤', name: 'triumph' },
  { content: '😡', name: 'angry' },
  { content: '😠', name: 'pouting' },
  { content: '🤬', name: 'cursing' },
  { content: '😈', name: 'smiling devil' },
  { content: '👿', name: 'angry devil' },
  { content: '💀', name: 'skull' },
  { content: '☠️', name: 'skull crossbones' },
  { content: '💩', name: 'poop' },
  { content: '🤡', name: 'clown' },
  { content: '👹', name: 'ogre' },
  { content: '👺', name: 'goblin' },
  { content: '👻', name: 'ghost' },
  { content: '👽', name: 'alien' },
  { content: '👾', name: 'alien monster' },
  { content: '🤖', name: 'robot' },
  // Gestures
  { content: '👍', name: 'thumbs up' },
  { content: '👎', name: 'thumbs down' },
  { content: '👌', name: 'ok hand' },
  { content: '✌️', name: 'peace' },
  { content: '🤞', name: 'crossed fingers' },
  { content: '🤟', name: 'love you' },
  { content: '🤘', name: 'rock' },
  { content: '👋', name: 'wave' },
  { content: '🤚', name: 'raised back hand' },
  { content: '✋', name: 'raised hand' },
  { content: '🖐️', name: 'hand splayed' },
  { content: '👊', name: 'fist bump' },
  { content: '✊', name: 'raised fist' },
  { content: '👏', name: 'clap' },
  { content: '🙌', name: 'raising hands' },
  { content: '🙏', name: 'pray please' },
  // Hearts
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
  { content: '💕', name: 'two hearts' },
  { content: '💖', name: 'sparkling heart' },
  { content: '💗', name: 'growing heart' },
  { content: '💘', name: 'heart arrow' },
  { content: '💝', name: 'heart ribbon' },
  // Objects & Symbols
  { content: '🔥', name: 'fire' },
  { content: '✨', name: 'sparkles' },
  { content: '⭐', name: 'star' },
  { content: '🌟', name: 'glowing star' },
  { content: '💫', name: 'dizzy star' },
  { content: '🎉', name: 'party popper' },
  { content: '🎊', name: 'confetti ball' },
  { content: '💯', name: '100' },
  { content: '💢', name: 'anger' },
  { content: '💥', name: 'collision' },
  { content: '💦', name: 'sweat drops' },
  { content: '💨', name: 'dash' },
  { content: '💬', name: 'speech bubble' },
  { content: '💭', name: 'thought bubble' },
  { content: '👀', name: 'eyes' },
  { content: '🙈', name: 'see no evil' },
  { content: '🙉', name: 'hear no evil' },
  { content: '🙊', name: 'speak no evil' },
];

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
 * Native emoji categories for display
 */
const nativeEmojiCategories = [
  {
    name: 'Smileys',
    icon: '😀',
    emojis: allNativeEmojis.slice(0, 70) // Smileys section
  },
  {
    name: 'Gestures',
    icon: '👋',
    emojis: allNativeEmojis.slice(70, 86) // Gestures
  },
  {
    name: 'Hearts',
    icon: '❤️',
    emojis: allNativeEmojis.slice(86, 101) // Hearts
  },
  {
    name: 'Symbols',
    icon: '✨',
    emojis: allNativeEmojis.slice(101) // Rest (symbols, objects)
  }
];

/**
 * Displayed native emoji categories (filtered if searching, all if not)
 * Only shown when using native pack
 */
const displayedNativeCategories = computed(() => {
  // Don't show native categories if using mutant pack
  if (!isNativePack.value) return [];
  
  const query = searchQuery.value.toLowerCase().trim();
  
  if (!query) {
    // Show all categories when not searching
    return nativeEmojiCategories;
  }
  
  // Filter emojis within each category when searching
  return nativeEmojiCategories
    .map(cat => ({
      ...cat,
      emojis: cat.emojis.filter(emoji => 
        emoji.name.toLowerCase().includes(query) ||
        emoji.content.includes(query)
      )
    }))
    .filter(cat => cat.emojis.length > 0);
});

/**
 * Category icons for mutant emojis
 */
const mutantCategoryIcons: Record<string, string> = {
  'expressions': '😊',
  'food_drink_herbs': '🍕',
  'activities_clothing': '🎮',
  'nature_effects': '🌿',
  'objects': '🔧',
  'symbols': '❤️',
  'travel_places': '✈️',
  'people_animals': '🐱',
  'extra': '✨'
};

/**
 * Displayed mutant emoji categories (filtered if searching, all if not)
 */
const displayedMutantCategories = computed(() => {
  // Only show mutant categories if using mutant pack
  if (isNativePack.value || !mutantLoaded.value) return [];
  
  const query = searchQuery.value.toLowerCase().trim();
  
  // Group emojis by category
  const categoryMap = new Map<string, EmojiPackItem[]>();
  for (const emoji of mutantEmojis.value) {
    const catId = emoji.category;
    if (!categoryMap.has(catId)) {
      categoryMap.set(catId, []);
    }
    categoryMap.get(catId)!.push(emoji);
  }
  
  // Convert to array with category metadata
  const categories = Array.from(categoryMap.entries()).map(([catId, emojis]) => {
    const catInfo = mutantCategories.value.find(c => c.id === catId);
    return {
      id: catId,
      name: catInfo?.name || catId.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      icon: mutantCategoryIcons[catId] || '📦',
      emojis
    };
  });
  
  if (!query) {
    return categories;
  }
  
  // Filter emojis within each category when searching
  return categories
    .map(cat => ({
      ...cat,
      emojis: cat.emojis.filter(emoji => 
        emoji.name.toLowerCase().includes(query) ||
        emoji.keywords?.some(kw => kw.toLowerCase().includes(query))
      )
    }))
    .filter(cat => cat.emojis.length > 0);
});

/**
 * Filters native emojis based on search query (for backwards compatibility)
 */
const filteredNativeEmojis = computed((): NativeEmojiItem[] => {
  const query = searchQuery.value.toLowerCase().trim();
  if (!query) return [];
  
  return allNativeEmojis.filter(emoji => 
    emoji.name.toLowerCase().includes(query) ||
    emoji.content.includes(query)
  ).slice(0, 50); // Limit results
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

/**
 * Load mutant emojis from the pack index
 */
const loadMutantEmojis = async (): Promise<void> => {
  if (mutantLoaded.value || mutantLoading.value || isNativePack.value) return;
  
  mutantLoading.value = true;
  try {
    const response = await fetch('/assets/emojis/mutant_emojis_svg/emoji-index.json');
    if (!response.ok) {
      throw new Error('Failed to load mutant emoji index');
    }
    
    const data = await response.json();
    mutantEmojis.value = data.emojis || [];
    mutantCategories.value = data.categories || [];
    mutantLoaded.value = true;
    debug.log(`📦 Loaded ${mutantEmojis.value.length} mutant emojis`);
  } catch (error) {
    debug.error('Failed to load mutant emojis:', error);
  } finally {
    mutantLoading.value = false;
  }
};

/**
 * Select a mutant emoji
 * Stores as "mutant:path" format so reactions can render the SVG
 */
const selectMutantEmoji = (emoji: EmojiPackItem): void => {
  triggerReaction();
  
  // Create a special ID format that includes the path for rendering
  // Format: mutant:path/to/emoji.svg
  const mutantId = `mutant:${emoji.path}`;
  
  recordEmojiUsage({
    id: emoji.id,
    name: emoji.name,
    native: undefined,
    url: `/assets/emojis/mutant_emojis_svg/${emoji.path}`
  });
  
  // Convert to Emoji type - use mutant: prefix so reactions can identify it
  const emojiObj = {
    id: mutantId,
    name: emoji.name,
    url: `/assets/emojis/mutant_emojis_svg/${emoji.path}`,
    created_at: new Date(),
    uploader: '',
    server_id: 'mutant'
  } as Emoji;
  emit('sendEmoji', emojiObj);
};

const selectEmoji = (emoji: Emoji): void => {
  triggerReaction();
  emit('sendEmoji', emoji);
};

// Select a native emoji (from quick reactions or frequent)
const selectQuickEmoji = (emoji: NativeEmojiItem): void => {
  triggerReaction();
  recordEmojiUsage({
    native: emoji.content,
    name: emoji.name
  });
  
  // Convert to Emoji type - use native char as ID for native emojis
  const emojiObj = {
    id: emoji.content,
    name: emoji.name,
    url: '', // Native emojis don't have URLs
    created_at: new Date(),
    uploader: '',
    server_id: ''
  } as Emoji;
  emit('sendEmoji', emojiObj);
};

// Select from frequently used emojis
const selectNativeEmoji = (emoji: { id: string; native?: string; name: string }): void => {
  triggerReaction();
  recordEmojiUsage({
    id: emoji.id,
    native: emoji.native,
    name: emoji.name
  });
  
  // Convert to Emoji type
  const emojiObj = {
    id: emoji.native || emoji.id,
    name: emoji.name,
    url: emoji.native ? '' : (emoji as any).url || '',
    created_at: new Date(),
    uploader: '',
    server_id: ''
  } as Emoji;
  emit('sendEmoji', emojiObj);
};

// Select from frequently used emojis (handles all types: native, custom, mutant)
const selectFrequentEmoji = (emoji: { id: string; native?: string; name: string; url?: string }): void => {
  triggerReaction();
  
  // Check if it's a mutant emoji (URL contains mutant path)
  if (emoji.url && emoji.url.includes('/mutant_emojis_svg/')) {
    // Extract path from URL for mutant: format
    const pathMatch = emoji.url.match(/\/mutant_emojis_svg\/(.+)$/);
    const mutantPath = pathMatch ? pathMatch[1] : emoji.name;
    
    const emojiObj = {
      id: `mutant:${mutantPath}`,
      name: emoji.name,
      url: emoji.url,
      created_at: new Date(),
      uploader: '',
      server_id: 'mutant'
    } as Emoji;
    emit('sendEmoji', emojiObj);
  } else if (emoji.url) {
    // Custom server emoji with URL
    const emojiObj = {
      id: emoji.id,
      name: emoji.name,
      url: emoji.url,
      created_at: new Date(),
      uploader: '',
      server_id: ''
    } as Emoji;
    emit('sendEmoji', emojiObj);
  } else {
    // Native unicode emoji
    const emojiObj = {
      id: emoji.native || emoji.id,
      name: emoji.name,
      url: '',
      created_at: new Date(),
      uploader: '',
      server_id: ''
    } as Emoji;
    emit('sendEmoji', emojiObj);
  }
  
  // Recording already done when emoji was first used
};

const handleClickOutside = (event: MouseEvent): void => {
  // Close the popup when clicking outside
  if (emojiPopup.value && !emojiPopup.value.contains(event.target as Node)) {
    props.closeEmojiList?.();
  }
};

const handleKeyDown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') {
    props.closeEmojiList?.();
  }
};

// --- Lifecycle Hooks ---

onMounted(() => {
  // Add event listeners with a small delay to prevent immediate closure
  setTimeout(() => {
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
  }, 100);

  nextTick(() => {
    updatePosition();
    searchInput.value?.focus();
  });
  
  // Load mutant emojis if using mutant pack
  if (!isNativePack.value) {
    loadMutantEmojis();
  }
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
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

/**
 * Load mutant emojis when pack changes to mutant
 */
watch(
  () => currentPackId.value,
  (packId) => {
    if (packId === 'mutant' && !mutantLoaded.value) {
      loadMutantEmojis();
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

.server-name,
.section-title {
  font-size: 11px;
  font-weight: 600;
  color: #b9bbbe;
  text-transform: uppercase;
  margin: 12px 0 6px 0;
  letter-spacing: 0.02em;
}

.server-name:first-of-type,
.section-title:first-of-type {
  margin-top: 4px;
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

.emoji-section {
  margin-bottom: 8px;
}

.native-list {
  grid-template-columns: repeat(auto-fill, 36px);
}

.native-emoji-item {
  width: 36px;
  height: 36px;
}

.native-emoji-item span {
  font-size: 24px;
  line-height: 1;
}

/* Mutant emoji styles */
.mutant-list {
  grid-template-columns: repeat(auto-fill, 36px);
}

.mutant-emoji-item {
  width: 36px;
  height: 36px;
}

.mutant-emoji-item img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

/* Frequent emoji list */
.frequent-list {
  grid-template-columns: repeat(auto-fill, 36px);
}

.frequent-emoji-img {
  width: 28px;
  height: 28px;
  object-fit: contain;
}

.emoji-shortcode {
  font-size: 10px;
  color: var(--text-secondary, #b9bbbe);
  word-break: break-all;
}

/* Loading state */
.emoji-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--text-secondary, #b9bbbe);
  font-size: 13px;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: var(--h-primary, #5865f2);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
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