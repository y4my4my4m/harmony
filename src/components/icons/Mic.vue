<template>
  <svg class="icon-component" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <!-- Filled mic – capsule head, stem, stand base -->
    <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3zm0 14c1.66 0 3-1.34 3-3v-1H9v1c0 1.66 1.34 3 3 3zm5-3h-2c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92z"/>
  </svg>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'MicIcon',
  props: { size: { type: [Number, String], default: 22 } }
});
</script>

<style scoped>
.icon-component {
  color: currentColor;
  transition: color 0.2s;
  cursor: pointer;
}
</style>
