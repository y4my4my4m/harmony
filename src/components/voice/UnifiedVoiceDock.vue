<template>
  <!-- Unified Voice Dock - Combines best of both old and new systems -->
  <div v-if="voiceStore.isConnected" class="unified-voice-dock" :class="dockMode">
    <!-- Dock Mode (default) -->
    <div v-if="currentMode === 'dock'" class="dock-container">
      <!-- User Info -->
      <div class="user-section">
        <div class="user-avatar-container">
          <img 
            :src="currentUserProfile.avatar_url || '/default_avatar.png'"
            :alt="currentUserProfile.display_name || 'User'"
            class="user-avatar"
            :class="{ speaking: isCurrentUserSpeaking }"
          />
          <div v-if="isCurrentUserSpeaking" class="speaking-ring"></div>
        </div>
        <div class="user-details">
          <span class="user-name">{{ currentUserProfile.display_name || currentUserProfile.username }}</span>
          <span class="channel-name">{{ channelName }}</span>
        </div>
      </div>

      <!-- Voice Controls -->
      <div class="voice-controls">
        <button
          @click="voiceStore.toggleMute"
          :class="['control-btn', 'mic-btn', { 
            active: !voiceStore.localState.isMuted && !voiceStore.localState.isDeafened,
            muted: voiceStore.localState.isMuted,
            deafened: voiceStore.localState.isDeafened 
          }]"
          :title="voiceStore.localState.isMuted ? 'Unmute' : 'Mute'"
        >
          <Icon :name="voiceStore.localState.isMuted || voiceStore.localState.isDeafened ? 'mic-off' : 'mic'" />
        </button>

        <button
          @click="voiceStore.toggleDeafen"
          :class="['control-btn', 'headphones-btn', { 
            active: !voiceStore.localState.isDeafened,
            deafened: voiceStore.localState.isDeafened 
          }]"
          :title="voiceStore.localState.isDeafened ? 'Undeafen' : 'Deafen'"
        >
          <Icon :name="voiceStore.localState.isDeafened ? 'headphones-off' : 'headphones'" />
        </button>

        <button
          @click="voiceStore.toggleVideo"
          :class="['control-btn', 'video-btn', { 
            active: voiceStore.localState.isVideoEnabled && !voiceStore.localState.isScreenSharing
          }]"
          :title="voiceStore.localState.isVideoEnabled && !voiceStore.localState.isScreenSharing ? 'Turn off camera' : 'Turn on camera'"
        >
          <Icon name="camera" />
        </button>

        <button
          @click="voiceStore.toggleScreenShare"
          :class="['control-btn', 'screen-btn', { 
            active: voiceStore.localState.isScreenSharing
          }]"
          :title="voiceStore.localState.isScreenSharing ? 'Stop screen share' : 'Share screen'"
        >
          <Icon name="screen-share" />
        </button>

        <button
          @click="toggleSettings"
          :class="['control-btn', 'settings-btn', { active: showSettings }]"
          title="Voice Settings"
        >
          <Icon name="settings" />
        </button>
      </div>

      <!-- Action Controls -->
      <div class="action-controls">
        <button
          @click="expandToOverlay"
          class="control-btn expand-btn"
          title="Expand to overlay"
        >
          <Icon name="maximize" />
        </button>
        
        <button
          @click="minimizeDock"
          class="control-btn minimize-btn"
          title="Minimize"
        >
          <Icon name="minimize" />
        </button>

        <button
          @click="leaveChannel"
          class="control-btn leave-btn"
          title="Leave channel"
        >
          <Icon name="phone-off" />
        </button>
      </div>
    </div>

    <!-- Minimized Mode -->
    <div v-else-if="currentMode === 'minimized'" class="minimized-container" @click="expandToDock">
      <div class="minimized-content">
        <div class="minimized-info">
          <Icon name="volume" class="channel-icon" />
          <span class="channel-name">{{ channelName }}</span>
          <span class="participant-count">{{ voiceStore.connectionStats.total }}</span>
        </div>
        
        <div class="minimized-controls">
          <button 
            @click.stop="voiceStore.toggleMute"
            class="mini-control-btn"
            :class="{ muted: voiceStore.localState.isMuted }"
            :title="voiceStore.localState.isMuted ? 'Unmute' : 'Mute'"
          >
            <Icon :name="voiceStore.localState.isMuted ? 'mic-off' : 'mic'" />
          </button>
          
          <button 
            @click.stop="voiceStore.toggleDeafen"
            class="mini-control-btn"
            :class="{ deafened: voiceStore.localState.isDeafened }"
            :title="voiceStore.localState.isDeafened ? 'Undeafen' : 'Deafen'"
          >
            <Icon :name="voiceStore.localState.isDeafened ? 'headphones-off' : 'headphones'" />
          </button>
          
          <button 
            @click.stop="leaveChannel"
            class="mini-control-btn leave"
            title="Leave channel"
          >
            <Icon name="phone-off" />
          </button>
        </div>
      </div>
    </div>

    <!-- Voice Settings Panel -->
    <VoiceSettingsPanel 
      v-if="showSettings"
      @close="showSettings = false"
    />

    <!-- Full Overlay Mode -->
    <UnifiedVoiceOverlay
      v-if="currentMode === 'overlay'"
      :channel-name="channelName"
      @close="handleOverlayClosed"
      @minimize="collapseToMinimized"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, onMounted, onUnmounted } from 'vue';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useAuthStore } from '@/stores/auth';
