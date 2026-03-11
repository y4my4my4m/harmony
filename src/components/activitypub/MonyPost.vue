<!-- MonyPost Component - Individual post display -->
<template>
  <!-- FIXED: Use v-show instead of v-if to prevent post disappearing on re-render -->
  <!-- Also added fallback for missing author to prevent complete disappearance -->
  <article class="mony-post" 
  v-show="post && (author || authorFallback)" :class="{ 'is-reply': post.reply_context, 'is-reblog': isReblog }">
    
    <!-- Reblog Header (if this is a reblog) -->
    <div v-if="isReblog" class="reblog-header">
      <Icon name="reblog" class="reblog-icon" />
      <div 
        class="reblog-author" 
        @click="viewProfile(author)"
        :title="`Reblogged by ${author.display_name || author.username}`"
      >
        <DisplayName :userId="author.id" :fallback="author.display_name || author.username" /> reblogged
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
            <div class="author-name" @click="viewProfile(displayAuthor)">
              <DisplayName :userId="displayAuthor.id" :fallback="displayAuthor.display_name || displayAuthor.username" />
              <span v-if="authorInstanceBadge === 'admin'" class="instance-badge admin" title="Instance Admin">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
                ADMIN
              </span>
              <span v-else-if="authorInstanceBadge === 'mod'" class="instance-badge mod" title="Instance Moderator">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>
                MOD
              </span>
              <SupporterBadge v-if="displayAuthor.id" :user-id="displayAuthor.id" />
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
        <!-- Unhydrated Reblog/Quote: Show reference link when content not loaded -->
        <div v-if="isUnhydratedReblog" class="unhydrated-reblog">
          <div class="unhydrated-reblog-notice">
            <Icon name="reblog" />
            <span>Reblogged from another instance</span>
          </div>
          <a 
            v-if="reblogReferenceUrl"
            :href="reblogReferenceUrl" 
            target="_blank" 
            rel="noopener noreferrer"
            class="reblog-reference-link"
          >
            <Icon name="external-link" />
            View original post
          </a>
        </div>

        <!-- Quote Post: Show user's comment first, then quoted content -->
        <div v-else-if="isQuotePost" class="quote-post-layout">
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
                <span class="quoted-author-name"><DisplayName :userId="displayAuthor.id" :fallback="displayAuthor.display_name || displayAuthor.username" /></span>
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
                  v-else-if="media.type === 'video' || media.type === 'gifv' || (media.type === 'unknown' && isVideoMediaUrl(media.url))" 
                  :src="media.url" 
                  controls
                  :loop="media.type === 'gifv'"
                  :autoplay="media.type === 'gifv'"
                  :muted="media.type === 'gifv'"
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
                v-else-if="media.type === 'video' || media.type === 'gifv' || (media.type === 'unknown' && isVideoMediaUrl(media.url))" 
                :src="media.url" 
                controls
                :loop="media.type === 'gifv'"
                :autoplay="media.type === 'gifv'"
                :muted="media.type === 'gifv'"
                class="media-video"
              >
                Your browser does not support the video tag.
              </video>
              <audio
                v-else-if="media.type === 'audio'"
                :src="media.url"
                controls
                class="media-audio"
              ></audio>
            </div>
          </div>
        </div>
      </div>

      <!-- Reply Context (shown AFTER the post content, like Twitter) -->
      <!-- Only show in timeline view, not in thread view where parent is already visible -->
      <div v-if="showReplyContextCard" class="reply-context-container">
        <div class="reply-indicator-bar">
          <Icon name="corner-down-right" class="reply-icon" :size="14" />
          <span class="reply-text">Replying to</span>
          <span class="reply-author-link" @click.stop="viewProfile(displayReplyContext.author)">
            @{{ displayReplyContext.author.username }}
          </span>
          <button 
            class="show-thread-btn"
            @click.stop="showReplyTarget"
            title="View full conversation"
          >
            <Icon name="message-square" :size="14" />
            View thread
          </button>
        </div>
        
        <div class="reply-parent-post" @click.stop="showReplyTarget">
          <div class="reply-parent-header">
            <Avatar 
              :src="displayReplyContext.author.avatar_url"
              :alt="displayReplyContext.author.display_name || displayReplyContext.author.username"
              size="sm"
            />
            <div class="reply-parent-author-info">
              <span class="reply-parent-name"><DisplayName :userId="displayReplyContext.author.id" :fallback="displayReplyContext.author.display_name || displayReplyContext.author.username" /></span>
              <span class="reply-parent-handle">@{{ displayReplyContext.author.username }}</span>
              <time class="reply-parent-time" v-if="displayReplyContext.created_at">
                {{ formatRelativeTime(displayReplyContext.created_at) }}
              </time>
            </div>
          </div>
          
          <div class="reply-parent-content">
            <MonyContent 
              :content="replyContentText" 
              :isPreview="true" 
              :previewLength="200" 
            />
          </div>
        </div>
      </div>

      <!-- Post Reactions (Emoji Reactions) - Above action buttons -->
      <!-- For reblogs, we need to show reactions for the ORIGINAL post -->
      <PostReactions
        ref="postReactionsRef"
        :post="displayPostForReactions"
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

        <div class="reblog-menu-container" v-click-outside="() => showReblogMenu = false">
          <button 
            class="action-button reblog-button"
            :class="{ 
              active: displayInteractionCounts.is_reblogged,
              disabled: !canReblog && !displayInteractionCounts.is_reblogged
            }"
            @click="handleReblogClick"
            :disabled="!canReblog && !displayInteractionCounts.is_reblogged"
            :title="!canReblog && !displayInteractionCounts.is_reblogged ? reblogDisabledReason : (displayInteractionCounts.is_reblogged ? 'Undo reblog' : 'Reblog options')"
          >
            <Icon name="reblog" />
            <span v-if="displayInteractionCounts.reblogs_count > 0">{{ formatCount(displayInteractionCounts.reblogs_count) }}</span>
          </button>
          
          <!-- Reblog dropdown menu -->
          <div v-if="showReblogMenu && canReblog" class="reblog-dropdown">
            <button 
              class="reblog-option"
              @click="handleSimpleReblog"
              :disabled="displayInteractionCounts.is_reblogged"
            >
              <Icon name="reblog" :size="16" />
              <span>Reblog</span>
            </button>
            <button 
              class="reblog-option"
              @click="handleQuoteReblog"
            >
              <Icon name="edit" :size="16" />
              <span>Quote</span>
            </button>
          </div>
        </div>

        <button 
          class="action-button favorite-button"
          :class="{ active: displayInteractionCounts.is_favorited }"
          @click="handleToggleFavorite"
          :title="displayInteractionCounts.is_favorited ? 'Unfavorite' : 'Favorite'"
        >
          <Icon :name="displayInteractionCounts.is_favorited ? 'heart-filled' : 'heart'" />
          <span v-if="displayInteractionCounts.favorites_count > 0 || displayInteractionCounts.is_favorited">{{ formatCount(displayInteractionCounts.favorites_count || 1) }}</span>
        </button>

        <button 
          ref="emojiTriggerRef"
          class="action-button add-reaction-button"
          @click.stop="handleShowEmojiPickerForOriginal"
          title="Add reaction"
        >
          <Icon name="plus" />
        </button>

        <button 
          class="action-button bookmark-button"
          :class="{ active: displayInteractionCounts.is_bookmarked }"
          @click="toggleBookmark(originalPostId)"
          :title="displayInteractionCounts.is_bookmarked ? 'Remove bookmark' : 'Bookmark'"
        >
          <Icon :name="displayInteractionCounts.is_bookmarked ? 'bookmark-filled' : 'bookmark'" />
        </button>

        <div class="action-menu" v-click-outside="closeMenu">
          <button 
            class="action-button menu-button" 
            @click="handleMenuToggle"
            :title="showMenu ? 'Close menu' : 'More options'"
          >
            <Icon name="more-horizontal" />
          </button>
        
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
          
          <!-- For reblogs, show "Undo Reblog" instead of "Delete" -->
          <button 
            v-if="isReblog && canDelete"
            class="dropdown-item"
            @click="onUndoReblog"
          >
            <Icon name="reblog" />
            <span>Undo Reblog</span>
          </button>
          
          <!-- Regular delete for non-reblog posts -->
          <button 
            v-if="!isReblog && canDelete"
            class="dropdown-item danger"
            @click="onDelete"
          >
            <Icon name="trash" />
            <span>Delete</span>
          </button>
          
          <!-- Fetch remote data for remote posts -->
          <div v-if="isRemotePost" class="dropdown-divider"></div>
          
          <button 
            v-if="isRemotePost && !isFetchingReactions"
            class="dropdown-item"
            @click="fetchRemoteReactions"
          >
            <Icon name="heart" />
            <span>Fetch reactions</span>
          </button>
          
          <button 
            v-if="isRemotePost && !isFetchingReplies"
            class="dropdown-item"
            @click="fetchRemoteReplies"
          >
            <Icon name="message-circle" />
            <span>Fetch replies</span>
          </button>
          
          <div 
            v-if="isRemotePost && (isFetchingReactions || isFetchingReplies)"
            class="dropdown-item loading-item"
          >
            <Icon name="loader" class="spinning" />
            <span>Loading...</span>
          </div>

          <div v-if="!canDelete" class="dropdown-divider"></div>
          <button
            v-if="!canDelete"
            class="dropdown-item danger"
            @click="openReportModal"
          >
            <Icon name="flag" />
            <span>Report Post</span>
          </button>
        </div>
      </div>
    </div>
    </div>

    <!-- Report Modal -->
    <ReportModal
      v-if="showReportModal"
      report-type="post"
      :target-user-id="displayAuthor.id"
      :target-post-id="post.id"
      :target-post-preview="postTextPreview"
      :target-user="{ username: displayAuthor.username, display_name: displayAuthor.display_name, avatar_url: displayAuthor.avatar_url }"
      @close="showReportModal = false"
    />

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
          :alt="formatEmojiName(tooltip.emoji?.name) || 'emoji'"
          class="tooltip-emoji"
        />
        <span v-else-if="tooltip.emoji?.unicode" class="tooltip-emoji native-emoji">{{ tooltip.emoji.unicode }}</span>
        <span v-if="tooltip.emoji?.url && tooltip.emoji?.name" class="emoji-name">:{{ formatEmojiName(tooltip.emoji.name) }}:</span>
        <span v-else-if="tooltip.emoji?.unicode && tooltipEmojiShortcode" class="emoji-name">:{{ tooltipEmojiShortcode }}:</span>
      </div>
      <div v-for="user in tooltip.content" :key="user.id" class="tooltip-user">
        <Avatar 
          :src="user.avatarUrl"
          size="xs"
          class="tooltip-avatar"
        />
        <span class="tooltip-username">
          <DisplayName
            v-if="user.displayNameParts"
            :parts="user.displayNameParts"
            :fallback="user.displayName"
          />
          <DisplayName v-else :userId="user.id" :fallback="user.displayName" />
        </span>
        <span v-if="user.isRemote && formatDomain(user.domain)" class="tooltip-domain">@{{ formatDomain(user.domain) }}</span>
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
import { computed, ref, onMounted } from 'vue';
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n';
import { useUserData } from '@/composables/useUserData';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useNotificationStore } from '@/stores/useNotification';
import { useThemeStore } from '@/stores/useTheme';
import { usePostInteractions } from '@/composables/usePostInteractions';
import ConversationService from '@/services/ConversationService';
import { formatDistanceToNow, format } from 'date-fns';
import DisplayName from '@/components/DisplayName.vue';
import { userDataService } from '@/services/userDataService';
import { unicodeToShortcode } from '@/services/unifiedEmojiService';
import { supabase } from '@/supabase';
import type { TimelinePost } from '@/types';

