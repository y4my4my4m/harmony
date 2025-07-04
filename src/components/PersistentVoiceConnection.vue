<template>
  <div class="persistent-voice">
    <!-- Unified Voice Dock - handles all modes (dock, minimized, overlay) -->
    <UnifiedVoiceDock 
      v-if="isConnected"
      :channel-name="currentChannelName"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, watch } from 'vue';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useRouter } from 'vue-router';
import UnifiedVoiceDock from './voice/UnifiedVoiceDock.vue';

export default defineComponent({
  name: 'PersistentVoiceConnection',
  components: {
    UnifiedVoiceDock
  },
  setup() {
    const voiceChannelStore = useUnifiedVoiceChannelStore();
    const serverUsersStore = useServerUsersStore();
    const router = useRouter();

    // Computed properties
    const isConnected = computed(() => voiceChannelStore.isConnected);
    const currentChannelName = computed(() => {
      if (!voiceChannelStore.currentChannelId || !voiceChannelStore.currentServerId) {
        return 'Voice Channel';
      }
      
      // Try to get channel name from server data
      const serverId = voiceChannelStore.currentServerId;
      const channelId = voiceChannelStore.currentChannelId;
      
      // You might need to implement getChannelName in serverUsersStore
      return `Voice Channel`; // Fallback
    });

    // Auto-reconnect logic for when user navigates
    watch(() => router.currentRoute.value.path, (newPath) => {
      // Keep voice connection active regardless of navigation
      console.log('Route changed to:', newPath, 'Voice still connected:', isConnected.value);
    });

    return {
      isConnected,
      currentChannelName
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