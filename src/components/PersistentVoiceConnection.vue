<template>
  <div class="persistent-voice">
    <!-- Unified Voice Dock - handles all modes (dock, minimized, overlay) -->
    <UnifiedVoiceDock 
      v-if="isConnected"
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
    const isConnected = computed(() => voiceChannelStore.isConnected);
    return {
      isConnected,
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