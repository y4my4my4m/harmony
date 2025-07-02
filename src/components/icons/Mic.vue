<template>
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4M12,6A6,6 0 0,1 18,12A6,6 0 0,1 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6M12,8A4,4 0 0,0 8,12A4,4 0 0,0 12,16A4,4 0 0,0 16,12A4,4 0 0,0 12,8Z"/>
  </svg>
</template>

<script lang="ts">import { defineComponent} from 'vue';

export default defineComponent({
    name: 'MicIcon',
    props: {
        isMicActive: {
            type: Boolean as PropType<boolean>,
            required: true
        }
    }
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

    .MicIconMuted .MicIconMutedPath {
        fill: #DD0000;
        transition: .2s;
        cursor:pointer;
        opacity: 0.75;
    }
    .MicIconMuted:hover .MicIconMutedPath {
        opacity: 1;
    }
</style>