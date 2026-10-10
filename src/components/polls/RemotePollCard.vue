<template>
  <div class="remote-poll" role="group" data-testid="remote-poll" @click.stop>
    <ul class="remote-poll-options">
      <li
        v-for="(option, index) in poll.options"
        :key="index"
        class="remote-poll-option"
        :class="{ 'is-leading': option.votes > 0 && option.votes === topVotes }"
        :title="t('polls.votes', { count: option.votes }, option.votes)"
      >
        <span class="remote-poll-fill" :style="{ width: option.percent + '%' }" aria-hidden="true" />
        <span class="remote-poll-percent">{{ option.percent }}%</span>
        <span class="remote-poll-text">{{ option.name }}</span>
      </li>
    </ul>
    <div class="remote-poll-footer">
      <span data-testid="remote-poll-voters">{{ votersLabel }}</span>
      <span aria-hidden="true">·</span>
      <span>{{ endLabel }}</span>
      <a
        v-if="!poll.closed && voteHref"
        :href="voteHref"
        target="_blank"
        rel="noopener noreferrer"
        class="remote-poll-link"
      >
        {{ t('polls.remote.voteOnOriginal') }}
        <Icon name="external-link" :size="12" />
      </a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { pollTimeLeft } from '@/utils/messagePoll'
import { remotePollFromMetadata, type RemotePoll } from '@/utils/remotePoll'
import { safeHref } from '@/utils/sanitize'

const props = defineProps<{
  /** The post's metadata; the card renders only when it carries a poll. */
  metadata: Record<string, any>
  /** The post on its origin server, where votes are cast. */
  originalUrl?: string | null
}>()

const { t } = useI18n()
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

const poll = computed<RemotePoll>(() => remotePollFromMetadata(props.metadata, now.value) ?? {
  multiple: false, options: [], voters: 0, votersReported: false, endTime: null, closed: true,
})
const topVotes = computed(() => Math.max(0, ...poll.value.options.map((o) => o.votes)))
const voteHref = computed(() => safeHref(props.originalUrl ?? undefined))

const votersLabel = computed(() => poll.value.votersReported
  ? t('polls.remote.voters', { count: poll.value.voters }, poll.value.voters)
  : t('polls.votes', { count: poll.value.voters }, poll.value.voters))

const endLabel = computed(() => {
  if (poll.value.closed) return t('polls.closed')
  const left = pollTimeLeft(poll.value.endTime, now.value)
  return left ? t(`polls.timeLeft.${left.unit}`, { count: left.value }, left.value) : ''
})

onMounted(() => {
  clock = setInterval(() => { now.value = Date.now() }, 60_000)
})
onUnmounted(() => {
  if (clock) clearInterval(clock)
})
</script>

<style scoped>
.remote-poll {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  cursor: default;
}

.remote-poll-options {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.remote-poll-option {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 34px;
  padding: 6px 12px;
  overflow: hidden;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  color: var(--text-primary);
}

.remote-poll-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: color-mix(in srgb, var(--harmony-primary) 18%, transparent);
  pointer-events: none;
}

.remote-poll-option.is-leading .remote-poll-fill {
  background: color-mix(in srgb, var(--harmony-primary) 30%, transparent);
}

.remote-poll-percent,
.remote-poll-text {
  position: relative;
}

.remote-poll-percent {
  flex-shrink: 0;
  min-width: 40px;
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.remote-poll-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.remote-poll-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.remote-poll-link {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--harmony-primary);
  text-decoration: none;
}

.remote-poll-link:hover {
  text-decoration: underline;
}
</style>
