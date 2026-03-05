<template>
  <div class="message-display" ref="messageDisplayContainer" @scroll="handleScroll" @click="dismissMobileActions">
    <!-- Loading skeletons when initially loading messages -->
    <div v-if="isLoading && messages.length === 0" class="loading-skeleton">
      <div v-for="n in 5" :key="`skeleton-${n}`" class="skeleton-message">
        <div class="skeleton-avatar"></div>
        <div class="skeleton-content">
          <div class="skeleton-header">
            <div class="skeleton-username"></div>
            <div class="skeleton-timestamp"></div>
          </div>
          <div class="skeleton-text-line" style="width: 90%;"></div>
          <div class="skeleton-text-line" style="width: 70%;"></div>
        </div>
      </div>
    </div>
    
    <div class="no-messages" v-else-if="!isLoading && messages.length === 0">
      {{ $t('message.noMessagesHere') }}
    </div>
    <!-- Loading older messages indicator -->
    <div v-if="isLoadingOlderMessages && messages.length > 0" class="loading-older-messages">
      <div class="loading-spinner"></div>
      <span>{{ $t('message.loadingOlder') }}</span>
    </div>
    
    <!-- Blocked Message Groups (Discord-like) -->
    <template v-for="(item, itemIndex) in displayItems" :key="item.key">
      <!-- Blocked Group Placeholder -->
      <div v-if="item.type === 'blocked-group'" class="blocked-message-group">
        <div class="blocked-group-content">
          <span class="blocked-icon">🚫</span>
          <span class="blocked-text">{{ item.count }} blocked message{{ item.count > 1 ? 's' : '' }}</span>
          <span class="blocked-separator">—</span>
          <button class="reveal-btn" @click="revealBlockedGroup(item.groupId)">
            Show message{{ item.count > 1 ? 's' : '' }}
          </button>
        </div>
      </div>
      
      <!-- Regular Message or Revealed Blocked Message -->
      <template v-else-if="item.type === 'message'">
        <!-- Beginning of conversation indicator (only show when all messages loaded) -->
        <div v-if="item.index === 0 && hasScrollbar && isAllMessagesLoaded" class="beginning-indicator" :style="getIndicatorStyle()">
          <div class="beginning-content">
            <div class="beginning-icon">🌟</div>
            <div class="beginning-text">
              <div class="beginning-title">{{ $t('message.conversationBeginning') }}</div>
              <div class="beginning-subtitle">{{ $t('message.conversationBeginningSubtitle') }}</div>
            </div>
          </div>
        </div>

        <!-- Date separator -->
        <div v-if="shouldShowDateSeparator(item.message, item.index)" class="date-separator">
          <div class="date-separator-line"></div>
          <span class="date-separator-text">{{ formatDateSeparator(item.message.created_at) }}</span>
          <div class="date-separator-line"></div>
        </div>

        <div 
          :id="`message-${item.message.id}`" 
          :data-message-id="item.message.id"
          class="message-item" 
          :class="{ 
            'shake-reject': isMessageShaking(item.message.id),
            'revealed-blocked': item.isRevealed
          }"
          @mouseover="handleMessageMouseover(item.message.id)" 
          @mouseleave="handleMessageMouseleave"
          @touchstart.passive="handleMessageTouchStart(item.message.id)"
          @touchend.passive="handleMessageTouchEnd"
          @touchmove.passive="handleMessageTouchMove"
        >
          <!-- Hide button for revealed blocked messages -->
          <div v-if="item.isRevealed && item.isFirstInRevealedGroup" class="revealed-blocked-banner">
            <span class="blocked-warning">⚠️ {{ item.revealedCount }} message{{ item.revealedCount > 1 ? 's' : '' }} from blocked user</span>
            <button class="hide-btn" @click="hideBlockedGroup(item.groupId)">Hide</button>
          </div>
          
          <!-- Gap indicator for jumped-to messages -->
          <div v-if="chatStore.messageGaps.has(`gap-before-${item.message.id}`)" class="message-gap">
            <div class="gap-line"></div>
            <div class="gap-text">{{ $t('message.jumpInConversation') }}</div>
            <div class="gap-line"></div>
          </div>

          <!-- System Message (join/leave announcements, thread creation) -->
          <div v-if="item.message.is_system" class="system-message">
            <div class="system-message-content">
              <div class="system-timestamp" v-html="formatSystemTimestamp(item.message.created_at)"></div>
              <div class="system-content">
                <!-- Thread created system message -->
                <template v-if="item.message.metadata?.type === 'thread_created'">
                  <div class="system-icon">🧵</div>
                  <div class="system-text thread-created-text">
                    <span 
                      class="system-user-mention"
                      @click="showUserProfile(item.message.user_id)"
                      :style="{ color: getUserColor(item.message.user_id).value }"
                    >{{ getUserDisplayName(item.message.user_id).value }}</span>
                    started a thread: 
                    <span 
                      class="system-thread-link"
                      @click="handleOpenThread(item.message.metadata?.thread_id)"
                    >{{ item.message.metadata?.thread_name || 'Thread' }}</span>. 
                    See 
                    <span 
                      class="system-threads-link"
                      @click="emit('showAllThreads')"
                    >all threads</span>.
                  </div>
                </template>
                <!-- Default system message (join/leave, etc.) -->
                <template v-else>
                  <div class="system-icon">👋</div>
                  <div class="system-text">
                    <UnifiedMessageContent 
                      :content="item.message.content"
                      :message-id="item.message.id"
                      :is-system="true"
                      :embed-payloads="item.message.metadata?.embeds"
                      @show-user-profile="showUserProfile"
                    />
                  </div>
                </template>
              </div>
            </div>
            
            <!-- Message actions for system messages (if hovered) -->
            <div class="message-actions" v-if="hoveredMessageId === item.message.id">
              <div class="action-btn" @click="openEmojiReactor(item.message, $event)"><ReactionIcon/></div>
              <div class="action-btn" v-if="canDeleteMessage(item.message)" @click="deleteMessage(item.message.id)"><DeleteIcon/></div>
              <div class="action-btn" @click="openContextMenu(item.message, $event)"><MoreIcon/></div>
            </div>
            
            <!-- Reactions for system messages -->
            <MessageReactions
              :message="item.message"
              @toggle-reaction="handleToggleReaction"
              @show-reaction-tooltip="showTooltip"
              @hide-reaction-tooltip="hideTooltip"
              @open-emoji-picker="handleOpenEmojiPicker"
            />
          </div>

          <!-- Regular Message Content -->
          <template v-else>
            <!-- Reply reference -->
            <div v-if="item.message.reply_to" @click="handleReplyClick(item.message.reply_to)" class="reply-reference">
            <div class="reply-spine"></div>
            <div class="reply-content">
              <Avatar 
                :src="getReplyUserAvatar(item.message.reply_to)"
                size="mini"
                class="reply-avatar"
              />
              <div class="reply-username" :style="{ color: getReplyUserColor(item.message.reply_to) }">
                {{ getReplyUserDisplayName(item.message.reply_to) }}
              </div>
              <div class="reply-preview">
                {{ getReplyMessagePreview(item.message.reply_to) }}
              </div>
            </div>
          </div>
          
          <!-- Message content with proper alignment -->
          <div class="message-group" :class="{ 'has-header': shouldShowHeader(item.message, item.index), 'compact': !shouldShowHeader(item.message, item.index) }">
            <!-- Message header (avatar + username + timestamp) -->
            <div v-if="shouldShowHeader(item.message, item.index)" class="message-header">
              <div class="message-avatar">
                <Avatar 
                  :src="getAuthorAvatarUrl(item.message).value"
                  size="sm" 
                  :interactive="true"
                  @click="getMessageAuthorId(item.message) && showUserProfile(getMessageAuthorId(item.message), $event)"
                />
          </div>
          <div class="message-main">
            <div class="message-meta">
              <span class="username" :style="{color: getAuthorColor(item.message).value}" @click="getMessageAuthorId(item.message) && showUserProfile(getMessageAuthorId(item.message), $event)">
                <span class="username-text">{{ getAuthorDisplayName(item.message).value }}</span>
                <span v-if="hasDiscordUserMetadata(item.message)" class="bot-badge discord">DISCORD</span>
                <span v-else-if="isMessageFromBot(item.message)" class="bot-badge">BOT</span>
                <span v-if="getInstanceBadge(item.message).value === 'admin'" class="instance-badge admin" title="Instance Admin">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
                  ADMIN
                </span>
                <span v-else-if="getInstanceBadge(item.message).value === 'mod'" class="instance-badge mod" title="Instance Moderator">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
                  MOD
                </span>
              </span>
              <span class="timestamp">
                {{ formatTimestamp(item.message.created_at) }}
                <!-- Pin indicator -->
                <span 
                  v-if="item.message.is_pinned" 
                  class="pin-indicator"
                  title="Pinned message"
                >📌</span>
                <!-- Encryption indicators -->
                <span 
                  v-if="item.message.decrypted" 
                  class="encryption-dot decrypted"
                  :title="'End-to-end encrypted'"
                ></span>
                <span 
                  v-else-if="item.message.encrypted" 
                  class="encryption-indicator locked"
                  :title="'End-to-end encrypted - You cannot decrypt this message'"
                >🔒</span>
              </span>
            </div>
            <UnifiedMessageContent 
              :content="item.message.content"
              :message-id="item.message.id"
              :editable-message-id="editableMessageId"
              :editable-content="editableMessageContent"
              :image-loaded="imageLoaded"
              :is-single-emoji="checkSingleEmoji(item.message.content)"
              :embed-payloads="item.message.metadata?.embeds"
              :encrypted="item.message.encrypted || false"
              :decrypted="item.message.decrypted || false"
              :can-decrypt="canDecryptMessages"
              @image-loaded="handleImageLoaded"
              @embed-loaded="handleEmbedLoaded(item.message.id)"
              @open-lightbox="handleOpenLightbox"
              @update:message="saveEdit"
              @update:content="editableMessageContent = $event"
              @cancel-edit="cancelEdit"
              @show-user-profile="showUserProfile"
              @decrypt-message="handleDecryptMessage(item.message)"
            />
            <!-- Edited indicator for messages with headers -->
            <span 
              v-if="isMessageEdited(item.message)" 
              class="edited-indicator inline"
              :title="item.message.updated_at ? `Edited at ${formatTimestamp(item.message.updated_at)}` : 'Edited'"
            >(edited)</span>
          </div>
        </div>
        
        <!-- Compact message (no header, just content aligned with previous messages) -->
        <div v-else class="message-content-only">
          <div class="message-gutter" :data-timestamp="formatTimeOnly(item.message.created_at)"></div>
          <div class="message-main">
            <UnifiedMessageContent 
              :content="item.message.content"
              :message-id="item.message.id"
              :editable-message-id="editableMessageId"
              :editable-content="editableMessageContent"
              :image-loaded="imageLoaded"
              :is-single-emoji="checkSingleEmoji(item.message.content)"
              :embed-payloads="item.message.metadata?.embeds"
              :encrypted="item.message.encrypted || false"
              :decrypted="item.message.decrypted || false"
              :can-decrypt="canDecryptMessages"
              @image-loaded="handleImageLoaded"
              @embed-loaded="handleEmbedLoaded(item.message.id)"
              @open-lightbox="handleOpenLightbox"
              @update:message="saveEdit"
              @update:content="editableMessageContent = $event"
              @cancel-edit="cancelEdit"
              @show-user-profile="showUserProfile"
              @decrypt-message="handleDecryptMessage(item.message)"
            />
            <!-- Edited indicator for compact messages -->
            <span 
              v-if="isMessageEdited(item.message)" 
              class="edited-indicator compact"
              :title="item.message.updated_at ? `Edited at ${formatTimestamp(item.message.updated_at)}` : 'Edited'"
            >(edited)</span>
          </div>
        </div>
        
        <!-- Message actions -->
        <div class="message-actions" v-if="hoveredMessageId === item.message.id">
          <div ref="reactionBtn" class="action-btn" @click="openEmojiReactor(item.message, $event)"><ReactionIcon/></div>
          <div class="action-btn" @click="replyTo(item.message)"><ReplyIcon/></div>
          <div class="action-btn thread-btn" v-if="!props.hideThreadActions" @click="createThread(item.message)" title="Create Thread"><ThreadIcon/></div>
          <div class="action-btn" v-if="canEditMessage(item.message)" @click="startEdit(item.message)"><EditIcon/></div>
          <div class="action-btn" v-if="canDeleteMessage(item.message)" @click="deleteMessage(item.message.id)"><DeleteIcon/></div>
          <div class="action-btn" @click="openContextMenu(item.message, $event)"><MoreIcon/></div>
        </div>
        
        <!-- Reactions -->
        <MessageReactions
          :message="item.message"
          @toggle-reaction="handleToggleReaction"
          @show-reaction-tooltip="showTooltip"
          @hide-reaction-tooltip="hideTooltip"
          @open-emoji-picker="handleOpenEmojiPicker"
        />
        
          <!-- Thread Indicator (if this message started a thread) - hidden in thread view -->
          <ThreadIndicator
            v-if="!props.hideThreadActions && getThreadForMessage(item.message.id)"
            :thread="getThreadForMessage(item.message.id)"
            @open="openThread"
            class="message-thread-indicator"
          />
        </div>
        </template>
      </div>
    </template>
  </template>
  </div>
  
  <vue-easy-lightbox
    class="lightbox"
    :visible="isLightboxOpen"
    :imgs="lightboxImages"
    :index="indexRef"
    @hide="closeLightbox"
  />

  <!-- Modern User Profile Modal -->
  <UserProfileModal
    :show="showProfileModal"
    :user="selectedUser"
    @close="closeProfile"
    @invite="openInviteModal"
    @mention="(username: string) => { emit('mentionUser', username); closeProfile(); }"
  />

  <!-- Invite Modal -->
  <InviteModal 
    :show="showInviteModal" 
    :server-id="serverChannelStore.currentServerId || undefined"
    :server-data="currentServerData || undefined"
    @close="closeInviteModal"
  />

  <!-- Tooltip for reactions -->
  <div
    v-if="tooltip.visible"
    class="tooltip"
    :style="{ top: tooltip.y + 10 + 'px', left: tooltip.x + 'px' }"
  >
    <div class="tooltip-header">
      <img 
        v-if="tooltip.emoji?.url"
        :src="getEmojiUrl(tooltip.emoji.url, 48)"
        :alt="tooltip.emoji.name || 'emoji'"
        class="tooltip-emoji"
      />
      <span class="emoji-name">:{{ tooltip.emoji?.name }}:</span>
    </div>
    <div v-for="user in tooltip.content" :key="user.id" class="tooltip-user">
      <Avatar 
        :src="user.avatarUrl"
        size="xs"
        class="tooltip-avatar"
      />
      <span :style="{ color: user.userColor }">{{ user.displayName }}</span>
      <span v-if="user.isBridged" class="bridged-badge" :title="'From ' + user.bridgeSource">
        <svg v-if="user.bridgeSource === 'discord'" width="12" height="12" viewBox="0 0 24 24" fill="#5865F2">
          <path d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09c-.01-.02-.04-.03-.07-.03c-1.5.26-2.93.71-4.27 1.33c-.01 0-.02.01-.03.02c-2.72 4.07-3.47 8.03-3.1 11.95c0 .02.01.04.03.05c1.8 1.32 3.53 2.12 5.24 2.65c.03.01.06 0 .07-.02c.4-.55.76-1.13 1.07-1.74c.02-.04 0-.08-.04-.09c-.57-.22-1.11-.48-1.64-.78c-.04-.02-.04-.08-.01-.11c.11-.08.22-.17.33-.25c.02-.02.05-.02.07-.01c3.44 1.57 7.15 1.57 10.55 0c.02-.01.05-.01.07.01c.11.09.22.17.33.26c.04.03.04.09-.01.11c-.52.31-1.07.56-1.64.78c-.04.01-.05.06-.04.09c.32.61.68 1.19 1.07 1.74c.03.01.06.02.09.01c1.72-.53 3.45-1.33 5.25-2.65c.02-.01.03-.03.03-.05c.44-4.53-.73-8.46-3.1-11.95c-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12c0 1.17-.83 2.12-1.89 2.12z"/>
        </svg>
      </span>
    </div>
  </div>

  <!-- Message Context Menu -->
  <MessageContextMenu
    :is-visible="contextMenuVisible"
    :position="contextMenuPosition"
    :message="contextMenuMessage"
    :channel-id="props.channelId"
    :conversation-id="props.conversationId"
    @close="closeContextMenu"
    @add-reaction="handleContextMenuReaction"
    @open-emoji-picker="handleContextMenuEmojiPicker"
  />

  <!-- Delete Message Confirmation Modal (for messages with threads) -->
  <ConfirmationModal
    :show="showDeleteConfirmModal"
    title="Delete Message"
    :message="`This message has a thread attached: '${deleteConfirmConfig.threadName}'`"
    secondary-message="Deleting this message will permanently delete the thread and all its replies. This action cannot be undone."
    confirm-button-text="Delete Message & Thread"
    @close="cancelDeleteMessage"
    @confirm="confirmDeleteMessage"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onUnmounted, reactive } from 'vue';
