<template>
    <div class="giphy-search" ref="giphy">
      <input type="text" v-model="searchQuery" placeholder="Search GIFs..." class="search-input">
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

<script setup lang="ts">
  import { ref, watch, onMounted, onUnmounted } from 'vue';
  import type { Gif } from '@/types'

  interface Props {
    closeGiphy?: () => void;
    gifIconClicked?: boolean;
  }

  const props = withDefaults(defineProps<Props>(), {
    gifIconClicked: false,
  });

  interface Emits {
    (e: 'sendGif', gif: Gif): void;
    (e: 'resetGifIconClicked'): void;
  }

  const emit = defineEmits<Emits>();

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

        // Handle escape key to close
        const handleKeyDown = (event: KeyboardEvent) => {
          if (event.key === 'Escape') {
            props.closeGiphy?.();
          }
        };

        onMounted(() => {
            document.addEventListener('click', handleClickOutside);
            document.addEventListener('keydown', handleKeyDown);
            fetchTrendingGifs();
        });

        onUnmounted(() => {
            document.removeEventListener('click', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
        });
        
        // Watcher on searchQuery with debounce for better performance
        watch(searchQuery, () => {
            searchGifs();
        });

        const selectGif = (gif: Gif) => {
            emit('sendGif', gif);
        };
</script>
<style scoped>
    .giphy-search {
        position: fixed;
        width: 480px;
        background-color: #2f3136;
        border-radius: 8px;
        box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
        border: 1px solid #40444b;
        z-index: 1000;
        
        /* Position above the GIF button - more to the left to center above GIF icon */
        bottom: 70px;
        right: 60px;
        transform: translateX(-50%);
    }

    .search-input {
        width: calc(100% - 20px);
        padding: 8px 12px;
        border-radius: 8px;
        border: 1px solid #52575e;
        background-color: #40444b;
        color: #dcddde;
        font-size: 16px;
        outline: none;
        transition: border-color 0.15s ease;
        box-sizing: border-box;
        margin: 10px;
    }

    .search-input:focus {
        border: 1px solid #5865f2;
    }

    .search-input::placeholder {
        color: #72767d;
    }

    .giphy-results {
        height: 450px;
        max-height: 450px;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 0 10px 10px 10px;
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
        transform: scale(1.05);
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

    /* Scrollbar styling */
    .giphy-results::-webkit-scrollbar {
        width: 8px;
    }

    .giphy-results::-webkit-scrollbar-track {
        background: transparent;
    }

    .giphy-results::-webkit-scrollbar-thumb {
        background: #40444b;
        border-radius: 4px;
    }

    .giphy-results::-webkit-scrollbar-thumb:hover {
        background: #4f545c;
    }
    
    @media (max-width: 768px) {
        .giphy-search {
            width: 90%;
            right: 20px;
            transform: translateX(0%);
        }
    }
</style>

