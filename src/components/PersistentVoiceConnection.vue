<template>
  <div class="persistent-voice">
    <!-- Unified Voice Dock - handles all modes (dock, minimized, overlay) -->
    <!-- Uses isConnectedOrJoining for optimistic UI - shows dock immediately on click -->
    <UnifiedVoiceDock 
      v-if="isConnectedOrJoining"
    />
    
  </div>
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import UnifiedVoiceDock from './voice/UnifiedVoiceDock.vue';

export default defineComponent({
  name: 'PersistentVoiceConnection',
  components: {
    UnifiedVoiceDock
  },
  setup() {
    const voiceChannelStore = useUnifiedVoiceChannelStore();
    // Use isConnectedOrJoining for optimistic UI - shows dock immediately when joining
    const isConnectedOrJoining = computed(() => voiceChannelStore.isConnectedOrJoining);
    return {
      isConnectedOrJoining,
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