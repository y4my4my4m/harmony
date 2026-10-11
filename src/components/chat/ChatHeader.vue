<template>
  <div class="chat-header">
    <div class="header-left">
      <button 
        v-if="isMobile"
        type="button"
        class="mobile-menu-btn"
        :aria-label="t('a11y.drawer.navigation')"
        v-bind="leftDrawerToggle"
        @click="$emit('toggle-left-sidebar')"
      >
        <svg viewBox="0 0 24 24" class="menu-icon" aria-hidden="true">
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
          <span
            v-if="lockKey"
            class="channel-lock"
            role="img"
            :title="$t(lockKey)"
            :aria-label="$t(lockKey)"
          ><Icon name="lock" :size="14" /></span>
          <template v-if="channel.description">
            <span class="channel-sep" aria-hidden="true">•</span>
            <span class="channel-description">{{ channel.description }}</span>
          </template>
        </div>
      </div>
    </div>

    <div class="header-actions">
      <button 
        type="button"
        class="action-btn pinned-btn"
        :class="{ 'has-pins': pinnedCount > 0 }"
        @click="handlePinnedClick"
        :title="pinnedCount > 0 ? t('chatNav.header.pinnedCount', { count: pinnedCount }, pinnedCount) : t('message.pinned')"
        :aria-label="pinnedCount > 0 ? t('chatNav.header.pinnedCount', { count: pinnedCount }, pinnedCount) : t('message.pinned')"
      >
        <Icon name="pin" :size="16" aria-hidden="true" />
        <span v-if="pinnedCount > 0" class="pinned-count" aria-hidden="true">{{ pinnedCount }}</span>
      </button>
      
      <button 
        type="button"
        class="action-btn threads-btn"
        @click="handleThreadsClick"
        :title="t('chatNav.header.threads')"
        :aria-label="t('chatNav.header.threads')"
      >
        <Icon name="thread" :size="16" aria-hidden="true" />
      </button>
      
      <button 
        type="button"
        class="action-btn search-btn"
        @click="handleSearchClick"
        :title="t('messageSearch.title')"
        :aria-label="t('messageSearch.title')"
      >
        <Icon name="search" :size="16" aria-hidden="true" />
      </button>
      
      <button 
        class="action-btn members-btn"
        :class="{ active: props.rightSidebarOpen }"
        @click="handleMembersClick"
        type="button"
        :title="t('a11y.drawer.memberList')"
        :aria-label="t('a11y.drawer.memberList')"
        v-bind="rightDrawerToggle"
      >
        <Icon name="users" :size="16" aria-hidden="true" />
      </button>
      
      <div class="more-menu-wrapper">
        <button 
          ref="moreBtnRef"
          type="button"
          class="action-btn more-btn"
          :class="{ active: showOptionsMenu }"
          :title="t('chatNav.header.more')"
          :aria-label="t('chatNav.header.more')"
          aria-haspopup="menu"
          :aria-expanded="showOptionsMenu"
          :aria-controls="showOptionsMenu ? moreMenu.menuId : undefined"
          @click="handleMoreClick"
          @keydown="moreMenu.onTriggerKeydown"
        >
          <Icon name="dots-vertical" :size="16" aria-hidden="true" />
        </button>

        <!-- Covers the page, the trigger included, so a click outside closes the
             menu without reaching anything underneath. -->
        <Teleport to="body">
          <div v-if="showOptionsMenu" class="more-menu-backdrop" aria-hidden="true" @click="showOptionsMenu = false"></div>
        </Teleport>
        <ChatMenu
          v-if="showOptionsMenu"
          :id="moreMenu.menuId"
          :anchor="moreBtnRef"
          :label="t('chatNav.header.more')"
          :initial-focus="moreMenu.initialFocus.value"
          class="more-menu"
          @close="showOptionsMenu = false"
        >
          <!-- Mobile: pinned/threads buttons are hidden from the header
               and exposed here instead. -->
          <template v-if="isMobile">
            <button type="button" role="menuitem" class="chat-menu-item context-menu-item" @click="handleMenuPinned">
              <Icon name="pin" :size="16" aria-hidden="true" />
              <span>{{ t('message.pinned') }}<template v-if="pinnedCount > 0"> ({{ pinnedCount }})</template></span>
            </button>
            <button type="button" role="menuitem" class="chat-menu-item context-menu-item" @click="handleMenuThreads">
              <Icon name="thread" :size="16" aria-hidden="true" />
              <span>{{ t('chatNav.header.threadsShort') }}</span>
            </button>
            <div class="chat-menu-divider" role="separator"></div>
          </template>

          <button type="button" role="menuitem" class="chat-menu-item context-menu-item" @click="handleMarkAsRead">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M0.41,13.41L6,19L7.41,17.58L1.83,12M22.24,5.58L11.66,16.17L7.5,12L6.07,13.41L11.66,19L23.66,7M18,7L16.59,5.58L10.24,11.93L11.66,13.34L18,7Z"/>
            </svg>
            <span>{{ $t('notificationSettings.header.markRead') }}</span>
          </button>

          <button type="button" role="menuitem" class="chat-menu-item context-menu-item" data-testid="channel-mute-toggle" @click="handleToggleMute">
            <svg v-if="isChannelMuted" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12,4L9.91,6.09L12,8.18M4.27,3L3,4.27L7.73,9H3V15H7L12,20V13.27L16.25,17.53C15.58,18.04 14.83,18.46 14,18.7V20.77C15.38,20.45 16.63,19.82 17.68,18.96L19.73,21L21,19.73L12,10.73M19,12C19,12.94 18.8,13.82 18.46,14.64L19.97,16.15C20.62,14.91 21,13.5 21,12C21,7.72 18,4.14 14,3.23V5.29C16.89,6.15 19,8.83 19,12M16.5,12C16.5,10.23 15.5,8.71 14,7.97V10.18L16.45,12.63C16.5,12.43 16.5,12.21 16.5,12Z"/>
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M14,3.23V5.29C16.89,6.15 19,8.83 19,12C19,15.17 16.89,17.84 14,18.7V20.77C18,19.86 21,16.28 21,12C21,7.72 18,4.14 14,3.23M16.5,12C16.5,10.23 15.5,8.71 14,7.97V16C15.5,15.29 16.5,13.76 16.5,12M3,9V15H7L12,20V4L7,9H3Z"/>
            </svg>
            <span>{{ $t(muteLabelKey) }}</span>
          </button>

          <div class="chat-menu-divider" role="separator"></div>
          <div role="group" :aria-labelledby="levelLabelId">
            <div :id="levelLabelId" class="chat-menu-label">{{ $t('notificationSettings.header.level') }}</div>
            <button
              v-for="option in levelOptions"
              :key="option.value ?? 'default'"
              type="button"
              role="menuitemradio"
              class="chat-menu-item context-menu-item"
              :class="{ 'item-active': channelLevel === option.value }"
              :aria-checked="channelLevel === option.value"
              :data-testid="`channel-level-${option.value ?? 'default'}`"
              @click="setNotificationLevel(option.value)"
            >
              <Icon :name="option.icon" :size="16" aria-hidden="true" />
              <span>{{ option.label }}</span>
              <svg v-if="channelLevel === option.value" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="check-icon" aria-hidden="true">
                <path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/>
              </svg>
            </button>
          </div>
          <button v-if="serverId" type="button" role="menuitem" class="chat-menu-item context-menu-item" data-testid="channel-open-notification-settings" @click="openServerNotificationSettings">
            <Icon name="settings" :size="16" aria-hidden="true" />
            <span>{{ $t('notificationSettings.menuEntry') }}</span>
          </button>

          <template v-if="canManageChannels || (canManageWebhooks && channel?.type === 0)">
            <div class="chat-menu-divider" role="separator"></div>

            <button type="button" role="menuitem" class="chat-menu-item context-menu-item" @click="handleEditChannel">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
              </svg>
              <span>{{ t('chatNav.menu.editChannel') }}</span>
            </button>
          </template>
        </ChatMenu>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import type { Channel, Server } from '@/types'
