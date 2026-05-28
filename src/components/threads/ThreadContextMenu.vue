<template>
  <div 
    v-if="isVisible" 
    class="context-menu"
    :style="menuStyle"
    @click.stop
  >
    <!-- Leave/Join Thread -->
    <div class="context-menu-item" @click="leaveThread">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
        <polyline points="16 17 21 12 16 7"/>
        <line x1="21" y1="12" x2="9" y2="12"/>
      </svg>
      <span>Leave Thread</span>
    </div>

    <div class="context-menu-divider"></div>

    <!-- Edit Thread -->
    <div class="context-menu-item" @click="editThread" v-if="canManageThread">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
      </svg>
      <span>Edit Thread</span>
    </div>

    <!-- Open in Split View -->
    <div class="context-menu-item" @click="openInSplitView">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3 5v14h18V5H3zm8 12H5V7h6v10zm8 0h-6V7h6v10z"/>
      </svg>
      <span>Open in Split View</span>
    </div>

    <div class="context-menu-divider" v-if="canManageThread"></div>

    <!-- Close Thread (Archive) -->
    <div class="context-menu-item" @click="closeThread" v-if="canManageThread && !thread?.archived">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/>
      </svg>
      <span>Close Thread</span>
    </div>

    <!-- Reopen Thread (if archived) -->
    <div class="context-menu-item" @click="reopenThread" v-if="canManageThread && thread?.archived">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 6.5L17.5 12H14v2h-4v-2H6.5L12 6.5zM5.12 5l.81-1h12l.94 1H5.12z"/>
      </svg>
      <span>Reopen Thread</span>
    </div>

    <!-- Lock Thread -->
    <div class="context-menu-item" @click="lockThread" v-if="canManageThread && !thread?.locked">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
      </svg>
      <span>Lock Thread</span>
    </div>

    <!-- Unlock Thread -->
    <div class="context-menu-item" @click="unlockThread" v-if="canManageThread && thread?.locked">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/>
      </svg>
      <span>Unlock Thread</span>
    </div>

    <!-- Delete Thread -->
    <div class="context-menu-item danger" @click="deleteThread" v-if="canManageThread">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
      </svg>
      <span>Delete Thread</span>
    </div>

    <div class="context-menu-divider"></div>

    <!-- Copy Link -->
    <div class="context-menu-item" @click="copyLink">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/>
      </svg>
      <span>Copy Link</span>
    </div>

    <!-- Copy Thread ID -->
    <div class="context-menu-item" @click="copyThreadId">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
      </svg>
      <span>Copy Thread ID</span>
      <span class="menu-hint">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" opacity="0.5">
          <path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/>
        </svg>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useServerPermissions } from '@/composables/useServerPermissions'
import type { ThreadWithDetails } from '@/services/ThreadService'

interface Props {
  isVisible: boolean
  position: { x: number; y: number }
  thread: ThreadWithDetails | null
  serverId?: string
}

const props = defineProps<Props>()

// Tuple-based defineEmits is the modern Vue 3 syntax and plays better
// with vue-tsc's `(...args: any[]) => any` listener-prop type than the
// older call-signature interface form, which produces contravariance
// errors at the parent's `@edit="..."` etc. binding sites.
const emit = defineEmits<{
  close: []
  leave: []
  edit: [thread: ThreadWithDetails]
  'open-split-view': [thread: ThreadWithDetails]
  'close-thread': [thread: ThreadWithDetails]
  reopen: [thread: ThreadWithDetails]
  lock: [thread: ThreadWithDetails]
  unlock: [thread: ThreadWithDetails]
  delete: [thread: ThreadWithDetails]
}>()

const { canManageChannels } = useServerPermissions()

// Calculate position to keep menu in viewport
const menuStyle = computed(() => {
  const menuWidth = 200
  const menuHeight = 350
  const padding = 10
  
  let x = props.position.x
  let y = props.position.y
  
  // Adjust if menu would go off right edge
  if (x + menuWidth > window.innerWidth - padding) {
    x = window.innerWidth - menuWidth - padding
  }
  
  // Adjust if menu would go off bottom edge
  if (y + menuHeight > window.innerHeight - padding) {
    y = window.innerHeight - menuHeight - padding
  }
  
  return {
    top: y + 'px',
    left: x + 'px'
  }
})

const canManageThread = computed(() => {
  // Can manage threads only if user has MANAGE_CHANNELS permission
  // Thread membership alone should not grant management capabilities
  return canManageChannels.value
})

const leaveThread = () => {
  emit('leave')
  emit('close')
}

const editThread = () => {
  if (props.thread) {
    emit('edit', props.thread)
  }
  emit('close')
}

const openInSplitView = () => {
  if (props.thread) {
    emit('open-split-view', props.thread)
  }
  emit('close')
}

const closeThread = () => {
  if (props.thread) {
    emit('close-thread', props.thread)
  }
  emit('close')
}

const reopenThread = () => {
  if (props.thread) {
    emit('reopen', props.thread)
  }
  emit('close')
}

const lockThread = () => {
  if (props.thread) {
    emit('lock', props.thread)
  }
  emit('close')
}

const unlockThread = () => {
  if (props.thread) {
    emit('unlock', props.thread)
  }
  emit('close')
}

const deleteThread = () => {
  if (props.thread) {
    emit('delete', props.thread)
  }
  emit('close')
}

const copyLink = async () => {
  if (props.thread && props.serverId) {
    const url = `${window.location.origin}/chat/${props.serverId}/thread/${props.thread.id}`
    await navigator.clipboard.writeText(url)
  }
  emit('close')
}

const copyThreadId = async () => {
  if (props.thread) {
    await navigator.clipboard.writeText(props.thread.id)
  }
  emit('close')
}

// Close menu on click outside
const handleClickOutside = (e: MouseEvent) => {
  emit('close')
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<style scoped>
.context-menu {
  position: fixed;
  background: var(--background-primary-alpha);
  border: 1px solid var(--border-color);
  backdrop-filter: blur(8px);
  border-radius: 6px;
  padding: 6px 0;
  min-width: 188px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  z-index: 1000;
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  color: var(--text-secondary, #b5bac1);
  cursor: pointer;
  font-size: 14px;
  transition: background-color 0.1s ease;
}

.context-menu-item:hover {
  background: var(--background-modifier-hover, rgba(79, 84, 92, 0.4));
  color: var(--text-primary, #fff);
}

.context-menu-item.danger {
  color: #ed4245;
}

.context-menu-item.danger:hover {
  background: rgba(237, 66, 69, 0.1);
  color: #ed4245;
}

.context-menu-divider {
  height: 1px;
  background: var(--border-color, var(--h-black-lighter));
  margin: 4px 8px;
}

.menu-hint {
  margin-left: auto;
  display: flex;
  align-items: center;
}
</style>

