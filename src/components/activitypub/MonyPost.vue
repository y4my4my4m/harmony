<!-- MonyPost Component - Individual post display -->
<template>
  <!-- FIXED: Use v-show instead of v-if to prevent post disappearing on re-render -->
  <!-- Also added fallback for missing author to prevent complete disappearance -->
  <article class="mony-post" data-testid="post-item"
  v-show="post && (author || authorFallback)" :class="{ 'is-reply': post.reply_context, 'is-reblog': isReblog, 'is-pinned': showPinnedHeader && post.is_pinned }">
    
    <!-- Pinned indicator (profile timeline pinned section only) -->
    <div v-if="showPinnedHeader && post.is_pinned" class="pinned-header">
      <Icon name="pin" :size="14" class="pinned-icon" />
      <span>Pinned</span>
    </div>

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
          <span v-if="isEdited" class="edited-indicator" title="This post has been edited">(edited)</span>
        </div>
      </div>

      <!-- Content Warning -->
      <div v-if="displayContentWarning" class="content-warning">
        <div class="cw-header">
          <Icon name="alert-triangle" />
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
        :class="{ 
          'is-sensitive': displayIsSensitive, 
          'revealed': sensitiveRevealedForTouch 
        }"
      >
        <!-- Tap-to-reveal overlay on mobile: first tap reveals, second tap opens lightbox -->
        <div
          v-if="displayIsSensitive && isTouchDevice && !sensitiveRevealedForTouch"
          class="sensitive-tap-overlay"
          @click.stop="sensitiveRevealedForTouch = true"
        />
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
                :content="contentForMonyContent"
                @user-mention-click="handleMentionClick"
                @hashtag-click="handleHashtagClick"
                @image-click="handleImageClick"
              />
            </div>
            
            <!-- Media in quoted post -->
            <MonyMediaGallery
              v-if="displayMediaAttachments?.length > 0"
              :media-attachments="displayMediaAttachments"
              :is-sensitive="displayIsSensitive"
            />
          </div>
        </div>
        
        <!-- Pure Reblog or Regular Post: Show content normally -->
        <div v-else>
          <!-- Text Content (includes inline YouTube iframe etc. via UnifiedContentRenderer's HTML mode) -->
          <div class="post-text">
            <MonyContent
              :content="contentForMonyContent"
              @user-mention-click="handleMentionClick"
              @hashtag-click="handleHashtagClick"
              @image-click="handleImageClick"
            />
          </div>

          <!--
            Compact captions for URLs that the content renderer ALREADY
            iframes inline (currently YouTube). Sits right under the
            content so it visually attaches to the iframe above, gives
            users the title/channel context they'd otherwise need to
            click into the iframe to see, but at a fraction of the
            visual weight of a full link card. Suppresses the big
            duplicate card that used to appear below the media gallery.
          -->
          <a
            v-for="embed in inlineRichEmbeds"
            :key="`inline-${embed.url}`"
            :href="embed.url"
            target="_blank"
            rel="noopener noreferrer"
            class="post-link-preview post-link-preview--compact"
          >
            <LinkEmbedCard :payload="(embed as any)" variant="compact" />
          </a>

          <!-- Media Attachments (grid + lightbox) -->
          <MonyMediaGallery
            v-if="displayMediaAttachments?.length > 0"
            :media-attachments="displayMediaAttachments"
            :is-sensitive="displayIsSensitive"
          />

          <!-- Full Link Preview Cards (everything that isn't already represented inline) -->
          <a
            v-for="embed in cardEmbeds"
            :key="embed.url"
            :href="embed.url"
            target="_blank"
            rel="noopener noreferrer"
            class="post-link-preview"
          >
            <LinkEmbedCard :payload="(embed as any)" />
          </a>
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
          data-testid="post-reply-btn"
          @click="onReply"
          :title="'Reply to ' + author.display_name"
        >
          <Icon name="message-circle" />
          <span v-if="displayInteractionCounts.replies_count > 0">{{ formatCount(displayInteractionCounts.replies_count) }}</span>
        </button>

        <div class="reblog-menu-container" v-click-outside="() => showReblogMenu = false">
          <button 
            class="action-button reblog-button"
            data-testid="post-reblog-btn"
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
          data-testid="post-favorite-btn"
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
          data-testid="post-bookmark-btn"
          :class="{ active: displayInteractionCounts.is_bookmarked }"
          @click="handleToggleBookmark"
          :title="displayInteractionCounts.is_bookmarked ? 'Remove bookmark' : 'Bookmark'"
        >
          <Icon :name="displayInteractionCounts.is_bookmarked ? 'bookmark-filled' : 'bookmark'" />
        </button>

        <div class="action-menu">
          <button 
            ref="menuButtonRef"
            class="action-button menu-button" 
            @click="handleMenuToggle"
            :title="showMenu ? 'Close menu' : 'More options'"
          >
            <Icon name="more-horizontal" />
          </button>
        
          <!-- Teleported to body to escape virtual-scroll stacking contexts -->
          <Teleport to="body">
            <div v-if="showMenu" ref="dropdownRef" class="action-dropdown" :style="dropdownStyle">
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
                v-if="canEdit && !isReblog"
                class="dropdown-item"
                @click="onTogglePin"
              >
                <Icon :name="props.post.is_pinned ? 'pin-off' : 'pin'" />
                <span>{{ props.post.is_pinned ? 'Unpin from Profile' : 'Pin to Profile' }}</span>
              </button>

              <button 
                v-if="isReblog && canDelete"
                class="dropdown-item"
                @click="onUndoReblog"
              >
                <Icon name="reblog" />
                <span>Undo Reblog</span>
              </button>
              
              <button 
                v-if="!isReblog && canDelete"
                class="dropdown-item danger"
                @click="onDelete"
              >
                <Icon name="trash" />
                <span>Delete</span>
              </button>
              
              <div v-if="isRemotePost" class="dropdown-divider"></div>
              
              <button 
                v-if="isRemotePost && !isFetchingReactions"
                class="dropdown-item"
                @click="handleFetchRemoteReactions"
              >
                <Icon name="heart" />
                <span>Fetch reactions</span>
              </button>
              
              <button 
                v-if="isRemotePost && !isFetchingReplies"
                class="dropdown-item"
                @click="handleFetchRemoteReplies"
              >
                <Icon name="message-circle" />
                <span>Fetch replies</span>
              </button>
              
              <button
                v-if="isRemotePost && isCurrentUserAdminOrMod && !isRefetchingContent"
                class="dropdown-item"
                @click="handleRefetchFromSource"
              >
                <Icon name="refresh-cw" />
                <span>Refetch from source</span>
              </button>
              
              <div 
                v-if="isRemotePost && (isFetchingReactions || isFetchingReplies || isRefetchingContent)"
                class="dropdown-item loading-item"
              >
                <Icon name="loader" class="spinning" />
                <span>Loading...</span>
              </div>

              <div v-if="isCurrentUserAdminOrMod && !canDelete" class="dropdown-divider"></div>
              <button
                v-if="isCurrentUserAdminOrMod"
                class="dropdown-item"
                @click="handleAdminToggleSensitive"
              >
                <Icon :name="displayIsSensitive ? 'eye' : 'eye-off'" />
                <span>{{ displayIsSensitive ? 'Unmark sensitive' : 'Mark sensitive' }}</span>
              </button>
              <button
                v-if="isCurrentUserAdminOrMod"
                class="dropdown-item"
                @click="handleAdminSetCW"
              >
                <Icon name="alert-triangle" />
                <span>{{ displayContentWarning ? 'Edit content warning' : 'Add content warning' }}</span>
              </button>
              <button
                v-if="isCurrentUserAdminOrMod && !canDelete"
                class="dropdown-item danger"
                @click="handleAdminDeletePost"
              >
                <Icon name="trash" />
                <span>Delete (admin)</span>
              </button>

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
          </Teleport>
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
    <!-- For reblogs, reply to the ORIGINAL post (not the boost wrapper) so the
         mention targets the original author and threads under the original note. -->
    <Composer 
      v-if="showInlineReply"
      mode="inline"
      type="reply"
      :reply-to-post="replyTarget"
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

    <!-- Emoji Popup for reactions - teleported to body to escape stacking contexts -->
    <Teleport to="body">
      <EmojiPopup
        v-if="showEmojiPopup"
        :trigger-element="emojiTriggerRef"
        :position="'above'"
        :is-reaction="true"
        :close-emoji-list="closeEmojiPopup"
        @send-emoji="handleEmojiSelected"
        @reset-emoji-icon-clicked="closeEmojiPopup"
      />
    </Teleport>

    <!-- Tooltip for reactions -->
    <div
      v-if="tooltip.visible"
      class="reaction-tooltip"
      :style="{ top: tooltip.y + 10 + 'px', left: tooltip.x + 'px' }"
    >
      <div class="tooltip-header">
        <img 
          v-if="tooltip.emoji?.url"
          :src="getEmojiUrl(tooltip.emoji.url, 48)"
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
            v-if="(user as any).displayNameParts"
            :parts="(user as any).displayNameParts"
            :fallback="user.displayName"
          />
          <DisplayName v-else :userId="user.id" :fallback="user.displayName" />
        </span>
        <span v-if="user.isRemote && formatDomain(user.domain)" class="tooltip-domain">@{{ formatDomain(user.domain) }}</span>
      </div>
    </div>
    
    <!-- Lightbox for images (only when not embedded in chat context) -->
    <vue-easy-lightbox
      v-if="!embedded"
      teleport="body"
      :visible="showLightbox"
      :imgs="[currentLightboxImage]"
      :index="0"
      @hide="closeLightbox"
    />
  </article>
</template>

<script lang="ts">
</script>

<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n';
import { useUserData } from '@/composables/useUserData';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useNotificationStore } from '@/stores/useNotification';
import { useThemeStore } from '@/stores/useTheme';
import { usePostInteractions } from '@/composables/usePostInteractions';
import { useRemotePostSync } from '@/composables/useRemotePostSync';
import ConversationService from '@/services/ConversationService';
import { formatDistanceToNow, format } from 'date-fns';
import DisplayName from '@/components/DisplayName.vue';
import { userDataService } from '@/services/userDataService';
import { unicodeToShortcode } from '@/services/unifiedEmojiService';
import { getEmojiUrl } from '@/utils/emojiUtils';
import { getOriginalPost } from '@/utils/postReblog';
import { supabase } from '@/supabase';
import type { TimelinePost } from '@/types';

// Components
import MonyContent from './MonyContent.vue';
import LinkEmbedCard from '@/components/embeds/LinkEmbedCard.vue';
import { parseEmbedUrl, isYouTubeUrl } from '@/utils/embedDetection';
import Icon from '@/components/common/Icon.vue';
import Avatar from '../common/Avatar.vue';
import Composer from './Composer.vue';
import PostReactions from './PostReactions.vue';
import MonyMediaGallery from './MonyMediaGallery.vue';
import ConfirmationModal from '../ConfirmationModal.vue';
import ReportModal from '@/components/moderation/ReportModal.vue';
import SupporterBadge from '@/components/common/SupporterBadge.vue';
import { adminService } from '@/services/AdminService';
import EmojiPopup from '@/components/EmojiPopup.vue';
import VueEasyLightbox from 'vue-easy-lightbox';
import { useToast } from 'vue-toastification';
import router from '@/router';

// Props
interface Props {
  post: TimelinePost;
  hideReplyContext?: boolean;
  isInThread?: boolean;
  embedded?: boolean; // When true, delegates lightbox to parent via open-lightbox emit
  /** Show "Pinned" row (profile pinned section only; not home/local/public feeds) */
  showPinnedHeader?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  hideReplyContext: false,
  isInThread: false,
  embedded: false,
  showPinnedHeader: false,
});

