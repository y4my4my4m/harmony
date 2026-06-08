<template>
  <div 
    v-if="spatialStore.isPanelVisible" 
    class="spatial-audio-panel"
    :class="{ 
      'panel-under-overlay': isUnderOverlay && !panelPosition, 
      'panel-under-dock': isUnderDock && !panelPosition,
      'panel-dragging': isPanelDragging
    }"
    :style="getPanelStyle()"
  >
    <!-- Panel Header (drag handle) -->
    <div 
      class="panel-header"
      @mousedown="handlePanelDragStart"
      @touchstart.passive="handlePanelTouchStart"
    >
      <div class="header-left">
        <div class="panel-icon">
          <Icon name="audio-lines" />
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
      @touchstart.passive="handleGridTouchStart"
      @touchmove.prevent="handleGridTouchMove"
      @touchend="handleGridTouchEnd"
      @touchcancel="handleGridTouchEnd"
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
        @touchstart.prevent="handleAvatarTouchStart($event, participant.userId)"
        @contextmenu.prevent="handleAvatarRightClick($event, participant.userId)"
      >
        <!-- Avatar Image -->
        <div class="avatar-container">
          <Avatar
            :src="getUserProfile(participant.userId)?.avatar_url || '/default_avatar.webp'"
            :alt="getUserProfile(participant.userId)?.display_name || 'User'"
            class="avatar-image"
            draggable="false"
          />
          
          <!-- Speaking Ring -->
          <div v-if="isSpeaking(participant)" class="speaking-ring"></div>
        </div>
        
        <!-- Username Label -->
        <div class="username-label">
          <DisplayName :userId="participant.userId" />
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
        <span v-if="showUpdatedMessage" class="status-updated">
          <Icon name="check-circle" />
          Updated!
        </span>
        <span v-else-if="isUpdatingSpatialAudio" class="status-updating">
          <Icon name="refresh" />
          Updating Audio...
        </span>
        <span v-else-if="spatialStore.settings.enabled" class="status-enabled">
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
import { debug } from '@/utils/debug'
import { useEventListener } from '@vueuse/core';
import { useSpatialAudioStore } from '@/stores/spatialAudio';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useAuthStore } from '@/stores/auth';
import { useUserData } from '@/composables/useUserData';
import { spatialAudioService } from '@/services/spatialAudio';
import Icon from '@/components/common/Icon.vue';
import Avatar from '../common/Avatar.vue';
import DisplayName from '@/components/DisplayName.vue';

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
const { getUserProfile: getUnifiedUserProfile, ensureProfilesAvailable } = useUserData();

const gridContainer = ref<HTMLElement | null>(null);
const showSettings = ref(false);
const gridSize = ref({ width: 600, height: 400 });
const isUpdatingSpatialAudio = ref(false);
const showUpdatedMessage = ref(false);

// --- Panel dragging state ---
const panelPosition = ref<{ x: number; y: number } | null>(null);
const isPanelDragging = ref(false);
let panelDragStartPos = { x: 0, y: 0 };
let panelDragInitialPos = { x: 0, y: 0 };
const PANEL_CLICK_THRESHOLD = 5;

function getPanelStyle() {
  if (!panelPosition.value) return {};
  return {
    left: `${panelPosition.value.x}px`,
    bottom: `${panelPosition.value.y}px`,
    right: 'auto',
    margin: '0',
  };
}

