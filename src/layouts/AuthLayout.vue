<template>
  <div class="auth-layout">
    <component
      :is="ownMain ? 'div' : 'main'"
      :id="ownMain ? undefined : MAIN_CONTENT_ID"
      :tabindex="ownMain ? undefined : -1"
      class="auth-content"
    >
      <RouterView />
    </component>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { MAIN_CONTENT_ID } from '@/composables/useRouteA11y'

const route = useRoute()
// Views that render their own <main> (NewProfile) set meta.providesMain.
const ownMain = computed(() => route.matched.some(r => r.meta?.providesMain === true))
</script>

<style scoped>
.auth-layout {
  width: calc(100 * var(--app-vw));
  height: calc(100 * var(--app-vh));
  height: calc(100 * var(--app-dvh)); /* mobile: exclude browser chrome so content isn't clipped */
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--h-background, #1e1f22);
  overflow: hidden;
}

.auth-content {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Ensure auth content takes full space without sidebars */
@media (max-width: 768px) {
  .auth-layout {
    padding: 0;
  }
  
  .auth-content {
    /* padding: 1rem; */
  }
}
</style>
