<template>
    <div class="giphy-search" ref="giphy">
      <input type="text" v-model="searchQuery" placeholder="Search GIFs...">
      <div class="giphy-results">
        <div v-for="gif in gifs" :key="gif.id" class="gif-item" 
            @mouseover="hoveredGif = gif.id" 
            @mouseleave="hoveredGif = null"
            @click="selectGif(gif)">
            <img :src="getImageSource(gif)" :alt="gif.title">
        </div>
      </div>
    </div>
</template>
<script lang="ts">
  import { defineComponent, ref, watch, onMounted, onUnmounted } from 'vue';
  import type { Ref } from 'vue';
  import type { Gif } from '@/types'

  export default defineComponent({
    name: 'GifComponent',
    props: {
        openGiphy: Function,
        closeGiphy: Function
    },
    emits: ['sendGif'],
    setup(props, { emit }) {
        const searchQuery = ref('');
        const gifs = ref<Gif[]>([]);
        const hoveredGif = ref<string | null>(null);
        const giphy: Ref<HTMLElement | null> = ref(null);

        const getImageSource = (gif: Gif) => {
            return hoveredGif.value === gif.id ? gif.media_formats.gif.url : gif.media_formats.gifpreview.url;
        };
        // Function to perform search
        const searchGifs = async () => {
            if (!searchQuery.value.trim()) return;
            try {
                const response = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(searchQuery.value)}&key=${import.meta.env.VITE_TENOR_API_KEY}&limit=25`);
                if (!response.ok) {
                throw new Error('Network response was not ok');
                }
                const data = await response.json();
                gifs.value = data.results;
            } catch (error) {
                console.error('Fetch error:', error);
            }
        };
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node;

            if (giphy.value && !giphy.value.contains(target)) {
                if (props.closeGiphy) {
                    props.closeGiphy();
                }
            }
        };

        onMounted(() => {
            document.addEventListener('click', handleClickOutside);
        });

        onUnmounted(() => {
            document.removeEventListener('click', handleClickOutside);
        });
        // Watcher on searchQuery
        watch(searchQuery, () => {
            searchGifs();
        });

        const selectGif = (gif: Gif) => {
            emit('sendGif', gif);
        };

        return { 
            searchQuery, 
            gifs, 
            hoveredGif,
            getImageSource,
            searchGifs, 
            selectGif 
        };
    }
    });

</script>
<style scoped>
    .giphy-search {
        position: absolute;
        width: 420px;
        bottom:120px;
        right:15%;
        background-color: #2f3136;
        border-radius: 8px;
        box-shadow: 0 8px 16px rgba(0,0,0,0.2);
        padding: 10px;
        box-sizing: border-box;
    }

    .giphy-search input[type="text"] {
        width: 100%;
        padding: 8px 12px;
        border-radius: 8px;
        border: 1px solid #52575e;
        background-color: var(--h-chat-dark);
        color: #cccccc;
        font-size: 16px;
        margin-top: 10px;
        margin-bottom: 10px;
        box-sizing: border-box;
        outline:none;
    }

    .giphy-search input[type="text"]::placeholder {
        color: #72767d;
    }

    .giphy-results {
        display: flex;
        flex-wrap: wrap; /* Allows items to wrap to the next line */
        gap: 10px; /* Space between items */
        padding: 10px;
        max-height: 450px;
        overflow-y: auto; /* Scroll vertically if content overflows */
    }

    .gif-item {
        flex-basis: calc(50% - 10px); /* Each item takes up half the container width minus half the gap */
        cursor: pointer;
        border-radius: 4px;
        transition: .2s;
        transform: scale(1);
    }

    .gif-item:hover {
        transform: scale(1.14);
    }
    .gif-item:hover img {
        box-shadow: 0 8px 16px rgba(0,0,0,0.2);
    }
    .gif-item img {
        width: 100%;
        height: auto;
        border-radius: 4px;
        object-fit: cover;
    }
</style>

  