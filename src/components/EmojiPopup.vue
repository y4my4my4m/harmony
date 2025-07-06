<template>
  <div class="emoji-popup" ref="emojiPopup">
    <!-- Search input -->
    <div class="emoji-search">
      <input 
        type="text" 
        v-model="searchQuery" 
        placeholder="Search emojis..." 
        class="search-input"
        ref="searchInput"
      >
    </div>
    
    <!-- Filtered emoji results -->
    <div class="emoji-content">
      <div v-if="filteredEmojiList.length === 0" class="no-results">
        <div v-if="searchQuery.trim()" class="no-results-content">
          <div class="no-results-icon">🔍</div>
          <p>No emojis found for "{{ searchQuery }}"</p>
          <small>Try a different search term</small>
        </div>
        <div v-else class="no-results-content">
          <div class="no-results-icon">😔</div>
          <p>No custom emojis available</p>
          <small>Ask your server admin to add some emojis!</small>
        </div>
      </div>
      
      <div v-for="(emojiData, serverId) in filteredEmojiList" :key="serverId">
        <h3 class="server-name">{{ emojiData.server_name }}</h3>
        <div class="emoji-list">
          <div v-for="emoji in emojiData.emojis" 
            :key="emoji.id" 
            class="emoji-item" 
            @click="selectEmoji(emoji)"
            @mouseover="hoveredEmoji = emoji.id" 
            @mouseleave="hoveredEmoji = null"
          >
            <img :src="emoji.url" :alt="emoji.name" :title="`:${emoji.display_name}:`">
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
  import { ref, onMounted, onUnmounted, computed, nextTick, watch } from 'vue';
  import { useServerChannelStore } from '@/stores/useServerChannel';
  import type { Emoji, ResolvedEmoji } from '@/types';
  
  interface Props {
    closeEmojiList?: () => void;
    emojiIconClicked?: boolean;
    isReaction?: boolean;
  }

  const props = withDefaults(defineProps<Props>(), {
    emojiIconClicked: false,
    isReaction: false,
  });

  interface Emits {
    (e: 'sendEmoji', emoji: Emoji): void;
    (e: 'resetEmojiIconClicked'): void;
  }

  const emit = defineEmits<Emits>();

  const serverChannelStore = useServerChannelStore();
  const hoveredEmoji = ref<string | null>(null);
  const emojiPopup = ref<HTMLElement | null>(null);
  const searchInput = ref<HTMLInputElement | null>(null);
  const searchQuery = ref('');
  const resolvedEmojiList = ref<Record<string, { 
    server_name: string; 
    server_icon?: string; 
    emojis: ResolvedEmoji[]; 
  }>>({});

        // Computed property to filter emojis based on search query
        const filteredEmojiList = computed(() => {
          const filtered: any[] = [];

          Object.entries(resolvedEmojiList.value).forEach(([serverId, data]) => {
            // Always filter out servers with no emojis
            if (data.emojis.length === 0) {
              return;
            }

            if (!searchQuery.value.trim()) {
              // No search query - include all servers that have emojis
              filtered.push({
                serverId,
                server_name: data.server_name,
                server_icon: data.server_icon,
                emojis: data.emojis
              });
            } else {
              // Search query present - filter emojis by search term
              const query = searchQuery.value.toLowerCase().trim();
              const matchingEmojis = data.emojis.filter(emoji => 
                emoji.name.toLowerCase().includes(query) ||
                emoji.display_name.toLowerCase().includes(query)
              );

              if (matchingEmojis.length > 0) {
                filtered.push({
                  serverId,
                  server_name: data.server_name,
                  server_icon: data.server_icon,
                  emojis: matchingEmojis
                });
              }
            }
          });

          return filtered;
        });

        // Handle click outside to close
        const handleClickOutside = (event: MouseEvent) => {
          if (emojiPopup.value && !emojiPopup.value.contains(event.target as Node)) {
            if (props.emojiIconClicked) {
              // Notify parent to reset the flag
              emit('resetEmojiIconClicked');
            } else {
              props.closeEmojiList?.();
            }
          }
        };

        // Handle escape key to close
        const handleKeyDown = (event: KeyboardEvent) => {
          if (event.key === 'Escape') {
            props.closeEmojiList?.();
          }
        };

        onMounted(() => {
          resolvedEmojiList.value = serverChannelStore.resolvedEmojiList;
          
          // Add event listeners
          document.addEventListener('click', handleClickOutside);
          document.addEventListener('keydown', handleKeyDown);
          
          // Focus search input
          nextTick(() => {
            if (searchInput.value) {
              searchInput.value.focus();
            }
          });
        });

        onUnmounted(() => {
          document.removeEventListener('click', handleClickOutside);
          document.removeEventListener('keydown', handleKeyDown);
        });

        // Watch for changes in resolved emoji list
        watch(() => serverChannelStore.resolvedEmojiList, (newList) => {
          resolvedEmojiList.value = newList;
        }, { deep: true });

        const selectEmoji = (emoji: Emoji) => {
            emit('sendEmoji', emoji);
        };

        // Clear search when popup opens
        watch(() => props.emojiIconClicked, (newVal) => {
          if (newVal) {
            searchQuery.value = '';
          }
        });
</script>
  
<style scoped>
  .emoji-popup {
    position: fixed;
    width: 320px;
    height: 400px;
    background-color: #2f3136; 
    border-radius: 8px;
    box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
    border: 1px solid #40444b;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    
    /* Position above the emoji button - better aligned */
    bottom: 70px;
    right: 100px;
    transform: translateX(-50%);
  }

  .emoji-search {
    padding: 12px;
    border-bottom: 1px solid #40444b;
    flex-shrink: 0;
  }

  .search-input {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid #40444b;
    border-radius: 4px;
    background-color: #40444b;
    color: #dcddde;
    font-size: 14px;
    outline: none;
    transition: border-color 0.15s ease;
  }

  .search-input:focus {
    border-color: #5865f2;
  }

  .search-input::placeholder {
    color: #72767d;
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

  .server-name:first-child {
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
  }

  .no-results-content {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .no-results-icon {
    font-size: 32px;
    margin-bottom: 8px;
  }

  .no-results p {
    margin: 0 0 4px 0;
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
      right: 20px;
    }
  }
</style>
