<template>
  <Teleport to="body">
    <div 
      v-if="isVisible" 
      class="voice-overlay"
      :class="{ 
        'overlay-entering': isEntering,
        'overlay-leaving': isLeaving 
      }"
      @click.self="handleOverlayClick"
    >
      <!-- Backdrop -->
      <div class="overlay-backdrop"></div>
      
      <!-- Main Container -->
      <div class="voice-container" :class="layoutMode">
        <!-- Header -->
        <div class="voice-header">
          <div class="channel-info">
            <div class="channel-icon">
              <Icon name="volume" size="lg" />
            </div>
            <div class="channel-details">
              <h2 class="channel-name">{{ channelName }}</h2>
              <p class="participant-count">
                {{ connectedUsers.length }} participant{{ connectedUsers.length !== 1 ? 's' : '' }}
              </p>
            </div>
          </div>
          
          <div class="header-controls">
            <button 
              @click="toggleLayoutMode"
              class="control-btn layout-btn"
              :title="`Switch to ${layoutMode === 'grid' ? 'gallery' : 'grid'} view`"
            >
              <Icon :name="layoutMode === 'grid' ? 'grid' : 'list'" />
            </button>
            
            <button 
              @click="togglePictureInPicture"
              class="control-btn pip-btn"
              :class="{ active: isPipMode }"
              title="Picture in Picture"
            >
              <Icon name="picture-in-picture" />
            </button>
            
            <button 
              @click="closeOverlay"
              class="control-btn close-btn"
              title="Close"
            >
              <Icon name="x" />
            </button>
          </div>
        </div>

        <!-- Participants Grid -->
        <div class="participants-container" :class="layoutMode">
          <!-- Featured Speaker (if in speaker mode) -->
          <div 
            v-if="layoutMode === 'speaker' && featuredSpeaker"
            class="featured-speaker"
          >
            <VoiceUserCard
              :user="featuredSpeaker.user"
              :video-stream="featuredSpeaker.stream"
              :audio-level="featuredSpeaker.audioLevel"
              :is-muted="featuredSpeaker.isMuted"
              :is-deafened="featuredSpeaker.isDeafened"
              :has-video="featuredSpeaker.hasVideo"
              :is-screen-sharing="featuredSpeaker.isScreenSharing"
              :connection-state="featuredSpeaker.connectionState"
              :is-self="featuredSpeaker.isSelf"
              :show-activity="false"
              class="featured-card"
            />
          </div>

          <!-- Participants List -->
          <div class="participants-grid" :class="gridClass">
            <VoiceUserCard
              v-for="participant in displayedParticipants"
              :key="participant.userId"
              :user="participant.user"
              :video-stream="participant.stream"
              :audio-level="participant.audioLevel"
              :is-muted="participant.isMuted"
              :is-deafened="participant.isDeafened"
              :has-video="participant.hasVideo"
              :is-screen-sharing="participant.isScreenSharing"
              :connection-state="participant.connectionState"
              :is-self="participant.isSelf"
              @toggle-video="handleToggleVideo(participant.userId)"
              @toggle-screen-share="handleToggleScreenShare(participant.userId)"
              class="participant-card"
            />
          </div>
        </div>

        <!-- Bottom Controls -->
        <div class="voice-controls">
          <div class="controls-section main-controls">
            <button 
              @click="toggleMute"
              class="control-btn primary-btn"
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
              class="control-btn primary-btn"
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
              class="control-btn primary-btn"
              :class="{ active: hasVideo }"
              title="Toggle Camera"
            >
              <Icon :name="hasVideo ? 'camera' : 'camera-off'" />
            </button>

            <button 
              @click="toggleScreenShare"
              class="control-btn primary-btn"
              :class="{ active: isScreenSharing }"
              title="Share Screen"
            >
              <Icon name="screen-share" />
            </button>
          </div>

          <div class="controls-section secondary-controls">
            <button 
              @click="openSettings"
              class="control-btn secondary-btn"
              title="Voice Settings"
            >
              <Icon name="settings" />
            </button>

            <button 
              @click="leaveChannel"
              class="control-btn leave-btn"
              title="Leave Voice Channel"
            >
              <Icon name="phone-off" />
              <span class="btn-text">Leave</span>
            </button>
          </div>
        </div>

        <!-- Settings Panel -->
        <VoiceSettingsPanel
          v-if="showSettings"
          @close="closeSettings"
          @update-settings="handleSettingsUpdate"
        />
      </div>
    </div>
  </Teleport>