import { debug } from '@/utils/debug'
import type { PropType, Ref, ComputedRef } from 'vue';
import type { Message, User, Emoji, Reaction } from '@/types';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useChatStore } from '@/stores/useChat';
import { useDMStore } from '@/stores/useDM';
import { useAuthStore } from '@/stores/auth';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useProfileStore } from '@/stores/useProfile';
import { useNotificationStore } from '@/stores/useNotification';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { supabase } from '@/supabase'; 
import { useServerPermissions } from '@/composables/useServerPermissions';
import { useUserData } from '@/composables/useUserData';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useLayoutState } from '@/composables/useLayoutState';
import { format, isToday, isYesterday, isSameDay, isValid } from 'date-fns';
import UserProfileModal from '@/components/UserProfileModal.vue';
import InviteModal from '@/components/InviteModal.vue';
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue';
import ReactionIcon from '@/components/icons/Reaction.vue';
import ReplyIcon from '@/components/icons/Reply.vue';
import ThreadIcon from '@/components/icons/Thread.vue';
import EditIcon from '@/components/icons/Edit.vue';
import DeleteIcon from '@/components/icons/Delete.vue';
import MoreIcon from '@/components/icons/More.vue';
import Avatar from '@/components/common/Avatar.vue';
import MessageReactions from '@/components/MessageReactions.vue';
import MessageContextMenu from '@/components/MessageContextMenu.vue';
import ThreadIndicator from '@/components/threads/ThreadIndicator.vue';
import ConfirmationModal from '@/components/ConfirmationModal.vue';
import { threadService } from '@/services/ThreadService';
import type { ThreadWithDetails } from '@/services/ThreadService';
import { messagePartsToMarkdown, messagePartsToPlainText, isSingleEmojiMessage as checkSingleEmoji } from '@/utils/messageContentUtils';
import { parseContentToMessageParts, resolveMentionsUserData, resolveEmojisData } from '@/utils/unifiedContentProcessing';
import { getEmojiUrl } from '@/utils/emojiUtils';
import { useReactionsStore } from '@/stores/useReactions';

// --- PROPS & EMITS ---
const props = defineProps({
  messages: {
    type: Array as PropType<Message[]>,
    required: true
  },
  loadMoreMessages: Function as PropType<() => void>,
  isAtBottom: Boolean,
  currentUserId: String,
  isLoading: {
    type: Boolean,
    default: false
  },
  channelId: String,
  conversationId: String,
  // Hide thread creation button (for use inside thread views)
  hideThreadActions: {
    type: Boolean,
    default: false
  },
});

const emit = defineEmits(['loadMoreMessages', 'toggleEmojiList', 'sendReaction', 'replyingTo', 'update:isAtBottom', 'createThread', 'showAllThreads', 'mentionUser']);

// --- STORES & COMPOSABLES ---
const serverUsersStore = useServerUsersStore();
const serverChannelStore = useServerChannelStore();
const chatStore = useChatStore();
const dmStore = useDMStore();
const authStore = useAuthStore();
const profileStore = useProfileStore();
const activityPubStore = useActivityPubStore();
const reactionsStore = useReactionsStore();

// Track which blocked message groups the user has chosen to reveal (by first message ID in group)
const revealedBlockedGroups = ref<Set<string>>(new Set());

// Force reactivity counter - increment when blocked users change
// This is updated by watching the store's blockedUsers size
const blockCheckVersion = ref(0);

// Reactive computed that tracks the blocked users count for change detection
const blockedUsersCount = computed(() => activityPubStore.blockedUsers.size);

// Watch for changes to blocked users count and force re-evaluation
watch(blockedUsersCount, (newCount, oldCount) => {
  blockCheckVersion.value++;
  debug.log('🔄 Blocked users changed, forcing re-render. Count:', newCount);
});

// Check if a message is from a blocked user (reactive)
const isMessageFromBlockedUser = (message: Message): boolean => {
  // Access the version to make this reactive to blocked user changes
  blockCheckVersion.value;
  
  const authorId = message.user_id || message.bot_id;
  if (!authorId) return false;
  
  // Use the store getter for reliable reactive access
  const isBlocked = activityPubStore.isBlocked(authorId);
  
  // Debug: log check for first few messages
  if (debug.isEnabled && props.messages.indexOf(message) < 3) {
    debug.log(`🔍 Block check: author=${authorId}, blocked=${isBlocked}, blockedUsers size=${activityPubStore.blockedUsers.size}`);
  }
  
  return isBlocked;
};

// Computed: Group consecutive blocked messages together (Discord-like)
interface BlockedMessageGroup {
  type: 'blocked-group';
  firstMessageId: string;
  messageIds: string[];
  count: number;
}

interface ProcessedMessage {
  type: 'message' | 'blocked-group';
  message?: Message;
  group?: BlockedMessageGroup;
  index: number;
}