// Emits
const emit = defineEmits<{
  reply: [post: TimelinePost];
  delete: [postId: string];
  edit: [postId: string];
  click: [post: TimelinePost];
  'user-mention-click': [handle: string];
  'hashtag-click': [tag: string];
  'user-click': [user: any];
  'show-conversation': [postId: string];
  'refresh': [postId: string];
  'open-lightbox': [url: string];
}>();

// Stores and composables
const { getCurrentUser, getUserProfile } = useUserData();
const activityPubStore = useActivityPubStore();
const notificationStore = useNotificationStore();
const themeStore = useThemeStore();
const toast = useToast();

// Composables for clean interaction handling
const { toggleFavorite, toggleReblog, toggleBookmark, togglePinPost } = usePostInteractions();

// Local state (removed isToggling since composable handles loading)
const showSensitiveContent = ref(false);
const sensitiveRevealedForTouch = ref(false); // On mobile: first tap reveals blur, second tap opens lightbox
const isTouchDevice = typeof window !== 'undefined' && 'ontouchstart' in window && !window.matchMedia('(pointer: fine)').matches;
const showMenu = ref(false);
const menuButtonRef = ref<HTMLElement | null>(null);
const dropdownRef = ref<HTMLElement | null>(null);
const showReblogMenu = ref(false);
const showInlineReply = ref(false);
const showDeleteConfirmation = ref(false);
const isDeleting = ref(false);
const isRefetchingContent = ref(false);

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
  const isLocal = author.is_local ?? true;
  const handle = isLocal ? author.username : `${author.username}@${author.domain}`;
  router.push({ name: 'UserProfile', params: { handle } });
};

