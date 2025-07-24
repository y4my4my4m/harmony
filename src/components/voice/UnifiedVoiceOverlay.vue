<template>
  <Teleport to="body">
      <!-- Background blur -->
      <div class="overlay-backdrop" :class="{ 'overlay-entering': isEntering, 'overlay-leaving': isLeaving }"></div>
    <div 
      v-if="voiceStore.isOverlayVisible" 
      class="voice-overlay"
      :class="{ 'overlay-entering': isEntering, 'overlay-leaving': isLeaving }"
      @click.self="handleBackdropClick"
    >
      
      <!-- Main container -->
      <div class="voice-container" :class="voiceStore.layoutMode">
        <!-- Header -->
        <div class="voice-header">
          <div class="channel-info">
            <div class="channel-icon">
              <Icon name="volume" />
            </div>
            <div class="channel-details">
              <h2 class="channel-name">{{ props.channelName }}</h2>
              <p class="participant-count">
                {{ connectionStats.total }} participant{{ connectionStats.total !== 1 ? 's' : '' }}
                <span v-if="connectionStats.speaking > 0" class="speaking-count">
                  • {{ connectionStats.speaking }} speaking
                </span>
              </p>
            </div>
          </div>
          
          <div class="header-controls">
            <button 
              @click="voiceStore.setLayoutMode('grid')"
              class="layout-btn"
              :class="{ active: voiceStore.layoutMode === 'grid' }"
              title="Grid view"
            >
              <Icon name="grid" />
            </button>
            <button 
              @click="voiceStore.setLayoutMode('speaker')"
              class="layout-btn"
              :class="{ active: voiceStore.layoutMode === 'speaker' }"
              title="Speaker view"
            >
              <Icon name="user" />
            </button>
            <button 
              @click="toggleSpatialPanel"
              class="layout-btn"
              :class="{ active: spatialStore.isPanelVisible }"
              title="Toggle Spatial Audio"
            >
              <Icon name="map" />
            </button>
            <button 
              @click="toggleSettings"
              class="layout-btn"
              :class="{ active: showSettings }"
              title="Voice Settings"
            >
              <Icon name="settings" />
            </button>
            <button 
              @click="minimizeOverlay"
              class="minimize-btn"
              title="Minimize"
            >
              <Icon name="minimize" />
            </button>
            <button 
              @click="closeOverlay"
              class="close-btn"
              title="Close"
            >
              <Icon name="x" />
            </button>
          </div>
        </div>

        <!-- Featured Speaker (Speaker mode) -->
        <div v-if="voiceStore.layoutMode === 'speaker' && featuredSpeaker" class="featured-speaker">
          <UnifiedVoiceUserCard
            :user-state="featuredSpeaker"
            @toggle-video="voiceStore.toggleVideo"
            @toggle-screen-share="voiceStore.toggleScreenShare"
            class="featured-card"
          />
        </div>

        <!-- Participants Grid -->
        <div class="participants-container" :class="`layout-${voiceStore.layoutMode}`">
          <TransitionGroup
            name="participant"
            tag="div"
            class="participants-grid"
            :class="{ 'speaker-mode': voiceStore.layoutMode === 'speaker' }"
          >
            <UnifiedVoiceUserCard
              v-for="participant in displayedParticipants"
              :key="participant.userId"
              :user-state="participant"
              @toggle-video="voiceStore.toggleVideo"
              @toggle-screen-share="voiceStore.toggleScreenShare"
              class="participant-card"
            />
          </TransitionGroup>
        </div>

        <!-- Bottom Controls -->
        <div class="voice-controls">
          <!-- Media controls -->
          <div class="media-controls">
            <button 
              @click="voiceStore.toggleMute"
              class="control-button"
              :class="{ 
                active: !voiceStore.localState.isMuted,
                muted: voiceStore.localState.isMuted 
              }"
              :title="voiceStore.localState.isMuted ? 'Unmute' : 'Mute'"
            >
              <Icon :name="voiceStore.localState.isMuted ? 'mic-off' : 'mic'" />
            </button>
            
            <button 
              @click="voiceStore.toggleDeafen"
              class="control-button"
              :class="{ 
                active: !voiceStore.localState.isDeafened,
                deafened: voiceStore.localState.isDeafened 
              }"
              :title="voiceStore.localState.isDeafened ? 'Undeafen' : 'Deafen'"
            >
              <Icon :name="voiceStore.localState.isDeafened ? 'headphones-off' : 'headphones'" />
            </button>
            
            <button 
              @click="voiceStore.toggleVideo"
              class="control-button"
              :class="{ 
                active: voiceStore.localState.isVideoEnabled && !voiceStore.localState.isScreenSharing 
              }"
              :title="voiceStore.localState.isVideoEnabled && !voiceStore.localState.isScreenSharing ? 'Turn off camera' : 'Turn on camera'"
            >
              <Icon name="camera" />
            </button>
            
            <button 
              @click="voiceStore.toggleScreenShare"
              class="control-button"
              :class="{ active: voiceStore.localState.isScreenSharing }"
              :title="voiceStore.localState.isScreenSharing ? 'Stop screen share' : 'Share screen'"
            >
              <Icon name="screen-share" />
            </button>
          </div>

          <!-- Action controls -->
          <div class="action-controls">
            <button 
              @click="leaveChannel"
              class="leave-button"
              title="Leave channel"
            >
              <Icon name="phone-off" />
              <span>Leave</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Voice Settings Panel - Teleported separately for proper z-index -->
    <Teleport to="body">
      <div 
        v-if="showSettings"
        class="settings-overlay-wrapper"
        @click.self="showSettings = false"
      >
        <VoiceSettingsPanel 
          @close="showSettings = false"
        />
      </div>
    </Teleport>

    <!-- Spatial Audio Panel -->
    <SpatialAudioPanel 
      :is-under-overlay="true"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useSpatialAudioStore } from '@/stores/spatialAudio';
