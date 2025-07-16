<template>
  <div class="server-container" :title="alt" :class="[sizeClass, { 'interactive': interactive }]">
    <!-- server Image -->
    <img
      :src="imgSrc"
      :alt="alt"
      class="server-image"
      :class="[classes, `shape-${shape}`]"
      @click="handleClick"
      @error="onImgError"
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
import { ref, computed, watch } from 'vue'
import { getServerIconUrl } from '../../utils/serverUtils'
import CameraIcon from '@/components/icons/Camera.vue'

// Types
type serverSize = 'mini' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
type UserStatus = 'online' | 'away' | 'busy' | 'offline'
type ImageShape = 'square' | 'rounded' | 'big-rounded' | 'round'

// Props
interface Props {
  id?: string
  src?: string | null
  alt?: string
  classes?: string[]
  size?: serverSize
  status?: UserStatus
  editable?: boolean
  interactive?: boolean
  loading?: boolean
  shape?: ImageShape
}

const props = withDefaults(defineProps<Props>(), {
  alt: 'server',
  size: 'md',
  editable: false,
  interactive: false,
  loading: false,
  shape: 'rounded'
})

// Emits
const emit = defineEmits<{
  'click': [id?: string]
  'upload': [file: File]
  'edit': []
}>()

// Refs
const fileInput = ref<HTMLInputElement>()

// Computed
const sizeClass = computed(() => `server-${props.size}`)

// --- Fallback image logic ---
const fallbackImage = '/default_server.png'

// Use a local ref for the img src, initialized to computed value or fallback
const imgSrc = ref(getServerIconUrl(props.src) || fallbackImage)

// Watch for prop changes and update imgSrc
watch(
  () => props.src,
  (newVal) => {
    imgSrc.value = getServerIconUrl(newVal) || fallbackImage
  }
)

// Error handler for <img>
const onImgError = () => {
  if (imgSrc.value !== fallbackImage) {
    imgSrc.value = fallbackImage
  }
}

// Methods
const handleClick = () => {
  if (props.interactive) {
    emit('click', props.id)
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
</script>

<style scoped>
.server-container {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
  contain: content;
}

.server-container.interactive {
  cursor: pointer;
}

.server-image {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  /* max-width: 100%; */
  max-height: calc(100% + 5px);
  width: auto;
  height: auto;
  background: rgba(88, 101, 242, 0.1);
  display: block;
  object-fit: cover;
}

/* Shape variants */
.server-image.shape-square {
  border-radius: 0;
}

.server-image.shape-rounded {
  border-radius: 6px;
}

.server-image.shape-big-rounded {
  border-radius: 16px;
}

.server-image.shape-round {
  border-radius: 50%;
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
