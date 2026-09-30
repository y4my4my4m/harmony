<template>
  <div 
    class="notification-item"
    data-testid="notification-item"
    :class="[
      `notification-item--${notification.type}`,
      {
        'notification-item--unread': !notification.is_read,
        'notification-item--clickable': isClickable,
        'notification-item--hovering': isHovering
      }
    ]"
    @click="handleClick"
    @mouseenter="isHovering = true"
    @mouseleave="isHovering = false"
    :tabindex="isClickable ? 0 : -1"
    @keydown.enter="handleClick"
    @keydown.space.prevent="handleClick"
  >
    <!-- Visual Indicator Bar -->
    <div class="notification-indicator" :class="`indicator--${notification.type}`"></div>
    
    <!-- Avatar Section -->
    <div class="notification-avatar">
      <div class="avatar-container">
        <Avatar
          :src="avatarUrl"
          :alt="`${username || 'User'} avatar`"
          size="md"
          class="avatar-image"
        />
        
        <!-- Type Icon Overlay -->
        <div class="type-icon-overlay" :class="`overlay--${notification.type}`">
          <component :is="typeIcon" class="type-icon" />
        </div>
      </div>
    </div>
    
    <!-- Content Section -->
    <div class="notification-content">
      <!-- Header -->
      <div class="notification-header">
        <div class="notification-title-section">
          <h4 class="notification-title">
            <template v-if="usesActorHeaderLayout">
              <DisplayName
                v-if="actorUserId"
                :user-id="actorUserId"
                :fallback="actorDisplayNameFallback"
                class="notification-actor-name"
              />
              <template v-else>{{ actorDisplayNameFallback }}</template>

              <template v-if="isReactionNotification">
                <span> reacted </span>
                <img
                  v-if="reactionEmoji?.url"
                  :src="reactionEmoji.url"
                  :alt="reactionEmoji.name"
                  :title="reactionEmoji.name ? `:${reactionEmoji.name}:` : ''"
                  class="notification-title-emoji"
                />
                <span
                  v-else-if="reactionEmoji?.unicode"
                  class="notification-title-emoji-fallback"
                >{{ reactionEmoji.unicode }}</span>
                <span
                  v-else-if="reactionEmoji?.name"
                  class="notification-title-emoji-fallback"
                >{{ reactionEmoji.name }}</span>
                <span>{{ reactionTitleSuffix }}</span>
              </template>
              <span v-else>{{ titleAction }}</span>
            </template>
            <template v-else>
              {{ formattedMessage.title }}
            </template>
          </h4>
          <div class="notification-metadata">
            <template v-if="usesActorHeaderLayout">
              <span v-if="actorHandle" class="actor-handle">{{ actorHandle }}</span>
              <span v-if="actorHandle" class="separator">•</span>
              <span class="timestamp" :title="fullTimestamp">{{ relativeTime }}</span>
            </template>
            <template v-else>
              <span class="timestamp" :title="fullTimestamp">{{ relativeTime }}</span>
              <template v-if="serverName">
                <span class="separator">•</span>
                <span class="server-name">{{ serverName }}</span>
              </template>
            </template>
          </div>
        </div>
        
        <!-- Actions -->
        <div class="notification-actions" @click.stop>
          <!-- Mark as Read/Unread -->
          <button 
            @click="toggleRead"
            class="action-btn read-toggle"
            :class="{ active: !notification.is_read }"
            :title="notification.is_read ? 'Mark as unread' : 'Mark as read'"
            :aria-label="notification.is_read ? 'Mark as unread' : 'Mark as read'"
          >
            <UnreadIcon v-if="notification.is_read" class="action-icon" />
            <MarkReadIcon v-else class="action-icon" />
          </button>
          
          <!-- Dismiss -->
          <button 
            @click="handleDismiss"
            class="action-btn dismiss-btn"
            title="Dismiss notification"
            aria-label="Dismiss notification"
          >
            <DismissIcon class="action-icon" />
          </button>
        </div>
      </div>
      
      <!-- Message Content -->
      <div class="notification-message">
        <!-- Rich Content for certain types -->
        <div v-if="hasRichContent" class="rich-content">
          <!-- Message Preview for mentions/replies -->
          <div v-if="messagePreview" class="message-preview">
            <p class="preview-line">
              <span class="preview-marker" aria-hidden="true">&gt;</span>
              <span class="preview-text">{{ messagePreview }}</span>
            </p>
          </div>
          
          <!-- Reaction Display - Show emoji inline in title, not here -->
          <!-- The emoji is already shown in the notification title -->
        </div>
      </div>
      
      <!-- Quick Actions for specific types -->
      <div v-if="hasQuickActions" class="quick-actions" @click.stop>
        <!-- For server invites -->
        <template v-if="notification.type === 'server_invite'">
          <button @click="acceptInvite" class="quick-action-btn accept">
            <AcceptIcon class="quick-action-icon" />
            Join server
          </button>
          <button @click="declineInvite" class="quick-action-btn decline">
            <DeclineIcon class="quick-action-icon" />
            Decline
          </button>
        </template>
        
        <!-- For follow requests -->
        <template v-if="notification.type === 'activitypub_follow_request'">
          <button @click="acceptFollowRequest" :disabled="isProcessingFollowRequest" class="quick-action-btn accept">
            <AcceptIcon class="quick-action-icon" />
            Accept
          </button>
          <button @click="rejectFollowRequest" :disabled="isProcessingFollowRequest" class="quick-action-btn decline">
            <DeclineIcon class="quick-action-icon" />
            Reject
          </button>
        </template>

        <!-- For DMs / group chat messages -->
        <template v-if="notification.type === 'dm' || notification.type === 'chat_message'">
          <button @click="replyToDM" class="quick-action-btn reply">
            <ReplyIcon class="quick-action-icon" />
            Reply
          </button>
        </template>
        
        <!-- For mentions/replies -->
        <template v-if="notification.type === 'mention' || notification.type === 'reply'">
          <button @click="jumpToMessage" class="quick-action-btn jump">
            <JumpIcon class="quick-action-icon" />
            Jump to message
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, defineAsyncComponent } from 'vue'
import { debug } from '@/utils/debug'
import { useRouter } from 'vue-router'
import { NotificationFormatter } from '@/services/NotificationFormatter'
import type { Notification } from '@/types'
import { getEmojiUrl } from '@/utils/emojiUtils'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'

