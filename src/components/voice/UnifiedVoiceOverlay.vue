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
      <div class="voice-container" :class="[voiceStore.layoutMode, { 'maximized': voiceStore.viewMode === 'maximized', 'fullscreen-mode': voiceStore.viewMode === 'fullscreen', 'rainbow-party': easterEggState.isActive && easterEggState.type === 'rainbow-party', 'screen-shake': easterEggState.isActive && easterEggState.type === 'rainbow-party' }]">
        <!-- Header -->
        <div class="voice-header">
          <div class="channel-info">
            <div class="channel-icon">
              <Icon name="volume" />
            </div>
            <div class="channel-details">
              <h2 class="channel-name">
                <DisplayName v-if="voiceStore.dmOtherUserId" :user-id="voiceStore.dmOtherUserId" :fallback="props.channelName" />
                <template v-else>{{ props.channelName }}</template>
              </h2>
              <p class="participant-count">
                {{ connectionStats.total }} participant{{ connectionStats.total !== 1 ? 's' : '' }}
                <span v-if="connectionStats.speaking > 0" class="speaking-count">
                  • {{ connectionStats.speaking }} speaking
                </span>
              </p>
            </div>
          </div>
          
          <div class="header-controls">
            <!-- E2EE Indicator -->
            <VoiceEncryptionBadge
              v-if="voiceStore.connectionMode"
              class="overlay-encryption-badge"
              :encrypted="voiceStore.isEncrypted"
              size="md"
              show-label
            />
            <!-- Connection Mode Indicator -->
            <div class="connection-mode-indicator" :class="voiceStore.connectionMode || 'unknown'">
              <Icon :name="voiceStore.connectionMode === 'livekit' ? 'server' : 'users'" />
              <span>{{ voiceStore.connectionMode === 'livekit' ? 'SFU' : 'P2P' }}</span>
            </div>
            
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

        <!-- Featured Speaker (Speaker mode) - Hidden when in fullscreen to avoid doubled video -->
        <div v-if="voiceStore.layoutMode === 'speaker' && featuredSpeaker && voiceStore.viewMode !== 'fullscreen'" class="featured-speaker">
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
        <div 
          v-else-if="voiceStore.viewMode === 'fullscreen' && fullscreenParticipant" 
          class="fullscreen-container"
          :class="{ 'full-window-mode': isFullWindowMode }"
          @click="isFullWindowMode && voiceStore.toggleFullWindowMode()"
        >
          <UnifiedVoiceUserCard
            :key="fullscreenParticipant.userId"
            :user-state="fullscreenParticipant"
            @toggle-video="voiceStore.toggleVideo"
            @toggle-screen-share="voiceStore.toggleScreenShare"
            class="fullscreen-card"
          />
          
          <!-- Thumbnail strip at bottom with collapse button -->
          <div class="thumbnail-strip-container">
            <button 
              class="thumbnail-collapse-btn"
              @click="isThumbnailStripCollapsed = !isThumbnailStripCollapsed"
              :title="isThumbnailStripCollapsed ? 'Show participants' : 'Hide participants'"
            >
              <Icon :name="isThumbnailStripCollapsed ? 'chevron-up' : 'chevron-down'" />
            </button>
            <div v-if="!isThumbnailStripCollapsed" class="thumbnail-strip">
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
                  muted: voiceStore.localState.isMuted,
                  'ptt-mode': isPTTMode,
                  'ptt-active': isPTTActive
                }"
                :title="isPTTMode 
                  ? (isPTTActive ? `Transmitting (${pttKeyDisplay})` : `Push ${pttKeyDisplay} to talk`) 
                  : (voiceStore.localState.isMuted ? 'Unmute (M)' : 'Mute (M)')"
              >
                <Icon :name="voiceStore.localState.isMuted ? 'mic-off' : 'mic'" />
                <span v-if="isPTTMode" class="ptt-badge" :class="{ active: isPTTActive }">PTT</span>
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
                <Icon :name="voiceStore.localState.isVideoEnabled && !voiceStore.localState.isScreenSharing ? 'video-off' : 'video'" />
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
          @update-settings="handleSettingsUpdate"
        />
      </div>
    </Teleport>

    <!-- Spatial Audio Panel -->
    <SpatialAudioPanel 
      :is-under-overlay="true"
    />

    <!-- Confetti Effect -->
    <ConfettiEffect 
      :is-active="easterEggState.isActive && easterEggState.type === 'rainbow-party'"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useSpatialAudioStore } from '@/stores/spatialAudio';
