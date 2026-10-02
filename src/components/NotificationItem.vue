<template>
  <li
    class="notification-item"
    data-testid="notification-item"
    :data-type="notification.type"
    :class="[`notification-item--${notification.type}`, { 'is-unread': !notification.is_read }]"
  >
    <button
      type="button"
      class="row-hit"
      data-row-hit
      :aria-label="accessibleLabel"
      @click="emit('open', notification)"
    />

    <span class="unread-dot" aria-hidden="true" />

    <div class="avatar-wrap" aria-hidden="true">
      <Avatar :src="avatarUrl" size="sm" class="row-avatar" />
      <span class="type-badge" :class="`tone-${tone}`">
        <Icon :name="typeIcon" :size="10" :stroke-width="2.5" />
      </span>
    </div>

    <div class="body">
      <div class="line">
        <span class="summary">
          <template v-if="actorLayout">
            <DisplayName
              v-if="actorUserId"
              :user-id="actorUserId"
              :fallback="actorName"
              :truncate="true"
              class="actor"
            />
            <span v-else class="actor">{{ actorName }}</span>
            <template v-if="isReaction">
              <span class="action"> reacted </span>
              <img
                v-if="reactionEmoji?.url"
                :src="reactionEmoji.url"
                :alt="reactionEmoji.name"
                class="inline-emoji"
              />
              <span v-else-if="reactionEmoji" class="inline-emoji-text">{{ reactionEmoji.text }}</span>
              <span class="action">{{ reactionSuffix }}</span>
            </template>
            <span v-else class="action">{{ actionText }}</span>
          </template>
          <span v-else class="actor">{{ formatted.title }}</span>
        </span>
        <time class="time" :datetime="notification.created_at" :title="fullTimestamp">{{ relative }}</time>
      </div>

      <p v-if="preview" class="preview">{{ preview }}</p>

      <div v-if="isFollowRequest" class="quick-actions">
        <button type="button" class="quick-btn primary" :disabled="busy" @click="respondToFollow(true)">
          {{ t('inbox.accept') }}
        </button>
        <button type="button" class="quick-btn" :disabled="busy" @click="respondToFollow(false)">
          {{ t('inbox.reject') }}
        </button>
      </div>
    </div>

    <div class="row-actions">
      <button
        type="button"
        class="row-action"
        :aria-label="notification.is_read ? t('inbox.markUnread') : t('inbox.markRead')"
        :title="notification.is_read ? t('inbox.markUnread') : t('inbox.markRead')"
        @click="emit('toggle-read', notification.id)"
      >
        <Icon :name="notification.is_read ? 'circle' : 'check'" :size="14" />
      </button>
      <button
        type="button"
        class="row-action"
        :aria-label="t('inbox.remove')"
        :title="t('inbox.remove')"
        @click="emit('remove', notification.id)"
      >
        <Icon name="x" :size="14" />
      </button>
    </div>
  </li>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { debug } from '@/utils/debug'
import { NotificationFormatter } from '@/services/NotificationFormatter'
import { getEmojiUrl } from '@/utils/emojiUtils'
import { shortRelativeTime } from '@/utils/notificationInbox'
import type { Notification } from '@/types'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import DisplayName from '@/components/DisplayName.vue'

const props = defineProps<{
  notification: Notification
  /** Shared clock for relative times, so rows do not each run a timer. */
  now: Date
}>()

const emit = defineEmits<{
  (e: 'open', notification: Notification): void
  (e: 'toggle-read', id: string): void
  (e: 'remove', id: string): void
}>()

const { t, locale } = useI18n()

const ACTION_OVERRIDES: Record<string, string> = {
  activitypub_follow: ' followed you',
  activitypub_follow_request: ' requested to follow you',
}

const data = computed<Record<string, any>>(() => props.notification.data || {})
const formatted = computed(() => NotificationFormatter.formatNotification(props.notification))

const actionText = computed(() =>
  ACTION_OVERRIDES[props.notification.type] ?? NotificationFormatter.getTitleAction(props.notification)
)

// Rows that read "<actor> <action>"; the rest show the formatted title.
const actorLayout = computed(() => !!actionText.value || isReaction.value)

const actor = computed(() => {
  const d = data.value
  return d.sender || d.actor || d.reactor || d.follower || d.author || d.user || d.inviter || null
})

const actorName = computed(() => {
  const a = actor.value
  return a?.display_name || a?.username || d('sender_display_name') || d('sender_username') || 'Someone'
})

