<template>
    <svg class="MicIcon" aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24">
        <path class="MicIconPath" d="M12 2a4 4 0 0 0-4 4v4a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4Z"></path>
        <path class="MicIconPath" d="M6 10a1 1 0 0 0-2 0 8 8 0 0 0 7 7.94V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.06A8 8 0 0 0 20 10a1 1 0 1 0-2 0 6 6 0 0 1-12 0Z"></path>
    </svg>
</template>

<script lang="ts">import { defineComponent} from 'vue';

export default defineComponent({
    name: 'MicIcon',
});
</script>

<style scoped>
    .MicIcon .MicIconPath {
        fill: #aaa;
        transition: .2s;
        cursor:pointer;
    }
    .MicIcon:hover .MicIconPath {
        fill: #fff;
    }
</style>