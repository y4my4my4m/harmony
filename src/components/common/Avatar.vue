<template>
  <div class="avatar-container" :class="[sizeClass, { 'interactive': interactive }]">
    <!-- Avatar Image -->
    <img
      :src="avatarUrl"
      :alt="alt"
      class="avatar-image"
      loading="lazy"
      @click="handleClick"
      @error="handleImageError"
      @load="handleImageLoad"
    />

    <!-- Loading State -->
    <div v-if="loading" class="avatar-loading">
      <LoadingSpinner :size="20" />
    </div>

    <!-- Status Indicator -->
    <div
      v-if="status && !isMobile"
      class="avatar-status"
      :class="`status-${status}`"
    ></div>

    <!-- Mobile Status Indicator (shows phone icon when on mobile) -->
    <div
      v-if="status && isMobile"
      class="avatar-status avatar-status-mobile"
      :class="`status-${status}`"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" class="mobile-icon">
        <path d="M15.5 1h-8C6.12 1 5 2.12 5 3.5v17C5 21.88 6.12 23 7.5 23h8c1.38 0 2.5-1.12 2.5-2.5v-17C18 2.12 16.88 1 15.5 1zm-4 21c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm4.5-4H7V4h9v14z"/>
      </svg>
    </div>

    <!-- Edit Button -->
    <button
      v-if="editable"
      class="avatar-edit-btn"
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
import { debug } from '@/utils/debug'
import { getAvatarUrl } from '@/utils/avatarUtils'
import { validateImageUpload } from '@/utils/uploadValidation'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import CameraIcon from '@/components/icons/Camera.vue'

const toast = useToast()

// Types
type AvatarSize = 'mini' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'
type UserStatus = 'online' | 'away' | 'busy' | 'offline' | 'invisible'

// Props
interface Props {
  src?: string | null
  alt?: string
  size?: AvatarSize
  status?: UserStatus
  isMobile?: boolean  // Show mobile indicator instead of regular status dot
  editable?: boolean
  interactive?: boolean
  loading?: boolean
  // Decouple the imgproxy fetch resolution from the display size. When the same
  // avatar is already rendered elsewhere at a larger size (e.g. the message list
  // at "sm"=48px), small placements like the reaction tooltip can request that
  // same pixel size to reuse the cached image instead of fetching a new variant.
  fetchSize?: number
}