// Components
import MonyContent from './MonyContent.vue';
import Icon from '@/components/common/Icon.vue';
import Avatar from '../common/Avatar.vue';
import Composer from './Composer.vue';
import PostReactions from './PostReactions.vue';
import ConfirmationModal from '../ConfirmationModal.vue';
import ReportModal from '@/components/moderation/ReportModal.vue';
import SupporterBadge from '@/components/common/SupporterBadge.vue';
import EmojiPopup from '@/components/EmojiPopup.vue';
import VueEasyLightbox from 'vue-easy-lightbox';
import router from '@/router';

// Props
interface Props {
  post: TimelinePost;
  hideReplyContext?: boolean; // Hide reply context when in thread view (parent is already visible)
  isInThread?: boolean; // True when this post is displayed within a thread/conversation view
}

const props = withDefaults(defineProps<Props>(), {
  hideReplyContext: false,
  isInThread: false
});

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
  'refresh': [postId: string]; // Refresh post data after fetching remote reactions
}>();

// Stores and composables
const { getCurrentUser, getUserProfile } = useUserData();
const activityPubStore = useActivityPubStore();
const notificationStore = useNotificationStore();
const themeStore = useThemeStore();

// Composables for clean interaction handling
const { toggleFavorite, toggleReblog, toggleBookmark } = usePostInteractions();