const processedMessages = computed((): ProcessedMessage[] => {
  // Force reactivity
  blockCheckVersion.value;
  
  const result: ProcessedMessage[] = [];
  let currentBlockedGroup: BlockedMessageGroup | null = null;
  
  props.messages.forEach((message, index) => {
    const isBlocked = isMessageFromBlockedUser(message);
    const isRevealed = currentBlockedGroup && revealedBlockedGroups.value.has(currentBlockedGroup.firstMessageId);
    
    if (isBlocked && !isRevealed) {
      // Start or continue a blocked group
      if (!currentBlockedGroup) {
        currentBlockedGroup = {
          type: 'blocked-group',
          firstMessageId: message.id,
          messageIds: [message.id],
          count: 1
        };
      } else {
        currentBlockedGroup.messageIds.push(message.id);
        currentBlockedGroup.count++;
      }
    } else {
      // End current blocked group if exists
      if (currentBlockedGroup) {
        result.push({
          type: 'blocked-group',
          group: currentBlockedGroup,
          index: result.length
        });
        currentBlockedGroup = null;
      }
      
      // Add regular message
      result.push({
        type: 'message',
        message,
        index
      });
    }
  });
  
  // Don't forget the last blocked group
  if (currentBlockedGroup) {
    result.push({
      type: 'blocked-group',
      group: currentBlockedGroup,
      index: result.length
    });
  }
  
  return result;
});

// Check if a blocked group has been revealed
const isBlockedGroupRevealed = (firstMessageId: string): boolean => {
  return revealedBlockedGroups.value.has(firstMessageId);
};

// Reveal a blocked message group
const revealBlockedGroup = (firstMessageId: string) => {
  revealedBlockedGroups.value.add(firstMessageId);
  // Force re-computation
  blockCheckVersion.value++;
};

// Hide a revealed blocked message group
const hideBlockedGroup = (firstMessageId: string) => {
  revealedBlockedGroups.value.delete(firstMessageId);
  // Force re-computation
  blockCheckVersion.value++;
};

// Get messages in a revealed blocked group
const getRevealedBlockedMessages = (messageIds: string[]): Message[] => {
  return props.messages.filter(m => messageIds.includes(m.id));
};

// Legacy functions for backwards compatibility
const isBlockedMessageRevealed = (messageId: string): boolean => {
  return revealedBlockedGroups.value.has(messageId);
};

const revealBlockedMessage = (messageId: string) => {
  revealedBlockedGroups.value.add(messageId);
  blockCheckVersion.value++;
};

const hideBlockedMessage = (messageId: string) => {
  revealedBlockedGroups.value.delete(messageId);
  blockCheckVersion.value++;
};

// Display items: transforms messages into displayable items with blocked groups
interface DisplayItem {
  type: 'message' | 'blocked-group';
  key: string;
  message?: Message;
  index?: number;
  // For blocked groups
  groupId?: string;
  count?: number;
  // For revealed blocked messages
  isRevealed?: boolean;
  isFirstInRevealedGroup?: boolean;
  revealedCount?: number;
}

const displayItems = computed((): DisplayItem[] => {
  // Force reactivity
  blockCheckVersion.value;
  
  const result: DisplayItem[] = [];
  let i = 0;
  
  while (i < props.messages.length) {
    const message = props.messages[i];
    const isBlocked = isMessageFromBlockedUser(message);
    
    if (isBlocked) {
      // Find consecutive blocked messages
      const groupStartIndex = i;
      const groupId = message.id;
      const groupMessages: Message[] = [];
      
      while (i < props.messages.length && isMessageFromBlockedUser(props.messages[i])) {
        groupMessages.push(props.messages[i]);
        i++;
      }
      
      const isRevealed = revealedBlockedGroups.value.has(groupId);
      
      if (isRevealed) {
        // Show revealed messages individually with a banner on the first one
        groupMessages.forEach((msg, idx) => {
          result.push({
            type: 'message',
            key: `msg-${msg.id}`,
            message: msg,
            index: groupStartIndex + idx,
            isRevealed: true,
            isFirstInRevealedGroup: idx === 0,
            groupId: groupId,
            revealedCount: groupMessages.length
          });
        });
      } else {
        // Show as a collapsed group
        result.push({
          type: 'blocked-group',
          key: `blocked-${groupId}`,
          groupId: groupId,
          count: groupMessages.length
        });
      }
    } else {
      // Regular message
      result.push({
        type: 'message',
        key: `msg-${message.id}`,
        message: message,
        index: i,
        isRevealed: false
      });
      i++;
    }
  }
  
  return result;
});
const { isCurrentUserServerOwner, canManageMessages } = useServerPermissions();
const { triggerInteraction, triggerDestructive } = useHapticSettings();
const { isMobile } = useLayoutState();
const { 
  getUserDisplayName, 
  getUserColor, 
  getUserAvatarUrl, 
  ensureProfilesAvailable,
  fetchUserProfile,
  getUserProfile
} = useUserData();

// Bot data cache
const botDataCache = ref<Map<string, { username: string; display_name: string; avatar_url: string }>>(new Map());
const fetchingBots = ref<Set<string>>(new Set());

// Thread data cache - map message ID -> thread data
const threadsByMessageId = ref<Map<string, ThreadWithDetails>>(new Map());
const loadingThreads = ref(false);

// Fetch threads for the current channel
const loadChannelThreads = async () => {
  if (!props.channelId) {
    threadsByMessageId.value.clear();
    return;
  }
  
  loadingThreads.value = true;
  try {
    const threads = await threadService.getThreadsForChannel(props.channelId);
    threadsByMessageId.value.clear();
    threads.forEach(thread => {
      if (thread.parent_message_id) {
        threadsByMessageId.value.set(thread.parent_message_id, thread);
      }
    });
  } catch (error) {
    debug.error('Failed to load threads:', error);
  } finally {
    loadingThreads.value = false;
  }
};

// Get thread for a message (if this message started a thread)
const getThreadForMessage = (messageId: string): ThreadWithDetails | undefined => {
  return threadsByMessageId.value.get(messageId);
};

// Open a thread
const openThread = (thread: ThreadWithDetails) => {
  emit('createThread', { thread } as any);
};

// Open a thread by ID (for system messages)
const handleOpenThread = async (threadId?: string) => {
  if (!threadId) return;
  
  try {
    const thread = await threadService.getThread(threadId);
    if (thread) {
      emit('createThread', { thread } as any);
    }
  } catch (error) {
    debug.error('Failed to open thread:', error);
  }
};

// Encryption capability check (cached - only updates when service state changes)
const canDecryptMessages = ref(false);

// Check encryption status once on mount and load threads
onMounted(async () => {
  try {
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService');
    canDecryptMessages.value = megolmMessageEncryptionService.isUnlocked();
  } catch {
    canDecryptMessages.value = false;
  }
  
  // Load threads for initial channel
  loadChannelThreads();
});

// Reload threads when channel changes
watch(() => props.channelId, () => {
  loadChannelThreads();
});

// Fetch bot data from database
const fetchBotData = async (botId: string) => {
  if (botDataCache.value.has(botId) || fetchingBots.value.has(botId)) {
    return;
  }
  
  fetchingBots.value.add(botId);
  
  try {
    const { data, error } = await supabase
      .from('bots')
      .select('id, username, display_name, avatar_url')
      .eq('id', botId)
      .single();
    
    if (!error && data) {
      botDataCache.value.set(botId, data);
    }
  } catch (error) {
    debug.error('Failed to fetch bot data:', error);
  } finally {
    fetchingBots.value.delete(botId);
  }
};

// Helper function to get author ID from message (handles both users and bots)
const getMessageAuthorId = (message: Message): string | null => {
  return message.user_id || message.bot_id || null;
};

// Helper function to check if message is from a bot
const isMessageFromBot = (message: Message): boolean => {
  return !!message.bot_id;
};

// Helper function to check if message is from Discord bridge (has Discord user metadata)
const hasDiscordUserMetadata = (message: Message): boolean => {
  const hasMetadata = !!message.metadata?.discord_user;
  // if (message.bot_id && !hasMetadata) {
  //   debug.log('🔍 Bot message without Discord metadata:', message.id, message.metadata);
  // }
  // if (hasMetadata) {
  //   debug.log('✅ Discord user found:', message.metadata?.discord_user);
  // }
  return hasMetadata;
};

// Helper function to get Discord user info from metadata
const getDiscordUserInfo = (message: Message): { username: string; display_name: string; avatar_url: string } | null => {
  return message.metadata?.discord_user || null;
};

const getInstanceBadge = (message: Message): ComputedRef<'admin' | 'mod' | null> => {
  return computed(() => {
    const userId = message.user_id;
    if (!userId) return null;
    const profile = getUserProfile(userId).value;
    if (profile?.is_admin) return 'admin';
    if (profile?.is_moderator) return 'mod';
    return null;
  });
};

// Helper functions for bot display
const getBotDisplayName = (botId: string): ComputedRef<string> => {
  return computed(() => {
    // Trigger fetch if not cached
    if (!botDataCache.value.has(botId) && !fetchingBots.value.has(botId)) {
      fetchBotData(botId);
    }
    
    const bot = botDataCache.value.get(botId);
    return bot?.display_name || bot?.username || `Bot-${botId.slice(0, 8)}`;
  });
};

const getBotAvatarUrl = (botId: string): ComputedRef<string> => {
  return computed(() => {
    const bot = botDataCache.value.get(botId);
    return bot?.avatar_url || '/default_avatar.webp';
  });
};

const getBotColor = (botId: string): ComputedRef<string> => {
  return computed(() => '#5865F2'); // Discord bot color
};

// Unified helper functions that work for users, bots, and Discord users
// IMPORTANT: All checks must be INSIDE computed() for reactivity
const getAuthorDisplayName = (message: Message): ComputedRef<string> => {
  return computed(() => {
    // Check for Discord user metadata first (puppeting)
    if (message.metadata?.discord_user) {
      const discordUser = message.metadata.discord_user;
      return discordUser.display_name || discordUser.username || 'Discord User';
    }
    
    // Regular bot
    if (message.bot_id) {
      if (!botDataCache.value.has(message.bot_id) && !fetchingBots.value.has(message.bot_id)) {
        fetchBotData(message.bot_id);
      }
      const bot = botDataCache.value.get(message.bot_id);
      return bot?.display_name || bot?.username || `Bot-${message.bot_id.slice(0, 8)}`;
    }
    
    // Regular user
    if (message.user_id) {
      return getUserDisplayName(message.user_id).value;
    }
    
    return 'Unknown';
  });
};

const getAuthorAvatarUrl = (message: Message): ComputedRef<string> => {
  return computed(() => {
    // Check for Discord user metadata first (puppeting)
    if (message.metadata?.discord_user) {
      return message.metadata.discord_user.avatar_url || '/default_avatar.webp';
    }
    
    // Regular bot
    if (message.bot_id) {
      const bot = botDataCache.value.get(message.bot_id);
      return bot?.avatar_url || '/default_avatar.webp';
    }
    
    // Regular user
    if (message.user_id) {
      return getUserAvatarUrl(message.user_id).value;
    }
    
    return '/default_avatar.webp';
  });
};

const getAuthorColor = (message: Message): ComputedRef<string> => {
  return computed(() => {
    // Check for Discord user metadata first (puppeting)
    if (message.metadata?.discord_user) {
      return '#7289DA'; // Discord blurple
    }
    
    // Regular bot
    if (message.bot_id) {
      return '#5865F2';
    }
    
    // Regular user
    if (message.user_id) {
      return getUserColor(message.user_id).value;
    }
    
    return '#dddddd';
  });
};

// Unified computed properties that work for both chat and DMs
const isLoadingOlderMessages = computed(() => {
  // Check both stores since MessageDisplay is used for both
  return chatStore.loadingOlderMessages || dmStore.loadingMessages;
});

