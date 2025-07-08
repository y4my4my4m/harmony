<template>
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <!-- Keyboard base -->
    <rect x="3" y="8" width="18" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5" fill="none"/>
    
    <!-- Simple key rows -->
    <rect x="5" y="10" width="14" height="1" rx="0.5" fill="currentColor" opacity="0.6"/>
    <rect x="5" y="12" width="14" height="1" rx="0.5" fill="currentColor" opacity="0.6"/>
    
    <!-- Spacebar -->
    <rect x="8" y="14.5" width="8" height="1" rx="0.5" fill="currentColor" opacity="0.6"/>
  </svg>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'KeyboardIcon',
});
</script>