<template>
  <div class="chat-header">
    <div class="header-left">
      <button 
        v-if="isMobile"
        class="mobile-menu-btn"
        @click="$emit('toggle-left-sidebar')"
      >
        <svg viewBox="0 0 24 24" class="menu-icon">
          <path d="M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z" fill="currentColor"/>
        </svg>
      </button>
      
      <div class="channel-info">
        <div class="channel-icon">
          <svg viewBox="0 0 24 24" class="hash-icon">
            <path d="M5.41 21L6.12 17H2.12L2.47 15H6.47L7.53 9H3.53L3.88 7H7.88L8.59 3H10.59L9.88 7H15.88L16.59 3H18.59L17.88 7H21.88L21.53 9H17.53L16.47 15H20.47L20.12 17H16.12L15.41 21H13.41L14.12 17H8.12L7.41 21H5.41M9.53 9L8.47 15H14.47L15.53 9H9.53Z" fill="currentColor"/>
          </svg>
        </div>
        <div class="channel-details">
          <h2 class="channel-name">{{ channel.name }}</h2>
          <template v-if="channel.description">
            <span class="channel-sep" aria-hidden="true">•</span>
            <span class="channel-description">{{ channel.description }}</span>
          </template>
        </div>
      </div>
    </div>

    <div class="header-actions">
      <button 
        v-if="pinnedCount > 0"
        class="action-btn pinned-btn"
        :class="{ 'has-pins': pinnedCount > 0 }"
        @click="handlePinnedClick"
        :title="`${pinnedCount} pinned message${pinnedCount !== 1 ? 's' : ''}`"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12,2L15.09,8.26L22,9.27L17,14.14L18.18,21.02L12,17.77L5.82,21.02L7,14.14L2,9.27L8.91,8.26L12,2Z"/>
        </svg>
        <span v-if="pinnedCount > 0" class="pinned-count">{{ pinnedCount }}</span>
      </button>
      
      <button 
        class="action-btn threads-btn"
        @click="handleThreadsClick"
        title="View all threads"
      >
        <Icon name="thread" :size="16" />
      </button>
      
      <button 
        class="action-btn search-btn"
        @click="handleSearchClick"
        title="Search in channel"
      >
        <Icon name="search" :size="16" />
      </button>
      
      <button 
        class="action-btn members-btn"
        :class="{ active: props.rightSidebarOpen }"
        @click="handleMembersClick"
        title="Show member list"
      >
        <Icon name="users" :size="16" />
      </button>
      
      <div class="more-menu-wrapper" ref="moreMenuRef">
        <button 
          class="action-btn more-btn"
          :class="{ active: showOptionsMenu }"
          @click="handleMoreClick"
          title="More options"
        >
          <Icon name="dots-vertical" :size="16" />
        </button>

        <Teleport to="body">
          <div v-if="showOptionsMenu" class="more-menu-backdrop" @click="showOptionsMenu = false"></div>
          <div
            v-if="showOptionsMenu"
            class="more-menu"
            :style="menuPosition"
            @click.stop
          >
            <div class="context-menu-item" @click="handleMarkAsRead">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M0.41,13.41L6,19L7.41,17.58L1.83,12M22.24,5.58L11.66,16.17L7.5,12L6.07,13.41L11.66,19L23.66,7M18,7L16.59,5.58L10.24,11.93L11.66,13.34L18,7Z"/>
              </svg>
              <span>Mark As Read</span>
            </div>

            <div class="context-menu-item" @click="handleToggleMute">
              <svg v-if="isChannelMuted" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12,4L9.91,6.09L12,8.18M4.27,3L3,4.27L7.73,9H3V15H7L12,20V13.27L16.25,17.53C15.58,18.04 14.83,18.46 14,18.7V20.77C15.38,20.45 16.63,19.82 17.68,18.96L19.73,21L21,19.73L12,10.73M19,12C19,12.94 18.8,13.82 18.46,14.64L19.97,16.15C20.62,14.91 21,13.5 21,12C21,7.72 18,4.14 14,3.23V5.29C16.89,6.15 19,8.83 19,12M16.5,12C16.5,10.23 15.5,8.71 14,7.97V10.18L16.45,12.63C16.5,12.43 16.5,12.21 16.5,12Z"/>
              </svg>
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M14,3.23V5.29C16.89,6.15 19,8.83 19,12C19,15.17 16.89,17.84 14,18.7V20.77C18,19.86 21,16.28 21,12C21,7.72 18,4.14 14,3.23M16.5,12C16.5,10.23 15.5,8.71 14,7.97V16C15.5,15.29 16.5,13.76 16.5,12M3,9V15H7L12,20V4L7,9H3Z"/>
              </svg>
              <span>{{ isChannelMuted ? 'Unmute Channel' : 'Mute Channel' }}</span>
            </div>

            <template v-if="canManageChannels">
              <div class="context-menu-divider"></div>

              <div class="context-menu-item" @click="handleEditChannel">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
                </svg>
                <span>Edit Channel</span>
              </div>
            </template>
          </div>
        </Teleport>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import type { Channel, Server } from '@/types'
