<template>
  <div class="dm-message-display">
    <div
      v-for="message in messages"
      :key="message.id"
      class="message-wrapper"
      :class="{ 'own-message': isOwnMessage(message.user_id) }"
    >
      <!-- Message content -->
      <div class="message-content">
        <div class="message-header">
          <img
            :src="getUserAvatar(message.user_id)"
            :alt="getUserDisplayName(message.user_id)"
            class="user-avatar"
          />
          <span class="username">{{ getUserDisplayName(message.user_id) }}</span>
          <span class="timestamp">{{ formatTime(message.created_at) }}</span>
        </div>
        
        <!-- Reply indicator -->
        <div v-if="message.reply_to" class="reply-indicator">
          <i class="icon-reply"></i>
          Replying to message
        </div>
        
        <!-- Message parts -->
        <div class="message-parts">
          <template v-for="(part, index) in message.content" :key="index">
            <span v-if="part.type === 'text'">{{ part.text }}</span>
            
            <img
              v-else-if="part.type === 'emoji' && 'emoji' in part"
              class="custom-emoji"
              :src="part.emoji.url"
              :alt="part.emoji.name"
              :title="`:${part.emoji.name}:`"
            />
            
            <div
              v-else-if="part.type === 'file'"
              class="file-attachment"
            >
              <img
                v-if="'fileType' in part && part.fileType === 'image'"
                class="image-attachment"
                @click="openImageModal(part.url)"
                :src="part.url"
                :alt="'Image'"
              />
              <video
                v-else-if="'fileType' in part && part.fileType === 'video'"
                class="video-attachment"
                controls
                :src="part.url"
              />
              <div v-else class="generic-file">
                <div class="file-icon">📄</div>
                <div class="file-info">
                  <div class="file-name">File</div>
                  <div class="file-size">Unknown size</div>
                </div>
                <a :href="part.url" download class="file-download">
                  Download
                </a>
              </div>
            </div>
            
            <a
              v-else-if="part.type === 'url' && 'url' in part"
              :href="part.url"
              target="_blank"
              rel="noopener noreferrer"
              class="url-link"
            >
              {{ part.url }}
            </a>
            
            <span
              v-else-if="part.type === 'mention' && 'mention' in part"
              class="mention"
            >
              {{ part.mention }}
            </span>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Message } from '@/types'
import { type DMUser } from '@/stores/useDM'
import { useAuthStore } from '@/stores/auth'

interface Props {
  messages: Message[]
  otherUser?: DMUser
}

const props = defineProps<Props>()

const authStore = useAuthStore()

const currentUserId = computed(() => authStore.user?.id || '')

const isOwnMessage = (userId: string) => {
  return userId === currentUserId.value
}

const getUserDisplayName = (userId: string) => {
  if (userId === currentUserId.value) {
    return authStore.user?.display_name || authStore.user?.username || 'You'
  }
  return props.otherUser?.display_name || props.otherUser?.username || 'User'
}

const getUserAvatar = (userId: string) => {
  if (userId === currentUserId.value) {
    return authStore.user?.avatar_url || '/default_avatar.png'
  }
  return props.otherUser?.avatar_url || '/default_avatar.png'
}

const formatTime = (timestamp: Date) => {
  return timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const openImageModal = (url: string) => {
  window.open(url, '_blank')
}
</script>

<style scoped>
.dm-message-display {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.message-wrapper {
  display: flex;
  flex-direction: column;
}

.message-wrapper.own-message {
  align-items: flex-end;
}

.message-wrapper.own-message .message-content {
  background: var(--accent-color, #007acc);
  color: white;
  border-radius: 18px 18px 4px 18px;
}

.message-content {
  max-width: 70%;
  padding: 0.75rem 1rem;
  background: var(--message-bg, #f1f3f4);
  border-radius: 18px 18px 18px 4px;
  position: relative;
}

.message-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
  font-size: 0.875rem;
}

.user-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
}

.username {
  font-weight: 600;
  color: var(--text-primary, #333);
}

.own-message .username {
  color: rgba(255, 255, 255, 0.9);
}

.timestamp {
  color: var(--text-secondary, #666);
  font-size: 0.75rem;
  margin-left: auto;
}

.own-message .timestamp {
  color: rgba(255, 255, 255, 0.7);
}

.reply-indicator {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--text-secondary, #666);
  margin-bottom: 0.25rem;
}

.own-message .reply-indicator {
  color: rgba(255, 255, 255, 0.7);
}

.message-parts {
  line-height: 1.4;
  word-wrap: break-word;
}

.custom-emoji {
  width: 20px;
  height: 20px;
  vertical-align: text-bottom;
  margin: 0 2px;
}

.file-attachment {
  margin: 0.5rem 0;
}

.image-attachment {
  max-width: 300px;
  max-height: 200px;
  border-radius: 8px;
  cursor: pointer;
  transition: opacity 0.2s;
}

.image-attachment:hover {
  opacity: 0.8;
}

.video-attachment {
  max-width: 300px;
  border-radius: 8px;
}

.generic-file {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem;
  background: var(--surface, white);
  border-radius: 8px;
  border: 1px solid var(--border, #e1e5e9);
}

.file-icon {
  font-size: 2rem;
}

.file-info {
  flex: 1;
}

.file-name {
  font-weight: 500;
  margin-bottom: 0.25rem;
}

.file-size {
  font-size: 0.875rem;
  color: var(--text-secondary, #666);
}

.file-download {
  padding: 0.5rem 1rem;
  background: var(--accent-color, #007acc);
  color: white;
  text-decoration: none;
  border-radius: 4px;
  font-size: 0.875rem;
  transition: background-color 0.2s;
}

.file-download:hover {
  background: var(--accent-hover, #005999);
}

.url-link {
  color: var(--accent-color, #007acc);
  text-decoration: underline;
}

.own-message .url-link {
  color: rgba(255, 255, 255, 0.9);
}

.mention {
  background: var(--mention-bg, #e3f2fd);
  color: var(--mention-color, #1976d2);
  padding: 0 0.25rem;
  border-radius: 3px;
  font-weight: 500;
}

.own-message .mention {
  background: rgba(255, 255, 255, 0.2);
  color: white;
}

.dm-message-display::-webkit-scrollbar {
  width: 8px;
}

.dm-message-display::-webkit-scrollbar-track {
  background: var(--surface, #f1f1f1);
}

.dm-message-display::-webkit-scrollbar-thumb {
  background: var(--border, #c1c1c1);
  border-radius: 4px;
}

.dm-message-display::-webkit-scrollbar-thumb:hover {
  background: var(--text-secondary, #a1a1a1);
}
</style>