const isAllMessagesLoaded = computed(() => {
  // Check both stores
  return chatStore.allMessagesLoaded || dmStore.allMessagesLoaded;
});

// --- REFS ---
const messageDisplayContainer = ref<HTMLDivElement | null>(null);
const imageLoaded: Ref<Record<string, boolean>> = ref({});
const embedLoaded: Ref<Record<string, number>> = ref({}); // Track embed load count per message
const replyMessages = ref<Record<string, Message>>({});
const tooltip = ref({
  visible: false,
  content: [] as { id: string; displayName: string; avatarUrl: string; userColor: string; }[],
  x: 0,
  y: 0,
  emoji: null as Emoji | null,
});
const tooltipTimer: Ref<NodeJS.Timeout | null> = ref(null);
const editableMessageId = ref<string | null>(null);
const editableMessageContent = ref('');
const hoveredMessageId = ref<string | null>(null);
const longPressTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const LONG_PRESS_DURATION = 500;

const handleMessageMouseover = (messageId: string) => {
  if (!isMobile.value) {
    hoveredMessageId.value = messageId;
  }
};

const handleMessageMouseleave = () => {
  if (!isMobile.value) {
    hoveredMessageId.value = null;
  }
};

const handleMessageTouchStart = (messageId: string) => {
  longPressTimer.value = setTimeout(() => {
    hoveredMessageId.value = messageId;
    triggerInteraction();
  }, LONG_PRESS_DURATION);
};

const handleMessageTouchEnd = () => {
  if (longPressTimer.value) {
    clearTimeout(longPressTimer.value);
    longPressTimer.value = null;
  }
};

const handleMessageTouchMove = () => {
  if (longPressTimer.value) {
    clearTimeout(longPressTimer.value);
    longPressTimer.value = null;
  }
};

const dismissMobileActions = (event: MouseEvent) => {
  if (!isMobile.value || !hoveredMessageId.value) return;
  const target = event.target as HTMLElement;
  if (!target.closest('.message-actions')) {
    hoveredMessageId.value = null;
  }
};

const isAtTop = ref(false);
const hasScrollbar = ref(false);
const bufferDistance = ref(0);
const selectedUser = ref<User | null>(null);
const showProfileModal = ref(false);
const showInviteModal = ref(false);

// Delete confirmation modal state
const showDeleteConfirmModal = ref(false);
const deleteConfirmConfig = ref({
  messageId: '',
  hasThread: false,
  threadName: '',
});

// Context menu state
const contextMenuVisible = ref(false);
const contextMenuPosition = ref({ x: 0, y: 0 });
const contextMenuMessage = ref<Message | null>(null);

const isLightboxOpen = ref(false);
const indexRef = ref(0);

// --- CONSTANTS ---
const BUFFER_THRESHOLD = 15; // pixels needed to trigger buffer effect

// --- COMPUTED PROPERTIES ---
const lightboxImages = computed(() => {
  let urls: Array<string> = [];
  if (!props.messages || !Array.isArray(props.messages)) {
    return urls;
  }
  
  props.messages.forEach(message => {
    if (!message?.content || !Array.isArray(message.content)) {
      return;
    }
    
    message.content.forEach(part => {
      if (!part || typeof part !== 'object') {
        return;
      }
      
      if (part.type === 'file' && part.fileType === 'image' && part.url) {
        urls.push(part.url);
      }
      else if (part.type === 'url' && part.url && (part.url.endsWith('.jpg') || part.url.endsWith('.png') || part.url.endsWith('.webp'))) {
        urls.push(part.url);
      }
    });
  });
  return urls;
});

const currentServerData = computed(() => {
  const serverId = serverChannelStore.currentServerId;
  if (!serverId) return null;
  
  const currentServer = serverChannelStore.currentServer;
  return {
    id: serverId,
    name: currentServer?.name || 'Unknown Server',
    icon_url: currentServer?.icon || '',
    member_count: Object.keys(serverUsersStore.userProfiles).length
  };
});

// --- HELPER FUNCTIONS ---
const getReplyUserId = (replyMessageId: string) => {
  const message = props.messages.find(msg => msg.id === replyMessageId) || replyMessages.value[replyMessageId];
  return message?.user_id || 'unknown';
};

// --- WATCHERS ---
watch(() => props.messages, (newMessages) => {
  if (!newMessages || !Array.isArray(newMessages)) {
    return;
  }

  const oldScrollHeight = messageDisplayContainer.value ? messageDisplayContainer.value.scrollHeight : 0;

  // Reset embed tracking for new messages
  const newMessageIds = new Set(newMessages.map(m => m.id));
  Object.keys(embedLoaded.value).forEach(messageId => {
    if (!newMessageIds.has(messageId)) {
      delete embedLoaded.value[messageId];
    }
  });

  const userIds = new Set<string>();
  newMessages.forEach(message => {
    if (message?.user_id) userIds.add(message.user_id);
    if (message?.reply_to) {
      const replyUserId = getReplyUserId(message.reply_to);
      if (replyUserId && replyUserId !== 'unknown') userIds.add(replyUserId);
    }
    if (message?.reactions) {
      message.reactions.forEach(reaction => reaction.reactions?.forEach(r => {
        if (r?.user_id) userIds.add(r.user_id);
      }));
    }

    if (Array.isArray(message.content)) {
      message.content.forEach(part => {
        if (part && typeof part === 'object' && 'url' in part && part.url && !(part.url in imageLoaded.value)) {
          if ((part.type === 'file' && part.fileType === 'image') || (part.type === 'url' && (part.url.endsWith('.jpg') || part.url.endsWith('.png') || part.url.endsWith('.webp')))) {
            imageLoaded.value[part.url] = false;
          }
        }
      });
    }
  });

  if (userIds.size > 0) {
    setTimeout(() => {
      ensureProfilesAvailable(Array.from(userIds)).catch(error => {
        debug.error('Error ensuring user profiles are available:', error);
      });
    }, 0);
  }

  // Batch fetch reactions for all messages (avoid N+1 queries)
  if (newMessages.length > 0) {
    // Filter out temp/optimistic messages
    const realMessageIds = newMessages
      .filter(msg => !msg.id.startsWith('temp-') && !msg.sending)
      .map(msg => msg.id);
    
    if (realMessageIds.length > 0) {
      // Batch fetch reactions for all messages at once
      reactionsStore.fetchMultipleMessageReactions(realMessageIds).catch(error => {
        debug.error('Error batch fetching reactions:', error);
      });
    }
  }

  if (newMessages.length > 0) {
    nextTick(() => {
      if (messageDisplayContainer.value) {
        const newScrollHeight = messageDisplayContainer.value.scrollHeight;
        const scrollOffset = newScrollHeight - oldScrollHeight;
        
        // If this is the initial load (old height was 0), scroll to bottom
        if (oldScrollHeight === 0 && newMessages.length > 0) {
          debug.log('📜 Initial load - scrolling to bottom');
          
          // Set flag so we re-scroll when images load
          shouldBeAtBottom.value = true;
          
          // Find all images in current messages that need to load
          const imageUrlsInMessages = new Set<string>();
          const embedCountsByMessage = new Map<string, number>();
          
          newMessages.forEach(message => {
            // Count embeds in this message
            let embedCount = 0;
            if (Array.isArray(message.content)) {
              message.content.forEach(part => {
                // Check for image parts
                if (part && typeof part === 'object' && 'url' in part && part.url) {
                  if ((part.type === 'file' && part.fileType === 'image') || 
                      (part.type === 'url' && (part.url.endsWith('.jpg') || part.url.endsWith('.png') || part.url.endsWith('.webp') || part.url.endsWith('.gif')))) {
                    imageUrlsInMessages.add(part.url);
                  }
                }
                // Check for embed parts
                if (part && typeof part === 'object' && (part.type === 'embed' || (part.type === 'url' && message.metadata?.embeds?.[part.url]))) {
                  embedCount++;
                }
              });
            }
            // Also check metadata.embeds
            if (message.metadata?.embeds) {
              embedCount += Object.keys(message.metadata.embeds).length;
            }
            if (embedCount > 0) {
              embedCountsByMessage.set(message.id, embedCount);
              // Initialize embed count for this message
              if (!embedLoaded.value[message.id]) {
                embedLoaded.value[message.id] = 0;
              }
            }
          });
          
          const pendingImages = Array.from(imageUrlsInMessages).filter(url => {
            // Image is pending if it's not in the loaded map or explicitly marked as false
            return url in imageLoaded.value ? imageLoaded.value[url] === false : true;
          });
          
          const totalEmbeds = Array.from(embedCountsByMessage.values()).reduce((sum, count) => sum + count, 0);
          debug.log('📜 Pending images to load:', pendingImages.length, 'out of', imageUrlsInMessages.size);
          debug.log('📜 Total embeds to load:', totalEmbeds);
          
          // Function to scroll to bottom with proper timing
          const scrollToBottom = (finalAttempt = false) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                if (messageDisplayContainer.value) {
                  messageDisplayContainer.value.scrollTop = messageDisplayContainer.value.scrollHeight;
                  // Verify we're actually at the bottom
                  const { scrollTop, scrollHeight, clientHeight } = messageDisplayContainer.value;
                  const isAtBottom = scrollTop + clientHeight >= scrollHeight - 5;
                  if (!isAtBottom && !finalAttempt) {
                    // If not at bottom, try one more time after a short delay
                    setTimeout(() => scrollToBottom(true), 100);
                  } else if (isAtBottom || finalAttempt) {
                    // Clear flag after successful scroll or final attempt
                    setTimeout(() => {
                      shouldBeAtBottom.value = false;
                    }, 500);
                  }
                }
              });
            });
          };
          
          if (pendingImages.length === 0 && totalEmbeds === 0) {
            // No images or embeds to wait for, scroll immediately
            setTimeout(() => scrollToBottom(), 50);
          } else {
            // Wait for images and embeds to load, but with a maximum timeout
            const maxWaitTime = 3000; // Maximum 3 seconds (increased for embeds)
            const startTime = Date.now();
            
            const checkAndScroll = () => {
              const imagesLoadedCount = pendingImages.filter(url => imageLoaded.value[url] === true).length;
              
              // Count loaded embeds
              let embedsLoadedCount = 0;
              embedCountsByMessage.forEach((expectedCount, messageId) => {
                const loadedCount = embedLoaded.value[messageId] || 0;
                embedsLoadedCount += Math.min(loadedCount, expectedCount);
              });
              
              const elapsed = Date.now() - startTime;
              const allImagesLoaded = imagesLoadedCount >= pendingImages.length;
              const allEmbedsLoaded = embedsLoadedCount >= totalEmbeds;
              
              // Scroll if all content loaded or timeout reached
              if ((allImagesLoaded && allEmbedsLoaded) || elapsed >= maxWaitTime) {
                debug.log(`📜 Images loaded: ${imagesLoadedCount}/${pendingImages.length}, Embeds loaded: ${embedsLoadedCount}/${totalEmbeds}, elapsed: ${elapsed}ms`);
                scrollToBottom();
              } else {
                // Check again after a short delay
                setTimeout(checkAndScroll, 100);
              }
            };
            
            // Start checking after initial render
            setTimeout(checkAndScroll, 100);
          }
        } 
        // When loading older messages, maintain scroll position by compensating for new content
        else if (scrollOffset > 0 && oldScrollHeight > 0) {
          debug.log('📜 Maintaining scroll position after loading older messages');
          messageDisplayContainer.value.scrollTop += scrollOffset;
          // Clear flag when loading older messages (user is scrolling up)
          shouldBeAtBottom.value = false;
        }
        
        checkScrollable();
        isAtTop.value = messageDisplayContainer.value.scrollTop === 0;
        const { scrollTop, scrollHeight, clientHeight } = messageDisplayContainer.value;
        emit('update:isAtBottom', scrollTop + clientHeight >= scrollHeight - 5);
      }
    });
  }
}, { immediate: true, deep: true });

