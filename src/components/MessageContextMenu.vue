<template>
  <!-- AppMenu teleports to <body>: no ancestor overflow or transform clips it,
       and it stacks above other portaled UI such as the mobile floating
       message-actions toolbar. -->
  <AppMenu
    v-if="isVisible && message"
    class="context-menu"
    data-testid="message-context-menu"
    :x="position.x"
    :y="position.y"
    :trigger="trigger"
    :label="t('messageA11y.menu.label')"
    @close="$emit('close')"
    @click.stop
  >
    <!-- Quick Reactions -->
    <div class="quick-reactions-row" role="group" :aria-label="t('messageA11y.menu.quickReactions')">
      <button
        v-for="emoji in quickReactionEmojis"
        :key="emoji.id || emoji.native"
        type="button"
        role="menuitem"
        class="quick-reaction-btn"
        :aria-label="t('messageA11y.menu.reactWith', { emoji: quickReactionName(emoji) })"
        :title="quickReactionName(emoji)"
        @click="addQuickReaction(emoji)"
      >
        <img v-if="(emoji as any).url" :src="getEmojiUrl((emoji as any).url, 32)" alt="" class="quick-reaction-custom-emoji" />
        <span v-else aria-hidden="true">{{ (emoji as any).native || emoji.name }}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        class="quick-reaction-btn more-btn"
        :aria-label="t('messageA11y.menu.moreReactions')"
        :title="t('messageA11y.menu.moreReactions')"
        aria-haspopup="dialog"
        @click="openEmojiPicker"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="16"/>
          <line x1="8" y1="12" x2="16" y2="12"/>
        </svg>
      </button>
    </div>
    
    <div class="context-menu-divider" role="separator"></div>

    <!-- Primary actions: full-fidelity emoji picker, reply, edit, thread.
         These mirror what the floating message-actions toolbar exposes,
         so right-clicking a message gives the same affordances as
         hovering it - just always discoverable. -->
    <button type="button" role="menuitem" class="context-menu-item" aria-haspopup="dialog" @click="openEmojiPicker">
      <ReactionIcon />
      <span>{{ t('message.react') }}</span>
    </button>

    <button v-if="hasReactions" type="button" role="menuitem" class="context-menu-item" aria-haspopup="dialog" data-testid="context-menu-view-reactions" @click="viewReactions">
      <Icon name="smile" size="sm" />
      <span>{{ $t('message.reactions.view') }}</span>
    </button>

    <button v-if="canReply" type="button" role="menuitem" class="context-menu-item" @click="reply">
      <ReplyIcon />
      <span>{{ t('message.reply') }}</span>
    </button>

    <button v-if="canEdit" type="button" role="menuitem" class="context-menu-item" @click="edit">
      <EditIcon />
      <span>{{ t('message.editMessage') }}</span>
    </button>

    <button v-if="canCreateThread" type="button" role="menuitem" class="context-menu-item" @click="createThread">
      <ThreadIcon />
      <span>{{ t('messageA11y.actions.thread') }}</span>
    </button>

    <div class="context-menu-divider" role="separator"></div>

    <button v-if="hasTextContent" type="button" role="menuitem" class="context-menu-item" @click="copyText">
      <Icon name="copy" size="sm" />
      <span>Copy text</span>
    </button>

    <!-- Image-specific actions. When the message has multiple image
         attachments we operate on the first one - that's the same image
         the chat preview shows largest, and matches Discord's behaviour
         when right-clicking the message body (vs right-clicking a
         specific image, which is a separate per-image menu). -->
    <template v-if="firstImageAttachment">
      <button type="button" role="menuitem" class="context-menu-item" @click="copyImage">
        <Icon name="copy" size="sm" />
        <span>Copy image</span>
      </button>

      <button type="button" role="menuitem" class="context-menu-item" @click="saveImage">
        <Icon name="download" size="sm" />
        <span>Save image</span>
      </button>
    </template>

    <template v-if="firstVideoAttachment">
      <button type="button" role="menuitem" class="context-menu-item" @click="saveVideo">
        <Icon name="download" size="sm" />
        <span>Save video</span>
      </button>
    </template>

    <template v-if="firstAudioAttachment">
      <button type="button" role="menuitem" class="context-menu-item" @click="saveAudio">
        <Icon name="download" size="sm" />
        <span>Save audio</span>
      </button>
    </template>

    <template v-if="hasMediaURL">
      <button type="button" role="menuitem" class="context-menu-item" @click="copyLinkURL">
        <Icon name="link" size="sm" />
        <span>{{ mediaUrlLabel }}</span>
      </button>
    </template>

    <button type="button" role="menuitem" class="context-menu-item" @click="copyMessageURL">
      <Icon name="link" size="sm" />
      <span>Copy message link</span>
    </button>

    <button v-if="canToggleEmbeds" type="button" role="menuitem" class="context-menu-item" data-testid="context-menu-toggle-embeds" @click="toggleEmbeds">
      <Icon :name="isEmbedsSuppressed ? 'eye' : 'eye-off'" size="sm" />
      <span>{{ isEmbedsSuppressed ? $t('message.embeds.show') : $t('message.embeds.remove') }}</span>
    </button>

    <template v-if="canPin">
      <button type="button" role="menuitem" class="context-menu-item" @click="togglePin">
        <Icon :name="isPinned ? 'pin-off' : 'pin'" size="sm" />
        <span>{{ isPinned ? t('message.unpinMessage') : t('message.pinMessage') }}</span>
      </button>
    </template>

    <!-- Destructive actions, grouped in their own section so they're
         visually separated from the safe ones above. -->
    <template v-if="canDelete || canReport">
      <div class="context-menu-divider" role="separator"></div>

      <button v-if="canDelete" type="button" role="menuitem" class="context-menu-item destructive-item" aria-haspopup="dialog" @click="deleteMessage">
        <DeleteIcon />
        <span>{{ t('message.deleteMessage') }}</span>
      </button>

      <button v-if="canReport" type="button" role="menuitem" class="context-menu-item destructive-item" aria-haspopup="dialog" @click="reportMessage">
        <Icon name="flag" size="sm" />
        <span>Report message</span>
      </button>
    </template>

    <template v-if="developerToolsEnabled">
      <div class="context-menu-divider" role="separator"></div>
      
      <button type="button" role="menuitem" class="context-menu-item" @click="copyRawData">
        <Icon name="copy" size="sm" />
        <span>{{ $t('settings.advanced.copyRawData') }}</span>
      </button>
    </template>
  </AppMenu>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { debug } from '@/utils/debug'
