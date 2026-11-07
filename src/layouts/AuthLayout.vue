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
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import { MAIN_CONTENT_ID } from '@/composables/useRouteA11y'

const route = useRoute()
// Views that render their own <main> (NewProfile) set meta.providesMain.
const ownMain = computed(() => route.matched.some(r => r.meta?.providesMain === true))

// The document scrolls here; a page opens at its top, not at the last page's offset.
watch(() => route.path, () => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }), { flush: 'post' })
</script>

<style scoped>
/* min-height, not height: a page taller than the screen grows the document, which scrolls;
   Fire TV's Silk scrolls nothing else with its d-pad pointer. A page within the screen
   stays centred. */
.auth-layout {
  width: 100%;
  min-height: calc(100 * var(--app-vh));
  min-height: calc(100 * var(--app-dvh)); /* mobile: exclude browser chrome so content isn't clipped */
  display: flex;
  flex-direction: column;
  background: var(--h-background, #1e1f22);
  overflow-x: clip;
}

/* One grid area: an auto-height page is centred; a page sized height: 100% fills the
   area, which is the screen or the page's content height, whichever is taller. */
.auth-content {
  flex: 1 0 auto;
  width: 100%;
  min-height: calc(100 * var(--app-vh));
  min-height: calc(100 * var(--app-dvh));
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  place-items: center;
}
</style>