// Icons - using dynamic imports for better performance
const MarkReadIcon = defineAsyncComponent(() => import('@/components/icons/MarkReadIcon.vue'))
const UnreadIcon = defineAsyncComponent(() => import('@/components/icons/UnreadIcon.vue'))
const DismissIcon = defineAsyncComponent(() => import('@/components/icons/DismissIcon.vue'))
const AcceptIcon = defineAsyncComponent(() => import('@/components/icons/AcceptIcon.vue'))
const DeclineIcon = defineAsyncComponent(() => import('@/components/icons/DeclineIcon.vue'))
const ReplyIcon = defineAsyncComponent(() => import('@/components/icons/Reply.vue'))
const JumpIcon = defineAsyncComponent(() => import('@/components/icons/JumpIcon.vue'))

// Type icons
const MentionIcon = defineAsyncComponent(() => import('@/components/icons/MentionIcon.vue'))
const DMIcon = defineAsyncComponent(() => import('@/components/icons/DMIcon.vue'))
const ReactionIcon = defineAsyncComponent(() => import('@/components/icons/Reaction.vue'))
const ServerInviteIcon = defineAsyncComponent(() => import('@/components/icons/ServerInviteIcon.vue'))
const VoiceIcon = defineAsyncComponent(() => import('@/components/icons/VoiceIcon.vue'))
const EmojiIcon = defineAsyncComponent(() => import('@/components/icons/EmojiIcon.vue'))

interface Props {
  notification: Notification
}

