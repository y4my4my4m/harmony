<template>
  <button 
    v-if="thread" 
    class="thread-indicator"
    @click="$emit('open', thread)"
  >
    <div class="indicator-left">
      <div class="participant-avatars">
        <Avatar 
          v-for="(participant, i) in displayParticipants" 
          :key="participant.id"
          :src="getParticipantAvatar(participant.id)"
          :alt="participant.display_name || 'User'"
          size="mini"
          class="participant-avatar"
          :style="{ zIndex: displayParticipants.length - i }"
        />
      </div>
      <span class="reply-text">
        <span class="reply-count">{{ formatReplyCount(thread.message_count) }}</span>
        <span class="reply-time" v-if="thread.last_message_at">
          Last reply {{ formatRelativeTime(thread.last_message_at) }}
        </span>
      </span>
    </div>
    <span class="view-thread">View Thread</span>
    <svg class="arrow-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M10 17l5-5-5-5v10z"/>
    </svg>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { formatDistanceToNow } from 'date-fns'
import Avatar from '@/components/common/Avatar.vue'
import { useUserData } from '@/composables/useUserData'

interface ThreadData {
  id: string
  name: string
  message_count: number
  member_count: number
  last_message_at?: Date | string | null
  participants?: Array<{ id: string; display_name?: string }>
}

interface Props {
  thread?: ThreadData | null
}

const props = defineProps<Props>()
defineEmits<{ open: [thread: ThreadData] }>()

const { getUserAvatarUrl } = useUserData()

const displayParticipants = computed(() => {
  if (!props.thread?.participants) return []
  return props.thread.participants.slice(0, 3)
})

const getParticipantAvatar = (userId: string): string => {
  return getUserAvatarUrl(userId).value || '/default_avatar.webp'
}

const formatReplyCount = (count: number) => {
  if (count === 1) return '1 Reply'
  return `${count} Replies`
}

const formatRelativeTime = (date: Date | string | null | undefined) => {
  if (!date) return ''
  try {
    const d = typeof date === 'string' ? new Date(date) : date
    return formatDistanceToNow(d, { addSuffix: false })
  } catch {
    return ''
  }
}
</script>

<style scoped>
.thread-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  max-width: 500px;
  padding: 4px 12px 4px 4px;
  margin-left: 44px; /* Align with message content */
  margin-top: 4px;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}

.thread-indicator:hover {
  background: var(--background-secondary);
}

.indicator-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.participant-avatars {
  display: flex;
}

.participant-avatar {
  margin-left: -4px;
  border: 2px solid var(--background-primary);
  border-radius: 50%;
}

.participant-avatar:first-child {
  margin-left: 0;
}

.reply-text {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
}

.reply-count {
  color: var(--harmony-primary);
  font-weight: 500;
}

.thread-indicator:hover .reply-count {
  text-decoration: underline;
}

.reply-time {
  color: var(--text-muted);
  font-size: 13px;
}

.thread-indicator:hover .reply-time {
  color: var(--text-secondary);
}

.view-thread {
  color: var(--text-muted);
  font-size: 13px;
  opacity: 0;
  transition: opacity 0.15s;
}

.thread-indicator:hover .view-thread {
  opacity: 1;
  color: var(--text-secondary);
}

.arrow-icon {
  color: var(--text-muted);
  opacity: 0;
  transition: opacity 0.15s;
}

.thread-indicator:hover .arrow-icon {
  opacity: 1;
}
</style>