watch(() => props.messages.map(msg => msg.reactions?.length), () => {
  const hasVisibleReactions = props.messages.some(msg => msg.reactions && msg.reactions.length > 0);
  if (!hasVisibleReactions && tooltip.value.visible) {
    hideTooltip();
  }
}, { deep: true });

// IntersectionObserver to clear unread counts when messages are scrolled into view
// OPTIMIZED: Debounced to prevent 45+ API calls per page load
let intersectionObserver: IntersectionObserver | null = null;
const observedMessages = new Set<string>();
let pendingUnreadUpdate: { messageId: string; timestamp: string } | null = null;
let unreadUpdateTimeout: ReturnType<typeof setTimeout> | null = null;
let hasUnreadUpdatePending = false;

const setupUnreadObserver = () => {
  if (!props.channelId && !props.conversationId) return;
  
  // Clean up existing observer
  if (intersectionObserver) {
    intersectionObserver.disconnect();
  }
  
  intersectionObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const messageId = entry.target.getAttribute('data-message-id');
        if (!messageId || messageId.startsWith('temp-') || observedMessages.has(messageId)) {
          return;
        }
        observedMessages.add(messageId);
        // Queue the message for unread update instead of calling API immediately
        queueUnreadUpdate(messageId);
      });
    },
    {
      root: messageDisplayContainer.value,
      rootMargin: '0px',
      threshold: 0.1 // Trigger when 10% of message is visible
    }
  );
  
  // Observe all message elements
  nextTick(() => {
    if (messageDisplayContainer.value) {
      const messageElements = messageDisplayContainer.value.querySelectorAll('[data-message-id]');
      messageElements.forEach((el) => {
        const id = el.getAttribute('data-message-id');
        if (id && !id.startsWith('temp-')) {
          intersectionObserver?.observe(el);
        }
      });
    }
  });
};

// Queue unread updates and debounce - only track the most recent message
const queueUnreadUpdate = (messageId: string) => {
  const message = props.messages.find(m => m.id === messageId);
  if (!message) return;
  
  const messageTimestamp = message.created_at;
  
  // Only update if this message is newer than the pending one
  if (!pendingUnreadUpdate || messageTimestamp > pendingUnreadUpdate.timestamp) {
    pendingUnreadUpdate = { messageId, timestamp: messageTimestamp };
  }
  
  // Debounce the actual API call
  if (unreadUpdateTimeout) {
    clearTimeout(unreadUpdateTimeout);
  }
  
  if (!hasUnreadUpdatePending) {
    hasUnreadUpdatePending = true;
  }
  
  unreadUpdateTimeout = setTimeout(async () => {
    if (pendingUnreadUpdate) {
      await flushUnreadUpdate();
    }
  }, 500); // 500ms debounce
};

// Flush the pending unread update to the server
const flushUnreadUpdate = async () => {
  if (!pendingUnreadUpdate || !hasUnreadUpdatePending) return;
  
  const { messageId } = pendingUnreadUpdate;
  hasUnreadUpdatePending = false;
  pendingUnreadUpdate = null;
  
  await clearUnreadCount(messageId);
};

