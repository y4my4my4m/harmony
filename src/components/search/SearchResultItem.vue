<template>
  <article
    class="search-result"
    tabindex="0"
    :aria-label="t('messageSearch.jumpTo')"
    @click="handleClick"
    @keydown.enter.self="emit('open', message)"
  >
    <Avatar :src="avatarUrl" size="sm" class="search-result-avatar" />
    <div class="search-result-main">
      <div class="search-result-meta">
        <MessageAuthorLabel
          class="search-result-author"
          :profile-user-id="profileUserId"
          :display-name="displayName"
          :bridge-source="bridgeSource"
          :color="usernameColor"
          truncate
        />
        <span v-if="message.bot_id && !isBridged" class="search-result-bot">{{ t('messageSearch.bot') }}</span>
        <SupporterBadge v-if="profileUserId" :user-id="profileUserId" />
        <time class="search-result-time" :datetime="isoTime" :title="fullTime">{{ fullTime }}</time>
        <Icon v-if="message.is_pinned" name="pin" :size="12" class="search-result-flag" :title="t('messageSearch.pinned')" />
        <Icon v-if="message.encrypted" name="lock" :size="12" class="search-result-flag" :title="t('messageSearch.encrypted')" />
        <button type="button" class="search-result-jump" @click.stop="emit('open', message)">
          {{ t('messageSearch.jump') }}
        </button>
      </div>
      <UnifiedMessageContent
        class="search-result-content"
        :content="message.content"
        :message-id="message.id"
        :embed-payloads="message.metadata?.embeds"
        :metadata="message.metadata"
        :encrypted="message.encrypted || false"
        :decrypted="message.decrypted || false"
        :unrecoverable="message.decryption_unrecoverable || false"
        :sender-verified="message.sender_verified"
      />
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import SupporterBadge from '@/components/common/SupporterBadge.vue'
import MessageAuthorLabel from '@/components/messages/MessageAuthorLabel.vue'
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'
import { useMessageAuthorPresentation } from '@/composables/useMessageAuthorPresentation'
import { formatFullDateTime } from '@/utils/shortRelativeTime'
import type { Message } from '@/types'

const props = defineProps<{
  message: Message
  serverId?: string | null
}>()

const emit = defineEmits<{
  (e: 'open', message: Message): void
}>()

const { t, locale } = useI18n()

const { profileUserId, displayName, avatarUrl, usernameColor, bridgeSource, isBridged } =
  useMessageAuthorPresentation(toRef(props, 'message'), { serverId: () => props.serverId })

const isoTime = computed(() => new Date(props.message.created_at).toISOString())
const fullTime = computed(() => formatFullDateTime(props.message.created_at, locale.value))

// Links, spoilers, media and buttons inside the content keep their own click.
const INTERACTIVE = 'a, button, input, textarea, video, audio, summary, [role="button"], [class*="spoiler"], .content-image'

const handleClick = (event: MouseEvent) => {
  const target = event.target as HTMLElement | null
  if (target?.closest(INTERACTIVE)) return
  if (window.getSelection()?.toString()) return
  emit('open', props.message)
}
</script>

<style scoped>
.search-result {
  position: relative;
  display: flex;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--background-secondary);
  border: 1px solid var(--border-secondary);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}

.search-result:hover,
.search-result:focus-visible {
  background: var(--background-modifier-hover);
  border-color: var(--border-hover);
  outline: none;
}

.search-result-avatar {
  flex-shrink: 0;
  margin-top: 2px;
}

.search-result-main {
  flex: 1;
  min-width: 0;
}

.search-result-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--font-size-sm);
}

.search-result-author {
  font-weight: var(--font-weight-semibold);
  max-width: 50%;
}

.search-result-bot {
  flex-shrink: 0;
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font-size: 10px;
  font-weight: var(--font-weight-semibold);
  line-height: 16px;
}

.search-result-time {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}

.search-result-flag {
  flex-shrink: 0;
  color: var(--text-muted);
}

.search-result-jump {
  margin-left: auto;
  flex-shrink: 0;
  padding: 2px var(--space-2);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-sm);
  background: var(--background-primary);
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.search-result:hover .search-result-jump,
.search-result:focus-within .search-result-jump {
  opacity: 1;
}

.search-result-jump:hover {
  color: var(--text-primary);
  border-color: var(--border-hover);
}

.search-result-content {
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
}

/* Media previews stay short so a page of results scans quickly. */
.search-result-content :deep(.content-image),
.search-result-content :deep(video) {
  max-height: 160px;
  width: auto;
}

@media (hover: none) {
  .search-result-jump {
    opacity: 1;
  }
}
</style>
