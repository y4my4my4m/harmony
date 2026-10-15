<template>
  <div class="persistent-voice">
    <!-- Unified Voice Dock - handles all modes (dock, minimized, overlay) -->
    <!-- Uses isConnectedOrJoining for optimistic UI - shows dock immediately on click -->
    <UnifiedVoiceDock 
      v-if="isConnectedOrJoining"
    />
    <!-- Voice moderation: own locks and departures in a call, the kick/ban dialog of a voice menu -->
    <VoiceModerationHost v-if="isConnectedOrJoining || hasKickBan" />
    
  </div>
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

.persistent-voice > * {
  pointer-events: auto;
}
</style>