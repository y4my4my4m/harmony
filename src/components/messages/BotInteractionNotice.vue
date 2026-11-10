<template>
  <div v-if="rows.length > 0" class="bot-interactions" aria-live="polite">
    <div
      v-for="row in rows"
      :key="row.id"
      class="bot-interaction"
      :class="`phase-${interactionPhase(row)}`"
      data-testid="bot-interaction-notice"
      :data-interaction-id="row.id"
      :data-status="interactionStatusAttr(row)"
    >
      <p class="bot-interaction-line">
        <span class="bot-interaction-spine" aria-hidden="true"></span>
        <Avatar :src="botAvatar(row)" size="mini" class="bot-interaction-avatar" />
        <span class="bot-interaction-used">{{ t('bots.commands.notice.used', { command: `/${row.commandName}` }) }}</span>
        <template v-if="statusText(row)">
          <span class="bot-interaction-dot" aria-hidden="true"> · </span>
          <span class="bot-interaction-status">
            <span v-if="interactionPhase(row) === 'thinking'" class="bot-interaction-pulse" aria-hidden="true"></span>
            {{ statusText(row) }}
          </span>
        </template>
        <template v-if="interactionPhase(row) !== 'thinking' && row.replies.length === 0">
          <span class="bot-interaction-dot" aria-hidden="true"> · </span>
          <button
            type="button"
            class="bot-interaction-dismiss"
            data-testid="bot-interaction-dismiss"
            @click="store.dismiss(row.id)"
          >{{ t('bots.commands.notice.dismiss') }}</button>
        </template>
      </p>

      <div v-if="row.replies.length > 0" class="bot-interaction-replies">
        <div class="bot-interaction-author">
          <Avatar :src="botAvatar(row)" size="sm" class="bot-interaction-author-avatar" />
          <span class="bot-interaction-author-name">{{ botName(row) }}</span>
          <span class="bot-interaction-badge">BOT</span>
        </div>
        <div
          v-for="reply in row.replies"
          :key="reply.id"
          class="bot-interaction-reply"
          data-testid="bot-interaction-reply"
        >
          <UnifiedMessageContent
            :content="reply.content"
            :message-id="reply.id"
            :media-hidden="mediaHidden"
          />
        </div>
        <p class="bot-interaction-private">
          <Icon name="eye" :size="14" aria-hidden="true" />
          <span>{{ t('bots.commands.notice.private') }}</span>
          <span class="bot-interaction-dot" aria-hidden="true"> · </span>
          <button
            type="button"
            class="bot-interaction-dismiss"
            data-testid="bot-interaction-dismiss"
            @click="store.dismiss(row.id)"
          >{{ t('bots.commands.notice.dismiss') }}</button>
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'
import { useT } from '@/composables/useT'
import { useServerMediaHidden } from '@/composables/useInstanceMediaHidden'
import {
  interactionPhase,
  interactionStatusAttr,
  useBotInteractionsStore,
  type BotInteractionEntry,
} from '@/stores/useBotInteractions'
import type { Message } from '@/types'

const props = defineProps<{
  channelId: string
  threadId?: string | null
  /** The list this notice ends; a public reply in it answers its row. */
  messages: readonly Message[]
  serverId?: string | null
}>()

const { t } = useT()
const store = useBotInteractionsStore()
const mediaHidden = useServerMediaHidden(() => props.serverId ?? null)

const scope = computed(() => ({ channelId: props.channelId, threadId: props.threadId ?? null }))
const rows = computed(() => store.rowsFor(scope.value.channelId, scope.value.threadId))

const botName = (row: BotInteractionEntry) =>
  row.bot?.display_name?.trim() || row.bot?.username || t('bots.commands.notice.someBot')
const botAvatar = (row: BotInteractionEntry) => row.bot?.avatar_url || '/default_avatar.webp'

function statusText(row: BotInteractionEntry): string {
  const bot = botName(row)
  switch (interactionPhase(row)) {
    case 'thinking': return t('bots.commands.notice.thinking', { bot })
    case 'timed_out': return t('bots.commands.notice.noResponse', { bot })
    case 'offline': return t('bots.commands.notice.offline', { bot })
    case 'cannot_post': return t('bots.commands.notice.cannotPost', { bot })
    case 'blocked': return t('bots.commands.notice.blocked', { bot })
    case 'thread_locked': return t('bots.commands.notice.threadLocked', { bot })
    case 'failed': return t('bots.commands.notice.failed', { bot })
    default: return ''
  }
}

onMounted(() => store.listen())

// Opening a channel or thread re-reads its rows: a push missed while elsewhere.
watch(scope, (next) => { void store.resync(next) }, { immediate: true })

// Rows the list answers: the newest messages, as they arrive.
const RECENT = 30
watch(
  () => [props.messages.length, props.messages[props.messages.length - 1]?.id],
  () => {
    if (rows.value.length === 0) return
    for (const message of props.messages.slice(-RECENT)) {
      if (message.metadata?.interaction) store.noteMessage(message)
    }
  },
  { immediate: true },
)
</script>

<style scoped>
.bot-interactions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 16px 8px;
}

.bot-interaction {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--harmony-primary) 6%, transparent);
}

.bot-interaction-line {
  position: relative;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding-left: 46px;
  font-size: 0.875rem;
  color: var(--text-secondary);
  min-width: 0;
}

.bot-interaction-spine {
  position: absolute;
  left: 18px;
  top: 50%;
  width: 22px;
  height: 10px;
  border-left: 2px solid var(--border-color);
  border-top: 2px solid var(--border-color);
  border-top-left-radius: 6px;
}

.bot-interaction-avatar {
  flex-shrink: 0;
  border-radius: 50%;
}

.bot-interaction-used {
  color: var(--text-primary);
  font-weight: 500;
}

.bot-interaction-dot {
  color: var(--text-muted);
}

.bot-interaction-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.phase-timed_out .bot-interaction-status,
.phase-offline .bot-interaction-status,
.phase-cannot_post .bot-interaction-status,
.phase-blocked .bot-interaction-status,
.phase-thread_locked .bot-interaction-status,
.phase-failed .bot-interaction-status {
  color: var(--text-danger);
}

.bot-interaction-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--harmony-primary);
  animation: bot-interaction-pulse 1.2s ease-in-out infinite;
}

@keyframes bot-interaction-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}

.bot-interaction-dismiss {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: var(--text-link);
  cursor: pointer;
}

.bot-interaction-dismiss:hover {
  text-decoration: underline;
}

.bot-interaction-dismiss:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
  border-radius: 2px;
}

.bot-interaction-replies {
  display: flex;
  flex-direction: column;
  padding-left: 54px;
  position: relative;
  min-width: 0;
}

.bot-interaction-author {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
}

.bot-interaction-author-avatar {
  position: absolute;
  left: 4px;
  top: 2px;
}

.bot-interaction-author-name {
  font-weight: 600;
  color: var(--text-primary);
}

.bot-interaction-badge {
  padding: 0 4px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
  line-height: 15px;
  background: var(--harmony-primary-fill, var(--harmony-primary));
  color: var(--text-on-primary);
}

.bot-interaction-reply {
  min-width: 0;
  color: var(--text-primary);
}

.bot-interaction-private {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 4px 0 0;
  font-size: 0.75rem;
  color: var(--text-muted);
}

@media (max-width: 768px) {
  .bot-interactions {
    padding: 4px 8px 8px;
  }

  .bot-interaction-line {
    padding-left: 40px;
  }

  .bot-interaction-replies {
    padding-left: 50px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .bot-interaction-pulse {
    animation: none;
    opacity: 1;
  }
}
</style>
