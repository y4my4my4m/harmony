<!-- MonyPost Component - Individual post display -->
<template>
  <article class="mony-post" 
  v-if="author" :class="{ 'is-reply': post.reply_context, 'is-reblog': isReblog }">
    
    <!-- Reblog Header (if this is a reblog) -->
    <div v-if="isReblog" class="reblog-header">
      <Icon name="reblog" class="reblog-icon" />
      <div 
        class="reblog-author" 
        @click="viewProfile(author)"
        :title="`Reblogged by ${author.display_name || author.username}`"
      >
        {{ author.display_name || author.username }} reblogged
      </div>
      <time 
        :datetime="post.created_at" 
        :title="formatFullDate(post.created_at)"
        class="reblog-time"
      >
        {{ formatRelativeTime(post.created_at) }}
      </time>
    </div>

    <!-- Main Post Content -->
    <div class="post-content" :class="{ 'reblog-content': isReblog }">
      <!-- Author Info (show original author for reblogs) -->
      <div class="post-header">
        <div 
          class="author-info"
          @click="viewProfile(displayAuthor)"
        >
          <Avatar
            :src="displayAuthor.avatar_url"
            :alt="displayAuthor.display_name || displayAuthor.username"
            size="md"
            :interactive="true"
          />
          <div class="author-details">
            <div class="author-name">
              {{ displayAuthor.display_name || displayAuthor.username }}
            </div>
            <div class="author-handle">
              <span>{{ displayAuthor.username }}</span>
              <span class="instance-domain" :class="{ 'is-local': displayAuthor.is_local }">
                @{{ isReblog ? originalInstanceDomain : instanceDomain }}
              </span>
            </div>
          </div>
        </div>
        
        <div class="post-meta">
          <div class="visibility-indicator" :title="visibilityTitle">
            <Icon :name="visibilityIcon" />
          </div>
          <time 
            :datetime="originalCreatedAt" 
            :title="formatFullDate(originalCreatedAt)"
            class="post-time"
            @click="handleTimeClick"
          >
            {{ formatRelativeTime(originalCreatedAt) }}
          </time>
        </div>
      </div>

      <!-- Reply Context (if this is a reply) -->
      <div v-if="displayReplyContext" class="reply-context">
        <div class="reply-header">
          <div class="reply-indicator">
            <Icon name="reply" class="reply-icon" />
            <span class="reply-text">Replying to</span>
          </div>
          <button 
            class="show-conversation-btn"
            @click="showReplyTarget"
            title="View full conversation"
          >
            <Icon name="thread" :size="16" />
            <span>Show thread</span>
          </button>
        </div>
        <div class="reply-preview-card">
          <Avatar 
            :src="displayReplyContext.author.avatar_url"
            :alt="displayReplyContext.author.display_name"
            size="xs"
          />
          <div class="reply-details">
            <span class="reply-author">@{{ displayReplyContext.author.username }}</span>
            <span class="reply-content-preview">
              <MonyContent 
                :content="replyContentText" 
                :isPreview="true" 
                :previewLength="100" 
              />
            </span>
          </div>
        </div>
      </div>

      <!-- Content Warning -->
      <div v-if="displayContentWarning" class="content-warning">
        <div class="cw-header">
          <Icon name="warning" />
          <span>{{ displayContentWarning }}</span>
        </div>
        <button 
          class="cw-toggle"
          @click="showSensitiveContent = !showSensitiveContent"
        >
          {{ showSensitiveContent ? 'Hide' : 'Show' }} content
        </button>
      </div>

      <!-- Post Body -->
      <div 
        v-show="!displayContentWarning || showSensitiveContent"
        class="post-body"
        :class="{ 'is-sensitive': displayIsSensitive }"
      >
        <!-- Quote Post: Show user's comment first, then quoted content -->
        <div v-if="isQuotePost" class="quote-post-layout">
          <!-- User's comment on the quote -->
          <div class="quote-comment">
            <MonyContent 
              :content="userQuoteContent" 
              @user-mention-click="handleMentionClick"
              @hashtag-click="handleHashtagClick"
              @image-click="handleImageClick"
            />
          </div>
          
          <!-- Quoted post content -->
          <div class="quoted-post">
            <div class="quoted-post-header">
              <Avatar
                :src="displayAuthor.avatar_url"
                :alt="displayAuthor.display_name || displayAuthor.username"
                size="sm"
              />
              <div class="quoted-author-info">
                <span class="quoted-author-name">{{ displayAuthor.display_name || displayAuthor.username }}</span>
                <span class="quoted-author-handle">@{{ displayAuthor.username }}</span>
                <time class="quoted-post-time">{{ formatRelativeTime(originalCreatedAt) }}</time>
              </div>
            </div>
            
            <div class="quoted-post-content">
              <MonyContent 
                :content="displayContent" 
                @user-mention-click="handleMentionClick"
                @hashtag-click="handleHashtagClick"
                @image-click="handleImageClick"
              />
            </div>
            
            <!-- Media in quoted post -->
            <div 
              v-if="displayMediaAttachments?.length > 0"
              class="quoted-media-gallery"
            >
              <div 
                v-for="media in displayMediaAttachments" 
                :key="media.id"
                class="media-item"
              >
                <img 
                  v-if="media.type === 'image'" 
                  :src="media.url" 
                  :alt="media.description || 'Media attachment'"
                  class="media-image"
                />
                <video 
                  v-else-if="media.type === 'video'" 
                  :src="media.url" 
                  controls
                  class="media-video"
                >
                  Your browser does not support the video tag.
                </video>
              </div>
            </div>
          </div>
        </div>
        
        <!-- Pure Reblog or Regular Post: Show content normally -->
        <div v-else>
          <!-- Text Content -->
          <div class="post-text">
            <MonyContent 
              :content="displayContent" 
              @user-mention-click="handleMentionClick"
              @hashtag-click="handleHashtagClick"
              @image-click="handleImageClick"
            />
          </div>

          <!-- Media Attachments -->
          <div 
            v-if="displayMediaAttachments?.length > 0"
            class="media-gallery"
          >
            <!-- Simple media display for now -->
            <div 
              v-for="media in displayMediaAttachments" 
              :key="media.id"
              class="media-item"
            >
              <img 
                v-if="media.type === 'image'" 
                :src="media.url" 
                :alt="media.description || 'Media attachment'"
                class="media-image"
              />
              <video 
                v-else-if="media.type === 'video'" 
                :src="media.url" 
                controls
                class="media-video"
              >
                Your browser does not support the video tag.
              </video>
            </div>
          </div>
        </div>
      </div>

      <!-- Post Reactions (Emoji Reactions) - Above action buttons -->
      <PostReactions
        ref="postReactionsRef"
        :post="post"
        @show-reaction-tooltip="handleShowReactionTooltip"
        @hide-reaction-tooltip="handleHideReactionTooltip"
      />

      <!-- Action Buttons -->
      <div class="post-actions">
        <button 
          class="action-button reply-button"
          @click="onReply"
          :title="'Reply to ' + author.display_name"
        >
          <Icon name="message-circle" />
          <span v-if="displayInteractionCounts.replies_count > 0">{{ formatCount(displayInteractionCounts.replies_count) }}</span>
        </button>

        <button 
          class="action-button reblog-button"
          :class="{ active: displayInteractionCounts.is_reblogged }"
          @click="toggleReblog(post.id)"
          :title="displayInteractionCounts.is_reblogged ? 'Undo reblog' : 'Reblog'"
        >
          <Icon name="reblog" />
          <span v-if="displayInteractionCounts.reblogs_count > 0">{{ formatCount(displayInteractionCounts.reblogs_count) }}</span>
        </button>

        <button 
          class="action-button favorite-button"
          :class="{ active: displayInteractionCounts.is_favorited }"
          @click="toggleFavorite(post.id)"
          :title="displayInteractionCounts.is_favorited ? 'Unfavorite' : 'Favorite'"
        >
          <Icon :name="displayInteractionCounts.is_favorited ? 'heart-filled' : 'heart'" />
          <span v-if="displayInteractionCounts.favorites_count > 0 || displayInteractionCounts.is_favorited">{{ formatCount(displayInteractionCounts.favorites_count || 1) }}</span>
        </button>

        <button 
          ref="emojiTriggerRef"
          class="action-button add-reaction-button"
          @click.stop="() => handleShowEmojiPicker(post)"
          title="Add reaction"
        >
          <Icon name="plus" />
        </button>

        <button 
          class="action-button bookmark-button"
          :class="{ active: displayInteractionCounts.is_bookmarked }"
          @click="toggleBookmark(post.id)"
          :title="displayInteractionCounts.is_bookmarked ? 'Remove bookmark' : 'Bookmark'"
        >
          <Icon :name="displayInteractionCounts.is_bookmarked ? 'bookmark-filled' : 'bookmark'" />
        </button>

        <div class="action-menu">
          <button 
            class="action-button menu-button" 
            @click="handleMenuToggle"
            :title="showMenu ? 'Close menu' : 'More options'"
          >
            <Icon name="more-horizontal" />
          </button>
        </div>
        
        <!-- Post action dropdown menu -->
        <div v-if="showMenu" class="action-dropdown">
          <button 
            class="dropdown-item"
            @click="copyLink"
          >
            <Icon name="link" />
            <span>Copy link</span>
          </button>
          
          <button 
            v-if="canEdit"
            class="dropdown-item"
            @click="onEdit"
          >
            <Icon name="edit" />
            <span>Edit</span>
          </button>
          
          <button 
            v-if="canDelete"
            class="dropdown-item danger"
            @click="onDelete"
          >
            <Icon name="trash" />
            <span>Delete</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Inline Reply Composer -->
    <Composer 
      v-if="showInlineReply"
      mode="inline"
      type="reply"
      :reply-to-post="post"
      @posted="handleReplySent"
      @close="showInlineReply = false"
    />

    <!-- Delete Confirmation Modal -->
    <ConfirmationModal
      :show="showDeleteConfirmation"
      title="Confirm Delete"
      message="Are you sure you want to delete this post? This action cannot be undone."
      @confirm="handleDeleteConfirm"
      @cancel="handleDeleteCancel"
      @close="handleDeleteCancel"
    />

    <!-- Emoji Popup for reactions -->
    <EmojiPopup
      v-if="showEmojiPopup"
      :trigger-element="emojiTriggerRef"
      :position="'above'"
      :is-reaction="true"
      :close-emoji-list="closeEmojiPopup"
      @send-emoji="handleEmojiSelected"
      @reset-emoji-icon-clicked="closeEmojiPopup"
    />

    <!-- Tooltip for reactions -->
    <div
      v-if="tooltip.visible"
      class="reaction-tooltip"
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
    
    <!-- Lightbox for images -->
    <vue-easy-lightbox
      :visible="showLightbox"
      :imgs="[currentLightboxImage]"
      :index="0"
      @hide="closeLightbox"
    />
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useUserData } from '@/composables/useUserData';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useNotificationStore } from '@/stores/useNotification';
import { useThemeStore } from '@/stores/useTheme';
import { usePostInteractions } from '@/composables/usePostInteractions';
import ConversationService from '@/services/ConversationService';
import { formatDistanceToNow, format } from 'date-fns';
import { supabase } from '@/supabase';
import type { TimelinePost } from '@/types';

