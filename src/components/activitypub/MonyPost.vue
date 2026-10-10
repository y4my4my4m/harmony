<!-- MonyPost Component - Individual post display -->
<template>
  <!-- v-show, not v-if: v-if drops the post on re-render. authorFallback covers a
       momentarily missing author so the article still renders. -->
  <article class="mony-post" data-testid="post-item"
  v-show="post && (author || authorFallback)" :class="{ 'is-reply': post.reply_context, 'is-reblog': isPureReblog, 'is-pinned': showPinnedHeader && post.is_pinned, 'is-detailed': detailed }">

    <!-- Pinned indicator (profile timeline pinned section only) -->
    <div v-if="showPinnedHeader && post.is_pinned" class="post-prepend">
      <Icon name="pin" :size="14" class="prepend-icon" />
      <span>{{ t('activitypub.pinned') }}</span>
    </div>

    <!-- Boost header (pure boosts only; quotes are first-class posts) -->
    <div v-if="isPureReblog" class="post-prepend">
      <Icon name="reblog" :size="14" class="prepend-icon" />
      <RouterLink :to="profileRoute(author)" class="prepend-author">
        <DisplayName :userId="author.id" :fallback="author.display_name || author.username" />
      </RouterLink>
      <span>{{ t('activitypub.boosted') }}</span>
    </div>

    <!-- Main Post Content -->
    <div class="post-content" :class="{ 'reblog-content': isPureReblog }">
      <!-- Author Info (show original author for reblogs) -->
      <div class="post-header">
        <RouterLink :to="profileRoute(displayAuthor)" class="author-info">
          <Avatar
            :src="displayAuthor.avatar_url"
            :alt="displayAuthor.display_name || displayAuthor.username"
            size="md"
          />
          <span class="author-details">
            <span class="author-name">
              <DisplayName :userId="displayAuthor.id" :fallback="displayAuthor.display_name || displayAuthor.username" />
              <span v-if="authorInstanceBadge === 'admin'" class="instance-badge" :title="t('activitypub.instanceAdmin')">{{ t('activitypub.adminBadge') }}</span>
              <span v-else-if="authorInstanceBadge === 'mod'" class="instance-badge" :title="t('activitypub.instanceModerator')">{{ t('activitypub.modBadge') }}</span>
              <SupporterBadge v-if="displayAuthor.id" :user-id="displayAuthor.id" :badge="authorSupporterBadge" />
            </span>
            <span class="author-handle">{{ displayHandle }}</span>
          </span>
        </RouterLink>

        <div v-if="!detailed" class="post-meta">
          <RouterLink :to="postRoute" class="post-time" :title="formatFullDate(originalCreatedAt)">
            <time :datetime="originalCreatedAt">{{ formatRelativeTime(originalCreatedAt) }}</time>
          </RouterLink>
          <span class="visibility-indicator" role="img" :title="visibilityTitle" :aria-label="visibilityTitle">
            <Icon :name="visibilityIcon" :size="14" />
          </span>
          <span v-if="isEdited" class="edited-indicator" :title="t('activitypub.editedTitle')">*</span>
        </div>
      </div>

      <!-- Reply line: parent author and a thread link, never the parent body -->
      <div v-if="showReplyLine" class="reply-line">
        <Icon name="reply" :size="14" class="reply-line-icon" />
        <span>{{ t('activitypub.replyingTo') }}</span>
        <RouterLink :to="profileRoute(displayReplyContext.author)" class="reply-author-link">
          {{ formatHandle(displayReplyContext.author) }}
        </RouterLink>
        <span aria-hidden="true">·</span>
        <button type="button" class="text-link" @click.stop="showReplyTarget">
          {{ t('activitypub.viewThread') }}
        </button>
      </div>

      <!-- Content Warning -->
      <div v-if="displayContentWarning" class="content-warning">
        <p class="cw-text">{{ displayContentWarning }}</p>
        <button
          type="button"
          class="cw-toggle"
          :aria-expanded="showSensitiveContent"
          @click="showSensitiveContent = !showSensitiveContent"
        >
          {{ showSensitiveContent ? t('activitypub.showLess') : t('activitypub.showMore') }}
        </button>
      </div>

      <!-- Post Body. Sensitive media blur lives in MonyMediaGallery; text is never blurred. -->
      <div
        v-show="!displayContentWarning || showSensitiveContent"
        class="post-body"
      >
        <!-- Unhydrated Reblog/Quote: Show reference link when content not loaded -->
        <div v-if="isUnhydratedReblog" class="unhydrated-reblog">
          <div class="unhydrated-reblog-notice">
            <Icon name="reblog" :size="16" />
            <span>{{ t('activitypub.boostedFromAnotherInstance') }}</span>
          </div>
          <a
            v-if="reblogReferenceUrl"
            :href="safeHref(reblogReferenceUrl)"
            target="_blank"
            rel="noopener noreferrer"
            class="reblog-reference-link"
          >
            <Icon name="external-link" :size="14" />
            {{ t('activitypub.viewOriginalPost') }}
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
            <div v-if="quotedAuthor" class="quoted-post-header">
              <Avatar
                :src="quotedAuthor.avatar_url"
                :alt="quotedAuthor.display_name || quotedAuthor.username"
                size="sm"
              />
              <div class="quoted-author-info">
                <span class="quoted-author-name"><DisplayName :userId="quotedAuthor.id" :fallback="quotedAuthor.display_name || quotedAuthor.username" /></span>
                <span class="quoted-author-handle">{{ formatHandle(quotedAuthor) }}</span>
                <time class="quoted-post-time" :datetime="quotedCreatedAt" :title="formatFullDate(quotedCreatedAt)">{{ formatRelativeTime(quotedCreatedAt) }}</time>
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

          <!-- Fediverse poll: counts as last reported by the origin; votes are cast there. -->
          <RemotePollCard
            v-if="remotePollMetadata"
            :metadata="remotePollMetadata"
            :original-url="remotePollUrl"
          />

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
            :href="safeHref(embed.url)"
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

          <!-- Link preview cards. Variant is `thumbnail` (small horizontal
               card) when the post also has a media attachment, so we don't
               visually double the dominant image. Otherwise `default` (big
               hero card). -->
          <a
            v-for="embed in cardEmbeds"
            :key="embed.url"
            :href="safeHref(embed.url)"
            target="_blank"
            rel="noopener noreferrer"
            class="post-link-preview"
          >
            <LinkEmbedCard :payload="(embed as any)" :variant="cardEmbedVariant" />
          </a>
        </div>
      </div>

      <!-- Emoji reactions sit under the content, above the meta and the action bar.
           A boost's reactions are the original post's. -->
      <PostReactions
        ref="postReactionsRef"
        :post="displayPostForReactions"
        @show-reaction-tooltip="handleShowReactionTooltip"
        @hide-reaction-tooltip="handleHideReactionTooltip"
        @reactions-changed="handleReactionsChanged"
      />

      <!-- Focused post (thread view): full timestamp and counts -->
      <template v-if="detailed">
        <div class="detail-meta">
          <RouterLink :to="postRoute" class="detail-time">
            <time :datetime="originalCreatedAt">{{ formatFullDate(originalCreatedAt) }}</time>
          </RouterLink>
          <span aria-hidden="true">·</span>
          <span class="visibility-indicator" role="img" :title="visibilityTitle" :aria-label="visibilityTitle">
            <Icon :name="visibilityIcon" :size="14" />
          </span>
          <template v-if="isEdited">
            <span aria-hidden="true">·</span>
            <span :title="t('activitypub.editedTitle')">{{ t('activitypub.edited') }}</span>
          </template>
        </div>
        <div v-if="detailStats.length > 0" class="detail-stats">
          <template v-for="(stat, index) in detailStats" :key="stat.key">
            <span v-if="index > 0" class="detail-stats-separator" aria-hidden="true">·</span>
            <span class="detail-stat">
              <strong>{{ formatCount(stat.count) }}</strong>
              {{ t(stat.label, stat.count) }}
            </span>
          </template>
        </div>
      </template>

      <!-- Action Buttons -->
      <div class="post-actions">
        <button
          type="button"
          class="action-button reply-button"
          data-testid="post-reply-btn"
          @click="onReply"
          :title="replyLabel"
          :aria-label="replyLabel"
          :aria-expanded="showInlineReply"
        >
          <span class="action-glyph"><Icon name="message-circle" :size="ACTION_GLYPH.reply" :stroke-width="glyphStroke(ACTION_GLYPH.reply)" /></span>
          <span v-if="!detailed && displayInteractionCounts.replies_count > 0" class="action-count">{{ formatCount(displayInteractionCounts.replies_count) }}</span>
        </button>

        <div class="reblog-menu-container" v-click-outside="() => showReblogMenu = false">
          <button
            type="button"
            class="action-button reblog-button"
            data-testid="post-reblog-btn"
            :class="{
              active: displayInteractionCounts.is_reblogged,
              disabled: !canReblog && !displayInteractionCounts.is_reblogged
            }"
            @click="handleReblogClick"
            :disabled="!canReblog && !displayInteractionCounts.is_reblogged"
            :title="boostLabel"
            :aria-label="boostLabel"
            :aria-pressed="displayInteractionCounts.is_reblogged"
            :aria-expanded="displayInteractionCounts.is_reblogged ? undefined : showReblogMenu"
          >
            <span class="action-glyph"><Icon name="reblog" :size="ACTION_GLYPH.reblog" :stroke-width="glyphStroke(ACTION_GLYPH.reblog)" /></span>
            <span v-if="!detailed && displayInteractionCounts.reblogs_count > 0" class="action-count">{{ formatCount(displayInteractionCounts.reblogs_count) }}</span>
          </button>

          <!-- Boost dropdown menu -->
          <div v-if="showReblogMenu && canReblog" class="reblog-dropdown" role="menu">
            <button
              type="button"
              role="menuitem"
              class="reblog-option"
              data-testid="reblog-option-boost"
              @click="handleSimpleReblog"
              :disabled="displayInteractionCounts.is_reblogged"
            >
              <Icon name="reblog" :size="16" />
              <span>{{ t('activitypub.boost') }}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              class="reblog-option"
              @click="handleQuoteReblog"
            >
              <Icon name="edit" :size="16" />
              <span>{{ t('activitypub.quote') }}</span>
            </button>
          </div>
        </div>

        <button
          type="button"
          class="action-button favorite-button"
          data-testid="post-favorite-btn"
          :class="{ active: displayInteractionCounts.is_favorited }"
          @click="handleToggleFavorite"
          :title="favoriteLabel"
          :aria-label="favoriteLabel"
          :aria-pressed="displayInteractionCounts.is_favorited"
        >
          <span class="action-glyph"><Icon :name="displayInteractionCounts.is_favorited ? 'heart-filled' : 'heart'" :size="ACTION_GLYPH.default" /></span>
          <span v-if="!detailed && displayInteractionCounts.favorites_count > 0" class="action-count">{{ formatCount(displayInteractionCounts.favorites_count) }}</span>
        </button>

        <button
          ref="emojiTriggerRef"
          type="button"
          class="action-button add-reaction-button"
          @click.stop="handleShowEmojiPickerForOriginal"
          :title="t('activitypub.addReaction')"
          :aria-label="t('activitypub.addReaction')"
        >
          <span class="action-glyph"><Icon name="smile-plus" :size="ACTION_GLYPH.default" /></span>
        </button>

        <button
          type="button"
          class="action-button bookmark-button"
          data-testid="post-bookmark-btn"
          :class="{ active: displayInteractionCounts.is_bookmarked }"
          @click="handleToggleBookmark"
          :title="bookmarkLabel"
          :aria-label="bookmarkLabel"
          :aria-pressed="displayInteractionCounts.is_bookmarked"
        >
          <span class="action-glyph"><Icon :name="displayInteractionCounts.is_bookmarked ? 'bookmark-filled' : 'bookmark'" :size="ACTION_GLYPH.default" /></span>
        </button>

        <div class="action-menu">
          <button
            ref="menuButtonRef"
            type="button"
            class="action-button menu-button"
            @click="handleMenuToggle"
            :title="t('activitypub.moreOptions')"
            :aria-label="t('activitypub.moreOptions')"
            aria-haspopup="menu"
            :aria-expanded="showMenu"
          >
            <span class="action-glyph"><Icon name="more-horizontal" :size="ACTION_GLYPH.default" /></span>
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
                v-if="canEdit && !isPureReblog"
                class="dropdown-item"
                @click="onEdit"
              >
                <Icon name="edit" />
                <span>Edit</span>
              </button>
              
              <button
                v-if="canEdit && !isPureReblog"
                class="dropdown-item"
                @click="onTogglePin"
              >
                <Icon :name="props.post.is_pinned ? 'pin-off' : 'pin'" />
                <span>{{ props.post.is_pinned ? 'Unpin from profile' : 'Pin to profile' }}</span>
              </button>

              <button
                v-if="isPureReblog && canDelete"
                class="dropdown-item"
                @click="onUndoReblog"
              >
                <Icon name="reblog" />
                <span>{{ t('activitypub.undoBoost') }}</span>
              </button>
              
              <button 
                v-if="!isPureReblog && canDelete"
                class="dropdown-item danger"
                @click="onDelete"
              >
                <Icon name="trash" />
                <span>Delete</span>
              </button>

              <button
                v-if="!isPureReblog && canDelete"
                class="dropdown-item danger"
                @click="onDeleteAndRedraft"
              >
                <Icon name="edit" />
                <span>Delete and redraft</span>
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
                v-if="!canDelete && displayAuthor?.id"
                class="dropdown-item"
                @click="onMuteAuthor"
              >
                <Icon name="volume-x" />
                <span>{{ isAuthorMuted ? 'Unmute' : 'Mute' }} @{{ displayAuthor.username }}</span>
              </button>
              <button
                v-if="!canDelete && displayAuthor?.id"
                class="dropdown-item danger"
                @click="onBlockAuthor"
              >
                <Icon name="ban" />
                <span>Block @{{ displayAuthor.username }}</span>
              </button>
              <button
                v-if="!canDelete"
                class="dropdown-item danger"
                @click="openReportModal"
              >
                <Icon name="flag" />
                <span>Report post</span>
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
      :target-user="{ username: displayAuthor.username, display_name: displayAuthor.display_name, avatar_url: displayAuthor.avatar_url, domain: displayAuthor.domain, is_local: displayAuthor.is_local }"
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
      title="Delete post?"
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
        :is-emoji-blocked="isReactionEmojiBlocked"
        :limit-notice="reactionLimitNotice"
        @send-emoji="handleEmojiSelected"
        @reset-emoji-icon-clicked="closeEmojiPopup"
      />
    </Teleport>

    <!-- Tooltip for reactions - teleported to body: coordinates are viewport-relative,
         and chat embeds nest this under a transformed virtual row plus
         contain: layout paint, both containing blocks for position: fixed. -->
    <Teleport to="body">
      <div
        v-if="tooltip.visible"
        class="reaction-tooltip"
        :style="{ top: `${tooltip.y}px`, left: `${tooltip.x}px` }"
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
          <div class="tooltip-user-meta">
            <span class="tooltip-username">
              <DisplayName
                v-if="user.displayNameParts"
                :parts="user.displayNameParts"
                :fallback="user.displayName"
              />
              <DisplayName v-else :userId="user.id" :fallback="user.displayName" />
            </span>
            <span v-if="user.isRemote && user.handle" class="tooltip-domain">{{ user.handle }}</span>
          </div>
        </div>
      </div>
    </Teleport>
    
    <!-- Lightbox for images (only when not embedded in chat context) -->
    <vue-easy-lightbox
      v-if="!embedded"
      teleport="body"
      :visible="showLightbox"
      :imgs="[currentLightboxImage]"
      :index="0"
      @hide="closeLightbox"
    />
    <LightboxDownloadButton
      v-if="!embedded"
      :visible="showLightbox"
      :url="currentLightboxImage"
    />
  </article>