const instanceDomain = computed(() => {
  const domain = props.post.author?.domain || displayAuthorSafe.value?.domain;
  return domain || import.meta.env.VITE_DOMAIN as string;
});

// Remote post detection (for fetching reactions)
const isRemotePost = computed<boolean>(() => {
  return !props.post.is_local && !!props.post.ap_id;
});

// Remote post sync (reactions/replies) via composable
const {
  isFetchingReactions,
  isFetchingReplies,
  fetchRemoteReactions,
  fetchRemoteReplies,
} = useRemotePostSync(
  () => props.post,
  {
    isRemote: isRemotePost,
    autoFetchReactions: true,
    onReactionsUpdate: (result: any) => {
      if (result.remote_reactions) {
        activityPubStore.updatePostMetadataInAllFeeds(props.post.id, {
          remote_reactions: result.remote_reactions,
          remote_reactions_fetched_at: new Date().toISOString(),
        });
        if (!props.post.metadata) {
          (props.post as any).metadata = {};
        }
        (props.post.metadata as any).remote_reactions = result.remote_reactions;
        (props.post.metadata as any).remote_reactions_fetched_at = new Date().toISOString();
      }
      // For reblogs, update the reblog sub-object (displayInteractionCounts reads from there)
      const target = (isReblog.value && props.post.reblog) ? props.post.reblog : props.post;
      if (result.favorites_count !== undefined) {
        (target as any).favorites_count = result.favorites_count;
      }
      if (result.replies_count !== undefined) {
        (target as any).replies_count = result.replies_count;
      }
      if (result.reblogs_count !== undefined) {
        (target as any).reblogs_count = result.reblogs_count;
      }
    },
    onRefresh: (postId: string) => emit('refresh', postId),
  }
);

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

