<template>
  <div 
    class="group-icon" 
    :class="[
      `size-${size}`,
      { 
        'has-badge': showParticipantCount && participantCount > 0,
        'clickable': clickable
      }
    ]"
    @click="handleClick"
  >
    <img
      v-if="iconUrl && !imageError"
      :src="iconUrl"
      :alt="alt"
      class="icon-image"
      loading="lazy"
      @error="handleImageError"
      @load="handleImageLoad"
    />
    <div v-else class="default-icon">
      <Icon name="users" />
    </div>
    
    <!-- Participant count badge -->
    <div 
      v-if="showParticipantCount && participantCount > 0" 
      class="participant-badge"
      :title="`${participantCount} member${participantCount !== 1 ? 's' : ''}`"
    >
      {{ participantCount > 99 ? '99+' : participantCount }}
    </div>
    
    <!-- Loading state -->
    <div v-if="loading" class="loading-overlay">
      <LoadingSpinner :size="20" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { debug } from '@/utils/debug'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import Icon from '@/components/common/Icon.vue'
import { GroupIconPresets, getDefaultGroupIcon, getGroupIconUrlRaw } from '@/utils/groupIconUtils'

interface Props {
  conversationId: string
  iconPath?: string | null
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  alt?: string
  showParticipantCount?: boolean
  participantCount?: number
  clickable?: boolean
  loading?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  size: 'md',
  alt: 'Group icon',
  showParticipantCount: false,
  participantCount: 0,
  clickable: false,
  loading: false
})

const emit = defineEmits<{
  click: []
  error: [error: Event]
  load: [event: Event]
}>()

const imageError = ref(false)
/** When transform URL returns 400 (e.g. imgproxy disabled), we show raw URL so the icon still displays */
const useRawUrlFallback = ref(false)

watch(
  () => [props.conversationId, props.iconPath],
  () => {
    imageError.value = false
    useRawUrlFallback.value = false
  }
)

// Memoize the URL to prevent flashing with error boundary
const iconUrl = computed(() => {
  try {
    if (!props.iconPath) {
      return getDefaultGroupIcon(props.conversationId, getSizePixels(props.size))
    }
    // If transform failed before, use raw URL so the uploaded icon still loads
    if (useRawUrlFallback.value) {
      return getGroupIconUrlRaw(props.conversationId, props.iconPath)
    }
    if (imageError.value) {
      return getDefaultGroupIcon(props.conversationId, getSizePixels(props.size))
    }

    // Use appropriate preset based on size (imgproxy transform for bandwidth/UX)
    switch (props.size) {
      case 'xs':
      case 'sm':
        return GroupIconPresets.small(props.conversationId, props.iconPath)
      case 'md':
        return GroupIconPresets.medium(props.conversationId, props.iconPath)
      case 'lg':
        return GroupIconPresets.large(props.conversationId, props.iconPath)
      case 'xl':
        return GroupIconPresets.profile(props.conversationId, props.iconPath)
      default:
        return GroupIconPresets.medium(props.conversationId, props.iconPath)
    }
  } catch (error) {
    // Error boundary: if anything fails, use a basic fallback
    debug.error('Failed to generate group icon URL:', error)
    return `data:image/svg+xml;base64,${btoa('<svg width="48" height="48" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect width="48" height="48" fill="#0EA5E9" rx="8"/><text x="24" y="30" text-anchor="middle" fill="white" font-size="18" font-family="system-ui">?</text></svg>')}`
  }
})

function getSizePixels(size: string): number {
  switch (size) {
    case 'xs': return 24
    case 'sm': return 32
    case 'md': return 48
    case 'lg': return 128
    case 'xl': return 256
    default: return 48
  }
}

function handleImageError(event: Event) {
  // Transform URL can return 400 if imgproxy isn't enabled (e.g. self-hosted). Try raw URL once.
  if (!useRawUrlFallback.value && props.iconPath) {
    debug.warn('Group icon transform URL failed, trying raw URL:', props.iconPath)
    useRawUrlFallback.value = true
    return
  }
  debug.warn('Group icon failed to load, falling back to default:', props.iconPath)
  imageError.value = true
  emit('error', event)
}

function handleImageLoad(event: Event) {
  imageError.value = false
  emit('load', event)
}

function handleClick() {
  if (props.clickable) {
    emit('click')
  }
}
</script>

<style scoped>
.group-icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--background-secondary);
  transition: all 0.2s ease;
}

.group-icon.clickable {
  cursor: pointer;
}

.group-icon.clickable:hover {
  transform: scale(1.05);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.icon-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
}

.default-icon {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--harmony-primary);
  color: var(--text-primary);
  border-radius: inherit;
}

/* Size variants */
.size-xs {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-sm);
}

.size-xs .default-icon {
  font-size: 12px;
}

.size-sm {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
}

.size-sm .default-icon {
  font-size: 14px;
}

.size-md {
  width: 48px;
  height: 48px;
  border-radius: var(--radius-md);
}

.size-md .default-icon {
  font-size: 20px;
}

.size-lg {
  width: 128px;
  height: 128px;
  border-radius: var(--radius-lg);
}

.size-lg .default-icon {
  font-size: 48px;
}

.size-xl {
  width: 256px;
  height: 256px;
  border-radius: var(--radius-xl);
}

.size-xl .default-icon {
  font-size: 96px;
}

/* Participant count badge */
.participant-badge {
  position: absolute;
  bottom: -2px;
  right: -2px;
  background: var(--accent-primary);
  color: var(--text-primary);
  font-size: 10px;
  font-weight: var(--font-weight-bold);
  min-width: 16px;
  height: 16px;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--background-primary);
  z-index: 1;
}

.size-xs .participant-badge,
.size-sm .participant-badge {
  font-size: 8px;
  min-width: 12px;
  height: 12px;
  bottom: -1px;
  right: -1px;
  border-width: 1px;
}

.size-lg .participant-badge,
.size-xl .participant-badge {
  font-size: 12px;
  min-width: 24px;
  height: 24px;
  bottom: -4px;
  right: -4px;
  border-width: 3px;
}

/* Loading overlay */
.loading-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: inherit;
  z-index: 2;
}

/* Focus styles for accessibility */
.group-icon.clickable:focus {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}

/* High contrast mode support */
@media (prefers-contrast: high) {
  .default-icon {
    border: 1px solid var(--border-color);
  }
  
  .participant-badge {
    border-color: var(--text-primary);
  }
}
</style>