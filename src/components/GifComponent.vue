<template>
    <div class="giphy-search" ref="giphy">
      <input type="text" v-model="searchQuery" placeholder="Search GIFs...">
      <div class="giphy-results">
        <masonry-wall :items="gifs" :column-width="150" :gap="10">
            <template #default="{ item }">
                <div :key="item.id" class="gif-item" 
                    @mouseover="hoveredGif = item.id" 
                    @mouseleave="hoveredGif = null"
                    @click="selectGif(item)">
                    <img :src="getImageSource(item)" :alt="item.title">
                </div>
            </template>
        </masonry-wall>
      </div>
    </div>
</template>
<script lang="ts">
  import { defineComponent, ref, watch, onMounted, onUnmounted } from 'vue';
  import type { PropType } from 'vue';
  import type { Gif } from '@/types'

  export default defineComponent({
    name: 'GifComponent',
    props: {
        closeGiphy: Function as PropType<() => void>,
        gifIconClicked: Boolean
    },
    emits: ['sendGif', 'resetGifIconClicked'],
    setup(props, { emit }) {
        const searchQuery = ref('');
        const gifs = ref<Gif[]>([]);
        const hoveredGif = ref<string | null>(null);
        const giphy = ref<HTMLElement | null>(null);

        const getImageSource = (gif: Gif) => {
            return hoveredGif.value === gif.id ? gif.media_formats.gif.url : gif.media_formats.gifpreview.url;
        };

        const fetchTrendingGifs = async () => {
            try {
                const response = await fetch(`https://tenor.googleapis.com/v2/featured?key=${import.meta.env.VITE_TENOR_API_KEY}&limit=18`);
                if (!response.ok) {
                    throw new Error('Network response was not ok');
                }
                const data = await response.json();
                gifs.value = data.results;
            } catch (error) {
                console.error('Fetch error:', error);
            }
        };

        const searchGifs = async () => {
            if (!searchQuery.value.trim()) {
                console.log('empty search');
                await fetchTrendingGifs();
            } else {
                if (!searchQuery.value.trim()) return;
                try {
                    const response = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(searchQuery.value)}&key=${import.meta.env.VITE_TENOR_API_KEY}&limit=18`);
                    if (!response.ok) {
                        throw new Error('Network response was not ok');
                    }
                    const data = await response.json();
                    gifs.value = data.results;
                } catch (error) {
                    console.error('Fetch error:', error);
                }
            }
        };

        const handleClickOutside = (event: MouseEvent) => {
            if (giphy.value && !giphy.value.contains(event.target as Node)) {
                if (props.gifIconClicked) {
                    // Notify parent to reset the flag
                    emit('resetGifIconClicked');
                } else {
                    props.closeGiphy?.();
                }
            }
        };

        onMounted(() => {
            document.addEventListener('click', handleClickOutside);
            fetchTrendingGifs();
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
            selectGif,
            giphy,
        };
    }
    });

</script>
<style scoped>
    .giphy-search {
        position: absolute;
        width: 480px;
        bottom: 90px;
        right: 250px;
        background-color: #2f3136;
        border-radius: 8px;
        box-shadow: -3px 7px 16px rgba(0,0,0,0.32), 4px 8px 16px rgba(0,0,0,0.22);
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
        display: block;
        height: 450px;
        max-height: 450px;
        overflow-y: auto;
        overflow-x: hidden;
        padding-right: 10px;
    }

    .gif-item {
        cursor: pointer;
        border-radius: 4px;
        transition: .2s;
        transform: scale(1);
        width: 100%;
        height: auto;
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
    @media (max-width: 768px) {

        .giphy-search {
            width: 90%;
            right: 20px;
        }
    }
</style>

  