</template>

<script lang="ts">
import { defineComponent, computed, ref, onMounted, onUnmounted } from 'vue';
import { useVoiceChannelStore } from '@/stores/voiceChannel';
import { useServerUsersStore } from '@/stores/useServerUsers';
import VoiceUserCard from './VoiceUserCard.vue';
import VoiceSettingsPanel from './VoiceSettingsPanel.vue';
import Icon from '@/components/common/Icon.vue';

export default defineComponent({
  name: 'VoiceChannelOverlay',
  components: {
    VoiceUserCard,
    VoiceSettingsPanel,
    Icon
  },
  props: {
    channelName: {
      type: String,
      default: 'Voice Channel'
    },
    isVisible: {
      type: Boolean,
      default: false
    }
  },
  emits: ['close', 'leave-channel'],
  setup(props, { emit }) {
    const voiceChannelStore = useVoiceChannelStore();
    const serverUsersStore = useServerUsersStore();
    
    const layoutMode = ref<'grid' | 'speaker' | 'gallery'>('grid');
    const isPipMode = ref(false);
    const showSettings = ref(false);
    const isEntering = ref(false);
    const isLeaving = ref(false);

    // Computed properties
    const connectedUsers = computed(() => voiceChannelStore.connectedUsers);
    const isMuted = computed(() => voiceChannelStore.isMuted);
    const isDeafened = computed(() => voiceChannelStore.isDeafened);
    const hasVideo = computed(() => voiceChannelStore.isVideoEnabled);
    const isScreenSharing = computed(() => voiceChannelStore.isScreenSharing);

    // Participants data
    const participants = computed(() => {
      return connectedUsers.value.map(userId => ({
        userId,
        user: serverUsersStore.userProfiles[userId] || { id: userId, username: 'Unknown' },
        stream: voiceChannelStore.getUserStream(userId),
        audioLevel: voiceChannelStore.getAudioLevel(userId),
        isMuted: userId === getCurrentUserId() ? isMuted.value : false,
        isDeafened: userId === getCurrentUserId() ? isDeafened.value : false,
        hasVideo: !!voiceChannelStore.getUserStream(userId)?.getVideoTracks().length,
        isScreenSharing: false, // TODO: implement screen sharing detection
        connectionState: voiceChannelStore.getConnectionState(userId),
        isSelf: userId === getCurrentUserId()
      }));
    });

    // Featured speaker (loudest or screen sharing)
    const featuredSpeaker = computed(() => {
      if (layoutMode.value !== 'speaker') return null;
      
      // Prioritize screen sharers
      const screenSharer = participants.value.find(p => p.isScreenSharing);
      if (screenSharer) return screenSharer;
      
      // Otherwise find loudest speaker
      return participants.value.reduce((loudest, current) => {
        return current.audioLevel > (loudest?.audioLevel || 0) ? current : loudest;
      }, null);
    });

    // Displayed participants (excluding featured speaker in speaker mode)
    const displayedParticipants = computed(() => {
      if (layoutMode.value === 'speaker' && featuredSpeaker.value) {
        return participants.value.filter(p => p.userId !== featuredSpeaker.value!.userId);
      }
      return participants.value;
    });

    // Grid layout class
    const gridClass = computed(() => {
      const count = displayedParticipants.value.length;
      if (count <= 1) return 'grid-1';
      if (count <= 4) return 'grid-2x2';
      if (count <= 6) return 'grid-2x3';
      if (count <= 9) return 'grid-3x3';
      return 'grid-auto';
    });

    // Methods
    const getCurrentUserId = () => {
      // TODO: Get from auth store
      return 'current-user-id';
    };

    const toggleLayoutMode = () => {
      const modes = ['grid', 'speaker', 'gallery'];
      const currentIndex = modes.indexOf(layoutMode.value);
      layoutMode.value = modes[(currentIndex + 1) % modes.length] as any;
    };

    const togglePictureInPicture = () => {
      isPipMode.value = !isPipMode.value;
      // TODO: Implement PiP functionality
    };

    const handleOverlayClick = () => {
      // Close overlay when clicking backdrop (optional)
    };

    const closeOverlay = () => {
      isLeaving.value = true;
      setTimeout(() => {
        emit('close');
        isLeaving.value = false;
      }, 300);
    };

    // Voice controls
    const toggleMute = () => voiceChannelStore.toggleMute();
    const toggleDeafen = () => voiceChannelStore.toggleDeafen();
    const toggleVideo = () => voiceChannelStore.toggleVideo();
    const toggleScreenShare = () => voiceChannelStore.toggleScreenShare();

    const handleToggleVideo = (userId: string) => {
      if (userId === getCurrentUserId()) {
        toggleVideo();
      }
    };

    const handleToggleScreenShare = (userId: string) => {
      if (userId === getCurrentUserId()) {
        toggleScreenShare();
      }
    };

    const openSettings = () => {
      showSettings.value = true;
    };

    const closeSettings = () => {
      showSettings.value = false;
    };

    const handleSettingsUpdate = (settings: any) => {
      // TODO: Apply settings
      console.log('Settings updated:', settings);
    };

    const leaveChannel = () => {
      emit('leave-channel');
      closeOverlay();
    };

    // Lifecycle
    onMounted(() => {
      if (props.isVisible) {
        isEntering.value = true;
        setTimeout(() => {
          isEntering.value = false;
        }, 300);
      }
    });

    // Keyboard shortcuts
    const handleKeyPress = (event: KeyboardEvent) => {
      if (!props.isVisible) return;
      
      switch (event.code) {
        case 'KeyM':
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            toggleMute();
          }
          break;
        case 'KeyD':
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            toggleDeafen();
          }
          break;
        case 'KeyV':
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            toggleVideo();
          }
          break;
        case 'Escape':
          event.preventDefault();
          closeOverlay();
          break;
      }
    };

    onMounted(() => {
      document.addEventListener('keydown', handleKeyPress);
    });

    onUnmounted(() => {
      document.removeEventListener('keydown', handleKeyPress);
    });

    return {
      layoutMode,
      isPipMode,
      showSettings,
      isEntering,
      isLeaving,
      connectedUsers,
      isMuted,
      isDeafened,
      hasVideo,
      isScreenSharing,
      participants,
      featuredSpeaker,
      displayedParticipants,
      gridClass,
      toggleLayoutMode,
      togglePictureInPicture,
      handleOverlayClick,
      closeOverlay,
      toggleMute,
      toggleDeafen,
      toggleVideo,
      toggleScreenShare,
      handleToggleVideo,
      handleToggleScreenShare,
      openSettings,
      closeSettings,
      handleSettingsUpdate,
      leaveChannel
    };
  }
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
}

