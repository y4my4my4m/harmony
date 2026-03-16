<template>
  <svg class="icon-component" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2a4 4 0 0 0-4 4v5a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4m-7 8a1 1 0 0 1 1 1a6 6 0 0 0 12 0a1 1 0 1 1 2 0a8 8 0 0 1-7 7.938V21a1 1 0 1 1-2 0v-2.062A8 8 0 0 1 4 11a1 1 0 0 1 1-1"/>
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
