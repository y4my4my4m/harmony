<template>
  <div class="reply-reference" @click="emit('open-reply', replyToMessageId)">
    <div class="reply-spine"></div>
    <div class="reply-content">
      <Avatar :src="avatarUrl" size="mini" class="reply-avatar" />
      <MessageAuthorLabel
        class="reply-username"
        :profile-user-id="profileUserId"
        :display-name="authorLabel"
        :bridge-source="bridgeSource"
        :color="usernameColor"
        truncate
      />
      <div class="reply-preview">
        {{ previewText }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import Avatar from '@/components/common/Avatar.vue'
import MessageAuthorLabel from '@/components/messages/MessageAuthorLabel.vue'
import { useReplyTarget } from '@/composables/useReplyTarget'

const props = defineProps<{
  replyToMessageId: string
  channelId?: string | null
  conversationId?: string | null
  serverId?: string | null
}>()

const emit = defineEmits<{
  (e: 'open-reply', replyMessageId: string): void
}>()

const {
  profileUserId,
  authorLabel,
  bridgeSource,
  avatarUrl,
  usernameColor,
  previewText,
} = useReplyTarget(
  toRef(props, 'replyToMessageId'),
  computed(() => ({
    channelId: props.channelId,
    conversationId: props.conversationId,
    serverId: props.serverId,
  })),
)
</script>

<style scoped>
.reply-reference {
  margin-left: 54px;
  margin-bottom: 0;
  cursor: pointer;
  position: relative;
}

.reply-spine {
  position: absolute;
  left: -36px;
  bottom: -1px;
  width: 2px;
  height: 12px;
  background-color: #4f545c;
  border-radius: 1px;
}

.reply-spine::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 34px;
  height: 2px;
  background-color: #4f545c;
  border-radius: 1px;
}

.reply-content {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0.64;
  transition: opacity 0.2s ease;
  min-width: 0;
}

.reply-content:hover {
  opacity: 1;
}

.reply-avatar {
  flex-shrink: 0;
}

.reply-username {
  font-weight: 500;
  font-size: 0.875rem;
  max-width: 50%;
  flex-shrink: 0;
}

.reply-preview {
  color: var(--text-secondary);
  font-size: 0.875rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
  min-width: 0;
  flex: 1;
}

@media (max-width: 768px) {
  .reply-reference {
    margin-left: 50px;
  }

  .reply-spine {
    left: -30px;
  }

  .reply-spine::after {
    width: 28px;
  }

  .reply-username {
    max-width: 40%;
  }

  .reply-preview {
    max-width: none;
  }
}
</style>
