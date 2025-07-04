<template>
  <div class="voice-control-panel" v-if="isInVoiceChannel">
    <div class="voice-panel-content">
      <!-- User info -->
      <div class="user-info">
        <img 
          :src="currentUserAvatar" 
          :alt="currentUserName"
          class="user-avatar"
          :class="{ speaking: isUserSpeaking }"
        />
        <div class="user-details">
          <span class="user-name">{{ currentUserName }}</span>
          <span class="channel-name">{{ currentChannelName }}</span>
        </div>
      </div>

      <!-- Voice controls -->
      <div class="voice-controls">
        <button
          @click="toggleMute"
          :class="['control-btn', 'mic-btn', { 
            active: !isMuted && !isDeafened,
            muted: isMuted,
            deafened: isDeafened 
          }]"
          :title="isMuted ? 'Unmute' : 'Mute'"
        >
          <Mic v-if="!isMuted && !isDeafened" />
          <MicMuted v-else />
        </button>

        <button
          @click="toggleDeafen"
          :class="['control-btn', 'headphones-btn', { 
            active: !isDeafened,
            deafened: isDeafened 
          }]"
          :title="isDeafened ? 'Undeafen' : 'Deafen'"
        >
          <Headphones v-if="!isDeafened" />
          <span v-else class="deafen-icon">🔇</span>
        </button>

        <button
          @click="toggleSettings"
          class="control-btn settings-btn"
          :class="{ active: showSettings }"
          title="Voice Settings"
        >
          <Cog />
        </button>

        <button
          @click="leaveVoiceChannel"
          class="control-btn leave-btn"
          title="Leave Voice Channel"
        >
          <span class="leave-icon">📞</span>
        </button>
      </div>

      <!-- Audio level indicator -->
      <div class="audio-level-container">
        <div 
          class="audio-level-bar"
          :style="{ width: `${audioLevel}%` }"
          :class="{ active: audioLevel > 5 }"
        ></div>
      </div>

      <!-- Quick settings panel -->
      <div v-if="showSettings" class="settings-panel">
        <div class="settings-section">
          <label class="setting-label">
            <input 
              type="range" 
              v-model="inputVolume" 
              min="0" 
              max="100" 
              @input="updateInputVolume"
            />
            <span>Input Volume: {{ inputVolume }}%</span>
          </label>
        </div>
        
        <div class="settings-section">
          <label class="setting-label">
            <input 
              type="range" 
              v-model="outputVolume" 
              min="0" 
              max="100" 
              @input="updateOutputVolume"
            />
            <span>Output Volume: {{ outputVolume }}%</span>
          </label>
        </div>

        <div class="settings-section">
          <label class="setting-checkbox">
            <input 
              type="checkbox" 
              v-model="echoCancellation"
              @change="updateEchoCancellation"
            />
            <span>Echo Cancellation</span>
          </label>
        </div>

        <div class="settings-section">
          <label class="setting-checkbox">
            <input 
              type="checkbox" 
              v-model="noiseSuppression"
              @change="updateNoiseSuppression"
            />
            <span>Noise Suppression</span>
          </label>
        </div>
      </div>
    </div>

    <!-- Connected users indicator -->
    <div class="connected-users" v-if="connectedUsers.length > 1">
      <span class="user-count">{{ connectedUsers.length - 1 }} other{{ connectedUsers.length > 2 ? 's' : '' }}</span>
      <div class="connected-avatars">
        <img 
          v-for="userId in otherUsers.slice(0, 3)" 
          :key="userId"
          :src="getUserAvatar(userId)"
          :alt="getUserName(userId)"
          :title="getUserName(userId)"
          class="connected-avatar"
          :class="{ speaking: getUserAudioLevel(userId) > 10 }"
        />
        <span v-if="otherUsers.length > 3" class="more-users">
          +{{ otherUsers.length - 3 }}
        </span>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted, onUnmounted } from 'vue';
import { useVoiceChannelStore } from '@/stores/voiceChannel';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useAuthStore } from '@/stores/auth';
import Mic from '@/components/icons/Mic.vue';
import MicMuted from '@/components/icons/MicMuted.vue';
import Headphones from '@/components/icons/Headphones.vue';
import Cog from '@/components/icons/Cog.vue';

