<template>
  <div 
    v-if="isVisible" 
    class="context-menu"
    :style="{ top: position.y + 'px', left: position.x + 'px' }"
    @click.stop
  >
    <div class="context-menu-item" @click="copyMessageURL">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M10,13C10.55,13 11,13.45 11,14V16C11,16.55 11.45,17 12,17C12.55,17 13,16.55 13,16V14C13,13.45 13.45,13 14,13C14.55,13 15,12.55 15,12C15,11.45 14.55,11 14,11H10C9.45,11 9,11.45 9,12C9,12.55 9.45,13 10,13M16.5,3C14.76,3 13.09,3.81 12,5.09C10.91,3.81 9.24,3 7.5,3C4.42,3 2,5.42 2,8.5C2,12.28 5.4,15.36 10.55,20.04L12,21.35L13.45,20.03C18.6,15.36 22,12.28 22,8.5C22,5.42 19.58,3 16.5,3Z" />
      </svg>
      <span>Copy Message URL</span>
    </div>
    
    <template v-if="hasMediaURL">
      <div class="context-menu-divider"></div>
      
      <div class="context-menu-item" @click="copyLinkURL">
        <svg width="16" height="16" viewBox="0 0 24 24">
          <path fill="currentColor" d="M16,6H13V7.9H16C18.26,7.9 20.1,9.73 20.1,12A4.1,4.1 0 0,1 16,16.1H13V18H16A6,6 0 0,0 22,12C22,8.68 19.31,6 16,6M3.9,12C3.9,9.73 5.74,7.9 8,7.9H11V6H8A6,6 0 0,0 2,12A6,6 0 0,0 8,18H11V16.1H8C5.74,16.1 3.9,14.26 3.9,12M8,13H16V11H8V13Z" />
        </svg>
        <span>Copy Link URL</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { Message } from '@/types';

interface Props {
  isVisible: boolean;
  position: { x: number; y: number };
  message: Message | null;
  channelId?: string;
  conversationId?: string;
}

interface Emits {
  (e: 'close'): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const hasMediaURL = computed(() => {
  if (!props.message || !props.message.content) return false;
  
  // Check if message content contains any URL parts (images, videos, audio)
  if (Array.isArray(props.message.content)) {
    return props.message.content.some(part => 
      part.type === 'url' || 
      (part.type === 'file' && ['image', 'video', 'audio'].includes(part.fileType))
    );
  }
  
  return false;
});

const copyMessageURL = async () => {
  if (!props.message) return;
  
  const domain = import.meta.env.VITE_DOMAIN || window.location.host;
  let messageURL = '';
  
  if (props.channelId) {
    // Server/channel message URL
    messageURL = `https://${domain}/channels/${props.channelId}/messages/${props.message.id}`;
  } else if (props.conversationId) {
    // DM message URL
    messageURL = `https://${domain}/conversations/${props.conversationId}/messages/${props.message.id}`;
  }
  
  try {
    await navigator.clipboard.writeText(messageURL);
    console.log('Message URL copied to clipboard');
  } catch (error) {
    console.error('Failed to copy message URL:', error);
  }
  
  emit('close');
};

const copyLinkURL = async () => {
  if (!props.message || !Array.isArray(props.message.content)) return;
  
  // Find the first URL or media file in the message
  let linkURL = '';
  
  for (const part of props.message.content) {
    if (part.type === 'url') {
      linkURL = part.url;
      break;
    } else if (part.type === 'file' && part.url) {
      linkURL = part.url;
      break;
    }
  }
  
  if (linkURL) {
    try {
      await navigator.clipboard.writeText(linkURL);
      console.log('Link URL copied to clipboard');
    } catch (error) {
      console.error('Failed to copy link URL:', error);
    }
  }
  
  emit('close');
};
</script>

<script lang="ts">
import { computed } from 'vue';
</script>

<style scoped>
.context-menu {
  position: fixed;
  background: #18191c;
  border: 1px solid #40444b;
  border-radius: 6px;
  padding: 6px 0;
  min-width: 180px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  z-index: 1000;
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  color: #dcddde;
  cursor: pointer;
  font-size: 14px;
  transition: background-color 0.1s ease;
}

.context-menu-item:hover {
  background-color: #5865f2;
  color: #ffffff;
}

.context-menu-divider {
  height: 1px;
  background-color: #40444b;
  margin: 4px 0;
}
</style>

