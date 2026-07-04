<template>
  <!-- Teleport to body so the menu is never clipped by an ancestor's
       overflow/transform context, and so it sits ABOVE other portaled
       UI like the mobile floating message-actions toolbar (which is
       also teleported to body and would otherwise paint over us by
       virtue of appearing later in the DOM). -->
  <Teleport to="body">
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

    <!-- Primary actions: full-fidelity emoji picker, reply, edit, thread.
         These mirror what the floating message-actions toolbar exposes,
         so right-clicking a message gives the same affordances as
         hovering it - just always discoverable. -->
    <div class="context-menu-item" @click="openEmojiPicker">
      <ReactionIcon />
      <span>Add Reaction</span>
    </div>

    <div v-if="canReply" class="context-menu-item" @click="reply">
      <ReplyIcon />
      <span>Reply</span>
    </div>

    <div v-if="canEdit" class="context-menu-item" @click="edit">
      <EditIcon />
      <span>Edit Message</span>
    </div>

    <div v-if="canCreateThread" class="context-menu-item" @click="createThread">
      <ThreadIcon />
      <span>Create Thread</span>
    </div>

    <div class="context-menu-divider"></div>

    <div v-if="hasTextContent" class="context-menu-item" @click="copyText">
      <Icon name="copy" size="sm" />
      <span>Copy Text</span>
    </div>

    <!-- Image-specific actions. When the message has multiple image
         attachments we operate on the first one - that's the same image
         the chat preview shows largest, and matches Discord's behaviour
         when right-clicking the message body (vs right-clicking a
         specific image, which is a separate per-image menu). -->
    <template v-if="firstImageAttachment">
      <div class="context-menu-item" @click="copyImage">
        <Icon name="copy" size="sm" />
        <span>Copy Image</span>
      </div>

      <div class="context-menu-item" @click="saveImage">
        <Icon name="download" size="sm" />
        <span>Save Image</span>
      </div>
    </template>

    <template v-if="firstVideoAttachment">
      <div class="context-menu-item" @click="saveVideo">
        <Icon name="download" size="sm" />
        <span>Save Video</span>
      </div>
    </template>

    <template v-if="firstAudioAttachment">
      <div class="context-menu-item" @click="saveAudio">
        <Icon name="download" size="sm" />
        <span>Save Audio</span>
      </div>
    </template>

    <template v-if="hasMediaURL">
      <div class="context-menu-item" @click="copyLinkURL">
        <Icon name="link" size="sm" />
        <span>{{ mediaUrlLabel }}</span>
      </div>
    </template>

    <div class="context-menu-item" @click="copyMessageURL">
      <Icon name="link" size="sm" />
      <span>Copy Message URL</span>
    </div>

    <template v-if="canPin">
      <div class="context-menu-item" @click="togglePin">
        <Icon :name="isPinned ? 'pin-off' : 'pin'" size="sm" />
        <span>{{ isPinned ? 'Unpin Message' : 'Pin Message' }}</span>
      </div>
    </template>

    <!-- Destructive actions, grouped in their own section so they're
         visually separated from the safe ones above. -->
    <template v-if="canDelete || canReport">
      <div class="context-menu-divider"></div>

      <div v-if="canDelete" class="context-menu-item destructive-item" @click="deleteMessage">
        <DeleteIcon />
        <span>Delete Message</span>
      </div>

      <div v-if="canReport" class="context-menu-item destructive-item" @click="reportMessage">
        <Icon name="flag" size="sm" />
        <span>Report Message</span>
      </div>
    </template>

    <template v-if="developerToolsEnabled">
      <div class="context-menu-divider"></div>
      
      <div class="context-menu-item" @click="copyRawData">
        <Icon name="copy" size="sm" />
        <span>{{ $t('settings.advanced.copyRawData') }}</span>
      </div>
    </template>
  </div>
  </Teleport>
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
import { downloadMediaFromUrl, filenameFromUrl } from '@/utils/downloadMedia';
import { getMessageShareUrl } from '@/utils/messageShareUrl';
import type { Message } from '@/types';
import Icon from '@/components/common/Icon.vue';
import ReactionIcon from '@/components/icons/Reaction.vue';
import ReplyIcon from '@/components/icons/Reply.vue';
import ThreadIcon from '@/components/icons/Thread.vue';
import EditIcon from '@/components/icons/Edit.vue';
import DeleteIcon from '@/components/icons/Delete.vue';