.overlay-backdrop {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(8px);
  animation: fadeIn 0.3s ease;
}

.voice-container {
  position: relative;
  background: linear-gradient(145deg, #2f3349, #252837);
  border-radius: 24px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 
    0 20px 60px rgba(0, 0, 0, 0.3),
    0 8px 25px rgba(0, 0, 0, 0.2);
  width: 90vw;
  height: 85vh;
  max-width: 1400px;
  max-height: 900px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: slideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* Header */
.voice-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px 32px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.02);
}

.channel-info {
  display: flex;
  align-items: center;
  gap: 16px;
}

.channel-icon {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, #5865f2, #7289da);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
}

.channel-name {
  font-size: 24px;
  font-weight: 700;
  color: #ffffff;
  margin: 0 0 4px 0;
}

.participant-count {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
}

.header-controls {
  display: flex;
  gap: 12px;
}

/* Participants Container */
.participants-container {
  flex: 1;
  padding: 24px 32px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.participants-container.speaker {
  flex-direction: row;
  gap: 24px;
}

.featured-speaker {
  flex: 2;
  display: flex;
}

.featured-card {
  width: 100%;
  min-height: 400px;
}

.participants-grid {
  display: grid;
  gap: 16px;
  overflow-y: auto;
  padding-right: 8px;
}

/* Grid layouts */
.grid-1 {
  grid-template-columns: 1fr;
  place-items: center;
}

.grid-2x2 {
  grid-template-columns: repeat(2, 1fr);
}

.grid-2x3 {
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(2, 1fr);
}

.grid-3x3 {
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(3, 1fr);
}

.grid-auto {
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
}

.participants-container.speaker .participants-grid {
  flex: 1;
  grid-template-columns: 1fr;
  grid-auto-rows: minmax(120px, 1fr);
}

.participant-card {
  transition: transform 0.2s ease;
}

.participant-card:hover {
  transform: scale(1.02);
}

/* Voice Controls */
.voice-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px 32px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(0, 0, 0, 0.2);
}