function d(key: string): string | undefined {
  const v = data.value[key]
  return typeof v === 'string' ? v : undefined
}

const actorUserId = computed(() => {
  const id = data.value.from_user_id ?? actor.value?.user_id ?? actor.value?.id
  return typeof id === 'string' ? id : null
})

const avatarUrl = computed(() => NotificationFormatter.getAvatarUrl(props.notification))

const isReaction = computed(() =>
  props.notification.type === 'reaction' || props.notification.type === 'activitypub_reaction'
)

const reactionSuffix = computed(() =>
  props.notification.type === 'activitypub_reaction' ? ' to your post' : ' to your message'
)

const reactionEmoji = computed(() => {
  if (!isReaction.value) return null
  const reaction = data.value.reaction || data.value
  const url = reaction?.emoji_url || data.value.emoji_url
  const raw = String(reaction?.emoji_name || reaction?.custom_emoji_content || data.value.emoji_name || '').trim()
  if (url) return { url: getEmojiUrl(url, 48), name: raw.replace(/^:|:$/g, ''), text: '' }
  if (!raw) return null
  return { url: null, name: raw, text: raw }
})

const isFollowRequest = computed(() => props.notification.type === 'activitypub_follow_request')

function partsText(content: any): string | null {
  if (!content) return null
  if (typeof content === 'string') {
    if (!content.startsWith('[')) return content
    try { content = JSON.parse(content) } catch { return content }
  }
  if (!Array.isArray(content)) return null
  const text = content
    .map((part: any) => {
      if (part.type === 'text') return part.text
      if (part.type === 'mention') return `@${part.username}${part.domain ? '@' + part.domain : ''}`
      if (part.type === 'emoji') return `:${part.emoji?.name || part.emoji}:`
      if (part.type === 'hashtag') return `#${part.name}`
      if (part.type === 'url') return part.url
      return ''
    })
    .join(' ')
    .trim()
  return text || null
}

const preview = computed(() => {
  const v = data.value
  const type = props.notification.type
  if (v.encrypted === true || v.message?.encrypted === true) return 'Encrypted message'
  if (!actorLayout.value) {
    return formatted.value.message && formatted.value.message !== formatted.value.title ? formatted.value.message : null
  }
  if (type.startsWith('activitypub_')) {
    return partsText(v.post?.content_preview) || partsText(v.post_content) || partsText(v.post?.content)
  }
  if (type === 'reaction') {
    return partsText(v.message_preview) || partsText(v.message?.content_preview)
  }
  return partsText(v.message?.content_preview) || partsText(v.preview || v.content_preview) || partsText(v.message?.content || v.content)
})

const relative = computed(() => shortRelativeTime(props.notification.created_at, props.now, locale.value))
const fullTimestamp = computed(() => new Date(props.notification.created_at).toLocaleString(locale.value))

const accessibleLabel = computed(() => {
  const summary = actorLayout.value
    ? `${actorName.value}${isReaction.value ? ` reacted${reactionSuffix.value}` : actionText.value}`
    : formatted.value.title
  const state = props.notification.is_read ? '' : `${t('inbox.unread')}. `
  return `${state}${summary}. ${preview.value ?? ''} ${fullTimestamp.value}`.trim()
})

const TYPE_ICONS: Record<string, { icon: string; tone: string }> = {
  mention: { icon: 'at-sign', tone: 'mention' },
  activitypub_mention: { icon: 'at-sign', tone: 'mention' },
  dm: { icon: 'message-circle', tone: 'dm' },
  chat_message: { icon: 'message-circle', tone: 'dm' },
  reply: { icon: 'corner-down-right', tone: 'reply' },
  thread_reply: { icon: 'corner-down-right', tone: 'reply' },
  activitypub_reply: { icon: 'corner-down-right', tone: 'reply' },
  reaction: { icon: 'smile', tone: 'reaction' },
  activitypub_reaction: { icon: 'smile', tone: 'reaction' },
  activitypub_favorite: { icon: 'heart', tone: 'favorite' },
  activitypub_reblog: { icon: 'repeat', tone: 'reblog' },
  activitypub_follow: { icon: 'user-plus', tone: 'follow' },
  activitypub_follow_request: { icon: 'user-plus', tone: 'follow' },
  activitypub_follow_accepted: { icon: 'user-check', tone: 'follow' },
  report_update: { icon: 'shield', tone: 'system' },
  moderation_warning: { icon: 'shield', tone: 'system' },
  server_invite: { icon: 'server', tone: 'system' },
  voice_channel_activity: { icon: 'headphones', tone: 'system' },
}

