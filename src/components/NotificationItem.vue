<template>
  <div 
    class="notification-item" 
    :class="{ 
      'unread': !notification.is_read,
      'clicked': notification.is_clicked 
    }"
    @click="handleClick"
  >
    <div class="notification-avatar">
      <img 
        :src="avatarUrl" 
        :alt="notification.data.username || 'User'"
        @error="handleAvatarError"
      />
      <div class="notification-type-icon" :class="`type-${notification.type}`">
        <component :is="getTypeIcon()" />
      </div>
    </div>
    
    <div class="notification-content">
      <div class="notification-header">
        <h4 class="notification-title">{{ notification.title }}</h4>
        <span class="notification-time">{{ formatTime(notification.created_at) }}</span>
      </div>
      
      <p v-if="notification.message" class="notification-message">
        {{ notification.message }}
      </p>
      
      <div v-if="hasMetadata" class="notification-metadata">
        <span v-if="notification.data.server_name" class="server-name">
          {{ notification.data.server_name }}
        </span>
        <span v-if="notification.data.channel_name" class="channel-name">
          #{{ notification.data.channel_name }}
        </span>
      </div>
    </div>
    
    <div class="notification-actions">
      <button 
        v-if="!notification.is_read"
        @click.stop="markAsRead"
        class="mark-read-btn"
        title="Mark as read"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
      </button>
      
      <button 
        @click.stop="dismissNotification"
        class="dismiss-btn"
        title="Dismiss"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, h } from 'vue'
import type { Notification } from '@/types'

interface Props {
  notification: Notification
}

interface Emits {
  (e: 'click', notification: Notification): void
  (e: 'mark-read', notificationId: string): void
  (e: 'dismiss', notificationId: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

// Computed properties
const avatarUrl = computed(() => 
  props.notification.data.avatar_url || '/default_avatar.png'
)

const hasMetadata = computed(() => 
  props.notification.data.server_name || props.notification.data.channel_name
)

// Methods
const handleClick = () => {
  emit('click', props.notification)
}

const markAsRead = () => {
  emit('mark-read', props.notification.id)
}

const dismissNotification = () => {
  emit('dismiss', props.notification.id)
}

const handleAvatarError = (event: Event) => {
  const target = event.target as HTMLImageElement
  target.src = '/default_avatar.png'
}

const formatTime = (timestamp: string): string => {
  const date = new Date(timestamp)
  const now = new Date()
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000)
  
  if (diffInSeconds < 60) {
    return 'just now'
  } else if (diffInSeconds < 3600) {
    const minutes = Math.floor(diffInSeconds / 60)
    return `${minutes}m ago`
  } else if (diffInSeconds < 86400) {
    const hours = Math.floor(diffInSeconds / 3600)
    return `${hours}h ago`
  } else if (diffInSeconds < 604800) {
    const days = Math.floor(diffInSeconds / 86400)
    return `${days}d ago`
  } else {
    return date.toLocaleDateString()
  }
}

const getTypeIcon = () => {
  const iconMap = {
    mention: () => h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c1.5 0 2.91-.33 4.18-.93L21 24l-2.07-4.82C20.26 17.07 21 14.63 21 12c0-5.52-4.48-10-10-10zm0 15c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm1-3h-2V7h2v7z' })
    ]),
    dm: () => h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z' })
    ]),
    reaction: () => h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z' })
    ]),
    reply: () => h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z' })
    ]),
    server_invite: () => h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z' })
    ]),
    friend_request: () => h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M16 4c0-1.11.89-2 2-2s2 .89 2 2-.89 2-2 2-2-.89-2-2zm4 18v-6h2.5l-2.54-7.63A3.014 3.014 0 0 0 16.96 6c-.8 0-1.54.37-2.01.97L12.5 10 8 6H6v4h2l3.5 4v8z' })
    ]),
    voice_channel_activity: () => h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z' })
    ]),
    server_update: () => h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z' })
    ]),
    emoji_added: () => h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor' }, [
      h('path', { d: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11z' })
    ])
  }
  
  return iconMap[props.notification.type] || iconMap.mention
}
</script>

<style scoped>
.notification-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  border-left: 3px solid transparent;
  position: relative;
}

.notification-item:hover {
  background: rgba(79, 84, 92, 0.16);
}

.notification-item.unread {
  background: rgba(88, 101, 242, 0.1);
  border-left-color: var(--h-brand);
}

.notification-item.unread::before {
  content: '';
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 8px;
  height: 8px;
  background: var(--h-brand);
  border-radius: 50%;
}

.notification-item.clicked {
  opacity: 0.7;
}

.notification-avatar {
  position: relative;
  flex-shrink: 0;
}

.notification-avatar img {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
}

.notification-type-icon {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--h-chat);
}

.type-mention {
  background: #f04747;
  color: #ffffff;
}

.type-dm {
  background: #7289da;
  color: #ffffff;
}

.type-reaction {
  background: #faa61a;
  color: #ffffff;
}

.type-reply {
  background: #43b581;
  color: #ffffff;
}

.type-server_invite {
  background: #9c84ef;
  color: #ffffff;
}

.type-friend_request {
  background: #43b581;
  color: #ffffff;
}

.type-voice_channel_activity {
  background: #7289da;
  color: #ffffff;
}

.type-server_update {
  background: #99aab5;
  color: #ffffff;
}

.type-emoji_added {
  background: #faa61a;
  color: #ffffff;
}

.notification-content {
  flex: 1;
  min-width: 0;
}

.notification-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.notification-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  line-height: 1.3;
  flex: 1;
}

.notification-time {
  font-size: 11px;
  color: #72767d;
  white-space: nowrap;
  flex-shrink: 0;
}

.notification-message {
  margin: 0 0 8px 0;
  font-size: 13px;
  color: #dcddde;
  line-height: 1.4;
  word-wrap: break-word;
}

.notification-metadata {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #72767d;
}

.server-name {
  font-weight: 600;
}

.channel-name {
  color: #7289da;
}

.notification-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.notification-item:hover .notification-actions {
  opacity: 1;
}

.mark-read-btn,
.dismiss-btn {
  background: transparent;
  border: none;
  color: #72767d;
  padding: 6px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mark-read-btn:hover {
  background: rgba(67, 181, 129, 0.1);
  color: #43b581;
}

.dismiss-btn:hover {
  background: rgba(240, 71, 71, 0.1);
  color: #f04747;
}

/* Responsive design */
@media (max-width: 480px) {
  .notification-item {
    padding: 10px 12px;
  }
  
  .notification-avatar img {
    width: 32px;
    height: 32px;
  }
  
  .notification-type-icon {
    width: 14px;
    height: 14px;
  }
  
  .notification-title {
    font-size: 13px;
  }
  
  .notification-message {
    font-size: 12px;
  }
}
</style>