import Icon from '@/components/common/Icon.vue'
import { messageService } from '@/services'
import { supabase } from '@/supabase'
import { useAuthStore } from '@/stores/auth'
import { useNotificationStore } from '@/stores/useNotification'
import { authContextService } from '@/services/AuthContextService'
import { useServerPermissions } from '@/composables/useServerPermissions'
import { debug } from '@/utils/debug'

// Props
interface Props {
  channel: Channel
  server?: Server
  isMobile?: boolean
  rightSidebarOpen?: boolean
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  'toggle-left-sidebar': []
  'toggle-right-sidebar': []
  'toggle-search': []
  'show-pinned': []
  'show-threads': []
  'edit-channel': [channel: Channel]
}>()

const { canManageChannels } = useServerPermissions()

// State
const showMembersList = ref(false)
const showOptionsMenu = ref(false)
const pinnedCount = ref(0)
const isChannelMuted = ref(false)
const moreMenuRef = ref<HTMLElement | null>(null)
const menuPosition = ref<Record<string, string>>({})

// Methods
const loadPinnedCount = async () => {
  if (!props.channel?.id) return
  try {
    pinnedCount.value = await messageService.getPinnedCount(props.channel.id)
  } catch (error) {
    console.error('Failed to load pinned count:', error)
  }
}

const loadMuteState = async () => {
  if (!props.channel?.id) return
  try {
    const ctx = await authContextService.getCurrentContext()
    if (!ctx.isAuthenticated) return

    const { data } = await supabase
      .from('notification_channels')
      .select('muted')
      .eq('user_id', ctx.profileId)
      .eq('channel_id', props.channel.id)
      .maybeSingle()

    isChannelMuted.value = data?.muted ?? false
  } catch (error) {
    debug.error('Failed to load mute state:', error)
  }
}

const handlePinnedClick = () => {
  emit('show-pinned')
}

const handleSearchClick = () => {
  emit('toggle-search')
}

const handleThreadsClick = () => {
  emit('show-threads')
}

const handleMembersClick = () => {
  showMembersList.value = !showMembersList.value
  emit('toggle-right-sidebar')
}

const handleMoreClick = () => {
  if (!showOptionsMenu.value) {
    const btn = moreMenuRef.value?.querySelector('.more-btn')
    if (btn) {
      const rect = btn.getBoundingClientRect()
      menuPosition.value = {
        top: `${rect.bottom + 4}px`,
        right: `${window.innerWidth - rect.right}px`,
      }
    }
  }
  showOptionsMenu.value = !showOptionsMenu.value
}