</template>

<script lang="ts">
</script>

<script setup lang="ts">
import { safeHref } from '@/utils/sanitize';
import { computed, ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { debug } from '@/utils/debug'
import { resolveHarmonyBaseUrl } from '@/utils/discordBridgeSetup'
import { useI18n } from 'vue-i18n';
import { useUserData } from '@/composables/useUserData';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useNotificationStore } from '@/stores/useNotification';
import { useThemeStore } from '@/stores/useTheme';
import { usePostInteractions } from '@/composables/usePostInteractions';
import { useRemotePostSync } from '@/composables/useRemotePostSync';
import ConversationService from '@/services/ConversationService';
import { formatShortRelativeTime, formatFullDateTime } from '@/utils/shortRelativeTime';
import DisplayName from '@/components/DisplayName.vue';
import { userDataService } from '@/services/userDataService';
import { unicodeToShortcode } from '@/services/unifiedEmojiService';
import { getEmojiUrl } from '@/utils/emojiUtils';
import { getReactionTooltipAnchor } from '@/utils/reactionTooltipPosition';
import { getOriginalPost } from '@/utils/postReblog';
import { isHeartEmoji } from '@/utils/heartReaction';
import { remotePollFromMetadata } from '@/utils/remotePoll';
import { ownPostReactions } from '@/utils/reactionLimits';
import { usePostReactionLimit } from '@/composables/useReactionLimits';
import { usePostReactionsStore } from '@/stores/postReactions';
import { services } from '@/services';
import { supabase } from '@/supabase';
import type { TimelinePost, DisplayNamePart } from '@/types';

