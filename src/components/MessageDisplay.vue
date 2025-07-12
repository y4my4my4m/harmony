<template>
  <div class="message-display" ref="messageDisplayContainer" @scroll="handleScroll">
    <div class="no-messages" v-if="messages.length == 0">
      There are no messages here, type something!
    </div>
    <template v-else v-for="(message, index) in messages" :key="`wrapper-${message.id}`">
      <!-- Beginning of conversation indicator -->
      <div v-if="index === 0 && hasScrollbar" class="beginning-indicator" :style="getIndicatorStyle()">
        <div class="beginning-content">
          <div class="beginning-icon">🌟</div>
          <div class="beginning-text">
            <div class="beginning-title">This is the beginning of your conversation</div>
            <div class="beginning-subtitle">Start chatting and make it memorable!</div>
          </div>
        </div>
      </div>

      <!-- Date separator -->
      <div v-if="shouldShowDateSeparator(message, index)" class="date-separator">
        <div class="date-separator-line"></div>
        <span class="date-separator-text">{{ formatDateSeparator(message.created_at) }}</span>
        <div class="date-separator-line"></div>
      </div>

      <div :id="`message-${message.id}`" class="message-item" @mouseover="hoveredMessageId = message.id" @mouseleave="hoveredMessageId = null">
        <!-- Gap indicator for jumped-to messages -->
        <div v-if="chatStore.messageGaps.has(`gap-before-${message.id}`)" class="message-gap">
          <div class="gap-line"></div>
          <div class="gap-text">Jump in conversation</div>
          <div class="gap-line"></div>
        </div>

        <!-- System Message (join/leave announcements) -->
        <div v-if="message.is_system" class="system-message">
          <div class="system-message-content">
            <div class="system-timestamp" v-html="formatSystemTimestamp(message.created_at)"></div>
            <div class="system-content">
              <div class="system-icon">👋</div>
              <div class="system-text">
                <UnifiedMessageContent 
                  :content="message.content"
                  :message-id="message.id"
                  :is-system="true"
                  @show-user-profile="showUserProfile"
                />
              </div>
            </div>
          </div>
          
          <!-- Message actions for system messages (if hovered) -->
          <div class="message-actions" v-if="hoveredMessageId === message.id">
            <div class="action-btn" @click="openEmojiReactor(message, $event)"><ReactionIcon/></div>
            <div class="action-btn" v-if="canDeleteMessage(message)" @click="deleteMessage(message.id)"><DeleteIcon/></div>
            <div class="action-btn"><MoreIcon/></div>
          </div>
          
          <!-- Reactions for system messages -->
          <MessageReactions
            :message="message"
            @toggle-reaction="handleToggleReaction"
            @show-reaction-tooltip="showTooltip"
            @hide-reaction-tooltip="hideTooltip"
          />
        </div>

        <!-- Regular Message Content -->
        <template v-else>
          <!-- Reply reference -->
          <div v-if="message.reply_to" @click="handleReplyClick(message.reply_to)" class="reply-reference">
            <div class="reply-spine"></div>
            <div class="reply-content">
              <Avatar 
                :src="getReplyUserAvatar(message.reply_to)"
                size="mini"
                class="reply-avatar"
              />
              <div class="reply-username" :style="{ color: getReplyUserColor(message.reply_to) }">
                {{ getReplyUserDisplayName(message.reply_to) }}
              </div>
              <div class="reply-preview">
                {{ getReplyMessagePreview(message.reply_to) }}
              </div>
            </div>
          </div>
          
          <!-- Message content with proper alignment -->
      <div class="message-group" :class="{ 'has-header': shouldShowHeader(message, index), 'compact': !shouldShowHeader(message, index) }">
        <!-- Message header (avatar + username + timestamp) -->
        <div v-if="shouldShowHeader(message, index)" class="message-header">
          <div class="message-avatar">
            <Avatar 
              :src="getUserAvatarUrl(message.user_id).value"
              size="sm" 
              :interactive="true"
              @click="showUserProfile(message.user_id, $event)"
            />
          </div>
          <div class="message-main">
            <div class="message-meta">
              <span class="username" :style="{color: getUserColor(message.user_id).value}" @click="showUserProfile(message.user_id, $event)">
                {{ getUserDisplayName(message.user_id).value }}
              </span>
              <span class="timestamp">{{ formatTimestamp(message.created_at) }}</span>
            </div>
            <UnifiedMessageContent 
              :content="message.content"
              :message-id="message.id"
              :editable-message-id="editableMessageId"
              :editable-content="editableMessageContent"
              :image-loaded="imageLoaded"
              :is-single-emoji="checkSingleEmoji(message.content)"
              @image-loaded="handleImageLoaded"
              @open-lightbox="handleOpenLightbox"
              @update:message="saveEdit"
              @update:content="editableMessageContent = $event"
              @cancel-edit="cancelEdit"
              @show-user-profile="showUserProfile"
            />
          </div>
        </div>
        
        <!-- Compact message (no header, just content aligned with previous messages) -->
        <div v-else class="message-content-only">
          <div class="message-gutter"></div>
          <div class="message-main">
            <UnifiedMessageContent 
              :content="message.content"
              :message-id="message.id"
              :editable-message-id="editableMessageId"
              :editable-content="editableMessageContent"
              :image-loaded="imageLoaded"
              :is-single-emoji="checkSingleEmoji(message.content)"
              @image-loaded="handleImageLoaded"
              @open-lightbox="handleOpenLightbox"
              @update:message="saveEdit"
              @update:content="editableMessageContent = $event"
              @cancel-edit="cancelEdit"
              @show-user-profile="showUserProfile"
            />
          </div>
        </div>
        
        <!-- Message actions -->
        <div class="message-actions" v-if="hoveredMessageId === message.id">
          <div ref="reactionBtn" class="action-btn" @click="openEmojiReactor(message, $event)"><ReactionIcon/></div>
          <div class="action-btn" @click="replyTo(message)"><ReplyIcon/></div>
          <div class="action-btn" v-if="canEditMessage(message)" @click="startEdit(message)"><EditIcon/></div>
          <div class="action-btn" v-if="canDeleteMessage(message)" @click="deleteMessage(message.id)"><DeleteIcon/></div>
          <div class="action-btn"><MoreIcon/></div>
        </div>
        
        <!-- Reactions -->
        <MessageReactions
          :message="message"
          @toggle-reaction="handleToggleReaction"
          @show-reaction-tooltip="showTooltip"
          @hide-reaction-tooltip="hideTooltip"
        />
          </div>
        </template>
      </div>
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
        :src="tooltip.emoji.url"
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
      <span>{{ user.displayName }}</span>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import type { PropType, Ref } from 'vue';
