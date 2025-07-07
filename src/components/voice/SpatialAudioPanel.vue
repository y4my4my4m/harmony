<template>
  <div 
    v-if="spatialStore.isPanelVisible" 
    class="spatial-audio-panel"
    :class="{ 'panel-under-overlay': isUnderOverlay, 'panel-under-dock': isUnderDock }"
  >
    <!-- Panel Header -->
    <div class="panel-header">
      <div class="header-left">
        <div class="panel-icon">
          <Icon name="map" />
        </div>
        <div class="panel-title">
          <h3>Spatial Audio</h3>
          <p>{{ allParticipants.length }} participant{{ allParticipants.length !== 1 ? 's' : '' }}</p>
        </div>
      </div>
      
      <div class="header-controls">
        <!-- Spatial Audio Toggle -->
        <button
          @click="spatialStore.toggleSpatialAudio()"
          :class="['control-btn', 'toggle-btn', { active: spatialStore.settings.enabled }]"
          :title="spatialStore.settings.enabled ? 'Disable Spatial Audio' : 'Enable Spatial Audio'"
        >
          <Icon :name="spatialStore.settings.enabled ? 'volume-spatial' : 'volume-off'" />
          <span>{{ spatialStore.settings.enabled ? 'ON' : 'OFF' }}</span>
        </button>
        
        <!-- Settings -->
        <button
          @click="toggleSettings"
          :class="['control-btn', 'settings-btn', { active: showSettings }]"
          title="Spatial Audio Settings"
        >
          <Icon name="settings" />
        </button>
        
        <!-- Close Panel -->
        <button
          @click="spatialStore.hidePanel()"
          class="control-btn close-btn"
          title="Close Panel"
        >
          <Icon name="x" />
        </button>
      </div>
    </div>

    <!-- Settings Panel (Collapsible) -->
    <div v-if="showSettings" class="settings-panel">
      <div class="settings-grid">
        <div class="setting-group">
          <label>Max Distance</label>
          <input
            v-model.number="localSettings.maxDistance"
            type="range"
            min="50"
            max="500"
            step="10"
            @input="updateSettings"
            class="range-input"
          />
          <span class="setting-value">{{ localSettings.maxDistance }}px</span>
        </div>
        
        <div class="setting-group">
          <label>Rolloff Factor</label>
          <input
            v-model.number="localSettings.rolloffFactor"
            type="range"
            min="0.1"
            max="3"
            step="0.1"
            @input="updateSettings"
            class="range-input"
          />
          <span class="setting-value">{{ localSettings.rolloffFactor }}</span>
        </div>
        
        <div class="setting-group">
          <label>Distance Model</label>
          <select v-model="localSettings.distanceModel" @change="updateSettings" class="select-input">
            <option value="linear">Linear</option>
            <option value="inverse">Inverse</option>
            <option value="exponential">Exponential</option>
          </select>
        </div>
        
        <div class="setting-group">
          <label>Panning Model</label>
          <select v-model="localSettings.panningModel" @change="updateSettings" class="select-input">
            <option value="equalpower">Equal Power</option>
            <option value="HRTF">HRTF</option>
          </select>
        </div>
        
        <div class="setting-group checkbox-group">
          <label class="checkbox-label">
            <input
              v-model="localSettings.enableReverb"
              type="checkbox"
              @change="updateSettings"
              class="checkbox-input"
            />
            <span class="checkbox-custom"></span>
            Enable Reverb
          </label>
        </div>
        
        <div v-if="localSettings.enableReverb" class="setting-group">
          <label>Room Size</label>
          <input
            v-model.number="localSettings.roomSize"
            type="range"
            min="0.1"
            max="2"
            step="0.1"
            @input="updateSettings"
            class="range-input"
          />
          <span class="setting-value">{{ localSettings.roomSize }}</span>
        </div>
      </div>
    </div>

    <!-- Main Grid Area -->
    <div 
      ref="gridContainer"
      class="spatial-grid"
      @mousedown="handleGridMouseDown"
      @mousemove="handleGridMouseMove"
      @mouseup="handleGridMouseUp"
      @mouseleave="handleGridMouseUp"
    >
      <!-- Background Grid Pattern -->
      <div class="grid-background"></div>
      
      <!-- Center Indicator -->
      <div class="center-indicator">
        <div class="center-dot"></div>
        <span class="center-label">Center</span>
      </div>
      
      <!-- User Avatars -->
      <div 
        v-for="participant in allParticipants"
        :key="participant.userId"
        class="spatial-avatar"
        :class="{
          'is-self': participant.userId === currentUserId,
          'is-speaking': isSpeaking(participant),
          'is-dragging': spatialStore.draggedUserId === participant.userId,
          'spatial-disabled': !spatialStore.settings.enabled
        }"
        :style="getAvatarStyle(participant.userId)"
        @mousedown="handleAvatarMouseDown($event, participant.userId)"
        @contextmenu.prevent="handleAvatarRightClick($event, participant.userId)"
      >
        <!-- Avatar Image -->
        <div class="avatar-container">
          <img
            :src="getUserProfile(participant.userId)?.avatar_url || '/default_avatar.png'"
            :alt="getUserProfile(participant.userId)?.display_name || 'User'"
            class="avatar-image"
            draggable="false"
          />
          
          <!-- Speaking Ring -->
          <div v-if="isSpeaking(participant)" class="speaking-ring"></div>
          
          <!-- Self Indicator -->
          <div v-if="participant.userId === currentUserId" class="self-indicator">
            <Icon name="user" />
          </div>
        </div>
        
        <!-- Username Label -->
        <div class="username-label">
          {{ getUserProfile(participant.userId)?.display_name || getUserProfile(participant.userId)?.username || 'Unknown' }}
        </div>
        
        <!-- Distance Indicator (to self) -->
        <div 
          v-if="participant.userId !== currentUserId && spatialStore.settings.enabled"
          class="distance-indicator"
        >
          {{ Math.round(getDistanceToSelf(participant.userId)) }}px
        </div>
      </div>
      
      <!-- Distance Lines (when dragging) -->
      <svg 
        v-if="spatialStore.isDragging && spatialStore.settings.enabled"
        class="distance-lines"
        :width="gridSize.width"
        :height="gridSize.height"
      >
        <g v-for="participant in otherParticipants" :key="participant.userId">
          <line
            :x1="getSelfPosition().x"
            :y1="getSelfPosition().y"
            :x2="getPosition(participant.userId).x"
            :y2="getPosition(participant.userId).y"
            class="distance-line"
            :style="{ opacity: getDistanceOpacity(participant.userId) }"
          />
          <text
            :x="(getSelfPosition().x + getPosition(participant.userId).x) / 2"
            :y="(getSelfPosition().y + getPosition(participant.userId).y) / 2"
            class="distance-text"
            text-anchor="middle"
            dy="-5"
          >
            {{ Math.round(getDistanceToUser(currentUserId, participant.userId)) }}px
          </text>
        </g>
      </svg>
    </div>
    
    <!-- Panel Footer -->
    <div class="panel-footer">
      <div class="footer-info">
        <span v-if="spatialStore.settings.enabled" class="status-enabled">
          <Icon name="check-circle" />
          Spatial Audio Active
        </span>
        <span v-else class="status-disabled">
          <Icon name="circle" />
          Spatial Audio Disabled
        </span>
      </div>
      
      <div class="footer-actions">
        <button
          @click="resetAllPositions"
          class="action-btn reset-btn"
          title="Reset All Positions"
        >
          <Icon name="refresh" />
          Reset
        </button>
        
        <button
          @click="randomizePositions"
          class="action-btn randomize-btn"
          title="Randomize Positions"
        >
          <Icon name="shuffle" />
          Randomize
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useSpatialAudioStore } from '@/stores/spatialAudio';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useAuthStore } from '@/stores/auth';
import { spatialAudioService } from '@/services/spatialAudio';
import Icon from '@/components/common/Icon.vue';

