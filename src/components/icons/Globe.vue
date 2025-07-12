<template>
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
    <!-- Outer globe circle -->
    <circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.5" fill="none"/>
    
    <!-- Vertical meridian line -->
    <ellipse cx="10" cy="10" rx="0" ry="8" stroke="currentColor" stroke-width="1" fill="none"/>
    <ellipse cx="10" cy="10" rx="3" ry="8" stroke="currentColor" stroke-width="1" fill="none"/>
    
    <!-- Horizontal latitude lines -->
    <ellipse cx="10" cy="10" rx="8" ry="0" stroke="currentColor" stroke-width="1" fill="none"/>
    <ellipse cx="10" cy="10" rx="8" ry="2.7" stroke="currentColor" stroke-width="1" fill="none"/>
  </svg>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
    name: 'GlobeIcon',
});
</script>