const isEdited = computed(() => {
  const post = (isReblog.value && props.post.reblog) ? props.post.reblog : props.post;
  if (!post.updated_at || !post.created_at) return false;
  const created = new Date(post.created_at).getTime();
  const updated = new Date(post.updated_at).getTime();
  return updated - created > 2000;
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
  const source: any = (isReblog.value && props.post.reblog) ? props.post.reblog : props.post;
  const media = source?.media_attachments ?? source?.mediaAttachments;
  const raw = Array.isArray(media) ? media : [];
  // Normalize federated media (ActivityPub uses type 'Document', mediaType 'image/*') so they render in grid
  return raw.map((m: any, idx: number) => {
    const url = m.url || m.remote_url || m.href;
    if (!url) return null;
    let type = m.type?.toLowerCase?.() || m.type || 'unknown';
    if (type === 'document' || type === 'unknown') {
      const mt = (m.mediaType || m.media_type || m.mime_type || '').toLowerCase();
      if (mt.startsWith('image/')) type = 'image';
      else if (mt.startsWith('video/') || mt.includes('gif')) type = 'video';
      else if (/\.(jpe?g|png|gif|webp|avif)/i.test(url)) type = 'image';
      else if (/\.(mp4|webm|ogv|mov)/i.test(url)) type = 'video';
    }
    return { ...m, id: m.id || `m-${idx}`, url, type };
  }).filter(Boolean);
});

const postEmbeds = computed<Array<{ url: string; title?: string; description?: string; image?: string; provider?: string }>>(() => {
  const source = (isReblog.value && props.post.reblog) ? props.post.reblog : props.post;
  const embeds = source?.metadata?.embeds;
  if (!embeds || typeof embeds !== 'object') return [];
  return Object.values(embeds).filter((e: any) => e && e.title) as Array<{ url: string; title?: string; description?: string; image?: string; provider?: string }>;
});

// ---------------------------------------------------------------------------
// Embed de-duplication: keep "the most of everything" without doubling up.
// ---------------------------------------------------------------------------
// `useContentRenderer.formattedHTML` auto-injects an inline iframe whenever
// it sees a YouTube URL in the post text (see useContentRenderer.ts:507).
// Without splitting `postEmbeds` we'd ALSO render a big LinkEmbedCard with
// the same YouTube thumbnail / title / channel below — three vertical
// surfaces showing the same video (iframe, optional uploaded media, link
// card). The fix: split the embed list by whether the URL is already
// represented as an inline rich embed.
//
//   * `inlineRichEmbeds`  → URLs the content renderer already iframes.
//                            Rendered as a *compact caption* directly
//                            beneath the content so the user still gets
//                            the title/channel context Mastodon shows,
//                            without doubling the visual weight.
//   * `cardEmbeds`        → everything else (Wikipedia, news, Spotify
//                            pages with no inline iframe support, etc.).
//                            Render the full LinkEmbedCard like before.
//
// Provider detection: prefer the federation-set `provider` field, fall
// back to URL parsing so this still works for older / partial payloads
// that didn't tag the provider.
const isInlineRichEmbed = (embed: { url: string; provider?: string }): boolean => {
  if (!embed?.url) return false;
  if (embed.provider === 'youtube') return true;
  const parsed = parseEmbedUrl(embed.url);
  return !!parsed && isYouTubeUrl(parsed);
};

const inlineRichEmbeds = computed(() => postEmbeds.value.filter(isInlineRichEmbed));

// Embeds that need a full link card. We strip `image` from any embed whose
// preview image visually duplicates something already shown by
// MonyMediaGallery, so a federated post doesn't render the same hero image
// twice (once as a gallery tile, once as the card's big thumbnail).
//
// Two cases get the strip:
//  1. Exact URL match — a Harmony post or an instance that serves the og:image
//     directly without a media cache.
//  2. The "link share" shape — exactly one media attachment AND exactly one
//     card embed. This is the most common federated-from-Mastodon case: the
//     remote serializer puts the cached preview image into `attachment[0]`
//     (so it lands in `media_attachments`) AND we generate our own link
//     preview from the URL in content (which lands in `metadata.embeds`).
//     The two URLs are different (mastodon-media-cache vs the origin host's
//     CDN) so exact-match never catches this; the shape heuristic does.
// When stripped, the card still renders site name + title + description, so
// users keep that context — they just don't see the same image twice.
const cardEmbeds = computed(() => {
  const cards = postEmbeds.value.filter((e) => !isInlineRichEmbed(e));
  const attachments = displayMediaAttachments.value as any[];
  if (attachments.length === 0) return cards;

  const attachmentUrls = new Set<string>();
  for (const m of attachments) {
    const u = m?.url || m?.remote_url || m?.href;
    if (typeof u === 'string' && u) attachmentUrls.add(u);
  }

  const isLinkShareShape = attachments.length === 1 && cards.length === 1;

  return cards.map((embed) => {
    const exactMatch = embed.image && attachmentUrls.has(embed.image);
    if (exactMatch || isLinkShareShape) {
      return { ...embed, image: undefined } as typeof embed;
    }
    return embed;
  });
});