import Icon from '@/components/common/Icon.vue'
import ChatMenu from '@/components/chat/ChatMenu.vue'
import { useMenuButton } from '@/composables/useMenu'
import { uid } from '@/utils/a11y/focus'
import { usePinsStore, pinScopeKey } from '@/stores/usePins'
import { useI18n } from 'vue-i18n'
import { useAppDrawers } from '@/composables/useLayoutState'
import { useNotificationStore } from '@/stores/useNotification'
import { useServerNotificationSettingsStore } from '@/stores/useServerNotificationSettings'
import { findOverride, inheritedLevel, isMuteActive, type NotificationLevel } from '@/services/notificationSettings'
import { authContextService } from '@/services/AuthContextService'
import { markChannelRead } from '@/services/readState'
import { useServerPermissions } from '@/composables/useServerPermissions'
import { useChannelEncryptionStore } from '@/stores/useChannelEncryption'
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

const { canManageChannels, canManageWebhooks } = useServerPermissions()
const channelEncryptionStore = useChannelEncryptionStore()

// i18n key for the lock icon's label; null for a channel without encryption.
const lockKey = computed((): string | null => {
  const state = channelEncryptionStore.stateFor(props.channel?.id)
  if (!state) return null
  if (Number(props.channel?.type) === 1 && state.voiceEncrypted) return 'channelEncryption.lock.voice'
  return state.messagesEncrypted ? 'channelEncryption.lock.messages' : null
})