// Local state (removed isToggling since composable handles loading)
const showSensitiveContent = ref(false);
const showMenu = ref(false);
const showReblogMenu = ref(false);
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
  content: [] as { 
    id: string; 
    displayName: string; 
    displayNameEmojis?: Array<{name: string, url: string}>;
    avatarUrl: string; 
    userColor?: string;
    isRemote?: boolean;
    domain?: string;
  }[],
  x: 0,
  y: 0,
  emoji: null as any,
});
const tooltipTimer = ref<NodeJS.Timeout | null>(null);

const tooltipEmojiShortcode = computed(() => {
  const unicode = tooltip.value.emoji?.unicode
  if (!unicode) return ''
  return unicodeToShortcode(unicode) || ''
})

const handleTimeClick = () => {
  // Navigate to PostDetail (the actual route) instead of PostView (which redirects)
  router.push({ name: 'PostDetail', params: { postId: props.post.id } });
};

// Computed
const author = computed(() => {
  return props.post.author;
});

// Fallback author for edge cases where author is temporarily unavailable
// This prevents posts from disappearing during re-renders due to RLS policy timing issues
const authorFallback = computed(() => {
  if (author.value) return null;
  // Return a minimal author object to keep the post visible
  return {
    id: props.post.author_id,
    username: 'Loading...',
    display_name: 'Loading...',
    avatar_url: null,
    domain: import.meta.env.VITE_DOMAIN as string,
    is_local: props.post.is_local ?? true
  };
});

// Use the actual author if available, otherwise use fallback
const displayAuthorSafe = computed(() => {
  return author.value || authorFallback.value;
});

const viewProfile = (author: { username: string; domain: string, is_local?: boolean }) => {
  const isLocal = author.is_local ?? true; // Default to local if not specified
  const profileHandle = isLocal ? `@${author.username}` : `@${author.username}@${author.domain}`;
  router.push({ name: 'UserProfile', params: { handle: profileHandle } });
};

const instanceDomain = computed(() => {
  const domain = props.post.author?.domain || displayAuthorSafe.value?.domain;
  return domain || import.meta.env.VITE_DOMAIN as string;
});

// Remote post detection (for fetching reactions)
const isRemotePost = computed(() => {
  return !props.post.is_local && props.post.ap_id;
});

// State for fetching remote data
const isFetchingReactions = ref(false);
const isFetchingReplies = ref(false);

// Reblog-related computed properties
const isReblog = computed(() => {
  // Check for hydrated reblog data OR metadata reference
  return !!(
    (props.post.reblog && props.post.reblog_author) ||
    props.post.metadata?.is_reblog ||
    props.post.metadata?.reblog_of ||
    props.post.ap_type === 'Announce'
  );
});

// Check if this is a remote reblog without hydrated data (needs to show placeholder)
const isUnhydratedReblog = computed(() => {
  return isReblog.value && !props.post.reblog && (
    props.post.metadata?.reblog_of || 
    props.post.metadata?.reblog_of_ap_url
  );
});

const isQuotePost = computed(() => {
  // Check metadata-based quote first (from remote posts)
  if (props.post.metadata?.is_quote || props.post.metadata?.quote_url) {
    return true;
  }
  
  // A quote post has both reblog data AND unique user-added content
  if (!isReblog.value) return false;
  
  const content = props.post.content;
  const reblogContent = props.post.reblog?.content;
  
  // If no content, it's a pure reblog
  if (!content || !Array.isArray(content) || content.length === 0) {
    return false;
  }
  
  // Check if user actually added their own content
  const hasUserContent = content.some(part => 
    part.type === 'text' && part.text && part.text.trim().length > 0
  );
  
  if (!hasUserContent) return false;
  
  // Additional check: if content is identical to reblog content, it's a pure reblog
  // (This catches cases where content was incorrectly duplicated)
  if (reblogContent && Array.isArray(reblogContent)) {
    const contentText = content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map(p => p.text.trim())
      .join(' ');
    const reblogText = reblogContent
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map(p => p.text.trim())
      .join(' ');
    
    // If the content is the same as the reblogged content, it's NOT a quote
    if (contentText === reblogText) {
      return false;
    }
  }
  
  return true;
});

// Get reblog/quote reference URL for unhydrated posts
const reblogReferenceUrl = computed(() => {
  return props.post.metadata?.reblog_of_ap_url || 
         props.post.metadata?.quote_url || 
         null;
});

const isVideoMediaUrl = (url: string): boolean => {
  if (!url) return false;
  return /\.(mp4|webm|ogg|avi|mov|wmv|flv|m4v)(\?.*)?$/i.test(url);
};

