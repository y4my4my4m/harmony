<!--
  Confirmation of an instance staff action on a server hosted here: who acts, what happens
  and to whom, where it is recorded, and an optional reason. `confirmText` makes the confirm
  button wait until that text is typed.
-->
<template>
  <BaseModal
    :show="show"
    :title="title"
    icon="shield"
    role="alertdialog"
    compact
    overlay-class="staff-action-dialog"
    @close="cancel"
  >
    <div class="staff-dialog" data-testid="staff-action-dialog">
      <p class="staff-pill"><Icon name="shield" :size="14" />{{ staffLabel }}</p>
      <p class="staff-scope">{{ scopeLine }}</p>
      <ul class="staff-consequences">
        <li v-for="(line, i) in consequences" :key="i">{{ line }}</li>
      </ul>
      <p class="staff-record"><Icon name="list" :size="14" />{{ recordLine }}</p>

      <label class="staff-field" :for="`${uid}-reason`">
        <span class="staff-label">{{ t('hostStaff.confirm.reason') }}</span>
        <textarea
          :id="`${uid}-reason`"
          v-model="reason"
          class="staff-input"
          rows="2"
          maxlength="512"
          :aria-describedby="reasonHint ? `${uid}-reason-hint` : undefined"
          data-testid="staff-action-reason"
        />
        <span v-if="reasonHint" :id="`${uid}-reason-hint`" class="staff-hint">{{ reasonHint }}</span>
      </label>

      <label v-if="confirmText" class="staff-field" :for="`${uid}-confirm`">
        <span class="staff-label">{{ t('hostStaff.confirm.delete.typeName') }}</span>
        <input
          :id="`${uid}-confirm`"
          v-model="typed"
          class="staff-input"
          type="text"
          autocomplete="off"
          :placeholder="confirmText"
          data-testid="staff-action-typed"
        />
      </label>

      <p v-if="error" class="staff-error" role="alert">{{ error }}</p>
    </div>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="cancel">{{ t('common.cancel') }}</button>
      <button
        type="button"
        class="btn"
        :class="danger ? 'btn-danger' : 'btn-primary'"
        :disabled="busy || !typedOk"
        :aria-busy="busy || undefined"
        data-testid="staff-action-confirm"
        @click="emit('confirm', reason.trim())"
      >{{ confirmLabel }}</button>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'

const props = withDefaults(defineProps<{
  show: boolean
  title: string
  /** "{instance} staff". */
  staffLabel: string
  /** Who acts and in which capacity. */
  scopeLine: string
  consequences: string[]
  /** Where the action is recorded. */
  recordLine: string
  confirmLabel: string
  reasonHint?: string
  danger?: boolean
  confirmText?: string
  busy?: boolean
  error?: string
}>(), {
  reasonHint: '',
  danger: true,
  confirmText: '',
  busy: false,
  error: '',
})

const emit = defineEmits<{
  confirm: [reason: string]
  close: []
}>()

const { t } = useT()
const uid = `staff-${useId()}`
const reason = ref('')
const typed = ref('')

const typedOk = computed(() => !props.confirmText || typed.value.trim() === props.confirmText.trim())

watch(() => props.show, (open) => {
  if (open) {
    reason.value = ''
    typed.value = ''
  }
})

function cancel() {
  if (!props.busy) emit('close')
}
</script>

<style scoped>
.staff-dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.staff-pill {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--warning, #f0b232);
  color: var(--text-primary);
  background: color-mix(in srgb, var(--warning, #f0b232) 14%, transparent);
  font-size: 12px;
  font-weight: 600;
}

.staff-scope {
  margin: 0;
  color: var(--text-secondary);
  font-size: 14px;
}

.staff-consequences {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.45;
}

.staff-record {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.45;
}

.staff-record :deep(svg) {
  flex-shrink: 0;
  margin-top: 2px;
}

.staff-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.staff-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
}

.staff-input {
  width: 100%;
  padding: 10px 12px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font: inherit;
  font-size: 14px;
  resize: vertical;
}

.staff-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
  box-shadow: 0 0 0 2px var(--harmony-primary-alpha-strong);
}

.staff-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.staff-error {
  margin: 0;
  color: var(--text-danger);
  font-size: 13px;
}
</style>