// Components
import MonyContent from './MonyContent.vue';
import Icon from '@/components/common/Icon.vue';
import Avatar from '../common/Avatar.vue';
import Composer from './Composer.vue';
import PostReactions from './PostReactions.vue';
import ConfirmationModal from '../ConfirmationModal.vue';
import EmojiPopup from '@/components/EmojiPopup.vue';
import VueEasyLightbox from 'vue-easy-lightbox';
import router from '@/router';

// Props
interface Props {
  post: TimelinePost;
}

const props = defineProps<Props>();

// Emits
const emit = defineEmits<{
  reply: [post: TimelinePost];
  delete: [postId: string];
  edit: [postId: string];
  click: [post: TimelinePost];
  'user-mention-click': [handle: string];
  'hashtag-click': [tag: string];
  'user-click': [user: any]; // For when clicking on the author
  'show-conversation': [postId: string]; // New emit for showing conversation
}>();

// Stores and composables
const { getCurrentUser } = useUserData();
const activityPubStore = useActivityPubStore();
const notificationStore = useNotificationStore();
const themeStore = useThemeStore();

// Composables for clean interaction handling
const { toggleFavorite, toggleReblog, toggleBookmark } = usePostInteractions();

// Local state (removed isToggling since composable handles loading)
const showSensitiveContent = ref(false);
const showMenu = ref(false);
const showInlineReply = ref(false);
const showDeleteConfirmation = ref(false);
const isDeleting = ref(false);