import type { Message, User, Emoji, Reaction, MessagePart } from '@/types';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useChatStore } from '@/stores/useChat';
import { useAuthStore } from '@/stores/auth';
import { useServerChannelStore } from '@/stores/useServerChannel'; 
import { useServerPermissions } from '@/composables/useServerPermissions';
import { useUserData } from '@/composables/useUserData';
import { format, isToday, isYesterday, isSameDay, isValid } from 'date-fns';
import UserProfileModal from '@/components/UserProfileModal.vue';
import InviteModal from '@/components/InviteModal.vue';
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue';
import ReactionIcon from '@/components/icons/Reaction.vue';
import ReplyIcon from '@/components/icons/Reply.vue';
import EditIcon from '@/components/icons/Edit.vue';
import DeleteIcon from '@/components/icons/Delete.vue';
import MoreIcon from '@/components/icons/More.vue';
import Avatar from '@/components/common/Avatar.vue';
import MessageReactions from '@/components/MessageReactions.vue';
import { messagePartsToMarkdown, messagePartsToPlainText, isSingleEmojiMessage as checkSingleEmoji } from '@/utils/messageContentUtils';

export default defineComponent({
  props: {
    messages: {
      type: Array as PropType<Message[]>,
      required: true
    },
    loadMoreMessages: Function as PropType<() => void>,
    isAtBottom: Boolean,
    currentUserId: String,
    // Add the missing isLoading prop
    isLoading: {
      type: Boolean,
      default: false
    },
  },
  // Add the missing emits declaration
  emits: ['loadMoreMessages', 'toggleEmojiList', 'sendReaction', 'replyingTo', 'update:isAtBottom'],
  components: { 
    UserProfileModal,
    InviteModal,
    ReplyIcon,
    EditIcon,
    ReactionIcon,
    DeleteIcon,
    MoreIcon,
    UnifiedMessageContent,
    Avatar,
    MessageReactions
  },
  setup(props, { emit }) {
    const messageDisplayContainer = ref<HTMLDivElement | null>(null);
    const serverUsersStore = useServerUsersStore();
    const serverChannelStore = useServerChannelStore();
    const useChat = useChatStore();
    const authStore = useAuthStore();
    const { isCurrentUserServerOwner } = useServerPermissions();
    
    // Use reactive user data system for real-time updates
    const { getUserDisplayName, getUserColor, getUserAvatarUrl } = useUserData();
    
    // Initialize imageLoaded early to prevent initialization order issues
    const imageLoaded: Ref<Record<string, boolean>> = ref({});
    
    // Cache for reply messages
    const replyMessages = ref<Record<string, Message>>({});
    
    const tooltip = ref({
      visible: false,
      content: [] as { id: string; displayName: string; avatarUrl: string; userColor: string; }[],
      x: 0,
      y: 0,
      emoji: null as Emoji | null,
    });
    const tooltipTimer: Ref<NodeJS.Timeout | null> = ref(null);

    // Initialize scroll position tracking and event listeners
    onMounted(() => {
      if (messageDisplayContainer.value) {
        isAtTop.value = messageDisplayContainer.value.scrollTop === 0;
        checkScrollable();
        
        // Add wheel event listener for buffer effect
        messageDisplayContainer.value.addEventListener('wheel', handleWheel, { passive: false });
      }
    });

    // Clean up event listeners
    onUnmounted(() => {
      if (messageDisplayContainer.value) {
        messageDisplayContainer.value.removeEventListener('wheel', handleWheel);
      }
    });

    const showTooltip = async (event: MouseEvent, reaction: Reaction) => {
      // Cancel any existing timer to prevent unwanted tooltip behavior
      if (tooltipTimer.value) {
        clearTimeout(tooltipTimer.value);
      }
      
      // Pre-fetch any missing user profiles using the getter
      const missingUserIds = reaction.reactions
        .filter(r => !serverUsersStore.getUserProfile(r.user_id))
        .map(r => r.user_id);
      
      if (missingUserIds.length > 0) {
        try {
          await Promise.all(missingUserIds.map(id => 
            serverUsersStore.fetchUserProfile(id).catch(error => {
              console.error("Error fetching user profile for tooltip:", error);
            })
          ));
        } catch (error) {
          console.error("Error fetching user profiles for tooltip:", error);
        }
      }
      
      const usersDetails = reaction.reactions.map(r => ({
        id: r.user_id,
        displayName: getUserDisplayName(r.user_id).value,
        avatarUrl: getUserAvatarUrl(r.user_id).value,
        userColor: getUserColor(r.user_id).value,
      }));
      
      // Set a timer to delay showing the tooltip
      tooltipTimer.value = setTimeout(() => {
        tooltip.value = {
          visible: true,
          content: usersDetails,
          x: event.clientX,
          y: event.clientY,
          emoji: reaction.emoji
        };
      }, 500); // 500 milliseconds delay
    };

    const hideTooltip = () => {
      if (tooltipTimer.value) {
        clearTimeout(tooltipTimer.value);
        tooltipTimer.value = null;
      }
      tooltip.value.visible = false;
    };

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

    // Helper function to get user ID from reply message
    const getReplyUserId = (replyMessageId: string) => {
      // First check if message is in current messages
      const currentMessage = props.messages.find(msg => msg.id === replyMessageId);
      if (currentMessage) {
        return currentMessage.user_id;
      }

      // Check if message is in reply cache
      const cachedMessage = replyMessages.value[replyMessageId];
      if (cachedMessage) {
        return cachedMessage.user_id;
      }

      return 'unknown';
    };

    // Watch for changes in messages for parsing
    watch(() => props.messages, (newMessages) => {
      if (!newMessages || !Array.isArray(newMessages)) {
        return;
      }

      const oldScrollHeight = messageDisplayContainer.value ? messageDisplayContainer.value.scrollHeight : 0;

      // Process message content and initialize image loading states
      newMessages.forEach(message => {
        if (!message?.content || !Array.isArray(message.content)) {
          return;
        }
        
        message.content.forEach(part => {
          if (!part || typeof part !== 'object') {
            return;
          }
          // initialize image "loading" state
          if (part.type === 'file' && part.fileType === 'image' && part.url && !(part.url in imageLoaded.value)) {
            imageLoaded.value[part.url] = false;
          }
          else if (part.type === 'url' && part.url && (part.url.endsWith('.jpg') || part.url.endsWith('.png') || part.url.endsWith('.webp')) && !(part.url in imageLoaded.value)) {
            imageLoaded.value[part.url] = false;
          }
        });
      });

      // Extract user IDs and ensure profiles are available (debounced)
      const userIds = new Set<string>();
      newMessages.forEach(message => {
        if (message?.user_id) {
          userIds.add(message.user_id);
        }
        
        // Also collect user IDs from reply messages
        if (message?.reply_to) {
          const replyUserId = getReplyUserId(message.reply_to);
          if (replyUserId && replyUserId !== 'unknown') {
            userIds.add(replyUserId);
          }
        }
        
        // Collect user IDs from reactions
        if (message?.reactions) {
          message.reactions.forEach(reaction => {
            if (reaction?.reactions) {
              reaction.reactions.forEach(r => {
                if (r?.user_id) {
                  userIds.add(r.user_id);
                }
              });
            }
          });
        }

        // ...existing message content processing...
        if (!message?.content || !Array.isArray(message.content)) {
          return;
        }
        
        message.content.forEach(part => {
          if (!part || typeof part !== 'object') {
            return;
          }
          // initialize image "loading" state
          if (part.type === 'file' && part.fileType === 'image' && part.url && !(part.url in imageLoaded.value)) {
            imageLoaded.value[part.url] = false;
          }
          else if (part.type === 'url' && part.url && (part.url.endsWith('.jpg') || part.url.endsWith('.png') || part.url.endsWith('.webp')) && !(part.url in imageLoaded.value)) {
            imageLoaded.value[part.url] = false;
          }
        });
      });

      // Ensure all user profiles are available
      if (userIds.size > 0) {
        // Use setTimeout to prevent blocking the main thread and avoid recursion
        setTimeout(() => {
          serverUsersStore.ensureProfilesAvailable(Array.from(userIds)).catch(error => {
            console.error('Error ensuring user profiles are available:', error);
          });
        }, 0);
      }

      if (newMessages && newMessages.length > 0) {
        // Recalculate scroll height and maintain scroll position
        nextTick(() => {
          if (messageDisplayContainer.value) {
            const newScrollHeight = messageDisplayContainer.value.scrollHeight;
            const scrollOffset = newScrollHeight - oldScrollHeight;
            
            // Only adjust scroll position if we have new content
            if (scrollOffset > 0) {
              messageDisplayContainer.value.scrollTop += scrollOffset;
            }
            
            // Update scroll state without triggering handleScroll recursion
            const currentScrollTop = messageDisplayContainer.value.scrollTop;
            isAtTop.value = currentScrollTop === 0;
            checkScrollable();
            
            // Update isAtBottom prop based on current scroll position
            const { scrollTop, scrollHeight, clientHeight } = messageDisplayContainer.value;
            const isAtBottom = scrollTop + clientHeight >= scrollHeight - 5; // 5px tolerance
            emit('update:isAtBottom', isAtBottom);
          }
        });
      }
    }, { immediate: true, deep: true });

    // Watch for reaction changes to hide tooltip when reactions become empty
    watch(() => props.messages, (newMessages, oldMessages) => {
      if (!newMessages || !oldMessages) return;
      
      // Check if any message had its reactions removed completely
      newMessages.forEach((newMessage) => {
        const oldMessage = oldMessages.find(old => old.id === newMessage.id);
        if (oldMessage && oldMessage.reactions && oldMessage.reactions.length > 0) {
          const newReactions = getValidReactions(newMessage);
          
          if (newReactions.length === 0) {
            // All reactions were removed, hide tooltip if it was showing
            hideTooltip();
          }
        }
      });
    }, { deep: true });

    // Additional watch specifically for reactions to ensure tooltip is hidden
    watch(() => props.messages.map(msg => msg.reactions), (newReactions, oldReactions) => {
      if (!newReactions || !oldReactions) return;
      
      // Check if any reactions array became empty
      for (let i = 0; i < newReactions.length; i++) {
        const newMsgReactions = newReactions[i];
        const oldMsgReactions = oldReactions[i];
        
        if (oldMsgReactions && oldMsgReactions.length > 0 && 
            (!newMsgReactions || newMsgReactions.length === 0)) {
          hideTooltip();
          break;
        }
      }
    }, { deep: true });

    const isSingleEmojiMessage = computed(() => {
      if (!props.messages || !Array.isArray(props.messages)) {
        return [];
      }
      
      return props.messages.map(message => {
        if (!message?.content || !Array.isArray(message.content)) {
          return false;
        }
        // Check if the message content has only one part and that part is an emoji
        return message.content.length === 1 && 
               message.content[0] && 
               typeof message.content[0] === 'object' && 
               Object.prototype.hasOwnProperty.call(message.content[0], 'emoji');
      });
    });

    const editableMessageId = ref<string | null>(null);
    const editableMessageContent = ref('');
    const hoveredMessageId = ref<string | null>(null);
    const isAtTop = ref(false);
    const hasScrollbar = ref(false);
    const bufferDistance = ref(0);

    const BUFFER_THRESHOLD = 15; // pixels needed to trigger buffer effect

    // Check if content is scrollable and update scroll state
    const checkScrollable = () => {
      if (messageDisplayContainer.value) {
        hasScrollbar.value = messageDisplayContainer.value.scrollHeight > messageDisplayContainer.value.clientHeight;
      }
    };
    
    const shouldShowHeader = (message: Message, index: number): boolean => {
      // Always show header for first message
      if (index === 0) return true;
      
      // Show header if previous message is from different user
      const prevMessage = props.messages[index - 1];
      if (!prevMessage || prevMessage.user_id !== message.user_id) return true;
      
      // Show header if message has a reply
      if (message.reply_to) return true;
      
      // Show header if there's a significant time gap (e.g., 5+ minutes)
      const timeDiff = new Date(message.created_at).getTime() - new Date(prevMessage.created_at).getTime();
      const fiveMinutes = 5 * 60 * 1000;
      if (timeDiff > fiveMinutes) return true;
      
      return false;
    };

    const openEmojiReactor = (message: Message, event: MouseEvent) => {
      // set true if not an emoji for the input but a reaction
      emit('toggleEmojiList', true, message, event.target as HTMLElement);
    }

    const toggleReaction = (messageId: string, emoji: Emoji) => {
      // console.log('toggleReaction called for messageId:', messageId, 'emoji:', emoji.id);
      
      // Always hide tooltip when any reaction is toggled to prevent stale tooltips
      if (tooltip.value.visible) {
        // console.log('Hiding tooltip due to reaction toggle');
        hideTooltip();
      }
      
      emit('sendReaction', messageId, emoji);
    }

    const handleToggleReaction = (messageId: string, emoji: Emoji) => {
      // This is called from the MessageReactions component
      toggleReaction(messageId, emoji);
    }

    // Utility function to convert structured message content to editable text
    const contentToEditableText = (content: MessagePart[]): string => {
      if (!content || !Array.isArray(content)) {
        return '';
      }

      return content.map(part => {
        if (!part || typeof part !== 'object') {
          return '';
        }

        switch (part.type) {
          case 'text':
            return part.text || '';
          case 'emoji':
            return part.emoji?.name ? `:${part.emoji.name}:` : '';
          case 'mention':
            return part.mention || '';
          case 'url':
            return part.url || '';
          case 'file':
            // For files, we'll show a placeholder text that can't be edited
            return `[${part.fileType || 'file'}: ${part.url ? 'attachment' : 'file'}]`;
          default:
            return '';
        }
      }).join('');
    };

    // Parse edited text back to structured content (reuse existing parsing logic)
    const parseEditedText = (text: string): MessagePart[] => {
      console.log('parseEditedText called with text:', text);
      
      const emojiRegex = /:([\w\d_+-]+):/g;
      const urlRegex = /(\bhttps?:\/\/\S+)/gi;
      const mentionRegex = /(@\w+@\w+\S+)/g;
      const fileRegex = /\[(?:image|video|file): [^\]]+\]/g;
      
      let lastIndex = 0;
      const result: MessagePart[] = [];
      const combinedRegex = new RegExp(
        `${emojiRegex.source}|${urlRegex.source}|${mentionRegex.source}|${fileRegex.source}`, 
        'gi'
      );

      let match;
      while ((match = combinedRegex.exec(text)) !== null) {
        // Add text before match
        if (match.index > lastIndex) {
          const textPart = text.slice(lastIndex, match.index);
          if (textPart.trim()) {
            result.push({ type: 'text', text: textPart });
          }
        }

        const matchedText = match[0];
        
        // Handle emoji
        if (matchedText.startsWith(':') && matchedText.endsWith(':')) {
          const emojiName = matchedText.slice(1, -1);
          const emoji = findEmojiByName(emojiName);
          if (emoji) {
            result.push({ type: 'emoji', emoji });
          } else {
            result.push({ type: 'text', text: matchedText });
          }
        }
        // Handle URL
        else if (matchedText.startsWith('http')) {
          result.push({ type: 'url', url: matchedText, preview: true });
        }
        // Handle mention
        else if (matchedText.startsWith('@')) {
          const userId = serverUsersStore.usernameToUserIdMap[matchedText.toLowerCase()];
          result.push({ type: 'mention', mention: matchedText, userId });
        }
        // Handle file placeholders (don't allow editing)
        else if (matchedText.startsWith('[') && matchedText.endsWith(']')) {
          // Skip file placeholders - they can't be edited
          result.push({ type: 'text', text: matchedText });
        }

        lastIndex = match.index + matchedText.length;
      }

      // Add remaining text
      if (lastIndex < text.length) {
        const remainingText = text.slice(lastIndex);
        if (remainingText.trim()) {
          result.push({ type: 'text', text: remainingText });
        }
      }

      console.log('parseEditedText result:', result);
      return result;
    };

    // Find emoji by name (reuse existing logic)
    const findEmojiByName = (name: string) => {
      const resolvedEmojiList = (serverChannelStore as any).resolvedEmojiList;
      for (const serverId in resolvedEmojiList) {
        const server = resolvedEmojiList[serverId];
        const emoji = server.emojis.find((e: any) => e.name === name);
        if (emoji) {
          return emoji;
        }
      }
      return undefined;
    };

    // Implement proper startEdit function
    const startEdit = (message: Message) => {
      if (!canEditMessage(message)) {
        return;
      }

      // Set the message as editable
      editableMessageId.value = message.id;
      
      // Convert structured content to editable text
      editableMessageContent.value = contentToEditableText(message.content);
      
      // Focus the edit input after DOM update
      nextTick(() => {
        const editInput = document.querySelector(`#edit-input-${message.id}`) as HTMLTextAreaElement;
        if (editInput) {
          editInput.focus();
          // Remove the .select() call to prevent automatic text selection
          // Position cursor at the end instead
          const textLength = editInput.value.length;
          editInput.setSelectionRange(textLength, textLength);
        }
      });
    };

    // Enhanced saveEdit function
    const saveEdit = async (messageId: string, newContent?: string) => {
      console.log('saveEdit called with messageId:', messageId, 'newContent:', newContent, 'editableMessageId:', editableMessageId.value);
      
      if (!editableMessageId.value) {
        console.log('No editable message ID, returning');
        return;
      }

      try {
        const textContent = newContent ?? editableMessageContent.value;
        console.log('Using textContent:', textContent);
        
        // Don't save if content is empty
        if (!textContent.trim()) {
          console.log('Content is empty, canceling edit');
          cancelEdit();
          return;
        }

        // Parse the edited text back to structured content
        const parsedContent = parseEditedText(textContent);
        console.log('Parsed content:', parsedContent);
        
        // Update the message with structured content
        console.log('Calling useChat.editMessage with messageId:', messageId, 'parsedContent:', parsedContent);
        await useChat.editMessage(messageId, parsedContent);
        
        // Reset edit state
        editableMessageId.value = null;
        editableMessageContent.value = '';
        console.log('Edit state reset');
      } catch (error) {
        console.error('Error saving message edit:', error);
        // Show user-friendly error message
        // TODO: Implement proper error notification system
      }
    };

    const cancelEdit = () => {
      editableMessageId.value = null;
      editableMessageContent.value = '';
    };

    const deleteMessage = (messageId: string) => {
      useChat.deleteMessage(messageId);
    };

    const selectedUser = ref<User | null>(null);
    const showProfileModal = ref(false);
    const showInviteModal = ref(false);
    const showUserProfile = async (userId: string, event?: MouseEvent) => {
      let user = serverUsersStore.getUserProfile(userId);
      
      if (!user) {
        console.log("User not found in cache, fetching profile for ID:", userId);
        try {
          const fetchedUser = await serverUsersStore.fetchUserProfile(userId);
          if (!fetchedUser) {
            console.error("Failed to fetch user profile for ID:", userId);
            return;
          }
          user = fetchedUser;
        } catch (error) {
          console.error("Error fetching user profile:", error);
          return;
        }
      }

      selectedUser.value = user;
      showProfileModal.value = true;
      event?.stopPropagation();
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

    // Current server data for invite modal
    const currentServerData = computed(() => {
      const serverId = serverChannelStore.currentServerId;
      if (!serverId) return null;
      
      // Get server data from the server store
      const currentServer = serverChannelStore.currentServer;
      return {
        id: serverId,
        name: currentServer?.name || 'Unknown Server',
        icon_url: currentServer?.icon || '',
        member_count: Object.keys(serverUsersStore.userProfiles).length
      };
    });

    const getUserIdFromMessage = (messageId:string) => {
      return useChat.messages.find(message => message.id === messageId)?.user_id || 'Unknown Message Id';
    };
    
    const formatTimestamp = (timestamp: Date) => {
      const date = new Date(timestamp);
      if (!isValid(date)) return '';
      
      if (isToday(date)) {
        return format(date, 'p'); // Time only for today
      } else if (isYesterday(date)) {
        return `Yesterday at ${format(date, 'p')}`;
      } else {
        return format(date, 'MMM d, yyyy \'at\' p'); // Full date and time for older messages
      }
    };

    const formatSystemTimestamp = (timestamp: Date) => {
      const date = new Date(timestamp);
      if (!isValid(date)) return '';
      
      if (isToday(date)) {
        return format(date, 'p'); // Time only for today
      } else if (isYesterday(date)) {
        return `Yesterday at<br/>${format(date, 'p')}`;
      } else {
        return `${format(date, 'MMM d, yyyy')}<br/>${format(date, 'p')}`; // Full date and time for older messages
      }
    };

    // Check if a date separator should be shown before this message
    const shouldShowDateSeparator = (message: Message, index: number): boolean => {
      if (index === 0) return false; // Don't show date separator for first message
      
      const currentDate = new Date(message.created_at);
      const prevMessage = props.messages[index - 1];
      const prevDate = new Date(prevMessage.created_at);
      
      return !isSameDay(currentDate, prevDate);
    };

    // Calculate the indicator's opacity and transform based on buffer distance
    const getIndicatorStyle = () => {
      if (!hasScrollbar.value || bufferDistance.value <= 0) {
        return { 
          opacity: 0, 
          transform: 'translateY(-20px)',
          pointerEvents: 'none' as 'none'
        };
      }
      
      // Calculate progress from 0 to 1 based on buffer distance
      const progress = Math.min(bufferDistance.value / BUFFER_THRESHOLD, 1);
      const opacity = progress;
      const translateY = -20 + (progress * 20); // Start at -20px, end at 0px
      
      return {
        opacity: opacity,
        transform: `translateY(${translateY}px)`,
        pointerEvents: progress > 0.5 ? ('auto' as 'auto') : ('none' as 'none'), // Enable interactions when mostly visible
        transition: 'opacity 0.2s ease-out, transform 0.2s ease-out' // Add smooth CSS transition
      };
    };

    // Format date for the separator display
    const formatDateSeparator = (timestamp: Date): string => {
      const date = new Date(timestamp);
      if (!isValid(date)) return '';
      
      if (isToday(date)) {
        return 'Today';
      } else if (isYesterday(date)) {
        return 'Yesterday';
      } else {
        return format(date, 'MMMM d, yyyy');
      }
    };

    const isLightboxOpen = ref(false);
    const indexRef = ref(0);

    const handleImageLoaded = (url: string) => {
      imageLoaded.value[url] = true;
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

    const handleScroll = () => {
      if (!messageDisplayContainer.value) return;
      
      const { scrollTop, scrollHeight, clientHeight } = messageDisplayContainer.value;
      
      // Check if content is scrollable
      checkScrollable();
      
      // Update isAtTop reactive property
      const isCurrentlyAtTop = scrollTop === 0;
      isAtTop.value = isCurrentlyAtTop;
      
      // Reset buffer when not at top or no scrollbar
      if (!isCurrentlyAtTop || !hasScrollbar.value) {
        bufferDistance.value = 0;
      }
      
      // Load more messages when at top
      if (isCurrentlyAtTop && props.loadMoreMessages) {
        props.loadMoreMessages();
      }

      // Calculate if we're at bottom with small tolerance
      const isAtBottom = scrollTop + clientHeight >= scrollHeight - 5;
      emit('update:isAtBottom', isAtBottom);
    };

    // Handle wheel events to detect scroll attempts beyond top
    const handleWheel = (event: WheelEvent) => {
      if (!messageDisplayContainer.value || !hasScrollbar.value) return;
      
      // Only handle when at top and scrolling up
      if (isAtTop.value && event.deltaY < 0) {
        event.preventDefault();
        
        // Accumulate buffer distance
        bufferDistance.value += Math.abs(event.deltaY) * 0.5; // Dampen the effect
        
        // Cap the buffer distance to prevent excessive accumulation
        bufferDistance.value = Math.min(bufferDistance.value, BUFFER_THRESHOLD * 2);
      } else if (event.deltaY > 0) {
        // Reset when scrolling down
        bufferDistance.value = 0;
      }
    };

    // Enhanced reply message handling
    const getReplyMessageContent = (replyMessageId: string) => {
      // First check if message is in current messages
      const currentMessage = props.messages.find(msg => msg.id === replyMessageId);
      if (currentMessage) {
        return currentMessage.content;
      }

      // Check if message is in reply cache
      const cachedMessage = replyMessages.value[replyMessageId];
      if (cachedMessage) {
        return cachedMessage.content;
      }

      // Fetch the message if not found
      fetchReplyMessageIfNeeded(replyMessageId);
      
      // Return empty array while loading
      return [];
    };

    // Handle clicking on reply messages - implement jump functionality
    const handleReplyClick = async (replyMessageId: string) => {
      // Get current channel ID from store
      const currentChannelId = useChat.currentChannelId;
      if (!currentChannelId) return;

      // Attempt to jump to the message
      const success = await useChat.jumpToMessage(replyMessageId, currentChannelId);
      if (!success) {
        console.warn(`Could not jump to message: ${replyMessageId}`);
      }
    };

    // Implement highlight message functionality
    useChat.highlightMessage = (messageId: string) => {
      nextTick(() => {
        const messageElement = document.getElementById(`message-${messageId}`);
        if (messageElement) {
          messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          messageElement.classList.add('highlighted');
          
          // Remove highlight after 3 seconds
          setTimeout(() => {
            messageElement.classList.remove('highlighted');
          }, 3000);
        }
      });
    };

    const highlightMessage = (messageId: string) => {
      // scroll up to message id
      const messageElement = document.getElementById(`message-${messageId}`);
      if (messageElement) {
        messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        messageElement.classList.add('highlighted');
        
        // Remove highlight after 3 seconds
        setTimeout(() => {
          messageElement.classList.remove('highlighted');
        }, 3000);
      }
    }

    const replyTo = (message: Message) => {
      // Get display name synchronously without triggering async operations
      const user = serverUsersStore.getUserProfile(message.user_id);
      const displayName = user?.display_name || 'Unknown User';
      emit('replyingTo', message.id, displayName);
    }

    // Permission checks for message editing/deletion
    const canEditMessage = (message: Message) => {
      if (!authStore.session?.user) return false;
      
      // Users can edit their own messages
      if (message.user_id === authStore.session.user.id) {
        return true;
      }
      
      // Server owners can edit any message (including system messages)
      if (isCurrentUserServerOwner.value) {
        return true;
      }
      
      return false;
    };

    const canDeleteMessage = (message: Message) => {
      if (!authStore.session?.user) return false;
      
      // Users can delete their own messages
      if (message.user_id === authStore.session.user.id) {
        return true;
      }
      
      // Server owners can delete any message (including system messages)
      if (isCurrentUserServerOwner.value) {
        return true;
      }
      
      return false;
    };

    const getReplyUserDisplayName = (replyMessageId: string) => {
      const userId = getReplyUserId(replyMessageId);
      if (userId === 'unknown') return 'Unknown User';
      return getUserDisplayName(userId).value;
    };

    const getReplyUserColor = (replyMessageId: string) => {
      const userId = getReplyUserId(replyMessageId);
      if (userId === 'unknown') return '#dddddd';
      return getUserColor(userId).value;
    };

    const getReplyUserAvatar = (replyMessageId: string) => {
      const userId = getReplyUserId(replyMessageId);
      if (userId === 'unknown') return '/default_avatar.png';
      return getUserAvatarUrl(userId).value;
    };

    const fetchReplyMessageIfNeeded = async (replyMessageId: string) => {
      // Don't fetch if already exists or is being fetched
      if (replyMessages.value[replyMessageId] || 
          props.messages.find(msg => msg.id === replyMessageId)) {
        return;
      }

      try {
        const message = await useChat.fetchReplyMessage(replyMessageId);
        if (message) {
          replyMessages.value[replyMessageId] = message;
        }
      } catch (error) {
        console.error('Error fetching reply message:', error);
      }
    };

    // Get reply message preview as plain text
    const getReplyMessagePreview = (replyMessageId: string) => {
      // First check if message is in current messages
      const currentMessage = props.messages.find(msg => msg.id === replyMessageId);
      if (currentMessage) {
        return messagePartsToPlainText(currentMessage.content);
      }

      // Check if message is in reply cache
      const cachedMessage = replyMessages.value[replyMessageId];
      if (cachedMessage) {
        return messagePartsToPlainText(cachedMessage.content);
      }

      // Fetch the message if not found
      fetchReplyMessageIfNeeded(replyMessageId);
      
      // Return loading text while fetching
      return 'Loading...';
    };

    // Computed property to filter reactions with valid emoji data
    const getValidReactions = (message: Message) => {
      if (!message.reactions) return [];
      return message.reactions.filter(reaction => reaction.emoji && reaction.emoji.id);
    };

    return { 
      getUserDisplayName, 
      getUserColor, 
      getUserAvatarUrl,
      getUserIdFromMessage,
      formatTimestamp,
      formatSystemTimestamp,
      shouldShowDateSeparator,
      getIndicatorStyle,
      formatDateSeparator,
      closeLightbox,
      lightboxImages, 
      isLightboxOpen,
      indexRef,
      imageLoaded,
      handleImageLoaded,
      handleOpenLightbox,
      messageDisplayContainer,
      handleScroll,
      hoveredMessageId,
      isAtTop,
      hasScrollbar,
      checkScrollable,
      handleWheel,
      deleteMessage,
      toggleReaction,
      handleToggleReaction,
      startEdit,
      saveEdit,
      cancelEdit,
      editableMessageId,
      editableMessageContent,
      showUserProfile,
      selectedUser,
      showProfileModal,
      showInviteModal,
      currentServerData,
      serverChannelStore,
      openInviteModal,
      closeInviteModal, 
      closeProfile,
      isSingleEmojiMessage,
      openEmojiReactor,
      replyTo,
      highlightMessage,
      tooltip,
      showTooltip,
      hideTooltip,
      shouldShowHeader,
      // Add missing functions to return
      getReplyMessageContent,
      getReplyMessagePreview,
      handleReplyClick,
      canEditMessage,
      canDeleteMessage,
      getValidReactions,
      getReplyUserDisplayName,
      getReplyUserColor,
      getReplyUserAvatar,
      contentToEditableText,
      parseEditedText,
      findEmojiByName,
      chatStore: useChat, // Expose chat store for template
      // Add utility functions
      messagePartsToMarkdown,
      messagePartsToPlainText,
      checkSingleEmoji,
    };
  }
});
</script>
<style scoped>
/* Modern message display styles */
.message-display {
  flex-grow: 1;
  overflow-y: auto;
  margin-right: 4px;
  padding: 20px 0 10px 0;
  height: calc(100vh - 165px);
}

/* Individual message item */
.message-item {
  position: relative;
  margin-bottom: 1px;
  padding: 0 16px;
  transition: background-color 0.1s ease-out;
}

.message-item:hover {
  background-color: rgba(4, 4, 5, 0.07);
}

/* Reply reference styling */
.reply-reference {
  margin-left: 48px;
  cursor: pointer;
  position: relative;
}

.reply-spine {
  position: absolute;
  left: -32px;
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
  width: 30px;
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
  color: #dcddde;
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
  padding: 4px 0;
}

/* .message-group.has-header {
  margin-top: 16px;
} */

.message-group.compact {
  margin-top: 0.125rem;
}

/* Message header with avatar + username + timestamp */
.message-header {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 2px 0;
}

.message-avatar {
  flex-shrink: 0;
  margin-top: 2px;
}

.message-main {
  flex: 1;
  min-width: 0;
}

.message-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 2px;
}

