<template>
  <div 
    v-if="isVisible" 
    ref="menuRef"
    class="context-menu"
    :style="menuStyle"
    @click.stop
    v-click-outside="() => $emit('close')"
  >
    <!-- Quick Reactions -->
    <div class="quick-reactions-row">
      <button
        v-for="emoji in quickReactionEmojis"
        :key="emoji.id || emoji.native"
        class="quick-reaction-btn"
        @click="addQuickReaction(emoji)"
        :title="emoji.name"
      >
        <img v-if="(emoji as any).url" :src="getEmojiUrl((emoji as any).url, 32)" :alt="emoji.name" class="quick-reaction-custom-emoji" />
        <template v-else>{{ (emoji as any).native || emoji.name }}</template>
      </button>
      <button 
        class="quick-reaction-btn more-btn"
        @click="openEmojiPicker"
        title="More reactions"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="16"/>
          <line x1="8" y1="12" x2="16" y2="12"/>
        </svg>
      </button>
    </div>
    
    <div class="context-menu-divider"></div>

    <div v-if="hasTextContent" class="context-menu-item" @click="copyText">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
        <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
      </svg>
      <span>Copy Text</span>
    </div>

    <div class="context-menu-item" @click="copyMessageURL">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z" />
      </svg>
      <span>Copy Message URL</span>
    </div>

    <template v-if="hasMediaURL">
      <div class="context-menu-item" @click="copyLinkURL">
        <svg width="16" height="16" viewBox="0 0 24 24">
          <path fill="currentColor" d="M16,6H13V7.9H16C18.26,7.9 20.1,9.73 20.1,12A4.1,4.1 0 0,1 16,16.1H13V18H16A6,6 0 0,0 22,12C22,8.68 19.31,6 16,6M3.9,12C3.9,9.73 5.74,7.9 8,7.9H11V6H8A6,6 0 0,0 2,12A6,6 0 0,0 8,18H11V16.1H8C5.74,16.1 3.9,14.26 3.9,12M8,13H16V11H8V13Z" />
        </svg>
        <span>{{ mediaUrlLabel }}</span>
      </div>
    </template>
    
    <template v-if="canPin">
      <div class="context-menu-divider"></div>
      
      <div class="context-menu-item" @click="togglePin">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12,2L15.09,8.26L22,9.27L17,14.14L18.18,21.02L12,17.77L5.82,21.02L7,14.14L2,9.27L8.91,8.26L12,2Z"/>
        </svg>
        <span>{{ isPinned ? 'Unpin Message' : 'Pin Message' }}</span>
      </div>
    </template>

    <template v-if="canReport">
      <div class="context-menu-divider"></div>
      
      <div class="context-menu-item report-item" @click="reportMessage">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
          <line x1="4" y1="22" x2="4" y2="15"/>
        </svg>
        <span>Report Message</span>
      </div>
    </template>

    <template v-if="developerToolsEnabled">
      <div class="context-menu-divider"></div>
      
      <div class="context-menu-item" @click="copyRawData">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        <span>{{ $t('settings.advanced.copyRawData') }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { debug } from '@/utils/debug'
import { useFrequentEmojis } from '@/composables/useFrequentEmojis';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useServerPermissions } from '@/composables/useServerPermissions';
import { useDeveloperTools } from '@/composables/useDeveloperTools';
import { messageService } from '@/services';
import { getEmojiUrl } from '@/utils/emojiUtils';
import { messagePartsToPlainText } from '@/utils/messageContentUtils';
import type { Message, Emoji } from '@/types';

interface Props {
  isVisible: boolean;
  position: { x: number; y: number };
  message: Message | null;
  channelId?: string;
  conversationId?: string;
  currentUserId?: string;
}

const menuRef = ref<HTMLElement | null>(null)
const adjustedPosition = ref({ x: 0, y: 0 })

