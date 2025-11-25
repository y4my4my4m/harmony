<template>
  <div class="message-display" ref="messageDisplayContainer" @scroll="handleScroll">
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
    
    <template v-for="(message, index) in messages" :key="`wrapper-${message.id}`">
      <!-- Beginning of conversation indicator (only show when all messages loaded) -->
      <div v-if="index === 0 && hasScrollbar && isAllMessagesLoaded" class="beginning-indicator" :style="getIndicatorStyle()">
        <div class="beginning-content">
          <div class="beginning-icon">🌟</div>
          <div class="beginning-text">
            <div class="beginning-title">{{ $t('message.conversationBeginning') }}</div>
            <div class="beginning-subtitle">{{ $t('message.conversationBeginningSubtitle') }}</div>
          </div>
        </div>
      </div>

      <!-- Date separator -->
      <div v-if="shouldShowDateSeparator(message, index)" class="date-separator">
        <div class="date-separator-line"></div>
        <span class="date-separator-text">{{ formatDateSeparator(message.created_at) }}</span>
        <div class="date-separator-line"></div>
      </div>

      <div 
        :id="`message-${message.id}`" 
        :data-message-id="message.id"
        class="message-item" 
        @mouseover="hoveredMessageId = message.id" 
        @mouseleave="hoveredMessageId = null"
      >
        <!-- Gap indicator for jumped-to messages -->
        <div v-if="chatStore.messageGaps.has(`gap-before-${message.id}`)" class="message-gap">
          <div class="gap-line"></div>
          <div class="gap-text">{{ $t('message.jumpInConversation') }}</div>
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
                  :embed-payloads="message.metadata?.embeds"
                  @show-user-profile="showUserProfile"
                />
              </div>
            </div>
          </div>
          
          <!-- Message actions for system messages (if hovered) -->
          <div class="message-actions" v-if="hoveredMessageId === message.id">
            <div class="action-btn" @click="openEmojiReactor(message, $event)"><ReactionIcon/></div>
            <div class="action-btn" v-if="canDeleteMessage(message)" @click="deleteMessage(message.id)"><DeleteIcon/></div>
            <div class="action-btn" @click="openContextMenu(message, $event)"><MoreIcon/></div>
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
              :src="getAuthorAvatarUrl(message).value"
              size="sm" 
              :interactive="true"
              @click="getMessageAuthorId(message) && showUserProfile(getMessageAuthorId(message), $event)"
            />
          </div>
          <div class="message-main">
            <div class="message-meta">
              <span class="username" :style="{color: getAuthorColor(message).value}" @click="getMessageAuthorId(message) && showUserProfile(getMessageAuthorId(message), $event)">
                {{ getAuthorDisplayName(message).value }}
                <span v-if="hasDiscordUserMetadata(message)" class="bot-badge discord">DISCORD</span>
                <span v-else-if="isMessageFromBot(message)" class="bot-badge">BOT</span>
              </span>
              <span class="timestamp">
                {{ formatTimestamp(message.created_at) }}
                <!-- Encryption indicators -->
                <span 
                  v-if="message.decrypted" 
                  class="encryption-dot decrypted"
                  :title="'End-to-end encrypted'"
                ></span>
                <span 
                  v-else-if="message.encrypted" 
                  class="encryption-indicator locked"
                  :title="'End-to-end encrypted - You cannot decrypt this message'"
                >🔒</span>
              </span>
            </div>
            <UnifiedMessageContent 
              :content="message.content"
              :message-id="message.id"
              :editable-message-id="editableMessageId"
              :editable-content="editableMessageContent"
              :image-loaded="imageLoaded"
              :is-single-emoji="checkSingleEmoji(message.content)"
              :embed-payloads="message.metadata?.embeds"
              :encrypted="message.encrypted || false"
              :decrypted="message.decrypted || false"
              @image-loaded="handleImageLoaded"
              @open-lightbox="handleOpenLightbox"
              @update:message="saveEdit"
              @update:content="editableMessageContent = $event"
              @cancel-edit="cancelEdit"
              @show-user-profile="showUserProfile"
            />
            <!-- Edited indicator for messages with headers -->
            <span 
              v-if="isMessageEdited(message)" 
              class="edited-indicator inline"
              :title="message.updated_at ? `Edited at ${formatTimestamp(message.updated_at)}` : 'Edited'"
            >(edited)</span>
          </div>
        </div>
        
        <!-- Compact message (no header, just content aligned with previous messages) -->
        <div v-else class="message-content-only">
          <div class="message-gutter" :data-timestamp="formatTimeOnly(message.created_at)"></div>
          <div class="message-main">
            <UnifiedMessageContent 
              :content="message.content"
              :message-id="message.id"
              :editable-message-id="editableMessageId"
              :editable-content="editableMessageContent"
              :image-loaded="imageLoaded"
              :is-single-emoji="checkSingleEmoji(message.content)"
              :embed-payloads="message.metadata?.embeds"
              :encrypted="message.encrypted || false"
              :decrypted="message.decrypted || false"
              @image-loaded="handleImageLoaded"
              @open-lightbox="handleOpenLightbox"
              @update:message="saveEdit"
              @update:content="editableMessageContent = $event"
              @cancel-edit="cancelEdit"
              @show-user-profile="showUserProfile"
            />
            <!-- Edited indicator for compact messages -->
            <span 
              v-if="isMessageEdited(message)" 
              class="edited-indicator compact"
              :title="message.updated_at ? `Edited at ${formatTimestamp(message.updated_at)}` : 'Edited'"
            >(edited)</span>
          </div>
        </div>
        
        <!-- Message actions -->
        <div class="message-actions" v-if="hoveredMessageId === message.id">
          <div ref="reactionBtn" class="action-btn" @click="openEmojiReactor(message, $event)"><ReactionIcon/></div>
          <div class="action-btn" @click="replyTo(message)"><ReplyIcon/></div>
          <div class="action-btn" v-if="canEditMessage(message)" @click="startEdit(message)"><EditIcon/></div>
          <div class="action-btn" v-if="canDeleteMessage(message)" @click="deleteMessage(message.id)"><DeleteIcon/></div>
          <div class="action-btn" @click="openContextMenu(message, $event)"><MoreIcon/></div>
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
      <span>{{ user.displayName }}</span>
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
  />
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue';
import type { PropType, Ref } from 'vue';
import type { Message, User, Emoji, Reaction } from '@/types';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useChatStore } from '@/stores/useChat';
import { useDMStore } from '@/stores/useDM';
import { useAuthStore } from '@/stores/auth';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useNotificationStore } from '@/stores/useNotification';
import { supabase } from '@/supabase'; 
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
import MessageContextMenu from '@/components/MessageContextMenu.vue';
import { messagePartsToMarkdown, messagePartsToPlainText, isSingleEmojiMessage as checkSingleEmoji } from '@/utils/messageContentUtils';
import { parseContentToMessageParts, resolveMentionsUserData } from '@/utils/unifiedContentProcessing';
import { getEmojiUrl } from '@/utils/emojiUtils';

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
});

