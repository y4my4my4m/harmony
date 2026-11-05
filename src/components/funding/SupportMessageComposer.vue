<!--
  SupportMessageComposer - an optional public message, written before opening a payment link.
  set_supporter_message keeps it for the donor's next donation within 24 hours; an admin
  approves it before others see it. The rules shown while typing are the database's
  (utils/supporterMessage.ts); its refusal is what counts. The parent calls saveIfChanged()
  when a payment link opens, so a typed message is kept without pressing Save.
-->
<template>
  <div class="support-note" :class="{ 'is-open': open }" data-testid="support-message">
    <button
      type="button"
      class="support-note__toggle"
      :aria-expanded="open"
      :aria-controls="bodyId"
      data-testid="support-message-toggle"
      @click="open = !open"
    >
      <Icon name="message-circle" :size="16" class="support-note__icon" aria-hidden="true" />
      <span class="support-note__title">{{ t('support.message.title') }}</span>
      <span class="support-note__optional">{{ t('support.message.optional') }}</span>
      <Icon name="chevron-down" :size="14" class="support-note__chevron" aria-hidden="true" />
    </button>
    <div v-show="open" :id="bodyId" class="support-note__body">
      <label :for="inputId" class="sr-only">{{ t('support.message.label') }}</label>
      <div class="support-note__field" :class="{ 'is-invalid': !!shownProblem }">
        <input
          :id="inputId"
          v-model="body"
          type="text"
          class="support-note__input"
          :placeholder="t('support.message.placeholder')"
          autocomplete="off"
          enterkeyhint="done"
          :aria-invalid="shownProblem ? 'true' : undefined"
          :aria-describedby="`${counterId} ${hintId}${errorText ? ' ' + errorId : ''}`"
          data-testid="support-message-input"
          @keydown.enter.prevent="save"
        />
        <span :id="counterId" class="support-note__counter" :class="{ 'is-over': length > max }">
          {{ length }}/{{ max }}
        </span>
      </div>
      <label class="support-note__check">
        <input v-model="anonymous" type="checkbox" data-testid="support-message-anonymous" />
        <span>{{ t('support.message.anonymous') }}</span>
      </label>
      <p v-if="errorText" :id="errorId" class="support-note__error" role="alert" data-testid="support-message-error">
        {{ errorText }}
      </p>
      <p :id="hintId" class="support-note__hint">{{ t('support.message.help') }}</p>
      <div class="support-note__actions">
        <button
          type="button"
          class="support-note__save"
          :disabled="saving || !changed"
          data-testid="support-message-save"
          @click="save"
        >
          {{ t('support.message.save') }}
        </button>
        <span v-if="statusText" class="support-note__status" role="status" data-testid="support-message-status">
          <Icon name="check" :size="12" aria-hidden="true" />
          {{ statusText }}
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { uid } from '@/utils/a11y/focus'
import {
  SUPPORTER_MESSAGE_MAX,
  normalizeSupporterMessage,
  supporterMessageLength,
  supporterMessageProblem,
} from '@/utils/supporterMessage'
import {
  fundingService,
  SupporterMessageError,
  type MySupporterMessage,
} from '@/services/FundingService'
import { formatUntil } from './format'

const props = defineProps<{
  /** The donor's unattached message, if any. */
  pending: MySupporterMessage | null
}>()

const emit = defineEmits<{ saved: [message: MySupporterMessage] }>()

const { t, locale } = useT()
const max = SUPPORTER_MESSAGE_MAX
const bodyId = uid('support-note')
const inputId = uid('support-note-input')
const counterId = uid('support-note-counter')
const hintId = uid('support-note-hint')
const errorId = uid('support-note-error')

const open = ref(!!props.pending)
const body = ref(props.pending?.body ?? '')
const anonymous = ref(props.pending?.anonymous ?? false)
const saving = ref(false)
const serverProblem = ref<string | null>(null)

watch(() => props.pending?.id, () => {
  if (props.pending) {
    body.value = props.pending.body
    anonymous.value = props.pending.anonymous
  }
})

