<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="isVisible" class="pinned-messages-overlay" @click.self="close">
        <div
          ref="drawerEl"
          class="pinned-messages-drawer"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          :aria-describedby="descriptionId"
          tabindex="-1"
        >
          <div class="drawer-header">
            <div class="header-content">
              <div class="header-icon" aria-hidden="true">
                <Icon name="pin" :size="20" />
              </div>
              <div class="header-text">
                <h3 :id="titleId">{{ t('message.pinned') }}</h3>
                <p :id="descriptionId">{{ pinnedCount > 0 ? t('chatNav.pinned.count', { count: pinnedCount }, pinnedCount) : t('chatNav.pinned.none') }}</p>
              </div>
            </div>
            <button type="button" class="close-btn" :title="t('common.close')" :aria-label="t('common.close')" @click="close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div class="drawer-content">
            <div v-if="loading" class="loading-state" role="status">
              <LoadingSpinner :size="32" />
              <p>{{ t('chatNav.pinned.loading') }}</p>
            </div>

            <EmptyState
              v-else-if="pinnedMessages.length === 0"
              icon="pin"
              :title="$t('empty.pins.title')"
              :description="$t('empty.pins.description')"
            />

            <ul v-else class="pinned-messages-list">
              <li
                v-for="message in pinnedMessages"
                :key="message.id"
                class="pinned-message-item"
                @click="jumpToMessage(message.id)"
              >
                <div class="message-header">
                  <Avatar
                    :src="getUserAvatar(message.user_id)"
                    size="sm"
                    class="message-avatar"
                  />
                  <!-- The author and time are the jump control; the list item stays clickable for the pointer. -->
                  <button type="button" class="message-info jump-btn" @click.stop="jumpToMessage(message.id)">
                    <span class="message-author" :style="{ color: getUserColorValue(message.user_id) }">
                      <DisplayName :userId="message.user_id" :fallback="getUserDisplayName(message.user_id)" />
                    </span>
                    <span class="message-time">
                      {{ formatTimestamp(message.created_at) }}
                    </span>
                    <span class="sr-only">{{ t('chatNav.pinned.jump') }}</span>
                  </button>
                  <div class="message-actions">
                    <button
                      v-if="canUnpin"
                      type="button"
                      class="action-btn unpin-btn"
                      :title="t('chatNav.pinned.unpin')"
                      :aria-label="t('chatNav.pinned.unpin')"
                      @click.stop="unpinMessage(message.id)"
                    >
                      <Icon name="pin-off" :size="16" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <div class="message-content">
                  <p v-if="isUndecrypted(message)" class="encrypted-preview">
                    <Icon name="lock" :size="12" />
                    <span>{{ $t('channelEncryption.encryptedMessage') }}</span>
                  </p>
                  <UnifiedMessageContent
                    v-else
                    :content="message.content"
                    :message-id="message.id"
                    :embed-payloads="message.metadata?.embeds"
                    :media-hidden="mediaHidden"
                  />
                </div>
                <div v-if="message.metadata?.pinner" class="pinned-by">
                  <Icon name="pin" :size="10" aria-hidden="true" />
                  {{ t('chatNav.pinned.by', { name: message.metadata.pinner.display_name || message.metadata.pinner.username }) }}
                </div>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDialog } from '@/composables/useDialog'
import { useServerPermissions } from '@/composables/useServerPermissions'
import { useChannelMessagePermissions } from '@/composables/useChannelMessagePermissions'
import { useServerMediaHidden } from '@/composables/useInstanceMediaHidden'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { usePinActions } from '@/composables/usePinActions'
import { usePinsStore, pinScopeKey } from '@/stores/usePins'
import { useUserData } from '@/composables/useUserData'
import { format } from 'date-fns'
import Avatar from '@/components/common/Avatar.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import DisplayName from '@/components/DisplayName.vue'
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'
import type { Message } from '@/types'
import { isUndecrypted } from '@/utils/channelEncryption'

interface Props {
  isVisible: boolean
  channelId?: string
  conversationId?: string
}

const props = defineProps<Props>()
const emit = defineEmits<{
  close: []
  'jump-to-message': [messageId: string]
}>()

const { isLocalServer } = useServerPermissions()
// Channel-resolved, as unpin_message decides it.
const serverChannelStore = useServerChannelStore()
const mediaHidden = useServerMediaHidden(() => (props.conversationId ? null : serverChannelStore.currentServerId))
const { canPinMessages: canPinInChannel } = useChannelMessagePermissions(
  () => serverChannelStore.currentServerId,
  () => (props.conversationId ? null : props.channelId),
)
const { 
  getUserDisplayName: getDisplayName, 
  getUserColor: getColor,
  getUserAvatarUrl: getAvatarUrl
} = useUserData()

const pinsStore = usePinsStore()
const { setPinned } = usePinActions()
const { t } = useI18n()

