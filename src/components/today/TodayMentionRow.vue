<template>
  <li class="today-row" :class="{ unread: mention.unread }">
    <Avatar :src="avatar" size="sm" class="today-row-avatar" />
    <div class="today-row-body">
      <div class="today-row-meta">
        <RouterLink v-if="route" :to="route" class="today-row-link" :aria-label="linkLabel">
          <MessageAuthorLabel
            :profile-user-id="profileUserId"
            :display-name="authorName"
            :bridge-source="bridgeSource"
            :color="authorColor"
            truncate
          />
        </RouterLink>
        <MessageAuthorLabel
          v-else
          :profile-user-id="profileUserId"
          :display-name="authorName"
          :bridge-source="bridgeSource"
          :color="authorColor"
          truncate
        />
        <span class="today-row-kind" :class="mention.kind">{{ kindLabel }}</span>
        <time class="today-row-time" :datetime="iso" :title="fullTime">{{ shortTime }}</time>
        <span v-if="mention.unread" class="today-unread-dot" :title="t('today.unread')"></span>
      </div>
      <div class="today-row-location">
        <Icon :name="locationIcon" :size="12" aria-hidden="true" />
        <span class="today-row-location-text">{{ location }}</span>
      </div>
      <TodayPreview
        :content="mention.message.content"
        :message-id="mention.message.id"
        :encrypted="mention.message.encrypted"
        :decrypted="mention.message.decrypted"
      />
    </div>
  </li>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import MessageAuthorLabel from '@/components/messages/MessageAuthorLabel.vue'
import TodayPreview from '@/components/today/TodayPreview.vue'
import { useMessageAuthorPresentation } from '@/composables/useMessageAuthorPresentation'
import { formatFullDateTime, formatShortRelativeTime } from '@/utils/shortRelativeTime'
import { mentionRoute, type TodayMention } from '@/utils/todaySummary'

const props = defineProps<{ mention: TodayMention }>()

const { t, locale } = useI18n()

const message = computed(() => props.mention.message)
const { profileUserId, displayName, avatarUrl, usernameColor, bridgeSource } =
  useMessageAuthorPresentation(message, { serverId: () => props.mention.server?.id })

const DEFAULT_AVATAR = '/default_avatar.webp'
const UNRESOLVED = new Set(['Unknown User', 'Deleted User'])
// useMessageAuthorPresentation's fallbacks for a user without a color; white vanishes on a
// light theme, so they defer to the theme's text color.
const FALLBACK_COLORS = new Set(['#ffffff', '#dddddd'])

const authorColor = computed(() =>
  FALLBACK_COLORS.has(usernameColor.value.toLowerCase()) ? undefined : usernameColor.value)

// The profile cache fills after first paint; the summary's own author row covers the gap.
const authorName = computed(() => {
  const fromCache = displayName.value
  const author = props.mention.author
  if (UNRESOLVED.has(fromCache) && author) return author.displayName || author.username || fromCache
  return fromCache
})

const avatar = computed(() => {
  const fromCache = avatarUrl.value
  if ((!fromCache || fromCache === DEFAULT_AVATAR) && props.mention.author?.avatarUrl) {
    return props.mention.author.avatarUrl
  }
  return fromCache
})

const route = computed(() => mentionRoute(props.mention))

const kindLabel = computed(() =>
  props.mention.kind === 'reply' ? t('today.mentions.reply') : t('today.mentions.mention'))

const location = computed(() => {
  const m = props.mention
  if (m.threadName && m.server) return t('today.mentions.inThread', { thread: m.threadName, server: m.server.name })
  if (m.channelName && m.server) return t('today.mentions.inChannel', { channel: m.channelName, server: m.server.name })
  if (m.conversation?.type === 'group') {
    return m.conversation.name
      ? t('today.mentions.inGroup', { name: m.conversation.name })
      : t('today.mentions.inUnnamedGroup')
  }
  return t('today.mentions.inDirect')
})

const locationIcon = computed(() => {
  const m = props.mention
  if (m.threadName) return 'thread'
  if (m.channelName) return 'hash'
  return m.conversation?.type === 'group' ? 'users' : 'message-circle'
})

const iso = computed(() => message.value.created_at.toISOString())
const shortTime = computed(() =>
  formatShortRelativeTime(message.value.created_at, { locale: locale.value, nowLabel: t('time.now') }))
const fullTime = computed(() => formatFullDateTime(message.value.created_at, locale.value))

const linkLabel = computed(() =>
  t('today.mentions.linkLabel', {
    kind: kindLabel.value,
    author: authorName.value,
    location: location.value,
    time: fullTime.value,
  }))
</script>

<style scoped src="./todayRow.css"></style>

<style scoped>
.today-row-kind {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: var(--font-weight-semibold);
  line-height: 18px;
  background: var(--harmony-primary-alpha);
  color: var(--harmony-primary);
}

.today-row-kind.reply {
  background: var(--background-modifier-selected);
  color: var(--text-secondary);
}

.today-row-location {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.today-row-location-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
