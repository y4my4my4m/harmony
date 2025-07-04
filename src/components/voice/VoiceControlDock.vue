<template>
  <Transition name="dock-slide">
    <div v-if="isInVoiceChannel" class="voice-dock">
      <div class="dock-container">
        <!-- Channel Info -->
        <div class="channel-info" @click="showVoiceOverlay">
          <div class="channel-indicator">
            <div class="indicator-ring" :class="{ active: hasActiveSpeaker }">
              <Icon name="volume" />
            </div>
          </div>
          
          <div class="channel-details">
            <div class="channel-name">{{ channelName }}</div>
            <div class="participant-info">
              <span class="participant-count">{{ connectedUsers.length }}</span>
              <div class="participant-avatars">
                <img 
                  v-for="(userId, index) in displayedParticipants" 
                  :key="userId"
                  :src="getUserAvatar(userId)"
                  :alt="getUserName(userId)"
                  :title="getUserName(userId)"
                  class="participant-avatar"
                  :style="{ 
                    zIndex: displayedParticipants.length - index,
                    '--offset': `${index * 16}px`
                  }"
                  :class="{ speaking: getUserAudioLevel(userId) > 15 }"
                />
                <div 
                  v-if="remainingCount > 0" 
                  class="remaining-count"
                  :style="{ '--offset': `${Math.min(displayedParticipants.length, 4) * 16}px` }"
                >
                  +{{ remainingCount }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Quick Controls -->
        <div class="dock-controls">
          <button 
            @click="toggleMute"
            class="dock-btn"
            :class="{ 
              active: !isMuted,
              danger: isMuted 
            }"
            :title="isMuted ? 'Unmute' : 'Mute'"
          >
            <Icon :name="isMuted ? 'mic-off' : 'mic'" />
          </button>

          <button 
            @click="toggleDeafen"
            class="dock-btn"
            :class="{ 
              active: !isDeafened,
              danger: isDeafened 
            }"
            :title="isDeafened ? 'Undeafen' : 'Deafen'"
          >
            <Icon :name="isDeafened ? 'headphones-off' : 'headphones'" />
          </button>

          <button 
            @click="toggleVideo"
            class="dock-btn"
            :class="{ active: hasVideo }"
            title="Toggle Camera"
          >
            <Icon :name="hasVideo ? 'camera' : 'camera-off'" />
          </button>

          <button 
            @click="toggleScreenShare"
            class="dock-btn"
            :class="{ active: isScreenSharing }"
            title="Share Screen"
          >
            <Icon name="screen-share" />
          </button>

          <div class="dock-separator"></div>

          <button 
            @click="showVoiceOverlay"
            class="dock-btn expand-btn"
            title="Open Voice Channel"
          >
            <Icon name="expand" />
          </button>

          <button 
            @click="leaveChannel"
            class="dock-btn leave-btn"
            title="Leave Voice Channel"
          >
            <Icon name="phone-off" />
          </button>
        </div>

        <!-- Connection Status -->
        <div class="connection-status">
          <div class="status-indicator" :class="connectionQuality">
            <div class="ping-value">{{ ping }}ms</div>
            <div class="connection-dots">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        </div>
      </div>

      <!-- Audio Visualizer -->
      <div class="audio-visualizer" v-if="showVisualizer">
        <div 
          v-for="i in 20" 
          :key="i"
          class="visualizer-bar"
          :style="{ 
            '--delay': `${i * 50}ms`,
            '--height': `${getVisualizerHeight(i)}%`
          }"
        ></div>
      </div>
    </div>
  </Transition>
</template>

<script lang="ts">
import { defineComponent, computed, ref, onMounted, onUnmounted } from 'vue';
import { useVoiceChannelStore } from '@/stores/voiceChannel';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useAuthStore } from '@/stores/auth';
import Icon from '@/components/common/Icon.vue';

