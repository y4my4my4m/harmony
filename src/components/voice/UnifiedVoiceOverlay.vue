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
      <div class="voice-container" :class="[voiceStore.layoutMode, { 'maximized': voiceStore.viewMode === 'maximized', 'fullscreen-mode': voiceStore.viewMode === 'fullscreen' }]">
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
              @click="toggleMaximize"
              class="layout-btn"
              :class="{ active: voiceStore.viewMode === 'maximized' }"
              title="Maximize"
            >
              <Icon name="maximize" />
            </button>
            <button 
              @click="toggleSpatialPanel"
              class="layout-btn spatial-btn"
              :class="{ 
                active: spatialStore.isPanelVisible,
                'spatial-enabled': spatialStore.settings.enabled
              }"
              :title="spatialStore.settings.enabled ? 'Spatial Audio: ON' : 'Spatial Audio: OFF'"
            >
              <Icon name="map" />
              <span v-if="spatialStore.settings.enabled" class="spatial-badge">3D</span>
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
        <div v-if="voiceStore.viewMode !== 'fullscreen'" class="participants-container" :class="`layout-${voiceStore.layoutMode}`">
          <TransitionGroup
            name="participant"
            tag="div"
            class="participants-grid"
            :class="[adaptiveGridClass, { 'speaker-mode': voiceStore.layoutMode === 'speaker' }]"
            :style="voiceStore.layoutMode === 'grid' ? gridStyle : {}"
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

        <!-- Fullscreen View -->
        <div v-else-if="voiceStore.viewMode === 'fullscreen' && fullscreenParticipant" class="fullscreen-container">
          <UnifiedVoiceUserCard
            :key="fullscreenParticipant.userId"
            :user-state="fullscreenParticipant"
            @toggle-video="voiceStore.toggleVideo"
            @toggle-screen-share="voiceStore.toggleScreenShare"
            class="fullscreen-card"
          />
          
          <!-- Thumbnail strip at bottom -->
          <div class="thumbnail-strip">
            <UnifiedVoiceUserCard
              v-for="participant in nonFullscreenParticipants"
              :key="participant.userId"
              :user-state="participant"
              @toggle-video="voiceStore.toggleVideo"
              @toggle-screen-share="voiceStore.toggleScreenShare"
              class="thumbnail-card"
            />
          </div>
        </div>

        <!-- Bottom Controls -->
        <div class="voice-controls">
          <!-- Media controls -->
          <div class="media-controls">
            <!-- Microphone with device selector -->
            <div class="control-group">
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
              <DeviceSelector type="input" @open-settings="showSettings = true" />
            </div>
            
            <!-- Speakers with device selector -->
            <div class="control-group">
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
              <DeviceSelector type="output" @open-settings="showSettings = true" />
            </div>
            
            <!-- Camera with device selector -->
            <div class="control-group">
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
              <DeviceSelector type="video" @open-settings="showSettings = true" />
            </div>
            
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

    <!-- Screenshare PIP -->
    <ScreensharePIP />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useSpatialAudioStore } from '@/stores/spatialAudio';
import { useAdaptiveGrid } from '@/composables/useAdaptiveGrid';
import UnifiedVoiceUserCard from './UnifiedVoiceUserCard.vue';
import VoiceSettingsPanel from './VoiceSettingsPanel.vue';
import SpatialAudioPanel from './SpatialAudioPanel.vue';
import ScreensharePIP from './ScreensharePIP.vue';
import DeviceSelector from './DeviceSelector.vue';
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
// ADAPTIVE GRID
// =============================================================================