// Components
import MonyContent from './MonyContent.vue';
import LinkEmbedCard from '@/components/embeds/LinkEmbedCard.vue';
import { parseEmbedUrl, isYouTubeUrl } from '@/utils/embedDetection';
import Icon from '@/components/common/Icon.vue';
import LightboxDownloadButton from '@/components/common/LightboxDownloadButton.vue';
import Avatar from '../common/Avatar.vue';
import Composer from './Composer.vue';
import PostReactions from './PostReactions.vue';
import MonyMediaGallery from './MonyMediaGallery.vue';
import RemotePollCard from '@/components/polls/RemotePollCard.vue';
import ConfirmationModal from '../ConfirmationModal.vue';
import ReportModal from '@/components/moderation/ReportModal.vue';
import SupporterBadge from '@/components/common/SupporterBadge.vue';
import { badgeFromMembership } from '@/services/FundingService';
import { adminService } from '@/services/AdminService';
import EmojiPopup from '@/components/EmojiPopup.vue';
import VueEasyLightbox from 'vue-easy-lightbox';
import { useToast } from 'vue-toastification';
import router from '@/router';
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { messagePartsToRawText } from '@/utils/messageContentUtils'
import { runtimeConfig } from '@/services/runtimeConfig'

// Props
interface Props {
  post: TimelinePost;
  hideReplyContext?: boolean;
  isInThread?: boolean;
  embedded?: boolean; // When true, delegates lightbox to parent via open-lightbox emit
  /** Show "Pinned" row (profile pinned section only; not home/local/public feeds) */
  showPinnedHeader?: boolean;
  /** Focused post in a thread: full timestamp and count summary. */
  detailed?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  hideReplyContext: false,
  isInThread: false,
  embedded: false,
  showPinnedHeader: false,
  detailed: false,
});

const i18n = useI18n();
const { t } = i18n;

const { confirm, prompt } = useConfirmDialog()

// Emits
const emit = defineEmits<{
  reply: [post: TimelinePost];
  'reply-created': [reply: TimelinePost, parentId: string];
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
const postReactionsStore = usePostReactionsStore();

// Composables for clean interaction handling
const { toggleFavorite, toggleReblog, toggleBookmark, togglePinPost } = usePostInteractions();

const showSensitiveContent = ref(false);
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
    displayNameParts?: DisplayNamePart[];
    displayNameEmojis?: Array<{name: string, url: string}>;
    avatarUrl: string;
    userColor?: string;
    isRemote?: boolean;
    domain?: string;
    handle?: string;
  }[],
  x: 0,
  y: 0,
  emoji: null as { name?: string; url?: string; unicode?: string } | null,
});
const tooltipTimer = ref<NodeJS.Timeout | null>(null);

const tooltipEmojiShortcode = computed(() => {
  const unicode = tooltip.value.emoji?.unicode
  if (!unicode) return ''
  return unicodeToShortcode(unicode) || ''
})

const postRoute = computed(() => ({ name: 'PostDetail', params: { postId: props.post.id } }));

// Computed
const author = computed(() => {
  return props.post.author;
});

// Fallback author for edge cases where author is temporarily unavailable
const authorFallback = computed(() => {
  if (author.value) return null;
  return {
    id: props.post.author_id,
    username: 'Loading...',
    display_name: 'Loading...',
    avatar_url: null,
    domain: runtimeConfig.domain as string,
    is_local: props.post.is_local ?? true
  };
});

// Use the actual author if available, otherwise use fallback
const displayAuthorSafe = computed(() => {
  return author.value || authorFallback.value;
});

const LOCAL_DOMAIN = runtimeConfig.domain as string;

type HandleSource = { username?: string; domain?: string | null; is_local?: boolean } | null | undefined;

const isLocalAuthor = (author: HandleSource) =>
  author?.is_local ?? (!author?.domain || author.domain === LOCAL_DOMAIN);

