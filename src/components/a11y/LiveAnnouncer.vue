<!--
  LiveAnnouncer - the two app-wide live regions behind useAnnouncer(). Mounted once,
  in App.vue. Teleported to <body> and marked data-a11y-persistent so an open modal
  (which makes its siblings inert) does not silence it.
-->
<template>
  <Teleport to="body">
    <div class="sr-only" data-a11y-persistent data-testid="live-announcer">
      <div aria-live="polite" aria-atomic="true" data-testid="live-announcer-polite">{{ politeText }}</div>
      <div aria-live="assertive" aria-atomic="true" data-testid="live-announcer-assertive">{{ assertiveText }}</div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { announcerRegions } from '@/composables/useAnnouncer'

const { politeText, assertiveText } = announcerRegions()
</script>
