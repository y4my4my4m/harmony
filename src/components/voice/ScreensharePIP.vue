<template>
  <Teleport to="body">
    <!-- Native PIP (uses browser API) - no visual component needed -->
    
    <!-- Fixed Corner PIP -->
    <div 
      v-if="voiceStore.pipActive && voiceStore.pipMode === 'fixed' && pipParticipant"
      class="pip-fixed"
      :class="{ minimized: isMinimized }"
    >
      <div class="pip-header">
        <span class="pip-title"><DisplayName v-if="pipParticipant" :userId="pipParticipant.userId" :fallback="participantName" :truncate="true" /></span>
        <div class="pip-controls">
          <button @click="toggleMinimize" class="pip-btn" title="Minimize">
            <Icon :name="isMinimized ? 'maximize-2' : 'minimize-2'" />
          </button>
          <button @click="closePIP" class="pip-btn" title="Close">
            <Icon name="x" />
          </button>
        </div>
      </div>
      <div v-if="!isMinimized" class="pip-video-container">
        <video
          ref="fixedVideoElement"
          autoplay
          playsinline
          class="pip-video"
        />
      </div>
    </div>

    <!-- Draggable PIP -->
    <div 
      v-if="voiceStore.pipActive && voiceStore.pipMode === 'draggable' && pipParticipant"
      class="pip-draggable"
      :style="draggableStyle"
      @mousedown="startDrag"
    >
      <div class="pip-header" @mousedown.stop="startDrag">
        <span class="pip-title"><DisplayName v-if="pipParticipant" :userId="pipParticipant.userId" :fallback="participantName" :truncate="true" /></span>
        <div class="pip-controls">
          <button @click="toggleMinimize" class="pip-btn" title="Minimize">
            <Icon :name="isMinimized ? 'maximize-2' : 'minimize-2'" />
          </button>
          <button @click="closePIP" class="pip-btn" title="Close">
            <Icon name="x" />
          </button>
        </div>
      </div>
      <div v-if="!isMinimized" class="pip-video-container">
        <video
          ref="draggableVideoElement"
          autoplay
          playsinline
          class="pip-video"
        />
        <!-- Resize handle -->
        <div 
          class="resize-handle" 
          @mousedown.stop="startResize"
          title="Drag to resize"
        ></div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { debug } from '@/utils/debug'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useUserData } from '@/composables/useUserData';
import Icon from '@/components/common/Icon.vue';
import DisplayName from '@/components/DisplayName.vue';

const voiceStore = useUnifiedVoiceChannelStore();
const { getUserDisplayName } = useUserData();

// Refs
const fixedVideoElement = ref<HTMLVideoElement | null>(null);
const draggableVideoElement = ref<HTMLVideoElement | null>(null);
const isMinimized = ref(false);

// Draggable state
const position = ref({ x: window.innerWidth - 420, y: window.innerHeight - 320 });
const size = ref({ width: 400, height: 300 });
const isDragging = ref(false);
const isResizing = ref(false);
const dragStart = ref({ x: 0, y: 0 });
const resizeStart = ref({ x: 0, y: 0, width: 0, height: 0 });

// Computed
const pipParticipant = computed(() => {
  if (!voiceStore.pipUserId) return null;
  return voiceStore.allParticipants.find(p => p.userId === voiceStore.pipUserId) || null;
});

const pipStream = computed(() => {
  if (!voiceStore.pipUserId) return null;
  return voiceStore.getUserStream(voiceStore.pipUserId);
});

const participantName = computed(() => {
  if (!pipParticipant.value) return 'Screen Share';
  return getUserDisplayName(pipParticipant.value.userId).value || 'User';
});

const draggableStyle = computed(() => ({
  left: `${position.value.x}px`,
  top: `${position.value.y}px`,
  width: isMinimized.value ? 'auto' : `${size.value.width}px`,
  height: isMinimized.value ? 'auto' : `${size.value.height}px`,
}));

// Methods
const closePIP = () => {
  voiceStore.togglePIP(null);
};

const toggleMinimize = () => {
  isMinimized.value = !isMinimized.value;
};

// Draggable functionality
const startDrag = (event: MouseEvent) => {
  isDragging.value = true;
  dragStart.value = {
    x: event.clientX - position.value.x,
    y: event.clientY - position.value.y,
  };
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', stopDrag);
};

const onDrag = (event: MouseEvent) => {
  if (!isDragging.value) return;
  
  position.value = {
    x: Math.max(0, Math.min(window.innerWidth - size.value.width, event.clientX - dragStart.value.x)),
    y: Math.max(0, Math.min(window.innerHeight - size.value.height, event.clientY - dragStart.value.y)),
  };
};

const stopDrag = () => {
  isDragging.value = false;
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', stopDrag);
};

// Resizable functionality
const startResize = (event: MouseEvent) => {
  isResizing.value = true;
  resizeStart.value = {
    x: event.clientX,
    y: event.clientY,
    width: size.value.width,
    height: size.value.height,
  };
  document.addEventListener('mousemove', onResize);
  document.addEventListener('mouseup', stopResize);
};