function handlePanelDragStart(e: MouseEvent) {
  if ((e.target as HTMLElement).closest('.control-btn')) return;
  e.preventDefault();
  
  const panelEl = (e.target as HTMLElement).closest('.spatial-audio-panel') as HTMLElement;
  if (!panelEl) return;
  
  const rect = panelEl.getBoundingClientRect();
  const currentX = rect.left;
  const currentY = window.innerHeight - rect.bottom;
  
  panelDragStartPos = { x: e.clientX, y: e.clientY };
  panelDragInitialPos = { x: currentX, y: currentY };
  isPanelDragging.value = false;
  
  const onMove = (ev: MouseEvent) => {
    const dx = ev.clientX - panelDragStartPos.x;
    const dy = ev.clientY - panelDragStartPos.y;
    
    if (!isPanelDragging.value && Math.abs(dx) + Math.abs(dy) > PANEL_CLICK_THRESHOLD) {
      isPanelDragging.value = true;
    }
    
    if (isPanelDragging.value) {
      panelPosition.value = {
        x: Math.max(0, panelDragInitialPos.x + dx),
        y: Math.max(0, panelDragInitialPos.y - dy),
      };
    }
  };
  
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    isPanelDragging.value = false;
  };
  
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function handlePanelTouchStart(e: TouchEvent) {
  if ((e.target as HTMLElement).closest('.control-btn')) return;
  
  const touch = e.touches[0];
  if (!touch) return;
  
  const panelEl = (e.target as HTMLElement).closest('.spatial-audio-panel') as HTMLElement;
  if (!panelEl) return;
  
  const rect = panelEl.getBoundingClientRect();
  const currentX = rect.left;
  const currentY = window.innerHeight - rect.bottom;
  
  panelDragStartPos = { x: touch.clientX, y: touch.clientY };
  panelDragInitialPos = { x: currentX, y: currentY };
  isPanelDragging.value = false;
  
  const onTouchMove = (ev: TouchEvent) => {
    const t = ev.touches[0];
    if (!t) return;
    const dx = t.clientX - panelDragStartPos.x;
    const dy = t.clientY - panelDragStartPos.y;
    
    if (!isPanelDragging.value && Math.abs(dx) + Math.abs(dy) > PANEL_CLICK_THRESHOLD) {
      isPanelDragging.value = true;
    }
    
    if (isPanelDragging.value) {
      ev.preventDefault();
      panelPosition.value = {
        x: Math.max(0, panelDragInitialPos.x + dx),
        y: Math.max(0, panelDragInitialPos.y - dy),
      };
    }
  };
  
  const onTouchEnd = () => {
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onTouchEnd);
    isPanelDragging.value = false;
  };
  
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onTouchEnd);
}

// Local visual positions for smooth dragging (separate from store)
const localVisualPositions = ref<Map<string, { x: number, y: number }>>(new Map());

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
  // During drag, use local visual position for smooth movement
  if (spatialStore.isDragging && localVisualPositions.value.has(userId)) {
    return localVisualPositions.value.get(userId)!;
  }
  
  // Otherwise use store position
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
  const profile = getUnifiedUserProfile(userId).value;
  return profile || {
    id: userId,
    username: 'Unknown User',
    display_name: 'Unknown User',
    avatar_url: null
  };
};

// =============================================================================
// DRAG & DROP
// =============================================================================

// Debounce timer for spatial audio updates during drag
let spatialUpdateTimer: number | null = null;
let settingsUpdateTimer: number | null = null;
const SPATIAL_UPDATE_INTERVAL = 100; // Update every 100ms while dragging
const SETTINGS_UPDATE_DELAY = 300; // Delay settings updates by 300ms

const handleAvatarMouseDown = (event: MouseEvent, userId: string) => {
  event.preventDefault();
  event.stopPropagation();
  
  const rect = gridContainer.value?.getBoundingClientRect();
  if (!rect) return;
  
  const startX = event.clientX - rect.left;
  const startY = event.clientY - rect.top;
  
  spatialStore.startDrag(userId, startX, startY);
  
  // Start debounced spatial audio updates
  if (spatialStore.settings.enabled) {
    startSpatialUpdateTimer();
  }
};

const handleGridMouseDown = (event: MouseEvent) => {
  // Only handle if clicking on empty grid (not on avatar)
  if ((event.target as HTMLElement).closest('.spatial-avatar')) return;
  
  // Could implement creating new position markers here in the future
};

const handleGridMouseMove = (event: MouseEvent) => {
  if (!spatialStore.isDragging || !spatialStore.draggedUserId) return;
  
  const rect = gridContainer.value?.getBoundingClientRect();
  if (!rect) return;
  
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  
  // Calculate new position with bounds checking
  const dragOffset = spatialStore.dragOffset;
  const newX = Math.max(20, Math.min(rect.width - 20, x - dragOffset.x));
  const newY = Math.max(20, Math.min(rect.height - 20, y - dragOffset.y));
  
  // Update LOCAL visual position immediately for 60fps smooth movement
  localVisualPositions.value.set(spatialStore.draggedUserId, { x: newX, y: newY });
  
  // Store position is updated by the debounced timer or on release
};

