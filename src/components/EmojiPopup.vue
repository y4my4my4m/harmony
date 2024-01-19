<template>
    <div class="emoji-popup" ref="emojiPopup">
      <div v-for="serverEmoji in allEmojis" :key="serverEmoji.serverId">
        <h3>{{ serverEmoji.serverId }}</h3>
        <!-- <input type="text" v-model="searchQuery" placeholder="Search emojis..."> -->
        <div class="emoji-list">
          <div v-for="emoji in serverEmoji.emojis" 
            :key="emoji.id" 
            class="emoji-item" 
            @click="selectEmoji(emoji)"
            @mouseover="hoveredEmoji = emoji.id" 
            @mouseleave="hoveredEmoji = null"
          >
            <img :src="emoji.url" :alt="emoji.name" :title="`:${emoji.name}:`">
          </div>
        </div>
      </div>
    </div>
</template>

<script lang="ts">
  import { defineComponent, ref, onMounted } from 'vue';
  import { useServerChannelStore } from '@/stores/useServerChannel';
  import type { PropType } from 'vue';
  import type { Emoji } from '@/types';
  
  export default defineComponent({
    name: 'EmojiPopup',
    props: {
        closeEmojiList: Function as PropType<() => void>,
        emojiIconClicked: Boolean
    },
    emits: ['sendEmoji'],
    setup(props, { emit }) {
        const serverChannelStore = useServerChannelStore();
        const hoveredEmoji = ref<string | null>(null);
        const emojiPopup = ref<HTMLElement | null>(null);

        const allEmojis = ref<{ serverId: string, emojis: Emoji[] }[]>([]);
        onMounted(async () => {
            // console.log(serverChannelStore.emojiList);
            allEmojis.value = serverChannelStore.emojiList;
        });

        const selectEmoji = (emoji: Emoji) => {
            emit('sendEmoji', emoji);
        };
  
        return {
            allEmojis, 
            selectEmoji, 
            hoveredEmoji,
            emojiPopup
        };
    }
  });
  </script>
  
  <style scoped>
    .emoji-popup {
        position: absolute;
        width: 480px;
        bottom: 90px;
        right: 250px;
        background-color: #2f3136; 
        border-radius: 8px;
        box-shadow: -3px 7px 16px rgba(0,0,0,0.32), 4px 8px 16px rgba(0,0,0,0.22);
        padding: 10px;
        box-sizing: border-box;
        min-height: 300px;
        max-height: 300px;
        overflow-y: auto;
        z-index: 10;
    }

    .emoji-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(48px, 1fr)); /* Emoji size */
        gap: 20px;
        justify-items: center;
    }

    .emoji-item {
        cursor: pointer;
        transition: transform 0.2s ease;
        border-radius:12px;
        padding:4px;
    }

    .emoji-item:hover{
        transform: scale(1.1); /* Slight zoom on hover */
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
    }

    .emoji-item img {
        width: 48px; /* Size of emoji */
        height: 48px;
        border-radius: 4px; /* Optional: for rounded emojis */
    }
</style>
  