<template>
  <div class="message-display" ref="messageDisplayContainer" @scroll="handleScroll">
    <div class="no-messages" v-if="messages.length == 0">
      There are no messages here, type something!
    </div>
    <div v-else v-for="(message, index) in messages" :key="message.id" :id="`message-${message.id}`" class="message-item" @mouseover="hoveredMessageId = message.id" @mouseleave="hoveredMessageId = null">
      <!-- Gap indicator for jumped-to messages -->
      <div v-if="chatStore.messageGaps.has(`gap-before-${message.id}`)" class="message-gap">
        <div class="gap-line"></div>
        <div class="gap-text">Jump in conversation</div>
        <div class="gap-line"></div>
      </div>
      
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
              :src="getUserAvatar(message.user_id)"
              size="sm" 
              :interactive="true"
              @click="showUserProfile(message.user_id, $event)"
            />
          </div>
          <div class="message-main">
            <div class="message-meta">
              <span class="username" :style="{color: getUserColor(message.user_id)}" @click="showUserProfile(message.user_id, $event)">
                {{ getUserDisplayName(message.user_id) }}
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
          <div class="action-btn" @click="openEmojiReactor(message)"><ReactionIcon/></div>
          <div class="action-btn" @click="replyTo(message)"><ReplyIcon/></div>
          <div class="action-btn" v-if="canEditMessage(message)" @click="startEdit(message)"><EditIcon/></div>
          <div class="action-btn" v-if="canDeleteMessage(message)" @click="deleteMessage(message.id)"><DeleteIcon/></div>
          <div class="action-btn"><MoreIcon/></div>
        </div>
        
        <!-- Reactions -->
        <div class="reactions" v-if="message.reactions && message.reactions.length > 0">
          <div class="reactions-gutter"></div>
          <div class="reactions-container">
            <div
              v-for="reaction in message.reactions"
              :key="reaction.id"
              class="reaction"
              @click="toggleReaction(message.id, reaction.emoji)"
              @mouseenter="showTooltip($event, reaction)"
              @mouseleave="hideTooltip"
              :class="{'reacted': reaction.reactions.some(r => r.user_id === currentUserId)}"
            >
              <img 
                :src="reaction.emoji.url" 
                :alt="reaction.emoji.name"
              />
              <span class="reaction-count">{{ reaction.count }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
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
    <div v-for="user in tooltip.content" :key="user.id">
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
import { defineComponent, computed, ref, watch, nextTick } from 'vue';
import type { PropType, Ref } from 'vue';
import type { Message, User, Emoji, Reaction, MessagePart, Profile } from '@/types';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useChatStore } from '@/stores/useChat';
import { useAuthStore } from '@/stores/auth';
import { useServerChannelStore } from '@/stores/useServerChannel'; 
import { format } from 'date-fns';
import UserProfileModal from '@/components/UserProfileModal.vue';
import InviteModal from '@/components/InviteModal.vue';
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue';
import ReactionIcon from '@/components/icons/Reaction.vue';
import ReplyIcon from '@/components/icons/Reply.vue';
import EditIcon from '@/components/icons/Edit.vue';
import DeleteIcon from '@/components/icons/Delete.vue';
import MoreIcon from '@/components/icons/More.vue';
import Avatar from '@/components/common/Avatar.vue';
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
    Avatar
  },
  setup(props, { emit }) {
    const messageDisplayContainer = ref<HTMLDivElement | null>(null);
    const serverUsersStore = useServerUsersStore();
    const serverChannelStore = useServerChannelStore();
    const useChat = useChatStore();
    const authStore = useAuthStore();
    
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


    const showTooltip = (event: MouseEvent, reaction: Reaction) => {
      // Cancel any existing timer to prevent unwanted tooltip behavior
      if (tooltipTimer.value) {
        clearTimeout(tooltipTimer.value);
      }
      const usersDetails = reaction.reactions.map(r => ({
        id: r.user_id,
        displayName: getUserDisplayName(r.user_id),
        avatarUrl: getUserAvatar(r.user_id),
        userColor: getUserColor(r.user_id),
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
      }, 500); // 2000 milliseconds delay
    };

    const hideTooltip = () => {
      if (tooltipTimer.value) {
        clearTimeout(tooltipTimer.value);
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

    // Watch for changes in messages for parsing
    watch(() => props.messages, (newMessages) => {
      if (!newMessages || !Array.isArray(newMessages)) {
        return;
      }

      const oldScrollHeight = messageDisplayContainer.value ? messageDisplayContainer.value.scrollHeight : 0;

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

      if (newMessages && newMessages.length > 0) {
        // Recalculate scroll height
        nextTick(() => {
          if (messageDisplayContainer.value) {
            const newScrollHeight = messageDisplayContainer.value.scrollHeight;
            const scrollOffset = newScrollHeight - oldScrollHeight;
            messageDisplayContainer.value.scrollTop += scrollOffset;
          }
          // FIXME: manually call to scroll down to bottom, although we probably dont want if we've scrolled up
          handleScroll();
        });
      }
    }, { immediate: true, deep: true });

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

    const openEmojiReactor = (message: Message) => {
      // set true if not an emoji for the input but a reaction
      emit('toggleEmojiList', true, message);
    }

    const toggleReaction = (messageId: string, emoji: Emoji) => {
      emit('sendReaction', messageId, emoji);
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

      return result;
    };

    // Find emoji by name (reuse existing logic)
    const findEmojiByName = (name: string) => {
      const resolvedEmojiList = serverChannelStore.resolvedEmojiList;
      for (const serverId in resolvedEmojiList) {
        const server = resolvedEmojiList[serverId];
        const emoji = server.emojis.find(e => e.name === name);
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
      if (!editableMessageId.value) return;

      try {
        const textContent = newContent ?? editableMessageContent.value;
        
        // Don't save if content is empty
        if (!textContent.trim()) {
          cancelEdit();
          return;
        }

        // Parse the edited text back to structured content
        const parsedContent = parseEditedText(textContent);
        
        // Update the message with structured content
        await useChat.editMessage(messageId, parsedContent);
        
        // Reset edit state
        editableMessageId.value = null;
        editableMessageContent.value = '';
      } catch (error) {
        console.error('Error saving message edit:', error);
        // TODO: Show error message to user
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
    const showUserProfile = (userId: string, event?: MouseEvent) => {
      const user = serverUsersStore.userProfiles[userId];
      if (!user) {
        console.error("User not found for ID:", userId);
        return;
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
    const getUserDisplayName = (userId:string) => {
      return serverUsersStore.userProfiles[userId]?.display_name || 'Unknown User';
    };
    const getUserColor = (userId:string) => {
      const profile = serverUsersStore.userProfiles[userId] as Profile;
      return `${profile?.color || '#dddddd'}`;
    };
    const getUserAvatar = (userId:string) => {
      return serverUsersStore.userProfiles[userId]?.avatar_url || '/default_avatar.png';
    };
    const formatTimestamp = (timestamp:Date) => {
      return format(new Date(timestamp), 'p'); // Formats to the user's locale time
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
      if (messageDisplayContainer.value) {
        const { scrollTop } = messageDisplayContainer.value;
        if (scrollTop === 0) {
          // console.log('fetchMore!');
          emit('loadMoreMessages');
        }

        // Emit event instead of mutating the prop
        emit('update:isAtBottom', false);
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
      emit('replyingTo', message.id, getUserDisplayName(message.user_id));
    }

    // Permission checks for message editing/deletion
    const canEditMessage = (message: Message) => {
      if (!authStore.session?.user) return false;
      
      // Users can edit their own messages
      if (message.user_id === authStore.session.user.id) {
        return true;
      }
      
      // TODO: Add admin permission check when admin roles are implemented
      // For now, only allow editing own messages
      return false;
    };

    const canDeleteMessage = (message: Message) => {
      if (!authStore.session?.user) return false;
      
      // Users can delete their own messages
      if (message.user_id === authStore.session.user.id) {
        return true;
      }
      
      // TODO: Add admin permission check when admin roles are implemented
      // For now, only allow deleting own messages
      return false;
    };

    const getReplyUserDisplayName = (replyMessageId: string) => {
      const userId = getReplyUserId(replyMessageId);
      return serverUsersStore.userProfiles[userId]?.display_name || 'Loading...';
    };

    const getReplyUserColor = (replyMessageId: string) => {
      const userId = getReplyUserId(replyMessageId);
      const profile = serverUsersStore.userProfiles[userId] as Profile;
      return `${profile?.color || '#dddddd'}`;
    };

    const getReplyUserAvatar = (replyMessageId: string) => {
      const userId = getReplyUserId(replyMessageId);
      return serverUsersStore.userProfiles[userId]?.avatar_url || '/default_avatar.png';
    };

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

    return { 
      getUserDisplayName, 
      getUserColor, 
      getUserAvatar,
      getUserIdFromMessage,
      formatTimestamp,
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
      deleteMessage,
      toggleReaction,
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
  padding: 0;
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
  margin: 4px 0 4px 62px;
  padding: 2px 0;
  font-size: 0.875rem;
  cursor: pointer;
  position: relative;
}

.reply-spine {
  position: absolute;
  left: -46px;
  top: -8px;
  width: 2px;
  height: 20px;
  background-color: #4f545c;
  border-radius: 1px;
}

.reply-spine::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 36px;
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
}

.message-group.has-header {
  margin-top: 16px;
}

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
  margin-left: 8px;
}

/* Compact message (no header) */
.message-content-only {
  display: flex;
  align-items: flex-start;
  padding: 0.125rem 0;
  min-height: 1.375rem;
}

.message-gutter {
  width: 62px;
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

/* Reactions */
.reactions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.reactions-gutter {
  width: 62px;
  flex-shrink: 0;
}

.reactions-container {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.reaction {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  background-color: #2f3136;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.875rem;
  transition: all 0.15s ease-out;
  user-select: none;
}

.reaction:hover {
  background-color: #40444b;
  border-color: #4f545c;
}

.reaction.reacted {
  background-color: hsl(235, 85.6%, 64.7%, 0.15);
  border-color: hsl(235, 85.6%, 64.7%);
}

.reaction img {
  width: 16px;
  height: 16px;
  object-fit: contain;
}

.reaction-count {
  font-size: 0.8125rem;
  font-weight: 500;
  color: #72767d;
  min-width: 9px;
  text-align: center;
}

.reaction.reacted .reaction-count {
  color: hsl(235, 85.6%, 64.7%);
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

/* Highlighted message */
.highlighted {
  background-color: hsl(359, 82.6%, 59.4%, 0.1) !important;
  border-left: 4px solid hsl(359, 82.6%, 59.4%);
  animation: highlight-fade 3s ease-out;
}

@keyframes highlight-fade {
  0% {
    background-color: hsl(359, 82.6%, 59.4%, 0.3) !important;
  }
  100% {
    background-color: hsl(359, 82.6%, 59.4%, 0.1) !important;
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
    margin-left: 58px;
  }
  
  .message-header {
    gap: 12px;
  }
  
  .message-gutter {
    width: 58px;
  }
  
  .reactions-gutter {
    width: 58px;
  }
}

/* Dark theme adjustments */
@media (prefers-color-scheme: dark) {
  .message-item:hover {
    background-color: rgba(79, 84, 92, 0.16);
  }
}
</style>