// =============================================================================
// PROPS & EMITS
// =============================================================================

interface Props {
  isUnderOverlay?: boolean;
  isUnderDock?: boolean;
}

withDefaults(defineProps<Props>(), {
  isUnderOverlay: false,
  isUnderDock: false
});

// =============================================================================
// STORES & STATE
// =============================================================================

const spatialStore = useSpatialAudioStore();
const voiceStore = useUnifiedVoiceChannelStore();
const authStore = useAuthStore();

const gridContainer = ref<HTMLElement | null>(null);
const showSettings = ref(false);
const gridSize = ref({ width: 600, height: 400 });

// Local settings for smooth updates
const localSettings = ref({ ...spatialStore.settings });

// =============================================================================
// COMPUTED PROPERTIES
// =============================================================================

const currentUserId = computed(() => authStore.session?.user?.id || '');

const allParticipants = computed(() => voiceStore.allParticipants);

const otherParticipants = computed(() => 
  allParticipants.value.filter(p => p.userId !== currentUserId.value)
);

// =============================================================================
// POSITION MANAGEMENT
// =============================================================================

const getPosition = (userId: string) => {
  const position = spatialStore.getUserPosition(userId);
  if (position) return position;
  
  // Initialize user if not positioned
  spatialStore.initializeUserPosition(userId);
  return spatialStore.getUserPosition(userId) || { x: 0, y: 0 };
};