const handleGridMouseUp = () => {
  if (spatialStore.isDragging && spatialStore.draggedUserId) {
    // Stop the debounced timer
    stopSpatialUpdateTimer();
    
    // Sync local visual position to store
    const localPos = localVisualPositions.value.get(spatialStore.draggedUserId);
    if (localPos) {
      spatialStore.setUserPosition(spatialStore.draggedUserId, localPos.x, localPos.y);
      localVisualPositions.value.delete(spatialStore.draggedUserId);
    }
    
    // Final spatial audio update on release
    if (spatialStore.settings.enabled) {
      spatialAudioService.updateSpatialEffects();
      
      // Show brief "updated" message
      showUpdatedMessage.value = true;
      setTimeout(() => {
        showUpdatedMessage.value = false;
      }, 1500);
    }
    
    spatialStore.endDrag();
  }
};

// =============================================================================
// TOUCH EVENT HANDLERS (Mobile support)
// =============================================================================

const handleAvatarTouchStart = (event: TouchEvent, userId: string) => {
  // Prevent sidebar swipe gestures from interfering
  event.stopPropagation();
  
  const touch = event.touches[0];
  if (!touch) return;
  
  const rect = gridContainer.value?.getBoundingClientRect();
  if (!rect) return;
  
  const startX = touch.clientX - rect.left;
  const startY = touch.clientY - rect.top;
  
  spatialStore.startDrag(userId, startX, startY);
  
  // Start debounced spatial audio updates
  if (spatialStore.settings.enabled) {
    startSpatialUpdateTimer();
  }
};

const handleGridTouchStart = (event: TouchEvent) => {
  // Prevent sidebar gestures when touching the grid
  event.stopPropagation();
};

const handleGridTouchMove = (event: TouchEvent) => {
  if (!spatialStore.isDragging || !spatialStore.draggedUserId) return;
  
  const touch = event.touches[0];
  if (!touch) return;
  
  const rect = gridContainer.value?.getBoundingClientRect();
  if (!rect) return;
  
  const x = touch.clientX - rect.left;
  const y = touch.clientY - rect.top;
  
  // Calculate new position with bounds checking
  const dragOffset = spatialStore.dragOffset;
  const newX = Math.max(20, Math.min(rect.width - 20, x - dragOffset.x));
  const newY = Math.max(20, Math.min(rect.height - 20, y - dragOffset.y));
  
  // Update LOCAL visual position immediately for smooth movement
  localVisualPositions.value.set(spatialStore.draggedUserId, { x: newX, y: newY });
};

const handleGridTouchEnd = () => {
  // Reuse the same logic as mouse up
  handleGridMouseUp();
};

const startSpatialUpdateTimer = () => {
  if (spatialUpdateTimer) return;
  
  isUpdatingSpatialAudio.value = true;
  
  spatialUpdateTimer = window.setInterval(() => {
    if (spatialStore.isDragging && spatialStore.settings.enabled && spatialStore.draggedUserId) {
      // Sync local visual position to store for spatial audio calculations
      const localPos = localVisualPositions.value.get(spatialStore.draggedUserId);
      if (localPos) {
        spatialStore.setUserPosition(spatialStore.draggedUserId, localPos.x, localPos.y);
      }
      
      // Update spatial audio effects
      spatialAudioService.updateSpatialEffects();
    }
  }, SPATIAL_UPDATE_INTERVAL);
};

const stopSpatialUpdateTimer = () => {
  if (spatialUpdateTimer) {
    clearInterval(spatialUpdateTimer);
    spatialUpdateTimer = null;
    isUpdatingSpatialAudio.value = false;
  }
};

const stopSettingsUpdateTimer = () => {
  if (settingsUpdateTimer) {
    clearTimeout(settingsUpdateTimer);
    settingsUpdateTimer = null;
  }
};

const handleAvatarRightClick = (event: MouseEvent, userId: string) => {
  // Could show context menu for avatar-specific actions
  debug.log('Right clicked on user:', userId);
};

// =============================================================================
// PANEL ACTIONS
// =============================================================================