watch([body, anonymous], () => { serverProblem.value = null })

const length = computed(() => supporterMessageLength(body.value))
const problem = computed(() => supporterMessageProblem(body.value))
const shownProblem = computed(() => {
  if (serverProblem.value) return serverProblem.value
  if (problem.value === 'empty') return null
  return problem.value
})

const changed = computed(() => {
  const text = normalizeSupporterMessage(body.value)
  if (!text) return false
  return text !== props.pending?.body || anonymous.value !== props.pending?.anonymous
})

const ERROR_KEYS: Record<string, string> = {
  length: 'support.message.errors.length',
  control: 'support.message.errors.control',
  bidi: 'support.message.errors.bidi',
  marks: 'support.message.errors.marks',
  disabled: 'support.message.errors.disabled',
}

const errorText = computed(() => {
  const p = shownProblem.value
  if (!p) return ''
  return t(ERROR_KEYS[p] ?? 'support.message.errors.failed', { max })
})

const statusText = computed(() => {
  if (!props.pending || changed.value) return ''
  return t('support.message.saved', {
    time: props.pending.expires_at ? formatUntil(props.pending.expires_at, locale.value) : '',
  })
})

async function save(): Promise<boolean> {
  if (!changed.value) return !!props.pending
  if (problem.value) {
    serverProblem.value = problem.value === 'empty' ? null : problem.value
    return false
  }
  saving.value = true
  try {
    const saved = await fundingService.setSupporterMessage(body.value, anonymous.value)
    emit('saved', saved)
    return true
  } catch (err) {
    serverProblem.value = err instanceof SupporterMessageError ? err.reason : 'failed'
    return false
  } finally {
    saving.value = false
  }
}

/** Saves a typed, valid message that differs from the stored one. */
function saveIfChanged(): void {
  if (changed.value && !problem.value) void save()
}

defineExpose({ saveIfChanged })
</script>

<style scoped>
.support-note {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.support-note__toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 44px;
  padding: var(--space-2) var(--space-4);
  background: none;
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.support-note__toggle:hover {
  background: var(--background-modifier-hover);
}

.support-note__toggle:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}

.support-note__icon {
  flex-shrink: 0;
  color: var(--text-link);
}

.support-note__title {
  min-width: 0;
}

.support-note__optional {
  flex: 1;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-normal);
  color: var(--text-secondary);
}

.support-note__chevron {
  flex-shrink: 0;
  color: var(--text-secondary);
}

@media (prefers-reduced-motion: no-preference) {
  .support-note__chevron {
    transition: transform var(--transition-fast);
  }
}

.support-note.is-open .support-note__chevron {
  transform: rotate(180deg);
}

.support-note__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0 var(--space-4) var(--space-4);
}

.support-note__field {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-3);
  background: var(--surface-inset, var(--background-tertiary));
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.support-note__field:focus-within {
  border-color: var(--harmony-primary);
}

.support-note__field.is-invalid {
  border-color: var(--danger);
}

.support-note__input {
  flex: 1;
  min-width: 0;
  min-height: 40px;
  padding: 0;
  background: transparent;
  border: none;
  outline: none;
  font: inherit;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.support-note__counter {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.support-note__counter.is-over {
  color: var(--text-danger);
  font-weight: var(--font-weight-semibold);
}

.support-note__check {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  cursor: pointer;
}

.support-note__check input {
  accent-color: var(--harmony-primary);
}

.support-note__hint,
.support-note__error {
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
}

.support-note__hint {
  color: var(--text-secondary);
}

.support-note__error {
  color: var(--text-danger);
}

.support-note__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.support-note__save {
  min-height: 32px;
  padding: 0 var(--space-3);
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  cursor: pointer;
}

.support-note__save:hover:not(:disabled) {
  border-color: var(--harmony-primary);
}

.support-note__save:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.support-note__save:disabled {
  cursor: default;
  opacity: 0.55;
}

.support-note__status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--text-success);
}
</style>