// Emoji picker state
const emojiTriggerRef = ref<HTMLElement>();
const postReactionsRef = ref<InstanceType<typeof PostReactions>>();
const showEmojiPopup = ref(false);

// Lightbox state
const showLightbox = ref(false);
const currentLightboxImage = ref<string>('');

// Tooltip state for reaction tooltips
const tooltip = ref({
  visible: false,
  content: [] as { id: string; displayName: string; avatarUrl: string; userColor?: string; }[],
  x: 0,
  y: 0,
  emoji: null as any,
});
const tooltipTimer = ref<NodeJS.Timeout | null>(null);


const handleTimeClick = () => {
  router.push({ name: 'PostView', params: { postId: props.post.id } });
};

// Computed
const author = computed(() => {
  return props.post.author;
});
const viewProfile = (author: { username: string; domain: string, is_local?: boolean }) => {
  const isLocal = author.is_local ?? true; // Default to local if not specified
  const profileHandle = isLocal ? `@${author.username}` : `@${author.username}@${author.domain}`;
  router.push({ name: 'UserProfile', params: { handle: profileHandle } });
};

const instanceDomain = computed(() => {
  const { domain } = props.post.author;
  return domain || 'har.mony.lol';
});

// Reblog-related computed properties
const isReblog = computed(() => {
  return !!(props.post.reblog && props.post.reblog_author);
});

