<template>
  <div class="remote-poll" role="group" :aria-label="t('polls.remote.label')" data-testid="remote-poll" @click.stop>
    <div v-if="canVote && !showResults" class="remote-poll-hint">
      {{ poll.multiple ? t('polls.selectMultiple') : t('polls.selectOne') }}
    </div>

    <ul v-if="showResults" class="remote-poll-options">
      <li
        v-for="(option, index) in poll.options"
        :key="index"
        class="remote-poll-option"
        :class="{ 'is-leading': option.votes > 0 && option.votes === topVotes, 'is-mine': mine.has(index) }"
        :title="t('polls.votes', { count: option.votes }, option.votes)"
        data-testid="remote-poll-result"
      >
        <span class="remote-poll-fill" :style="{ width: option.percent + '%' }" aria-hidden="true" />
        <span class="remote-poll-percent">{{ option.percent }}%</span>
        <span class="remote-poll-text">{{ option.name }}</span>
        <Icon v-if="mine.has(index)" name="check" :size="14" class="remote-poll-check" aria-hidden="true" />
        <span class="sr-only">
          , {{ t('polls.votes', { count: option.votes }, option.votes) }}<template v-if="mine.has(index)">, {{ t('polls.remote.yourAnswer') }}</template>
        </span>
      </li>
    </ul>

    <div v-else class="remote-poll-choices" :role="poll.multiple ? 'group' : 'radiogroup'">
      <button
        v-for="(option, index) in poll.options"
        :key="index"
        type="button"
        class="remote-poll-choice"
        :class="{ 'is-selected': selected.includes(index) }"
        :role="poll.multiple ? 'checkbox' : 'radio'"
        :aria-checked="selected.includes(index)"
        :disabled="!canVote || voting"
        data-testid="remote-poll-option"
        @click="toggle(index)"
      >
        <span class="remote-poll-mark" :class="poll.multiple ? 'is-box' : 'is-round'" aria-hidden="true">
          <Icon v-if="selected.includes(index)" name="check" :size="12" />
        </span>
        <span class="remote-poll-text">{{ option.name }}</span>
      </button>
    </div>

    <div class="remote-poll-footer">
      <button
        v-if="canVote && !showResults"
        type="button"
        class="remote-poll-vote"
        :disabled="selected.length === 0 || voting"
        data-testid="remote-poll-vote"
        @click="vote"
      >
        {{ t('polls.remote.vote') }}
      </button>
      <span data-testid="remote-poll-voters">{{ votersLabel }}</span>
      <span aria-hidden="true">·</span>
      <span>{{ endLabel }}</span>
      <button
        v-if="canVote"
        type="button"
        class="remote-poll-link"
        data-testid="remote-poll-results"
        @click="peek = !peek"
      >
        {{ peek ? t('polls.hideResults') : t('polls.showResults') }}
      </button>
      <a
        v-if="!postId && !poll.closed && voteHref"
        :href="voteHref"
        target="_blank"
        rel="noopener noreferrer"
        class="remote-poll-link remote-poll-external"
      >
        {{ t('polls.remote.voteOnOriginal') }}
        <Icon name="external-link" :size="12" />
      </a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { pollTimeLeft } from '@/utils/messagePoll'
import { remotePollFromMetadata, type RemotePoll } from '@/utils/remotePoll'
import { safeHref } from '@/utils/sanitize'
import { myRemotePollChoices, remotePollErrorCode, voteRemotePoll } from '@/services/RemotePollService'
import { debug } from '@/utils/debug'

const props = defineProps<{
  /** The post's metadata; the card renders only when it carries a poll. */
  metadata: Record<string, any>
  /** The post on its origin server. */
  originalUrl?: string | null
  /** The poll's post here; votes are cast on it. Without one the card only shows the counts. */
  postId?: string | null
}>()

const { t } = useI18n()
const toast = useToast()
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

// Counts returned by the caller's vote, until the post's metadata changes.
const voted = ref<Record<string, any> | null>(null)
// The caller's answers; null until read.
const myChoices = ref<number[] | null>(null)
const selected = ref<number[]>([])
const voting = ref(false)
// Results before voting.
const peek = ref(false)

const poll = computed<RemotePoll>(() => remotePollFromMetadata(voted.value ?? props.metadata, now.value) ?? {
  multiple: false, options: [], voters: 0, votersReported: false, endTime: null, closed: true,
})
const mine = computed(() => new Set(myChoices.value ?? []))
const hasVoted = computed(() => mine.value.size > 0)
const canVote = computed(() => !!props.postId && myChoices.value !== null && !hasVoted.value && !poll.value.closed)
const showResults = computed(() => !props.postId || poll.value.closed || hasVoted.value || peek.value)
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

function toggle(index: number) {
  if (!canVote.value || voting.value) return
  if (!poll.value.multiple) {
    selected.value = [index]
    return
  }
  selected.value = selected.value.includes(index)
    ? selected.value.filter((i) => i !== index)
    : [...selected.value, index].sort((a, b) => a - b)
}

async function vote() {
  const postId = props.postId
  if (!postId || !canVote.value || selected.value.length === 0) return
  voting.value = true
  const choices = [...selected.value]
  try {
    voted.value = await voteRemotePoll(postId, choices)
    myChoices.value = choices
    peek.value = false
  } catch (error) {
    debug.warn('Remote poll vote failed:', error)
    const code = remotePollErrorCode(error)
    if (code === 'POLL_ALREADY_VOTED') {
      myChoices.value = await myRemotePollChoices(postId)
      toast.error(t('polls.errors.alreadyVoted'))
    } else if (code === 'POLL_CLOSED') {
      voted.value = { ...(voted.value ?? props.metadata), poll_closed: true }
      toast.error(t('polls.errors.closed'))
    } else {
      toast.error(t('polls.errors.voteFailed'))
    }
  } finally {
    voting.value = false
  }
}

watch(() => props.metadata, () => { voted.value = null })
watch(() => props.postId, async (postId) => {
  myChoices.value = null
  selected.value = []
  if (postId) myChoices.value = await myRemotePollChoices(postId)
}, { immediate: true })

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

.remote-poll-hint {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.remote-poll-options,
.remote-poll-choices {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.remote-poll-option,
.remote-poll-choice {
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

.remote-poll-option.is-mine,
.remote-poll-choice.is-selected {
  border-color: var(--harmony-primary);
}

.remote-poll-choice {
  width: 100%;
  text-align: left;
  background: var(--background-tertiary);
  cursor: pointer;
  font: inherit;
  transition: border-color var(--transition-fast);
}

.remote-poll-choice:hover:not(:disabled) {
  border-color: var(--harmony-primary);
}

.remote-poll-choice:disabled {
  cursor: default;
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
.remote-poll-text,
.remote-poll-check,
.remote-poll-mark {
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

.remote-poll-check {
  flex-shrink: 0;
  color: var(--text-link);
}

.remote-poll-mark {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--text-muted);
  color: var(--text-on-primary);
}

.remote-poll-mark.is-round {
  border-radius: var(--radius-full);
}

.remote-poll-mark.is-box {
  border-radius: var(--radius-sm);
}

.remote-poll-choice.is-selected .remote-poll-mark {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
}

.remote-poll-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.remote-poll-vote {
  padding: 4px 14px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.remote-poll-vote:disabled {
  opacity: 0.5;
  cursor: default;
}

.remote-poll-link {
  padding: 0;
  background: none;
  border: none;
  font: inherit;
  color: var(--text-link);
  text-decoration: none;
  cursor: pointer;
}

.remote-poll-external {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.remote-poll-link:hover {
  text-decoration: underline;
}
</style>