export default defineComponent({
  name: 'VoiceControlDock',
  components: { Icon },
  props: {
    channelName: {
      type: String,
      default: 'Voice Channel'
    }
  },
  emits: ['show-voice-overlay'],
  setup(props, { emit }) {
    const voiceChannelStore = useVoiceChannelStore();
    const serverUsersStore = useServerUsersStore();
    const authStore = useAuthStore();

    const showVisualizer = ref(true);
    const ping = ref(42);

    // Computed properties
    const isInVoiceChannel = computed(() => voiceChannelStore.isConnected);
    const connectedUsers = computed(() => voiceChannelStore.connectedUsers);
    const isMuted = computed(() => voiceChannelStore.isMuted);
    const isDeafened = computed(() => voiceChannelStore.isDeafened);
    const hasVideo = computed(() => voiceChannelStore.isVideoEnabled);
    const isScreenSharing = computed(() => voiceChannelStore.isScreenSharing);

    // Active speaker detection
    const hasActiveSpeaker = computed(() => {
      return connectedUsers.value.some(userId => 
        voiceChannelStore.getAudioLevel(userId) > 15
      );
    });

    // Connection quality
    const connectionQuality = computed(() => {
      if (ping.value < 50) return 'excellent';
      if (ping.value < 100) return 'good';
      if (ping.value < 200) return 'fair';
      return 'poor';
    });

    // Displayed participants (max 4 avatars)
    const displayedParticipants = computed(() => {
      return connectedUsers.value.slice(0, 4);
    });

    const remainingCount = computed(() => {
      return Math.max(0, connectedUsers.value.length - 4);
    });

    // Helper methods
    const getCurrentUserId = () => {
      return authStore.session?.user?.id || 'anonymous';
    };

    const getUserAvatar = (userId: string) => {
      const user = serverUsersStore.userProfiles[userId];
      return user?.avatar_url || '/default_avatar.png';
    };

    const getUserName = (userId: string) => {
      const user = serverUsersStore.userProfiles[userId];
      return user?.display_name || user?.username || 'Unknown';
    };

    const getUserAudioLevel = (userId: string) => {
      return voiceChannelStore.getAudioLevel(userId);
    };

    // Audio visualizer
    const getVisualizerHeight = (barIndex: number) => {
      if (!hasActiveSpeaker.value) return 10;
      
      const time = Date.now() / 100;
      const wave = Math.sin(time + barIndex * 0.5) * 0.3;
      const noise = Math.random() * 0.2;
      const baseHeight = 20 + wave * 30 + noise * 20;
      
      return Math.max(10, Math.min(80, baseHeight));
    };

    // Control methods
    const toggleMute = () => voiceChannelStore.toggleMute();
    const toggleDeafen = () => voiceChannelStore.toggleDeafen();
    const toggleVideo = () => voiceChannelStore.toggleVideo();
    const toggleScreenShare = () => voiceChannelStore.toggleScreenShare();

    const showVoiceOverlay = () => {
      emit('show-voice-overlay');
    };

    const leaveChannel = async () => {
      await voiceChannelStore.leaveVoiceChannel();
    };

    // Ping simulation (replace with actual network monitoring)
    const updatePing = () => {
      ping.value = 30 + Math.random() * 40; // Simulate 30-70ms ping
    };

    let pingInterval: number;

    onMounted(() => {
      pingInterval = window.setInterval(updatePing, 2000);
    });

    onUnmounted(() => {
      if (pingInterval) {
        clearInterval(pingInterval);
      }
    });

    return {
      isInVoiceChannel,
      connectedUsers,
      isMuted,
      isDeafened,
      hasVideo,
      isScreenSharing,
      hasActiveSpeaker,
      connectionQuality,
      displayedParticipants,
      remainingCount,
      showVisualizer,
      ping,
      getUserAvatar,
      getUserName,
      getUserAudioLevel,
      getVisualizerHeight,
      toggleMute,
      toggleDeafen,
      toggleVideo,
      toggleScreenShare,
      showVoiceOverlay,
      leaveChannel
    };
  }
});
</script>

<style scoped>
.voice-dock {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  pointer-events: none;
}

.dock-container {
  background: rgba(32, 34, 37, 0.95);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 20px;
  padding: 16px 24px;
  display: flex;
  align-items: center;
  gap: 20px;
  box-shadow: 
    0 8px 32px rgba(0, 0, 0, 0.3),
    0 4px 16px rgba(0, 0, 0, 0.2);
  pointer-events: auto;
  min-width: 400px;
}

/* Channel Info */
.channel-info {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  padding: 8px;
  border-radius: 12px;
  transition: background 0.2s ease;
}

.channel-info:hover {
  background: rgba(255, 255, 255, 0.05);
}

.channel-indicator {
  position: relative;
}

