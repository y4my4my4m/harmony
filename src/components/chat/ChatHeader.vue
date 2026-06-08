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

            <div class="context-menu-divider"></div>
            <div class="context-menu-label">Notification Level</div>
            <div 
              class="context-menu-item" 
              :class="{ 'item-active': channelNotificationLevel === 'all' }"
              @click="setNotificationLevel('all')"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M21,19V20H3V19L5,17V11C5,7.9 7.03,5.17 10,4.29C10,4.19 10,4.1 10,4A2,2 0 0,1 12,2A2,2 0 0,1 14,4C14,4.1 14,4.19 14,4.29C16.97,5.17 19,7.9 19,11V17L21,19M14,21A2,2 0 0,1 12,23A2,2 0 0,1 10,21"/>
              </svg>
              <span>All Messages</span>
              <svg v-if="channelNotificationLevel === 'all'" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="check-icon">
                <path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/>
              </svg>
            </div>
            <div 
              class="context-menu-item"
              :class="{ 'item-active': channelNotificationLevel === 'mentions' }"
              @click="setNotificationLevel('mentions')"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12,15C12.81,15 13.5,14.7 14.11,14.11C14.7,13.5 15,12.81 15,12C15,11.19 14.7,10.5 14.11,9.89C13.5,9.3 12.81,9 12,9C11.19,9 10.5,9.3 9.89,9.89C9.3,10.5 9,11.19 9,12C9,12.81 9.3,13.5 9.89,14.11C10.5,14.7 11.19,15 12,15M12,2C14.75,2 17.1,3 19.05,4.95C21,6.9 22,9.25 22,12V13.45C22,14.45 21.65,15.3 21,16C20.3,16.67 19.5,17 18.5,17C17.3,17 16.31,16.5 15.56,15.5C14.56,16.5 13.38,17 12,17C10.63,17 9.45,16.5 8.46,15.54C7.5,14.55 7,13.38 7,12C7,10.63 7.5,9.45 8.46,8.46C9.45,7.5 10.63,7 12,7C13.38,7 14.55,7.5 15.54,8.46C16.5,9.45 17,10.63 17,12V13.45C17,13.86 17.16,14.22 17.46,14.53C17.76,14.84 18.11,15 18.5,15C18.92,15 19.27,14.84 19.57,14.53C19.87,14.22 20,13.86 20,13.45V12C20,9.81 19.23,7.93 17.65,6.35C16.07,4.77 14.19,4 12,4C9.81,4 7.93,4.77 6.35,6.35C4.77,7.93 4,9.81 4,12C4,14.19 4.77,16.07 6.35,17.65C7.93,19.23 9.81,20 12,20H17V22H12C9.25,22 6.9,21 4.95,19.05C3,17.1 2,14.75 2,12C2,9.25 3,6.9 4.95,4.95C6.9,3 9.25,2 12,2Z"/>
              </svg>
              <span>Mentions Only</span>
              <svg v-if="channelNotificationLevel === 'mentions'" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="check-icon">
                <path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/>
              </svg>
            </div>
            <div 
              class="context-menu-item"
              :class="{ 'item-active': channelNotificationLevel === 'none' }"
              @click="setNotificationLevel('none')"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20,18.69L7.84,6.14L5.27,3.49L4,4.76L6.8,7.56V7.57C5.66,9.2 5,11.13 5,13V17L3,19V20H17.73L19.73,22L21,20.73L20,18.69M12,23A2,2 0 0,0 14,21H10A2,2 0 0,0 12,23M19,13C19,9.82 16.64,7.2 13.55,6.22C13.35,5.5 12.74,5 12,5C11.26,5 10.65,5.5 10.45,6.22C10.05,6.33 9.66,6.5 9.29,6.69L20,17.4V13Z"/>
              </svg>
              <span>Nothing</span>
              <svg v-if="channelNotificationLevel === 'none'" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="check-icon">
                <path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/>
              </svg>
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
import { ref, watch, onMounted, onUnmounted } from 'vue'
import type { Channel, Server } from '@/types'
import Icon from '@/components/common/Icon.vue'
import { messageService } from '@/services'
import { supabase } from '@/supabase'
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
// Matches the DB default (`notification_channels.notification_level DEFAULT 'mentions'`)
// so the UI shows the correct check mark before any explicit per-channel
// override exists. Server- or user-level overrides still take precedence
// once `loadMuteState` has run.
const channelNotificationLevel = ref<'all' | 'mentions' | 'none'>('mentions')
const moreMenuRef = ref<HTMLElement | null>(null)
const menuPosition = ref<Record<string, string>>({})