const isQuotePost = computed(() => {
  // A quote post has both reblog data AND non-empty content
  if (!isReblog.value) return false;
  const content = props.post.content;
  
  // Check if content is empty (pure reblog) or has actual content (quote post)
  if (Array.isArray(content)) {
    return content.length > 0 && content.some(part => 
      part.type === 'text' && part.text && part.text.trim().length > 0
    );
  }
  
  // Fallback: if content exists but is not array (shouldn't happen per interface)
  return false;
});

const displayAuthor = computed(() => {
  return (isReblog.value && props.post.reblog_author) ? props.post.reblog_author : props.post.author;
});

const originalInstanceDomain = computed(() => {
  if (!isReblog.value || !props.post.reblog_author) return instanceDomain.value;
  const { domain } = props.post.reblog_author;
  return domain || 'har.mony.lol';
});

const originalCreatedAt = computed(() => {
  return (isReblog.value && props.post.reblog) ? props.post.reblog.created_at : props.post.created_at;
});

// For quote posts, we show both the user's content AND the quoted content
const userQuoteContent = computed(() => {
  return isQuotePost.value ? props.post.content : null;
});

const displayContent = computed(() => {
  // For pure reblogs, show the original content
  // For quote posts, we'll show the original content in a quoted block
  return (isReblog.value && props.post.reblog) ? props.post.reblog.content : props.post.content;
});

const displayMediaAttachments = computed(() => {
  return (isReblog.value && props.post.reblog) ? props.post.reblog.media_attachments : props.post.media_attachments;
});

const displayContentWarning = computed(() => {
  return (isReblog.value && props.post.reblog) ? props.post.reblog.content_warning : props.post.content_warning;
});

const displayIsSensitive = computed(() => {
  return (isReblog.value && props.post.reblog) ? props.post.reblog.is_sensitive : props.post.is_sensitive;
});

const displayReplyContext = computed(() => {
  // For now, ignore reblog logic and focus on regular posts
  const context = props.post.reply_context;
  return context;
});

const displayInteractionCounts = computed(() => {
  if (isReblog.value && props.post.reblog) {
    return {
      favorites_count: props.post.reblog.favorites_count,
      reblogs_count: props.post.reblog.reblogs_count,
      replies_count: props.post.reblog.replies_count,
      is_favorited: props.post.reblog.is_favorited || false,
      is_reblogged: props.post.reblog.is_reblogged || false,
      is_bookmarked: props.post.reblog.is_bookmarked || false
    };
  }
  return {
    favorites_count: props.post.favorites_count,
    reblogs_count: props.post.reblogs_count,
    replies_count: props.post.replies_count,
    is_favorited: props.post.is_favorited || false,
    is_reblogged: props.post.is_reblogged || false,
    is_bookmarked: props.post.is_bookmarked || false
  };
});