import { useServerUsersStore } from '@/stores/useServerUsers';
import UnifiedVoiceOverlay from './UnifiedVoiceOverlay.vue';
import VoiceSettingsPanel from './VoiceSettingsPanel.vue';
import Icon from '@/components/common/Icon.vue';

export default defineComponent({
  name: 'UnifiedVoiceDock',
  components: {
    UnifiedVoiceOverlay,
    VoiceSettingsPanel,
    Icon
  },
  
  props: {
    channelName: {
      type: String,
      default: 'Voice Channel'
    }
  },
  
  setup(props) {
    const voiceStore = useUnifiedVoiceChannelStore();
    const authStore = useAuthStore();
    const serverUsersStore = useServerUsersStore();
    
    const currentMode = ref<'dock' | 'minimized' | 'overlay'>('dock');
    const showSettings = ref(false);
    
    // =============================================================================
    // COMPUTED PROPERTIES
    // =============================================================================
    
    const currentUserId = computed(() => authStore.session?.user?.id);
    
    const currentUserProfile = computed(() => {
      if (!currentUserId.value) return { display_name: 'Unknown', username: 'Unknown', avatar_url: null };
      return serverUsersStore.userProfiles[currentUserId.value] || { 
        display_name: 'Unknown', 
        username: 'Unknown', 
        avatar_url: null 
      };
    });
    
    const isCurrentUserSpeaking = computed(() => {
      return voiceStore.localState.audioLevel > 20 && !voiceStore.localState.isMuted;
    });
    
    const dockMode = computed(() => {
      return {
        'dock-mode': currentMode.value === 'dock',
        'minimized-mode': currentMode.value === 'minimized',
        'overlay-mode': currentMode.value === 'overlay'
      };
    });
    
    // =============================================================================
    // METHODS
    // =============================================================================
    
    const expandToOverlay = () => {
      currentMode.value = 'overlay';
      voiceStore.isOverlayVisible = true;
    };
    
    const expandToDock = () => {
      currentMode.value = 'dock';
      voiceStore.isOverlayVisible = false;
    };
    
    const minimizeDock = () => {
      currentMode.value = 'minimized';
      voiceStore.isOverlayVisible = false;
    };
    
    const collapseToMinimized = () => {
      currentMode.value = 'minimized';
      voiceStore.isOverlayVisible = false;
    };
    
    const toggleSettings = () => {
      showSettings.value = !showSettings.value;
    };
    
    const leaveChannel = async () => {
      await voiceStore.leaveVoiceChannel();
      currentMode.value = 'dock';
    };
    
    const handleOverlayClosed = () => {
      // When overlay is closed, we leave the channel entirely
      currentMode.value = 'dock';
    };
    
    // =============================================================================
    // LIFECYCLE
    // =============================================================================
    
    onMounted(() => {
      // Start in dock mode when first connecting
      currentMode.value = 'dock';
      
      // Keyboard shortcuts
      const handleKeyPress = (event: KeyboardEvent) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
          return;
        }
        
        // Only handle shortcuts when not in overlay mode
        if (currentMode.value !== 'overlay') {
          switch (event.key.toLowerCase()) {
            case 'm':
              voiceStore.toggleMute();
              break;
            case 'd':
              voiceStore.toggleDeafen();
              break;
            case 'v':
              voiceStore.toggleVideo();
              break;
            case 's':
              if (event.ctrlKey || event.metaKey) return; // Don't interfere with save
              voiceStore.toggleScreenShare();
              break;
          }
        }
      };
      
      document.addEventListener('keydown', handleKeyPress);
      
      onUnmounted(() => {
        document.removeEventListener('keydown', handleKeyPress);
      });
    });
    
    return {
      voiceStore,
      currentMode,
      showSettings,
      currentUserProfile,
      isCurrentUserSpeaking,
      dockMode,
      expandToOverlay,
      expandToDock,
      minimizeDock,
      collapseToMinimized,
      toggleSettings,
      leaveChannel,
      handleOverlayClosed
    };
  }
});
</script>