.username {
  font-weight: 500;
  font-size: 1rem;
  cursor: pointer;
  transition: text-decoration 0.1s ease;
}

.username:hover {
  text-decoration: underline;
}

.timestamp {
  font-size: 0.75rem;
  color: #a3a6aa;
  font-weight: 400;
}

/* Compact message (no header) */
.message-content-only {
  display: flex;
  align-items: flex-start;
  padding: 0.125rem 0;
  min-height: 1.375rem;
}

.message-gutter {
  width: 48px;
  margin-left: 4px;
  flex-shrink: 0;
  position: relative;
}

/* Show timestamp on hover for compact messages */
.message-content-only:hover .message-gutter::before {
  content: attr(data-timestamp);
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.6875rem;
  color: #a3a6aa;
  background-color: var(--background-primary);
  padding: 0 4px;
  border-radius: 3px;
  white-space: nowrap;
}

/* Message actions */
.message-actions {
  position: absolute;
  top: -16px;
  right: 16px;
  display: flex;
  background-color: #36393f;
  border: 1px solid #40444b;
  border-radius: 8px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  z-index: 1;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  cursor: pointer;
  color: #b9bbbe;
  transition: all 0.15s ease-out;
  border-radius: 4px;
  margin: 2px;
}

.action-btn:hover {
  background-color: #40444b;
  color: #dcddde;
}