import { useFrequentEmojis } from '@/composables/useFrequentEmojis';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useServerPermissions } from '@/composables/useServerPermissions';
import { useChannelMessagePermissions } from '@/composables/useChannelMessagePermissions';
import { useDeveloperTools } from '@/composables/useDeveloperTools';
import { usePinActions } from '@/composables/usePinActions';
import { embedsSuppressed, hasEmbeddableParts, setEmbedsSuppressed } from '@/services/messageEmbeds';
import { useToast } from 'vue-toastification';
import { i18n } from '@/i18n';
import { useReactionsStore } from '@/stores/useReactions';
import { getEmojiUrl } from '@/utils/emojiUtils';
import { messagePartsToPlainText } from '@/utils/messageContentUtils';
import { downloadMediaFromUrl, filenameFromUrl } from '@/utils/downloadMedia';
import { resolveMediaPartUrl } from '@/services/privateMedia';
import { getMessageShareUrl } from '@/utils/messageShareUrl';
import type { Message } from '@/types';
import Icon from '@/components/common/Icon.vue';
import ReactionIcon from '@/components/icons/Reaction.vue';
import ReplyIcon from '@/components/icons/Reply.vue';
import ThreadIcon from '@/components/icons/Thread.vue';
import EditIcon from '@/components/icons/Edit.vue';
import DeleteIcon from '@/components/icons/Delete.vue';
import AppMenu from '@/components/a11y/AppMenu.vue';
import { useT } from '@/composables/useT';
import { spokenEmojiName } from '@/utils/a11y/emojiNames';

