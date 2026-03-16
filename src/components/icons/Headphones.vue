<template>
  <Headphones v-if="isHeadphonesActive" class="icon-component" :size="20" :stroke-width="2" />
  <svg v-else class="icon-component icon-deafened" aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="1" y1="1" x2="23" y2="23"></line>
    <path d="M3 18v-6a9 9 0 0 1 18 0v6"></path>
    <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zm-14 0a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"></path>
  </svg>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { Headphones } from 'lucide-vue-next';

export default defineComponent({
  name: 'HeadphonesIcon',
  components: { Headphones },
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
  color: var(--icon-primary, #9999a0);
  transition: color 0.2s;
  cursor: pointer;
}
.icon-component:hover {
  color: var(--text-primary, #f2f3f5);
}
.icon-deafened {
  color: var(--text-primary, #f2f3f5);
  opacity: 0.75;
}
.icon-deafened:hover {
  opacity: 1;
}
</style>