interface Props {
  isVisible: boolean;
  position: { x: number; y: number };
  message: Message | null;
  serverId?: string;
  channelId?: string;
  threadId?: string;
  conversationId?: string;
  currentUserId?: string;
  /** When true, hide the "Create Thread" item (e.g. inside a thread view). */
  hideThreadActions?: boolean;
  /** Caller-supplied permission flags. The toolbar already has the same
      checks via canEditMessage / canDeleteMessage in MessageDisplay; passing
      them through keeps the menu consistent without duplicating the
      permission logic. */
  canEdit?: boolean;
  canDelete?: boolean;
}

const menuRef = ref<HTMLElement | null>(null)
const adjustedPosition = ref({ x: 0, y: 0 })

const props = withDefaults(defineProps<Props>(), {
  hideThreadActions: false,
  canEdit: false,
  canDelete: false,
});

// Tuple-based defineEmits is the modern Vue 3 syntax and plays better
// with vue-tsc's `(...args: any[]) => any` listener-prop type than the
// older call-signature interface form, which produces contravariance
// errors at the parent's `@reply="..."` etc. binding sites.
const emit = defineEmits<{
  close: []
  'add-reaction': [emoji: { native?: string; name: string; id?: string }]
  'open-emoji-picker': [position: { x: number; y: number }]
  'pin-changed': []
  report: [message: Message]
  reply: [message: Message]
  edit: [message: Message]
  thread: [message: Message]
  delete: [messageId: string, event: MouseEvent]
}>();

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
// Keep action availability aligned with MessageFloatingActions:
// - System messages: no reply/thread/edit rows
// - Thread button: hidden when hideThreadActions is true
const canReply = computed(() => !!props.message && !props.message.is_system);
const canCreateThread = computed(
  () => !!props.message && !props.message.is_system && !props.hideThreadActions
);

/**
 * First image attachment in the message, if any. Used to gate the
 * "Copy Image" / "Save Image" items and to source the image URL for
 * those actions. Multi-image messages still target this first one -
 * the right-click on the message body is a "message" context menu,
 * not a per-image one.
 */
const firstImageAttachment = computed(() => {
  if (!props.message || !Array.isArray(props.message.content)) return null;
  for (const part of props.message.content) {
    if (
      part &&
      typeof part === 'object' &&
      part.type === 'file' &&
      (part as any).fileType === 'image' &&
      (part as any).url
    ) {
      return part as { type: 'file'; fileType: string; url: string; name?: string };
    }
  }
  return null;
});

const firstVideoAttachment = computed(() => {
  if (!props.message || !Array.isArray(props.message.content)) return null;
  for (const part of props.message.content) {
    if (
      part &&
      typeof part === 'object' &&
      part.type === 'file' &&
      (part as any).fileType === 'video' &&
      (part as any).url
    ) {
      return part as { type: 'file'; fileType: string; url: string; name?: string };
    }
  }
  return null;
});

const firstAudioAttachment = computed(() => {
  if (!props.message || !Array.isArray(props.message.content)) return null;
  for (const part of props.message.content) {
    if (
      part &&
      typeof part === 'object' &&
      part.type === 'file' &&
      (part as any).fileType === 'audio' &&
      (part as any).url
    ) {
      return part as { type: 'file'; fileType: string; url: string; name?: string };
    }
  }
  return null;
});

const menuStyle = computed(() => ({
  top: `${adjustedPosition.value.y}px`,
  left: `${adjustedPosition.value.x}px`,
}));