import UnifiedVoiceUserCard from './UnifiedVoiceUserCard.vue';
import VoiceSettingsPanel from './VoiceSettingsPanel.vue';
import SpatialAudioPanel from './SpatialAudioPanel.vue';
import Icon from '@/components/common/Icon.vue';

interface Props {
  channelName?: string;
}

const props = withDefaults(defineProps<Props>(), {
  channelName: 'Voice Channel',
});

interface Emits {
  (e: 'close'): void;
  (e: 'minimize'): void;
}

const emit = defineEmits<Emits>();

const voiceStore = useUnifiedVoiceChannelStore();
const spatialStore = useSpatialAudioStore();
const isEntering = ref(false);
const isLeaving = ref(false);
const showSettings = ref(false);

// =============================================================================
// COMPUTED PROPERTIES
// =============================================================================

const connectionStats = computed(() => voiceStore.connectionStats);
    
    const featuredSpeaker = computed(() => {
      if (voiceStore.layoutMode !== 'speaker') return null;
      return voiceStore.featuredSpeaker;
    });
    
    // const displayedParticipants = computed(() => {
    //   // Explicitly access the store properties to ensure reactivity
    //   const localState = voiceStore.localState;
    //   const allUsers = voiceStore.allUsers;
      
    //   // Rebuild participants list to ensure reactivity
    //   const participants = [localState];
    //   allUsers.forEach(user => {
    //     if (user.userId !== localState.userId) {
    //       participants.push(user);
    //     }
    //   });
      
    //   if (voiceStore.layoutMode === 'speaker' && featuredSpeaker.value) {
    //     // In speaker mode, show everyone except the featured speaker
    //     return participants.filter(p => p.userId !== featuredSpeaker.value!.userId);
    //   }
      
    //   // In grid mode, show everyone
    //   return participants;
    // });


    const displayedParticipants = computed(() => {
      const allParticipants = voiceStore.allParticipants;
      
      if (voiceStore.layoutMode === 'speaker' && featuredSpeaker.value) {
        // In speaker mode, show everyone except the featured speaker
        return allParticipants.filter(p => p.userId !== featuredSpeaker.value!.userId);
      }
      
      // In grid mode, show everyone
      return allParticipants;
    });
    
    // =============================================================================
    // METHODS
    // =============================================================================
    
    const handleBackdropClick = () => {
      minimizeOverlay();
    };
    
    const minimizeOverlay = () => {
      isLeaving.value = true;
      setTimeout(() => {
        voiceStore.toggleOverlay();
        isLeaving.value = false;
        emit('minimize');
      }, 300);
    };
    
    const closeOverlay = () => {
      minimizeOverlay();
    };
    
    const leaveChannel = async () => {
      const success = await voiceStore.leaveVoiceChannel();
      if (success) {
        emit('close');
      }
    };
    
    const toggleSettings = () => {
      showSettings.value = !showSettings.value;
    };
    
    const toggleSpatialPanel = () => {
      spatialStore.togglePanel();
    };
    // =============================================================================
    // LIFECYCLE
    // =============================================================================
    
    onMounted(() => {
      isEntering.value = true;
      setTimeout(() => {
        isEntering.value = false;
      }, 300);
      
      // Keyboard shortcuts
      const handleKeyPress = (event: KeyboardEvent) => {
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
          return; // Don't trigger shortcuts when typing
        }
        
        switch (event.key.toLowerCase()) {
          case 'm':
            voiceStore.toggleMute();
            break;
          case 'v':
            voiceStore.toggleVideo();
            break;
          case 's':
            if (event.ctrlKey || event.metaKey) return; // Don't interfere with save
            voiceStore.toggleScreenShare();
            break;
          case 'd':
            voiceStore.toggleDeafen();
            break;
          case ',':
            // Settings shortcut (comma key, like Discord)
            toggleSettings();
            break;
          case 'escape':
            if (showSettings.value) {
              showSettings.value = false;
            } else {
              minimizeOverlay();
            }
            break;
        }
      };
      
      document.addEventListener('keydown', handleKeyPress);
      
      onUnmounted(() => {
        document.removeEventListener('keydown', handleKeyPress);
      });
    });