/**
 * Insert or update notification_channels for a server channel.
 * DB uses a partial unique index on (user_id, channel_id), so PostgREST
 * upsert with onConflict(user_id, channel_id) fails with 42P10.
 */
async function mergeServerChannelNotificationRow(
  profileId: string,
  channelId: string,
  serverId: string | null,
  updates: { muted?: boolean; notification_level?: 'all' | 'mentions' | 'none' }
) {
  const { data: existing } = await supabase
    .from('notification_channels')
    .select('id')
    .eq('user_id', profileId)
    .eq('channel_id', channelId)
    .maybeSingle()

  const updated_at = new Date().toISOString()

  if (existing?.id) {
    return supabase
      .from('notification_channels')
      .update({
        ...updates,
        server_id: serverId,
        updated_at,
      })
      .eq('id', existing.id)
  }

  return supabase.from('notification_channels').insert({
    user_id: profileId,
    channel_id: channelId,
    server_id: serverId,
    ...updates,
    updated_at,
  })
}

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
      .select('muted, notification_level')
      .eq('user_id', ctx.profileId)
      .eq('channel_id', props.channel.id)
      .maybeSingle()

    isChannelMuted.value = data?.muted ?? false
    // No row → show the new default ('mentions'). User-explicit values
    // (including 'all') are returned as-is and override the default.
    channelNotificationLevel.value =
      (data?.notification_level as 'all' | 'mentions' | 'none') ?? 'mentions'
  } catch (error) {
    debug.error('Failed to load mute state:', error)
  }
}

const setNotificationLevel = async (level: 'all' | 'mentions' | 'none') => {
  showOptionsMenu.value = false
  if (!props.channel?.id) return

  try {
    const ctx = await authContextService.getCurrentContext()
    if (!ctx.isAuthenticated) return

    const prevLevel = channelNotificationLevel.value
    channelNotificationLevel.value = level

    const { error } = await mergeServerChannelNotificationRow(
      ctx.profileId,
      props.channel.id,
      props.server?.id ?? null,
      { notification_level: level }
    )

    if (error) {
      channelNotificationLevel.value = prevLevel
      debug.error('Failed to set notification level:', error)
    } else {
      debug.log(`✅ Channel notification level set to: ${level}`)
    }
  } catch (error) {
    debug.error('Failed to set notification level:', error)
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
    const ctx = await authContextService.getCurrentContext()
    if (!ctx.isAuthenticated) return

    // RLS-aware identity: unread_counts.user_id references profiles.id,
    // not auth.users.id. Mixing the two silently mutates zero rows.
    const { error } = await supabase
      .from('unread_counts')
      .update({
        unread_messages: 0,
        unread_mentions: 0,
        last_read_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('user_id', ctx.profileId)
      .eq('channel_id', props.channel.id)

    if (error) {
      debug.error('Failed to clear channel unread counts:', error)
      return
    }

    // Mark all notifications for this channel as read.
    // Filter on every supported location path used by NotificationFormatter so
    // notifications stored under data.location.* are also cleared.
    const notificationStore = useNotificationStore()
    const channelId = props.channel.id
    const channelNotifications = notificationStore.notifications.filter(n =>
      !n.is_read && (
        n.data?.channel_id === channelId ||
        n.data?.message?.channel_id === channelId ||
        n.data?.location?.channel_id === channelId
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

    const { error } = await mergeServerChannelNotificationRow(
      ctx.profileId,
      props.channel.id,
      props.server?.id ?? null,
      { muted: newMuted }
    )

    if (error) {
      isChannelMuted.value = !newMuted
      debug.error('Failed to toggle mute:', error)
      return
    }

    // Notify other components (notably ChannelSidebar) so the muted styling
    // and the suppression of unread indicators happen instantly without
    // waiting for a server-switch / remount to refetch `notification_channels`.
    window.dispatchEvent(new CustomEvent('channel-mute-changed', {
      detail: { channelId: props.channel.id, muted: newMuted },
    }))

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

/* Mobile styles: two rows - name on first row, description on second */
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
  background: var(--border-color, var(--background-quinary));
  margin: 4px 8px;
}

.more-menu .context-menu-label {
  padding: 4px 12px 2px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}

.more-menu .context-menu-item.item-active {
  color: var(--harmony-primary);
}

.more-menu .context-menu-item .check-icon {
  margin-left: auto;
}
</style>