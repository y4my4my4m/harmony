<template>
  <div 
    v-if="isVisible" 
    class="context-menu"
    :style="{ top: position.y + 'px', left: position.x + 'px' }"
    @click.stop
    v-click-outside="() => $emit('close')"
  >
    <div class="context-menu-item" @click="copyMessageURL">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z" />
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
import { computed } from 'vue';
import { debug } from '@/utils/debug'
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
    debug.log('Message URL copied to clipboard');
  } catch (error) {
    debug.error('Failed to copy message URL:', error);
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
      debug.log('Link URL copied to clipboard');
    } catch (error) {
      debug.error('Failed to copy link URL:', error);
    }
  }
  
  emit('close');
};
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