interface Props {
  isVisible: boolean;
  position: { x: number; y: number };
  /** Where focus returns when the menu closes; default the element focused at opening. */
  trigger?: HTMLElement | null;
  message: Message | null;
  serverId?: string;
  channelId?: string;
  threadId?: string;
  conversationId?: string;
  currentUserId?: string;
  /** When true, hide the "Create thread" item (e.g. inside a thread view). */
  hideThreadActions?: boolean;
  /** Caller-supplied permission flags. The toolbar already has the same
      checks via canEditMessage / canDeleteMessage in MessageDisplay; passing
      them through keeps the menu consistent without duplicating the
      permission logic. */
  canEdit?: boolean;
  canDelete?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  hideThreadActions: false,
  canEdit: false,
  canDelete: false,
  trigger: null,
});

const { t } = useT();

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
  'view-reactions': [message: Message]
  reply: [message: Message]
  edit: [message: Message]
  thread: [message: Message]
  delete: [messageId: string, event: MouseEvent]
}>();

const { topEmojisForContextMenu, hasFrequentEmojis, recordEmojiUsage } = useFrequentEmojis();
const { triggerReaction } = useHapticSettings();
const { canPinMessages: canPinServerWide } = useServerPermissions();
// Channel-resolved, as pin_message and set_message_embeds_suppressed decide it.
const { canPinMessages: canPinInChannel, canManageMessages, canCreateThreads, canEmbedLinks } = useChannelMessagePermissions(
  () => props.serverId,
  () => (props.conversationId ? null : props.channelId),
);
const { setPinned } = usePinActions();
const { developerToolsEnabled } = useDeveloperTools();
const reactionsStore = useReactionsStore();

const isPinned = computed(() => props.message?.is_pinned || false);
const hasReactions = computed(() =>
  !!props.message && reactionsStore.getMessageReactions(props.message.id).length > 0
);
const canPin = computed(() => (props.conversationId ? canPinServerWide.value : canPinInChannel.value));
const toast = useToast();

// The author, or MANAGE_MESSAGES in a server channel (set_message_embeds_suppressed). An author
// without EMBED_LINKS in the channel cannot restore their message's embeds.
const isEmbedsSuppressed = computed(() => embedsSuppressed(props.message));
const canToggleEmbeds = computed(() => {
  const message = props.message;
  if (!message || (!hasEmbeddableParts(message) && !isEmbedsSuppressed.value)) return false;
  const authorId = message.user_id || (message as any).author_id;
  if (authorId && authorId === props.currentUserId) {
    return !isEmbedsSuppressed.value || !props.channelId || !!props.conversationId || canEmbedLinks.value !== false;
  }
  return !!props.channelId && !props.conversationId && canManageMessages.value;
});

const toggleEmbeds = async () => {
  const message = props.message;
  emit('close');
  if (!message) return;
  try {
    await setEmbedsSuppressed(message, !isEmbedsSuppressed.value);
  } catch (error) {
    debug.error('Failed to change message embeds:', error);
    toast.error(i18n.global.t('message.embeds.failed'));
  }
};
const canReport = computed(() => {
  if (!props.message) return false;
  const authorId = props.message.user_id || (props.message as any).author_id;
  return authorId !== props.currentUserId;
});
// Keep action availability aligned with MessageFloatingActions:
// - System messages: no reply/thread/edit rows
// - Thread button: hidden when hideThreadActions is true
const canReply = computed(() => !!props.message && !props.message.is_system);
// create_thread needs CREATE_PUBLIC_THREADS in the message's channel.
const canCreateThread = computed(
  () => !!props.message && !props.message.is_system && !props.hideThreadActions && canCreateThreads.value
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


// Default emojis for quick reactions (used when no frequent emojis yet)
const defaultQuickEmojis = [
  { id: '👍', native: '👍', name: 'thumbs up' },
  { id: '❤️', native: '❤️', name: 'heart' },
  { id: '😂', native: '😂', name: 'laughing' },
  { id: '😮', native: '😮', name: 'wow' }
];

const quickReactionName = (emoji: { name?: string; native?: string; url?: string }): string =>
  spokenEmojiName({ name: emoji.name, url: emoji.url, native: emoji.native, shortcode: emoji.url ? undefined : emoji.name });

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
  emit('open-emoji-picker', { ...props.position });
  emit('close');
};