const drawerEl = ref<HTMLElement | null>(null)
const { titleId, descriptionId } = useDialog({
  open: () => props.isVisible,
  element: drawerEl,
  onClose: () => close(),
  initialFocus: 'dialog',
})

// In DMs the layout still passes the last channel id; the conversation wins.
const scope = computed(() => pinScopeKey(
  props.conversationId ? null : props.channelId,
  props.conversationId,
))
const cachedMessages = computed(() => pinsStore.pinnedMessages(scope.value))
const pinnedMessages = computed<Message[]>(() => cachedMessages.value ?? [])
const loadFailed = ref(false)
// Spinner only before the first fetch; later opens render the cached list.
const loading = computed(() => cachedMessages.value === null && !loadFailed.value)
const pinnedCount = computed(() => pinnedMessages.value.length)
// Any participant unpins in a conversation (unpin_message); a copy's pins are the host's.
const canUnpin = computed(() =>
  !!props.conversationId || (isLocalServer.value && canPinInChannel.value))

const loadPinnedMessages = async () => {
  if (!scope.value) return
  loadFailed.value = false
  try {
    await pinsStore.loadList(
      props.conversationId ? null : props.channelId,
      props.conversationId,
    )
  } catch (error) {
    loadFailed.value = true
    console.error('Failed to load pinned messages:', error)
  }
}

const unpinMessage = (messageId: string) => {
  const message = pinnedMessages.value.find(m => m.id === messageId)
  if (message) void setPinned(message, false)
}

// A remote pin for a message not held locally leaves the list incomplete.
watch(() => pinsStore.isListStale(scope.value), (stale) => {
  if (stale && props.isVisible) loadPinnedMessages()
})

const jumpToMessage = (messageId: string) => {
  emit('jump-to-message', messageId)
  close()
}

const close = () => {
  emit('close')
}

const getUserDisplayName = (userId?: string) => {
  if (!userId) return 'Unknown'
  return getDisplayName(userId).value
}

const getUserColorValue = (userId?: string) => {
  if (!userId) return undefined
  return getColor(userId).value
}

const getUserAvatar = (userId?: string) => {
  if (!userId) return '/default_avatar.webp'
  return getAvatarUrl(userId).value
}

const formatTimestamp = (date: Date | string) => {
  try {
    const d = typeof date === 'string' ? new Date(date) : date
    return format(d, 'MMM d, yyyy h:mm a')
  } catch {
    return ''
  }
}

watch(() => props.isVisible, (visible) => {
  if (visible) {
    loadPinnedMessages()
  }
})

onMounted(() => {
  if (props.isVisible) {
    loadPinnedMessages()
  }
})
</script>

<style scoped>
.pinned-messages-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pinned-messages-drawer {
  width: 100%;
  max-width: 520px;
  max-height: calc(70 * var(--app-vh));
  margin: 20px;
  background: var(--background-secondary);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-large);
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.header-content {
  display: flex;
  align-items: center;
  gap: 12px;
}

.header-icon {
  color: var(--text-link);
  display: flex;
  align-items: center;
}

.header-text h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.header-text p {
  margin: 2px 0 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  transition: all 0.2s;
}

.close-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.drawer-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
}

.pinned-messages-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.pinned-message-item {
  padding: 12px;
  background: var(--background-tertiary);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid var(--border-color);
}

.pinned-message-item:hover {
  background: var(--background-quaternary);
  border-color: var(--border-hover);
}

.message-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.message-avatar {
  flex-shrink: 0;
}

.message-info {
  flex: 1;
  min-width: 0;
}

.jump-btn {
  display: block;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: none;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.jump-btn:focus-visible {
  outline: 2px solid var(--border-focus, var(--harmony-primary));
  outline-offset: 2px;
}

.message-author {
  display: block;
  font-weight: 600;
  color: var(--text-primary);
  font-size: 14px;
}

.message-time {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.message-actions {
  display: flex;
  gap: 4px;
}

.action-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  transition: all 0.2s;
}

.action-btn:hover {
  background: var(--background-primary);
  color: var(--text-primary);
}

.message-content {
  margin-left: 48px; /* Avatar sm (32px) + gap (12px) + small offset */
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
}

.encrypted-preview {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--font-size-sm);
  font-style: italic;
  color: var(--text-muted);
}

.pinned-by {
  margin-left: 48px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
}

/* Modal transition */
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity 0.2s ease;
}

.drawer-enter-active .pinned-messages-drawer,
.drawer-leave-active .pinned-messages-drawer {
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}

.drawer-enter-from .pinned-messages-drawer,
.drawer-leave-to .pinned-messages-drawer {
  transform: scale(0.95);
  opacity: 0;
}

/* Mobile */
@media (max-width: 768px) {
  .pinned-messages-drawer {
    max-height: calc(90 * var(--app-vh));
    margin: 0;
    border-radius: 12px;
  }
}
</style>