const props = withDefaults(defineProps<Props>(), {
  alt: 'Avatar',
  size: 'md',
  isMobile: false,
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

// Map avatar size to pixel size for optimization
const sizeMap: Record<AvatarSize, number> = {
  mini: 16,
  xs: 24,
  sm: 48, // should be 40px but 48 looks better because power of two value properly resize
  md: 96,
  lg: 128,
  xl: 156,
  '2xl': 256
}

// Computed
const avatarUrl = computed(() => {
  if (imageError.value) return '/default_avatar.webp'
  const pixelSize = props.fetchSize ?? (sizeMap[props.size] || 48)
  return getAvatarUrl(props.src, pixelSize)
})

const sizeClass = computed(() => `avatar-${props.size}`)

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

const handleFileSelect = async (event: Event) => {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  
  if (file) {
    // Validate against the avatars bucket's real size/type limits and surface
    // any problem through the toast system (not a native alert).
    const validationError = await validateImageUpload(file, 'avatars')
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

// Transient network failures (imgproxy/R2 latency) should not permanently
// show the default avatar. We retry a few times with backoff before giving up.
// only reset retry state on successful load of the REAL image, and
// never schedule a retry when the fallback itself just failed - otherwise we'd
// flip-flop between broken-real and broken-fallback forever.
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
  const delay = RETRY_DELAYS_MS[retryCount.value] ?? 3000
  retryTimer = setTimeout(() => {
    retryTimer = null
    retryCount.value++
    // Flipping imageError back to false makes the computed return the real URL
    // again, which re-issues the network request through the same <img> tag.
    imageError.value = false
  }, delay)
}

const handleImageError = () => {
  // If imageError was already true, this @error is from the fallback default
  // image itself failing - don't loop, just stay on the broken-image state.
  if (imageError.value) {
    debug.warn('Avatar fallback image failed to load:', avatarUrl.value)
    clearRetryTimer()
    return
  }
  debug.log(`Avatar image error for URL: ${avatarUrl.value} (retry ${retryCount.value}/${MAX_RETRIES})`)
  imageError.value = true
  scheduleRetry()
}

const handleImageLoad = () => {
  // Do NOT reset imageError here - the fallback image loading successfully
  // would re-trigger the broken src, causing an infinite loop.
  // Only "forgive" past failures when the REAL image loads (imageError is
  // false at this point because the computed returned the real URL).
  if (!imageError.value && retryCount.value > 0) {
    retryCount.value = 0
    clearRetryTimer()
  }
}

// Reset error state only when the src prop actually changes
watch(() => props.src, () => {
  imageError.value = false
  retryCount.value = 0
  clearRetryTimer()
})

onUnmounted(() => {
  clearRetryTimer()
})
</script>

<style scoped>
.avatar-container {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
}

.avatar-container.interactive {
  cursor: pointer;
}

.avatar-image {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  background-color: var(--background-quaternary);
  transition: all 0.2s ease;
  /* border: 2px solid var(--background-senary); */
}

/* .avatar-container.interactive .avatar-image:hover {
  transform: scale(1.05);
  border-color: #0EA5E9;
} */

/* Size classes - following voice overlay pattern */
.avatar-mini {
  width: 16px;
  height: 16px;
}

.avatar-xs {
  width: 20px;
  height: 20px;
}

.avatar-sm {
  width: 40px;
  height: 40px;
}

.avatar-md {
  width: 48px;
  height: 48px;
}

.avatar-lg {
  width: 64px;
  height: 64px;
}

.avatar-xl {
  width: 80px;
  height: 80px;
}

.avatar-2xl {
  width: 128px;
  height: 128px;
}

/* Loading state */
.avatar-loading {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  border-radius: 50%;
  background-color: var(--background-quaternary);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 0;
}

/* Status indicator - following voice overlay pattern */
.avatar-status {
  position: absolute;
  border-radius: 50%;
  border: 2px solid var(--background-secondary);
  bottom: -2px;
  right: -2px;
  width: 12px;
  height: 12px;
}

.avatar-sm .avatar-status {
  width: 8px;
  height: 8px;
  border-width: 1px;
}

.avatar-md .avatar-status {
  width: 12px;
  height: 12px;
  border-width: 2px;
}

.avatar-lg .avatar-status {
  width: 16px;
  height: 16px;
  border-width: 2px;
}

.avatar-xl .avatar-status {
  width: 20px;
  height: 20px;
  border-width: 3px;
}

.avatar-status.status-online {
  background-color: var(--status-online, #43b581);
}

.avatar-status.status-away {
  background-color: var(--status-away, #faa81a);
}

.avatar-status.status-busy {
  background-color: var(--status-busy, #f04747);
}

.avatar-status.status-offline {
  background-color: var(--status-offline, #747f8d);
}

.avatar-status.status-invisible {
  background-color: transparent;
  border: 2px solid var(--status-offline, #747f8d);
  box-sizing: border-box;
}

/* Mobile indicator - shows phone icon */
.avatar-status-mobile {
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: transparent !important;
  border-radius: 3px !important;
  width: auto !important;
  min-width: 14px;
  padding: 1px;
}

.mobile-icon {
  width: 10px;
  height: 10px;
  color: currentColor;
}

.avatar-status-mobile.status-online .mobile-icon {
  color: var(--status-online, #43b581);
}

.avatar-status-mobile.status-away .mobile-icon {
  color: var(--status-away, #faa81a);
}

.avatar-status-mobile.status-busy .mobile-icon {
  color: var(--status-busy, #f04747);
}

.avatar-status-mobile.status-offline .mobile-icon,
.avatar-status-mobile.status-invisible .mobile-icon {
  color: var(--status-offline, #747f8d);
}

/* Edit button */
.avatar-edit-btn {
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

.avatar-edit-btn:hover:not(:disabled) {
  background-color: #0284C7;
  transform: scale(1.1);
}

.avatar-edit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.avatar-sm .avatar-edit-btn {
  width: 18px;
  height: 18px;
}

.avatar-md .avatar-edit-btn {
  width: 24px;
  height: 24px;
}

.avatar-lg .avatar-edit-btn {
  width: 28px;
  height: 28px;
}

.avatar-xl .avatar-edit-btn {
  width: 32px;
  height: 32px;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
</style>