interface Emits {
  (e: 'close'): void;
  (e: 'add-reaction', emoji: { native?: string; name: string; id?: string }): void;
  (e: 'open-emoji-picker', position: { x: number; y: number }): void;
  (e: 'pin-changed'): void;
  (e: 'report', message: Message): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const { topEmojisForContextMenu, hasFrequentEmojis, recordEmojiUsage } = useFrequentEmojis();
const { triggerReaction } = useHapticSettings();
const { canPinMessages } = useServerPermissions();
const { developerToolsEnabled } = useDeveloperTools();

const isPinned = computed(() => props.message?.is_pinned || false);
const canPin = computed(() => canPinMessages.value);
const canReport = computed(() => {
  if (!props.message) return false;
  const authorId = props.message.user_id || (props.message as any).author_id;
  return authorId !== props.currentUserId;
});

// Calculate menu position with boundary checking
const menuStyle = computed(() => ({
  top: `${adjustedPosition.value.y}px`,
  left: `${adjustedPosition.value.x}px`,
}));

// Watch for visibility changes to adjust position
watch(() => props.isVisible, async (visible) => {
  if (visible) {
    // Start with the provided position
    adjustedPosition.value = { ...props.position }
    
    // Wait for menu to render
    await nextTick()
    
    if (menuRef.value) {
      const rect = menuRef.value.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const padding = 8
      
      let x = props.position.x
      let y = props.position.y
      
      // Check right boundary
      if (x + rect.width > viewportWidth - padding) {
        x = viewportWidth - rect.width - padding
      }
      
      // Check bottom boundary
      if (y + rect.height > viewportHeight - padding) {
        y = viewportHeight - rect.height - padding
      }
      
      // Ensure not negative
      x = Math.max(padding, x)
      y = Math.max(padding, y)
      
      adjustedPosition.value = { x, y }
    }
  }
});

// Default emojis for quick reactions (used when no frequent emojis yet)
const defaultQuickEmojis = [
  { id: '👍', native: '👍', name: 'thumbs up' },
  { id: '❤️', native: '❤️', name: 'heart' },
  { id: '😂', native: '😂', name: 'laughing' },
  { id: '😮', native: '😮', name: 'wow' }
];

// Get quick reaction emojis (frequent + defaults if needed)
const quickReactionEmojis = computed(() => {
  if (hasFrequentEmojis.value && topEmojisForContextMenu.value.length >= 4) {
    return topEmojisForContextMenu.value;
  }
  // Mix frequent emojis with defaults to always have 4
  const frequent = topEmojisForContextMenu.value;
  const needed = 4 - frequent.length;
  const defaults = defaultQuickEmojis.slice(0, needed);
  return [...frequent, ...defaults];
});

const addQuickReaction = (emoji: any) => {
  triggerReaction();
  recordEmojiUsage({
    id: emoji.id,
    native: emoji.native,
    name: emoji.name
  });
  emit('add-reaction', emoji);
  emit('close');
};

const openEmojiPicker = () => {
  emit('open-emoji-picker', { ...adjustedPosition.value });
  emit('close');
};

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

const hasTextContent = computed(() => {
  if (!props.message || !Array.isArray(props.message.content)) return false;
  return props.message.content.some(part => {
    if (part.type === 'text' && (part.text || '').trim().length > 0) return true;
    if (part.type === 'mention' || part.type === 'role_mention') return true;
    if (part.type === 'emoji') return true;
    if (part.type === 'url') return true;
    return false;
  });
});

// Show "Copy Media URL" when the message has a file attachment, otherwise
// "Copy Link URL" for plain URLs. Matches Discord's wording: media files
// (images/videos/audio) get "Media URL"; bare links get "Link".
const mediaUrlLabel = computed(() => {
  if (!props.message || !Array.isArray(props.message.content)) return 'Copy Link URL';
  const hasFileMedia = props.message.content.some(
    part => part.type === 'file' && ['image', 'video', 'audio'].includes(part.fileType)
  );
  return hasFileMedia ? 'Copy Media URL' : 'Copy Link URL';
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

const copyText = async () => {
  if (!props.message || !Array.isArray(props.message.content)) {
    emit('close');
    return;
  }

  const text = messagePartsToPlainText(props.message.content);
  if (!text) {
    emit('close');
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    debug.log('Message text copied to clipboard');
  } catch (error) {
    debug.error('Failed to copy message text:', error);
  }

  emit('close');
};

const togglePin = async () => {
  if (!props.message) return;
  
  try {
    if (isPinned.value) {
      await messageService.unpinMessage(props.message.id);
    } else {
      await messageService.pinMessage(props.message.id);
    }
    emit('pin-changed');
    emit('close');
  } catch (error) {
    debug.error('Failed to toggle pin:', error);
  }
};

const reportMessage = () => {
  if (!props.message) return;
  emit('report', props.message);
  emit('close');
};

const copyRawData = async () => {
  if (!props.message) return;

  try {
    const json = JSON.stringify(props.message, null, 2);
    await navigator.clipboard.writeText(json);
    debug.log('Message raw data copied to clipboard');
  } catch (error) {
    debug.error('Failed to copy raw data:', error);
  }

  emit('close');
};
</script>

<style scoped>
.context-menu {
  position: fixed;
  border: 1px solid var(--border-color);
  backdrop-filter: blur(8px);
  border-radius: 6px;
  padding: 6px 0;
  min-width: 200px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  z-index: 1000;
}

.quick-reactions-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  justify-content: center;
}

.quick-reaction-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 18px;
  color: var(--text-secondary);
  transition: all 0.15s ease;
  overflow: hidden;
}

.quick-reaction-btn:hover {
  background-color: rgba(255, 255, 255, 0.1);
  transform: scale(1.15);
}

.quick-reaction-custom-emoji {
  width: 22px;
  height: 22px;
  object-fit: contain;
}

.quick-reaction-btn.more-btn {
  font-size: 14px;
  color: var(--text-muted);
}

.quick-reaction-btn.more-btn:hover {
  color: var(--text-secondary);
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  transition: background-color 0.1s ease;
}

.context-menu-item:hover {
  background-color: var(--harmony-primary);
  color: var(--text-primary);
}

.context-menu-divider {
  height: 1px;
  background: var(--border-primary, var(--h-black-lighter));
  margin: 4px 8px;
}

.context-menu-item.report-item:hover {
  background-color: #ed4245;
}
</style>