const replyContentText = computed(() => {
  // Return the full JSONB content from reply_context
  if (displayReplyContext.value && displayReplyContext.value.content) {
    return displayReplyContext.value.content;
  }
  
  // Fallback to content_preview if content is not available (backward compatibility)
  if (displayReplyContext.value && displayReplyContext.value.content_preview) {
    return displayReplyContext.value.content_preview;
  }
  
  return '';
});

const canEdit = computed(() => {
  const currentUser = getCurrentUser.value;
  return currentUser?.id === props.post.author.id;
});

const canDelete = computed(() => {
  const currentUser = getCurrentUser.value;
  return currentUser?.id === props.post.author.id;
});

const visibilityIcon = computed(() => {
  switch (props.post.visibility) {
    case 'public': return 'globe';
    case 'unlisted': return 'unlock';
    case 'followers': return 'users';
    case 'direct': return 'mail';
    default: return 'globe';
  }
});

const visibilityTitle = computed(() => {
  const { t } = useI18n();
  switch (props.post.visibility) {
    case 'public': return t('activitypub.publicVisibleToEveryone');
    case 'unlisted': return t('activitypub.unlistedNotShown');
    case 'followers': return t('activitypub.followersOnly');
    case 'direct': return t('activitypub.directMessage');
    default: return t('activitypub.public');
  }
});

// Methods
const formatRelativeTime = (dateString: string) => {
  try {
    return formatDistanceToNow(new Date(dateString), { addSuffix: true });
  } catch {
    return 'Unknown time';
  }
};

const formatFullDate = (dateString: string) => {
  try {
    return format(new Date(dateString), 'PPP p');
  } catch {
    return 'Invalid date';
  }
};

const formatCount = (count: number) => {
  if (count < 1000) return count.toString();
  if (count < 10000) return (count / 1000).toFixed(1) + 'K';
  if (count < 1000000) return Math.floor(count / 1000) + 'K';
  return (count / 1000000).toFixed(1) + 'M';
};

const onReply = () => {
  showInlineReply.value = !showInlineReply.value;
  // Also emit for parent components that might want to handle it differently
  emit('reply', props.post);
};

const handleReplySent = (reply: any) => {
  console.log('Reply sent:', reply);
  showInlineReply.value = false;
  // Could emit a success event or update local state here
};

const handleShowEmojiPicker = (post: TimelinePost) => {
  console.log('Show emoji picker for post:', post.id);
  console.log('emojiTriggerRef:', emojiTriggerRef.value);
  console.log('Current showEmojiPopup:', showEmojiPopup.value);
  showEmojiPopup.value = true;
  console.log('Set showEmojiPopup to:', showEmojiPopup.value);
};

const closeEmojiPopup = () => {
  showEmojiPopup.value = false;
};

const handleEmojiSelected = async (emoji: any) => {
  console.log('Emoji selected:', emoji);
  
  const currentUser = getCurrentUser.value;
  if (!currentUser) {
    console.warn('User not authenticated');
    return;
  }
  
  try {
    // Play audio feedback immediately for better UX
    try {
      await themeStore.testAudio('reaction');
    } catch (audioError) {
      console.warn('Failed to play reaction audio:', audioError);
      // Don't block the reaction if audio fails
    }
    
    // Use the PostReactions composable instead of direct Supabase calls
    if (postReactionsRef.value?.handleEmojiSelected) {
      const success = await postReactionsRef.value.handleEmojiSelected(emoji);
      if (success) {
        console.log(`✅ Added emoji reaction ${emoji.name} to post ${props.post.id}`);
        closeEmojiPopup();
      }
    } else {
      // Fallback to direct API call
      const { error } = await supabase.rpc('add_post_emoji_reaction', {
        p_user_id: currentUser.id,
        p_post_id: props.post.id,
        p_emoji_id: emoji.id || null,
        p_custom_emoji_content: emoji.native || emoji.name || null
      });

      if (error) {
        console.error('Failed to add emoji reaction:', error);
        // Play error sound if available
        try {
          await themeStore.testAudio('ui_error');
        } catch (audioError) {
          console.warn('Failed to play error audio:', audioError);
        }
      } else {
        console.log(`✅ Added emoji reaction ${emoji.name} to post ${props.post.id}`);
        closeEmojiPopup();
        // Refresh the reactions display
        if (postReactionsRef.value) {
          await postReactionsRef.value.loadReactions();
        }
      }
    }
  } catch (error) {
    console.error('Error adding emoji reaction:', error);
    // Play error sound if available
    try {
      await themeStore.testAudio('ui_error');
    } catch (audioError) {
      console.warn('Failed to play error audio:', audioError);
    }
  }
};