const handleMarkAsRead = async () => {
  showOptionsMenu.value = false
  if (!props.channel?.id) return

  try {
    const authStore = useAuthStore()
    const userId = authStore.session?.user?.id
    if (!userId) return

    // Clear unread counts for this channel
    await supabase
      .from('unread_counts')
      .update({
        unread_messages: 0,
        unread_mentions: 0,
        last_read_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .eq('channel_id', props.channel.id)

    // Mark all notifications for this channel as read
    const notificationStore = useNotificationStore()
    const channelNotifications = notificationStore.notifications.filter(n =>
      !n.is_read && (
        n.data?.channel_id === props.channel.id ||
        n.data?.message?.channel_id === props.channel.id
      )
    )
    if (channelNotifications.length > 0) {
      await Promise.all(channelNotifications.map(n => notificationStore.markAsRead(n.id)))
    }

    debug.log('✅ Marked channel as read:', props.channel.name)
  } catch (error) {
    debug.error('Failed to mark channel as read:', error)
  }
}

const handleEditChannel = () => {
  showOptionsMenu.value = false
  if (props.channel) {
    emit('edit-channel', props.channel)
  }
}

const handleToggleMute = async () => {
  showOptionsMenu.value = false
  if (!props.channel?.id) return

  try {
    const ctx = await authContextService.getCurrentContext()
    if (!ctx.isAuthenticated) return

    const newMuted = !isChannelMuted.value
    isChannelMuted.value = newMuted

    // Upsert the notification_channels row
    const { error } = await supabase
      .from('notification_channels')
      .upsert({
        user_id: ctx.profileId,
        channel_id: props.channel.id,
        server_id: props.server?.id ?? null,
        muted: newMuted,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,channel_id' })

    if (error) {
      // Revert optimistic update
      isChannelMuted.value = !newMuted
      debug.error('Failed to toggle mute:', error)

      // Fallback: try select-then-update/insert
      const { data: existing } = await supabase
        .from('notification_channels')
        .select('id')
        .eq('user_id', ctx.profileId)
        .eq('channel_id', props.channel.id)
        .maybeSingle()

      if (existing?.id) {
        await supabase
          .from('notification_channels')
          .update({ muted: newMuted, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
      } else {
        await supabase
          .from('notification_channels')
          .insert({
            user_id: ctx.profileId,
            channel_id: props.channel.id,
            server_id: props.server?.id ?? null,
            muted: newMuted,
          })
      }
      isChannelMuted.value = newMuted
    }

    debug.log(`✅ Channel ${newMuted ? 'muted' : 'unmuted'}:`, props.channel.name)
  } catch (error) {
    debug.error('Failed to toggle channel mute:', error)
  }
}

// Close menu on outside click or Escape
const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') showOptionsMenu.value = false
}

watch(() => props.channel?.id, () => {
  loadPinnedCount()
  loadMuteState()
  showOptionsMenu.value = false
})

onMounted(() => {
  loadPinnedCount()
  loadMuteState()
  document.addEventListener('keydown', handleKeyDown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeyDown)
})
</script>

<style scoped>
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--background-primary);
  border-bottom: 1px solid var(--border-color);
  height: 48px;
  min-height: 48px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.mobile-menu-btn {
  display: none;
  background: none;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.mobile-menu-btn:hover {
  background: var(--background-secondary);
}

.menu-icon {
  width: 20px;
  height: 20px;
}

.channel-info {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.channel-icon {
  color: var(--text-secondary);
  flex-shrink: 0;
  display: flex;
}

.hash-icon {
  width: 24px;
  height: 24px;
}

.channel-details {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: nowrap;
  align-items: baseline;
  gap: 6px;
}

.channel-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}

.channel-sep {
  color: var(--text-muted);
  font-size: 12px;
  flex-shrink: 0;
  user-select: none;
}

.channel-description {
  font-size: 13px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
}

.action-btn:hover,
.action-btn.active {
  color: var(--text-primary);
  background: var(--background-secondary);
}

.pinned-btn {
  position: relative;
}

.pinned-count {
  position: absolute;
  top: -4px;
  right: -4px;
  background: var(--harmony-primary);
  color: var(--text-primary);
  font-size: 10px;
  font-weight: 600;
  padding: 2px 5px;
  border-radius: 10px;
  min-width: 16px;
  text-align: center;
  line-height: 1.2;
}

.pinned-btn.has-pins {
  color: var(--harmony-primary);
}

.more-menu-wrapper {
  position: relative;
}

/* Mobile styles: two rows – name on first row, description on second */
@media (max-width: 768px) {
  .mobile-menu-btn {
    display: flex;
  }
  
  .chat-header {
    padding: 12px;
  }
  
  .action-btn {
    width: 40px;
    height: 40px;
  }
  
  .channel-details {
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 2px 6px;
  }
  
  .channel-name {
    flex: 0 1 auto;
  }
  
  .channel-sep {
    display: none;
  }
  
  .channel-description {
    flex: 1 1 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
    padding-left: 0;
  }
  
  .pinned-count {
    top: 0;
    right: 0px;
  }
}
</style>

<style>
.more-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
}

.more-menu {
  position: fixed;
  background: var(--background-primary-alpha, var(--background-primary));
  border: 1px solid var(--border-color);
  backdrop-filter: blur(8px);
  border-radius: 6px;
  padding: 6px 0;
  min-width: 200px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  z-index: 1000;
}

.more-menu .context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  transition: background-color 0.1s ease;
  user-select: none;
}

.more-menu .context-menu-item:hover:not(.disabled) {
  background-color: var(--harmony-primary);
  color: var(--text-primary);
}


.more-menu .context-menu-divider {
  height: 1px;
  background: var(--border-color, var(--h-black-lighter));
  margin: 4px 8px;
}
</style>