const typeIcon = computed(() => TYPE_ICONS[props.notification.type]?.icon ?? 'bell')
const tone = computed(() => TYPE_ICONS[props.notification.type]?.tone ?? 'system')

const busy = ref(false)

async function respondToFollow(accept: boolean) {
  const followerId = data.value.follower?.id || data.value.follower_id
  if (!followerId || busy.value) return
  busy.value = true
  try {
    const { interactionService } = await import('@/services/InteractionService')
    if (accept) await interactionService.acceptFollowRequest(followerId)
    else await interactionService.rejectFollowRequest(followerId)
    emit('remove', props.notification.id)
  } catch (error) {
    debug.error('Failed to answer follow request:', error)
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.notification-item {
  position: relative;
  display: grid;
  grid-template-columns: 8px 40px minmax(0, 1fr);
  align-items: start;
  column-gap: var(--space-2);
  padding: var(--space-2) var(--space-3) var(--space-2) var(--space-2);
  border-radius: var(--radius-md);
  margin: 0 var(--space-2);
  transition: background-color var(--transition-fast);
}

.notification-item:hover,
.notification-item:focus-within {
  background: var(--background-modifier-hover);
}

.notification-item.is-unread {
  background: color-mix(in srgb, var(--harmony-primary) 7%, transparent);
}

.notification-item.is-unread:hover,
.notification-item.is-unread:focus-within {
  background: color-mix(in srgb, var(--harmony-primary) 12%, transparent);
}

/* Covers the row so the whole row opens the target; secondary controls sit above it. */
.row-hit {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  border: none;
  border-radius: inherit;
  background: transparent;
  cursor: pointer;
  padding: 0;
}

.row-hit:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}

.unread-dot {
  width: 8px;
  height: 8px;
  margin-top: 16px;
  border-radius: var(--radius-full);
  background: transparent;
}

.is-unread .unread-dot {
  background: var(--h-brand);
}

.avatar-wrap {
  position: relative;
  width: 40px;
  height: 40px;
  pointer-events: none;
}

.type-badge {
  position: absolute;
  right: -3px;
  bottom: -3px;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-full);
  color: var(--text-on-primary, #fff);
  background: var(--text-tertiary);
  box-shadow: 0 0 0 2px var(--background-secondary);
}

.tone-mention { background: var(--error); }
.tone-dm { background: var(--harmony-primary); }
.tone-reply { background: var(--success); }
.tone-reaction,
.tone-favorite { background: color-mix(in srgb, var(--error) 70%, var(--warning)); }
.tone-reblog { background: var(--success); }
.tone-follow { background: var(--harmony-secondary); }

.body {
  position: relative;
  min-width: 0;
  pointer-events: none;
}

.line {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: var(--font-size-sm);
  line-height: 1.35;
  color: var(--text-secondary);
}

.actor {
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.inline-emoji {
  width: 16px;
  height: 16px;
  vertical-align: -3px;
  object-fit: contain;
}

.time {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.preview {
  margin: 2px 0 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--font-size-sm);
  line-height: 1.35;
  color: var(--text-muted);
}

.quick-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
  pointer-events: auto;
}

.quick-btn {
  position: relative;
  z-index: 1;
  padding: 4px 12px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-base);
  background: var(--background-modifier-hover);
  color: var(--text-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
}

.quick-btn.primary {
  border-color: transparent;
  background: var(--harmony-primary);
  color: var(--text-on-primary, #fff);
}

.quick-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* Overlays the timestamp, so showing it never reflows the row. */
.row-actions {
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: 1;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-base);
  background: var(--background-floating, var(--background-secondary));
  box-shadow: var(--shadow-small);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--transition-fast);
}

.notification-item:hover .row-actions,
.notification-item:focus-within .row-actions {
  opacity: 1;
  pointer-events: auto;
}

.row-action {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.row-action:hover {
  background: var(--background-modifier-active);
  color: var(--text-primary);
}

.row-action:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}

/* Touch screens have no hover: the actions stay visible in their own column. */
@media (hover: none) {
  .notification-item {
    grid-template-columns: 8px 40px minmax(0, 1fr) 32px;
  }

  .row-actions {
    position: static;
    flex-direction: column;
    align-self: center;
    gap: 0;
    padding: 0;
    opacity: 1;
    pointer-events: auto;
    background: transparent;
    box-shadow: none;
  }

  .row-action {
    width: 32px;
    height: 32px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .notification-item,
  .row-actions {
    transition: none;
  }
}
</style>