interface Emits {
  (e: 'click', notification: Notification): void
  (e: 'mark-read', notificationId: string): void
  (e: 'dismiss', notificationId: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()
const router = useRouter()

const ACTOR_HEADER_TYPES = new Set([
  'dm',
  'chat_message',
  'mention',
  'reply',
  'reaction',
  'thread_reply',
  'activitypub_mention',
  'activitypub_reply',
  'activitypub_reaction',
  'activitypub_favorite',
  'activitypub_reblog',
])

// State
const isHovering = ref(false)

// Use NotificationFormatter for all message formatting
const formattedMessage = computed(() => 
  NotificationFormatter.formatNotification(props.notification)
)

const username = computed(() =>
  NotificationFormatter.getUsername(props.notification)
)

const usesActorHeaderLayout = computed(() =>
  ACTOR_HEADER_TYPES.has(props.notification.type)
)

const isReactionNotification = computed(() =>
  props.notification.type === 'reaction' || props.notification.type === 'activitypub_reaction'
)

const titleAction = computed(() =>
  NotificationFormatter.getTitleAction(props.notification)
)

const reactionTitleSuffix = computed(() =>
  props.notification.type === 'activitypub_reaction'
    ? ' to your post'
    : ' to your message'
)

const actorDisplayNameFallback = computed(() =>
  NotificationFormatter.getActorDisplayNameFallback(props.notification)
)

// Actor profile id when available (for DisplayName so custom emojis render)
const actorUserId = computed(() => {
  const data = props.notification.data
  if (!data) return null
  const actor = data.sender || data.actor || data.reactor || data.author || data.user || data.follower
  const id =
    data.from_user_id ??
    actor?.user_id ??
    actor?.id ??
    data.inviter?.user_id
  return id && typeof id === 'string' ? id : null
})

const actorHandle = computed(() =>
  NotificationFormatter.getActorHandle(props.notification)
)

const avatarUrl = computed(() => 
  NotificationFormatter.getAvatarUrl(props.notification)
)

const serverName = computed(() => 
  NotificationFormatter.getServerName(props.notification)
)

const _channelName = computed(() => 
  NotificationFormatter.getChannelName(props.notification)
)

const isClickable = computed(() => 
  NotificationFormatter.isClickable(props.notification)
)

const extractMessagePartText = (content: any): string | null => {
  if (!content) return null

  if (typeof content === 'string') {
    if (content.startsWith('[')) {
      try { content = JSON.parse(content) } catch { return content }
    } else {
      return content
    }
  }

  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (part.type === 'text') return part.text
        if (part.type === 'mention') return `@${part.username}${part.domain ? '@' + part.domain : ''}`
        if (part.type === 'emoji') return `:${part.emoji?.name || part.emoji}:`
        if (part.type === 'hashtag') return `#${part.name}`
        if (part.type === 'url') return part.url
        return ''
      })
      .join(' ')
      .trim() || null
  }

  if (typeof content === 'object') return null
  return String(content)
}

const truncatePreview = (text: string | null, maxLen = 100): string | null => {
  if (!text) return null
  return text.length > maxLen ? text.substring(0, maxLen) + '...' : text
}

// Rich content computed properties
const messagePreview = computed(() => {
  const data = props.notification.data

  // For report updates, show the resolution note / full message (so "Note: ..." is visible)
  if (props.notification.type === 'report_update') {
    const msg = formattedMessage.value.message
    return msg ? truncatePreview(msg, 200) : null
  }
  
  // For chat reactions, show the message preview (what they reacted to)
  if (props.notification.type === 'reaction') {
    const preview = extractMessagePartText(data.message_preview)
      || extractMessagePartText(data.message?.content_preview)
    return truncatePreview(preview)
  }

  // For ActivityPub reactions/favorites/reblogs, show the post preview
  if (['activitypub_reaction', 'activitypub_favorite', 'activitypub_reblog'].includes(props.notification.type)) {
    const preview = extractMessagePartText(data.post?.content_preview)
      || extractMessagePartText(data.post_content)
      || extractMessagePartText(data.post?.content)
    return truncatePreview(preview)
  }
  
  // For ActivityPub mentions, check post structure
  if (props.notification.type === 'activitypub_mention') {
    const preview = extractMessagePartText(data.post?.content_preview)
      || extractMessagePartText(data.post_content)
      || extractMessagePartText(data.post?.content)
    return truncatePreview(preview)
  }
  
  // For chat mentions/DMs, prioritize structured message.content_preview
  const preview = extractMessagePartText(data.message?.content_preview)
    || extractMessagePartText(data.preview || data.content_preview)
    || extractMessagePartText(data.message?.content || data.content)
  
  return truncatePreview(preview)
})

const reactionEmoji = computed(() => {
  if (!isReactionNotification.value) return null

  const data = props.notification.data
  const reactionData = data.reaction || data
  const emojiUrl = reactionData?.emoji_url || data.emoji_url
  const rawName =
    reactionData?.emoji_name ||
    reactionData?.custom_emoji_content ||
    data.emoji_name ||
    '👍'

  if (emojiUrl) {
    return {
      name: rawName,
      url: getEmojiUrl(emojiUrl, 48),
      unicode: null as string | null,
    }
  }

  // Unicode or shortcode-only reaction (common on federated posts)
  const trimmed = String(rawName).trim()
  if (/^:[\w+-]+:$/.test(trimmed)) {
    return { name: trimmed.slice(1, -1), url: null, unicode: null }
  }
  if (trimmed.length <= 8 && /\p{Extended_Pictographic}/u.test(trimmed)) {
    return { name: trimmed, url: null, unicode: trimmed }
  }

  return { name: trimmed, url: null, unicode: null }
})