import { useAdaptiveGrid } from '@/composables/useAdaptiveGrid';
import { useKeybinds } from '@/composables/useKeybinds';
import { debug } from '@/utils/debug';
import { useKonamiCode } from '@/composables/useKonamiCode';
import { easterEggService, type EasterEggState } from '@/services/EasterEggService';
import { useAuthStore } from '@/stores/auth';
import UnifiedVoiceUserCard from './UnifiedVoiceUserCard.vue';
import VoiceSettingsPanel from './VoiceSettingsPanel.vue';
import SpatialAudioPanel from './SpatialAudioPanel.vue';
import DeviceSelector from './DeviceSelector.vue';
import VoiceEncryptionBadge from './VoiceEncryptionBadge.vue';
import ConfettiEffect from '../easteregg/ConfettiEffect.vue';
import Icon from '@/components/common/Icon.vue';
import DisplayName from '@/components/DisplayName.vue';

// Centralized keybind system
const keybinds = useKeybinds();
const isPTTMode = keybinds.isPTTMode;
const isPTTActive = keybinds.isPTTActive;
const pttKeyDisplay = computed(() => keybinds.getKeybindDisplay('push-to-talk'));

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
const authStore = useAuthStore();
const isEntering = ref(false);
const isLeaving = ref(false);
const showSettings = ref(false);
const isThumbnailStripCollapsed = ref(false);

// Easter egg state
const easterEggState = ref<EasterEggState>({
  isActive: false,
  type: null,
  activatedBy: null,
  activatedAt: null,
});

