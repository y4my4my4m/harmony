<template>
  <div class="server-container" :title="showTitle ? alt : undefined" :class="[sizeClass, { 'interactive': interactive }]">
    <!-- server Image -->
    <img
      :src="imgSrc"
      :alt="alt"
      class="server-image"
      :class="[classes, `shape-${shape}`]"
      loading="lazy"
      @click="handleClick"
      @error="onImgError"
      @load="onImgLoad"
    />

    <!-- Loading State -->
    <div v-if="loading" class="server-loading">
      <LoadingSpinner :size="20" />
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
import { ref, computed, watch, onUnmounted } from 'vue'
import { useToast } from 'vue-toastification'
import { getServerIconUrl } from '../../utils/serverUtils'
import { debug } from '@/utils/debug'
import { validateImageUpload } from '@/utils/uploadValidation'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import CameraIcon from '@/components/icons/Camera.vue'

const toast = useToast()

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
  showTitle?: boolean
  /**
   * Override the imgproxy render width/height (px) independent of display size.
   * Use to reuse an already-cached variant: e.g. the small context-bar icon can
   * request the same 96px variant the server rail already loaded (cache hit, no
   * extra fetch) instead of a unique tiny variant.
   */
  fetchSize?: number
}

const props = withDefaults(defineProps<Props>(), {
  alt: 'server',
  size: 'md',
  editable: false,
  interactive: false,
  loading: false,
  shape: 'rounded',
  showTitle: true
})

// Emits
const emit = defineEmits<{
  'click': [id?: string]
  'upload': [file: File]
  'edit': []
}>()

// Refs
const fileInput = ref<HTMLInputElement>()

// Map server size to pixel size for optimization
const sizeMap: Record<serverSize, number> = {
  mini: 16,
  xs: 24,
  sm: 36,
  md: 48,
  lg: 64,
  xl: 80,
  '2xl': 128
}

// Computed
const sizeClass = computed(() => `server-${props.size}`)

// --- Fallback image logic ---
const fallbackImage = '/default_server.webp'

// Use a local ref for the img src to allow error handling
const imgSrc = ref<string>(fallbackImage)
// The "real" URL we last computed from props; needed so retries can restore
// the real URL after we temporarily swapped in the fallback on @error.
const realImgSrc = ref<string>(fallbackImage)

// Transient network failures (imgproxy/R2 latency) should not permanently
// pin the icon to the fallback. Retry a few times with backoff before giving up.
const MAX_RETRIES = 3
const RETRY_DELAYS_MS = [400, 1200, 3000]
const retryCount = ref(0)
let retryTimer: ReturnType<typeof setTimeout> | null = null

const clearRetryTimer = () => {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

const scheduleRetry = () => {
  clearRetryTimer()
  if (retryCount.value >= MAX_RETRIES) return
  if (realImgSrc.value === fallbackImage) return
  const delay = RETRY_DELAYS_MS[retryCount.value] ?? 3000
  retryTimer = setTimeout(() => {
    retryTimer = null
    retryCount.value++
    // Swap back to the real URL; if the network was momentarily flaky, this
    // re-issues the request through the same <img> tag and may succeed.
    imgSrc.value = realImgSrc.value
  }, delay)
}

// Update imgSrc when props change
watch(
  () => [props.src, props.size, props.fetchSize],
  () => {
    const pixelSize = props.fetchSize ?? (sizeMap[props.size] || 48)
    const resolved = getServerIconUrl(props.src, pixelSize) || fallbackImage
    realImgSrc.value = resolved
    imgSrc.value = resolved
    retryCount.value = 0
    clearRetryTimer()
  },
  { immediate: true }
)

// Error handler for <img>
const onImgError = () => {
  // If we're already on the fallback, the fallback itself failed - don't loop.
  if (imgSrc.value === fallbackImage) {
    debug.warn('Server icon fallback image failed to load')
    clearRetryTimer()
    return
  }
  imgSrc.value = fallbackImage
  scheduleRetry()
}

const onImgLoad = () => {
  // Successful load of the real URL: forgive past failures.
  if (imgSrc.value !== fallbackImage && retryCount.value > 0) {
    retryCount.value = 0
    clearRetryTimer()
  }
}

onUnmounted(() => {
  clearRetryTimer()
})

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

const handleFileSelect = async (event: Event) => {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  
  if (file) {
    // Validate against the server_icons bucket's real size/type limits and
    // surface any problem through the toast system (not a native alert).
    const validationError = await validateImageUpload(file, 'server_icons')
    if (validationError) {
      toast.error(validationError)
      target.value = ''
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
  /* contain: content; */
}

.server-container.interactive {
  cursor: pointer;
}

.server-image {
  width: 100%;
  height: 100%;
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
  background-color: var(--harmony-primary);
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.server-edit-btn:hover:not(:disabled) {
  background-color: #0284C7;
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
