<template>
    <div class="giphy-search">
      <input type="text" v-model="searchQuery" @keyup.enter="searchGifs" placeholder="Search GIFs...">
      <button @click="searchGifs">Search</button>
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
  import { defineComponent, ref, watch } from 'vue';
  import type { Gif } from '@/types'

  export default defineComponent({
    name: 'GifComponent',
    emits: ['sendGif'],
    setup(_, { emit }) {
        const searchQuery = ref('');
        const gifs = ref<Gif[]>([]);
        const hoveredGif = ref<string | null>(null);

        const getImageSource = (gif: Gif) => {
            return hoveredGif.value === gif.id ? gif.media_formats.gif.url : gif.media_formats.gifpreview.url;
        };
        // Function to perform search
        const searchGifs = async () => {
        if (!searchQuery.value.trim()) return;
        try {
            const response = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(searchQuery.value)}&key=${import.meta.env.VITE_TENOR_API_KEY}&limit=10`);
            if (!response.ok) {
            throw new Error('Network response was not ok');
            }
            const data = await response.json();
            gifs.value = data.results;
        } catch (error) {
            console.error('Fetch error:', error);
        }
        };

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
        width: 100%;
        top:300px;
        left:200px;
    }

    .giphy-results {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
        gap: 10px;
        padding: 10px;
        max-height: 300px;
        overflow-y: auto;
        width:100%;
        background-color: #2f3136;
        border-radius: 8px;
        box-shadow: 0 8px 16px rgba(0,0,0,0.2);
    }

    .gif-item {
        cursor: pointer;
        border-radius: 4px;
        width:100%;
    }

    .gif-item img {
        width: 100%;
        height: 150px;
        border-radius: 4px;
        object-fit: cover;
    }
</style>

  