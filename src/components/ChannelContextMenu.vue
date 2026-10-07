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
      <span>Invite people</span>
    </div>
    
    <div class="context-menu-item" data-testid="copy-channel-id" @click="copyChannelId" v-if="channel">
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M5.88,21L6.6,17H3.6L3.96,15H6.96L8.04,9H5.04L5.4,7H8.4L9.12,3H11.12L10.4,7H16.4L17.12,3H19.12L18.4,7H21.4L21.04,9H18.04L16.96,15H19.96L19.6,17H16.6L15.88,21H13.88L14.6,17H8.6L7.88,21H5.88M10.04,9L8.96,15H14.96L16.04,9H10.04Z"/>
      </svg>
      <span>{{ t('channel.copyId') }}</span>
    </div>

    <div class="context-menu-divider" v-if="canManageChannel"></div>
    
    <div class="context-menu-item" @click="editChannel" v-if="canManageChannel">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
      </svg>
      <span>Edit channel</span>
    </div>
    
    <div class="context-menu-item danger" @click="deleteChannel" v-if="canManageChannel">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
      </svg>
      <span>Delete channel</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { useServerPermissions } from '@/composables/useServerPermissions'
import { debug } from '@/utils/debug'
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
const { t } = useI18n()
const toast = useToast()

const canManageChannel = computed(() => {
  return canManageChannels.value && props.channel
})

const canInvite = computed(() => {
  return hasCurrentUserPermission(Permission.CREATE_INVITE) && props.channel?.type === 0
})

const menuStyle = computed(() => {
  const menuWidth = 200
  const menuHeight = canManageChannel.value ? 190 : 80
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

const copyChannelId = async () => {
  const id = props.channel?.id
  emit('close')
  if (!id) return
  try {
    await navigator.clipboard.writeText(id)
    toast.success(t('channel.idCopied'))
  } catch (error) {
    debug.error('Failed to copy channel ID:', error)
    toast.error(t('channel.idCopyFailed'))
  }
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
  background: var(--background-floating);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 6px 0;
  min-width: 160px;
  box-shadow: var(--shadow-large);
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
  color: var(--text-on-primary);
}

.context-menu-item.danger {
  color: var(--error);
}

.context-menu-item.danger:hover {
  background-color: var(--error);
  color: var(--text-on-primary);
}

.context-menu-divider {
  height: 1px;
  background: var(--border-color, var(--background-quinary));
  margin: 4px 8px;
}
</style>
