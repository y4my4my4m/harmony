<template>
  <svg class="icon-component" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M19 11c0 1.19-.34 2.3-.9 3.28l-1.23-1.23c.27-.62.43-1.31.43-2.05h1.7M15 11.16L9 5.18V5a3 3 0 0 1 6 0v6l.01.16M4.27 3L21 19.73 19.73 21l-4.46-4.46C14.77 17.27 13.91 17.58 13 17.72V21h-2v-3.28c-3.28-.49-6-2.31-6-5.72h1.7c0 3 2.54 5.1 5.3 5.1.81 0 1.6-.19 2.31-.58L12 14a3 3 0 0 1-3-3V9.73L3 4.27 4.27 3z"/>
  </svg>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'MicMutedIcon',
});
</script>

<style scoped>
.icon-component {
  color: currentColor;
  transition: color 0.2s;
  cursor: pointer;
}
</style>
