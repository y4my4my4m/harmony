<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="isVisible" class="pinned-messages-overlay" @click.self="close">
        <div class="pinned-messages-drawer">
          <div class="drawer-header">
            <div class="header-content">
              <div class="header-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12,2L15.09,8.26L22,9.27L17,14.14L18.18,21.02L12,17.77L5.82,21.02L7,14.14L2,9.27L8.91,8.26L12,2Z"/>
                </svg>
              </div>
              <div class="header-text">
                <h3>Pinned Messages</h3>
                <p v-if="pinnedCount > 0">{{ pinnedCount }} message{{ pinnedCount !== 1 ? 's' : '' }}</p>
                <p v-else>No pinned messages</p>
              </div>
            </div>
            <button class="close-btn" @click="close" title="Close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div class="drawer-content">
            <div v-if="loading" class="loading-state">
              <LoadingSpinner :size="32" />
              <p>Loading pinned messages...</p>
            </div>

            <div v-else-if="pinnedMessages.length === 0" class="empty-state">
              <div class="empty-icon">📌</div>
              <p>No pinned messages yet</p>
              <p class="empty-hint">Pin important messages to find them easily</p>
            </div>

            <div v-else class="pinned-messages-list">
              <div
                v-for="message in pinnedMessages"
                :key="message.id"
                class="pinned-message-item"
                @click="jumpToMessage(message.id)"
              >
                <div class="message-header">
                  <Avatar
                    :src="getUserAvatar(message.user_id)"
                    :alt="getUserDisplayName(message.user_id)"
                    size="sm"
                    class="message-avatar"
                  />
                  <div class="message-info">
                    <div class="message-author" :style="{ color: getUserColorValue(message.user_id) }">
                      <DisplayName :userId="message.user_id" :fallback="getUserDisplayName(message.user_id)" />
                    </div>
                    <div class="message-time">
                      {{ formatTimestamp(message.created_at) }}
                    </div>
                  </div>
                  <div class="message-actions">
                    <button
                      v-if="canUnpin"
                      class="action-btn unpin-btn"
                      @click.stop="unpinMessage(message.id)"
                      title="Unpin"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12,2L15.09,8.26L22,9.27L17,14.14L18.18,21.02L12,17.77L5.82,21.02L7,14.14L2,9.27L8.91,8.26L12,2Z"/>
                      </svg>
                    </button>
                  </div>
                </div>
                <div class="message-content">
                  <UnifiedMessageContent
                    :content="message.content"
                    :message-id="message.id"
                    :embed-payloads="message.metadata?.embeds"
                  />
                </div>
                <div v-if="message.metadata?.pinner" class="pinned-by">
                  Pinned by {{ message.metadata.pinner.display_name || message.metadata.pinner.username }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { messageService } from '@/services'
import { useServerPermissions } from '@/composables/useServerPermissions'
import { useUserData } from '@/composables/useUserData'
import { format } from 'date-fns'
import Avatar from '@/components/common/Avatar.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import DisplayName from '@/components/DisplayName.vue'
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'
import type { Message } from '@/types'

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

const { canPinMessages } = useServerPermissions()
const { 
  getUserDisplayName: getDisplayName, 
  getUserColor: getColor,
  getUserAvatarUrl: getAvatarUrl
} = useUserData()

const pinnedMessages = ref<Message[]>([])
const loading = ref(false)
const pinnedCount = computed(() => pinnedMessages.value.length)
const canUnpin = computed(() => canPinMessages.value)

const loadPinnedMessages = async () => {
  if (!props.channelId && !props.conversationId) return

  loading.value = true
  try {
    if (props.channelId) {
      pinnedMessages.value = await messageService.getPinnedChannelMessages(props.channelId)
    } else if (props.conversationId) {
      pinnedMessages.value = await messageService.getPinnedDMMessages(props.conversationId)
    }
  } catch (error) {
    console.error('Failed to load pinned messages:', error)
  } finally {
    loading.value = false
  }
}

const unpinMessage = async (messageId: string) => {
  try {
    await messageService.unpinMessage(messageId)
    pinnedMessages.value = pinnedMessages.value.filter(m => m.id !== messageId)
  } catch (error) {
    console.error('Failed to unpin message:', error)
  }
}

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
  max-height: 70vh;
  margin: 20px;
  background: var(--background-secondary);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
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
  color: var(--harmony-primary);
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
  background: var(--background-secondary);
  color: var(--text-primary);
}

.drawer-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.empty-state p {
  margin: 8px 0;
  color: var(--text-secondary);
}

.empty-hint {
  font-size: 12px;
  opacity: 0.7;
}

.pinned-messages-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
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
  background: var(--background-hover);
  border-color: var(--harmony-primary);
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

.message-author {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 14px;
}

.message-time {
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

.pinned-by {
  margin-left: 48px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
}

.pinned-by::before {
  content: '📌';
  font-size: 10px;
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
    max-height: 90vh;
    margin: 0;
    border-radius: 12px;
  }
}
</style>