const handleShowReactionTooltip = (event: MouseEvent, reaction: any) => {
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  
  // Transform user_reactions to the format needed for tooltip
  const usersDetails = (reaction.user_reactions || []).map((ur: any) => ({
    id: ur.user_id,
    displayName: ur.display_name || ur.username || 'Unknown User',
    avatarUrl: ur.avatar_url || '',
    userColor: ur.user_color || '#ffffff'
  }));
  
  // Show tooltip after a delay
  tooltipTimer.value = setTimeout(() => {
    tooltip.value = { 
      visible: true, 
      content: usersDetails, 
      x: event.clientX, 
      y: event.clientY, 
      emoji: {
        name: reaction.emoji_name,
        url: reaction.emoji_url
      }
    };
  }, 500);
};

const handleHideReactionTooltip = () => {
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  tooltipTimer.value = null;
  tooltip.value.visible = false;
};

const onEdit = () => {
  emit('edit', props.post.id);
  closeMenu();
};

const onDelete = () => {
  showDeleteConfirmation.value = true;
  closeMenu();
};

/**
 * Handle confirmed delete action - professional with feedback
 */
const handleDeleteConfirm = async () => {
  if (isDeleting.value) return;
  
  try {
    isDeleting.value = true;
    showDeleteConfirmation.value = false;
    
    // Call the delete action through the store
    await activityPubStore.deletePost(props.post.id);
    
    // Show success toast
    notificationStore.showToast(
      'server_update',
      'Post deleted',
      'Your post has been successfully deleted',
      3000
    );
    
    console.log('✅ Post successfully deleted:', props.post.id);
    
  } catch (error) {
    console.error('❌ Failed to delete post:', error);
    
    // Show error toast
    notificationStore.showToast(
      'server_update',
      'Delete failed',
      'Failed to delete post. Please try again.',
      5000
    );
  } finally {
    isDeleting.value = false;
  }
};

/**
 * Handle delete confirmation cancel
 */
const handleDeleteCancel = () => {
  showDeleteConfirmation.value = false;
};

const showReplyTarget = async () => {
  if (displayReplyContext.value) {
    try {
      // Get conversation navigation data from service
      const navigationData = await ConversationService.getConversationNavigationData(props.post.id, {
        highlightPost: props.post.id
      });
      
      if (navigationData.success && navigationData.route) {
        // Handle navigation in the component
        await router.push(navigationData.route);
      } else {
        console.error('❌ Failed to get conversation navigation data:', navigationData.error);
        
        // Use fallback route
        await router.push(navigationData.fallbackRoute);
      }
      
    } catch (error) {
      console.error('❌ Failed to navigate to conversation:', error);
      
      // Fallback: emit the event as before
      emit('show-conversation', props.post.id);
    }
  } else {
    console.warn('⚠️ No reply context found for post:', props.post.id);
  }
};

const copyLink = async () => {
  try {
    const url = props.post.url || `${window.location.origin}/posts/${props.post.id}`;
    await navigator.clipboard.writeText(url);
    // You could show a toast here
  } catch (error) {
    console.error('Failed to copy link:', error);
  }
  closeMenu();
};

const closeMenu = () => {
  showMenu.value = false;
};

const handleMenuToggle = () => {
  console.log('🔘 Menu button clicked, current state:', showMenu.value);
  showMenu.value = !showMenu.value;
  console.log('🔘 Menu state after toggle:', showMenu.value);
};