const getSelfPosition = () => {
  return getPosition(currentUserId.value);
};

const getAvatarStyle = (userId: string) => {
  const position = getPosition(userId);
  return {
    transform: `translate(${position.x - 25}px, ${position.y - 25}px)`,
    zIndex: spatialStore.draggedUserId === userId ? 1000 : 1
  };
};

const getDistanceToSelf = (userId: string): number => {
  return spatialStore.getDistanceBetween(currentUserId.value, userId);
};

const getDistanceToUser = (userId1: string, userId2: string): number => {
  return spatialStore.getDistanceBetween(userId1, userId2);
};

const getDistanceOpacity = (userId: string): number => {
  const distance = getDistanceToSelf(userId);
  const maxDistance = spatialStore.settings.maxDistance;
  return Math.max(0.2, 1 - (distance / maxDistance));
};

// =============================================================================
// USER INTERACTION
// =============================================================================

const isSpeaking = (participant: any): boolean => {
  return participant.isSpeaking || (participant.audioLevel > 20 && !participant.isMuted);
};

const getUserProfile = (userId: string) => {
  return voiceStore.getUserProfile(userId);
};

// =============================================================================
// DRAG & DROP
// =============================================================================

const handleAvatarMouseDown = (event: MouseEvent, userId: string) => {
  event.preventDefault();
  event.stopPropagation();
  
  const rect = gridContainer.value?.getBoundingClientRect();
  if (!rect) return;
  
  const startX = event.clientX - rect.left;
  const startY = event.clientY - rect.top;
  
  spatialStore.startDrag(userId, startX, startY);
};

const handleGridMouseDown = (event: MouseEvent) => {
  // Only handle if clicking on empty grid (not on avatar)
  if ((event.target as HTMLElement).closest('.spatial-avatar')) return;
  
  // Could implement creating new position markers here in the future
};

const handleGridMouseMove = (event: MouseEvent) => {
  if (!spatialStore.isDragging) return;
  
  const rect = gridContainer.value?.getBoundingClientRect();
  if (!rect) return;
  
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  
  spatialStore.updateDrag(x, y);
  
  // Update spatial audio in real-time
  if (spatialStore.settings.enabled) {
    spatialAudioService.updateSpatialEffects();
  }
};

const handleGridMouseUp = () => {
  if (spatialStore.isDragging) {
    spatialStore.endDrag();
  }
};

const handleAvatarRightClick = (event: MouseEvent, userId: string) => {
  // Could show context menu for avatar-specific actions
  console.log('Right clicked on user:', userId);
};

// =============================================================================
// PANEL ACTIONS
// =============================================================================

const toggleSettings = () => {
  showSettings.value = !showSettings.value;
};

const updateSettings = () => {
  spatialStore.updateSettings(localSettings.value);
  
  if (spatialStore.settings.enabled) {
    spatialAudioService.updateSettings();
    spatialAudioService.updateSpatialEffects();
  }
};