<style scoped>
.unified-voice-dock {
  position: fixed;
  bottom: 20px;
  left: 20px;
  z-index: 1000;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* =============================================================================
   DOCK MODE (Default expanded view)
   ============================================================================= */

.dock-container {
  background: linear-gradient(145deg, #2f3136, #36393f);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 400px;
  box-shadow: 
    0 8px 32px rgba(0, 0, 0, 0.6),
    0 4px 16px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(20px);
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.dock-container:hover {
  background: linear-gradient(145deg, #36393f, #40444b);
  transform: translateY(-2px);
  box-shadow: 
    0 12px 40px rgba(0, 0, 0, 0.7),
    0 6px 20px rgba(0, 0, 0, 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
}

/* User Section */
.user-section {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.user-avatar-container {
  position: relative;
  width: 40px;
  height: 40px;
}

.user-avatar {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid #40444b;
  transition: all 0.3s ease;
}

.user-avatar.speaking {
  border-color: #00d4aa;
  box-shadow: 0 0 20px rgba(0, 212, 170, 0.4);
}

.speaking-ring {
  position: absolute;
  top: -4px;
  left: -4px;
  right: -4px;
  bottom: -4px;
  border: 2px solid #00d4aa;
  border-radius: 50%;
  animation: pulse-ring 2s infinite;
}

.user-details {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.user-name {
  color: #ffffff;
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.channel-name {
  color: #b9bbbe;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Voice Controls */
.voice-controls {
  display: flex;
  gap: 8px;
}

.control-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(0, 0, 0, 0.3);
  color: #b9bbbe;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  backdrop-filter: blur(10px);
}

.control-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.3);
  transform: scale(1.05);
}

.control-btn.active {
  background: linear-gradient(145deg, #00d4aa, #00b894);
  color: white;
  border-color: rgba(0, 212, 170, 0.6);
  box-shadow: 0 4px 12px rgba(0, 212, 170, 0.3);
}

.control-btn.muted {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: white;
  border-color: rgba(237, 66, 69, 0.6);
  box-shadow: 0 4px 12px rgba(237, 66, 69, 0.3);
}

.control-btn.deafened {
  background: linear-gradient(145deg, #faa61a, #e67e22);
  color: white;
  border-color: rgba(250, 166, 26, 0.6);
  box-shadow: 0 4px 12px rgba(250, 166, 26, 0.3);
}

/* Action Controls */
.action-controls {
  display: flex;
  gap: 6px;
}

.expand-btn:hover {
  background: linear-gradient(145deg, #5865f2, #4752c4);
  color: white;
  border-color: rgba(88, 101, 242, 0.6);
}

.minimize-btn:hover {
  background: linear-gradient(145deg, #faa61a, #e67e22);
  color: white;
  border-color: rgba(250, 166, 26, 0.6);
}

.leave-btn:hover {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: white;
  border-color: rgba(237, 66, 69, 0.6);
}

/* =============================================================================
   MINIMIZED MODE
   ============================================================================= */

.minimized-container {
  background: linear-gradient(145deg, #2f3136, #36393f);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 12px 16px;
  cursor: pointer;
  transition: all 0.3s ease;
  min-width: 240px;
  box-shadow: 
    0 6px 20px rgba(0, 0, 0, 0.4),
    0 2px 8px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(10px);
}

.minimized-container:hover {
  background: linear-gradient(145deg, #36393f, #40444b);
  transform: translateY(-1px);
  box-shadow: 
    0 8px 25px rgba(0, 0, 0, 0.5),
    0 3px 10px rgba(0, 0, 0, 0.4);
}

.minimized-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.minimized-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.channel-icon {
  color: #5865f2;
  font-size: 16px;
}

.minimized-info .channel-name {
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

.minimized-controls {
  display: flex;
  gap: 6px;
}

.mini-control-btn {
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

.mini-control-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.3);
}

.mini-control-btn.muted {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: white;
  border-color: rgba(237, 66, 69, 0.6);
}

.mini-control-btn.deafened {
  background: linear-gradient(145deg, #faa61a, #e67e22);
  color: white;
  border-color: rgba(250, 166, 26, 0.6);
}

.mini-control-btn.leave {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: white;
  border-color: rgba(237, 66, 69, 0.6);
}

/* =============================================================================
   ANIMATIONS
   ============================================================================= */

@keyframes pulse-ring {
  0% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.1); opacity: 0.7; }
  100% { transform: scale(1.2); opacity: 0; }
}

/* =============================================================================
   RESPONSIVE DESIGN
   ============================================================================= */

@media (max-width: 768px) {
  .unified-voice-dock {
    bottom: 10px;
    left: 10px;
    right: 10px;
  }
  
  .dock-container {
    min-width: auto;
    width: 100%;
  }
  
  .minimized-container {
    min-width: auto;
    width: 100%;
  }
  
  .user-section {
    flex: 0 1 auto;
  }
  
  .voice-controls {
    gap: 6px;
  }
  
  .control-btn {
    width: 32px;
    height: 32px;
    font-size: 12px;
  }
}

@media (max-width: 480px) {
  .dock-container {
    flex-direction: column;
    gap: 12px;
    padding: 12px;
  }
  
  .user-section {
    width: 100%;
  }
  
  .voice-controls,
  .action-controls {
    justify-content: center;
  }
}
</style>