const relativeTime = computed(() => {
  const now = new Date()
  const created = new Date(props.notification.created_at)
  const diffMs = now.getTime() - created.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return 'now'
  if (diffMins < 60) return `${diffMins}m`
  if (diffHours < 24) return `${diffHours}h`
  if (diffDays < 7) return `${diffDays}d`
  
  return created.toLocaleDateString(undefined, { 
    month: 'short', 
    day: 'numeric' 
  })
})

const fullTimestamp = computed(() => {
  return new Date(props.notification.created_at).toLocaleString()
})

const hasRichContent = computed(() => {
  return !!messagePreview.value
})

// Check if this notification should show reaction display
// eslint-disable-next-line unused-imports/no-unused-vars
const shouldShowReactionDisplay = computed(() => {
  return props.notification.type === 'reaction' || props.notification.type === 'activitypub_reaction'
})

const hasQuickActions = computed(() => {
  return ['server_invite', 'dm', 'chat_message', 'mention', 'reply', 'activitypub_follow_request'].includes(props.notification.type)
})

// Methods
const handleClick = () => {
  if (isClickable.value) {
    emit('click', props.notification)
  }
}

const toggleRead = () => {
  emit('mark-read', props.notification.id)
}

const handleDismiss = () => {
  emit('dismiss', props.notification.id)
}
// Quick action handlers using NotificationFormatter navigation data
const acceptInvite = () => {
  debug.log('Accepting server invite:', props.notification.data?.invite_id)
  emit('dismiss', props.notification.id)
}

const declineInvite = () => {
  debug.log('Declining server invite:', props.notification.data?.invite_id)
  emit('dismiss', props.notification.id)
}

const isProcessingFollowRequest = ref(false)

const acceptFollowRequest = async () => {
  const followerId = props.notification.data?.follower?.id || props.notification.data?.follower_id
  if (!followerId || isProcessingFollowRequest.value) return
  isProcessingFollowRequest.value = true
  try {
    const { interactionService } = await import('@/services/InteractionService')
    await interactionService.acceptFollowRequest(followerId)
    emit('dismiss', props.notification.id)
  } catch (error) {
    debug.error('Failed to accept follow request:', error)
  } finally {
    isProcessingFollowRequest.value = false
  }
}

const rejectFollowRequest = async () => {
  const followerId = props.notification.data?.follower?.id || props.notification.data?.follower_id
  if (!followerId || isProcessingFollowRequest.value) return
  isProcessingFollowRequest.value = true
  try {
    const { interactionService } = await import('@/services/InteractionService')
    await interactionService.rejectFollowRequest(followerId)
    emit('dismiss', props.notification.id)
  } catch (error) {
    debug.error('Failed to reject follow request:', error)
  } finally {
    isProcessingFollowRequest.value = false
  }
}

const replyToDM = () => {
  const navData = NotificationFormatter.getNavigationData(props.notification)
  if (navData?.type === 'conversation') {
    router.push(`/dm/${navData.conversationId}`)
  }
  emit('dismiss', props.notification.id)
}

const jumpToMessage = () => {
  const navData = NotificationFormatter.getNavigationData(props.notification)
  if (navData?.type === 'channel') {
    let path = `/chat/${navData.serverId}/${navData.channelId}`
    if (navData.messageId) {
      path += `?messageId=${navData.messageId}`
    }
    router.push(path)
  }
  emit('dismiss', props.notification.id)
}

// Computed properties for type icons
const typeIcon = computed(() => {
  const iconMap = {
    mention: MentionIcon,
    dm: DMIcon,
    chat_message: DMIcon,
    reaction: ReactionIcon,
    activitypub_reaction: ReactionIcon,
    activitypub_favorite: ReactionIcon,
    activitypub_reblog: ReactionIcon,
    reply: ReplyIcon,
    server_invite: ServerInviteIcon,
    voice_channel_activity: VoiceIcon,
    emoji_added: EmojiIcon,
  } as const

  type IconMapKey = keyof typeof iconMap
  const type = props.notification.type as IconMapKey
  return iconMap[type] ?? MentionIcon
})
</script>

<style scoped>
.notification-item {
  position: relative;
  display: flex;
  gap: 12px;
  padding: 16px 20px;
  background: transparent;
  transition: background-color var(--transition-fast);
  cursor: default;
  overflow: hidden;
  border-radius: 0;
}

