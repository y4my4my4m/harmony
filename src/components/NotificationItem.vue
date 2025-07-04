<template>
  <div 
    class="notification-item"
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
          <h4 class="notification-title">{{ formattedMessage.title }}</h4>
          <div class="notification-metadata">
            <span class="username">{{ username }}</span>
            <span class="separator">•</span>
            <span class="timestamp" :title="fullTimestamp">{{ relativeTime }}</span>
            <span v-if="serverName" class="separator">•</span>
            <span v-if="serverName" class="server-name">{{ serverName }}</span>
          </div>
        </div>
        
        <!-- Actions -->
        <div class="notification-actions" @click.stop>
          <!-- Mark as Read/Unread -->
          <button 
            @click="toggleRead"
            class="action-btn read-toggle"
            :class="{ active: !notification.is_read }"
            :aria-label="notification.is_read ? 'Mark as unread' : 'Mark as read'"
          >
            <MarkReadIcon v-if="notification.is_read" class="action-icon" />
            <UnreadIcon v-else class="action-icon" />
          </button>
          
          <!-- Dismiss -->
          <button 
            @click="handleDismiss"
            class="action-btn dismiss-btn"
            aria-label="Dismiss notification"
          >
            <DismissIcon class="action-icon" />
          </button>
        </div>
      </div>
      
      <!-- Message Content -->
      <div class="notification-message">
        <p class="message-text">{{ formattedMessage.message }}</p>
        
        <!-- Rich Content for certain types -->
        <div v-if="hasRichContent" class="rich-content">
          <!-- Message Preview for mentions/replies -->
          <div v-if="messagePreview" class="message-preview">
            <div class="preview-content">
              <span class="preview-text">{{ messagePreview }}</span>
            </div>
          </div>
          
          <!-- Channel/Server Info -->
          <div v-if="channelInfo" class="channel-info">
            <span class="channel-name">#{{ channelInfo }}</span>
            <span v-if="serverName" class="in-server">in {{ serverName }}</span>
          </div>
          
          <!-- Reaction Display -->
          <div v-if="reactionEmoji" class="reaction-display">
            <span class="reaction-emoji">{{ reactionEmoji }}</span>
            <span class="reaction-text">{{ reactionEmoji }} reaction</span>
          </div>
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
        
        <!-- For DMs -->
        <template v-if="notification.type === 'dm'">
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
import { useRouter } from 'vue-router'
import { NotificationFormatter } from '@/services/NotificationFormatter'
import type { Notification } from '@/types'
import Avatar from '@/components/common/Avatar.vue'

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

// State
const isHovering = ref(false)

// Use NotificationFormatter for all message formatting
const formattedMessage = computed(() => 
  NotificationFormatter.formatNotification(props.notification)
)

const username = computed(() => 
  NotificationFormatter.getUsername(props.notification)
)

const avatarUrl = computed(() => 
  NotificationFormatter.getAvatarUrl(props.notification)
)

const serverName = computed(() => 
  NotificationFormatter.getServerName(props.notification)
)

const channelName = computed(() => 
  NotificationFormatter.getChannelName(props.notification)
)

const isClickable = computed(() => 
  NotificationFormatter.isClickable(props.notification)
)

// Rich content computed properties
const messagePreview = computed(() => {
  const data = props.notification.data
  return data.message?.content_preview || null
})

const channelInfo = computed(() => {
  return channelName.value
})

const reactionEmoji = computed(() => {
  if (props.notification.type === 'reaction') {
    return props.notification.data.reaction?.emoji_name || '👍'
  }
  return null
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
  return messagePreview.value || channelInfo.value || reactionEmoji.value
})