const clearUnreadCount = async (messageId: string) => {
  if (!props.channelId && !props.conversationId) return;
  
  try {
    const userId = authStore.session?.user?.id;
    if (!userId) return;
    
    // Get the message to find channel_id or conversation_id
    const message = props.messages.find(m => m.id === messageId);
    if (!message) return;
    
    const channelId = props.channelId || message.channel_id;
    const conversationId = props.conversationId || message.conversation_id;
    
    if (!channelId && !conversationId) return;
    
    // Update unread_counts table to clear unread counts - SINGLE call per channel
    const { error } = await supabase
      .from('unread_counts')
      .update({
        unread_messages: 0,
        unread_mentions: 0,
        last_read_message_id: messageId,
        last_read_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .eq(channelId ? 'channel_id' : 'conversation_id', channelId || conversationId);
    
    if (error) {
      debug.error('Failed to clear unread count:', error);
    } else {
      debug.log('✅ Cleared unread count for', channelId ? 'channel' : 'conversation', channelId || conversationId);
    }
    
    // Batch mark related notifications as read
    const notificationStore = useNotificationStore();
    const relatedNotifications = notificationStore.notifications.filter(n => 
      (n.data?.message?.id === messageId || n.data?.message_id === messageId) && !n.is_read
    );
    
    // Mark all related notifications in parallel instead of sequentially
    if (relatedNotifications.length > 0) {
      await Promise.all(relatedNotifications.map(n => notificationStore.markAsRead(n.id)));
    }
  } catch (error) {
    debug.error('Error clearing unread count:', error);
  }
};

// Watch for messages changes to setup observer
watch(() => props.messages.length, () => {
  if (props.messages.length > 0) {
    nextTick(() => {
      setupUnreadObserver();
    });
  }
}, { immediate: true });

// Cleanup on unmount
onUnmounted(() => {
  // Clear the debounce timeout first to prevent it from firing after unmount
  if (unreadUpdateTimeout) {
    clearTimeout(unreadUpdateTimeout);
    unreadUpdateTimeout = null;
  }
  
  // Flush any pending unread update before unmounting
  // Note: We can't truly await in onUnmounted, but we capture the data and let it complete
  // The flushUnreadUpdate function captures pendingUnreadUpdate at the start, so it will
  // complete even after we clear the local state
  if (pendingUnreadUpdate && hasUnreadUpdatePending) {
    // Fire and forget with error handling - the function already captures the data it needs
    flushUnreadUpdate().catch((err) => {
      console.warn('Failed to flush unread update on unmount:', err);
    });
  }
  
  if (intersectionObserver) {
    intersectionObserver.disconnect();
    intersectionObserver = null;
  }
  observedMessages.clear();
  // Note: Don't reset pendingUnreadUpdate here - flushUnreadUpdate already handles it
  // and resetting here could interfere with the async operation
});


// --- LIFECYCLE HOOKS ---
onMounted(() => {
  if (messageDisplayContainer.value) {
    isAtTop.value = messageDisplayContainer.value.scrollTop === 0;
    checkScrollable();
    messageDisplayContainer.value.addEventListener('wheel', handleWheel, { passive: false });
  }
  // Implement highlight message functionality on the chat store
  chatStore.highlightMessage = (messageId: string) => {
    nextTick(() => {
      const messageElement = document.getElementById(`message-${messageId}`);
      if (messageElement) {
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        messageElement.classList.add('highlighted');
        setTimeout(() => messageElement.classList.remove('highlighted'), 3000);
      }
    });
  };
});

onUnmounted(() => {
  if (messageDisplayContainer.value) {
    messageDisplayContainer.value.removeEventListener('wheel', handleWheel);
  }
  if (longPressTimer.value) {
    clearTimeout(longPressTimer.value);
  }
});

// --- METHODS ---

// Tooltip Handling
const showTooltip = async (event: MouseEvent, reaction: Reaction) => {
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  
  // Filter to only Harmony users (those with user_id) for profile lookup
  const harmonyUserIds = reaction.reactions
    .filter(r => r.user_id)
    .map(r => r.user_id);
  
  if (harmonyUserIds.length > 0) {
    await ensureProfilesAvailable(harmonyUserIds).catch(error => 
      debug.error("Error ensuring profiles for tooltip:", error)
    );
  }

  const usersDetails = reaction.reactions.map(r => {
    // Check if this is a bridged Discord reaction (has metadata.discord_user)
    if (r.metadata?.discord_user) {
      const discordUser = r.metadata.discord_user;
      return {
        id: discordUser.id,
        displayName: discordUser.display_name || discordUser.username,
        avatarUrl: discordUser.avatar_url || '',
        userColor: '#5865F2', // Discord brand color
        isBridged: true,
        bridgeSource: 'discord'
      };
    }
    
    // Regular Harmony user
    return {
      id: r.user_id,
      displayName: getUserDisplayName(r.user_id).value,
      avatarUrl: getUserAvatarUrl(r.user_id).value,
      userColor: getUserColor(r.user_id).value,
      isBridged: false
    };
  });
  
  tooltipTimer.value = setTimeout(() => {
    tooltip.value = { visible: true, content: usersDetails, x: event.clientX, y: event.clientY, emoji: reaction.emoji };
  }, 500);
};

const hideTooltip = () => {
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  tooltipTimer.value = null;
  tooltip.value.visible = false;
};

// Scroll & UI State
const checkScrollable = () => {
  if (messageDisplayContainer.value) {
    hasScrollbar.value = messageDisplayContainer.value.scrollHeight > messageDisplayContainer.value.clientHeight;
  }
};

const handleScroll = () => {
  if (!messageDisplayContainer.value) {
    return;
  }
  
  const { scrollTop, scrollHeight, clientHeight } = messageDisplayContainer.value;
  
  checkScrollable();
  isAtTop.value = scrollTop === 0;
  
  if (!isAtTop.value || !hasScrollbar.value) bufferDistance.value = 0;
  
  if (isAtTop.value) {
    debug.log('📜 At top! hasScrollbar:', hasScrollbar.value, 'loadMoreMessages:', !!props.loadMoreMessages);
    
    if (props.loadMoreMessages) {
      props.loadMoreMessages();
    } else {
      debug.log('❌ No loadMoreMessages function provided!');
    }
  }

  const isAtBottom = scrollTop + clientHeight >= scrollHeight - 5;
  // Clear flag if user scrolls away from bottom
  if (!isAtBottom) {
    shouldBeAtBottom.value = false;
  }
  
  emit('update:isAtBottom', isAtBottom);
};

const handleWheel = (event: WheelEvent) => {
  if (messageDisplayContainer.value && hasScrollbar.value && isAtTop.value && event.deltaY < 0) {
    event.preventDefault();
    bufferDistance.value = Math.min(bufferDistance.value + Math.abs(event.deltaY) * 0.5, BUFFER_THRESHOLD * 2);
  } else if (event.deltaY > 0) {
    bufferDistance.value = 0;
  }
};

// Message Display Logic
const shouldShowHeader = (message: Message, index: number): boolean => {
  if (index === 0) return true;
  const prevMessage = props.messages[index - 1];
  if (!prevMessage) return true;
  
  // For bot-puppeted messages (e.g., Discord bridge), compare the puppeted user identity
  // rather than the bot_id, since multiple Discord users are puppeted through the same bot
  if (message.bot_id && prevMessage.bot_id) {
    const currentDiscordUser = message.metadata?.discord_user;
    const prevDiscordUser = prevMessage.metadata?.discord_user;
    
    // If both have discord_user metadata, compare by discord user id or username
    if (currentDiscordUser && prevDiscordUser) {
      const currentId = currentDiscordUser.id || currentDiscordUser.username;
      const prevId = prevDiscordUser.id || prevDiscordUser.username;
      if (currentId !== prevId) return true;
    } 
    // If one has discord_user and the other doesn't, show header
    else if (currentDiscordUser !== prevDiscordUser) {
      return true;
    }
    // If neither has discord_user, compare bot_ids (same bot = same author)
    else if (message.bot_id !== prevMessage.bot_id) {
      return true;
    }
  } 
  // Standard user message comparison
  // Note: Use nullish coalescing to normalize null/undefined for bot_id comparison
  // This fixes optimistic messages (bot_id: undefined) vs DB messages (bot_id: null)
  else if (prevMessage.user_id !== message.user_id || (prevMessage.bot_id ?? null) !== (message.bot_id ?? null)) {
    return true;
  }
  
  if (message.reply_to) return true;
  const timeDiff = new Date(message.created_at).getTime() - new Date(prevMessage.created_at).getTime();
  return timeDiff > 5 * 60 * 1000;
};

const shouldShowDateSeparator = (message: Message, index: number): boolean => {
  if (index === 0) return false;
  const prevMessage = props.messages[index - 1];
  return !isSameDay(new Date(message.created_at), new Date(prevMessage.created_at));
};

const getIndicatorStyle = () => {
  if (!hasScrollbar.value || bufferDistance.value <= 0) {
    return { opacity: 0, transform: 'translateY(-20px)', pointerEvents: 'none' as const };
  }
  const progress = Math.min(bufferDistance.value / BUFFER_THRESHOLD, 1);
  return {
    opacity: progress,
    transform: `translateY(${-20 + progress * 20}px)`,
    pointerEvents: progress > 0.5 ? ('auto' as const) : ('none' as const),
    transition: 'opacity 0.2s ease-out, transform 0.2s ease-out'
  };
};

// Formatting
const formatTimestamp = (timestamp: Date) => {
  const date = new Date(timestamp);
  if (!isValid(date)) return '';
  if (isToday(date)) return format(date, 'p');
  if (isYesterday(date)) return `Yesterday at ${format(date, 'p')}`;
  return format(date, 'MMM d, yyyy \'at\' p');
};

// Check if message has been edited
const isMessageEdited = (message: Message): boolean => {
  if (!message.updated_at || !message.created_at) return false;
  
  // Parse both timestamps
  const createdAt = new Date(message.created_at).getTime();
  const updatedAt = new Date(message.updated_at).getTime();
  
  // Consider edited if updated_at is more than 1 second after created_at
  // (allows for small timing differences in the database)
  return updatedAt - createdAt > 1000;
};

const formatTimeOnly = (timestamp: Date) => {
  const date = new Date(timestamp);
  if (!isValid(date)) return '';
  return format(date, 'p');
};

const formatSystemTimestamp = (timestamp: Date) => {
  const date = new Date(timestamp);
  if (!isValid(date)) return '';
  if (isToday(date)) return format(date, 'p');
  if (isYesterday(date)) return `Yesterday at<br/>${format(date, 'p')}`;
  return `${format(date, 'MMM d, yyyy')}<br/>${format(date, 'p')}`;
};

const formatDateSeparator = (timestamp: Date): string => {
  const date = new Date(timestamp);
  if (!isValid(date)) return '';
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'MMMM d, yyyy');
};

// Message Actions (Edit, Delete, React)
const canEditMessage = (message: Message) => {
  if (!authStore.session?.user || !message) return false;
  
  // Can't edit optimistic messages (temporary IDs starting with "temp-")
  if (message.id.startsWith('temp-')) return false;
  
  // Can't edit messages that are still sending
  if (message.sending) return false;
  
  // Can't edit messages in remote servers (federated servers)
  if (serverChannelStore.currentServer?.is_local_server === false) return false;
  
  const currentUserId = authStore.session.user.id;
  const messageUserId = message.user_id;
  return messageUserId === currentUserId || isCurrentUserServerOwner.value;
};

const canDeleteMessage = (message: Message) => {
  if (!authStore.session?.user || !message) return false;

  if (serverChannelStore.currentServer?.is_local_server === false) return false;

  const currentUserId = authStore.session.user.id;
  const messageUserId = message.user_id;

  if (messageUserId === currentUserId) return true;
  if (isCurrentUserServerOwner.value) return true;
  if (profileStore.profile?.is_admin || profileStore.profile?.is_moderator) return true;
  if (canManageMessages.value) return true;

  return false;
};




    const startEdit = (message: Message) => {
    if (!canEditMessage(message)) return;
    editableMessageId.value = message.id;
    editableMessageContent.value = messagePartsToMarkdown(message.content);
    hoveredMessageId.value = null;
    nextTick(() => {
      const editInput = document.querySelector(`#edit-input-${message.id}`) as HTMLTextAreaElement;
      if (editInput) {
        editInput.focus();
        const textLength = editInput.value.length;
        editInput.setSelectionRange(textLength, textLength);
      }
    });
  };

const saveEdit = async (messageId: string, newContent?: string) => {
  if (!editableMessageId.value) return;
  const textContent = newContent ?? editableMessageContent.value;
  if (!textContent.trim()) {
    cancelEdit();
    return;
  }
  try {
    const userDataMap = await resolveMentionsUserData(textContent);
    const emojiDataMap = await resolveEmojisData(textContent);
    const parsedContent = await parseContentToMessageParts(textContent, userDataMap, emojiDataMap);
    
    await chatStore.editMessage(messageId, parsedContent);
    cancelEdit();
  } catch (error) {
    debug.error('Error saving message edit:', error);
  }
};

const cancelEdit = () => {
  editableMessageId.value = null;
  editableMessageContent.value = '';
};

const deleteMessage = (messageId: string) => {
  hoveredMessageId.value = null;
  const thread = getThreadForMessage(messageId);
  
  if (thread) {
    deleteConfirmConfig.value = {
      messageId,
      hasThread: true,
      threadName: thread.name || 'this thread',
    };
    showDeleteConfirmModal.value = true;
  } else {
    triggerDestructive();
    chatStore.deleteMessage(messageId);
  }
};

const confirmDeleteMessage = async () => {
  const { messageId } = deleteConfirmConfig.value;
  
  // Haptic feedback for destructive action
  triggerDestructive();
  
  // Delete the message (cascade will delete the thread)
  await chatStore.deleteMessage(messageId);
  
  // Clear thread from local cache
  threadsByMessageId.value.delete(messageId);
  
  // Close the modal
  showDeleteConfirmModal.value = false;
};

const cancelDeleteMessage = () => {
  showDeleteConfirmModal.value = false;
  deleteConfirmConfig.value = {
    messageId: '',
    hasThread: false,
    threadName: '',
  };
};

const openEmojiReactor = (message: Message, event: MouseEvent) => {
  emit('toggleEmojiList', true, message, event.currentTarget as HTMLElement);
};

// Track messages with shake animation for blocked reaction attempts
const shakingMessages = ref<Set<string>>(new Set());

const handleToggleReaction = (messageId: string, emoji: Emoji) => {
  if (tooltip.value.visible) hideTooltip();
  
  // Check if the message is from a blocked user - refuse reaction with shake
  const message = props.messages.find(m => m.id === messageId);
  if (message && isMessageFromBlockedUser(message)) {
    // Add shake animation
    shakingMessages.value.add(messageId);
    triggerDestructive(); // Haptic feedback
    
    // Remove shake after animation completes
    setTimeout(() => {
      shakingMessages.value.delete(messageId);
    }, 500);
    
    debug.warn('Cannot react to message from blocked user');
    return;
  }
  
  emit('sendReaction', messageId, emoji);
};

// Check if a message is currently shaking (blocked reaction attempt)
const isMessageShaking = (messageId: string): boolean => {
  return shakingMessages.value.has(messageId);
};

// Handle opening emoji picker from inline add reaction button
const handleOpenEmojiPicker = (messageId: string, event: MouseEvent) => {
  // Find the message object from the store
  const message = props.messages.find(m => m.id === messageId);
  if (!message) return;
  
  // Emit with proper parameters: (isReaction: boolean, message: Message, triggerElement: HTMLElement)
  emit('toggleEmojiList', true, message, event.currentTarget as HTMLElement);
};

// Handle quick reaction from context menu
const handleContextMenuReaction = (emoji: { native?: string; name: string; id?: string }) => {
  if (!contextMenuMessage.value) return;
  
  // Convert to the Emoji type expected by sendReaction
  const emojiForReaction: Emoji = {
    id: emoji.id || emoji.native || emoji.name,
    name: emoji.name,
    url: '', // Native emojis don't have URLs
    content: emoji.native || emoji.name
  };
  
  emit('sendReaction', contextMenuMessage.value.id, emojiForReaction);
};

// Handle opening emoji picker from context menu
const handleContextMenuEmojiPicker = () => {
  if (!contextMenuMessage.value) return;
  // Emit with proper parameters for reaction mode
  emit('toggleEmojiList', true, contextMenuMessage.value, undefined);
};

// Reply Logic
const replyTo = (message: Message) => {
  const displayName = getUserDisplayName(message.user_id).value || 'Unknown User';
  emit('replyingTo', message.id, displayName);
  hoveredMessageId.value = null;
};

const handleReplyClick = async (replyMessageId: string) => {
  if (!chatStore.currentChannelId) return;
  const success = await chatStore.jumpToMessage(replyMessageId, chatStore.currentChannelId);
  if (!success) debug.warn(`Could not jump to message: ${replyMessageId}`);
};

// Thread Logic
const createThread = (message: Message) => {
  emit('createThread', message);
  hoveredMessageId.value = null;
};

const fetchReplyMessageIfNeeded = async (replyMessageId: string) => {
  if (replyMessages.value[replyMessageId] || props.messages.some(msg => msg.id === replyMessageId)) return;
  try {
    const message = await chatStore.fetchReplyMessage(replyMessageId);
    if (message) replyMessages.value[replyMessageId] = message;
  } catch (error) {
    debug.error('Error fetching reply message:', error);
  }
};

const getReplyUserDisplayName = (replyMessageId: string) => {
  const userId = getReplyUserId(replyMessageId);
  return userId === 'unknown' ? 'Unknown User' : getUserDisplayName(userId).value;
};

const getReplyUserColor = (replyMessageId: string) => {
  const userId = getReplyUserId(replyMessageId);
  return userId === 'unknown' ? '#dddddd' : getUserColor(userId).value;
};

const getReplyUserAvatar = (replyMessageId: string) => {
  const userId = getReplyUserId(replyMessageId);
  return userId === 'unknown' ? '/default_avatar.webp' : getUserAvatarUrl(userId).value;
};

const getReplyMessagePreview = (replyMessageId: string) => {
  const message = props.messages.find(msg => msg.id === replyMessageId) || replyMessages.value[replyMessageId];
  if (message) return messagePartsToPlainText(message.content);
  fetchReplyMessageIfNeeded(replyMessageId);
  return 'Loading...';
};


// Track if we should be at bottom (for initial load)
const shouldBeAtBottom = ref(false);

// Lightbox and Media
const handleImageLoaded = (url: string) => {
  imageLoaded.value[url] = true;
  
  // If we should be at bottom and an image just loaded, re-scroll
  if (shouldBeAtBottom.value && messageDisplayContainer.value) {
    requestAnimationFrame(() => {
      if (messageDisplayContainer.value) {
        const { scrollTop, scrollHeight, clientHeight } = messageDisplayContainer.value;
        const isAtBottom = scrollTop + clientHeight >= scrollHeight - 5;
        if (!isAtBottom) {
          messageDisplayContainer.value.scrollTop = messageDisplayContainer.value.scrollHeight;
        }
      }
    });
  }
};

// Handle embed loaded events
const handleEmbedLoaded = (messageId: string) => {
  if (!embedLoaded.value[messageId]) {
    embedLoaded.value[messageId] = 0;
  }
  embedLoaded.value[messageId] = (embedLoaded.value[messageId] || 0) + 1;
  
  // If we should be at bottom and an embed just loaded, re-scroll
  if (shouldBeAtBottom.value && messageDisplayContainer.value) {
    requestAnimationFrame(() => {
      if (messageDisplayContainer.value) {
        const { scrollTop, scrollHeight, clientHeight } = messageDisplayContainer.value;
        const isAtBottom = scrollTop + clientHeight >= scrollHeight - 5;
        if (!isAtBottom) {
          messageDisplayContainer.value.scrollTop = messageDisplayContainer.value.scrollHeight;
        }
      }
    });
  }
};

// Handle click-to-decrypt for encrypted messages
const handleDecryptMessage = async (message: Message) => {
  debug.log('🔓 Attempting to decrypt message on click:', message.id);
  
  try {
    // Dynamically import the encryption service
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService');
    
    if (!megolmMessageEncryptionService.isUnlocked()) {
      debug.log('🔒 Encryption not unlocked - cannot decrypt');
      return;
    }
    
    // First, try to claim any pending session shares
    await megolmMessageEncryptionService.claimPendingSessionShares();
    
    // Check if we have the original encrypted content (not replaced with glyphs)
    // If content is preserved, use it directly - no DB reload needed
    const hasOriginalContent = message.encryption_metadata && 
      Array.isArray(message.content) && 
      message.content[0]?.type === 'text' &&
      message.content[0]?.text &&
      /^[A-Za-z0-9+/=]{20,}$/.test(message.content[0].text); // Looks like base64
    
    let messageToDecrypt = message;
    
    if (!hasOriginalContent) {
      // Content was replaced with glyphs (legacy) - reload from DB
      debug.log('🔐 Content was replaced with glyphs, reloading from database...');
      const { data: freshMessage } = await supabase
        .from('messages')
        .select('*')
        .eq('id', message.id)
        .single();
      
      if (!freshMessage?.encryption_metadata || !freshMessage.encrypted) {
        debug.log('❌ Message has no encryption metadata in database');
        return;
      }
      
      messageToDecrypt = {
        ...message,
        encryption_metadata: freshMessage.encryption_metadata,
        content: freshMessage.content,
        channel_id: freshMessage.channel_id,
        conversation_id: freshMessage.conversation_id
      } as Message;
    }
    
    // Build the message object that decryptMessage expects
    const roomId = messageToDecrypt.channel_id || messageToDecrypt.conversation_id || props.channelId || props.conversationId || '';
    debug.log('🔐 Decrypting with roomId:', roomId);
    
    const messageForDecryption = {
      content: messageToDecrypt.content,
      channel_id: messageToDecrypt.channel_id || props.channelId || '',
      conversation_id: messageToDecrypt.conversation_id || props.conversationId || '',
      encryption_metadata: messageToDecrypt.encryption_metadata
    };
    
    const decryptedContent = await megolmMessageEncryptionService.decryptMessage(messageForDecryption);
    
    if (decryptedContent) {
      // Update the message in the store with decrypted content
      const resolvedContent = await resolveMentionsUserData(decryptedContent);
      
      // Create updated message object
      const updatedMessage: Message = {
        ...messageToDecrypt,
        content: resolvedContent,
        encrypted: false,
        decrypted: true
      };
      
      // Update the message in the appropriate store
      if (props.channelId || messageToDecrypt.channel_id) {
        chatStore.updateMessageInCache(messageToDecrypt.id, updatedMessage);
      } else if (props.conversationId || messageToDecrypt.conversation_id) {
        dmStore.updateMessageInCache(messageToDecrypt.id, updatedMessage);
      }
      
      debug.log('✅ Message decrypted successfully on click');

      // Trigger reprocessing of other encrypted messages (we may now have the session key)
      window.dispatchEvent(new CustomEvent('megolm-key-received', {
        detail: { roomId: messageToDecrypt.channel_id || messageToDecrypt.conversation_id, sessionId: messageToDecrypt.encryption_metadata?.session_id }
      }));
    }
  } catch (error) {
    debug.log('❌ Could not decrypt message:', error);
  }
};

const handleOpenLightbox = (url: string) => {
  const index = lightboxImages.value.indexOf(url);
  if (index !== -1) {
    indexRef.value = index;
    isLightboxOpen.value = true;
  }
};

const closeLightbox = () => {
  isLightboxOpen.value = false;
};

// Context menu handlers
const openContextMenu = (message: Message, event: MouseEvent) => {
  event.preventDefault();
  event.stopPropagation();
  
  // Haptic feedback for context menu
  triggerInteraction();
  
  contextMenuMessage.value = message;
  contextMenuPosition.value = {
    x: event.clientX,
    y: event.clientY
  };
  contextMenuVisible.value = true;
};

const closeContextMenu = () => {
  contextMenuVisible.value = false;
  contextMenuMessage.value = null;
};


// Modals (User Profile, Invite)
const showUserProfile = async (userId: string, event?: MouseEvent) => {
  event?.stopPropagation();
  let user = getUserProfile(userId).value || await fetchUserProfile(userId).catch(e => debug.error(e));
  if (user) {
    selectedUser.value = user;
    showProfileModal.value = true;
  } else {
    debug.error("Failed to fetch user profile for ID:", userId);
  }
};

const closeProfile = () => {
  showProfileModal.value = false;
  selectedUser.value = null;
};

const openInviteModal = () => {
  showProfileModal.value = false;
  showInviteModal.value = true;
};

const closeInviteModal = () => {
  showInviteModal.value = false;
};
</script>

<style scoped>
/* Modern message display styles */
.message-display {
  flex: 1;
  overflow-y: auto;
  margin-right: 4px;
  padding: 20px 0 10px 0;
  min-height: 0; /* Important for flex child with overflow */
}

/* Individual message item */
.message-item {
  position: relative;
  padding: 0.125rem 16px; /* 2px vertical padding */
  transition: background-color 0.1s ease-out;
}

/* Add margin to message-item only if its child .message-group has a header */
.message-item > .message-group.has-header ~ .message-group,
.message-item > .message-group.has-header {
  /* no-op: ensure specificity for selector ordering */
}
.message-item:has(> .message-group.has-header) {
  margin-top: 0.5rem;
}

.message-item:hover {
  background-color: rgba(4, 4, 5, 0.07);
}

/* Reply reference styling */
.reply-reference {
  margin-left: 54px; /* Match the gutter width */
  margin-bottom: 0;
  cursor: pointer;
  position: relative;
}

.reply-spine {
  position: absolute;
  left: -36px;
  bottom: -1px;
  width: 2px;
  height: 12px;
  background-color: #4f545c;
  border-radius: 1px;
}

.reply-spine::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 34px;
  height: 2px;
  background-color: #4f545c;
  border-radius: 1px;
}