// Watch for visibility changes to adjust position
watch(() => props.isVisible, async (visible) => {
  if (visible) {
    adjustedPosition.value = { ...props.position }
    
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

  const threadId = props.threadId || props.message.thread_id;
  const messageURL = getMessageShareUrl({
    messageId: props.message.id,
    serverId: props.serverId,
    channelId: props.channelId,
    threadId,
    conversationId: props.conversationId,
  });

  if (!messageURL) return;

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

const reply = () => {
  if (!props.message) return;
  emit('reply', props.message);
  emit('close');
};

const edit = () => {
  if (!props.message) return;
  emit('edit', props.message);
  emit('close');
};

const createThread = () => {
  if (!props.message) return;
  emit('thread', props.message);
  emit('close');
};

const deleteMessage = (event: MouseEvent) => {
  if (!props.message) return;
  // Pass the event through so MessageDisplay can honour shift-to-skip-confirm
  // (shift-click delete is the same affordance as the floating toolbar).
  emit('delete', props.message.id, event);
  emit('close');
};

/**
 * Fetch the first image attachment as a Blob and write it to the
 * clipboard via the async clipboard API. Falls back gracefully if the
 * environment doesn't support `ClipboardItem` (older Safari, Tauri
 * webviews on some platforms) by copying the URL instead so the user
 * always gets *something* useful from the action.
 */
const copyImage = async () => {
  const attachment = firstImageAttachment.value;
  if (!attachment) {
    emit('close');
    return;
  }
  try {
    if (typeof window !== 'undefined' && 'ClipboardItem' in window) {
      const response = await fetch(attachment.url);
      const blob = await response.blob();
      // ClipboardItem accepts most image MIME types; coerce non-png to
      // png so paste targets that only accept image/png still work.
      const targetType = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/png';
      const item = new (window as any).ClipboardItem({ [targetType]: blob });
      await (navigator.clipboard as any).write([item]);
      debug.log('Image copied to clipboard');
    } else {
      await navigator.clipboard.writeText(attachment.url);
      debug.log('Image URL copied to clipboard (no ClipboardItem support)');
    }
  } catch (error) {
    debug.error('Failed to copy image:', error);
    // Last-resort fallback: copy the URL.
    try {
      await navigator.clipboard.writeText(attachment.url);
    } catch {
      // give up silently
    }
  }
  emit('close');
};

const saveImage = async () => {
  const attachment = firstImageAttachment.value;
  if (!attachment) {
    emit('close');
    return;
  }
  const filename = (attachment as any).name || filenameFromUrl(attachment.url, 'image');
  await downloadMediaFromUrl(attachment.url, filename);
  emit('close');
};

const saveVideo = async () => {
  const attachment = firstVideoAttachment.value;
  if (!attachment) {
    emit('close');
    return;
  }
  const filename = (attachment as any).name || filenameFromUrl(attachment.url, 'video');
  await downloadMediaFromUrl(attachment.url, filename);
  emit('close');
};

const saveAudio = async () => {
  const attachment = firstAudioAttachment.value;
  if (!attachment) {
    emit('close');
    return;
  }
  const filename = (attachment as any).name || filenameFromUrl(attachment.url, 'audio');
  await downloadMediaFromUrl(attachment.url, filename);
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
  /* Must out-stack the mobile floating message-actions toolbar
     (.message-actions-floating, z-index 1000) - both are portaled to
     body, so DOM order alone isn't enough to guarantee we paint on top. */
  z-index: 1100;
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

/* Shared icons used in context rows should always inherit the row color
   (normal, hover, destructive), rather than hardcoding their own icon token.
   This keeps menu rows visually consistent across all skins/themes. */
.context-menu-item :deep(.icon-component),
.context-menu-item :deep(.icon-wrap),
.context-menu-item :deep(.icon) {
  color: inherit !important;
  cursor: inherit;
}

.context-menu-item:hover {
  background-color: var(--harmony-primary);
  color: var(--text-primary);
}

.context-menu-divider {
  height: 1px;
  background: var(--border-primary, var(--background-quinary));
  margin: 4px 8px;
}

/* Destructive items (Delete, Report) read in red and switch to a
   solid-red hover so the user gets a clear "this is dangerous" cue. */
.context-menu-item.destructive-item {
  color: var(--error, #ed4245);
}

.context-menu-item.destructive-item:hover {
  background-color: #ed4245;
  color: #fff;
}
</style>