const viewReactions = () => {
  if (!props.message) return;
  emit('view-reactions', props.message);
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
      linkURL = (await resolveMediaPartUrl(part)) ?? part.url;
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

// The menu closes at once; the pin state is already applied locally and
// reverts with a toast if the RPC fails.
const togglePin = () => {
  if (!props.message) return;
  const message = props.message;
  const pinned = !isPinned.value;
  emit('close');
  void setPinned(message, pinned).then((ok) => {
    if (ok) emit('pin-changed');
  });
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
  const url = (await resolveMediaPartUrl(attachment)) ?? attachment.url;
  try {
    if (typeof window !== 'undefined' && 'ClipboardItem' in window) {
      const response = await fetch(url);
      const blob = await response.blob();
      // ClipboardItem accepts most image MIME types; coerce non-png to
      // png so paste targets that only accept image/png still work.
      const targetType = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/png';
      const item = new (window as any).ClipboardItem({ [targetType]: blob });
      await (navigator.clipboard as any).write([item]);
      debug.log('Image copied to clipboard');
    } else {
      await navigator.clipboard.writeText(url);
      debug.log('Image URL copied to clipboard (no ClipboardItem support)');
    }
  } catch (error) {
    debug.error('Failed to copy image:', error);
    // Last-resort fallback: copy the URL.
    try {
      await navigator.clipboard.writeText(url);
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
  const filename = (attachment as any).name || (attachment as any).fileName || filenameFromUrl(attachment.url, 'image');
  await downloadMediaFromUrl((await resolveMediaPartUrl(attachment)) ?? attachment.url, filename);
  emit('close');
};

const saveVideo = async () => {
  const attachment = firstVideoAttachment.value;
  if (!attachment) {
    emit('close');
    return;
  }
  const filename = (attachment as any).name || (attachment as any).fileName || filenameFromUrl(attachment.url, 'video');
  await downloadMediaFromUrl((await resolveMediaPartUrl(attachment)) ?? attachment.url, filename);
  emit('close');
};

const saveAudio = async () => {
  const attachment = firstAudioAttachment.value;
  if (!attachment) {
    emit('close');
    return;
  }
  const filename = (attachment as any).name || (attachment as any).fileName || filenameFromUrl(attachment.url, 'audio');
  await downloadMediaFromUrl((await resolveMediaPartUrl(attachment)) ?? attachment.url, filename);
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

<style>
/* The menu element is AppMenu's; scoped styles reach only the slot content. */
.app-menu.context-menu {
  background: var(--background-floating);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 6px 0;
  min-width: 200px;
  box-shadow: var(--shadow-large);
  /* Must out-stack the mobile floating message-actions toolbar
     (.message-actions-floating, z-index 1000) - both are portaled to
     body, so DOM order alone isn't enough to guarantee we paint on top. */
  z-index: 1100;
}
</style>

<style scoped>
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

.quick-reaction-btn:hover,
.quick-reaction-btn:focus-visible {
  background-color: var(--background-modifier-hover);
}

.quick-reaction-btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
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
  width: 100%;
  padding: 8px 12px;
  border: none;
  background: none;
  font: inherit;
  text-align: left;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
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

/* Icons are 16 to 20px wide; a fixed box keeps the labels in one column. */
.context-menu-item > :deep(:is(.icon-component, .icon)) {
  display: inline-flex;
  flex: 0 0 20px;
  justify-content: center;
  width: 20px;
}

.context-menu-item:hover,
.context-menu-item:focus {
  background-color: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  outline: none;
}

.context-menu-divider {
  height: 1px;
  background: var(--border-primary, var(--background-quinary));
  margin: 4px 8px;
}

/* Destructive items (Delete, Report) read in red and switch to a
   solid-red hover so the user gets a clear "this is dangerous" cue. */
.context-menu-item.destructive-item {
  color: var(--text-danger);
}

.context-menu-item.destructive-item:hover,
.context-menu-item.destructive-item:focus {
  background-color: var(--error-fill);
  color: var(--text-on-primary);
}
</style>