const onResize = (event: MouseEvent) => {
  if (!isResizing.value) return;
  
  const deltaX = event.clientX - resizeStart.value.x;
  const deltaY = event.clientY - resizeStart.value.y;
  
  size.value = {
    width: Math.max(300, Math.min(1920, resizeStart.value.width + deltaX)),
    height: Math.max(200, Math.min(1080, resizeStart.value.height + deltaY)),
  };
};

const stopResize = () => {
  isResizing.value = false;
  document.removeEventListener('mousemove', onResize);
  document.removeEventListener('mouseup', stopResize);
};

// Handle native PIP mode
watch(() => [voiceStore.pipActive, voiceStore.pipMode, pipStream.value], async ([active, mode, stream]) => {
  if (active && mode === 'native' && stream) {
    // Use browser's native PIP API
    try {
      const videoEl = document.createElement('video');
      videoEl.srcObject = stream as MediaStream;
      videoEl.autoplay = true;
      videoEl.muted = false;
      
      // Wait for video to load
      await new Promise(resolve => {
        videoEl.addEventListener('loadedmetadata', resolve, { once: true });
      });
      
      // Enter PIP mode
      if (document.pictureInPictureEnabled && !document.pictureInPictureElement) {
        await videoEl.requestPictureInPicture();
        
        // Listen for PIP close
        videoEl.addEventListener('leavepictureinpicture', () => {
          voiceStore.togglePIP(null);
          videoEl.srcObject = null;
          videoEl.remove();
        }, { once: true });
      }
    } catch (error) {
      debug.error('Failed to enter native PIP:', error);
      // Fall back to fixed mode
      voiceStore.togglePIP(voiceStore.pipUserId, 'fixed');
    }
  }
}, { immediate: true });

// Attach video to fixed PIP element using LiveKit's proper method
// Watch streamUpdateCounter to react to stream changes
watch(
  [() => voiceStore.pipActive, () => voiceStore.pipMode, () => voiceStore.pipUserId, fixedVideoElement, () => voiceStore.streamUpdateCounter],
  ([active, mode, userId, videoEl, _counter]) => {
    if (active && mode === 'fixed' && userId && videoEl) {
      const attached = voiceStore.attachVideoToElement(userId, videoEl as any);
      if (!attached && pipStream.value) {
        // Fallback to srcObject if attach fails
        (videoEl as HTMLVideoElement).srcObject = pipStream.value;
      }
    }
  },
  { immediate: true }
);

// Attach video to draggable PIP element using LiveKit's proper method
// Watch streamUpdateCounter to react to stream changes
watch(
  [() => voiceStore.pipActive, () => voiceStore.pipMode, () => voiceStore.pipUserId, draggableVideoElement, () => voiceStore.streamUpdateCounter],
  ([active, mode, userId, videoEl, _counter]) => {
    if (active && mode === 'draggable' && userId && videoEl) {
      const attached = voiceStore.attachVideoToElement(userId, videoEl as any);
      if (!attached && pipStream.value) {
        // Fallback to srcObject if attach fails
        (videoEl as HTMLVideoElement).srcObject = pipStream.value;
      }
    }
  },
  { immediate: true }
);

// Cleanup
onUnmounted(() => {
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', stopDrag);
  document.removeEventListener('mousemove', onResize);
  document.removeEventListener('mouseup', stopResize);
});
</script>

<style scoped>
/* Fixed Corner PIP */
.pip-fixed {
  position: fixed;
  bottom: 80px;
  right: 20px;
  width: 400px;
  background: linear-gradient(145deg, var(--background-tertiary), var(--background-secondary));
  border-radius: 12px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  z-index: 10000;
  overflow: hidden;
  transition: all 0.3s ease;
}

.pip-fixed.minimized {
  width: 300px;
}

/* Draggable PIP */
.pip-draggable {
  position: fixed;
  background: linear-gradient(145deg, var(--background-tertiary), var(--background-secondary));
  border-radius: 12px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  z-index: 10000;
  overflow: hidden;
  min-width: 300px;
  min-height: 200px;
}

.pip-draggable .pip-header {
  cursor: move;
}

/* Common PIP styles */
.pip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.3);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.pip-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
  user-select: none;
}

.pip-controls {
  display: flex;
  gap: 4px;
}

.pip-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.pip-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.pip-video-container {
  position: relative;
  width: 100%;
  height: 300px;
  background: #000;
}

.pip-draggable .pip-video-container {
  height: calc(100% - 42px);
}

.pip-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

/* Resize handle */
.resize-handle {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 20px;
  height: 20px;
  cursor: nwse-resize;
  background: linear-gradient(135deg, transparent 50%, rgba(255, 255, 255, 0.3) 50%);
  border-bottom-right-radius: 12px;
}

.resize-handle:hover {
  background: linear-gradient(135deg, transparent 50%, rgba(255, 255, 255, 0.5) 50%);
}

/* Responsive */
@media (max-width: 768px) {
  .pip-fixed {
    width: 90vw;
    max-width: 350px;
    bottom: 60px;
    right: 10px;
  }
  
  .pip-video-container {
    height: 200px;
  }
}
</style>