.notification-item--clickable {
  cursor: pointer;
}

.notification-item--clickable:hover {
  background: var(--background-modifier-hover);
}

.notification-item--clickable:focus {
  outline: none;
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  box-shadow: inset 3px 0 0 var(--h-brand);
}

.notification-item--unread {
  background: color-mix(in srgb, var(--harmony-primary) 4%, transparent);
}

.notification-item--unread.notification-item--clickable:hover {
  background: color-mix(in srgb, var(--harmony-primary) 8%, transparent);
}

/* Visual indicator bar */
.notification-indicator {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.notification-item--unread .notification-indicator {
  opacity: 1;
}

.indicator--mention,
.indicator--activitypub_mention  {
  background: var(--error);
}

.indicator--dm,
.indicator--chat_message,
.indicator--activitypub_dm {
  background: var(--harmony-primary);
}

.indicator--reaction,
.indicator--activitypub_reaction,
.indicator--activitypub_favorite,
.indicator--activitypub_reblog {
  background: var(--warning);
}

.indicator--reply,
.indicator--activitypub_reply {
  background: var(--success);
}

.indicator--server_invite {
  background: var(--harmony-primary);
}

.indicator--voice_channel_activity {
  background: var(--success);
}

.indicator--emoji_added {
  background: var(--harmony-accent);
}

.indicator--activitypub_follow {
  background: var(--harmony-primary);
}

/* Avatar section */
.notification-avatar {
  flex-shrink: 0;
}

.avatar-container {
  position: relative;
  width: 40px;
  height: 40px;
}

.avatar-image {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid transparent;
  transition: border-color var(--transition-fast);
}

.notification-item--unread .avatar-image {
  border-color: color-mix(in srgb, var(--harmony-primary) 30%, transparent);
}

.type-icon-overlay {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 8px;
  color: var(--text-primary);
  z-index: 4;
}

.type-icon-overlay svg {
  width: 14px;
  height: 14px;
}

.overlay--mention svg,
.overlay--activitypub_mention svg{
  fill: var(--error);
}

.overlay--dm svg,
.overlay--chat_message svg,
.overlay--activitypub_dm svg{
  fill: var(--harmony-primary);
  stroke: var(--text-secondary);
}

.overlay--reaction svg,
.overlay--reaction .reactionIcon path,
.overlay--activitypub_reaction svg,
.overlay--activitypub_reaction .reactionIcon path{
  fill: var(--warning)!important;
}

.overlay--reply svg,
.overlay--activitypub_reply svg {
  fill: var(--success);
}

.overlay--server_invite svg {
  fill: var(--harmony-primary);
}

.overlay--voice_channel_activity svg {
  fill: var(--success);
}

.overlay--emoji_added svg {
  fill: var(--harmony-accent);
}

.overlay--activitypub_favorite svg,
.overlay--activitypub_favorite .reactionIcon path,
.overlay--activitypub_reblog svg,
.overlay--activitypub_reblog .reactionIcon path {
  fill: var(--warning)!important;
}

.overlay--activitypub_follow svg {
  fill: var(--harmony-primary);
}

.type-icon {
  position: relative;
  top: 2px;
  left: 2px;
  height: 24px;
  width: 24px;
  stroke-width: 1px;
  z-index: 5;
  color: var(--text-primary);
  stroke: var(--text-on-primary);
}

/* Content section */
.notification-content {
  flex: 1;
  min-width: 0;
}

.notification-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
}

.notification-title-section {
  flex: 1;
  min-width: 0;
}