// State
const showMembersList = ref(false)
const showOptionsMenu = ref(false)
const pinsStore = usePinsStore()
const pinnedCount = computed(() => pinsStore.pinnedCount(pinScopeKey(props.channel?.id)))
const moreBtnRef = ref<HTMLElement | null>(null)
const moreMenu = useMenuButton(showOptionsMenu)
const levelLabelId = uid('channel-level')

const { t } = useI18n()
const { leftDrawerToggle, rightDrawerToggle } = useAppDrawers()
const notificationSettings = useServerNotificationSettingsStore()
const serverId = computed(() => props.server?.id ?? props.channel?.server_id ?? null)
const settings = computed(() => notificationSettings.settingsFor(serverId.value))
const ownOverride = computed(() =>
  props.channel?.id ? findOverride(settings.value, { channelId: props.channel.id }) : null,
)
const categoryMuted = computed(() => {
  const categoryId = props.channel?.category
  return !!categoryId && isMuteActive(findOverride(settings.value, { categoryId }))
})
const ownMuted = computed(() => isMuteActive(ownOverride.value))
const isChannelMuted = computed(() => ownMuted.value || categoryMuted.value)
const muteLabelKey = computed(() => {
  if (ownMuted.value) return 'notificationSettings.header.unmuteChannel'
  if (categoryMuted.value) return 'notificationSettings.header.unmuteCategory'
  return 'notificationSettings.header.muteChannel'
})
/** The channel's own level; null follows its category and the server. */
const channelLevel = computed<NotificationLevel | null>(() => ownOverride.value?.level ?? null)
const levelOptions = computed(() => {
  const inherited = settings.value ? inheritedLevel(settings.value, props.channel?.category) : 'mentions'
  return [
    {
      value: null,
      icon: 'bell',
      label: t('notificationSettings.header.default', { level: t(`notificationSettings.levels.${inherited}`) }),
    },
    { value: 'all' as const, icon: 'bell', label: t('notificationSettings.levels.all') },
    { value: 'mentions' as const, icon: 'at-sign', label: t('notificationSettings.levels.mentions') },
    { value: 'none' as const, icon: 'bell-off', label: t('notificationSettings.levels.none') },
  ]
})

