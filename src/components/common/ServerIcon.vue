<template>
  <div class="server-container" :class="[sizeClass, { 'interactive': interactive }]">
    <!-- server Image -->
    <img
      :src="serverUrl"
      :alt="alt"
      class="server-image"
      @click="handleClick"
      @error="handleImageError"
      @load="handleImageLoad"
    />

    <!-- Loading State -->
    <div v-if="loading" class="server-loading">
      <div class="loading-spinner"></div>
    </div>

    <!-- Status Indicator -->
    <div
      v-if="status"
      class="server-status"
      :class="`status-${status}`"
    ></div>

    <!-- Edit Button -->
    <button
      v-if="editable"
      class="server-edit-btn"
      @click="handleEdit"
      :disabled="loading"
    >
      <CameraIcon />
    </button>

    <!-- Hidden file input -->
    <input
      v-if="editable"
      ref="fileInput"
      type="file"
      accept="image/*"
      style="display: none"
      @change="handleFileSelect"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { getServerUrl } from '../../utils/serverUtils'
import CameraIcon from '@/components/icons/Camera.vue'

// Types
type serverSize = 'mini' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
type UserStatus = 'online' | 'away' | 'busy' | 'offline'

// Props
interface Props {
  src?: string | null
  alt?: string
  size?: serverSize
  status?: UserStatus
  editable?: boolean
  interactive?: boolean
  loading?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  alt: 'server',
  size: 'md',
  editable: false,
  interactive: false,
  loading: false
})

// Emits
const emit = defineEmits<{
  'click': []
  'upload': [file: File]
  'edit': []
}>()

// State
const imageError = ref(false)

// Refs
const fileInput = ref<HTMLInputElement>()

// Computed
const serverUrl = computed(() => {
  if (imageError.value) return '/default_server.png'
  return getServerUrl(props.src)
})

const sizeClass = computed(() => `server-${props.size}`)

// Methods
const handleClick = () => {
  if (props.interactive) {
    emit('click')
  }
}

const handleEdit = () => {
  if (props.editable) {
    emit('edit')
    fileInput.value?.click()
  }
}

const handleFileSelect = (event: Event) => {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  
  if (file) {
    // Validate file size (max 8MB)
    if (file.size > 8 * 1024 * 1024) {
      alert('File size must be less than 8MB')
      return
    }
    
    // Validate file type
    if (!file.type.startsWith('image/')) {
      alert('Please select a valid image file')
      return
    }
    
    emit('upload', file)
  }
  
  // Reset input
  target.value = ''
}

const handleImageError = () => {
  console.log('server image error for URL:', serverUrl.value)
  imageError.value = true
  // Don't attempt to reload the URL on error to prevent infinite loops
}

const handleImageLoad = () => {
  // Only reset error if we weren't already in error state
  if (imageError.value) {
    imageError.value = false
  }
}
</script>

<style scoped>
.server-container {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
  border-radius: 16px;
}

.server-container.interactive {
  cursor: pointer;
}

.server-image {
  position: relative;
  overflow: hidden;
  background: rgba(88, 101, 242, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: visible;
}


/* Size classes - following voice overlay pattern */
.server-mini {
  width: 16px;
  height: 16px;
}

.server-xs {
  width: 20px;
  height: 20px;
}

.server-sm {
  width: 36px;
  height: 36px;
}

.server-md {
  width: 48px;
  height: 48px;
}

.server-lg {
  width: 64px;
  height: 64px;
}

.server-xl {
  width: 80px;
  height: 80px;
}

.server-2xl {
  width: 128px;
  height: 128px;
}

/* Loading state */
.server-loading {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  border-radius: 50%;
  background-color: var(--h-chat-light);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 0;
}


/* Edit button */
.server-edit-btn {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: none;
  background-color: #5865f2;
  color: #ffffff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.server-edit-btn:hover:not(:disabled) {
  background-color: #4752c4;
  transform: scale(1.1);
}

.server-edit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.server-sm .server-edit-btn {
  width: 18px;
  height: 18px;
}

.server-md .server-edit-btn {
  width: 24px;
  height: 24px;
}

.server-lg .server-edit-btn {
  width: 28px;
  height: 28px;
}

.server-xl .server-edit-btn {
  width: 32px;
  height: 32px;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
</style>