.notification-title {
  margin: 0 0 2px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.3;
  word-wrap: break-word;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.notification-actor-name {
  font-weight: 700;
  color: var(--text-primary);
}

.notification-title-emoji {
  width: 20px;
  height: 20px;
  object-fit: contain;
  flex-shrink: 0;
  vertical-align: middle;
}

.notification-title-emoji-fallback {
  font-size: 18px;
}

.notification-item--unread .notification-title {
  color: var(--text-primary);
}

.notification-metadata {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1;
}

.username,
.actor-handle {
  font-weight: 600;
  color: var(--text-secondary);
}

.actor-handle {
  font-weight: 500;
}

.separator {
  color: var(--text-muted);
}

.timestamp {
  font-weight: 500;
}

.server-name {
  font-weight: 500;
  color: var(--harmony-secondary);
}

/* Actions */
.notification-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.notification-item--hovering .notification-actions,
.notification-item:focus .notification-actions {
  opacity: 1;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.action-btn:hover {
  background: var(--background-modifier-active);
  color: var(--text-secondary);
}

.read-toggle.active {
  color: var(--h-brand);
}

.read-toggle.active:hover {
  background: color-mix(in srgb, var(--harmony-primary) 15%, transparent);
}

.dismiss-btn:hover {
  background: color-mix(in srgb, var(--error) 15%, transparent);
  color: var(--error);
}

.action-icon {
  width: 14px;
  height: 14px;
}

/* Message content */
.notification-message {
  margin-bottom: 8px;
}

.message-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.4;
  color: var(--text-secondary);
  word-wrap: break-word;
}

.notification-item--unread .message-text {
  color: var(--text-primary);
}

/* Rich content */
.rich-content {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.message-preview {
  margin-top: 4px;
}

.preview-line {
  margin: 0;
  display: flex;
  gap: 6px;
  align-items: flex-start;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-secondary);
}

.preview-marker {
  flex-shrink: 0;
  color: var(--text-muted);
  font-weight: 600;
  user-select: none;
}

.preview-text {
  font-style: italic;
  word-wrap: break-word;
  min-width: 0;
}

.reaction-display {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  background: var(--background-modifier-hover);
  padding: 6px;
  border-radius: var(--radius-sm);
}

.reaction-emoji-image {
  width: 36px;
  height: 36px;
  object-fit: contain;
  flex-shrink: 0;
}

.reaction-emoji-fallback {
  font-size: 16px;
  flex-shrink: 0;
}

.reaction-text {
  color: var(--text-secondary);
  font-weight: 500;
  display: flex;
  gap: 4px;
  font-size: 12px;
  padding: 4px;
  align-items: center;
}

/* Quick actions */
.quick-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.notification-item--hovering .quick-actions,
.notification-item:focus .quick-actions {
  opacity: 1;
}

.quick-action-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-full);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.quick-action-btn.accept {
  background: color-mix(in srgb, var(--success) 15%, transparent);
  color: var(--success);
  border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
}

.quick-action-btn.accept:hover {
  background: color-mix(in srgb, var(--success) 25%, transparent);
}

.quick-action-btn.decline {
  background: color-mix(in srgb, var(--error) 15%, transparent);
  color: var(--error);
  border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
}

.quick-action-btn.decline:hover {
  background: color-mix(in srgb, var(--error) 25%, transparent);
}

.quick-action-btn.reply,
.quick-action-btn.jump {
  background: color-mix(in srgb, var(--harmony-primary) 15%, transparent);
  color: var(--h-brand);
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 30%, transparent);
}

.quick-action-btn.reply:hover,
.quick-action-btn.jump:hover {
  background: color-mix(in srgb, var(--harmony-primary) 25%, transparent);
}

.quick-action-icon {
  width: 12px;
  height: 12px;
}

/* Type-specific styling */
.notification-item--mention {
  border-left: 3px solid transparent;
}

.notification-item--mention.notification-item--unread {
  border-left-color: var(--error);
}

.notification-item--dm.notification-item--unread,
.notification-item--chat_message.notification-item--unread {
  border-left-color: var(--harmony-secondary);
}

.notification-item--reaction.notification-item--unread {
  border-left-color: var(--warning);
}

.notification-item--reply.notification-item--unread {
  border-left-color: var(--success);
}

/* Responsive design */
@media (max-width: 768px) {
  .notification-item {
    padding: 12px 16px;
    gap: 10px;
  }
  
  .avatar-container {
    width: 36px;
    height: 36px;
  }
  
  .type-icon-overlay {
    width: 16px;
    height: 16px;
  }
  
  .notification-title {
    font-size: 13px;
  }
  
  .message-text {
    font-size: 12px;
  }
  
  .notification-metadata {
    font-size: 10px;
  }
  
  .notification-actions {
    opacity: 1; /* Always show on mobile */
  }
  
  .quick-actions {
    opacity: 1;
    flex-wrap: wrap;
  }
  
  .quick-action-btn {
    font-size: 10px;
    padding: 4px 8px;
  }
}

/* High contrast mode */
@media (prefers-contrast: high) {
  .notification-item {
    border: 1px solid currentColor;
  }
  
  .avatar-image {
    border: 2px solid currentColor;
  }
  
  .type-icon-overlay {
    border: 2px solid currentColor;
  }
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
</style>