// Methods
// Cached count renders at once; the fetch revalidates it. Realtime rows and
// local pin ops keep it current afterwards.
const loadPinnedCount = () => {
  if (!props.channel?.id) return
  void pinsStore.loadCount(props.channel.id, null, { entering: true })
}

const loadMuteState = () => {
  if (serverId.value) void notificationSettings.load(serverId.value)
}

const setNotificationLevel = (level: NotificationLevel | null) => {
  showOptionsMenu.value = false
  if (!props.channel?.id || !serverId.value) return
  void notificationSettings.updateOverride(serverId.value, { channelId: props.channel.id }, { level })
}

const openServerNotificationSettings = () => {
  showOptionsMenu.value = false
  if (serverId.value) notificationSettings.openModal(serverId.value)
}

const handlePinnedClick = () => {
  emit('show-pinned')
}

const handleMenuPinned = () => {
  showOptionsMenu.value = false
  emit('show-pinned')
}

const handleMenuThreads = () => {
  showOptionsMenu.value = false
  emit('show-threads')
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
  showOptionsMenu.value = !showOptionsMenu.value
}

const handleMarkAsRead = async () => {
  showOptionsMenu.value = false
  if (!props.channel?.id) return

  try {
    const ctx = await authContextService.getCurrentContext()
    if (!ctx.isAuthenticated) return

    try {
      await markChannelRead(props.channel.id)
    } catch (error) {
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

    debug.log('Marked channel as read:', props.channel.name)
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

// A channel muted through its category unmutes the category, as Discord's menu does.
const handleToggleMute = () => {
  showOptionsMenu.value = false
  const channelId = props.channel?.id
  if (!channelId || !serverId.value) return
  if (!ownMuted.value && categoryMuted.value && props.channel.category) {
    void notificationSettings.updateOverride(serverId.value, { categoryId: props.channel.category }, { muted: false })
    return
  }
  void notificationSettings.updateOverride(serverId.value, { channelId }, { muted: !ownMuted.value })
}

watch(() => [props.channel?.id, serverId.value], () => {
  loadPinnedCount()
  loadMuteState()
  showOptionsMenu.value = false
})

onMounted(() => {
  loadPinnedCount()
  loadMuteState()
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
  min-width: 40px;
  min-height: 40px;
  align-items: center;
  justify-content: center;
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
  flex: 0 1 auto;
  min-width: 0;
}

.channel-lock {
  display: inline-flex;
  align-self: center;
  flex-shrink: 0;
  color: var(--text-secondary);
}

.channel-sep {
  color: var(--text-muted);
  font-size: 12px;
  flex-shrink: 0;
  user-select: none;
}

.channel-description {
  /* Zero basis: the name keeps its width until the header runs out. */
  flex: 1 1 0;
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

.action-btn:hover {
  color: var(--text-primary);
  background: var(--background-secondary);
}

/* Open panel or menu. */
.action-btn.active {
  color: var(--icon-active);
  background: var(--background-modifier-selected);
}

.pinned-btn {
  position: relative;
}

.pinned-count {
  position: absolute;
  top: -4px;
  right: -4px;
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font-size: 10px;
  font-weight: 600;
  padding: 2px 5px;
  border-radius: var(--radius-full);
  min-width: 16px;
  text-align: center;
  line-height: 1.2;
}

.pinned-btn.has-pins {
  color: var(--text-link);
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

  /* Mobile keeps search + members + overflow; pinned and threads move
     into the overflow menu. */
  .pinned-btn,
  .threads-btn {
    display: none;
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

.chat-menu.more-menu .check-icon {
  margin-left: auto;
}

.chat-menu.more-menu .item-active {
  color: var(--text-link);
}

.chat-menu.more-menu .item-active:hover,
.chat-menu.more-menu .item-active:focus-visible {
  color: var(--text-on-primary);
}
</style>
