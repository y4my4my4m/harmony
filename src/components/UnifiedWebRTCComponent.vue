<template>
  <div class="unified-webrtc-wrapper">
    <!-- Unified Voice Dock - Shows when connected -->
    <UnifiedVoiceDock
      v-if="voiceStore.isConnected"
      :channel-name="channelName"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, onMounted, onUnmounted, watch } from 'vue';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import UnifiedVoiceDock from '@/components/voice/UnifiedVoiceDock.vue';

export default defineComponent({
  name: 'UnifiedWebRTCComponent',
  components: {
    UnifiedVoiceDock
  },
  
  props: {
    channelId: {
      type: String,
      required: true
    },
    serverId: {
      type: String,
      required: true
    },
    channelName: {
      type: String,
      default: 'Voice Channel'
    },
  },
  
  setup(props) {
    const voiceStore = useUnifiedVoiceChannelStore();
    
    // =============================================================================
    // LIFECYCLE
    // =============================================================================
    
    // Note: DO NOT auto-leave when component unmounts or channel changes
    // Users should stay connected to voice channels until they explicitly leave
    // The voice dock should remain visible and functional across channel/server navigation
    
    onUnmounted(() => {
      // Component unmounting should not disconnect voice - user stays connected
      // Only disconnect if the entire page is closing (handled by beforeunload in WebRTC service)
      console.log('🔄 UnifiedWebRTCComponent unmounted, keeping voice connection alive');
    });
    
    // Handle channel changes - stay connected to voice channel
    watch(() => props.channelId, (newChannelId, oldChannelId) => {
      if (oldChannelId && newChannelId !== oldChannelId && voiceStore.isConnected) {
        // Channel changed while connected - keep voice connection but log the change
        console.log('🔄 Channel changed while in voice call, staying connected to voice channel');
      }
    });
    
    return {
      voiceStore
    };
  }
});
</script>
