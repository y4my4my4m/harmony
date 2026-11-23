<!--
  The voice layer: the dock and the voice moderation host, a child of <body>. An open dialog makes
  everything outside it inert (utils/a11y/layers inertOthers), this layer included, and an inert
  element passes presses to whatever lies under it; so while inert the layer paints under the
  dialogs (z-index 1000 and up). The media viewer leaves it interactive (data-over-viewer) under
  the dock, which paints over the viewer.
-->
<template>
  <Teleport to="body">
    <div class="persistent-voice" data-over-viewer>
      <!-- Unified Voice Dock - handles all modes (dock, minimized, overlay) -->
      <!-- Uses isConnectedOrJoining for optimistic UI - shows dock immediately on click -->
      <UnifiedVoiceDock
        v-if="isConnectedOrJoining"
      />
      <!-- Voice moderation: own locks and departures in a call, the kick/ban dialog of a voice menu -->
      <VoiceModerationHost v-if="isConnectedOrJoining || hasKickBan" />
    </div>
  </Teleport>
</template>

<script lang="ts">
import { defineComponent, computed, defineAsyncComponent } from 'vue';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useVoiceModerationStore } from '@/stores/voiceModeration';
// Loaded with the first call: nothing of the dock renders outside one.
const UnifiedVoiceDock = defineAsyncComponent(() => import('./voice/UnifiedVoiceDock.vue'));
const VoiceModerationHost = defineAsyncComponent(() => import('./voice/VoiceModerationHost.vue'));

export default defineComponent({
  name: 'PersistentVoiceConnection',
  components: {
    UnifiedVoiceDock,
    VoiceModerationHost,
  },
  setup() {
    const voiceChannelStore = useUnifiedVoiceChannelStore();
    // Use isConnectedOrJoining for optimistic UI - shows dock immediately when joining
    const isConnectedOrJoining = computed(() => voiceChannelStore.isConnectedOrJoining);
    const moderation = useVoiceModerationStore();
    const hasKickBan = computed(() => !!moderation.kickBan);
    return {
      isConnectedOrJoining,
      hasKickBan,
    };
  }
});
</script>

<style scoped>
.persistent-voice {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  z-index: 9998;
}

.persistent-voice[inert] {
  z-index: 999;
}

.persistent-voice > * {
  pointer-events: auto;
}
</style>