export default defineComponent({
  name: 'VoiceControlPanel',
  components: {
    Mic,
    MicMuted,
    Headphones,
    Cog,
  },
  setup() {
    const voiceChannelStore = useVoiceChannelStore();
    const serverUsersStore = useServerUsersStore();
    const authStore = useAuthStore();

    const showSettings = ref(false);
    const inputVolume = ref(75);
    const outputVolume = ref(75);
    const echoCancellation = ref(true);
    const noiseSuppression = ref(true);
    const audioLevel = ref(0);

    // Computed properties
    const isInVoiceChannel = computed(() => voiceChannelStore.isConnected);
    const currentUserName = computed(() => {
      const user = authStore.session?.user;
      return user?.user_metadata?.display_name || user?.user_metadata?.username || user?.email || 'Unknown';
    });
    const currentUserAvatar = computed(() => {
      const user = authStore.session?.user;
      return user?.user_metadata?.avatar_url || '/default_avatar.png';
    });
    const currentChannelName = computed(() => {
      // You'll need to implement this based on your channel data structure
      return 'Voice Channel';
    });
    const isMuted = computed(() => voiceChannelStore.isMuted);
    const isDeafened = computed(() => voiceChannelStore.isDeafened);
    const connectedUsers = computed(() => voiceChannelStore.connectedUsers);
    const otherUsers = computed(() => {
      const currentUserId = authStore.session?.user?.id;
      return connectedUsers.value.filter(userId => userId !== currentUserId);
    });
    const isUserSpeaking = computed(() => audioLevel.value > 10);

    // Methods
    const toggleMute = () => {
      voiceChannelStore.toggleMute();
    };

    const toggleDeafen = () => {
      voiceChannelStore.toggleDeafen();
    };

    const toggleSettings = () => {
      showSettings.value = !showSettings.value;
    };

    const leaveVoiceChannel = async () => {
      await voiceChannelStore.leaveVoiceChannel();
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

    const updateInputVolume = () => {
      // Implement input volume control
      console.log('Input volume:', inputVolume.value);
    };

    const updateOutputVolume = () => {
      // Implement output volume control
      console.log('Output volume:', outputVolume.value);
    };

    const updateEchoCancellation = () => {
      // Implement echo cancellation toggle
      console.log('Echo cancellation:', echoCancellation.value);
    };

    const updateNoiseSuppression = () => {
      // Implement noise suppression toggle
      console.log('Noise suppression:', noiseSuppression.value);
    };

    // Audio level monitoring
    let audioLevelInterval: number | null = null;

    const startAudioLevelMonitoring = () => {
      audioLevelInterval = window.setInterval(() => {
        const currentUserId = authStore.session?.user?.id;
        if (currentUserId) {
          audioLevel.value = voiceChannelStore.getAudioLevel('local') || 0;
        }
      }, 100);
    };

    const stopAudioLevelMonitoring = () => {
      if (audioLevelInterval) {
        clearInterval(audioLevelInterval);
        audioLevelInterval = null;
      }
    };

    onMounted(() => {
      startAudioLevelMonitoring();
    });

    onUnmounted(() => {
      stopAudioLevelMonitoring();
    });

    return {
      showSettings,
      inputVolume,
      outputVolume,
      echoCancellation,
      noiseSuppression,
      audioLevel,
      isInVoiceChannel,
      currentUserName,
      currentUserAvatar,
      currentChannelName,
      isMuted,
      isDeafened,
      connectedUsers,
      otherUsers,
      isUserSpeaking,
      toggleMute,
      toggleDeafen,
      toggleSettings,
      leaveVoiceChannel,
      getUserAvatar,
      getUserName,
      getUserAudioLevel,
      updateInputVolume,
      updateOutputVolume,
      updateEchoCancellation,
      updateNoiseSuppression,
    };
  },
});
</script>

<style scoped>
.voice-control-panel {
  position: fixed;
  bottom: 20px;
  left: 20px;
  background: rgba(32, 34, 37, 0.95);
  backdrop-filter: blur(10px);
  border-radius: 12px;
  padding: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  z-index: 1000;
  min-width: 200px;
  max-width: 350px;
}

.voice-panel-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.user-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 2px solid transparent;
  transition: border-color 0.2s;
}

.user-avatar.speaking {
  border-color: #00ff88;
  box-shadow: 0 0 8px rgba(0, 255, 136, 0.3);
}

.user-details {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.user-name {
  font-weight: 600;
  color: #ffffff;
  font-size: 14px;
}

.channel-name {
  font-size: 12px;
  color: #b9bbbe;
}

.voice-controls {
  display: flex;
  gap: 8px;
  justify-content: center;
}

.control-btn {
  background: rgba(79, 84, 92, 0.8);
  border: none;
  border-radius: 8px;
  width: 36px;
  height: 36px;
  color: #dcddde;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}

.control-btn:hover {
  background: rgba(79, 84, 92, 1);
}

.control-btn.active {
  background: #5865f2;
  color: white;
}

.mic-btn.muted {
  background: #ed4245;
  color: white;
}

.headphones-btn.deafened {
  background: #ed4245;
  color: white;
}

.leave-btn {
  background: #ed4245;
  color: white;
}

.leave-btn:hover {
  background: #c13236;
}

.settings-btn.active {
  background: #5865f2;
}

.audio-level-container {
  height: 4px;
  background: rgba(79, 84, 92, 0.8);
  border-radius: 2px;
  overflow: hidden;
}

.audio-level-bar {
  height: 100%;
  background: #00ff88;
  transition: width 0.1s;
  border-radius: 2px;
}

.audio-level-bar.active {
  box-shadow: 0 0 8px rgba(0, 255, 136, 0.3);
}

.settings-panel {
  background: rgba(54, 57, 63, 0.9);
  border-radius: 8px;
  padding: 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.settings-section {
  margin-bottom: 12px;
}

.settings-section:last-child {
  margin-bottom: 0;
}

.setting-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: #dcddde;
  font-size: 12px;
}

.setting-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #dcddde;
  font-size: 12px;
  cursor: pointer;
}

.setting-label input[type="range"] {
  width: 100%;
  height: 4px;
  background: rgba(79, 84, 92, 0.8);
  border-radius: 2px;
  outline: none;
  -webkit-appearance: none;
}

.setting-label input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  background: #5865f2;
  border-radius: 50%;
  cursor: pointer;
}

.setting-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: #5865f2;
}

.connected-users {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.user-count {
  font-size: 12px;
  color: #b9bbbe;
}

.connected-avatars {
  display: flex;
  gap: 4px;
  align-items: center;
}

.connected-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.2);
  transition: border-color 0.2s;
}

.connected-avatar.speaking {
  border-color: #00ff88;
  box-shadow: 0 0 4px rgba(0, 255, 136, 0.3);
}

.more-users {
  font-size: 10px;
  color: #b9bbbe;
  margin-left: 4px;
}

.deafen-icon, .leave-icon {
  font-size: 14px;
}
</style>