const emit = defineEmits(['loadMoreMessages', 'toggleEmojiList', 'sendReaction', 'replyingTo', 'update:isAtBottom']);

// --- STORES & COMPOSABLES ---
const serverUsersStore = useServerUsersStore();
const serverChannelStore = useServerChannelStore();
const chatStore = useChatStore();
const dmStore = useDMStore();
const authStore = useAuthStore();
const { isCurrentUserServerOwner } = useServerPermissions();
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
    console.error('Failed to fetch bot data:', error);
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
  //   console.log('🔍 Bot message without Discord metadata:', message.id, message.metadata);
  // }
  // if (hasMetadata) {
  //   console.log('✅ Discord user found:', message.metadata?.discord_user);
  // }
  return hasMetadata;
};

// Helper function to get Discord user info from metadata
const getDiscordUserInfo = (message: Message): { username: string; display_name: string; avatar_url: string } | null => {
  return message.metadata?.discord_user || null;
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
    return bot?.avatar_url || '/default_avatar.png';
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
      return message.metadata.discord_user.avatar_url || '/default_avatar.png';
    }
    
    // Regular bot
    if (message.bot_id) {
      const bot = botDataCache.value.get(message.bot_id);
      return bot?.avatar_url || '/default_avatar.png';
    }
    
    // Regular user
    if (message.user_id) {
      return getUserAvatarUrl(message.user_id).value;
    }
    
    return '/default_avatar.png';
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
const isAtTop = ref(false);
const hasScrollbar = ref(false);
const bufferDistance = ref(0);
const selectedUser = ref<User | null>(null);
const showProfileModal = ref(false);
const showInviteModal = ref(false);

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
        console.error('Error ensuring user profiles are available:', error);
      });
    }, 0);
  }

  if (newMessages.length > 0) {
    nextTick(() => {
      if (messageDisplayContainer.value) {
        const newScrollHeight = messageDisplayContainer.value.scrollHeight;
        const scrollOffset = newScrollHeight - oldScrollHeight;
        
        // If this is the initial load (old height was 0), scroll to bottom
        if (oldScrollHeight === 0 && newMessages.length > 0) {
          console.log('📜 Initial load - scrolling to bottom');
          // Use setTimeout to ensure DOM is fully rendered
          setTimeout(() => {
            if (messageDisplayContainer.value) {
              messageDisplayContainer.value.scrollTop = messageDisplayContainer.value.scrollHeight;
            }
          }, 50);
        } 
        // When loading older messages, maintain scroll position by compensating for new content
        else if (scrollOffset > 0 && oldScrollHeight > 0) {
          console.log('📜 Maintaining scroll position after loading older messages');
          messageDisplayContainer.value.scrollTop += scrollOffset;
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
let intersectionObserver: IntersectionObserver | null = null;
const observedMessages = new Set<string>();

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
        clearUnreadCount(messageId);
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
    
    // Update unread_counts table to clear unread counts
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
      console.error('Failed to clear unread count:', error);
    } else {
      console.log('✅ Cleared unread count for', channelId ? 'channel' : 'conversation', channelId || conversationId);
    }
    
    // Mark related notifications as read
    const notificationStore = useNotificationStore();
    const relatedNotifications = notificationStore.notifications.filter(n => 
      (n.data?.message?.id === messageId || n.data?.message_id === messageId) && !n.is_read
    );
    
    for (const notification of relatedNotifications) {
      await notificationStore.markAsRead(notification.id);
    }
  } catch (error) {
    console.error('Error clearing unread count:', error);
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
  if (intersectionObserver) {
    intersectionObserver.disconnect();
    intersectionObserver = null;
  }
  observedMessages.clear();
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
});

// --- METHODS ---

// Tooltip Handling
const showTooltip = async (event: MouseEvent, reaction: Reaction) => {
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  const userIds = reaction.reactions.map(r => r.user_id);
  await ensureProfilesAvailable(userIds).catch(error => console.error("Error ensuring profiles for tooltip:", error));

  const usersDetails = reaction.reactions.map(r => ({
    id: r.user_id,
    displayName: getUserDisplayName(r.user_id).value,
    avatarUrl: getUserAvatarUrl(r.user_id).value,
    userColor: getUserColor(r.user_id).value,
  }));
  
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
    console.log('📜 At top! hasScrollbar:', hasScrollbar.value, 'loadMoreMessages:', !!props.loadMoreMessages);
    
    if (props.loadMoreMessages) {
      props.loadMoreMessages();
    } else {
      console.log('❌ No loadMoreMessages function provided!');
    }
  }

  emit('update:isAtBottom', scrollTop + clientHeight >= scrollHeight - 5);
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
  else if (prevMessage.user_id !== message.user_id || prevMessage.bot_id !== message.bot_id) {
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
  
  const currentUserId = authStore.session.user.id;
  const messageUserId = message.user_id;
  return messageUserId === currentUserId || isCurrentUserServerOwner.value;
};

const canDeleteMessage = (message: Message) => {
  if (!authStore.session?.user || !message) return false;
  const currentUserId = authStore.session.user.id;
  const messageUserId = message.user_id;
  return messageUserId === currentUserId || isCurrentUserServerOwner.value;
};




    const startEdit = (message: Message) => {
    if (!canEditMessage(message)) return;
    editableMessageId.value = message.id;
    editableMessageContent.value = messagePartsToMarkdown(message.content);
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
    // Use unified content parsing system for consistency
    const userDataMap = await resolveMentionsUserData(textContent);
    const parsedContent = await parseContentToMessageParts(textContent, userDataMap);
    
    await chatStore.editMessage(messageId, parsedContent);
    cancelEdit();
  } catch (error) {
    console.error('Error saving message edit:', error);
  }
};

const cancelEdit = () => {
  editableMessageId.value = null;
  editableMessageContent.value = '';
};

const deleteMessage = (messageId: string) => {
  chatStore.deleteMessage(messageId);
};

const openEmojiReactor = (message: Message, event: MouseEvent) => {
  emit('toggleEmojiList', true, message, event.currentTarget as HTMLElement);
};

const handleToggleReaction = (messageId: string, emoji: Emoji) => {
  if (tooltip.value.visible) hideTooltip();
  emit('sendReaction', messageId, emoji);
};

// Reply Logic
const replyTo = (message: Message) => {
  const displayName = getUserDisplayName(message.user_id).value || 'Unknown User';
  emit('replyingTo', message.id, displayName);
};

const handleReplyClick = async (replyMessageId: string) => {
  if (!chatStore.currentChannelId) return;
  const success = await chatStore.jumpToMessage(replyMessageId, chatStore.currentChannelId);
  if (!success) console.warn(`Could not jump to message: ${replyMessageId}`);
};

const fetchReplyMessageIfNeeded = async (replyMessageId: string) => {
  if (replyMessages.value[replyMessageId] || props.messages.some(msg => msg.id === replyMessageId)) return;
  try {
    const message = await chatStore.fetchReplyMessage(replyMessageId);
    if (message) replyMessages.value[replyMessageId] = message;
  } catch (error) {
    console.error('Error fetching reply message:', error);
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
  return userId === 'unknown' ? '/default_avatar.png' : getUserAvatarUrl(userId).value;
};

const getReplyMessagePreview = (replyMessageId: string) => {
  const message = props.messages.find(msg => msg.id === replyMessageId) || replyMessages.value[replyMessageId];
  if (message) return messagePartsToPlainText(message.content);
  fetchReplyMessageIfNeeded(replyMessageId);
  return 'Loading...';
};


// Lightbox and Media
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

// Context menu handlers
const openContextMenu = (message: Message, event: MouseEvent) => {
  event.preventDefault();
  event.stopPropagation();
  
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
  let user = getUserProfile(userId).value || await fetchUserProfile(userId).catch(e => console.error(e));
  if (user) {
    selectedUser.value = user;
    showProfileModal.value = true;
  } else {
    console.error("Failed to fetch user profile for ID:", userId);
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
  padding: 2px 48px 2px 16px;
  transition: background-color 0.1s ease-out;
}

.message-item:hover {
  background-color: rgba(4, 4, 5, 0.07);
}

/* Reply reference styling */
.reply-reference {
  margin-left: 56px; /* Match the gutter width */
  margin-bottom: 4px;
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

/* Messages with headers get extra top margin for visual separation */
.message-group.has-header {
  margin-top: 1.0625rem;
}

.message-group.compact {
  margin-top: 0;
}

/* Message header with avatar + username + timestamp */
.message-header {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}

.message-avatar {
  flex-shrink: 0;
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

.username {
  font-weight: 500;
  font-size: 1rem;
  cursor: pointer;
  transition: text-decoration 0.1s ease;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.username:hover {
  text-decoration: underline;
}

.bot-badge {
  display: inline-block;
  background: #5865F2;
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
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Show timestamp on hover for compact messages */
.message-content-only:hover .message-gutter::before {
  content: attr(data-timestamp);
  position: absolute;
  left: 0;
  right: 0;
  top: 3px;
  bottom: 0;
  min-height: 24px;
  text-align: center;
  font-size: 0.6875rem;
  color: #72767d;
  font-weight: 500;
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

.skeleton-timestamp {
  width: 50px;
  height: 12px;
  background: linear-gradient(90deg, #40444b 0%, #484c52 50%, #40444b 100%);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s infinite;
  border-radius: 4px;
}

.skeleton-text-line {
  height: 14px;
  background: linear-gradient(90deg, #40444b 0%, #484c52 50%, #40444b 100%);
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
</style>