// Content for MonyContent: when we have media_attachments, exclude file/image parts from content
// so they're only shown once in MonyMediaGallery (which has the lightbox). Federated posts often
// have media in content only (no media_attachments) - then we show them in MonyContent's grid.
const contentForMonyContent = computed(() => {
  const content = displayContent.value;
  const mediaAttachments = displayMediaAttachments.value;
  if (!content || !Array.isArray(content)) return content;
  if (mediaAttachments.length === 0) return content;

  // Build set of media URLs (normalized) so we filter content parts that duplicate attachments.
  // Normalize: strip query string, use pathname for matching (handles protocol/host differences).
  const normalizeUrl = (url: string) => {
    try {
      const u = url.split('?')[0];
      const path = u.includes('/') ? u.replace(/^[^/]*\/\/[^/]+/, '') : u;
      return path || u;
    } catch {
      return url;
    }
  };
  const mediaUrlPaths = new Set(
    mediaAttachments
      .map((m: any) => (m.url || m.remote_url || m.href) && normalizeUrl(String(m.url || m.remote_url || m.href)))
      .filter(Boolean)
  );

  const isMediaPartOrDuplicate = (p: any): boolean => {
    const partUrl = p?.url;
    if (partUrl && (mediaUrlPaths.has(normalizeUrl(partUrl)) || mediaUrlPaths.has(partUrl))) return true;
    const t = String(p?.type || '').toLowerCase();
    if (t === 'file') {
      const ft = p?.fileType || p?.file_type || '';
      if (ft === 'image' || ft === 'video' || ft === 'audio') return true;
      const mt = (p?.mimeType || p?.mime_type || p?.mediaType || p?.media_type || '').toLowerCase();
      if (mt.startsWith('image/') || mt.startsWith('video/') || mt.includes('gif')) return true;
      if (partUrl && /\.(jpe?g|png|gif|webp|avif|mp4|webm|ogv|mov)(\?|$)/i.test(partUrl)) return true;
      return false;
    }
    if (t === 'image' || t === 'video' || t === 'gifv') return true;
    if (t === 'url' && partUrl) {
      return /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?|$)/i.test(partUrl) ||
        /\.(mp4|webm|ogg|avi|mov|wmv|flv|m4v)(\?|$)/i.test(partUrl);
    }
    return false;
  };
  return content.filter((p: any) => !isMediaPartOrDuplicate(p));
});

const displayContentWarning = computed(() => {
  if (isReblog.value && props.post.reblog) {
    return props.post.reblog.content_warning || props.post.content_warning;
  }
  return props.post.content_warning;
});

