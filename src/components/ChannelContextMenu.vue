<template>
  <div 
    v-if="isVisible" 
    class="context-menu"
    :style="menuStyle"
    @click.stop
  >
    <div class="context-menu-item" @click="inviteUsers" v-if="canInvite">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M12,5.5A3.5,3.5 0 0,1 15.5,9A3.5,3.5 0 0,1 12,12.5A3.5,3.5 0 0,1 8.5,9A3.5,3.5 0 0,1 12,5.5M5,8C5.56,8 6.08,8.15 6.53,8.42C6.38,9.85 6.8,11.27 7.66,12.38C7.16,13.34 6.16,14 5,14A3,3 0 0,1 2,11A3,3 0 0,1 5,8M19,8A3,3 0 0,1 22,11A3,3 0 0,1 19,14C17.84,14 16.84,13.34 16.34,12.38C17.2,11.27 17.62,9.85 17.47,8.42C17.92,8.15 18.44,8 19,8M5.5,18.25C5.5,16.18 8.41,14.5 12,14.5C15.59,14.5 18.5,16.18 18.5,18.25V20H5.5V18.25M0,20V18.5C0,17.11 1.89,15.94 4.45,15.6C3.86,16.28 3.5,17.22 3.5,18.25V20H0M24,20H20.5V18.25C20.5,17.22 20.14,16.28 19.55,15.6C22.11,15.94 24,17.11 24,18.5V20Z"/>
      </svg>
      <span>Invite Users</span>
    </div>
    
    <div class="context-menu-divider" v-if="canManageChannel"></div>
    
    <div class="context-menu-item" @click="editChannel" v-if="canManageChannel">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
      </svg>
      <span>Edit Channel</span>
    </div>
    
    <div class="context-menu-item danger" @click="deleteChannel" v-if="canManageChannel">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
      </svg>
      <span>Delete Channel</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useServerPermissions } from '@/composables/useServerPermissions'
import type { Channel } from '@/types'

interface Props {
  isVisible: boolean
  position: { x: number; y: number }
  channel: Channel | null
}

interface Emits {
  (e: 'close'): void
  (e: 'invite-users'): void
  (e: 'edit-channel', channel: Channel): void
  (e: 'delete-channel', channel: Channel): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const { canManageChannels, hasCurrentUserPermission, Permission } = useServerPermissions()

const canManageChannel = computed(() => {
  return canManageChannels.value && props.channel
})

const canInvite = computed(() => {
  return hasCurrentUserPermission(Permission.CREATE_INVITE) && props.channel?.type === 0
})

const menuStyle = computed(() => {
  const menuWidth = 200
  const menuHeight = canManageChannel.value ? 150 : 40
  const padding = 10

  let x = props.position.x
  let y = props.position.y

  if (typeof window !== 'undefined') {
    if (x + menuWidth > window.innerWidth - padding) {
      x = window.innerWidth - menuWidth - padding
    }
    if (y + menuHeight > window.innerHeight - padding) {
      y = window.innerHeight - menuHeight - padding
    }
  }

  return { top: y + 'px', left: x + 'px' }
})

const inviteUsers = () => {
  emit('invite-users')
  emit('close')
}

const editChannel = () => {
  if (props.channel) {
    emit('edit-channel', props.channel)
  }
  emit('close')
}

const deleteChannel = () => {
  if (props.channel) {
    emit('delete-channel', props.channel)
  }
  emit('close')
}
</script>

<style scoped>
.context-menu {
  position: fixed;
  background: var(--background-primary-alpha);
  border: 1px solid var(--border-color);
  backdrop-filter: blur(8px);
  border-radius: 6px;
  padding: 6px 0;
  min-width: 160px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  z-index: 1000;
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  transition: background-color 0.1s ease;
}

.context-menu-item:hover {
  background-color: var(--harmony-primary);
  color: var(--text-primary);
}

.context-menu-item.danger {
  color: #ed4245;
}

.context-menu-item.danger:hover {
  background-color: #ed4245;
  color: var(--text-primary);
}

.context-menu-divider {
  height: 1px;
  background: var(--border-color, var(--background-quinary));
  margin: 4px 8px;
}
</style>