.action-btn:active {
  background-color: #2f3136;
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
  background-color: #40444b;
}

.date-separator-text {
  padding: 0 16px;
  /* background-color: #36393f; */
  color: #b9bbbe;
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
  color: #b9bbbe;
  line-height: 1.4;
  opacity: 0.8;
}

/* Highlighted message */
.highlighted {
  background-color: hsla(34, 100%, 50%, 0.1) !important;
  border-left: 4px solid hsl(34, 100%, 50%);
  animation: highlight-fade 3s ease-out;
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
  color: #dcddde;
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
  background: linear-gradient(90deg, #40444b 0%, #484c52 50%, #40444b 100%);
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
  background: linear-gradient(90deg, #40444b 0%, #484c52 50%, #40444b 100%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s infinite;
  border-radius: 4px;
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
    padding: 0 12px;
  }
  
  .reply-reference {
    margin-left: 44px;
  }
  
  .message-header {
    gap: 12px;
  }
  
  .message-gutter {
    width: 44px;
  }
  
  .reactions-gutter {
    width: 44px;
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
  background-color: rgba(88, 101, 242, 0.1);
  border-left: 4px solid #5865f2;
  border-radius: 0 4px 4px 0;
  margin-left: 4px;
  font-size: 0.875rem;
  width: 100%;
  color: #b9bbbe;
}


.system-icon {
  font-size: 1rem;
  flex-shrink: 0;
}

.system-text {
  flex: 1;
  color: #dcddde;
}

.system-text :deep(.system-message-content) {
  color: inherit !important;
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
</style>