</script>

<style scoped>
.voice-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  animation: overlay-enter 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.voice-overlay.overlay-leaving {
  animation: overlay-leave 0.3s cubic-bezier(0.55, 0.06, 0.68, 0.19);
}

.overlay-backdrop {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(10px);
  transition: all 0.3s ease;
  opacity: 1;
}
.overlay-backdrop.overlay-entering {
  opacity: 1;
}
.overlay-backdrop.overlay-leaving {
  opacity: 0;
}

.voice-container {
  position: relative;
  background: linear-gradient(145deg, #2f3136, #36393f);
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 
    0 20px 60px rgba(0, 0, 0, 0.6),
    0 8px 32px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  width: 100%;
  max-width: 1200px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Header */
.voice-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  background: linear-gradient(145deg, #36393f, #2f3136);
}

.channel-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.channel-icon {
  width: 40px;
  height: 40px;
  background: linear-gradient(145deg, #5865f2, #4752c4);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 18px;
}

.channel-name {
  font-size: 20px;
  font-weight: 700;
  color: #ffffff;
  margin: 0 0 4px 0;
}

.participant-count {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
}

.speaking-count {
  color: #00d4aa;
  font-weight: 600;
}

.header-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.layout-btn,
.minimize-btn,
.close-btn {
  width: 36px;
  height: 36px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  color: #b9bbbe;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}

.layout-btn:hover,
.minimize-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.3);
}

.layout-btn.active {
  background: linear-gradient(145deg, #5865f2, #4752c4);
  color: white;
  border-color: rgba(88, 101, 242, 0.6);
}

.close-btn:hover {
  background: #ed4245;
  color: white;
  border-color: #ed4245;
}

/* Featured Speaker */
.featured-speaker {
  padding: 20px 24px;
  display: flex;
  justify-content: center;
}

.featured-card {
  width: 100%;
  max-width: 600px;
  min-height: 300px;
}

/* Participants Container */
.participants-container {
  flex: 1;
  padding: 20px 24px;
  overflow-y: auto;
  min-height: 300px;
  align-content: center;
  justify-content: center;
  display: flex;  /* Added display property */
  flex-direction: column; /* Ensure children stack vertically */
}

.participants-grid {
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  place-items: stretch;
}

.participants-grid.speaker-mode {
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  max-height: 300px;
  overflow-y: visible;
}

.layout-speaker .participants-grid {
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
}

/* Voice Controls */
.voice-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  background: linear-gradient(145deg, #2f3136, #36393f);
}

.media-controls {
  display: flex;
  gap: 12px;
}

.control-button {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.2);
  background: rgba(0, 0, 0, 0.3);
  color: #b9bbbe;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  backdrop-filter: blur(10px);
}

.control-button:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.4);
  transform: scale(1.05);
}