const resetAllPositions = () => {
  allParticipants.value.forEach(participant => {
    spatialStore.initializeUserPosition(participant.userId);
  });
  
  if (spatialStore.settings.enabled) {
    spatialAudioService.updateSpatialEffects();
  }
};

const randomizePositions = () => {
  allParticipants.value.forEach(participant => {
    spatialStore.removeUserPosition(participant.userId);
    spatialStore.initializeUserPosition(participant.userId);
  });
  
  if (spatialStore.settings.enabled) {
    spatialAudioService.updateSpatialEffects();
  }
};

// =============================================================================
// LIFECYCLE & WATCHERS
// =============================================================================

const updateGridSize = () => {
  if (gridContainer.value) {
    const rect = gridContainer.value.getBoundingClientRect();
    gridSize.value = { width: rect.width, height: rect.height };
    spatialStore.setPanelSize(rect.width, rect.height);
  }
};

// Watch for spatial audio toggle
watch(() => spatialStore.settings.enabled, (enabled) => {
  if (enabled) {
    spatialAudioService.enableSpatialAudio();
  } else {
    spatialAudioService.disableSpatialAudio();
  }
});

// Initialize positions for new participants
watch(() => allParticipants.value, (newParticipants, oldParticipants) => {
  const oldIds = new Set(oldParticipants?.map(p => p.userId) || []);
  
  newParticipants.forEach(participant => {
    if (!oldIds.has(participant.userId)) {
      spatialStore.initializeUserPosition(participant.userId);
    }
  });
  
  // Remove positions for users who left
  const newIds = new Set(newParticipants.map(p => p.userId));
  oldParticipants?.forEach(participant => {
    if (!newIds.has(participant.userId)) {
      spatialStore.removeUserPosition(participant.userId);
    }
  });
}, { deep: true });

onMounted(() => {
  nextTick(() => {
    updateGridSize();
    
    // Initialize positions for current participants
    allParticipants.value.forEach(participant => {
      spatialStore.initializeUserPosition(participant.userId);
    });
    
    window.addEventListener('resize', updateGridSize);
  });
});

onUnmounted(() => {
  window.removeEventListener('resize', updateGridSize);
  spatialStore.endDrag();
});
</script>