const handleMentionClick = (handle: string) => {
  console.log('Mention clicked:', handle);
  router.push({ name: 'UserProfile', params: { handle } });
};

const handleHashtagClick = (tag: string) => {
  emit('hashtag-click', tag);
};

const handleImageClick = (url: string) => {
  currentLightboxImage.value = url;
  showLightbox.value = true;
};

const closeLightbox = () => {
  showLightbox.value = false;
};
</script>

<style scoped>
.mony-post {
  background-color: var(--background-quinary);
  border-bottom: 1px solid var(--border-color);
  transition: background-color 0.2s;
  border-radius: 12px;
}

.mony-post:hover {
  background-color: var(--background-quaternary);
}

.mony-post.is-reply {
  border-left: 3px solid #2563eb;
}

.reblog-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem 0;
  color: #9ca3af;
  font-size: 0.875rem;
}

.reblog-icon {
  color: var(--harmony-primary);
  width: 1rem;
  height: 1rem;
}

.reblog-author {
  color: var(--harmony-primary);
  text-decoration: none;
  font-weight: 500;
  cursor: pointer;
}

.reblog-author:hover {
  text-decoration: underline;
}

.post-content {
  padding: 1rem;
}

.post-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.author-info {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  text-decoration: none;
  color: inherit;
  flex: 1;
}

.author-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.author-details {
  flex: 1;
  min-width: 0;
}

.author-name {
  font-weight: 600;
  color: white;
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}

.author-handle {
  color: #9ca3af;
  font-size: 0.875rem;
  text-overflow: ellipsis;
  overflow: hidden;
  display:flex;
  flex-direction: row;
  gap: 4px;
  white-space: nowrap;
  align-items: center;
}

.post-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: flex-end;
  color: #9ca3af;
  font-size: 0.875rem;
  flex-shrink: 0;
}

.post-time:hover {
  text-decoration: underline;
  cursor: pointer;
}

.visibility-indicator {
  display: flex;
  align-items: center;
  justify-content: flex-end;
}

.instance-domain {
  display: flex;
  align-items: center;
  background: var(--background-secondary);
  border-radius: 5px;
  padding: 1px 5px;
  cursor: pointer;
  user-select: text;
  opacity: 0.4;
  transition: all 0.2s ease-in-out;
}
.instance-domain:hover {
  opacity: 1;
  background: var(--background-primary);
}

.reply-context {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  padding: 0.75rem;
  background-color: rgba(59, 130, 246, 0.05);
  border-radius: 0.5rem;
  border-left: 3px solid #3b82f6;
  border: 1px solid rgba(59, 130, 246, 0.1);
}

.reply-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.reply-indicator {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  color: #9ca3af;
  font-size: 0.875rem;
}

.reply-icon {
  color: #9ca3af;
  font-size: 0.875rem;
}

.reply-text {
  color: #9ca3af;
  font-size: 0.875rem;
}

.reply-preview-card {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background-color: #374151;
  border-radius: 0.375rem;
  padding: 0.375rem 0.75rem;
}

.reply-details {
  display: flex;
  flex-direction: column;
}

.reply-author {
  color: #3b82f6;
  font-weight: 500;
  text-decoration: none;
}

.reply-author:hover {
  text-decoration: underline;
}

.reply-content-preview {
  color: white;
  font-size: 0.875rem;
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}

.show-conversation-btn {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  color: #3b82f6;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.875rem;
  padding: 0.25rem 0.5rem;
  border-radius: 0.375rem;
  transition: all 0.2s;
  text-decoration: none;
}

.show-conversation-btn:hover {
  color: #10b981;
  background-color: rgba(16, 185, 129, 0.1);
}

.btn-icon {
  color: #3b82f6;
  font-size: 1rem;
}

.content-warning {
  background-color: #374151;
  border-radius: 0.5rem;
  padding: 1rem;
  margin-bottom: 1rem;
}

.cw-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  color: #fbbf24;
  font-weight: 500;
}

.cw-toggle {
  background-color: #4b5563;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 0.25rem;
  cursor: pointer;
  font-size: 0.875rem;
}

.cw-toggle:hover {
  background-color: #6b7280;
}

.post-body {
  margin-bottom: 1rem;
}

.post-body.is-sensitive {
  filter: blur(10px);
  transition: filter 0.2s;
}

