<template>
  <div class="persistent-voice">
    <!-- Voice Control Dock - always visible when in voice -->
    <VoiceControlDock 
      v-if="isConnected"
      :channel-name="currentChannelName"
      @show-voice-overlay="showOverlay = true"
    />

    <!-- Voice Channel Overlay -->
    <VoiceChannelOverlay
      :is-visible="showOverlay"
      :channel-name="currentChannelName"
      @close="showOverlay = false"
      @leave-channel="handleLeaveChannel"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, watch } from 'vue';
import { useVoiceChannelStore } from '@/stores/voiceChannel';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useRouter } from 'vue-router';
import VoiceControlDock from './voice/VoiceControlDock.vue';
import VoiceChannelOverlay from './voice/VoiceChannelOverlay.vue';

export default defineComponent({
  name: 'PersistentVoiceConnection',
  components: {
    VoiceControlDock,
    VoiceChannelOverlay
  },
  setup() {
    const voiceChannelStore = useVoiceChannelStore();
    const serverUsersStore = useServerUsersStore();
    const router = useRouter();
    const showOverlay = ref(false);

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

    // Handle leaving voice channel
    const handleLeaveChannel = async () => {
      await voiceChannelStore.leaveVoiceChannel();
      showOverlay.value = false;
    };

    // Auto-reconnect logic for when user navigates
    watch(() => router.currentRoute.value.path, (newPath) => {
      // Keep voice connection active regardless of navigation
      console.log('Route changed to:', newPath, 'Voice still connected:', isConnected.value);
    });

    return {
      isConnected,
      currentChannelName,
      showOverlay,
      handleLeaveChannel
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