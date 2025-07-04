<template>
  <div class="discord-webrtc-wrapper">
    <!-- Join Voice Channel Button (when not connected) -->
    <div v-if="!voiceStore.isConnected" class="join-voice-container">
      <button 
        @click="joinVoiceChannel"
        class="join-voice-btn"
        :disabled="isJoining"
      >
        <Icon name="volume" />
        {{ isJoining ? 'Connecting...' : 'Join Voice Channel' }}
      </button>
    </div>

    <!-- Voice Channel Overlay -->
    <DiscordVoiceOverlay
      v-if="voiceStore.isConnected"
      :channel-name="channelName"
      @close="handleChannelClosed"
      @minimize="handleOverlayMinimized"
    />

    <!-- Minimized Voice Panel (when connected but overlay hidden) -->
    <div 
      v-if="voiceStore.isConnected && !voiceStore.isOverlayVisible" 
      class="minimized-voice-panel"
      @click="voiceStore.toggleOverlay"
    >
      <div class="panel-content">
        <div class="channel-info">
          <Icon name="volume" />
          <span class="channel-name">{{ channelName }}</span>
          <span class="participant-count">{{ voiceStore.connectionStats.total }}</span>
        </div>
        
        <div class="quick-controls">
          <button 
            @click.stop="voiceStore.toggleMute"
            class="quick-control-btn"
            :class="{ muted: voiceStore.localState.isMuted }"
            :title="voiceStore.localState.isMuted ? 'Unmute' : 'Mute'"
          >
            <Icon :name="voiceStore.localState.isMuted ? 'mic-off' : 'mic'" />
          </button>
          
          <button 
            @click.stop="voiceStore.toggleDeafen"
            class="quick-control-btn"
            :class="{ deafened: voiceStore.localState.isDeafened }"
            :title="voiceStore.localState.isDeafened ? 'Undeafen' : 'Deafen'"
          >
            <Icon :name="voiceStore.localState.isDeafened ? 'headphones-off' : 'headphones'" />
          </button>
          
          <button 
            @click.stop="leaveChannel"
            class="quick-control-btn leave"
            title="Leave channel"
          >
            <Icon name="phone-off" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue';
import { useDiscordVoiceChannelStore } from '@/stores/discordVoiceChannel';
import DiscordVoiceOverlay from '@/components/voice/DiscordVoiceOverlay.vue';
import Icon from '@/components/common/Icon.vue';

export default defineComponent({
  name: 'DiscordWebRTCComponent',
  components: {
    DiscordVoiceOverlay,
    Icon
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
    }
  },
  
  setup(props) {
    const voiceStore = useDiscordVoiceChannelStore();
    const isJoining = ref(false);
    
    // =============================================================================
    // METHODS
    // =============================================================================
    
    const joinVoiceChannel = async () => {
      if (isJoining.value) return;
      
      isJoining.value = true;
      try {
        const success = await voiceStore.joinVoiceChannel(props.channelId, props.serverId);
        if (!success) {
          console.error('Failed to join voice channel');
          // Could show error notification here
        }
      } catch (error) {
        console.error('Error joining voice channel:', error);
      } finally {
        isJoining.value = false;
      }
    };
    
    const leaveChannel = async () => {
      await voiceStore.leaveVoiceChannel();
    };
    
    const handleChannelClosed = () => {
      // Channel was left through the overlay
      console.log('Voice channel closed');
    };
    
    const handleOverlayMinimized = () => {
      // Overlay was minimized
      console.log('Voice overlay minimized');
    };
    
    return {
      voiceStore,
      isJoining,
      joinVoiceChannel,
      leaveChannel,
      handleChannelClosed,
      handleOverlayMinimized
    };
  }
});
</script>

<style scoped>
.discord-webrtc-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
}

/* Join Button */
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
  padding: 14px 28px;
  color: white;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  display: flex;
  align-items: center;
  gap: 10px;
  box-shadow: 
    0 6px 20px rgba(88, 101, 242, 0.4),
    0 2px 8px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(10px);
}

.join-voice-btn:hover:not(:disabled) {
  background: linear-gradient(145deg, #4752c4, #3c4693);
  transform: translateY(-2px);
  box-shadow: 
    0 8px 30px rgba(88, 101, 242, 0.5),
    0 4px 12px rgba(0, 0, 0, 0.4);
}

.join-voice-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
  transform: none;
}

.join-voice-btn:active:not(:disabled) {
  transform: translateY(0);
}

/* Minimized Panel */
.minimized-voice-panel {
  position: fixed;
  bottom: 20px;
  left: 20px;
  background: linear-gradient(145deg, #2f3136, #36393f);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 12px 16px;
  cursor: pointer;
  transition: all 0.3s ease;
  z-index: 1000;
  min-width: 280px;
  box-shadow: 
    0 6px 20px rgba(0, 0, 0, 0.4),
    0 2px 8px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(10px);
}

.minimized-voice-panel:hover {
  background: linear-gradient(145deg, #36393f, #40444b);
  transform: translateY(-1px);
  box-shadow: 
    0 8px 25px rgba(0, 0, 0, 0.5),
    0 3px 10px rgba(0, 0, 0, 0.4);
}

.panel-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.channel-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.channel-info .icon {
  color: #5865f2;
  font-size: 16px;
}

.channel-name {
  color: #ffffff;
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.participant-count {
  background: rgba(88, 101, 242, 0.2);
  color: #5865f2;
  padding: 2px 6px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 600;
  min-width: 20px;
  text-align: center;
}

.quick-controls {
  display: flex;
  gap: 6px;
}

.quick-control-btn {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(0, 0, 0, 0.3);
  color: #b9bbbe;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}

.quick-control-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.3);
}

.quick-control-btn.muted {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: white;
  border-color: rgba(237, 66, 69, 0.6);
}

.quick-control-btn.deafened {
  background: linear-gradient(145deg, #faa61a, #e67e22);
  color: white;
  border-color: rgba(250, 166, 26, 0.6);
}

.quick-control-btn.leave {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: white;
  border-color: rgba(237, 66, 69, 0.6);
}

.quick-control-btn.leave:hover {
  background: linear-gradient(145deg, #c73e1d, #a0281a);
}

/* Responsive */
@media (max-width: 768px) {
  .join-voice-container,
  .minimized-voice-panel {
    bottom: 10px;
    left: 10px;
    right: 10px;
  }
  
  .join-voice-btn {
    width: 100%;
    justify-content: center;
  }
  
  .minimized-voice-panel {
    min-width: auto;
  }
}
</style>