const toggleSettings = () => {
  showSettings.value = !showSettings.value;
};

const updateSettings = () => {
  // Clear existing timer
  if (settingsUpdateTimer) {
    clearTimeout(settingsUpdateTimer);
  }
  
  // Update settings immediately for UI responsiveness
  spatialStore.updateSettings(localSettings.value);
  
  // Debounce the spatial audio updates
  settingsUpdateTimer = window.setTimeout(() => {
    if (spatialStore.settings.enabled) {
      spatialAudioService.updateSettings();
      spatialAudioService.updateSpatialEffects();
    }
  }, SETTINGS_UPDATE_DELAY);
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

useEventListener(window, 'resize', updateGridSize);

// Watch for spatial audio toggle
watch(() => spatialStore.settings.enabled, (enabled) => {
  if (enabled) {
    spatialAudioService.enableSpatialAudio();
  } else {
    spatialAudioService.disableSpatialAudio();
  }
});

// Track participant IDs to detect joins/leaves without deep watching
let previousParticipantIds = new Set<string>();

// Initialize positions for new participants (watch by user ID string to avoid deep watching)
watch(
  () => allParticipants.value.map(p => p.userId).sort().join(','),
  () => {
    const currentIds = new Set(allParticipants.value.map(p => p.userId));
    
    // Initialize positions for new participants
    currentIds.forEach(userId => {
      if (!previousParticipantIds.has(userId)) {
        spatialStore.initializeUserPosition(userId);
      }
    });
    
    // Remove positions for users who left
    previousParticipantIds.forEach(userId => {
      if (!currentIds.has(userId)) {
        spatialStore.removeUserPosition(userId);
      }
    });
    
    previousParticipantIds = currentIds;
  }
);

// Track loaded user IDs to avoid repeated fetches
const loadedProfileIds = new Set<string>();

// Ensure all participant profiles are loaded when participants change
watch(
  () => allParticipants.value.map(p => p.userId).join(','),
  async (userIdsString) => {
    const userIds = userIdsString.split(',').filter(id => id && !loadedProfileIds.has(id));
    if (userIds.length > 0) {
      try {
        await ensureProfilesAvailable(userIds);
        userIds.forEach(id => loadedProfileIds.add(id));
        debug.log('✅ Loaded profiles for spatial audio participants:', userIds.length);
      } catch (error) {
        debug.warn('⚠️ Failed to load profiles for spatial audio participants:', error);
      }
    }
  },
  { immediate: true }
);

onMounted(() => {
  nextTick(() => {
    updateGridSize();
    
    // Initialize positions for current participants
    allParticipants.value.forEach(participant => {
      spatialStore.initializeUserPosition(participant.userId);
    });
    
  });
});

onUnmounted(() => {
  stopSpatialUpdateTimer();
  stopSettingsUpdateTimer();
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

.spatial-audio-panel.panel-dragging {
  transition: none;
  user-select: none;
}

/* Panel Header */
.panel-header {
  cursor: grab;
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
  background: linear-gradient(145deg, #0EA5E9, #0284C7);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
  font-size: 18px;
}

.panel-title h3 {
  margin: 0;
  color: var(--text-primary);
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
  color: var(--text-primary);
  border-color: rgba(255, 255, 255, 0.2);
}

.control-btn.active {
  background: linear-gradient(145deg, #0EA5E9, #0284C7);
  color: var(--text-primary);
  border-color: rgba(14, 165, 233, 0.6);
}

.toggle-btn.active {
  background: linear-gradient(145deg, #00d4aa, #00b894);
  border-color: rgba(0, 212, 170, 0.6);
}

.close-btn:hover {
  background: #ed4245;
  color: var(--text-primary);
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
  background: var(--harmony-primary);
  border-radius: 50%;
  cursor: pointer;
}

.select-input {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: var(--text-primary);
  padding: 6px 8px;
  font-size: 12px;
}

.setting-value {
  color: var(--text-primary);
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
  position: absolute;
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
  background: var(--harmony-primary);
  border-color: #0EA5E9;
}

.checkbox-input:checked + .checkbox-custom::after {
  content: '✓';
  position: absolute;
  color: var(--text-primary);
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
  transition: filter 0.2s ease, opacity 0.2s ease; /* Don't animate transform for smooth dragging */
  user-select: none;
}

.spatial-avatar:not(.is-dragging):hover {
  transition: all 0.2s ease; /* Re-enable transition for hover when not dragging */
  transform: scale(1.1);
  z-index: 10 !important;
}

.spatial-avatar.is-dragging {
  cursor: grabbing;
  transform: scale(1.2);
  filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.6));
  transition: transform 0.1s ease, filter 0.1s ease; /* Only animate scale and filter, not position */
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
  border-color: #0EA5E9;
  box-shadow: 0 0 20px rgba(14, 165, 233, 0.4);
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

.username-label {
  position: absolute;
  top: 55px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.8);
  color: var(--text-primary);
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
  background: rgba(14, 165, 233, 0.9);
  color: var(--text-primary);
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
  stroke: rgba(14, 165, 233, 0.4);
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

.status-updating {
  color: #ffa500;
  display: flex;
  align-items: center;
  gap: 4px;
  animation: pulse-updating 1.5s infinite;
}

.status-updated {
  color: #00d4aa;
  display: flex;
  align-items: center;
  gap: 4px;
  animation: fade-in-out 1.5s ease-in-out;
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
  color: var(--text-primary);
  border-color: rgba(255, 255, 255, 0.2);
}

/* Animations */
@keyframes pulse-ring {
  0% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.1); opacity: 0.7; }
  100% { transform: scale(1.2); opacity: 0; }
}

@keyframes pulse-updating {
  0% { opacity: 1; }
  50% { opacity: 0.6; }
  100% { opacity: 1; }
}

@keyframes fade-in-out {
  0% { opacity: 0; transform: translateY(5px); }
  20% { opacity: 1; transform: translateY(0); }
  80% { opacity: 1; transform: translateY(0); }
  100% { opacity: 0; transform: translateY(-5px); }
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

/* Mobile - Full screen spatial panel */
@media (max-width: 480px) {
  .spatial-audio-panel {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
    z-index: 10001;
  }
  
  .panel-header {
    padding: 12px 16px;
    padding-top: calc(12px + env(safe-area-inset-top, 0px));
    flex-wrap: wrap;
    gap: 10px;
  }
  
  .header-left {
    flex: 1;
    min-width: 0;
  }
  
  .panel-title h3 {
    font-size: 16px;
  }
  
  .panel-title p {
    font-size: 11px;
  }
  
  .header-controls {
    gap: 6px;
  }
  
  .control-btn {
    padding: 8px 12px;
    min-width: 44px;
    min-height: 44px;
  }
  
  /* Grid area fills available space with touch support */
  .spatial-grid {
    flex: 1;
    touch-action: none; /* Prevent browser gestures */
    -webkit-user-select: none;
    user-select: none;
  }
  
  /* Larger avatars for touch */
  .spatial-avatar {
    width: 56px;
    height: 56px;
    touch-action: none; /* Prevent scroll/zoom on avatar drag */
  }
  
  .avatar-container {
    width: 56px;
    height: 56px;
  }
  
  .avatar-image {
    width: 48px;
    height: 48px;
  }
  
  .username-label {
    top: 60px;
    font-size: 11px;
    padding: 3px 8px;
  }
  
  /* Settings panel takes more space */
  .settings-panel {
    padding: 16px;
    max-height: 50vh;
    overflow-y: auto;
  }
  
  .settings-grid {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  
  .setting-group label {
    font-size: 13px;
  }
  
  .range-input {
    height: 8px;
  }
  
  .range-input::-webkit-slider-thumb {
    width: 24px;
    height: 24px;
  }
  
  .range-input::-moz-range-thumb {
    width: 24px;
    height: 24px;
  }
  
  .select-input {
    padding: 12px;
    font-size: 16px; /* Prevent iOS zoom */
  }
  
  /* Footer adjustments */
  .panel-footer {
    padding: 12px 16px;
    padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
    flex-wrap: wrap;
    gap: 10px;
  }
  
  .footer-info {
    font-size: 11px;
    flex: 1;
  }
  
  .footer-actions {
    gap: 6px;
  }
  
  .action-btn {
    padding: 10px 14px;
    font-size: 12px;
    min-height: 44px;
  }
}
</style>