const hasQuickActions = computed(() => {
  return ['server_invite', 'dm', 'mention', 'reply'].includes(props.notification.type)
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

// Avatar error handling is now handled by the Avatar component

// Quick action handlers using NotificationFormatter navigation data
const acceptInvite = () => {
  console.log('Accepting server invite:', props.notification.data?.invite_id)
  emit('dismiss', props.notification.id)
}

const declineInvite = () => {
  console.log('Declining server invite:', props.notification.data?.invite_id)
  emit('dismiss', props.notification.id)
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
      path += `?message=${navData.messageId}`
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
    reaction: ReactionIcon,
    reply: ReplyIcon,
    server_invite: ServerInviteIcon,
    voice_channel_activity: VoiceIcon,
    emoji_added: EmojiIcon
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
  background: rgba(88, 101, 242, 0.1);
  box-shadow: inset 3px 0 0 var(--h-brand);
}

.notification-item--unread {
  background: rgba(88, 101, 242, 0.04);
}

.notification-item--unread.notification-item--clickable:hover {
  background: rgba(88, 101, 242, 0.08);
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

.indicator--mention {
  background: linear-gradient(180deg, #f04747, #d63031);
}

.indicator--dm {
  background: linear-gradient(180deg, #7289da, #5865f2);
}

.indicator--reaction {
  background: linear-gradient(180deg, #faa61a, #f39c12);
}

.indicator--reply {
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
  border-color: rgba(88, 101, 242, 0.3);
  box-shadow: 0 0 0 2px rgba(88, 101, 242, 0.1);
}

.type-icon-overlay {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--h-chat);
  font-size: 8px;
  color: #ffffff;
}

.overlay--mention {
  background: linear-gradient(135deg, #f04747, #d63031);
}

.overlay--dm {
  background: linear-gradient(135deg, #7289da, #5865f2);
}

.overlay--reaction {
  background: linear-gradient(135deg, #faa61a, #f39c12);
}

.overlay--reply {
  background: linear-gradient(135deg, #43b581, #00b894);
}

.overlay--server_invite {
  background: linear-gradient(135deg, #9c88ff, #7c3aed);
}

.overlay--voice_channel_activity {
  background: linear-gradient(135deg, #1dd1a1, #55a3ff);
}

.overlay--emoji_added {
  background: linear-gradient(135deg, #fd79a8, #e84393);
}

.type-icon {
  width: 10px;
  height: 10px;
}

.unread-pulse {
  position: absolute;
  top: -2px;
  right: -2px;
  width: 12px;
  height: 12px;
  background: radial-gradient(circle, rgba(88, 101, 242, 0.8) 0%, transparent 70%);
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
  color: #ffffff;
  line-height: 1.3;
  word-wrap: break-word;
}

.notification-item--unread .notification-title {
  color: #ffffff;
}

.notification-metadata {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #72767d;
  line-height: 1;
}

.username {
  font-weight: 600;
  color: #b9bbbe;
}

.separator {
  color: #4f545c;
}

.timestamp {
  font-weight: 500;
}

.server-name {
  font-weight: 500;
  color: #7289da;
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
  color: #72767d;
  cursor: pointer;
  transition: all 0.2s ease;
}

.action-btn:hover {
  background: rgba(79, 84, 92, 0.32);
  color: #dcddde;
}

.read-toggle.active {
  color: var(--h-brand);
}

.read-toggle.active:hover {
  background: rgba(88, 101, 242, 0.15);
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
  color: #dcddde;
  word-wrap: break-word;
}

.notification-item--unread .message-text {
  color: #ffffff;
}

/* Rich content */
.rich-content {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.message-preview {
  background: rgba(79, 84, 92, 0.3);
  border-radius: 6px;
  padding: 8px 10px;
  border-left: 3px solid rgba(88, 101, 242, 0.5);
}

.preview-content {
  font-size: 12px;
  color: #b9bbbe;
  line-height: 1.3;
}

.preview-text {
  font-style: italic;
}

.channel-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.channel-name {
  font-weight: 600;
  color: #7289da;
}

.in-server {
  color: #72767d;
}

.reaction-display {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.reaction-emoji {
  font-size: 16px;
}

.reaction-text {
  color: #b9bbbe;
  font-weight: 500;
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
  background: linear-gradient(135deg, rgba(88, 101, 242, 0.15), rgba(88, 101, 242, 0.25));
  color: var(--h-brand);
  border: 1px solid rgba(88, 101, 242, 0.3);
}

.quick-action-btn.reply:hover,
.quick-action-btn.jump:hover {
  background: linear-gradient(135deg, rgba(88, 101, 242, 0.25), rgba(88, 101, 242, 0.35));
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(88, 101, 242, 0.2);
}

.quick-action-icon {
  width: 12px;
  height: 12px;
}

/* Hover gradient effect */
.hover-gradient {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(88, 101, 242, 0.03), transparent);
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

.notification-item--dm.notification-item--unread {
  border-left-color: #7289da;
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