.post-body.is-sensitive:hover {
  filter: blur(0px);
}

.post-text {
  color: white;
  line-height: 1.6;
  word-wrap: break-word;
  margin-bottom: 1rem;
}

.interaction-stats {
  display: flex;
  gap: 1rem;
  margin-bottom: 0.75rem;
  color: #9ca3af;
  font-size: 0.875rem;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.post-actions {
  display: flex;
  align-items: center;
  gap: 1rem;
  position: relative;
}

.action-button {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem;
  background: none;
  border: none;
  color: #9ca3af;
  cursor: pointer;
  border-radius: 0.25rem;
  transition: all 0.2s;
  font-size: 0.875rem;
}

.action-button:hover {
  background-color: #374151;
  color: white;
}

.action-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.action-button.loading {
  opacity: 0.7;
}

.reply-button:hover {
  color: #3b82f6;
  background-color: rgba(59, 130, 246, 0.1);
}

.reblog-button:hover {
  color: #10b981;
  background-color: rgba(16, 185, 129, 0.1);
}

.reblog-button.active {
  color: #10b981;
}

.favorite-button:hover {
  color: #ef4444;
  background-color: rgba(239, 68, 68, 0.1);
}

.favorite-button.active {
  color: #ef4444;
}

.bookmark-button:hover {
  color: #f59e0b;
  background-color: rgba(245, 158, 11, 0.1);
}

.bookmark-button.active {
  color: #f59e0b;
}

.action-menu {
  position: relative;
  margin-left: auto;
}

.action-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  backdrop-filter: blur(3px);
  background-color: var(--background-primary-alpha);
  border: 1px solid var(--border-color);
  border-radius: 0.5rem;
  padding: 0.5rem;
  min-width: 150px;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
  z-index: 1000;
  margin-top: 0.25rem;
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem;
  background: none;
  border: none;
  color: white;
  text-align: left;
  cursor: pointer;
  border-radius: 0.25rem;
  font-size: 0.875rem;
}

.dropdown-item:hover {
  background-color: var(--background-secondary-alpha);
}

.dropdown-item.danger {
  color: #ef4444;
}

.dropdown-item.danger:hover {
  background-color: rgba(239, 68, 68, 0.1);
}

/* Quote Post Styles */
.quote-post-layout {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.quote-comment {
  color: white;
  line-height: 1.6;
  word-wrap: break-word;
}

.quoted-post {
  border: 1px solid #374151;
  border-radius: 0.75rem;
  padding: 1rem;
  background-color: rgba(0, 0, 0, 0.2);
  margin-top: 0.5rem;
}

.quoted-post-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.quoted-author-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
}

.quoted-author-name {
  font-weight: 600;
  color: white;
}

.quoted-author-handle {
  color: #9ca3af;
}

.quoted-post-time {
  color: #6b7280;
  font-size: 0.8rem;
}

.quoted-post-content {
  color: white;
  line-height: 1.6;
  word-wrap: break-word;
  margin-bottom: 0.75rem;
}

.quoted-media-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 0.5rem;
  border-radius: 0.5rem;
  overflow: hidden;
}

.quoted-media-gallery .media-item {
  border-radius: 0.5rem;
  overflow: hidden;
}

.quoted-media-gallery .media-image,
.quoted-media-gallery .media-video {
  width: 100%;
  height: auto;
  max-height: 200px;
  object-fit: cover;
}

/* Media Gallery Styles */

/* Mobile responsive */
@media (max-width: 768px) {
  .post-content {
    padding: 0.75rem;
  }
  
  .author-avatar {
    width: 36px;
    height: 36px;
  }
  
  .post-actions {
    gap: 0.5rem;
  }
  
  .action-button {
    padding: 0.375rem;
  }
}

/* Reaction Tooltip Styles */
.reaction-tooltip {
  position: fixed;
  z-index: var(--z-tooltip);
  background: var(--background-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  max-width: 200px;
  box-shadow: var(--shadow-large);
  pointer-events: none;
}

.tooltip-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border-secondary);
}

.tooltip-emoji {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

.emoji-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.tooltip-user {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.tooltip-avatar {
  flex-shrink: 0;
}
</style>