const displayAuthor = computed(() => {
  const author = (isReblog.value && props.post.reblog_author) ? props.post.reblog_author : props.post.author;
  return author || authorFallback.value;
});

const authorInstanceBadge = computed(() => {
  const authorId = displayAuthor.value?.id;
  if (!authorId) return null;
  const profile = getUserProfile(authorId).value;
  if (profile?.is_admin) return 'admin';
  if (profile?.is_moderator) return 'mod';
  return null;
});

const originalInstanceDomain = computed(() => {
  if (!isReblog.value || !props.post.reblog_author) return instanceDomain.value;
  const { domain } = props.post.reblog_author;
  return domain || import.meta.env.VITE_DOMAIN as string;
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

// Track dynamically loaded reply context
const loadedReplyContext = ref<any>(null);
const isLoadingReplyContext = ref(false);

const displayReplyContext = computed(() => {
  // For reblogs, check the reblogged post's reply context
  if (isReblog.value && props.post.reblog?.reply_context) {
    return props.post.reblog.reply_context;
  }
  // First check if we have reply_context in the post itself
  if (props.post.reply_context) {
    return props.post.reply_context;
  }
  // Use dynamically loaded context if available
  if (loadedReplyContext.value) {
    return loadedReplyContext.value;
  }
  return null;
});

// Show reply context card only in timeline view (not in thread view)
const showReplyContextCard = computed(() => {
  return displayReplyContext.value && !props.hideReplyContext && !props.isInThread;
});

// Load reply context if we have in_reply_to but no reply_context
const loadReplyContext = async () => {
  // For reblogs, use the reblogged post's in_reply_to
  const inReplyTo = isReblog.value 
    ? props.post.reblog?.in_reply_to 
    : props.post.in_reply_to;
  const hasReplyContext = isReblog.value 
    ? props.post.reblog?.reply_context 
    : props.post.reply_context;
    
  if (!inReplyTo || hasReplyContext || isLoadingReplyContext.value) {
    return;
  }
  
  isLoadingReplyContext.value = true;
  try {
    const { data: parentPost, error } = await supabase
      .from('posts')
      .select(`
        id, content, created_at, visibility,
        author:profiles!posts_author_id_fkey(
          id, username, display_name, avatar_url, domain
        )
      `)
      .eq('id', inReplyTo)
      .single();
    
    if (!error && parentPost && parentPost.author) {
      // Handle author being either an object or array (Supabase join result)
      const author = Array.isArray(parentPost.author) ? parentPost.author[0] : parentPost.author;
      if (author) {
        loadedReplyContext.value = {
          id: parentPost.id,
          content: parentPost.content,
          content_preview: Array.isArray(parentPost.content) 
            ? parentPost.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join(' ').slice(0, 200)
            : String(parentPost.content).slice(0, 200),
          author: {
            id: author.id,
            username: author.username,
            display_name: author.display_name || author.username,
            avatar_url: author.avatar_url || '/default_avatar.webp',
            domain: author.domain || import.meta.env.VITE_DOMAIN as string
          },
          created_at: parentPost.created_at,
          visibility: parentPost.visibility
        };
      }
    }
  } catch (err) {
    debug.error('Failed to load reply context:', err);
  } finally {
    isLoadingReplyContext.value = false;
  }
};

// For reblogs, we need to fetch the user's interaction state with the ORIGINAL post
const originalPostInteractions = ref<{
  is_favorited: boolean;
  is_reblogged: boolean;
  is_bookmarked: boolean;
} | null>(null);

const loadOriginalPostInteractions = async () => {
  if (!isReblog.value || !props.post.reblog?.id) return;
  
  // OPTIMIZATION: Check if interactions were pre-loaded by the store
  // This prevents N+1 queries when the parent already batch-fetched interactions
  const reblog = props.post.reblog;
  if (reblog.is_favorited !== undefined || reblog.is_reblogged !== undefined || reblog.is_bookmarked !== undefined) {
    originalPostInteractions.value = {
      is_favorited: reblog.is_favorited ?? false,
      is_reblogged: reblog.is_reblogged ?? false,
      is_bookmarked: reblog.is_bookmarked ?? false
    };
    return;
  }
  
  try {
    const { userDataService } = await import('@/services/userDataService');
    const currentUser = userDataService.getCurrentUser();
    if (!currentUser?.id) return;

    const { data: interactions, error } = await supabase
      .from('post_interactions')
      .select('interaction_type')
      .eq('post_id', props.post.reblog.id)
      .eq('user_id', currentUser.id)
      .in('interaction_type', ['favorite', 'reblog', 'bookmark']);

    if (error) {
      debug.error('Failed to load original post interactions:', error);
      return;
    }

    const interactionTypes = new Set(interactions?.map(i => i.interaction_type) || []);
    originalPostInteractions.value = {
      is_favorited: interactionTypes.has('favorite'),
      is_reblogged: interactionTypes.has('reblog'),
      is_bookmarked: interactionTypes.has('bookmark')
    };
  } catch (err) {
    debug.error('Failed to load original post interactions:', err);
  }
};

// Load reply context on mount if needed
onMounted(() => {
  // Check for reply context in post or reblog
  const inReplyTo = isReblog.value 
    ? props.post.reblog?.in_reply_to 
    : props.post.in_reply_to;
  const hasReplyContext = isReblog.value 
    ? props.post.reblog?.reply_context 
    : props.post.reply_context;
    
  if (inReplyTo && !hasReplyContext) {
    loadReplyContext();
  }

  // For reblogs, fetch the user's interaction state with the original post
  if (isReblog.value) {
    loadOriginalPostInteractions();
  }
});

// The ID of the original post - for reblogs, this is the reblogged post's ID
// All interactions (favorite, reblog, bookmark) should target this ID
const originalPostId = computed(() => {
  if (isReblog.value && props.post.reblog?.id) {
    return props.post.reblog.id;
  }
  return props.post.id;
});

// For reblogs, we need to show reactions for the ORIGINAL post
// Create a post-like object with the correct ID for PostReactions component
const displayPostForReactions = computed(() => {
  if (isReblog.value && props.post.reblog?.id) {
    // Return the original post data with the correct ID
    return {
      ...props.post.reblog,
      id: props.post.reblog.id
    };
  }
  return props.post;
});

// Optimistic override for favorite state — set immediately on click, reconciled after DB response
const favoriteOverride = ref<{ is_favorited: boolean; favorites_count: number } | null>(null)

const displayInteractionCounts = computed(() => {
  const fav = favoriteOverride.value;

  if (isReblog.value && props.post.reblog) {
    const interactions = originalPostInteractions.value;
    return {
      favorites_count: fav?.favorites_count ?? props.post.reblog.favorites_count ?? 0,
      reblogs_count: props.post.reblog.reblogs_count || 0,
      replies_count: props.post.reblog.replies_count || 0,
      is_favorited: fav?.is_favorited ?? interactions?.is_favorited ?? props.post.reblog.is_favorited ?? false,
      is_reblogged: interactions?.is_reblogged ?? props.post.reblog.is_reblogged ?? false,
      is_bookmarked: interactions?.is_bookmarked ?? props.post.reblog.is_bookmarked ?? false
    };
  }
  return {
    favorites_count: fav?.favorites_count ?? props.post.favorites_count ?? 0,
    reblogs_count: props.post.reblogs_count || 0,
    replies_count: props.post.replies_count || 0,
    is_favorited: fav?.is_favorited ?? props.post.is_favorited ?? false,
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

// Report
const showReportModal = ref(false);
const postTextPreview = computed(() => {
  const content = props.post.content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p.type === 'text' || p.text)
      .map((p: any) => p.text)
      .join(' ')
      .slice(0, 200);
  }
  if (typeof content === 'string') {
    return content.replace(/<[^>]+>/g, '').slice(0, 200);
  }
  return '';
});
const openReportModal = () => {
  showMenu.value = false;
  showReportModal.value = true;
};

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

// Check if post can be reblogged (Mastodon behavior: only public/unlisted posts can be reblogged)
const canReblog = computed(() => {
  // Get the original post's visibility (for reblogs, check the original)
  const originalVisibility = props.post.reblog?.visibility || props.post.visibility;
  return originalVisibility === 'public' || originalVisibility === 'unlisted';
});

const reblogDisabledReason = computed(() => {
  if (canReblog.value) return '';
  const originalVisibility = props.post.reblog?.visibility || props.post.visibility;
  if (originalVisibility === 'followers') {
    return 'Followers-only posts cannot be reblogged';
  }
  if (originalVisibility === 'direct') {
    return 'Direct messages cannot be reblogged';
  }
  return 'This post cannot be reblogged';
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
  // Toggle inline reply - handled entirely within MonyPost
  showInlineReply.value = !showInlineReply.value;
  // Don't emit to parent - we handle replies inline now
};

const handleReplySent = (reply: any) => {
  debug.log('Reply sent:', reply);
  showInlineReply.value = false;
  // Could emit a success event or update local state here
};

const handleShowEmojiPicker = (post: TimelinePost) => {
  debug.log('Show emoji picker for post:', post.id);
  debug.log('emojiTriggerRef:', emojiTriggerRef.value);
  debug.log('Current showEmojiPopup:', showEmojiPopup.value);
  showEmojiPopup.value = true;
  debug.log('Set showEmojiPopup to:', showEmojiPopup.value);
};

const closeEmojiPopup = () => {
  showEmojiPopup.value = false;
};

const handleEmojiSelected = async (emoji: any) => {
  debug.log('Emoji selected:', emoji);
  
  const currentUser = getCurrentUser.value;
  if (!currentUser) {
    debug.warn('User not authenticated');
    return;
  }
  
  try {
    // Play audio feedback immediately for better UX
    try {
      await themeStore.testAudio('reaction');
    } catch (audioError) {
      debug.warn('Failed to play reaction audio:', audioError);
      // Don't block the reaction if audio fails
    }
    
    // Use the PostReactions composable instead of direct Supabase calls
    if (postReactionsRef.value?.handleEmojiSelected) {
      const success = await postReactionsRef.value.handleEmojiSelected(emoji);
      if (success) {
        debug.log(`✅ Added emoji reaction ${emoji.name} to post ${props.post.id}`);
        closeEmojiPopup();
      }
    } else {
      // Fallback to direct API call
      // Check if emoji.id is a valid UUID (server custom emoji) or native unicode
      const isUuid = emoji.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(emoji.id);
      const emojiId = isUuid ? emoji.id : null;
      const customContent = !isUuid ? (emoji.native || emoji.id || emoji.name) : null;
      
      const { error } = await supabase.rpc('add_post_emoji_reaction', {
        p_user_id: currentUser.id,
        p_post_id: props.post.id,
        p_emoji_id: emojiId,
        p_custom_emoji_content: customContent
      });

      if (error) {
        debug.error('Failed to add emoji reaction:', error);
        // Play error sound if available
        try {
          await themeStore.testAudio('ui_error');
        } catch (audioError) {
          debug.warn('Failed to play error audio:', audioError);
        }
      } else {
        debug.log(`✅ Added emoji reaction ${emoji.name} to post ${props.post.id}`);
        closeEmojiPopup();
        // Refresh the reactions display
        if (postReactionsRef.value) {
          await postReactionsRef.value.loadReactions();
        }
      }
    }
  } catch (error) {
    debug.error('Error adding emoji reaction:', error);
    // Play error sound if available
    try {
      await themeStore.testAudio('ui_error');
    } catch (audioError) {
      debug.warn('Failed to play error audio:', audioError);
    }
  }
};

/**
 * Format emoji name for display - removes extra colons and @. notation
 */
const formatEmojiName = (name: string | undefined): string => {
  if (!name) return '';
  // Remove colons from start/end if present
  let formatted = name.replace(/^:+|:+$/g, '');
  // Remove @. or @domain suffix for cleaner display
  formatted = formatted.replace(/@\.?$/, '').replace(/@[^@]+$/, '');
  return formatted;
};

/**
 * Format domain for display - handles Misskey's "." notation
 */
const formatDomain = (domain: string | undefined): string => {
  if (!domain || domain === '.' || domain === '') return '';
  return domain;
};

/**
 * Render a display name with custom emojis as HTML
 * Replaces :emoji: patterns with <img> tags
 */
const renderDisplayNameWithEmojis = (displayName: string, emojis?: Array<{name: string, url: string}>): string => {
  if (!displayName) return '';
  if (!emojis || emojis.length === 0) return escapeHtml(displayName);
  
  // Create emoji map for quick lookup - handle various name formats
  const emojiMap = new Map<string, string>();
  for (const e of emojis) {
    if (!e.name || !e.url) continue;
    // Store with original name
    emojiMap.set(e.name, e.url);
    // Also store without colons if present
    const cleanName = e.name.replace(/^:|:$/g, '');
    emojiMap.set(cleanName, e.url);
    // Also store without @domain suffix
    const nameWithoutDomain = cleanName.replace(/@[^@]*$/, '');
    emojiMap.set(nameWithoutDomain, e.url);
  }
  
  // Replace :emoji: patterns with img tags
  // Handle: :emoji:, :emoji@domain:, :emoji@.:, and zero-width space wrapped
  let result = displayName;
  const emojiRegex = /\u200b?:([a-zA-Z0-9_]+(?:@[a-zA-Z0-9._-]*)?):?\u200b?/g;
  
  result = result.replace(emojiRegex, (match, name) => {
    // Try different name formats to find a match
    const cleanName = name.replace(/@[^@]*$/, ''); // Remove @domain
    const url = emojiMap.get(name) || emojiMap.get(cleanName);
    if (url) {
      const alt = escapeHtml(cleanName);
      return `<img src="${escapeHtml(url)}" alt=":${alt}:" class="inline-emoji" style="height: 1em; vertical-align: middle;" onerror="this.onerror=null;var p=this.parentNode;var s=document.createElement('span');s.className='inline-emoji emoji-fallback';s.textContent='?';s.style.cssText='display:inline;font-size:1em;vertical-align:middle';p&&p.replaceChild(s,this);" />`;
    }
    return escapeHtml(match);
  });
  
  return result;
};

// Simple HTML escape helper
const escapeHtml = (text: string): string => {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

const handleShowReactionTooltip = (event: MouseEvent, reaction: any) => {
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  
  // Debug: log reaction data
  debug.log('🎯 Reaction tooltip data:', {
    emoji_name: reaction.emoji_name,
    reactors: reaction.reactors,
    user_reactions: reaction.user_reactions,
    full_reaction: reaction
  });
  
  // Transform local user_reactions to the format needed for tooltip
  const localUsers = (reaction.user_reactions || []).map((ur: any) => ({
    id: ur.user_id,
    displayName: ur.display_name || ur.username || 'Unknown User',
    avatarUrl: ur.avatar_url || '',
    userColor: ur.user_color || '#ffffff',
    isRemote: false
  }));
  
  // Add remote reactors from federated fetch. Use parts for display name so custom emojis
  // render (synthetic id is not in user cache, so DisplayName cannot look up by userId).
  const remoteUsers = (reaction.reactors || []).map((reactor: any) => {
    debug.log('🎯 Remote reactor:', reactor);
    const displayName = reactor.display_name || reactor.username || 'Unknown';
    const rawEmojis = reactor.display_name_emojis || [];
    const pinnedEmojis = rawEmojis
      .map((e: any) => ({
        id: e.id || e.name || '',
        name: (e.name || '').replace(/:/g, ''),
        url: e.url || ''
      }))
      .filter((e: any) => e.name && e.url);
    const displayNameParts = userDataService.resolveDisplayNameParts(
      displayName,
      pinnedEmojis.length ? pinnedEmojis : undefined
    );
    return {
      id: `${reactor.username}@${reactor.domain}`,
      displayName,
      displayNameParts,
      avatarUrl: reactor.avatar_url || '',
      userColor: '#888888',
      isRemote: true,
      domain: reactor.domain
    };
  });
  
  // Combine local and remote users
  const usersDetails = [...localUsers, ...remoteUsers];
  
  // Show tooltip after a delay
  tooltipTimer.value = setTimeout(() => {
    tooltip.value = { 
      visible: true, 
      content: usersDetails, 
      x: event.clientX, 
      y: event.clientY, 
      emoji: {
        name: reaction.emoji_name,
        url: reaction.emoji_url,
        unicode: reaction.custom_emoji_content
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
 * Handle undo reblog action - removes the reblog post and updates state
 */
const onUndoReblog = async () => {
  closeMenu();
  
  try {
    // Get the original post ID from the reblog
    const originalPostId = props.post.reblog?.id || props.post.metadata?.reblog_of;
    
    if (originalPostId) {
      // Use toggleReblog which handles the undo
      await toggleReblog(originalPostId);
      
      notificationStore.showToast(
        'server_update',
        'Reblog removed',
        'Your reblog has been undone',
        3000
      );
    }
  } catch (error) {
    debug.error('Failed to undo reblog:', error);
    notificationStore.showToast(
      'error',
      'Failed to undo reblog',
      'There was an error removing your reblog',
      5000
    );
  }
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
    
    debug.log('✅ Post successfully deleted:', props.post.id);
    
  } catch (error) {
    debug.error('❌ Failed to delete post:', error);
    
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
        debug.error('❌ Failed to get conversation navigation data:', navigationData.error);
        
        // Use fallback route
        await router.push(navigationData.fallbackRoute);
      }
      
    } catch (error) {
      debug.error('❌ Failed to navigate to conversation:', error);
      
      // Fallback: emit the event as before
      emit('show-conversation', props.post.id);
    }
  } else {
    debug.warn('⚠️ No reply context found for post:', props.post.id);
  }
};

const copyLink = async () => {
  try {
    const url = props.post.url || `${window.location.origin}/posts/${props.post.id}`;
    await navigator.clipboard.writeText(url);
    // You could show a toast here
  } catch (error) {
    debug.error('Failed to copy link:', error);
  }
  closeMenu();
};

const closeMenu = () => {
  showMenu.value = false;
};

const handleMenuToggle = () => {
  debug.log('🔘 Menu button clicked, current state:', showMenu.value);
  showMenu.value = !showMenu.value;
  debug.log('🔘 Menu state after toggle:', showMenu.value);
};

// Optimistic favorite toggle — fills/unfills the heart immediately
const handleToggleFavorite = async () => {
  const postId = originalPostId.value
  const targetPost = isReblog.value ? props.post.reblog : props.post
  const wasFavorited = displayInteractionCounts.value.is_favorited
  const prevCount = displayInteractionCounts.value.favorites_count

  favoriteOverride.value = {
    is_favorited: !wasFavorited,
    favorites_count: Math.max(0, prevCount + (wasFavorited ? -1 : 1))
  }

  const result = await toggleFavorite(postId)

  if (result.success) {
    favoriteOverride.value = {
      is_favorited: result.liked!,
      favorites_count: result.newCount ?? favoriteOverride.value.favorites_count
    }
  } else {
    favoriteOverride.value = null
  }

  // Also update the reblog interaction ref so it stays in sync
  if (isReblog.value && originalPostInteractions.value) {
    originalPostInteractions.value = {
      ...originalPostInteractions.value,
      is_favorited: favoriteOverride.value?.is_favorited ?? wasFavorited
    }
  }
}

// Reblog menu handlers
const handleReblogClick = () => {
  // If already reblogged, undo the reblog directly
  if (displayInteractionCounts.value.is_reblogged) {
    // Always use the original post ID for reblog actions
    toggleReblog(originalPostId.value);
    return;
  }
  // Otherwise show the menu with options
  showReblogMenu.value = !showReblogMenu.value;
};

const handleSimpleReblog = async () => {
  showReblogMenu.value = false;
  // Always reblog the original post, not a reblog of a reblog
  await toggleReblog(originalPostId.value);
};

const handleQuoteReblog = () => {
  showReblogMenu.value = false;
  // Open composer with the ORIGINAL post as a quote (not a reblog)
  const originalPost = props.post.reblog || props.post;
  const originalAuthor = props.post.reblog_author || props.post.author;
  activityPubStore.openComposer({
    quotePost: originalPost,
    quoteAuthor: originalAuthor
  });
};

// Fetch remote reactions for a remote post
const fetchRemoteReactions = async () => {
  if (!isRemotePost.value || isFetchingReactions.value) return;
  
  const postApId = props.post.ap_id;
  if (!postApId) return;
  
  isFetchingReactions.value = true;
  showMenu.value = false;
  
  try {
    const response = await fetch('/api/federation/fetch-reactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        post_ap_id: postApId,
        post_id: props.post.id,
      }),
    });
    
    if (response.ok) {
      const result = await response.json();
      debug.log(`📬 Fetched ${result.count} reactions for remote post`);
      
      if (result.count > 0) {
        debug.log(`✅ Found ${result.count} reactions from remote instance`);
      } else {
        debug.log(`📭 No reactions found on remote instance`);
      }
      
      // Update post metadata and counts immediately with the returned data
      if (result.remote_reactions) {
        // Update in store feeds
        activityPubStore.updatePostMetadataInAllFeeds(props.post.id, {
          remote_reactions: result.remote_reactions,
          remote_reactions_fetched_at: new Date().toISOString(),
        });
        
        // Also directly update the post's metadata for immediate reactivity
        // (handles cases where post is in local ref like UserProfileView.userPosts)
        if (!props.post.metadata) {
          (props.post as any).metadata = {};
        }
        (props.post.metadata as any).remote_reactions = result.remote_reactions;
        (props.post.metadata as any).remote_reactions_fetched_at = new Date().toISOString();
        
        debug.log(`✅ Updated post metadata with ${Object.keys(result.remote_reactions).length} reaction types`);
      }
      
      // Update counts directly on the post for immediate reactivity
      if (result.favorites_count !== undefined) {
        (props.post as any).favorites_count = result.favorites_count;
      }
      if (result.replies_count !== undefined) {
        (props.post as any).replies_count = result.replies_count;
      }
      if (result.reblogs_count !== undefined) {
        (props.post as any).reblogs_count = result.reblogs_count;
      }
      
      // Also emit refresh for any parent that wants to fully reload
      emit('refresh', props.post.id);
    } else {
      debug.error('Failed to fetch remote reactions:', await response.text());
    }
  } catch (error) {
    debug.error('Error fetching remote reactions:', error);
  } finally {
    isFetchingReactions.value = false;
  }
};

// Fetch remote replies for a remote post
const fetchRemoteReplies = async () => {
  if (!isRemotePost.value || isFetchingReplies.value) return;
  
  const postApId = props.post.ap_id;
  if (!postApId) return;
  
  isFetchingReplies.value = true;
  showMenu.value = false;
  
  try {
    const response = await fetch('/api/federation/fetch-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        post_ap_id: postApId,
        post_id: props.post.id,
      }),
    });
    
    if (response.ok) {
      const result = await response.json();
      debug.log(`📬 Fetched ${result.count} replies for remote post`);
      
      // Emit event to refresh post data
      emit('refresh', props.post.id);
      
      if (result.count > 0) {
        debug.log(`✅ Found ${result.count} replies from remote instance`);
      } else {
        debug.log(`📭 No replies found on remote instance`);
      }
    } else {
      debug.error('Failed to fetch remote replies:', await response.text());
    }
  } catch (error) {
    debug.error('Error fetching remote replies:', error);
  } finally {
    isFetchingReplies.value = false;
  }
};

// Handle emoji picker for original post (for reblogs, target the original)
const handleShowEmojiPickerForOriginal = () => {
  // Create a post-like object with the original post ID for the emoji picker
  const targetPost = isReblog.value && props.post.reblog 
    ? { ...props.post.reblog, id: originalPostId.value }
    : props.post;
  handleShowEmojiPicker(targetPost);
};


const handleMentionClick = (handle: string) => {
  debug.log('Mention clicked:', handle);
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
  border-left: 3px solid var(--harmony-primary);
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
  /* color: var(--text-primary); */
  color: var(--text-primary);
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  user-select: text;
  margin-bottom: 4px;
}

.author-name:hover {
  text-decoration: underline;
  cursor: pointer;
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
  position: relative;
  top: -1px;
}

.instance-badge.admin {
  color: color-mix(in srgb, var(--text-secondary) 30%, transparent);
  transition: all 0.5s ease;
}

.instance-badge.mod {
  color: color-mix(in srgb, var(--text-secondary) 30%, transparent);
  transition: all 0.5s ease;
}

.author-name:hover .instance-badge.admin,
.author-name:hover .instance-badge.mod {
  color: var(--text-primary);
  background: var(--harmony-secondary);
}

.author-handle {
  color: var(--text-secondary);
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
  color: var(--text-secondary);
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

/* Reply Context - looks like quoted post */
.reply-context-container {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}

.reply-indicator-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.reply-icon {
  color: var(--text-secondary);
}

.reply-text {
  color: var(--text-secondary);
}

.reply-author-link {
  color: var(--harmony-primary);
  cursor: pointer;
  font-weight: 500;
}

.reply-author-link:hover {
  text-decoration: underline;
}

.show-thread-btn {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem 2.5rem;
  background: transparent;
  border: 1px solid #3741515b;
  border-radius: 0.375rem;
  color: var(--text-secondary);
  font-size: 0.75rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.show-thread-btn:hover {
  background: var(--background-secondary);
  color: var(--text-primary);
}

.reply-parent-post {
  /* border: 1px solid var(--border-color); */
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  background-color: var(--background-primary);
  cursor: pointer;
  transition: border-color 0.2s ease;
}

.reply-parent-post:hover {
  border-color: #4b5563;
}

.reply-parent-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.reply-parent-author-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.reply-parent-name {
  font-weight: 600;
  /* color: var(--text-primary); */
  color: var(--text-primary);
  font-size: 0.9rem;
}

.reply-parent-handle {
  /* color: #9ca3af; */
  color: var(--text-secondary);
  font-size: 0.85rem;
}

.reply-parent-time {
  /* color: #6b7280; */
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.reply-parent-content {
  /* color: #d1d5db; */
  color: var(--text-secondary);
  font-size: 0.9rem;
}

/* Simple reply indicator for thread view */
.reply-indicator-simple {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  color: #6b7280;
  font-size: 0.75rem;
  margin-bottom: 0.5rem;
  padding-left: 0.25rem;
}

.reply-indicator-simple .reply-icon {
  color: #6b7280;
}

.reply-indicator-simple .reply-text {
  color: #6b7280;
}

.reply-indicator-simple .reply-author-link {
  color: #60a5fa;
  cursor: pointer;
  font-weight: 500;
}

.reply-indicator-simple .reply-author-link:hover {
  text-decoration: underline;
  line-height: 1.5;
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
  color: var(--text-primary);
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
  /* color: var(--text-primary); */
  color: var(--text-primary);
  line-height: 1.6;
  word-wrap: break-word;
  margin-bottom: 1rem;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

.post-text :deep(*) {
  user-select: text;
  -webkit-user-select: text;
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
  /* background-color: #374151; */
  /* color: var(--text-primary); */
  background-color: var(--background-quinary);
  color: var(--text-primary);
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

/* Reblog dropdown menu */
.reblog-menu-container {
  position: relative;
}

.reblog-dropdown {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  background: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  padding: 0.25rem;
  min-width: 140px;
  z-index: 100;
  margin-bottom: 0.5rem;
}

.reblog-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.625rem 0.75rem;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 0.875rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.reblog-option:hover:not(:disabled) {
  background: var(--background-hover);
  color: #10b981;
}

.reblog-option:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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

.dropdown-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.1);
  margin: 0.5rem 0;
}

.loading-item {
  color: #9ca3af;
  cursor: wait;
}

.loading-item .spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
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
  /* color: var(--text-primary); */
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  border-radius: 0.25rem;
  font-size: 0.875rem;
}

.dropdown-item:hover {
  background-color: var(--background-secondary-alpha);
}

.dropdown-item.danger {
  /* color: #ef4444; */
  color: var(--error);
}

.dropdown-item.danger:hover {
  background-color: rgba(239, 68, 68, 0.1);
}

/* Unhydrated Reblog (remote reblog without loaded content) */
.unhydrated-reblog {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 0.75rem;
}

.unhydrated-reblog-notice {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  /* color: #9ca3af; */
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.reblog-reference-link {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--h-brand, #5865f2);
  text-decoration: none;
  font-size: 0.875rem;
  padding: 0.5rem 0.75rem;
  background: rgba(88, 101, 242, 0.1);
  border-radius: 0.5rem;
  width: fit-content;
  transition: all 0.2s;
}

.reblog-reference-link:hover {
  background: rgba(88, 101, 242, 0.2);
  text-decoration: underline;
}

/* Quote Post Styles */
.quote-post-layout {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.quote-comment {
  color: var(--text-primary);
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
  color: var(--text-primary);
}

.quoted-author-handle {
  color: #9ca3af;
}

.quoted-post-time {
  color: #6b7280;
  font-size: 0.8rem;
}

.quoted-post-content {
  color: var(--text-primary);
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

.tooltip-username {
  color: var(--text-primary);
}

.tooltip-domain {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  opacity: 0.7;
}
</style>
