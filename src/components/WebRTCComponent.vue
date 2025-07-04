<template>
  <div class="webrtc-wrapper">
    <!-- Voice Control Dock -->
    <VoiceControlDock 
      :channel-name="channelName"
      @show-voice-overlay="showOverlay = true"
    />

    <!-- Voice Channel Overlay -->
    <VoiceChannelOverlay
      :is-visible="showOverlay"
      :channel-name="channelName"
      @close="showOverlay = false"
      @leave-channel="handleLeaveChannel"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted, onUnmounted } from 'vue';
import { useVoiceChannelStore } from '@/stores/voiceChannel';
import { useServerUsersStore } from '@/stores/useServerUsers';
import VoiceControlDock from './voice/VoiceControlDock.vue';
import VoiceChannelOverlay from './voice/VoiceChannelOverlay.vue';

export default defineComponent({
  name: 'WebRTCComponent',
  components: {
    VoiceControlDock,
    VoiceChannelOverlay
  },
  props: {
    channelId: {
      type: String,
      required: true,
    },
    serverId: {
      type: String,
      required: true,
    },
    channelName: {
      type: String,
      default: 'Voice Channel'
    }
  },
  setup(props) {
    const voiceChannelStore = useVoiceChannelStore();
    const showOverlay = ref(false);

    // Auto-connect when component mounts
    onMounted(async () => {
      if (props.channelId && props.serverId) {
        await voiceChannelStore.joinVoiceChannel(props.channelId, props.serverId);
      }
    });

    // Auto-disconnect when component unmounts
    onUnmounted(async () => {
      await voiceChannelStore.leaveVoiceChannel();
    });

    const handleLeaveChannel = async () => {
      await voiceChannelStore.leaveVoiceChannel();
      showOverlay.value = false;
    };

    return {
      showOverlay,
      handleLeaveChannel
    };
  }
});
</script>

<style scoped>
.webrtc-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
}
</style>