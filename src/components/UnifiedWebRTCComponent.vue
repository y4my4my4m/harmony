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
    autoJoin: {
      type: Boolean,
      default: false
    }
  },
  
  setup(props) {
    const voiceStore = useUnifiedVoiceChannelStore();
    
    // =============================================================================
    // AUTO-JOIN FUNCTIONALITY
    // =============================================================================
    
    const joinVoiceChannel = async () => {
      try {
        const success = await voiceStore.joinVoiceChannel(props.channelId, props.serverId);
        if (!success) {
          console.error('Failed to join voice channel');
        } else {
          // Clear the auto-join flag after successful join
          sessionStorage.removeItem('autoJoinVoiceChannel');
        }
      } catch (error) {
        console.error('Error joining voice channel:', error);
      }
    };
    
    // =============================================================================
    // WATCHERS & LIFECYCLE
    // =============================================================================
    
    // Check for auto-join on mount (triggered by microphone click)
    onMounted(() => {
      const shouldAutoJoin = sessionStorage.getItem('autoJoinVoiceChannel') === 'true';
      if (shouldAutoJoin && !voiceStore.isConnected) {
        console.log('🎯 Auto-joining voice channel via microphone click');
        joinVoiceChannel();
      }
    });
    
    // Auto-join when autoJoin prop is true (fallback)
    watch(() => props.autoJoin, (shouldAutoJoin) => {
      if (shouldAutoJoin && !voiceStore.isConnected) {
        console.log('🎯 Auto-joining voice channel via prop');
        joinVoiceChannel();
      }
    }, { immediate: true });
    
    // Auto-leave when component unmounts or channel changes
    onUnmounted(() => {
      if (voiceStore.isConnected && voiceStore.currentChannelId === props.channelId) {
        voiceStore.leaveVoiceChannel();
      }
    });
    
    // Handle channel changes
    watch(() => props.channelId, (newChannelId, oldChannelId) => {
      if (oldChannelId && newChannelId !== oldChannelId && voiceStore.isConnected) {
        // Channel changed while connected - leave old and potentially join new
        voiceStore.leaveVoiceChannel();
      }
    });
    
    return {
      voiceStore,
      joinVoiceChannel
    };
  }
});
</script>

<style scoped>
.unified-webrtc-wrapper {
  /* Container for the WebRTC system - dock positioning is handled internally */
  position: relative;
  width: 100%;
  height: 100%;
}
</style>