// Full window mode is now in the store
const isFullWindowMode = computed(() => voiceStore.isFullWindowMode);

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
    
    // Track previous screenshare state to detect when it stops
    const previousScreenShareState = ref<boolean | null>(null);
    
    // =============================================================================
    // WATCHERS
    // =============================================================================
    
    // Watch for fullscreen participant's video/screenshare state changes
    // Exit fullscreen when the user stops sharing their screen or disables video
    watch(
      () => fullscreenParticipant.value,
      (participant, _oldParticipant) => {
        if (!participant) {
          // Fullscreen participant left or not found - exit fullscreen immediately
          if (voiceStore.viewMode === 'fullscreen' && voiceStore.fullscreenUserId) {
            debug.log('🖼️ [Fullscreen] Participant gone, exiting fullscreen');
            voiceStore.exitFullscreen();
          }
          previousScreenShareState.value = null;
          return;
        }
        
        const hasVideoOrScreenshare = participant.isVideoEnabled || participant.isScreenSharing;
        const hadVideoOrScreenshare = previousScreenShareState.value;
        
        // If they had video/screenshare and now don't, exit fullscreen immediately
        if (hadVideoOrScreenshare === true && !hasVideoOrScreenshare) {
          debug.log('🖼️ [Fullscreen] No more video/screenshare, exiting fullscreen');
          voiceStore.exitFullscreen();
        }
        
        // Update previous state
        previousScreenShareState.value = hasVideoOrScreenshare;
      },
      { deep: true, immediate: true }
    );

    // Watch the store's streamUpdateCounter for any stream changes affecting fullscreen user
    // This provides a backup trigger in case the deep watch misses something
    watch(
      () => voiceStore.streamUpdateCounter,
      () => {
        if (voiceStore.viewMode !== 'fullscreen' || !voiceStore.fullscreenUserId) return;
        
        // Re-check if fullscreen participant still has video/screenshare
        const participant = fullscreenParticipant.value;
        if (participant && !participant.isVideoEnabled && !participant.isScreenSharing) {
          debug.log('🖼️ [Fullscreen] Stream update detected - no video, exiting fullscreen');
          voiceStore.exitFullscreen();
        }
      }
    );

    // Specifically watch for the fullscreen user's screenshare state
    // This is the most direct way to catch screenshare stopping
    watch(
      [() => voiceStore.fullscreenUserId, () => voiceStore.allUsers],
      ([userId, allUsers]) => {
        if (voiceStore.viewMode !== 'fullscreen' || !userId) return;
        
        // Find the user in allUsers
        const user = allUsers.find((u: any) => u.userId === userId);
        
        // If user exists but has no video/screenshare, exit fullscreen
        if (user && !user.isVideoEnabled && !user.isScreenSharing) {
          debug.log('🖼️ [Fullscreen] User has no video/screenshare, exiting');
          voiceStore.exitFullscreen();
        }
      },
      { deep: true }
    );

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
    
    const handleSettingsUpdate = (event: { type: string; value: any }) => {
      switch (event.type) {
        case 'streamQuality':
          // Update stream quality in the voice store
          voiceStore.updateStreamQuality(event.value);
          break;
        case 'saveAll':
          // Save all settings including stream quality
          if (event.value.videoQuality || event.value.frameRate || event.value.audioBitrate) {
            const qualityToResolution: Record<string, number> = {
              '360p': 360,
              '480p': 480,
              '720p': 720,
              '1080p': 1080,
              'source': -1,
            };
            voiceStore.updateStreamQuality({
              resolution: qualityToResolution[event.value.videoQuality] ?? 720,
              frameRate: parseInt(event.value.frameRate) || 30,
              audioBitrate: parseInt(event.value.audioBitrate) || 128
            });
          }
          break;
        // Other event types can be handled here if needed
      }
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
    
    // Konami code and easter egg
    const konamiEnabled = ref(true)
    let konamiDetector: ReturnType<typeof useKonamiCode> | null = null
    
    const handleKonamiActivate = () => {
      // Don't activate if konami is disabled or game is already active
      if (!konamiEnabled.value || easterEggState.value.isActive) {
        return
      }
      
      // Only activate if 2+ participants are in the call
      // if (connectionStats.value.total < 2) {
      //   debug.log('🎮 [Konami] Not enough participants (need 2+, have', connectionStats.value.total, ')')
      //   return
      // }

      const currentUserId = voiceStore.localState.userId || authStore.session?.user?.id
      if (!currentUserId) {
        debug.warn('🎮 [Konami] No user ID available')
        return
      }

      debug.log('🎮 [Konami] Activating rainbow party!')
      konamiEnabled.value = false // Disable konami code detection
      
      // Stop konami code detector
      if (konamiDetector) {
        konamiDetector.reset()
      }
      
      easterEggService.activate('rainbow-party', currentUserId)
      
      // Auto-deactivate after confetti duration (10 seconds default)
      setTimeout(() => {
        easterEggService.deactivate()
      }, 10000)
      
      // No auto-deactivate - users can close manually with X button
    }
    
    // Reset konami flag when rainbow party closes
    watch(() => easterEggState.value.isActive, (isActive) => {
      if (!isActive && easterEggState.value.type === 'rainbow-party') {
        konamiEnabled.value = true // Re-enable konami code detection
        // Reset the existing konami detector (don't recreate - composables must be called at top level)
        if (konamiDetector) {
          konamiDetector.reset()
        }
        debug.log('🎮 [Konami] Rainbow party closed, re-enabling konami code detection')
      }
    })

    // Initialize easter egg service when channel changes
    const initializeEasterEgg = () => {
      const channelId = voiceStore.currentChannelId || voiceStore.optimisticChannelId
      if (channelId) {
        const currentUserId = voiceStore.localState.userId || authStore.session?.user?.id
        if (currentUserId) {
          easterEggService.initialize(channelId, currentUserId)
          
          // Subscribe to easter egg state changes (only once)
          if (!easterEggState.value.activatedBy) {
            easterEggService.subscribe((state) => {
              easterEggState.value = state
            })
          }
        }
      }
    }

    // Watch for channel changes
    watch(
      () => voiceStore.currentChannelId || voiceStore.optimisticChannelId,
      () => {
        initializeEasterEgg()
      },
      { immediate: true }
    )

    // Konami code detector
    konamiDetector = useKonamiCode(handleKonamiActivate)

    onMounted(() => {
      isEntering.value = true;
      setTimeout(() => {
        isEntering.value = false;
      }, 300);
      
      // Activate voice-overlay context for keybinds
      keybinds.activateContext('voice-overlay');
      
      // Register keybind handlers
      // Note: toggleMute already handles PTT mode check internally
      keybinds.registerHandler('toggle-mute', () => voiceStore.toggleMute());
      keybinds.registerHandler('toggle-deafen', () => voiceStore.toggleDeafen());
      keybinds.registerHandler('toggle-camera', () => voiceStore.toggleVideo());
      keybinds.registerHandler('toggle-screenshare', () => voiceStore.toggleScreenShare());
      keybinds.registerHandler('toggle-voice-settings', () => toggleSettings());
      keybinds.registerHandler('exit-fullscreen', () => {
        // Priority order: full-window mode > fullscreen > settings > minimize
        if (voiceStore.isFullWindowMode) {
          voiceStore.toggleFullWindowMode();
        } else if (voiceStore.viewMode === 'fullscreen') {
          voiceStore.exitFullscreen();
        } else if (showSettings.value) {
          showSettings.value = false;
        } else {
          minimizeOverlay();
        }
      });
    });
    
    onUnmounted(() => {
      // Deactivate context and unregister handlers
      keybinds.deactivateContext('voice-overlay');
      keybinds.unregisterHandler('toggle-mute');
      keybinds.unregisterHandler('toggle-deafen');
      keybinds.unregisterHandler('toggle-camera');
      keybinds.unregisterHandler('toggle-screenshare');
      keybinds.unregisterHandler('toggle-voice-settings');
      keybinds.unregisterHandler('exit-fullscreen');
      
      // Cleanup easter egg service
      easterEggService.cleanup();
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
  /* background: rgba(0, 0, 0, 0.5); */
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
  /* background: linear-gradient(145deg, var(--background-tertiary), var(--background-secondary)); */
  background: linear-gradient(145deg, color-mix(in srgb, var(--background-tertiary) 39%, transparent), color-mix(in srgb, var(--background-secondary) 35%, transparent));
  backdrop-filter: blur(20px);
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
  /* background: linear-gradient(145deg, var(--background-secondary), var(--background-tertiary)); */
  background: linear-gradient(145deg, color-mix(in srgb, var(--background-secondary) 21%, transparent), color-mix(in srgb, var(--background-tertiary) 19%, transparent));
  /* backdrop-filter: blur(20px); */
}

/* Connection Mode Indicator - Inline with header controls */
.connection-mode-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.connection-mode-indicator.livekit {
  background: rgba(87, 242, 135, 0.15);
  color: #57f287;
  border: 1px solid rgba(87, 242, 135, 0.3);
}

.connection-mode-indicator.p2p {
  background: rgba(14, 165, 233, 0.15);
  color: #0EA5E9;
  border: 1px solid rgba(14, 165, 233, 0.3);
}

.connection-mode-indicator.unknown {
  background: rgba(255, 255, 255, 0.1);
  color: #b9bbbe;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.connection-mode-indicator :deep(span) {
  display: flex;
}

.connection-mode-indicator :deep(svg) {
  width: 12px;
  height: 12px;
}

.channel-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.channel-icon {
  width: 40px;
  height: 40px;
  background: linear-gradient(145deg, #0EA5E9, #0284C7);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
  font-size: 18px;
}

.channel-name {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
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
  color: var(--text-primary);
  border-color: rgba(255, 255, 255, 0.3);
}

.layout-btn.active {
  background: linear-gradient(145deg, #0EA5E9, #0284C7);
  color: var(--text-primary);
  border-color: rgba(14, 165, 233, 0.6);
}

/* Spatial audio button with indicator */
.spatial-btn {
  position: relative;
}

.spatial-btn.spatial-enabled {
  background: linear-gradient(145deg, #00d4aa, #00b894);
  color: var(--text-primary);
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
  color: var(--text-primary);
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
  min-height: 0;
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
  max-width: 640px;
  max-height: 480px;
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
  /* background: linear-gradient(145deg, var(--background-tertiary), var(--background-secondary)); */
  background: linear-gradient(145deg, color-mix(in srgb, var(--background-tertiary) 39%, transparent), color-mix(in srgb, var(--background-secondary) 35%, transparent));
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
  color: var(--text-primary);
  border-color: rgba(255, 255, 255, 0.4);
  transform: scale(1.05);
}

.control-button.active {
  background: linear-gradient(145deg, #00d4aa, #00b894);
  color: var(--text-primary);
  border-color: rgba(0, 212, 170, 0.6);
  box-shadow: 0 4px 16px rgba(0, 212, 170, 0.3);
}

.control-button.muted {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: var(--text-primary);
  border-color: rgba(237, 66, 69, 0.6);
  box-shadow: 0 4px 16px rgba(237, 66, 69, 0.3);
}

/* PTT Mode Styles */
.control-button.ptt-mode {
  position: relative;
}

.control-button.ptt-active {
  background: linear-gradient(145deg, #00d4aa, #00b894) !important;
  color: var(--text-primary) !important;
  border-color: rgba(0, 212, 170, 0.6) !important;
  box-shadow: 0 4px 16px rgba(0, 212, 170, 0.4), 0 0 20px rgba(0, 212, 170, 0.3) !important;
  animation: ptt-transmit 0.5s ease-in-out infinite;
}

@keyframes ptt-transmit {
  0%, 100% {
    box-shadow: 0 4px 16px rgba(0, 212, 170, 0.4), 0 0 20px rgba(0, 212, 170, 0.3);
  }
  50% {
    box-shadow: 0 4px 20px rgba(0, 212, 170, 0.6), 0 0 30px rgba(0, 212, 170, 0.4);
  }
}

.ptt-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  font-size: 9px;
  font-weight: 700;
  padding: 2px 5px;
  background: rgba(0, 0, 0, 0.7);
  color: #888;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.ptt-badge.active {
  background: #00d4aa;
  color: var(--text-primary);
}

.control-button.deafened {
  background: linear-gradient(145deg, #faa61a, #e67e22);
  color: var(--text-primary);
  border-color: rgba(250, 166, 26, 0.6);
  box-shadow: 0 4px 16px rgba(250, 166, 26, 0.3);
}

.leave-button {
  background: linear-gradient(145deg, #ed4245, #c73e1d);
  color: var(--text-primary);
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
  padding: 0!important;
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
  max-width: 100%;
  max-height: none;
  min-height: 200px;
  margin: 0 auto;
}

.fullscreen-card :deep(.video-stream) {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* User info label overlay in fullscreen - positioned at bottom left corner */
.fullscreen-card :deep(.user-info) {
  position: absolute;
  bottom: 8px;
  left: 8px;
  width: auto !important; /* Override default width: 100% */
  background: rgba(0, 0, 0, 0.7);
  padding: 4px 12px;
  border-radius: 4px;
  backdrop-filter: blur(4px);
  z-index: 5;
  text-align: left;
  margin: 0;
  top: auto; /* Reset top positioning */
}

.fullscreen-card :deep(.avatar-container) {
  display: none; /* Hide avatar when video is showing */
}

/* Thumbnail strip container with collapse button */
.thumbnail-strip-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
}

.thumbnail-collapse-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 20px;
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px 4px 0 0;
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  transition: all 0.2s ease;
  margin-bottom: -1px;
}

.thumbnail-collapse-btn:hover {
  background: rgba(0, 0, 0, 0.7);
  color: var(--text-primary);
}

/* Compact thumbnail strip at bottom - Discord style */
.thumbnail-strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 4px;
  max-height: 128px;
  flex-shrink: 0;
}

.thumbnail-card {
  flex-shrink: 0;
  width: 120px;
  min-height: 120px!important;
  max-height: 120px!important;
}

.thumbnail-card :deep(.harmony-voice-card) {
  min-height: 80px;
  padding: 4px;
}

.thumbnail-card :deep(.video-container) {
  max-height: 60px;
  max-width: 100%;
  margin-bottom: 2px;
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

/* ============================================
   MOBILE RESPONSIVE STYLES
   ============================================ */

/* Tablet landscape */
@media (max-width: 768px) {
  .voice-overlay {
    padding: 8px;
    padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
  }
  
  .voice-container {
    max-width: 100%;
    max-height: 100%;
    border-radius: 16px;
  }
  
  .voice-header {
    padding: 12px 16px;
    flex-wrap: wrap;
    gap: 12px;
  }
  
  .channel-info {
    flex: 1;
    min-width: 0;
  }
  
  .channel-icon {
    width: 36px;
    height: 36px;
    font-size: 16px;
  }
  
  .channel-name {
    font-size: 16px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .participant-count {
    font-size: 12px;
  }
  
  /* Hide connection mode text on tablet */
  .connection-mode-indicator span {
    display: none;
  }
  
  .connection-mode-indicator {
    padding: 6px;
  }
  
  .header-controls {
    gap: 6px;
  }
  
  .layout-btn,
  .minimize-btn,
  .close-btn {
    width: 40px;
    height: 40px;
    font-size: 16px;
  }
  
  /* Hide spatial badge text on tablet */
  .spatial-badge {
    font-size: 7px;
    padding: 1px 3px;
  }
  
  .participants-container {
    padding: 12px 16px;
    min-height: 200px;
  }
  
  .participants-grid {
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 10px;
  }
  
  .voice-controls {
    padding: 12px 16px;
    padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
    flex-wrap: wrap;
    gap: 12px;
  }
  
  .media-controls {
    gap: 8px;
    flex-wrap: wrap;
    justify-content: center;
  }
  
  .control-button {
    width: 48px;
    height: 48px;
    font-size: 18px;
  }
  
  .leave-button {
    padding: 10px 20px;
    font-size: 13px;
  }
  
  /* Fullscreen adjustments */
  .fullscreen-container {
    padding: 8px;
  }
  
  .thumbnail-strip {
    gap: 6px;
    max-height: 100px;
  }
  
  .thumbnail-card {
    width: 90px;
    min-height: 90px !important;
    max-height: 90px !important;
  }
}

/* Mobile portrait */
@media (max-width: 480px) {
  .voice-overlay {
    padding: 0;
    align-items: stretch;
  }
  
  .voice-container {
    border-radius: 0;
    max-height: 100vh;
    height: 100%;
  }
  
  .voice-header {
    padding: 12px;
    border-radius: 0;
  }
  
  .channel-icon {
    width: 32px;
    height: 32px;
    font-size: 14px;
  }
  
  .channel-details {
    gap: 2px;
  }
  
  .channel-name {
    font-size: 15px;
  }
  
  .participant-count {
    font-size: 11px;
  }
  
  .speaking-count {
    display: none;
  }
  
  .header-controls {
    gap: 4px;
  }
  
  /* Show layout toggle buttons on mobile */
  .layout-btn[title="Grid view"],
  .layout-btn[title="Speaker view"] {
    display: flex;
    width: 36px;
    height: 36px;
    font-size: 14px;
  }
  
  /* Hide maximize button on mobile */
  .layout-btn[title="Maximize"],
  .minimize-btn {
    display: none;
  }
  
  .layout-btn.spatial-btn,
  .close-btn {
    width: 36px;
    height: 36px;
    font-size: 14px;
  }
  
  /* Show settings button */
  .layout-btn[title="Voice Settings"] {
    display: flex;
  }
  
  .participants-container {
    padding: 8px 12px;
    min-height: 150px;
  }
  
  .participants-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }
  
  .participants-grid.grid-single {
    grid-template-columns: 1fr;
  }
  
  .participants-grid.grid-duo {
    grid-template-columns: 1fr;
    grid-auto-rows: minmax(180px, auto);
  }
  
  .participants-grid.grid-quad {
    grid-template-columns: repeat(2, 1fr);
    grid-auto-rows: minmax(160px, auto);
  }
  
  .participants-grid.grid-six {
    grid-template-columns: repeat(3, 1fr);
    grid-auto-rows: minmax(140px, auto);
  }
  
  .participants-grid.grid-nine,
  .participants-grid.grid-large,
  .participants-grid.grid-gallery {
    grid-template-columns: repeat(3, 1fr);
    grid-auto-rows: minmax(120px, auto);
  }
  
  .featured-card {
    min-height: 200px;
  }
  
  .featured-speaker {
    padding: 8px;
  }
  
  /* Voice controls - bottom sheet style */
  .voice-controls {
    padding: 12px;
    padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    flex-direction: column;
    gap: 12px;
    background: linear-gradient(145deg, #2a2d35, #1e2028);
  }
  
  .media-controls {
    width: 100%;
    justify-content: center;
    gap: 10px;
  }
  
  .control-group {
    flex-direction: column;
    gap: 2px;
  }
  
  .control-button {
    width: 52px;
    height: 52px;
    font-size: 20px;
  }
  
  .action-controls {
    width: 100%;
  }
  
  .leave-button {
    width: 100%;
    justify-content: center;
    padding: 14px 24px;
    font-size: 14px;
    border-radius: 12px;
  }
  
  /* PTT badge adjustments */
  .ptt-badge {
    font-size: 8px;
    padding: 1px 4px;
  }
  
  /* Fullscreen on mobile */
  .fullscreen-container {
    padding: 4px;
  }
  
  .thumbnail-strip-container {
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  
  .thumbnail-strip {
    gap: 4px;
    max-height: 80px;
    padding: 2px;
  }
  
  .thumbnail-card {
    width: 70px;
    min-height: 70px !important;
    max-height: 70px !important;
  }
  
  .thumbnail-card :deep(.video-container) {
    max-height: 45px;
  }
  
  .thumbnail-card :deep(.username) {
    font-size: 9px;
  }
}

/* Very small mobile screens */
@media (max-width: 360px) {
  .voice-header {
    padding: 10px;
  }
  
  .channel-info {
    gap: 8px;
  }
  
  .channel-icon {
    width: 28px;
    height: 28px;
    font-size: 12px;
  }
  
  .channel-name {
    font-size: 14px;
  }
  
  .header-controls {
    gap: 3px;
  }
  
  .layout-btn.spatial-btn,
  .close-btn {
    width: 32px;
    height: 32px;
    font-size: 12px;
  }
  
  .participants-grid {
    grid-template-columns: 1fr;
    gap: 6px;
  }
  
  .media-controls {
    gap: 8px;
  }
  
  .control-button {
    width: 48px;
    height: 48px;
    font-size: 18px;
  }
  
  .leave-button {
    padding: 12px 20px;
    font-size: 13px;
  }
  
  .thumbnail-card {
    width: 60px;
    min-height: 60px !important;
    max-height: 60px !important;
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
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
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

/* Mobile settings wrapper */
@media (max-width: 480px) {
  .settings-overlay-wrapper {
    padding: 0;
    align-items: stretch;
  }
  
  .settings-overlay-wrapper :deep(.settings-panel) {
    width: 100%;
    max-width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
  }
}

/* Full Window Mode - Stream fills entire viewport */
.fullscreen-container.full-window-mode {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  padding: 0 !important;
  margin: 0 !important;
  z-index: 10002;
  background: #000;
  cursor: pointer;
}

.fullscreen-container.full-window-mode .fullscreen-card {
  width: 100% !important;
  height: 100% !important;
  max-height: none !important;
  border-radius: 0 !important;
}

.fullscreen-container.full-window-mode .fullscreen-card :deep(.video-container) {
  max-width: 100%;
  max-height: 100%;
  border-radius: 0;
}

.fullscreen-container.full-window-mode .fullscreen-card :deep(.user-info) {
  display: none !important;
}

.fullscreen-container.full-window-mode .thumbnail-strip-container {
  display: none !important;
}

/* ============================================
   EASTER EGG: RAINBOW PARTY MODE
   ============================================ */

.voice-container.rainbow-party {
  animation: rainbow-border 3s linear infinite;
  box-shadow: 
    0 20px 60px rgba(0, 0, 0, 0.6),
    0 8px 32px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.1),
    0 0 40px rgba(255, 0, 150, 0.5);
}

.voice-container.rainbow-party .participant-card {
  animation: rainbow-glow 2s ease-in-out infinite;
}

.voice-container.rainbow-party .participant-card :deep(.harmony-voice-card) {
  border: 3px solid;
  border-image: linear-gradient(
    45deg,
    #ff6b6b,
    #4ecdc4,
    #45b7d1,
    #f9ca24,
    #f0932b,
    #eb4d4b,
    #6c5ce7,
    #a29bfe
  ) 1;
  animation: rainbow-border-rotate 3s linear infinite;
  box-shadow: 0 0 20px rgba(255, 0, 150, 0.6);
}

.voice-container.screen-shake {
  animation: screen-shake 0.5s ease-in-out;
}

/* Remove screen shake after animation completes */
.voice-container.screen-shake {
  animation-fill-mode: forwards;
}

@keyframes rainbow-border {
  0% {
    border-color: #ff6b6b;
    box-shadow: 
      0 20px 60px rgba(0, 0, 0, 0.6),
      0 8px 32px rgba(0, 0, 0, 0.4),
      0 0 40px rgba(255, 107, 107, 0.5);
  }
  14% {
    border-color: #4ecdc4;
    box-shadow: 
      0 20px 60px rgba(0, 0, 0, 0.6),
      0 8px 32px rgba(0, 0, 0, 0.4),
      0 0 40px rgba(78, 205, 196, 0.5);
  }
  28% {
    border-color: #45b7d1;
    box-shadow: 
      0 20px 60px rgba(0, 0, 0, 0.6),
      0 8px 32px rgba(0, 0, 0, 0.4),
      0 0 40px rgba(69, 183, 209, 0.5);
  }
  42% {
    border-color: #f9ca24;
    box-shadow: 
      0 20px 60px rgba(0, 0, 0, 0.6),
      0 8px 32px rgba(0, 0, 0, 0.4),
      0 0 40px rgba(249, 202, 36, 0.5);
  }
  57% {
    border-color: #f0932b;
    box-shadow: 
      0 20px 60px rgba(0, 0, 0, 0.6),
      0 8px 32px rgba(0, 0, 0, 0.4),
      0 0 40px rgba(240, 147, 43, 0.5);
  }
  71% {
    border-color: #eb4d4b;
    box-shadow: 
      0 20px 60px rgba(0, 0, 0, 0.6),
      0 8px 32px rgba(0, 0, 0, 0.4),
      0 0 40px rgba(235, 77, 75, 0.5);
  }
  85% {
    border-color: #6c5ce7;
    box-shadow: 
      0 20px 60px rgba(0, 0, 0, 0.6),
      0 8px 32px rgba(0, 0, 0, 0.4),
      0 0 40px rgba(108, 92, 231, 0.5);
  }
  100% {
    border-color: #a29bfe;
    box-shadow: 
      0 20px 60px rgba(0, 0, 0, 0.6),
      0 8px 32px rgba(0, 0, 0, 0.4),
      0 0 40px rgba(162, 155, 254, 0.5);
  }
}

@keyframes rainbow-glow {
  0%, 100% {
    filter: brightness(1) saturate(1);
    transform: scale(1);
  }
  50% {
    filter: brightness(1.2) saturate(1.3);
    transform: scale(1.02);
  }
}

@keyframes rainbow-border-rotate {
  0% {
    border-image-source: linear-gradient(0deg, #ff6b6b, #4ecdc4, #45b7d1, #f9ca24);
  }
  25% {
    border-image-source: linear-gradient(90deg, #f0932b, #eb4d4b, #6c5ce7, #a29bfe);
  }
  50% {
    border-image-source: linear-gradient(180deg, #ff6b6b, #4ecdc4, #45b7d1, #f9ca24);
  }
  75% {
    border-image-source: linear-gradient(270deg, #f0932b, #eb4d4b, #6c5ce7, #a29bfe);
  }
  100% {
    border-image-source: linear-gradient(360deg, #ff6b6b, #4ecdc4, #45b7d1, #f9ca24);
  }
}

@keyframes screen-shake {
  0%, 100% {
    transform: translate(0, 0);
  }
  10% {
    transform: translate(-2px, -2px);
  }
  20% {
    transform: translate(2px, 2px);
  }
  30% {
    transform: translate(-2px, 2px);
  }
  40% {
    transform: translate(2px, -2px);
  }
  50% {
    transform: translate(-1px, -1px);
  }
  60% {
    transform: translate(1px, 1px);
  }
  70% {
    transform: translate(-1px, 1px);
  }
  80% {
    transform: translate(1px, -1px);
  }
  90% {
    transform: translate(0, 0);
  }
}
</style>