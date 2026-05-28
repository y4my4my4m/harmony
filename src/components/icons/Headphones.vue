<template>
  <svg v-if="isHeadphonesActive" class="icon-component" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h4v-8H5v-1c0-3.87 3.13-7 7-7s7 3.13 7 7v1h-4v8h4c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z"/>
  </svg>
  <svg v-else class="icon-component icon-deafened" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <!-- Same filled headphones as active, with diagonal slash -->
    <path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h4v-8H5v-1c0-3.87 3.13-7 7-7s7 3.13 7 7v1h-4v8h4c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z"/>
    <line x1="1" y1="1" x2="23" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>
  </svg>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';

export default defineComponent({
  name: 'HeadphonesIcon',
  props: {
    isHeadphonesActive: {
      type: Boolean as PropType<boolean>,
      required: true
    }
  }
});
</script>

<style scoped>
.icon-component {
  color: currentColor;
  transition: color 0.2s;
  cursor: pointer;
}
.icon-deafened {
  opacity: 0.9;
}
.icon-deafened:hover {
  opacity: 1;
}
</style>