.indicator-ring {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: linear-gradient(135deg, #5865f2, #7289da);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  transition: all 0.3s ease;
  position: relative;
}

.indicator-ring.active {
  background: linear-gradient(135deg, #00d4aa, #00f5d4);
  box-shadow: 0 0 20px rgba(0, 212, 170, 0.3);
}

.indicator-ring.active::before {
  content: '';
  position: absolute;
  top: -3px;
  left: -3px;
  right: -3px;
  bottom: -3px;
  border-radius: 50%;
  background: linear-gradient(135deg, #00d4aa, #00f5d4);
  opacity: 0.3;
  animation: pulse 2s infinite;
}

.channel-details {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.channel-name {
  font-weight: 600;
  color: #ffffff;
  font-size: 14px;
}

.participant-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.participant-count {
  font-size: 12px;
  color: #b9bbbe;
  font-weight: 500;
}

.participant-avatars {
  display: flex;
  position: relative;
}

.participant-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid #2f3349;
  position: relative;
  margin-left: calc(-1 * var(--offset, 0px));
  transition: all 0.3s ease;
}

.participant-avatar.speaking {
  border-color: #00d4aa;
  box-shadow: 0 0 8px rgba(0, 212, 170, 0.4);
  z-index: 10 !important;
}

.remaining-count {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  border: 2px solid #2f3349;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: #dcddde;
  font-weight: 600;
  margin-left: calc(-1 * var(--offset, 0px));
  position: relative;
}

/* Dock Controls */
.dock-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dock-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.1);
  color: #dcddde;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.dock-btn:hover {
  background: rgba(255, 255, 255, 0.15);
  transform: translateY(-1px);
}

.dock-btn.active {
  background: #5865f2;
  color: white;
  box-shadow: 0 4px 12px rgba(88, 101, 242, 0.3);
}

.dock-btn.danger {
  background: #ed4245;
  color: white;
  box-shadow: 0 4px 12px rgba(237, 66, 69, 0.3);
}

.expand-btn {
  background: rgba(255, 255, 255, 0.08);
}

.leave-btn {
  background: rgba(237, 66, 69, 0.2);
  color: #ed4245;
}

.leave-btn:hover {
  background: #ed4245;
  color: white;
}

.dock-separator {
  width: 1px;
  height: 24px;
  background: rgba(255, 255, 255, 0.1);
  margin: 0 4px;
}

/* Connection Status */
.connection-status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ping-value {
  font-size: 11px;
  font-weight: 600;
  color: #b9bbbe;
  min-width: 32px;
  text-align: right;
}

.connection-dots {
  display: flex;
  gap: 2px;
}

.connection-dots span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #40444b;
  transition: all 0.3s ease;
}

.status-indicator.excellent .connection-dots span {
  background: #00d4aa;
}

.status-indicator.excellent .ping-value {
  color: #00d4aa;
}

.status-indicator.good .connection-dots span:nth-child(-n+2) {
  background: #00d4aa;
}

.status-indicator.good .ping-value {
  color: #00d4aa;
}

.status-indicator.fair .connection-dots span:first-child {
  background: #faa61a;
}

.status-indicator.fair .ping-value {
  color: #faa61a;
}

.status-indicator.poor .connection-dots span:first-child {
  background: #ed4245;
}

.status-indicator.poor .ping-value {
  color: #ed4245;
}

/* Audio Visualizer */
.audio-visualizer {
  position: absolute;
  bottom: -8px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 2px;
  align-items: flex-end;
  height: 16px;
  opacity: 0.6;
}

.visualizer-bar {
  width: 2px;
  background: linear-gradient(to top, #5865f2, #00d4aa);
  border-radius: 1px;
  transition: height 0.1s ease;
  animation: visualizerWave 1.5s ease-in-out infinite;
  animation-delay: var(--delay);
  height: var(--height);
  min-height: 2px;
}

/* Animations */
@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 0.3; }
  50% { transform: scale(1.1); opacity: 0.6; }
}

@keyframes visualizerWave {
  0%, 100% { transform: scaleY(1); }
  50% { transform: scaleY(1.5); }
}

/* Transitions */
.dock-slide-enter-active,
.dock-slide-leave-active {
  transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}

.dock-slide-enter-from {
  opacity: 0;
  transform: translateX(-50%) translateY(20px) scale(0.9);
}

.dock-slide-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(20px) scale(0.9);
}

/* Responsive */
@media (max-width: 768px) {
  .dock-container {
    min-width: auto;
    padding: 12px 16px;
    gap: 12px;
  }
  
  .channel-name {
    display: none;
  }
  
  .dock-btn {
    width: 32px;
    height: 32px;
  }
  
  .ping-value {
    display: none;
  }
}

@media (max-width: 480px) {
  .voice-dock {
    bottom: 10px;
    left: 10px;
    right: 10px;
    transform: none;
  }
  
  .dock-container {
    width: 100%;
    justify-content: space-between;
  }
  
  .channel-info {
    flex: 1;
    min-width: 0;
  }
  
  .participant-info {
    display: none;
  }
}
</style>