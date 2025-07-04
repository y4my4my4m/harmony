<template>
  <div class="webrtc-wrapper">
    <!-- Join Voice Channel Button (when not connected) -->
    <div v-if="!isConnected" class="join-voice-container">
      <button 
        @click="joinVoiceChannel"
        class="join-voice-btn"
        :disabled="isJoining"
      >
        <Icon name="volume" />
        {{ isJoining ? 'Connecting...' : 'Join Voice Channel' }}
      </button>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed } from 'vue';
import { useVoiceChannelStore } from '@/stores/voiceChannel';
import Icon from '@/components/common/Icon.vue';

export default defineComponent({
  name: 'WebRTCComponent',
  components: {
    Icon
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
    const isJoining = ref(false);

    // Computed properties
    const isConnected = computed(() => voiceChannelStore.isConnected);

    // Join voice channel manually
    const joinVoiceChannel = async () => {
      if (isJoining.value) return;
      
      isJoining.value = true;
      try {
        await voiceChannelStore.joinVoiceChannel(props.channelId, props.serverId);
      } catch (error) {
        console.error('Failed to join voice channel:', error);
      } finally {
        isJoining.value = false;
      }
    };

    return {
      isConnected,
      isJoining,
      joinVoiceChannel
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

.join-voice-container {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 1000;
}

.join-voice-btn {
  background: linear-gradient(145deg, #5865f2, #4752c4);
  border: none;
  border-radius: 50px;
  padding: 12px 24px;
  color: white;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  gap: 8px;
  box-shadow: 
    0 4px 12px rgba(88, 101, 242, 0.3),
    0 2px 4px rgba(0, 0, 0, 0.2);
}

.join-voice-btn:hover:not(:disabled) {
  background: linear-gradient(145deg, #4752c4, #3c4693);
  transform: translateY(-2px);
  box-shadow: 
    0 6px 20px rgba(88, 101, 242, 0.4),
    0 4px 8px rgba(0, 0, 0, 0.3);
}

.join-voice-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
  transform: none;
}

.join-voice-btn:active:not(:disabled) {
  transform: translateY(0);
}
</style>