.reply-content {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0.64;
  transition: opacity 0.2s ease;
}

.reply-content:hover {
  opacity: 1;
}

.reply-avatar {
  flex-shrink: 0;
}

.reply-username {
  font-weight: 500;
  font-size: 0.875rem;
}

.reply-preview {
  color: var(--text-secondary);
  font-size: 0.875rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
}

/* Message group - contains header and/or content */
.message-group {
  display: flex;
  flex-direction: column;
  position: relative;
}


/* Message header with avatar + username + timestamp */
.message-header {
  display: flex;
  /* align-items: center; */
  gap: 16px;
}

.message-avatar {
  flex-shrink: 0;
  display: flex;
}

.message-main {
  flex: 1;
  min-width: 0;
}

.message-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  line-height: 1.375rem;
}

.username-text {
  font-weight: 500;
  font-size: 1rem;
  cursor: pointer;
  transition: text-decoration 0.1s ease;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.username-text:hover {
  text-decoration: underline;
}

.bot-badge {
  display: inline-block;
  background: var(--harmony-primary);
  color: white;
  font-size: 0.625rem;
  font-weight: 600;
  padding: 0.125rem 0.25rem;
  border-radius: 0.1875rem;
  vertical-align: middle;
  margin-left: 0.25rem;
}

.bot-badge.discord {
  background: #7289DA;
}

.instance-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
  font-size: 0.625rem;
  font-weight: 600;
  padding: 0.125rem 0.3rem;
  border-radius: 0.1875rem;
  vertical-align: middle;
  margin-left: 0.25rem;
  text-decoration: none;
}

.instance-badge.admin {
  background: linear-gradient(135deg, #d4a017, #b8860b);
  color: #fff;
}

.instance-badge.mod {
  background: linear-gradient(135deg, #2b9e8f, #1a7a6d);
  color: #fff;
}

.timestamp {
  font-size: 0.75rem;
  color: #a3a6aa;
  font-weight: 400;
}

.edited-indicator {
  font-size: 0.65rem;
  color: #72767d;
  font-style: italic;
  margin-left: 0.25rem;
  opacity: 0.8;
  cursor: help;
  transition: opacity 0.2s;
}

.edited-indicator:hover {
  opacity: 1;
}

/* Inline variant appears after message content */
.edited-indicator.inline,
.edited-indicator.compact {
  display: inline;
  margin-left: 0.35rem;
  vertical-align: baseline;
  line-height: 1.375;
}

/* Pin indicator */
.pin-indicator {
  margin-left: 0.35rem;
  font-size: 0.75rem;
  opacity: 0.8;
  cursor: help;
}

/* Thread action button */
.thread-btn {
  color: var(--harmony-primary);
}

/* Compact message (no header) */
.message-content-only {
  display: flex;
  align-items: flex-start;
  min-height: 1.375rem;
}

.message-gutter {
  width: 56px; /* 40px avatar + 16px gap = 56px to align with header messages */
  flex-shrink: 0;
  position: relative;
  height: 1.375rem; /* Match line height */
}

/* Show timestamp on hover for compact messages */
.message-content-only:hover .message-gutter::before {
  content: attr(data-timestamp);
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  line-height: 1.375rem;
  text-align: center;
  font-size: 0.6875rem;
  color: #72767d;
  font-weight: 500;
}

/* Message actions */
.message-actions {
  position: absolute;
  top: -16px;
  right: 0;
  display: flex;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  backdrop-filter: blur(8px);
  z-index: 1;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  cursor: pointer;
  color: var(--text-secondary);
  transition: all 0.15s ease-out;
  border-radius: 4px;
  margin: 2px;
}

.action-btn:hover {
  background-color: var(--harmony-primary-alpha);
  color: var(--text-primary);
}

.action-btn:active {
  background-color: var(--background-tertiary-alpha);
  transform: scale(0.95);
}

/* Gap indicator */
.message-gap {
  display: flex;
  align-items: center;
  margin: 24px 16px;
  color: #72767d;
  font-size: 0.875rem;
  font-weight: 600;
}

.gap-line {
  flex: 1;
  height: 1px;
  background-color: #40444b;
}

.gap-text {
  padding: 0 16px;
  background-color: #36393f;
  position: relative;
}

/* Date separator */
.date-separator {
  display: flex;
  align-items: center;
  margin: 24px 16px 16px 16px;
  color: #72767d;
  font-size: 0.875rem;
  font-weight: 600;
  /* text-transform: uppercase; */
  letter-spacing: 0.02em;
}

.date-separator-line {
  flex: 1;
  height: 1px;
  /* background-color: #40444b; */
  background-color: var(--border-color);
}

.date-separator-text {
  padding: 0 16px;
  /* background-color: #36393f; */
  /* color: var(--text-secondary); */
  color: var(--text-secondary);
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
}

/* Beginning of conversation indicator */
.beginning-indicator {
  display: flex;
  justify-content: center;
  padding: 32px 16px 24px;
  margin-bottom: 8px;
  /* Remove default transitions since we handle them programmatically */
  transition: none;
}

.beginning-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  max-width: 480px;
  padding: 24px;
  background: linear-gradient(135deg, rgba(114, 137, 218, 0.1) 0%, rgba(114, 137, 218, 0.05) 100%);
  border-radius: 16px;
  border: 1px solid rgba(114, 137, 218, 0.2);
  transition: all 0.3s ease-in-out;
}

.beginning-content:hover {
  background: linear-gradient(135deg, rgba(114, 137, 218, 0.15) 0%, rgba(114, 137, 218, 0.08) 100%);
  border-color: rgba(114, 137, 218, 0.3);
}

.beginning-icon {
  font-size: 2rem;
  margin-bottom: 12px;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2));
}