const displayIsSensitive = computed(() => {
  if (isReblog.value && props.post.reblog) {
    return props.post.reblog.is_sensitive || props.post.is_sensitive;
  }
  return props.post.is_sensitive;
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
      .in('interaction_type', ['favorite', 'emoji_reaction', 'reblog', 'bookmark']);

    if (error) {
      debug.error('Failed to load original post interactions:', error);
      return;
    }

    const interactionTypes = new Set(interactions?.map(i => i.interaction_type) || []);
    originalPostInteractions.value = {
      is_favorited: interactionTypes.has('favorite') || interactionTypes.has('emoji_reaction'),
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

// The post that "Reply" should address. For *pure* reblogs we hand the
// original post to the Composer so the mention targets the original author
// and the reply is threaded under the original note (Mastodon/Pleroma/Misskey
// behavior). For quote posts and regular posts, the reply targets the post
// itself - quote posts are first-class user posts whose replies belong on
// them, not on the post they quote. The shared util encodes this rule so
// every reply call site agrees.
const replyTarget = computed<TimelinePost>(() => getOriginalPost(props.post));

// For reblogs, we need to show reactions for the ORIGINAL post
// Create a post-like object with the correct ID for PostReactions component
const displayPostForReactions = computed((): TimelinePost => {
  if (isReblog.value && props.post.reblog?.id) {
    return {
      ...props.post.reblog,
      id: props.post.reblog.id,
      metadata: {
        ...props.post.reblog.metadata,
        remote_reactions: props.post.metadata?.remote_reactions,
        remote_reactions_fetched_at: props.post.metadata?.remote_reactions_fetched_at,
      },
    } as TimelinePost;
  }
  return props.post;
});

// Optimistic override for favorite state - set immediately on click, reconciled after DB response
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

const isCurrentUserAdminOrMod = computed(() => {
  const currentUser = getCurrentUser.value;
  if (!currentUser?.id) return false;
  const profile = getUserProfile(currentUser.id).value;
  return profile?.is_admin || profile?.is_moderator || false;
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
    return (content as string).replace(/<[^>]+>/g, '').slice(0, 200);
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
      await themeStore.playAudio('reaction');
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
          await themeStore.playAudio('ui_error');
        } catch (audioError) {
          debug.warn('Failed to play error audio:', audioError);
        }
      } else {
        debug.log(`✅ Added emoji reaction ${emoji.name} to post ${props.post.id}`);
        closeEmojiPopup();
        // Refresh the reactions display
        if (postReactionsRef.value) {
          await (postReactionsRef.value as any).loadReactions?.();
        }
      }
    }
  } catch (error) {
    debug.error('Error adding emoji reaction:', error);
    // Play error sound if available
    try {
      await themeStore.playAudio('ui_error');
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

const onTogglePin = async () => {
  closeMenu();
  const result = await togglePinPost(props.post);
  if (!result.success) {
    toast.error(result.error || 'Failed to toggle pin');
  } else {
    toast.success(result.pinned ? 'Pinned to profile' : 'Unpinned from profile');
  }
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
    toast.success('Link copied to clipboard');
  } catch (error) {
    debug.error('Failed to copy link:', error);
    toast.error('Failed to copy link');
  }
  closeMenu();
};

const closeMenu = () => {
  showMenu.value = false;
};

function handleDropdownOutsideClick(e: MouseEvent) {
  const target = e.target as Node;
  if (menuButtonRef.value?.contains(target) || dropdownRef.value?.contains(target)) return;
  closeMenu();
}

watch(showMenu, (isOpen) => {
  if (isOpen) {
    nextTick(() => {
      document.addEventListener('mousedown', handleDropdownOutsideClick);
    });
  } else {
    document.removeEventListener('mousedown', handleDropdownOutsideClick);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleDropdownOutsideClick);
  if (tooltipTimer.value) clearTimeout(tooltipTimer.value);
  tooltipTimer.value = null;
  tooltip.value.visible = false;
});

const dropdownStyle = ref<Record<string, string>>({});

const handleMenuToggle = () => {
  if (!showMenu.value && menuButtonRef.value) {
    const rect = menuButtonRef.value.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const left = Math.max(8, rect.right - 150);

    if (spaceBelow < 200) {
      dropdownStyle.value = {
        position: 'fixed',
        bottom: `${window.innerHeight - rect.top + 4}px`,
        left: `${left}px`,
        zIndex: '9999',
      };
    } else {
      dropdownStyle.value = {
        position: 'fixed',
        top: `${rect.bottom + 4}px`,
        left: `${left}px`,
        zIndex: '9999',
      };
    }
  }
  showMenu.value = !showMenu.value;
};

// Optimistic favorite toggle - fills/unfills the heart immediately
const handleToggleFavorite = async () => {
  const postId = originalPostId.value;
  if (!postId) return;

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
const handleReblogClick = async () => {
  // If already reblogged, undo the reblog directly
  if (displayInteractionCounts.value.is_reblogged) {
    const postId = originalPostId.value;
    if (!postId) return;
    toggleReblog(postId);
    return;
  }

  // Otherwise show the menu with options
  showReblogMenu.value = !showReblogMenu.value;
};

const handleSimpleReblog = async () => {
  showReblogMenu.value = false;
  const postId = originalPostId.value;
  if (!postId) return;
  await toggleReblog(postId);
};

const handleQuoteReblog = () => {
  showReblogMenu.value = false;
  // Open composer with the ORIGINAL post as a quote (not a reblog)
  const originalPost = props.post.reblog || props.post;
  const originalAuthor = props.post.reblog_author || props.post.author;
  activityPubStore.openComposer({
    quotePost: originalPost as any,
    quoteAuthor: originalAuthor as any,
  });
};

const handleToggleBookmark = async () => {
  const postId = originalPostId.value;
  if (!postId) return;
  toggleBookmark(postId);
};

// Manual menu triggers for fetch - close menu before calling composable methods
const handleFetchRemoteReactions = () => {
  showMenu.value = false;
  fetchRemoteReactions();
};

const handleFetchRemoteReplies = () => {
  showMenu.value = false;
  fetchRemoteReplies();
};

const handleRefetchFromSource = async () => {
  showMenu.value = false;
  isRefetchingContent.value = true;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      isRefetchingContent.value = false;
      return;
    }

    const response = await fetch(`${activityPubStore.federationApiUrl}/refetch-post`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ post_id: props.post.id }),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Refetch failed');
    }

    if (result.content) {
      activityPubStore.updatePostContentInAllFeeds(props.post.id, result.content);
    }

    notificationStore.showToast('server_update', 'Post refetched', 'Content updated from source.', 3000);
  } catch (error: any) {
    notificationStore.showToast('server_update', 'Refetch failed', error.message || 'Could not refetch post.', 5000);
  } finally {
    isRefetchingContent.value = false;
  }
};