const profileRoute = (author: HandleSource) => {
  const username = author?.username || '';
  const handle = isLocalAuthor(author) || !author?.domain ? username : `${username}@${author.domain}`;
  return { name: 'UserProfile', params: { handle } };
};

/** "@user@domain"; Misskey's "." domain placeholder is dropped. */
const formatHandle = (author: HandleSource) => {
  const username = author?.username || '';
  const domain = author?.domain && author.domain !== '.' ? author.domain : LOCAL_DOMAIN;
  return domain ? `@${username}@${domain}` : `@${username}`;
};

const instanceDomain = computed(() => {
  const domain = props.post.author?.domain || displayAuthorSafe.value?.domain;
  return domain || runtimeConfig.domain as string;
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
        // Post objects are store-shared refs; mutating keeps every rendered copy in sync.
        if (!props.post.metadata) {
          // eslint-disable-next-line vue/no-mutating-props
          props.post.metadata = {};
        }
        // eslint-disable-next-line vue/no-mutating-props
        props.post.metadata.remote_reactions = result.remote_reactions;
        // eslint-disable-next-line vue/no-mutating-props
        props.post.metadata.remote_reactions_fetched_at = new Date().toISOString();
      }
      // For pure reblogs, update the reblog sub-object (displayInteractionCounts reads from there)
      const target = (isPureReblog.value && props.post.reblog) ? props.post.reblog : props.post;
      if (result.favorites_count !== undefined) {
        target.favorites_count = result.favorites_count;
      }
      if (result.replies_count !== undefined) {
        target.replies_count = result.replies_count;
      }
      if (result.reblogs_count !== undefined) {
        target.reblogs_count = result.reblogs_count;
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

// Pure boost (Announce wrapper) - quote posts are first-class posts and
// must NOT unwrap: their header, interactions and routing target the quote.
const isPureReblog = computed(() => isReblog.value && !isQuotePost.value);

const reblogReferenceUrl = computed(() => {
  return props.post.metadata?.reblog_of_ap_url || 
         props.post.metadata?.quote_url || 
         null;
});

// eslint-disable-next-line unused-imports/no-unused-vars
const isVideoMediaUrl = (url: string): boolean => {
  if (!url) return false;
  return /\.(mp4|webm|ogg|avi|mov|wmv|flv|m4v)(\?.*)?$/i.test(url);
};

// Main card header author. Pure reblogs unwrap to the boosted author;
// quotes keep the quoter (the quoted author renders inside the quote block).
const displayAuthor = computed(() => {
  const author = (isPureReblog.value && props.post.reblog_author) ? props.post.reblog_author : props.post.author;
  return author || authorFallback.value;
});

// Author/time shown inside the quoted block of a quote post.
const quotedAuthor = computed(() => {
  return props.post.reblog_author || props.post.reblog?.author || null;
});

const quotedCreatedAt = computed(() => {
  return props.post.reblog?.created_at || props.post.created_at;
});

const authorSupporterBadge = computed(() => {
  const membership = displayAuthor.value?.supporter_membership;
  if (membership === undefined) return undefined;
  return badgeFromMembership(membership);
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
  if (!isPureReblog.value || !props.post.reblog_author) return instanceDomain.value;
  const { domain } = props.post.reblog_author;
  return domain || runtimeConfig.domain as string;
});

const displayHandle = computed(() => {
  const domain = isPureReblog.value ? originalInstanceDomain.value : instanceDomain.value;
  return formatHandle({ username: displayAuthor.value?.username, domain });
});

const originalCreatedAt = computed(() => {
  return (isPureReblog.value && props.post.reblog) ? props.post.reblog.created_at : props.post.created_at;
});

const isEdited = computed(() => {
  const post = (isPureReblog.value && props.post.reblog) ? props.post.reblog : props.post;
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
  // Quote posts render the original content in a quoted block
  return (isReblog.value && props.post.reblog) ? props.post.reblog.content : props.post.content;
});

const remotePollSource = computed<any>(() => (isReblog.value && props.post.reblog) ? props.post.reblog : props.post);
const remotePollMetadata = computed(() => {
  const metadata = remotePollSource.value?.metadata;
  return remotePollFromMetadata(metadata) ? metadata as Record<string, any> : null;
});
const remotePollUrl = computed<string | null>(() => remotePollSource.value?.url || remotePollSource.value?.ap_id || null);

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

// Embed de-duplication. `useContentRenderer.formattedHTML` auto-injects an
// inline iframe for any YouTube URL in the post text (see
// useContentRenderer.ts:507). Unsplit, `postEmbeds` would also render a full
// LinkEmbedCard for the same URL - three vertical surfaces showing one video
// (iframe, optional uploaded media, link card). Split the embed list by
// whether the URL is already represented as an inline rich embed.
//
//   * `inlineRichEmbeds`  → URLs the content renderer already iframes.
//                            Rendered as a *compact caption* directly
//                            beneath the content so the user still gets
//                            the title/channel context Mastodon shows,
//                            without doubling the visual weight.
//   * `cardEmbeds`        → everything else (Wikipedia, news, Spotify
//                            pages with no inline iframe support, etc.).
//                            Render the full LinkEmbedCard.
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
const cardEmbeds = computed(() => postEmbeds.value.filter((e) => !isInlineRichEmbed(e)));

// When the post also has a media attachment, render link cards in the
// `thumbnail` variant: a fixed-size horizontal card with a small image on
// the left and one-line title + one-line description on the right. The
// attachment is already the dominant visual; the card adds the
// site / title context without doubling the picture's footprint - same
// pattern Mastodon and Misskey use. With no attachment present, fall back
// to the full default card (image on top, full body).
const cardEmbedVariant = computed<'default' | 'thumbnail'>(() =>
  (displayMediaAttachments.value as any[]).length > 0 ? 'thumbnail' : 'default'
);

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

const loadedReplyContext = ref<any>(null);
const isLoadingReplyContext = ref(false);

const displayReplyContext = computed(() => {
  // For pure reblogs, check the reblogged post's reply context
  if (isPureReblog.value && props.post.reblog?.reply_context) {
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

const showReplyLine = computed(() => {
  return !!displayReplyContext.value?.author && !props.hideReplyContext && !props.isInThread;
});

const loadReplyContext = async () => {
  // For pure reblogs, use the reblogged post's in_reply_to
  const inReplyTo = isPureReblog.value
    ? props.post.reblog?.in_reply_to
    : props.post.in_reply_to;
  const hasReplyContext = isPureReblog.value
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
            domain: author.domain || runtimeConfig.domain as string
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

// Reblogs: interaction state belongs to the ORIGINAL post
const originalPostInteractions = ref<{
  is_favorited: boolean;
  is_reblogged: boolean;
  is_bookmarked: boolean;
} | null>(null);

const loadOriginalPostInteractions = async () => {
  if (!isPureReblog.value || !props.post.reblog?.id) return;
  
  // Check if interactions were pre-loaded by the store
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

onMounted(() => {
  // Check for reply context in post or reblog
  const inReplyTo = isPureReblog.value
    ? props.post.reblog?.in_reply_to
    : props.post.in_reply_to;
  const hasReplyContext = isPureReblog.value
    ? props.post.reblog?.reply_context
    : props.post.reply_context;
    
  if (inReplyTo && !hasReplyContext) {
    loadReplyContext();
  }

  // For pure reblogs, fetch the user's interaction state with the original post
  if (isPureReblog.value) {
    loadOriginalPostInteractions();
  }

});

// Interaction target id: pure reblogs unwrap to the boosted post; quote
// posts are favorited/reblogged/bookmarked as themselves.
const originalPostId = computed(() => {
  if (isPureReblog.value && props.post.reblog?.id) {
    return props.post.reblog.id;
  }
  return props.post.id;
});

const { isEmojiBlocked: isReactionEmojiBlocked, limitNotice: reactionLimitNotice } =
  usePostReactionLimit(originalPostId);

// The heart covers the caller's reactions: unfavouriting removes them too.
const ownReactionCount = computed(() =>
  ownPostReactions(postReactionsStore.getPostReactions(originalPostId.value) ?? []).length);

// The post that "Reply" should address. For *pure* reblogs we hand the
// original post to the Composer so the mention targets the original author
// and the reply is threaded under the original note (Mastodon/Pleroma/Misskey
// behavior). For quote posts and regular posts, the reply targets the post
// itself - quote posts are first-class user posts whose replies belong on
// them, not on the post they quote. The shared util encodes this rule so
// every reply call site agrees.
const replyTarget = computed<TimelinePost>(() => getOriginalPost(props.post));

// Reblogs: reactions belong to the ORIGINAL post
// Create a post-like object with the correct ID for PostReactions component
const displayPostForReactions = computed((): TimelinePost => {
  if (isPureReblog.value && props.post.reblog?.id) {
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
const repliesCountOverride = ref<number | null>(null)

// The optimistic bump holds only until the server count moves, and never
// outlives the post it counted.
watch(
  () => [
    props.post.id,
    (isPureReblog.value && props.post.reblog)
      ? props.post.reblog.replies_count
      : props.post.replies_count,
  ],
  () => { repliesCountOverride.value = null }
);

const displayInteractionCounts = computed(() => {
  const fav = favoriteOverride.value;

  if (isPureReblog.value && props.post.reblog) {
    const interactions = originalPostInteractions.value;
    return {
      favorites_count: fav?.favorites_count ?? props.post.reblog.favorites_count ?? 0,
      reblogs_count: props.post.reblog.reblogs_count || 0,
      replies_count: repliesCountOverride.value ?? props.post.reblog.replies_count ?? 0,
      is_favorited: fav?.is_favorited ?? interactions?.is_favorited ?? props.post.reblog.is_favorited ?? false,
      is_reblogged: interactions?.is_reblogged ?? props.post.reblog.is_reblogged ?? false,
      is_bookmarked: interactions?.is_bookmarked ?? props.post.reblog.is_bookmarked ?? false
    };
  }
  return {
    favorites_count: fav?.favorites_count ?? props.post.favorites_count ?? 0,
    reblogs_count: props.post.reblogs_count || 0,
    replies_count: repliesCountOverride.value ?? props.post.replies_count ?? 0,
    is_favorited: fav?.is_favorited ?? props.post.is_favorited ?? false,
    is_reblogged: props.post.is_reblogged || false,
    is_bookmarked: props.post.is_bookmarked || false
  };
});

// Focused-post counts: replies, then boosts and favourites as Mastodon orders them.
// Zero counts are left out.
const detailStats = computed(() => {
  const counts = displayInteractionCounts.value;
  return [
    { key: 'replies', count: counts.replies_count, label: 'activitypub.repliesLabel' },
    { key: 'boosts', count: counts.reblogs_count, label: 'activitypub.boostsLabel' },
    { key: 'favorites', count: counts.favorites_count, label: 'activitypub.favoritesLabel' },
  ].filter((stat) => stat.count > 0);
});

// Action glyph sizes in px. Ink measured at 18px with a 1.5px stroke: message-circle is a
// closed 16.6px bubble with a 230px² convex hull, repeat-2 an open 16.5x10.5px pair of
// arrows at 144px², heart 173px², bookmark 177px². Reply at 16 and boost at 20 come to
// 182 and 178px².
const ACTION_GLYPH = { reply: 16, reblog: 20, default: 18 } as const;

/** Lucide stroke width, in its 24-unit viewBox, that draws 1.5px at `size` px. */
const glyphStroke = (size: number) => (1.5 * 24) / size;

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
  const originalVisibility = props.post.reblog?.visibility || props.post.visibility;
  return originalVisibility === 'public' || originalVisibility === 'unlisted';
});

const reblogDisabledReason = computed(() => {
  if (canReblog.value) return '';
  const originalVisibility = props.post.reblog?.visibility || props.post.visibility;
  if (originalVisibility === 'followers') {
    return t('activitypub.boostDisabledFollowers');
  }
  if (originalVisibility === 'direct') {
    return t('activitypub.boostDisabledDirect');
  }
  return t('activitypub.boostDisabled');
});

const replyLabel = computed(() => t('activitypub.replyToUser', {
  name: displayAuthor.value?.display_name || displayAuthor.value?.username || '',
}));

const boostLabel = computed(() => {
  const counts = displayInteractionCounts.value;
  if (!canReblog.value && !counts.is_reblogged) return reblogDisabledReason.value;
  return counts.is_reblogged ? t('activitypub.undoBoost') : t('activitypub.boost');
});

const favoriteLabel = computed(() => {
  if (!displayInteractionCounts.value.is_favorited) return t('activitypub.favorite');
  const reactions = ownReactionCount.value;
  return reactions > 0 ? t('activitypub.unfavoriteWithReactions', reactions) : t('activitypub.unfavorite');
});

const bookmarkLabel = computed(() =>
  displayInteractionCounts.value.is_bookmarked ? t('activitypub.removeBookmark') : t('activitypub.bookmark'));

const currentLocale = () => {
  const loc = (i18n as { locale?: { value?: string } }).locale?.value;
  return typeof loc === 'string' && loc ? loc : 'en';
};

const formatRelativeTime = (dateString: string) =>
  formatShortRelativeTime(dateString, { locale: currentLocale(), nowLabel: t('activitypub.now') });

const formatFullDate = (dateString: string) => formatFullDateTime(dateString, currentLocale());

const formatCount = (count: number) => {
  if (count < 1000) return count.toString();
  if (count < 10000) return (count / 1000).toFixed(1) + 'K';
  if (count < 1000000) return Math.floor(count / 1000) + 'K';
  return (count / 1000000).toFixed(1) + 'M';
};

const onReply = () => {
  showInlineReply.value = !showInlineReply.value;
  // Replies are handled inline; nothing is emitted to the parent.
};

const handleReplySent = (reply: any) => {
  debug.log('Reply sent:', reply);
  showInlineReply.value = false;
  // Bump reply count optimistically (displayInteractionCounts reads the override).
  repliesCountOverride.value = displayInteractionCounts.value.replies_count + 1;
  // Notify containers (e.g. PostView thread) so they can append the reply
  // without waiting for a reload. Threads under the *original* post id so
  // reblog wrappers attribute the reply to the correct note.
  if (reply) {
    emit('reply-created', reply as TimelinePost, replyTarget.value.id);
  }
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
    // Audio fires before the network round-trip.
    try {
      await themeStore.playAudio('reaction');
    } catch (audioError) {
      debug.warn('Failed to play reaction audio:', audioError);
      // Don't block the reaction if audio fails
    }
    
    // ❤ is the favourite, not a chip. On a heart only reactions filled it makes the
    // favourite explicit, as add_post_emoji_reaction does; otherwise it toggles the heart.
    if (isHeartEmoji(emoji)) {
      closeEmojiPopup();
      if (await keepImpliedFavourite()) return;
      await handleToggleFavorite();
      return;
    }

    // Use the PostReactions composable instead of direct Supabase calls
    if (postReactionsRef.value?.handleEmojiSelected) {
      const success = await postReactionsRef.value.handleEmojiSelected(emoji);
      if (success) {
        debug.log(`Added emoji reaction ${emoji.name} to post ${props.post.id}`);
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
        debug.log(`Added emoji reaction ${emoji.name} to post ${props.post.id}`);
        closeEmojiPopup();
        if (postReactionsRef.value) {
          await (postReactionsRef.value as any).loadReactions?.();
        }
        await handleReactionsChanged({ added: true });
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

const formatRemoteHandle = (username: string | undefined, domain: string | undefined): string => {
  if (!username) return '';
  const d = formatDomain(domain);
  return d ? `@${username}@${d}` : `@${username}`;
};

/**
 * Render a display name with custom emojis as HTML
 * Replaces :emoji: patterns with <img> tags
 */
// eslint-disable-next-line unused-imports/no-unused-vars
const renderDisplayNameWithEmojis = (displayName: string, emojis?: Array<{name: string, url: string}>): string => {
  if (!displayName) return '';
  if (!emojis || emojis.length === 0) return escapeHtml(displayName);
  
  const emojiMap = new Map<string, string>();
  for (const e of emojis) {
    if (!e.name || !e.url) continue;
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
  
  debug.log('Reaction tooltip data:', {
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
    debug.log('Remote reactor:', reactor);
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
      handle: formatRemoteHandle(reactor.username, reactor.domain),
    };
  });
  
  // Combine local and remote users
  const usersDetails = [...localUsers, ...remoteUsers];
  
  const anchor = getReactionTooltipAnchor(event);

  // Show tooltip after a delay
  tooltipTimer.value = setTimeout(() => {
    tooltip.value = { 
      visible: true, 
      content: usersDetails, 
      x: anchor.x, 
      y: anchor.y, 
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

// Mastodon-style: delete the post and reopen the composer prefilled with
// its content so the author can fix and repost.
const onDeleteAndRedraft = async () => {
  closeMenu();
  if (isDeleting.value) return;
  const confirmed = await confirm({
    title: 'Delete and redraft',
    message: 'Delete this post and move its content back into the composer? Favorites and boosts on it are lost.',
    confirmButtonText: 'Delete and redraft',
    dangerAction: true,
  });
  if (!confirmed) return;

  try {
    isDeleting.value = true;
    const draftText = messagePartsToRawText(props.post.content as any);
    const draft = {
      content: draftText,
      visibility: props.post.visibility || 'public',
      contentWarning: props.post.content_warning || undefined,
      sensitive: !!props.post.is_sensitive,
    };
    await activityPubStore.deletePost(props.post.id);
    activityPubStore.openComposer(draft);
  } catch (error: any) {
    debug.error('Failed to delete & re-draft:', error);
    toast.error(error?.message || 'Failed to delete post');
  } finally {
    isDeleting.value = false;
  }
};

const isAuthorMuted = computed(() => {
  const id = displayAuthor.value?.id;
  return id ? activityPubStore.mutedUsers.has(id) : false;
});

const onMuteAuthor = async () => {
  closeMenu();
  const author = displayAuthor.value;
  if (!author?.id) return;
  try {
    if (isAuthorMuted.value) {
      await activityPubStore.unmuteUser(author.id);
      toast.success(`Unmuted @${author.username}`);
    } else {
      await activityPubStore.muteUser(author.id);
      toast.success(`Muted @${author.username} - their posts are hidden from your feeds`);
    }
  } catch (error: any) {
    toast.error(error?.message || 'Failed to update mute');
  }
};

const onBlockAuthor = async () => {
  closeMenu();
  const author = displayAuthor.value;
  if (!author?.id) return;
  const confirmed = await confirm({
    title: `Block @${author.username}?`,
    message: 'They won\'t be able to follow you or see your posts, and you won\'t see theirs.',
    confirmButtonText: 'Block',
    dangerAction: true,
  });
  if (!confirmed) return;
  try {
    await activityPubStore.blockUser(author.id);
    toast.success(`Blocked @${author.username}`);
  } catch (error: any) {
    toast.error(error?.message || 'Failed to block user');
  }
};

const onUndoReblog = async () => {
  closeMenu();
  
  try {
    const originalPostId = props.post.reblog?.id || props.post.metadata?.reblog_of;
    
    if (originalPostId) {
      // Use toggleReblog which handles the undo
      await toggleReblog(originalPostId);
      
      notificationStore.showToast(
        'server_update',
        t('activitypub.boostRemoved'),
        '',
        3000
      );
    }
  } catch (error) {
    debug.error('Failed to undo reblog:', error);
    notificationStore.showToast(
      'error',
      t('activitypub.boostRemoveFailed'),
      '',
      5000
    );
  }
};

const handleDeleteConfirm = async () => {
  if (isDeleting.value) return;
  
  try {
    isDeleting.value = true;
    showDeleteConfirmation.value = false;
    
    await activityPubStore.deletePost(props.post.id);
    
    notificationStore.showToast(
      'server_update',
      'Post deleted',
      'Your post was deleted',
      3000
    );
    
    debug.log('Post successfully deleted:', props.post.id);
    
  } catch (error) {
    debug.error('Failed to delete post:', error);
    
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

const handleDeleteCancel = () => {
  showDeleteConfirmation.value = false;
};

const showReplyTarget = async () => {
  if (displayReplyContext.value) {
    try {
      const navigationData = await ConversationService.getConversationNavigationData(props.post.id, {
        highlightPost: props.post.id
      });
      
      if (navigationData.success && navigationData.route) {
        await router.push(navigationData.route);
      } else {
        debug.error('Failed to get conversation navigation data:', navigationData.error);
        
        // Use fallback route
        await router.push(navigationData.fallbackRoute);
      }
      
    } catch (error) {
      debug.error('Failed to navigate to conversation:', error);
      
      // Fallback: emit the event as before
      emit('show-conversation', props.post.id);
    }
  } else {
    debug.warn('No reply context found for post:', props.post.id);
  }
};

const copyLink = async () => {
  try {
    const url = props.post.url || `${resolveHarmonyBaseUrl()}/posts/${props.post.id}`;
    await navigator.clipboard.writeText(url);
    toast.success('Link copied');
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

  const targetPost = isPureReblog.value ? props.post.reblog : props.post
  const wasFavorited = displayInteractionCounts.value.is_favorited
  const prevCount = displayInteractionCounts.value.favorites_count

  favoriteOverride.value = {
    is_favorited: !wasFavorited,
    favorites_count: Math.max(0, prevCount + (wasFavorited ? -1 : 1))
  }
  // Deleting the favourite deletes the caller's reactions (trg_favourite_follows_reactions).
  if (wasFavorited) postReactionsStore.dropOwnReactions(postId)

  const result = await toggleFavorite(postId)

  if (result.success) {
    favoriteOverride.value = {
      is_favorited: result.liked!,
      favorites_count: result.newCount ?? favoriteOverride.value.favorites_count
    }
  } else {
    favoriteOverride.value = null
  }
  if (wasFavorited) void postReactionsStore.fetchPostReactions(postId, true)

  // Also update the reblog interaction ref so it stays in sync
  if (isPureReblog.value && originalPostInteractions.value) {
    originalPostInteractions.value = {
      ...originalPostInteractions.value,
      is_favorited: favoriteOverride.value?.is_favorited ?? wasFavorited
    }
  }
}

/** True when the caller's favourite was implied by reactions and is now explicit. */
const keepImpliedFavourite = async (): Promise<boolean> => {
  const postId = originalPostId.value;
  if (!postId || !displayInteractionCounts.value.is_favorited) return false;
  try {
    const state = await services.posts.getFavouriteState(postId);
    if (!state.favorited || !state.implied) return false;
    await services.posts.keepFavourite(postId);
    favoriteOverride.value = { is_favorited: true, favorites_count: state.count };
    return true;
  } catch (error) {
    debug.warn('Failed to keep the favourite:', error);
    return true;
  }
};

/**
 * A reaction implies the caller's favourite and the last one's removal takes an implied
 * favourite with it (trg_reaction_implies_favourite), so the heart is read back.
 */
const handleReactionsChanged = async ({ added }: { added: boolean }) => {
  const postId = originalPostId.value;
  if (!postId) return;

  const counts = displayInteractionCounts.value;
  if (added && !counts.is_favorited) {
    favoriteOverride.value = { is_favorited: true, favorites_count: counts.favorites_count + 1 };
  }

  try {
    const state = await services.posts.getFavouriteState(postId);
    favoriteOverride.value = { is_favorited: state.favorited, favorites_count: state.count };
    activityPubStore.updatePostInteractionInAllFeeds(postId, 'favorite', state.favorited);
  } catch (error) {
    debug.warn('Failed to read the favourite back after a reaction:', error);
  }

  if (isPureReblog.value && originalPostInteractions.value && favoriteOverride.value) {
    originalPostInteractions.value = {
      ...originalPostInteractions.value,
      is_favorited: favoriteOverride.value.is_favorited
    }
  }
};

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
  // Pure reblogs unwrap so the quote references the boosted note; quoting
  // a quote post references the quote itself.
  const originalPost = isPureReblog.value ? (props.post.reblog || props.post) : props.post;
  const originalAuthor = isPureReblog.value
    ? (props.post.reblog_author || props.post.author)
    : props.post.author;
  activityPubStore.openComposer({
    quotePost: originalPost,
    quoteAuthor: originalAuthor,
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
    if (isPureReblog.value && props.post.reblog) {
      // eslint-disable-next-line vue/no-mutating-props -- store-shared ref, see above
      props.post.reblog.is_sensitive = newVal;
    }
    notificationStore.showToast('server_update', 'Post updated', newVal ? 'Post marked as sensitive.' : 'Post unmarked as sensitive.', 3000);
  } catch (error: any) {
    notificationStore.showToast('server_update', 'Failed', error.message || 'Could not update post.', 5000);
  }
};

const handleAdminSetCW = async () => {
  showMenu.value = false;
  const postId = originalPostId.value;
  const existingCw = (isPureReblog.value && props.post.reblog?.content_warning) || props.post.content_warning || '';
  const cw = await prompt({
    title: 'Content warning',
    message: 'Leave empty to remove the content warning.',
    label: 'Content warning text',
    initialValue: existingCw,
    confirmButtonText: 'Save',
  });
  if (cw === null) return;
  try {
    if (cw.trim()) {
      await adminService.moderatePost(postId, 'set_cw', cw.trim());
      activityPubStore.updatePostFieldInAllFeeds(postId, 'content_warning', cw.trim());
      if (isPureReblog.value && props.post.reblog) {
        // eslint-disable-next-line vue/no-mutating-props -- store-shared ref, see above
        props.post.reblog.content_warning = cw.trim();
      }
      notificationStore.showToast('server_update', 'Content warning set', '', 3000);
    } else {
      await adminService.moderatePost(postId, 'remove_cw');
      activityPubStore.updatePostFieldInAllFeeds(postId, 'content_warning', null);
      if (isPureReblog.value && props.post.reblog) {
        // eslint-disable-next-line vue/no-mutating-props -- store-shared ref, see above
        props.post.reblog.content_warning = null;
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
  if (!(await confirm({ title: 'Delete post (admin)', message: 'Delete this post as admin? This cannot be undone.', confirmButtonText: 'Delete', dangerAction: true }))) return;
  try {
    await adminService.moderatePost(postId, 'delete');
    activityPubStore.updatePostFieldInAllFeeds(postId, 'is_deleted', true);
    notificationStore.showToast('server_update', 'Post deleted', 'Post has been removed by admin.', 3000);
  } catch (error: any) {
    notificationStore.showToast('server_update', 'Failed', error.message || 'Could not delete post.', 5000);
  }
};

const handleShowEmojiPickerForOriginal = () => {
  const targetPost: any = isPureReblog.value && props.post.reblog
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
  background: transparent;
  border-bottom: 1px solid var(--border-color);
  transition: background-color var(--transition-fast);
}

.mony-post:hover {
  background-color: var(--background-modifier-hover);
}

.mony-post.is-detailed:hover {
  background-color: transparent;
}

/* Boost / pinned line above the header. Starts at the avatar's left edge, where the post
   body starts: the body is not indented under the name. */
.post-prepend {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4) 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.3;
  min-width: 0;
}

.prepend-icon {
  flex-shrink: 0;
}

.prepend-author {
  color: var(--text-secondary);
  font-weight: var(--font-weight-semibold);
  text-decoration: none;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prepend-author:hover {
  text-decoration: underline;
}

.post-content {
  padding: var(--space-3) var(--space-4);
}

.post-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-2);
}

.author-info {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  flex: 1;
  color: inherit;
  text-decoration: none;
}

.author-details {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.author-name {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
}

.author-name > :first-child {
  overflow: hidden;
  text-overflow: ellipsis;
}

.author-info:hover .author-name > :first-child {
  text-decoration: underline;
}

.instance-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.02em;
  line-height: 1.4;
}

.author-handle {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.post-meta {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.3;
  padding-top: 2px;
}

.post-time {
  color: var(--text-secondary);
  text-decoration: none;
  white-space: nowrap;
}

.post-time:hover {
  text-decoration: underline;
}

/* The timestamp is the post's only link to its detail view; on touch screens
   its hit area grows to about 40px square without moving the layout. */
@media (pointer: coarse) {
  .post-time {
    position: relative;
  }

  .post-time::after {
    content: '';
    position: absolute;
    inset: -11px -12px;
  }
}

.visibility-indicator {
  display: inline-flex;
  align-items: center;
  color: var(--text-muted);
}

.edited-indicator {
  color: var(--text-muted);
  cursor: default;
}

/* Reply line */
.reply-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-bottom: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.4;
}

.reply-line-icon {
  flex-shrink: 0;
}

.reply-author-link {
  color: var(--harmony-primary);
  text-decoration: none;
  overflow-wrap: anywhere;
}

.reply-author-link:hover,
.text-link:hover {
  text-decoration: underline;
}

.text-link {
  padding: 0;
  border: none;
  background: none;
  color: var(--harmony-primary);
  font: inherit;
  cursor: pointer;
}

/* Content warning */
.content-warning {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.cw-text {
  margin: 0;
  color: var(--text-primary);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.cw-toggle {
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.cw-toggle:hover {
  background: var(--background-modifier-hover);
}

.post-body {
  margin-bottom: var(--space-2);
}

.post-text {
  color: var(--text-primary);
  line-height: 1.5;
  overflow-wrap: anywhere;
  user-select: text;
  -webkit-user-select: text;
}

.mony-post.is-detailed .post-text {
  font-size: 1.0625rem;
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

.post-link-preview {
  display: block;
  text-decoration: none;
  margin-top: var(--space-3);
  border-radius: var(--radius-lg);
  overflow: hidden;
  border: 1px solid var(--border-color);
  transition: border-color var(--transition-fast);
}

.post-link-preview:hover {
  border-color: var(--border-hover);
}

/* Caption under an inline rich embed (YouTube iframe) */
.post-link-preview--compact {
  margin-top: var(--space-1);
  border-radius: var(--radius-md);
}

/* Focused post */
.detail-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-3);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.detail-time {
  color: var(--text-secondary);
  text-decoration: none;
}

.detail-time:hover {
  text-decoration: underline;
}

.detail-stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-3) 0;
  border-top: 1px solid var(--border-color);
  border-bottom: 1px solid var(--border-color);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.detail-stats strong {
  color: var(--text-primary);
  font-weight: var(--font-weight-bold);
}

.detail-stats-separator {
  color: var(--text-muted);
}

/* Action bar */
.post-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 440px;
  margin-left: calc(var(--space-2) * -1);
  position: relative;
}

.mony-post.is-detailed .post-actions {
  max-width: none;
  justify-content: space-around;
  margin: var(--space-1) 0 0;
}

.action-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  min-width: 36px;
  height: 36px;
  padding: 0 var(--space-2);
  background: none;
  border: none;
  border-radius: var(--radius-full);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: color var(--transition-fast), background-color var(--transition-fast);
}

.action-count {
  font-variant-numeric: tabular-nums;
}

/* Every glyph centres in the same 20px slot, so counts start at one offset whatever the
   glyph's size. */
.action-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
}

.action-button:hover {
  color: var(--text-primary);
  background-color: var(--background-modifier-hover);
}

.action-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.reply-button:hover {
  color: var(--harmony-primary);
  background-color: var(--harmony-primary-alpha);
}

.reblog-button:hover:not(:disabled),
.reblog-button.active {
  color: var(--success);
}

.reblog-button:hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--success) 12%, transparent);
}

.favorite-button:hover,
.favorite-button.active {
  color: var(--error);
}

.favorite-button:hover {
  background-color: color-mix(in srgb, var(--error) 12%, transparent);
}

.bookmark-button:hover,
.bookmark-button.active {
  color: var(--warning);
}

.bookmark-button:hover {
  background-color: color-mix(in srgb, var(--warning) 12%, transparent);
}

.mony-post :is(a, button):focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.mony-post .action-button:focus-visible {
  border-radius: var(--radius-full);
}

/* Boost dropdown */
.reblog-menu-container {
  position: relative;
}

.reblog-dropdown {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  background: var(--background-floating, var(--background-primary));
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-medium);
  padding: var(--space-1);
  min-width: 140px;
  z-index: 100;
  margin-bottom: var(--space-2);
}

.reblog-option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.reblog-option:hover:not(:disabled) {
  background: var(--background-modifier-hover);
}

.reblog-option:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-menu {
  position: relative;
}

/* Dropdown styles use :global() because the dropdown is Teleported to <body> */
:global(.action-dropdown) {
  position: fixed;
  background-color: var(--background-floating, var(--background-primary));
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  padding: var(--space-1);
  min-width: 180px;
  box-shadow: var(--shadow-large);
  z-index: 9999;
}

:global(.action-dropdown .dropdown-item) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: none;
  border: none;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
}

:global(.action-dropdown .dropdown-item:hover) {
  background-color: var(--background-modifier-hover);
}

:global(.action-dropdown .dropdown-item:focus-visible) {
  outline: 2px solid var(--harmony-primary);
  outline-offset: -2px;
}

:global(.action-dropdown .dropdown-item.danger) {
  color: var(--error);
}

:global(.action-dropdown .dropdown-item.danger:hover) {
  background-color: color-mix(in srgb, var(--error) 12%, transparent);
}

:global(.action-dropdown .dropdown-divider) {
  height: 1px;
  background: var(--border-color);
  margin: var(--space-1) 0;
}

:global(.action-dropdown .loading-item) {
  color: var(--text-secondary);
  cursor: wait;
}

:global(.action-dropdown .loading-item .spinning) {
  animation: monypost-spin 1s linear infinite;
}

@keyframes monypost-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Unhydrated boost (remote boost without loaded content) */
.unhydrated-reblog {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
}

.unhydrated-reblog-notice {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.reblog-reference-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--harmony-primary);
  text-decoration: none;
  font-size: var(--font-size-sm);
  width: fit-content;
}

.reblog-reference-link:hover {
  text-decoration: underline;
}

/* Quote post */
.quote-post-layout {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.quote-comment {
  color: var(--text-primary);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.quoted-post {
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  padding: var(--space-3);
}

.quoted-post-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  min-width: 0;
}

.quoted-author-info {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--font-size-sm);
  white-space: nowrap;
  overflow: hidden;
}

.quoted-author-name {
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.quoted-author-handle {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
}

.quoted-post-time {
  color: var(--text-secondary);
}

.quoted-post-content {
  color: var(--text-primary);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

/* Mobile */
@media (max-width: 768px) {
  .post-content {
    padding: var(--space-3);
  }

  .post-prepend {
    padding: var(--space-3) var(--space-3) 0;
  }

  .author-info {
    gap: var(--space-2);
  }

  .post-actions {
    max-width: none;
  }

  .action-button {
    min-width: 40px;
    height: 40px;
    justify-content: center;
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
  max-width: 300px;
  box-shadow: var(--shadow-large);
  pointer-events: none;
  transform: translate(-50%, calc(-100% - 8px));
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
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-1) 0;
  font-size: var(--font-size-sm);
  color: var(--tooltip-text, var(--text-secondary));
  opacity: 0.95;
}

.tooltip-avatar {
  flex-shrink: 0;
}

.tooltip-user-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.tooltip-username {
  color: var(--tooltip-text, var(--text-primary));
  overflow-wrap: anywhere;
  line-height: 1.3;
}

.tooltip-domain {
  color: var(--tooltip-text, var(--text-muted));
  font-size: var(--font-size-xs);
  opacity: 0.75;
  line-height: 1.2;
}
</style>
