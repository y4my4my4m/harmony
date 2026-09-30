<template>
  <li class="today-row" :class="{ unread: conversation.unreadMessages > 0 }">
    <GroupIcon
      v-if="conversation.type === 'group'"
      :conversation-id="conversation.id"
      :icon-path="conversation.iconUrl"
      size="sm"
      :alt="title"
      class="today-row-avatar"
    />
    <Avatar v-else :src="other?.avatarUrl" :alt="title" size="sm" class="today-row-avatar" />
    <div class="today-row-body">
      <div class="today-row-meta">
        <RouterLink :to="route" class="today-row-link" :aria-label="linkLabel">
          <DisplayName v-if="conversation.type === 'direct' && other" :user-id="other.id" :fallback="title" truncate />
          <span v-else class="today-conversation-title">{{ title }}</span>
        </RouterLink>
        <time v-if="last" class="today-row-time" :datetime="last.created_at.toISOString()" :title="fullTime">{{ shortTime }}</time>
        <span class="today-conversation-count" :title="t('today.conversations.unreadCount', { count: conversation.unreadMessages }, conversation.unreadMessages)">
          {{ conversation.unreadMessages > 99 ? '99+' : conversation.unreadMessages }}
        </span>
      </div>
      <div v-if="last" class="today-conversation-last">
        <span v-if="senderPrefix" class="today-conversation-sender">
          <template v-if="fromMe">{{ t('today.conversations.you') }}</template>
          <DisplayName v-else-if="last.user_id" :user-id="last.user_id" :fallback="senderFallback" truncate />
        </span>
        <TodayPreview
          class="today-conversation-preview"
          :content="last.content"
          :message-id="last.id"
          :encrypted="last.encrypted"
          :decrypted="last.decrypted"
          :lines="1"
        />
      </div>
    </div>
  </li>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Avatar from '@/components/common/Avatar.vue'
import GroupIcon from '@/components/common/GroupIcon.vue'
import DisplayName from '@/components/DisplayName.vue'
import TodayPreview from '@/components/today/TodayPreview.vue'
import { formatFullDateTime, formatShortRelativeTime } from '@/utils/shortRelativeTime'
import { conversationRoute, type TodayConversation } from '@/utils/todaySummary'

const props = defineProps<{
  conversation: TodayConversation
  meId: string | null
}>()

const { t, locale } = useI18n()

const other = computed(() => props.conversation.participants[0] ?? null)
const last = computed(() => props.conversation.lastMessage)
const route = computed(() => conversationRoute(props.conversation))

const nameOf = (p: { displayName: string | null; username: string | null }) =>
  p.displayName || p.username || t('today.unknownUser')

const title = computed(() => {
  const c = props.conversation
  if (c.type === 'group') {
    if (c.name) return c.name
    const names = c.participants.map(nameOf)
    const extra = c.participantCount - 1 - names.length
    return extra > 0
      ? t('today.conversations.groupNamesMore', { names: names.join(', '), count: extra })
      : names.join(', ') || t('today.conversations.group')
  }
  return other.value ? nameOf(other.value) : t('today.unknownUser')
})

const fromMe = computed(() => !!last.value?.user_id && last.value.user_id === props.meId)
const senderPrefix = computed(() => fromMe.value || props.conversation.type === 'group')
const senderFallback = computed(() => {
  const sender = props.conversation.participants.find(p => p.id === last.value?.user_id)
  return sender ? nameOf(sender) : t('today.unknownUser')
})

const shortTime = computed(() =>
  last.value ? formatShortRelativeTime(last.value.created_at, { locale: locale.value, nowLabel: t('time.now') }) : '')
const fullTime = computed(() => (last.value ? formatFullDateTime(last.value.created_at, locale.value) : ''))

const linkLabel = computed(() =>
  t('today.conversations.linkLabel', {
    name: title.value,
    count: props.conversation.unreadMessages,
  }, props.conversation.unreadMessages))
</script>

<style scoped src="./todayRow.css"></style>

<style scoped>
.today-conversation-title {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.today-conversation-count {
  flex-shrink: 0;
  min-width: 20px;
  padding: 0 6px;
  border-radius: var(--radius-full);
  background: var(--error);
  color: var(--text-on-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  line-height: 18px;
  text-align: center;
}

.today-conversation-last {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  min-width: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.today-conversation-sender {
  flex-shrink: 0;
  max-width: 40%;
  color: var(--text-primary);
  font-weight: var(--font-weight-medium);
}

.today-conversation-sender::after {
  content: ':';
}

.today-conversation-preview {
  flex: 1;
  min-width: 0;
}
</style>