const handleAdminToggleSensitive = async () => {
  showMenu.value = false;
  const postId = originalPostId.value;
  try {
    const currentSensitive = displayIsSensitive.value;
    const newVal = !currentSensitive;
    const action = currentSensitive ? 'unmark_sensitive' : 'mark_sensitive';
    await adminService.moderatePost(postId, action);
    activityPubStore.updatePostFieldInAllFeeds(postId, 'is_sensitive', newVal);
    if (isReblog.value && props.post.reblog) {
      (props.post.reblog as any).is_sensitive = newVal;
    }
    notificationStore.showToast('server_update', 'Post updated', newVal ? 'Post marked as sensitive.' : 'Post unmarked as sensitive.', 3000);
  } catch (error: any) {
    notificationStore.showToast('server_update', 'Failed', error.message || 'Could not update post.', 5000);
  }
};

const handleAdminSetCW = async () => {
  showMenu.value = false;
  const postId = originalPostId.value;
  const existingCw = (isReblog.value && props.post.reblog?.content_warning) || props.post.content_warning || '';
  const cw = prompt('Content warning text (leave empty to remove):', existingCw);
  if (cw === null) return;
  try {
    if (cw.trim()) {
      await adminService.moderatePost(postId, 'set_cw', cw.trim());
      activityPubStore.updatePostFieldInAllFeeds(postId, 'content_warning', cw.trim());
      if (isReblog.value && props.post.reblog) {
        (props.post.reblog as any).content_warning = cw.trim();
      }
      notificationStore.showToast('server_update', 'Content warning set', '', 3000);
    } else {
      await adminService.moderatePost(postId, 'remove_cw');
      activityPubStore.updatePostFieldInAllFeeds(postId, 'content_warning', null);
      if (isReblog.value && props.post.reblog) {
        (props.post.reblog as any).content_warning = null;
      }
      notificationStore.showToast('server_update', 'Content warning removed', '', 3000);
    }
  } catch (error: any) {
    notificationStore.showToast('server_update', 'Failed', error.message || 'Could not update content warning.', 5000);
  }
};

const handleAdminDeletePost = async () => {
  showMenu.value = false;
  const postId = originalPostId.value;
  if (!confirm('Delete this post as admin? This cannot be undone.')) return;
  try {
    await adminService.moderatePost(postId, 'delete');
    activityPubStore.updatePostFieldInAllFeeds(postId, 'is_deleted', true);
    notificationStore.showToast('server_update', 'Post deleted', 'Post has been removed by admin.', 3000);
  } catch (error: any) {
    notificationStore.showToast('server_update', 'Failed', error.message || 'Could not delete post.', 5000);
  }
};