.controls-section {
  display: flex;
  gap: 12px;
  align-items: center;
}

.control-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 2px solid transparent;
  border-radius: 12px;
  padding: 12px;
  color: #dcddde;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  backdrop-filter: blur(8px);
}

.control-btn:hover {
  background: rgba(255, 255, 255, 0.15);
  transform: translateY(-1px);
}

.primary-btn {
  width: 48px;
  height: 48px;
  border-radius: 50%;
}

.primary-btn.active {
  background: #5865f2;
  border-color: #5865f2;
  color: white;
}

.primary-btn.danger {
  background: #ed4245;
  border-color: #ed4245;
  color: white;
}

.secondary-btn {
  padding: 8px;
}

.leave-btn {
  background: #ed4245;
  border-color: #ed4245;
  color: white;
  padding: 12px 20px;
}

.leave-btn:hover {
  background: #c13236;
  border-color: #c13236;
}

.btn-text {
  font-size: 14px;
}

/* Animations */
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: scale(0.9) translateY(20px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.overlay-entering .voice-container {
  animation: slideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.overlay-leaving .voice-container {
  animation: slideOut 0.3s ease-in;
}

@keyframes slideOut {
  from {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
  to {
    opacity: 0;
    transform: scale(0.9) translateY(-20px);
  }
}

/* Responsive */
@media (max-width: 1200px) {
  .voice-container {
    width: 95vw;
    height: 90vh;
  }
  
  .participants-container.speaker {
    flex-direction: column;
  }
  
  .featured-speaker {
    flex: none;
    height: 50%;
  }
}

@media (max-width: 768px) {
  .voice-header {
    padding: 16px 20px;
  }
  
  .channel-name {
    font-size: 20px;
  }
  
  .participants-container {
    padding: 16px 20px;
  }
  
  .voice-controls {
    padding: 16px 20px;
    flex-wrap: wrap;
    gap: 12px;
  }
  
  .controls-section {
    flex-wrap: wrap;
  }
  
  .grid-2x2,
  .grid-2x3,
  .grid-3x3 {
    grid-template-columns: 1fr;
  }
}

/* Custom scrollbar */
.participants-grid::-webkit-scrollbar {
  width: 6px;
}

.participants-grid::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 3px;
}

.participants-grid::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
}

.participants-grid::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.3);
}
</style>