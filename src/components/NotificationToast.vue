<template>
  <Teleport to="body">
    <div class="notification-toasts" data-testid="notification-toasts">
      <TransitionGroup name="toast" tag="div">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="notification-toast"
          :class="`toast-${toast.type}`"
          :data-testid="`notification-toast-${toast.type}`"
          :data-toast-id="toast.id"
          @click="handleToastClick(toast)"
        >
          <div class="toast-icon">
            <Avatar 
              v-if="toast.avatar" 
              :src="toast.avatar" 
              :alt="toast.title"
              class="toast-avatar"
              @error="handleAvatarError"
            />
            <div v-else class="toast-type-icon" :class="`type-${toast.type}`">
              <component :is="getTypeIcon(toast.type)" />
            </div>
          </div>
          
          <div class="toast-content">
            <h4 class="toast-title">
              <template v-if="toast.type === 'activitypub_reaction' || toast.type === 'reaction'">
                <!-- For reactions, show emoji inline in title -->
                <template v-if="toast.type === 'activitypub_reaction'">
                  <span v-if="toast.actorUserId"><DisplayName :user-id="toast.actorUserId" :truncate="true" /></span>
                  <span v-else>{{ toast.title.split('reacted')[0] }}</span>reacted
                  <img 
                    v-if="toast.emojiUrl"
                    :src="toast.emojiUrl" 
                    :alt="toast.emojiName || 'emoji'"
                    :title="toast.emojiName ? `:${toast.emojiName}:` : ''"
                    class="toast-emoji"
                  />
                  <span 
                    v-else-if="toast.emojiName"
                    class="toast-emoji-fallback"
                  >
                    :{{ toast.emojiName }}:
                  </span>
                  <span v-if="toast.actorUserId && toast.titleSuffix">{{ toast.titleSuffix.replace(/^.*?reacted/, '') }}</span>
                  <span v-else>{{ toast.title.split('reacted')[1] }}</span>
                </template>
                <template v-else>
                  <template v-if="toast.actorUserId && toast.titleSuffix">
                    <DisplayName :user-id="toast.actorUserId" :truncate="true" /><span>{{ toast.titleSuffix }}</span>
                  </template>
                  <template v-else>{{ toast.title }}</template>
                  <img 
                    v-if="toast.emojiUrl"
                    :src="toast.emojiUrl" 
                    :alt="toast.emojiName || 'emoji'"
                    :title="toast.emojiName ? `:${toast.emojiName}:` : ''"
                    class="toast-emoji"
                  />
                  <span 
                    v-else-if="toast.emojiName"
                    class="toast-emoji-fallback"
                  >
                    :{{ toast.emojiName }}:
                  </span>
                </template>
              </template>
              <template v-else-if="toast.actorUserId && toast.titleSuffix">
                <DisplayName :user-id="toast.actorUserId" :truncate="true" /><span>{{ toast.titleSuffix }}</span>
              </template>
              <template v-else>
                {{ toast.title }}
              </template>
            </h4>
            <p v-if="toast.message" class="toast-message">{{ toast.message }}</p>
            <div class="toast-actions" v-if="toast.actions">
              <button
                v-for="action in toast.actions"
                :key="action.label"
                @click.stop="action.action"
                class="toast-action-btn"
                :class="action.style || 'primary'"
              >
                {{ action.label }}
              </button>
            </div>
          </div>
          
          <button @click.stop="removeToast(toast.id)" class="toast-close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
          
          <!-- Progress bar -->
          <div class="toast-progress">
            <div 
              class="toast-progress-bar"
              :style="{ animationDuration: `${toast.duration}ms` }"
            ></div>
          </div>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, h } from 'vue'
import { useNotificationStore } from '@/stores/useNotification'
import type { NotificationToast, NotificationType } from '@/types'
import Avatar from './common/Avatar.vue'
import DisplayName from './DisplayName.vue'

const notificationStore = useNotificationStore()

// Computed
const toasts = computed(() => notificationStore.toasts)

// Methods
const removeToast = (toastId: string) => {
  notificationStore.removeToast(toastId)
}

const handleToastClick = (toast: NotificationToast) => {
  // Navigate to the source notification's target (DM, channel, post, profile…),
  // reusing the same routing + mark-as-read logic as the notification bell.
  if (toast.notificationId) {
    const notification = notificationStore.notifications.find(
      n => n.id === toast.notificationId
    )
    if (notification) {
      notificationStore.handleNotificationClick(notification)
    }
  }
  removeToast(toast.id)
}

const handleAvatarError = (event: Event) => {
  const target = event.target as HTMLImageElement
  target.src = '/default_avatar.webp'
}