// Handle emoji picker for original post (for reblogs, target the original)
const handleShowEmojiPickerForOriginal = () => {
  // Create a post-like object with the original post ID for the emoji picker
  const targetPost: any = isReblog.value && props.post.reblog
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
  if (props.embedded) {
    emit('open-lightbox', url);
    return;
  }
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

.pinned-header {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.5rem 1rem 0;
  color: var(--text-muted, #9ca3af);
  font-size: 0.8rem;
  font-weight: 500;
}

.pinned-icon {
  opacity: 0.7;
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

.edited-indicator {
  color: var(--text-tertiary, #6b7280);
  font-size: 0.75rem;
  margin-left: 4px;
  cursor: default;
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
  position: relative;
}

.post-body.is-sensitive {
  filter: blur(10px);
  transition: filter 0.2s;
}

.post-body.is-sensitive:hover,
.post-body.is-sensitive.revealed {
  filter: blur(0px);
}

/* Tap-to-reveal overlay on mobile: first tap reveals, second tap opens lightbox */
.sensitive-tap-overlay {
  position: absolute;
  inset: 0;
  z-index: 1;
  cursor: pointer;
}

.post-text {
  color: var(--text-primary);
  line-height: 1.6;
  word-wrap: break-word;
  margin-bottom: 1rem;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

.post-link-preview {
  display: block;
  text-decoration: none;
  margin-top: 0.5rem;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border-color, rgba(255,255,255,0.1));
  transition: border-color 0.2s;
}

.post-link-preview:hover {
  border-color: var(--primary);
}

/* Compact caption variant — used right beneath an inline rich embed
   (e.g. a YouTube iframe). Tighter margins so it visually reads as part
   of the same "video unit" rather than a separate card, smaller radius
   to match the slimmer chrome, and a subtler hover so the caption
   doesn't compete for attention with the iframe above it. */
.post-link-preview--compact {
  margin-top: 0.25rem;
  border-radius: 8px;
}

.post-link-preview--compact:hover {
  border-color: var(--border-color-strong, rgba(255, 255, 255, 0.2));
}

.post-text :deep(*) {
  user-select: text;
  -webkit-user-select: text;
}

.post-text :deep(img) {
  max-width: 100%;
  height: auto;
}

.post-text :deep(img.inline-emoji) {
  height: 1.2em;
  width: auto;
  max-width: 120px;
  vertical-align: -0.2em;
  margin: 0 1px;
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

:global(.action-dropdown .dropdown-divider) {
  height: 1px;
  background: rgba(255, 255, 255, 0.1);
  margin: 0.5rem 0;
}

:global(.action-dropdown .loading-item) {
  color: #9ca3af;
  cursor: wait;
}

:global(.action-dropdown .loading-item .spinning) {
  animation: monypost-spin 1s linear infinite;
}

@keyframes monypost-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.action-menu {
  position: relative;
  margin-left: auto;
}

/* Dropdown styles use :global() because the dropdown is Teleported to <body> */
:global(.action-dropdown) {
  position: fixed;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  background-color: var(--background-primary-alpha, rgba(30, 31, 34, 0.85));
  border: 1px solid var(--border-color);
  border-radius: 0.5rem;
  padding: 0.5rem;
  min-width: 150px;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
  z-index: 9999;
}

:global(.action-dropdown .dropdown-item) {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem;
  background: none;
  border: none;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  border-radius: 0.25rem;
  font-size: 0.875rem;
}

:global(.action-dropdown .dropdown-item:hover) {
  background-color: var(--background-secondary-alpha);
}

:global(.action-dropdown .dropdown-item.danger) {
  color: var(--error);
}

:global(.action-dropdown .dropdown-item.danger:hover) {
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
  color: var(--h-brand, #0EA5E9);
  text-decoration: none;
  font-size: 0.875rem;
  padding: 0.5rem 0.75rem;
  background: rgba(14, 165, 233, 0.1);
  border-radius: 0.5rem;
  width: fit-content;
  transition: all 0.2s;
}

.reblog-reference-link:hover {
  background: rgba(14, 165, 233, 0.2);
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
  gap: 4px;
  border-radius: 0.5rem;
  overflow: hidden;
  max-height: 200px;
}

.quoted-media-gallery.media-count-1 { grid-template-columns: 1fr; }
.quoted-media-gallery.media-count-2 {
  grid-template-columns: 1fr 1fr;
  aspect-ratio: 2 / 1;
}
.quoted-media-gallery.media-count-3 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  aspect-ratio: 1 / 1;
}
.quoted-media-gallery.media-count-3 .media-item:first-child {
  grid-row: 1 / 3;
}
.quoted-media-gallery.media-count-4 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  aspect-ratio: 1 / 1;
}

.quoted-media-gallery .media-image,
.quoted-media-gallery .media-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* Media Gallery Styles */

.media-gallery {
  display: grid;
  gap: 4px;
  border-radius: 0.5rem;
  overflow: hidden;
  margin: 0.5rem 0.75rem 0.75rem;
  max-height: 400px;
}

.media-gallery.media-count-1 {
  grid-template-columns: 1fr;
}

.media-gallery.media-count-2 {
  grid-template-columns: 1fr 1fr;
  aspect-ratio: 2 / 1; /* two side-by-side cells */
}

.media-gallery.media-count-3 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  aspect-ratio: 1 / 1; /* square grid for L-shape layout */
}

.media-gallery.media-count-3 .media-item:first-child {
  grid-row: 1 / 3;
}

.media-gallery.media-count-4 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  aspect-ratio: 1 / 1; /* 2x2 square grid */
}

.media-item {
  border-radius: 0;
  overflow: hidden;
  position: relative;
  min-height: 0;
}

.media-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  cursor: pointer;
}

.media-gallery.media-count-1 .media-image {
  max-height: 400px;
  height: auto;
}

.media-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.media-gallery.media-count-1 .media-video {
  max-height: 400px;
  height: auto;
}

/* Mobile responsive */
@media (max-width: 768px) {
  .post-content {
    padding: 0.75rem;
  }

  .author-avatar {
    width: 36px;
    height: 36px;
  }

  /* 1. Post header: keep timestamp top-right, prevent overflow */
  .post-header {
    align-items: flex-start;
  }

  .author-info {
    min-width: 0;
    overflow: hidden;
  }

  .author-details {
    overflow: hidden;
  }

  .author-name {
    font-size: 0.85rem;
  }

  .author-handle {
    font-size: 0.75rem;
  }

  .post-meta {
    font-size: 0.75rem;
    align-items: flex-end;
    justify-content: flex-start;
  }

  .post-time {
    white-space: nowrap;
  }

  /* 2. Smaller visibility icon on mobile */
  .visibility-indicator {
    font-size: 0.7rem;
  }
  .visibility-indicator :deep(svg) {
    width: 12px;
    height: 12px;
  }

  /* 3. Reply indicator: stack label+author, separate View thread button */
  .reply-indicator-bar {
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .show-thread-btn {
    width: 100%;
    justify-content: center;
    padding: 0.4rem 0.75rem;
    white-space: nowrap;
    margin-left: 0;
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
  background: var(--tooltip-bg, var(--background-tertiary));
  color: var(--tooltip-text, var(--text-primary));
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
  color: var(--tooltip-text, var(--text-primary));
}

.tooltip-user {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) 0;
  font-size: var(--font-size-sm);
  color: var(--tooltip-text, var(--text-secondary));
  opacity: 0.95;
}

.tooltip-avatar {
  flex-shrink: 0;
}

.tooltip-username {
  color: var(--tooltip-text, var(--text-primary));
}

.tooltip-domain {
  color: var(--tooltip-text, var(--text-muted));
  font-size: var(--font-size-xs);
  opacity: 0.7;
}
</style>