const { gridStyle, gridClass: adaptiveGridClass } = useAdaptiveGrid(
  () => voiceStore.allParticipants.length
);

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
    
    // Fullscreen mode participants
    const fullscreenParticipant = computed(() => {
      if (voiceStore.viewMode !== 'fullscreen' || !voiceStore.fullscreenUserId) return null;
      return voiceStore.allParticipants.find(p => p.userId === voiceStore.fullscreenUserId) || null;
    });
    
    const nonFullscreenParticipants = computed(() => {
      if (voiceStore.viewMode !== 'fullscreen' || !voiceStore.fullscreenUserId) return [];
      return voiceStore.allParticipants.filter(p => p.userId !== voiceStore.fullscreenUserId);
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

    const toggleMaximize = () => {
      if (voiceStore.viewMode === 'maximized') {
        voiceStore.setViewMode('normal');
      } else {
        voiceStore.setViewMode('maximized');
      }
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
            if (voiceStore.viewMode === 'fullscreen') {
              voiceStore.exitFullscreen();
            } else if (showSettings.value) {
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
  z-index: 10000;
}

/* Maximized mode */
.voice-container.maximized {
  max-width: 95vw;
  max-height: 95vh;
}

/* When .voice-container.maximized is present, remove align-items: center from .voice-overlay */
.voice-overlay:has(> .voice-container.maximized) {
  align-items: unset;
}

/* Fullscreen mode - maximize video space like Discord */
.voice-container.fullscreen-mode {
  max-width: 100vw;
  max-height: 100vh;
  height: 100vh;
  width: 100vw;
  border-radius: 0;
}

/* Compact header in fullscreen */
.voice-container.fullscreen-mode .voice-header {
  padding: 12px 16px;
}

/* Compact controls in fullscreen */
.voice-container.fullscreen-mode .voice-controls {
  padding: 12px 16px;
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
  color: var(--text-secondary);
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
  color: var(--text-secondary);
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

/* Spatial audio button with indicator */
.spatial-btn {
  position: relative;
}

.spatial-btn.spatial-enabled {
  background: linear-gradient(145deg, #00d4aa, #00b894);
  color: white;
  border-color: rgba(0, 212, 170, 0.6);
  box-shadow: 0 0 12px rgba(0, 212, 170, 0.4);
}

.spatial-btn.spatial-enabled:hover {
  background: linear-gradient(145deg, #00e5b8, #00c9a0);
}

.spatial-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: #00d4aa;
  color: #000;
  font-size: 8px;
  font-weight: 800;
  padding: 2px 4px;
  border-radius: 4px;
  line-height: 1;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  animation: pulse-badge 2s infinite;
}

@keyframes pulse-badge {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}

.close-btn:hover {
  background: #ed4245;
  color: white;
  border-color: #ed4245;
}

/* Featured Speaker - larger when screensharing */
.featured-speaker {
  padding: 16px;
  display: flex;
  justify-content: center;
  flex: 1;
  min-height: 0;
}

.featured-card {
  width: 100%;
  max-width: 900px;
  min-height: 300px;
  flex: 1;
  display: flex;
  flex-direction: column;
}

/* When featured speaker is screensharing, maximize video */
.featured-card :deep(.harmony-voice-card.screen-sharing) {
  flex: 1;
}

.featured-card :deep(.harmony-voice-card.screen-sharing .video-container) {
  flex: 1;
  max-height: none;
  height: auto;
  min-height: 300px;
}

/* Participants Container */
.participants-container {
  flex: 1;
  padding: 16px 24px;
  overflow-y: auto;
  min-height: 300px;
  align-content: flex-start;
  justify-content: flex-start;
  display: flex;
  flex-direction: column;
}


.voice-container.maximized .participants-container {
  padding: 12px 16px;
  min-height: 0;
}

.voice-container.maximized .participants-grid {
  align-items: stretch;
  align-content: start;
}

.voice-container.maximized .participant-card :deep(.harmony-voice-card) {
  min-height: 350px;
}

.voice-container.maximized .participant-card :deep(.video-container) {
  height: 300px;
  max-height: none; /* Allow video to be larger */
}

.participants-grid {
  display: grid;
  gap: var(--grid-gap, 16px);
  grid-template-columns: repeat(auto-fill, minmax(var(--grid-min-width, 320px), var(--grid-max-width, 1fr)));
  place-items: stretch;
}

/* Adaptive grid classes for specific participant counts */
.participants-grid.grid-single {
  justify-content: center;
  grid-template-columns: minmax(400px, 600px);
}

.participants-grid.grid-duo {
  grid-template-columns: repeat(2, minmax(280px, 1fr));
}

.participants-grid.grid-quad {
  grid-template-columns: repeat(2, minmax(260px, 1fr));
}

.participants-grid.grid-six {
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}

.participants-grid.grid-nine {
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}

.participants-grid.grid-large {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.participants-grid.grid-gallery {
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
}

/* Participant card height based on grid config */
.participants-grid .participant-card :deep(.harmony-voice-card) {
  min-height: var(--grid-card-height, 200px);
}

/* Maximized mode - larger tiles */
.voice-container.maximized .participants-grid {
  --grid-min-width: 380px;
  --grid-gap: 20px;
}

.voice-container.maximized .participants-grid.grid-single,
.voice-container.maximized .participants-grid.grid-duo {
  grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
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

/* Control group with button and device selector */
.control-group {
  display: flex;
  align-items: center;
  gap: 4px;
}

.control-button {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.2);
  background: rgba(0, 0, 0, 0.3);
  color: var(--text-secondary);
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

/* Fullscreen Container - Discord-like layout where screenshare dominates */
.fullscreen-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 12px 16px;
  overflow: hidden;
  height: 100%;
  min-height: 0; /* Allow flex shrinking */
}

.fullscreen-card {
  flex: 1;
  min-height: 0;
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
}

/* Remove card constraints in fullscreen - let video fill the space */
.fullscreen-card :deep(.harmony-voice-card) {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 8px;
}

.fullscreen-card :deep(.video-container) {
  flex: 1;
  height: auto !important;
  min-height: 200px;
  max-height: none !important; /* Override the 400px limit */
  aspect-ratio: unset; /* Let it stretch to fill */
  margin-bottom: 0;
}

.fullscreen-card :deep(.video-stream) {
  width: 100%;
  height: 100%;
  object-fit: contain !important;
}

/* Hide user info in fullscreen main view - space is precious */
.fullscreen-card :deep(.user-info) {
  position: absolute;
  bottom: 8px;
  left: 8px;
  background: rgba(0, 0, 0, 0.7);
  padding: 4px 8px;
  border-radius: 4px;
  backdrop-filter: blur(4px);
}

.fullscreen-card :deep(.avatar-container) {
  display: none; /* Hide avatar when video is showing */
}

/* Compact thumbnail strip at bottom - Discord style */
.thumbnail-strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 4px 0;
  max-height: 100px;
  flex-shrink: 0;
}

.thumbnail-card {
  flex-shrink: 0;
  width: 120px;
}

.thumbnail-card :deep(.harmony-voice-card) {
  min-height: 80px;
  padding: 4px;
}

.thumbnail-card :deep(.video-container) {
  height: 60px !important;
  min-height: 60px !important;
  max-height: 60px !important;
  margin-bottom: 2px;
  aspect-ratio: 16 / 9;
}

.thumbnail-card :deep(.username) {
  font-size: 10px;
}

.thumbnail-card :deep(.user-info) {
  padding-bottom: 0;
  top: auto;
  bottom: 2px;
}

.thumbnail-card :deep(.avatar-container) {
  transform: scale(0.7);
}

.thumbnail-card :deep(.status-indicators) {
  transform: scale(0.8);
}

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