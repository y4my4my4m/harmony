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
        
        <!-- Unread Pulse -->
        <div v-if="!notification.is_read" class="unread-pulse"></div>
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
            Join Server
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
            Jump to Message
          </button>
        </template>
      </div>
    </div>
    
    <!-- Hover gradient effect -->
    <div class="hover-gradient"></div>
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

// Extract text from a MessagePart array or JSON string
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

  // For ActivityPub reactions, show the post preview (your post that was reacted to)
  if (props.notification.type === 'activitypub_reaction') {
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
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  cursor: default;
  overflow: hidden;
  border-radius: 0;
}

.notification-item--clickable {
  cursor: pointer;
}

.notification-item--clickable:hover {
  background: rgba(79, 84, 92, 0.16);
}

.notification-item--clickable:focus {
  outline: none;
  background: rgba(14, 165, 233, 0.1);
  box-shadow: inset 3px 0 0 var(--h-brand);
}

.notification-item--unread {
  background: rgba(14, 165, 233, 0.04);
}

.notification-item--unread.notification-item--clickable:hover {
  background: rgba(14, 165, 233, 0.08);
}

.notification-item--hovering .hover-gradient {
  opacity: 1;
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
  background: linear-gradient(180deg, #f04747, #d63031);
}

.indicator--dm,
.indicator--chat_message,
.indicator--activitypub_dm {
  background: linear-gradient(180deg, #38BDF8, #0EA5E9);
}

.indicator--reaction,
.indicator--activitypub_reaction {
  background: linear-gradient(180deg, #faa61a, #f39c12);
}

.indicator--reply,
.indicator--activitypub_reply {
  background: linear-gradient(180deg, #43b581, #00b894);
}

.indicator--server_invite {
  background: linear-gradient(180deg, #9c88ff, #7c3aed);
}

.indicator--voice_channel_activity {
  background: linear-gradient(180deg, #1dd1a1, #55a3ff);
}

.indicator--emoji_added {
  background: linear-gradient(180deg, #fd79a8, #e84393);
}

.indicator--activitypub_follow {
  background: linear-gradient(180deg, #117dd6, #30a2ff);
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
  transition: all 0.3s ease;
}

.notification-item--unread .avatar-image {
  border-color: rgba(14, 165, 233, 0.3);
  box-shadow: 0 0 0 2px rgba(14, 165, 233, 0.1);
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
  /* background: linear-gradient(135deg, #9647f0, #5a1c7e); */
  fill: #9647f0;
}

.overlay--dm svg,
.overlay--chat_message svg,
.overlay--activitypub_dm svg{
  /* background: linear-gradient(135deg, #38BDF8, #0EA5E9); */
  fill: #38BDF8;
  stroke: #d5d8e6;
}

.overlay--reaction svg,
.overlay--reaction .reactionIcon path,
.overlay--activitypub_reaction svg,
.overlay--activitypub_reaction .reactionIcon path{
  /* background: linear-gradient(135deg, #faa61a, #f39c12); */
  fill: #faa61a!important;
}

.overlay--reply svg,
.overlay--activitypub_reply svg {
  /* background: linear-gradient(135deg, #43b581, #00b894); */
  fill: #43b581;
}

.overlay--server_invite svg {
  /* background: linear-gradient(135deg, #9c88ff, #7c3aed); */
  fill: #9c88ff;
}

.overlay--voice_channel_activity svg {
  /* background: linear-gradient(135deg, #1dd1a1, #55a3ff); */
  fill: #1dd1a1;
}

.overlay--emoji_added svg {
  /* background: linear-gradient(135deg, #fd79a8, #e84393); */
  fill: #fd79a8;
}

.overlay--activitypub_favorite svg,
.overlay--activitypub_favorite .reactionIcon path {
  /* background: linear-gradient(135deg, #d6a811, #ff8d30); */
  fill: #d6a811!important;
}

.overlay--activitypub_follow svg {
  /* background: linear-gradient(180deg, #117dd6, #30a2ff); */
  fill: #117dd6;
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
  stroke: #fff;
}

.unread-pulse {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 12px;
  height: 12px;
  background: radial-gradient(circle, rgba(14, 165, 233, 0.8) 0%, transparent 70%);
  border-radius: 50%;
  animation: notification-pulse 2s ease-in-out infinite;
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
  color: #4f545c;
}

.timestamp {
  font-weight: 500;
}

.server-name {
  font-weight: 500;
  color: #38BDF8;
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
  transition: all 0.2s ease;
}

.action-btn:hover {
  background: rgba(79, 84, 92, 0.32);
  color: var(--text-secondary);
}

.read-toggle.active {
  color: var(--h-brand);
}

.read-toggle.active:hover {
  background: rgba(14, 165, 233, 0.15);
}

.dismiss-btn:hover {
  background: rgba(240, 71, 71, 0.15);
  color: #f04747;
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
  background: rgba(79, 84, 92, 0.3);
  padding: 6px;
  border-radius: 4px;
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
  transform: translateY(4px);
  transition: all 0.3s ease;
}

.notification-item--hovering .quick-actions,
.notification-item:focus .quick-actions {
  opacity: 1;
  transform: translateY(0);
}

.quick-action-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: 16px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  backdrop-filter: blur(8px);
}

.quick-action-btn.accept {
  background: linear-gradient(135deg, rgba(67, 181, 129, 0.15), rgba(67, 181, 129, 0.25));
  color: #43b581;
  border: 1px solid rgba(67, 181, 129, 0.3);
}

.quick-action-btn.accept:hover {
  background: linear-gradient(135deg, rgba(67, 181, 129, 0.25), rgba(67, 181, 129, 0.35));
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(67, 181, 129, 0.2);
}

.quick-action-btn.decline {
  background: linear-gradient(135deg, rgba(240, 71, 71, 0.15), rgba(240, 71, 71, 0.25));
  color: #f04747;
  border: 1px solid rgba(240, 71, 71, 0.3);
}

.quick-action-btn.decline:hover {
  background: linear-gradient(135deg, rgba(240, 71, 71, 0.25), rgba(240, 71, 71, 0.35));
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(240, 71, 71, 0.2);
}

.quick-action-btn.reply,
.quick-action-btn.jump {
  background: linear-gradient(135deg, rgba(14, 165, 233, 0.15), rgba(14, 165, 233, 0.25));
  color: var(--h-brand);
  border: 1px solid rgba(14, 165, 233, 0.3);
}

.quick-action-btn.reply:hover,
.quick-action-btn.jump:hover {
  background: linear-gradient(135deg, rgba(14, 165, 233, 0.25), rgba(14, 165, 233, 0.35));
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(14, 165, 233, 0.2);
}

.quick-action-icon {
  width: 12px;
  height: 12px;
}

/* Hover gradient effect */
.hover-gradient {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(14, 165, 233, 0.03), transparent);
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
}

/* Animations */
@keyframes notification-pulse {
  0%, 100% { 
    transform: scale(1); 
    opacity: 0.8; 
  }
  50% { 
    transform: scale(1.2); 
    opacity: 1; 
  }
}

/* Type-specific styling */
.notification-item--mention {
  border-left: 3px solid transparent;
}

.notification-item--mention.notification-item--unread {
  border-left-color: #f04747;
}

.notification-item--dm.notification-item--unread,
.notification-item--chat_message.notification-item--unread {
  border-left-color: #38BDF8;
}

.notification-item--reaction.notification-item--unread {
  border-left-color: #faa61a;
}

.notification-item--reply.notification-item--unread {
  border-left-color: #43b581;
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
    transform: translateY(0);
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
  
  .unread-pulse {
    animation: none;
  }
}
</style>