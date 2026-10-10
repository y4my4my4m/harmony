<template>
  <div class="poll-card" role="group" :aria-label="question" data-testid="poll-card">
    <div class="poll-header">
      <Icon name="bar-chart-2" :size="16" class="poll-icon" aria-hidden="true" />
      <span class="poll-question">{{ question }}</span>
    </div>
    <div v-if="!closed && !unavailable" class="poll-hint">
      {{ allowMultiple ? t('polls.selectMultiple') : t('polls.selectOne') }}
    </div>

    <div class="poll-options" :role="allowMultiple ? 'group' : 'radiogroup'">
      <button
        v-for="option in options"
        :key="option.key"
        type="button"
        class="poll-option"
        :class="{ 'is-mine': option.mine, 'is-leading': showResults && option.leading }"
        :role="allowMultiple ? 'checkbox' : 'radio'"
        :aria-checked="option.mine"
        :disabled="!canVote"
        :title="showResults ? t('polls.votes', { count: option.votes }, option.votes) : undefined"
        data-testid="poll-option"
        @click="choose(option.id)"
      >
        <span
          v-if="showResults"
          class="poll-option-fill"
          :style="{ width: option.percent + '%' }"
          aria-hidden="true"
        />
        <span class="poll-option-mark" :class="allowMultiple ? 'is-box' : 'is-round'" aria-hidden="true">
          <Icon v-if="option.mine" name="check" :size="12" />
        </span>
        <span class="poll-option-text">{{ option.text }}</span>
        <span v-if="showResults" class="poll-option-percent">{{ option.percent }}%</span>
      </button>
    </div>

    <div class="poll-footer">
      <span v-if="unavailable" class="poll-status">{{ t('polls.unavailable') }}</span>
      <template v-else-if="state">
        <span class="poll-status" data-testid="poll-voters">{{ t('polls.votes', { count: state.totalVoters }, state.totalVoters) }}</span>
        <span class="poll-dot" aria-hidden="true">·</span>
        <span class="poll-status">{{ endLabel }}</span>
        <button
          v-if="!closed && hasVoted"
          type="button"
          class="poll-link"
          data-testid="poll-remove-vote"
          @click="removeVote"
        >{{ t('polls.removeVote') }}</button>
        <button
          v-else-if="!closed"
          type="button"
          class="poll-link"
          @click="peek = !peek"
        >{{ peek ? t('polls.hideResults') : t('polls.showResults') }}</button>
        <button
          v-if="!closed && state.isAuthor"
          type="button"
          class="poll-link"
          data-testid="poll-end"
          @click="endPoll"
        >{{ t('polls.end') }}</button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import type { PollContent } from '@/types'
import { useMessagePollsStore } from '@/stores/useMessagePolls'
import { pollErrorCode } from '@/services/MessagePollService'
import { pollPercent, pollTimeLeft } from '@/utils/messagePoll'
import { debug } from '@/utils/debug'

const props = defineProps<{
  poll: PollContent
  messageId: string
}>()

const { t } = useI18n()
const toast = useToast()
const store = useMessagePollsStore()

const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
// Results stay hidden until the caller votes, the poll ends, or this is set.
const peek = ref(false)

// A poll part naming another message's poll is not this message's poll.
const state = computed(() => {
  const s = store.get(props.poll.pollId)
  return s && s.messageId === props.messageId ? s : undefined
})
const unavailable = computed(() =>
  store.isUnavailable(props.poll.pollId) || (!!store.get(props.poll.pollId) && !state.value))

const question = computed(() => state.value?.question ?? props.poll.question)
const allowMultiple = computed(() => state.value?.allowMultiple ?? props.poll.allowMultiple === true)
const expiresAt = computed(() => state.value?.expiresAt ?? props.poll.expiresAt ?? null)
const closed = computed(() => {
  if (state.value?.closed) return true
  const end = expiresAt.value ? Date.parse(expiresAt.value) : NaN
  return !Number.isNaN(end) && end <= now.value
})
const hasVoted = computed(() => (state.value?.myOptionIds.length ?? 0) > 0)
const showResults = computed(() => !!state.value && (hasVoted.value || closed.value || peek.value))
const canVote = computed(() => !!state.value && !closed.value && !unavailable.value)