<style scoped>
.spatial-audio-panel {
  position: fixed;
  background: linear-gradient(145deg, #1e1f22, #2b2d31);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  box-shadow: 
    0 20px 60px rgba(0, 0, 0, 0.6),
    0 8px 32px rgba(0, 0, 0, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(20px);
  width: 600px;
  height: 500px;
  z-index: 10500;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.panel-under-overlay {
  bottom: 20px;
  left: 0;
  right: 0;
  margin: 0 auto;
  /* right: 20px; */
}

.panel-under-dock {
  bottom: 180px;
  right: -25px;
}

/* Panel Header */
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  background: linear-gradient(145deg, #2b2d31, #1e1f22);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.panel-icon {
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

.panel-title h3 {
  margin: 0;
  color: #ffffff;
  font-size: 16px;
  font-weight: 600;
}

.panel-title p {
  margin: 0;
  color: #b5bac1;
  font-size: 12px;
}

.header-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.control-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: #b5bac1;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 12px;
  font-weight: 500;
}

.control-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.2);
}

.control-btn.active {
  background: linear-gradient(145deg, #5865f2, #4752c4);
  color: white;
  border-color: rgba(88, 101, 242, 0.6);
}

.toggle-btn.active {
  background: linear-gradient(145deg, #00d4aa, #00b894);
  border-color: rgba(0, 212, 170, 0.6);
}

.close-btn:hover {
  background: #ed4245;
  color: white;
  border-color: #ed4245;
}

/* Settings Panel */
.settings-panel {
  padding: 16px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(0, 0, 0, 0.2);
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
}

.setting-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.setting-group label {
  color: #b5bac1;
  font-size: 12px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.range-input {
  appearance: none;
  width: 100%;
  height: 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  outline: none;
}

.range-input::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  background: #5865f2;
  border-radius: 50%;
  cursor: pointer;
}

.select-input {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: #ffffff;
  padding: 6px 8px;
  font-size: 12px;
}

.setting-value {
  color: #ffffff;
  font-size: 12px;
  font-weight: 500;
}

.checkbox-group {
  flex-direction: row;
  align-items: center;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: #b5bac1;
  font-size: 12px;
}

.checkbox-input {
  appearance: none;
  width: 16px;
  height: 16px;
}

.checkbox-custom {
  width: 16px;
  height: 16px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  position: relative;
}

.checkbox-input:checked + .checkbox-custom {
  background: #5865f2;
  border-color: #5865f2;
}

.checkbox-input:checked + .checkbox-custom::after {
  content: '✓';
  position: absolute;
  color: white;
  font-size: 10px;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

/* Main Grid */
.spatial-grid {
  flex: 1;
  position: relative;
  overflow: hidden;
  cursor: crosshair;
}

.grid-background {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-image: 
    linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
  background-size: 20px 20px;
}

.center-indicator {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  pointer-events: none;
}

.center-dot {
  width: 8px;
  height: 8px;
  background: rgba(255, 255, 255, 0.4);
  border-radius: 50%;
}

.center-label {
  color: rgba(255, 255, 255, 0.3);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* User Avatars */
.spatial-avatar {
  position: absolute;
  width: 50px;
  height: 50px;
  cursor: grab;
  transition: all 0.2s ease;
  user-select: none;
}

.spatial-avatar:hover {
  transform: scale(1.1);
  z-index: 10 !important;
}

.spatial-avatar.is-dragging {
  cursor: grabbing;
  transform: scale(1.2);
  filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.6));
}

.spatial-avatar.spatial-disabled {
  opacity: 0.6;
  filter: grayscale(50%);
}

.avatar-container {
  position: relative;
  width: 50px;
  height: 50px;
}

.avatar-image {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid rgba(255, 255, 255, 0.2);
  transition: all 0.2s ease;
}

.spatial-avatar.is-self .avatar-image {
  border-color: #5865f2;
  box-shadow: 0 0 20px rgba(88, 101, 242, 0.4);
}

.spatial-avatar.is-speaking .avatar-image {
  border-color: #00d4aa;
  box-shadow: 0 0 20px rgba(0, 212, 170, 0.6);
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

.self-indicator {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 18px;
  height: 18px;
  background: #5865f2;
  border: 2px solid #1e1f22;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 10px;
}

.username-label {
  position: absolute;
  top: 55px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.8);
  color: white;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  white-space: nowrap;
  pointer-events: none;
  backdrop-filter: blur(10px);
}

.distance-indicator {
  position: absolute;
  top: -8px;
  right: -8px;
  background: rgba(88, 101, 242, 0.9);
  color: white;
  padding: 2px 4px;
  border-radius: 8px;
  font-size: 8px;
  font-weight: 600;
  min-width: 20px;
  text-align: center;
  pointer-events: none;
}

/* Distance Lines */
.distance-lines {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 0;
}

.distance-line {
  stroke: rgba(88, 101, 242, 0.4);
  stroke-width: 1;
  stroke-dasharray: 3, 3;
}

.distance-text {
  fill: rgba(255, 255, 255, 0.7);
  font-size: 10px;
  font-weight: 600;
}

/* Panel Footer */
.panel-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  background: linear-gradient(145deg, #1e1f22, #2b2d31);
}

.footer-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.status-enabled {
  color: #00d4aa;
  display: flex;
  align-items: center;
  gap: 4px;
}

.status-disabled {
  color: #b5bac1;
  display: flex;
  align-items: center;
  gap: 4px;
}

.footer-actions {
  display: flex;
  gap: 8px;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: #b5bac1;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 11px;
}

.action-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.2);
}

/* Animations */
@keyframes pulse-ring {
  0% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.1); opacity: 0.7; }
  100% { transform: scale(1.2); opacity: 0; }
}

/* Responsive */
@media (max-width: 768px) {
  .spatial-audio-panel {
    width: calc(100vw - 40px);
    height: calc(100vh - 100px);
    bottom: 20px;
    left: 20px;
    right: 20px;
  }
  
  .settings-grid {
    grid-template-columns: 1fr;
  }
}
</style>
