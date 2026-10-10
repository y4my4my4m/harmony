<template>
  <BaseModal
    :show="show"
    :title="t('polls.createTitle')"
    icon="bar-chart-2"
    compact
    @close="close"
  >
    <form class="poll-form" data-testid="poll-create-form" @submit.prevent="submit">
      <label class="poll-field-label" for="poll-question">{{ t('polls.question') }}</label>
      <input
        id="poll-question"
        ref="questionRef"
        v-model="question"
        class="poll-input"
        type="text"
        :maxlength="POLL_QUESTION_MAX"
        :placeholder="t('polls.questionPlaceholder')"
        data-testid="poll-question"
      />

      <span class="poll-field-label">{{ t('polls.answers') }}</span>
      <div class="poll-answers">
        <div v-for="(_, index) in answers" :key="answerKeys[index]" class="poll-answer-row">
          <input
            :ref="(el) => setAnswerRef(el, index)"
            v-model="answers[index]"
            class="poll-input"
            type="text"
            :maxlength="POLL_ANSWER_MAX"
            :placeholder="t('polls.answerPlaceholder', { n: index + 1 })"
            data-testid="poll-answer"
            @keydown.enter.prevent="onAnswerEnter(index)"
          />
          <button
            v-if="answers.length > POLL_MIN_ANSWERS"
            type="button"
            class="poll-answer-remove"
            :aria-label="t('polls.removeAnswer')"
            :title="t('polls.removeAnswer')"
            data-testid="poll-answer-remove"
            @click="removeAnswer(index)"
          >
            <Icon name="x" :size="16" />
          </button>
        </div>
        <button
          v-if="answers.length < POLL_MAX_ANSWERS"
          type="button"
          class="poll-add-answer"
          data-testid="poll-add-answer"
          @click="addAnswer"
        >
          <Icon name="plus" :size="14" />
          {{ t('polls.addAnswer') }}
        </button>
      </div>

      <div class="poll-settings">
        <label class="poll-setting">
          <span>{{ t('polls.duration') }}</span>
          <select v-model.number="durationHours" class="poll-input poll-select" data-testid="poll-duration">
            <option v-for="hours in POLL_DURATION_HOURS" :key="hours" :value="hours">
              {{ t(`polls.durations.h${hours}`) }}
            </option>
          </select>
        </label>
        <div class="poll-setting">
          <span>{{ t('polls.allowMultiple') }}</span>
          <ToggleSwitch v-model="allowMultiple" data-testid="poll-allow-multiple" />
        </div>
      </div>

      <p v-if="error" class="poll-error" role="alert" data-testid="poll-error">{{ error }}</p>
    </form>

    <template #footer>
      <div class="poll-actions">
        <UnifiedButton variant="ghost" :text="t('common.cancel')" @click="close" />
        <UnifiedButton
          variant="primary"
          :text="t('polls.post')"
          :disabled="!!problem"
          :loading="posting"
          data-testid="poll-post"
          @click="submit"
        />
      </div>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '@/components/common/BaseModal.vue'
import Icon from '@/components/common/Icon.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import UnifiedButton from '@/components/shared/UnifiedButton.vue'
import { createMessagePoll, pollErrorCode } from '@/services/MessagePollService'
import { blockedMessageRejection, moderationRejectionFromError } from '@/services/AutoModService'
import {
  POLL_ANSWER_MAX,
  POLL_DEFAULT_DURATION_HOURS,
  POLL_DURATION_HOURS,
  POLL_MAX_ANSWERS,
  POLL_MIN_ANSWERS,
  POLL_QUESTION_MAX,
  normalizePollAnswers,
  pollDraftProblem,
} from '@/utils/messagePoll'
import { debug } from '@/utils/debug'

const props = defineProps<{
  show: boolean
  channelId?: string | null
  conversationId?: string | null
  replyTo?: string | null
}>()

const emit = defineEmits<{
  close: []
  /** The message row create_message_poll returned. */
  created: [message: Record<string, any>]
}>()

const { t } = useI18n()

const question = ref('')
const answers = ref<string[]>(['', ''])
let nextKey = 0
const answerKeys = ref<number[]>([nextKey++, nextKey++])
const allowMultiple = ref(false)
const durationHours = ref<number>(POLL_DEFAULT_DURATION_HOURS)
const posting = ref(false)
const error = ref('')
const questionRef = ref<HTMLInputElement | null>(null)
const answerRefs: Array<HTMLInputElement | null> = []