.control-button.active {
  background: linear-gradient(145deg, #00d4aa, #00b894);
  color: white;
  border-color: rgba(0, 212, 170, 0.6);
  box-shadow: 0 4px 16px rgba(0, 212, 170, 0.3);
}

.control-button.muted {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: white;
  border-color: rgba(237, 66, 69, 0.6);
  box-shadow: 0 4px 16px rgba(237, 66, 69, 0.3);
}

.control-button.deafened {
  background: linear-gradient(145deg, #faa61a, #e67e22);
  color: white;
  border-color: rgba(250, 166, 26, 0.6);
  box-shadow: 0 4px 16px rgba(250, 166, 26, 0.3);
}

.leave-button {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: white;
  border: none;
  border-radius: 25px;
  padding: 12px 24px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 8px;
  box-shadow: 0 4px 16px rgba(237, 66, 69, 0.3);
}

.leave-button:hover {
  background: linear-gradient(145deg, #c73e1d, #a0281a);
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(237, 66, 69, 0.4);
}

/* Participant Transitions */
.participant-enter-active,
.participant-leave-active {
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.participant-enter-from {
  opacity: 0;
  transform: scale(0.8) translateY(20px);
}

.participant-leave-to {
  opacity: 0;
  transform: scale(0.8) translateY(-20px);
}

/* Animations */
@keyframes overlay-enter {
  from {
    opacity: 0;
    transform: scale(0.9);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes overlay-leave {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.9);
  }
}

/* Responsive Design */
@media (max-width: 1024px) {
  .voice-container {
    max-width: 95vw;
  }
  
  .participants-grid {
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  }
}

@media (max-width: 768px) {
  .voice-overlay {
    padding: 10px;
  }
  
  .voice-header {
    padding: 16px 20px;
  }
  
  .channel-name {
    font-size: 18px;
  }
  
  .participants-container {
    padding: 16px 20px;
  }
  
  .participants-grid {
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
  }
  
  .voice-controls {
    padding: 16px 20px;
  }
  
  .media-controls {
    gap: 8px;
  }
  
  .control-button {
    width: 44px;
    height: 44px;
    font-size: 16px;
  }
}

@media (max-width: 480px) {
  .participants-grid {
    grid-template-columns: 1fr 1fr;
  }
  
  .featured-card {
    min-height: 240px;
  }
  
  .header-controls {
    gap: 4px;
  }
  
  .layout-btn,
  .minimize-btn,
  .close-btn {
    width: 32px;
    height: 32px;
    font-size: 14px;
  }
}

/* Settings Panel Wrapper - Ensures proper z-index layering */
.settings-overlay-wrapper {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10001; /* Higher than voice overlay (9999) */
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
}

/* Override the VoiceSettingsPanel styles when inside our wrapper */
.settings-overlay-wrapper :deep(.settings-overlay) {
  position: static;
  width: auto;
  height: auto;
  background: transparent;
  backdrop-filter: none;
  z-index: auto;
}
</style>