const getTypeIcon = (type: NotificationType) => {
  const iconMap = {
    mention: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c1.5 0 2.91-.33 4.18-.93L21 24l-2.07-4.82C20.26 17.07 21 14.63 21 12c0-5.52-4.48-10-10-10zm0 15c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm1-3h-2V7h2v7z' })
    ]),
    dm: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z' })
    ]),
    reaction: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z' })
    ]),
    reply: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z' })
    ]),
    server_invite: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z' })
    ]),
    friend_request: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M16 4c0-1.11.89-2 2-2s2 .89 2 2-.89 2-2 2-2-.89-2-2zm4 18v-6h2.5l-2.54-7.63A3.014 3.014 0 0 0 16.96 6c-.8 0-1.54.37-2.01.97L12.5 10 8 6H6v4h2l3.5 4v8z' })
    ]),
    voice_channel_activity: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z' })
    ]),
    server_update: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z' })
    ]),
    emoji_added: () => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11z' })
    ])
  }
  
  const map = iconMap as Record<string, () => any>
  return map[type] || iconMap.mention
}
</script>

<style scoped>
.notification-toasts {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 10000;
  display: flex;
  flex-direction: column-reverse;
  gap: 12px;
  pointer-events: none;
}

.notification-toast {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: var(--background-secondary);
  border: 1px solid var(--background-quaternary);
  border-radius: 8px;
  padding: 16px;
  min-width: 300px;
  max-width: 400px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  cursor: pointer;
  pointer-events: all;
  position: relative;
  overflow: hidden;
  backdrop-filter: blur(8px);
  margin-bottom: 10px;
}

.notification-toast::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  width: 4px;
  height: 100%;
  background: var(--toast-color, var(--h-brand));
}

.toast-mention {
  --toast-color: #f04747;
}

.toast-dm {
  --toast-color: #38BDF8;
}

.toast-reaction {
  --toast-color: #faa61a;
}

.toast-reply {
  --toast-color: #43b581;
}

.toast-server_invite {
  --toast-color: #9c84ef;
}

.toast-friend_request {
  --toast-color: #43b581;
}

.toast-voice_channel_activity {
  --toast-color: #38BDF8;
}

.toast-server_update {
  --toast-color: #99aab5;
}

.toast-emoji_added {
  --toast-color: #faa61a;
}

.toast-icon {
  flex-shrink: 0;
}

.toast-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
}

.toast-type-icon {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--toast-color, var(--h-brand));
  color: var(--text-primary);
}

.toast-content {
  flex: 1;
  min-width: 0;
}

.toast-title {
  margin: 0 0 4px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.3;
  flex-wrap: wrap;
  display: flex;
  align-items: center;
  gap: 6px;
}

.toast-message {
  margin: 0 0 8px 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.4;
  word-wrap: break-word;
}

.toast-title :deep(.display-name-emoji) {
  width: 18px;
  height: 18px;
  vertical-align: -3px;
}

.toast-emoji {
  width: 20px;
  height: 20px;
  object-fit: contain;
  flex-shrink: 0;
  vertical-align: middle;
}

.toast-emoji-fallback {
  font-size: 14px;
  color: var(--text-secondary);
}

.toast-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.toast-action-btn {
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.toast-action-btn.primary {
  background: var(--h-brand);
  color: var(--text-primary);
}

.toast-action-btn.primary:hover {
  background: #677bc4;
}

.toast-action-btn.secondary {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--background-quaternary);
}

.toast-action-btn.secondary:hover {
  background: rgba(79, 84, 92, 0.16);
  color: var(--text-secondary);
}

.toast-action-btn.danger {
  background: #f04747;
  color: var(--text-primary);
}

.toast-action-btn.danger:hover {
  background: #d63939;
}

.toast-close {
  position: absolute;
  top: 8px;
  right: 8px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  padding: 4px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  opacity: 0;
}

.notification-toast:hover .toast-close {
  opacity: 1;
}

.toast-close:hover {
  background: rgba(79, 84, 92, 0.16);
  color: var(--text-secondary);
}

.toast-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 3px;
  background: rgba(0, 0, 0, 0.1);
}

.toast-progress-bar {
  height: 100%;
  background: var(--toast-color, var(--h-brand));
  width: 100%;
  transform-origin: left;
  animation: toast-progress linear forwards;
}

@keyframes toast-progress {
  from {
    transform: scaleX(1);
  }
  to {
    transform: scaleX(0);
  }
}

/* Transitions */
.toast-enter-active {
  transition: all 0.3s ease;
}

.toast-leave-active {
  transition: all 0.3s ease;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(100%) scale(0.95);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(100%) scale(0.95);
}

.toast-move {
  transition: transform 0.3s ease;
}

/* Responsive design */
@media (max-width: 768px) {
  .notification-toasts {
    top: env(safe-area-inset-top, 10px);
    right: 10px;
    left: 10px;
    bottom: auto;
    flex-direction: column;
  }

  .notification-toast {
    min-width: 0;
    max-width: none;
  }
}

@media (max-width: 480px) {
  .notification-toast {
    padding: 12px;
  }
  
  .toast-avatar,
  .toast-type-icon {
    width: 32px;
    height: 32px;
  }
  
  .toast-title {
    font-size: 13px;
  }
  
  .toast-message {
    font-size: 12px;
  }
}
</style>