const problem = computed(() => pollDraftProblem(question.value, answers.value))

function setAnswerRef(el: Element | ComponentPublicInstance | null, index: number) {
  answerRefs[index] = el as HTMLInputElement | null
}

function reset() {
  question.value = ''
  answers.value = ['', '']
  answerKeys.value = [nextKey++, nextKey++]
  allowMultiple.value = false
  durationHours.value = POLL_DEFAULT_DURATION_HOURS
  error.value = ''
  posting.value = false
}

watch(() => props.show, (visible) => {
  if (!visible) return
  reset()
  void nextTick(() => questionRef.value?.focus())
}, { immediate: true })

watch([question, answers], () => { error.value = '' }, { deep: true })

function addAnswer() {
  if (answers.value.length >= POLL_MAX_ANSWERS) return
  answers.value.push('')
  answerKeys.value.push(nextKey++)
  const index = answers.value.length - 1
  void nextTick(() => answerRefs[index]?.focus())
}

function removeAnswer(index: number) {
  if (answers.value.length <= POLL_MIN_ANSWERS) return
  answers.value.splice(index, 1)
  answerKeys.value.splice(index, 1)
}

function onAnswerEnter(index: number) {
  if (index === answers.value.length - 1 && answers.value[index].trim() && answers.value.length < POLL_MAX_ANSWERS) {
    addAnswer()
  } else if (index < answers.value.length - 1) {
    answerRefs[index + 1]?.focus()
  } else {
    void submit()
  }
}

function close() {
  if (!posting.value) emit('close')
}

async function describeFailure(err: any): Promise<string> {
  const code = pollErrorCode(err)
  if (code === 'POLL_ENCRYPTED') return t('polls.errors.encrypted')
  if (code === 'POLL_QUESTION_INVALID') return t('polls.errors.question')
  if (code === 'POLL_OPTIONS_INVALID') return t('polls.errors.answers')
  const raw = [err?.code, err?.message].filter((v) => typeof v === 'string').join(' ')
  const slowmode = /SLOWMODE_ACTIVE:(\d+)/.exec(raw)
  if (slowmode) {
    const seconds = parseInt(slowmode[1], 10)
    window.dispatchEvent(new CustomEvent('harmony:slowmode-hit', {
      detail: { seconds, channelId: props.channelId ?? undefined },
    }))
    return t('polls.errors.slowmode', { seconds })
  }
  if (raw.includes('RECIPIENT_DELETED')) return t('dm.recipientDeleted')
  const moderation = moderationRejectionFromError(err)
  if (moderation) return moderation.message
  return t('polls.errors.createFailed')
}

async function submit() {
  if (posting.value) return
  const issue = problem.value
  if (issue) {
    error.value = t(`polls.errors.${issue}`)
    return
  }
  posting.value = true
  error.value = ''
  try {
    const message = await createMessagePoll({
      channelId: props.channelId ?? null,
      conversationId: props.conversationId ?? null,
      question: question.value.trim(),
      answers: normalizePollAnswers(answers.value),
      allowMultiple: allowMultiple.value,
      durationHours: durationHours.value,
      replyTo: props.replyTo ?? null,
    })
    if (!message) {
      // AutoMod dropped the poll and recorded why.
      error.value = (await blockedMessageRejection(props.channelId)).message
      return
    }
    emit('created', message)
  } catch (err) {
    debug.warn('Poll creation failed:', err)
    error.value = await describeFailure(err)
  } finally {
    posting.value = false
  }
}
</script>

<style scoped>
.poll-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.poll-field-label {
  font-size: var(--font-size-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
  margin-top: 8px;
}

.poll-input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 12px;
  background: var(--input-bg, var(--background-tertiary));
  border: 1px solid var(--input-border, var(--border-primary));
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
}

.poll-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.poll-answers {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.poll-answer-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.poll-answer-remove {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-muted);
  cursor: pointer;
}

.poll-answer-remove:hover {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.poll-add-answer {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: transparent;
  border: 1px dashed var(--border-primary);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.poll-add-answer:hover {
  color: var(--text-primary);
  border-color: var(--harmony-primary);
}

.poll-settings {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}

.poll-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.poll-select {
  width: auto;
  min-width: 140px;
}

.poll-error {
  margin: 8px 0 0;
  font-size: var(--font-size-sm);
  color: var(--error);
}

.poll-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

@media (max-width: 480px) {
  .poll-actions {
    flex-direction: column-reverse;
    gap: 8px;
  }
}
</style>