const options = computed(() => {
  const s = state.value
  if (!s) {
    return (props.poll.options ?? []).map((text, i) => ({
      key: `${i}`, id: '', text, votes: 0, percent: 0, mine: false, leading: false,
    }))
  }
  const mine = new Set(s.myOptionIds)
  const top = Math.max(0, ...s.options.map((o) => o.votes))
  return s.options.map((o) => ({
    key: o.id,
    id: o.id,
    text: o.text,
    votes: o.votes,
    percent: pollPercent(o.votes, s.totalVoters),
    mine: mine.has(o.id),
    leading: top > 0 && o.votes === top,
  }))
})

const endLabel = computed(() => {
  if (closed.value) return t('polls.closed')
  const left = pollTimeLeft(expiresAt.value, now.value)
  return left ? t(`polls.timeLeft.${left.unit}`, { count: left.value }, left.value) : ''
})

async function submit(optionIds: string[]) {
  try {
    await store.vote(props.poll.pollId, optionIds)
  } catch (error) {
    debug.warn('Poll vote failed:', error)
    toast.error(pollErrorCode(error) === 'POLL_CLOSED' ? t('polls.errors.closed') : t('polls.errors.voteFailed'))
  }
}

function choose(optionId: string) {
  const s = state.value
  if (!s || !optionId || !canVote.value) return
  if (!s.allowMultiple) {
    if (s.myOptionIds.length === 1 && s.myOptionIds[0] === optionId) return
    void submit([optionId])
    return
  }
  const next = s.myOptionIds.includes(optionId)
    ? s.myOptionIds.filter((id) => id !== optionId)
    : [...s.myOptionIds, optionId]
  void submit(next)
}

function removeVote() {
  peek.value = false
  void submit([])
}

async function endPoll() {
  try {
    await store.end(props.poll.pollId)
  } catch (error) {
    debug.warn('Ending the poll failed:', error)
    toast.error(t('polls.errors.endFailed'))
  }
}

watch(() => props.poll.pollId, (id) => store.request(id), { immediate: true })

onMounted(() => {
  clock = setInterval(() => { now.value = Date.now() }, 30_000)
})
onUnmounted(() => {
  if (clock) clearInterval(clock)
})
</script>

<style scoped>
.poll-card {
  margin: 4px 0;
  padding: 12px 14px;
  max-width: 440px;
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.poll-header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.poll-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--harmony-primary);
}

.poll-question {
  font-weight: 600;
  color: var(--text-primary);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.poll-hint {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.poll-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.poll-option {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 38px;
  padding: 8px 12px;
  overflow: hidden;
  text-align: left;
  color: var(--text-primary);
  background: var(--background-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  cursor: pointer;
  font: inherit;
  transition: border-color var(--transition-fast), background-color var(--transition-fast);
}

.poll-option:hover:not(:disabled) {
  border-color: var(--harmony-primary);
}

.poll-option:disabled {
  cursor: default;
}

.poll-option.is-mine {
  border-color: var(--harmony-primary);
}

.poll-option-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: color-mix(in srgb, var(--harmony-primary) 18%, transparent);
  transition: width 0.3s ease;
  pointer-events: none;
}

.poll-option.is-leading .poll-option-fill {
  background: color-mix(in srgb, var(--harmony-primary) 30%, transparent);
}

.poll-option-mark,
.poll-option-text,
.poll-option-percent {
  position: relative;
}

.poll-option-mark {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--text-muted);
  color: var(--text-on-primary);
}

.poll-option-mark.is-round {
  border-radius: var(--radius-full);
}

.poll-option-mark.is-box {
  border-radius: var(--radius-sm);
}

.poll-option.is-mine .poll-option-mark {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
}

.poll-option-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.poll-option-percent {
  flex-shrink: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-secondary);
}

.poll-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.poll-link {
  padding: 0;
  background: none;
  border: none;
  font: inherit;
  color: var(--harmony-primary);
  cursor: pointer;
}

.poll-link:hover {
  text-decoration: underline;
}

.poll-footer .poll-link:first-of-type {
  margin-left: auto;
}
</style>