.beginning-title {
  font-size: 1.125rem;
  font-weight: 600;
  color: #ffffff;
  margin-bottom: 4px;
  line-height: 1.4;
}

.beginning-subtitle {
  font-size: 0.875rem;
  color: var(--text-secondary);
  line-height: 1.4;
  opacity: 0.8;
}

/* Highlighted message */
.highlighted {
  background-color: rgba(88, 101, 242, 0.15) !important;
  border-left: 3px solid #5865f2;
  animation: highlight-fade 3s ease-out;
}

/* Search text highlight */
.search-highlight {
  background-color: #fbbf24;
  color: #1f2937;
  padding: 2px 4px;
  border-radius: 3px;
  font-weight: 600;
}

@keyframes highlight-fade {
  0% {
    background-color: hsl(34, 100%, 50%, 0.3) !important;
  }
  100% {
    background-color: hsl(34, 100%, 50%, 0.1) !important;
  }
}

/* No messages state */
.no-messages {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  height: 100%;
  color: #72767d;
  font-size: 1rem;
}

/* Tooltip */
.tooltip {
  position: fixed;
  background-color: #18191c;
  color: #ffffff;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 0.875rem;
  font-weight: 500;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  z-index: 1000;
  pointer-events: none;
  max-width: 300px;
  transform: translateX(-50%);
}

.tooltip-avatar {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  margin-right: 8px;
}

.tooltip-user {
  display: flex;
  align-items: center;
  gap: 4px;
}

.bridged-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 2px;
}

.tooltip-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0 8px 0;
  margin-bottom: 8px;
  border-bottom: 1px solid #40444b49;
}
.tooltip-emoji {
  width: 48px;
  height: 48px;
  margin-right: 4px;
}
.tooltip-emoji-name {
  font-size: 0.875rem;
  color: var(--text-secondary);
}

/* Loading skeletons */
.loading-skeleton {
  padding: 16px;
}

.skeleton-message {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}

.skeleton-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: linear-gradient(90deg, var(--background-quaternary) 25%, rgba(255,255,255,0.08) 50%, var(--background-quaternary) 75%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s infinite;
}

.skeleton-content {
  flex: 1;
}

.skeleton-header {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.skeleton-username {
  width: 80px;
  height: 16px;
  background: linear-gradient(90deg, var(--background-quaternary) 25%, rgba(255,255,255,0.08) 50%, var(--background-quaternary) 75%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s infinite;
  border-radius: 4px;
}

.skeleton-timestamp {
  width: 50px;
  height: 12px;
  background: linear-gradient(90deg, var(--background-quaternary) 25%, rgba(255,255,255,0.08) 50%, var(--background-quaternary) 75%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s infinite;
  border-radius: 4px;
}

.skeleton-text-line {
  height: 14px;
  background: linear-gradient(90deg, var(--background-quaternary) 25%, rgba(255,255,255,0.08) 50%, var(--background-quaternary) 75%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s infinite;
  border-radius: 4px;
  margin-bottom: 6px;
}

@keyframes skeleton-shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
}

/* Responsive design */
@media (max-width: 768px) {
  .message-item {
    padding: 0 8px 0 12px;
  }
  
  .reply-reference {
    margin-left: 50px;
  }
  .reply-spine {
    left: -30px;
  }
  
  .reply-spine::after {
    width: 28px;
  }

  .message-header {
    gap: 12px;
  }
  
  .message-gutter {
    width: 52px;
  }
  
  .reactions-gutter {
    width: 42px;
  }
  
  .date-separator {
    margin: 20px 12px 12px 12px;
  }
  
  .date-separator-text {
    padding: 0 12px;
  }
  
  .beginning-indicator {
    padding: 24px 12px 16px;
  }
  
  .beginning-content {
    padding: 20px 16px;
    max-width: 100%;
  }
  
  .beginning-title {
    font-size: 1rem;
  }
  
  .beginning-subtitle {
    font-size: 0.8125rem;
  }
}

/* Dark theme adjustments */
@media (prefers-color-scheme: dark) {
  .message-item:hover {
    background-color: rgba(79, 84, 92, 0.16);
  }
}

/* System Messages (Join/Leave Announcements) */
.system-message {
  padding: 0 16px 0 0;
}

.system-message-content {
  display: flex;
  align-items: center;
  flex-direction: row;
  margin: 8px 0;
}

.system-content {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background-color: var(--background-quaternary);
  border-left: 4px solid var(--harmony-primary);
  border-radius: 0 4px 4px 0;
  margin-left: 4px;
  font-size: 0.875rem;
  width: 100%;
  color: var(--text-secondary);
}


.system-icon {
  font-size: 1rem;
  flex-shrink: 0;
}

.system-text {
  flex: 1;
  color: var(--text-secondary);
}

.system-text :deep(.system-message-content) {
  color: inherit !important;
}

/* Thread created system message */
.thread-created-text {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px;
}

.system-user-mention {
  font-weight: 600;
  cursor: pointer;
}

.system-user-mention:hover {
  text-decoration: underline;
}

.system-thread-link,
.system-threads-link {
  color: var(--text-link, #00aff4);
  font-weight: 600;
  cursor: pointer;
}

.system-thread-link:hover,
.system-threads-link:hover {
  text-decoration: underline;
}

.system-timestamp {
  font-size: 0.65rem;
  color: #72767d;
  opacity: 0.7;
  flex-shrink: 0;
}

/* System message responsiveness */
@media (max-width: 768px) {
  .system-content {
    padding: 6px 12px;
    gap: 6px;
    font-size: 0.8125rem;
  }
  
  .system-timestamp {
    font-size: 0.6875rem;
  }
}

/* Sending indicator - inline with message content */
.sending-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 6px;
  opacity: 0.5;
  vertical-align: text-bottom;
  line-height: 1;
}

.spinner-icon {
  width: 14px;
  height: 14px;
  color: var(--text-secondary);
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* Loading older messages indicator at top */
.loading-older-messages {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 20px;
  color: var(--text-secondary);
  font-size: 14px;
}

.loading-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--text-secondary);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin-loader 0.8s linear infinite;
}

@keyframes spin-loader {
  to { transform: rotate(360deg); }
}

/* Encryption indicators */
.encryption-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  margin-left: 6px;
  vertical-align: middle;
  cursor: help;
  transition: all 0.2s ease;
  position: relative;
  top: -1px;
}

.encryption-dot.decrypted {
  background-color: #3ba55d;
  opacity: 0.5;
  box-shadow: 0 0 3px rgba(59, 165, 93, 0.4);
}

.encryption-dot.decrypted:hover {
  opacity: 1;
  box-shadow: 0 0 6px rgba(59, 165, 93, 0.8);
  transform: scale(1.2);
}

.encryption-indicator.locked {
  display: inline-block;
  font-size: 0.7em;
  margin-left: 4px;
  opacity: 0.6;
  animation: lockPulse 3s ease-in-out infinite;
  filter: drop-shadow(0 0 3px rgba(237, 66, 69, 0.4));
  cursor: help;
  transition: all 0.2s ease;
  vertical-align: middle;
  position: relative;
  top: -1px;
}

.encryption-indicator.locked:hover {
  opacity: 1;
  filter: drop-shadow(0 0 6px rgba(237, 66, 69, 0.8));
  transform: scale(1.1);
}

@keyframes lockPulse {
  0%, 100% {
    opacity: 0.6;
  }
  50% {
    opacity: 0.9;
  }
}

/* Blocked message styles */
/* Discord-like blocked message group */
.blocked-message-group {
  padding: 8px 16px;
  margin: 4px 0;
}

.blocked-group-content {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  color: var(--text-muted);
  font-size: 0.875rem;
}

.blocked-separator {
  color: var(--text-muted);
  opacity: 0.5;
}

.blocked-message {
  padding: 8px 16px;
  margin: 4px 0;
}

.blocked-message-content {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--background-secondary);
  border-radius: 8px;
  border-left: 3px solid var(--text-muted);
}

/* Revealed blocked messages indicator banner */
.revealed-blocked-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  margin-bottom: 4px;
  background: rgba(237, 66, 69, 0.1);
  border-radius: 4px;
  border-left: 3px solid var(--status-danger, #ed4245);
}

.revealed-blocked {
  border-left: 2px solid var(--status-danger, #ed4245);
  background: rgba(237, 66, 69, 0.05);
}

.blocked-icon {
  font-size: 1rem;
  opacity: 0.6;
}

.blocked-text {
  color: var(--text-muted);
  font-size: 0.875rem;
  font-style: italic;
}

.reveal-btn {
  margin-left: auto;
  padding: 4px 12px;
  font-size: 0.75rem;
  background: transparent;
  border: 1px solid var(--text-muted);
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
}

.reveal-btn:hover {
  background: var(--background-modifier-hover);
  border-color: var(--text-normal);
  color: var(--text-normal);
}

.revealed-blocked-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 16px;
  margin-bottom: 4px;
}

.blocked-warning {
  font-size: 0.75rem;
  color: var(--text-warning, #f0b232);
  opacity: 0.8;
}

.hide-btn {
  padding: 2px 8px;
  font-size: 0.7rem;
  background: transparent;
  border: 1px solid var(--text-muted);
  border-radius: 3px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
}

.hide-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}

/* Shake animation for blocked reaction attempts (like Discord) */
@keyframes shake-reject {
  0%, 100% { transform: translateX(0); }
  10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
  20%, 40%, 60%, 80% { transform: translateX(4px); }
}

.shake-reject {
  animation: shake-reject 0.5s ease-in-out;
  background-color: rgba(237, 66, 69, 0.1) !important;
}

.shake-reject .message-reactions,
.shake-reject .reaction {
  animation: shake-reject 0.5s ease-in-out;
}
</style>