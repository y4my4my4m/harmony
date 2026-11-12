<template>
  <div class="import-admin" data-testid="bridge-import-admin">
    <h4>{{ t('discordBridge.importAdmin.title') }}</h4>
    <p class="hint">{{ t('discordBridge.importAdmin.lead') }}</p>

    <p v-if="loadError" class="error" role="alert">{{ t('discordBridge.importAdmin.loadFailed') }}</p>

    <div class="field">
      <label :for="`${uid}-mode`" class="title">{{ t('discordBridge.importAdmin.mode') }}</label>
      <select
        :id="`${uid}-mode`"
        :value="mode"
        class="cyber-input mode-input"
        :disabled="!loaded || switching"
        :aria-describedby="`${uid}-mode-hint`"
        data-testid="import-mode"
        @change="setMode(($event.target as HTMLSelectElement).value as HistoryImportMode)"
      >
        <option value="off">{{ t('discordBridge.importAdmin.modeOff') }}</option>
        <option value="self_run">{{ t('discordBridge.importAdmin.modeSelfRun') }}</option>
      </select>
      <span :id="`${uid}-mode-hint`" class="hint">{{ t('discordBridge.importAdmin.modeHint') }}</span>
    </div>

    <div v-if="mode === 'self_run'" class="warning" role="note" data-testid="import-warning">
      <p>{{ t('discordBridge.importAdmin.warningTitle') }}</p>
      <ul>
        <li>{{ t('discordBridge.importAdmin.warningAuthors') }}</li>
        <li>{{ t('discordBridge.importAdmin.warningRequests') }}</li>
        <li>{{ t('discordBridge.importAdmin.warningQuiet') }}</li>
        <li>{{ t('discordBridge.importAdmin.warningStorage') }}</li>
      </ul>
    </div>

    <div v-for="field in fields" :key="field.key" class="field">
      <label :for="`${uid}-${field.key}`" class="title">{{ t(`discordBridge.importAdmin.${field.key}`) }}</label>
      <input
        :id="`${uid}-${field.key}`"
        v-model.number="draft[field.key]"
        type="number"
        min="0"
        step="1"
        inputmode="numeric"
        class="cyber-input limit-input"
        :disabled="!loaded || saving"
        :aria-describedby="`${uid}-${field.key}-hint`"
        :data-testid="`import-${field.key}`"
      />
      <span :id="`${uid}-${field.key}-hint`" class="hint">{{ t(`discordBridge.importAdmin.${field.key}Hint`) }}</span>
    </div>
    <span v-if="invalid" class="error" role="alert">{{ t('discordBridge.importAdmin.limitInvalid') }}</span>

    <button
      type="button"
      class="btn btn-primary"
      :disabled="!loaded || saving || !dirty || invalid"
      data-testid="import-save"
      @click="saveLimits"
    >
      {{ saving ? t('discordBridge.admin.saving') : t('discordBridge.importAdmin.save') }}
    </button>

    <p v-if="totalsText" class="hint totals" role="status" data-testid="import-totals">{{ totalsText }}</p>

    <div class="purge">
      <h5>{{ t('discordBridge.importAdmin.purgeTitle') }}</h5>
      <p class="hint">{{ t('discordBridge.importAdmin.purgeLead') }}</p>
      <div v-if="confirmingPurge" class="purge-confirm" role="alertdialog" :aria-labelledby="`${uid}-purge`" data-testid="instance-purge-confirm">
        <p :id="`${uid}-purge`">{{ t('discordBridge.importAdmin.purgeConfirm') }}</p>
        <div class="actions">
          <button type="button" class="btn btn-danger" :disabled="purging" data-testid="instance-purge-yes" @click="purge">
            {{ t('discordBridge.importAdmin.purgeYes') }}
          </button>
          <button type="button" class="btn btn-ghost" :disabled="purging" @click="confirmingPurge = false">
            {{ t('discordBridge.import.cancel') }}
          </button>
        </div>
      </div>
      <button v-else type="button" class="btn btn-danger" :disabled="!loaded || purging" data-testid="instance-purge" @click="confirmingPurge = true">
        {{ t('discordBridge.importAdmin.purge') }}
      </button>
      <p v-if="purged !== null" class="hint" role="status" aria-live="polite" data-testid="instance-purge-progress">
        {{ t('discordBridge.privacy.progress', { count: purged }, purged) }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import { formatBytes } from '@/utils/uploadValidation'
import {
  IMPORT_MAX_RUNNING_KEY,
  IMPORT_MODE_KEY,
  IMPORT_RATE_KEY,
  MIRROR_SERVER_LIMIT_KEY,
  fetchImportAdminConfig,
  fetchImportTotals,
  purgeInstanceBridgedMessages,
  saveBridgeInstanceConfig,
  type BridgeInstanceConfigKey,
  type HistoryImportMode,
  type ImportTotals,
} from './bridgeApi'

type LimitKey = 'maxRunning' | 'messagesPerMinute' | 'mirrorServerLimitMb'

const fields: Array<{ key: LimitKey; config: BridgeInstanceConfigKey }> = [
  { key: 'maxRunning', config: IMPORT_MAX_RUNNING_KEY },
  { key: 'messagesPerMinute', config: IMPORT_RATE_KEY },
  { key: 'mirrorServerLimitMb', config: MIRROR_SERVER_LIMIT_KEY },
]

const TOTALS_POLL_MS = 30_000

const { t } = useI18n()
const toast = useToast()
const uid = `bridge-import-admin-${useId()}`

const mode = ref<HistoryImportMode>('off')
const draft = reactive<Record<LimitKey, number>>({ maxRunning: 0, messagesPerMinute: 0, mirrorServerLimitMb: 0 })
const saved = reactive<Record<LimitKey, number>>({ maxRunning: 0, messagesPerMinute: 0, mirrorServerLimitMb: 0 })
const loaded = ref(false)
const loadError = ref(false)
const switching = ref(false)
const saving = ref(false)
const totals = ref<ImportTotals | null>(null)
const confirmingPurge = ref(false)
const purging = ref(false)
/** Messages removed so far by the running purge; null when none runs. */
const purged = ref<number | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

const invalid = computed(() => fields.some((f) => !Number.isInteger(draft[f.key]) || draft[f.key] < 0))
const dirty = computed(() => fields.some((f) => draft[f.key] !== saved[f.key]))

const totalsText = computed(() => {
  const s = totals.value
  if (!s) return ''
  const parts = [t('discordBridge.importAdmin.totals', { running: s.running, queued: s.queued, imported: s.imported })]
  if (s.storedBytes !== null) parts.push(t('discordBridge.importAdmin.totalsStored', { size: formatBytes(s.storedBytes) }))
  return parts.join(' · ')
})

/** Saved on change; the select returns to its previous value when the save fails. */
async function setMode(next: HistoryImportMode) {
  const previous = mode.value
  mode.value = next
  switching.value = true
  try {
    await saveBridgeInstanceConfig(IMPORT_MODE_KEY, next)
    toast.success(t('discordBridge.importAdmin.saved'))
  } catch (error) {
    mode.value = previous
    debug.error('Saving the history import switch failed:', error)
    toast.error(t('discordBridge.importAdmin.saveFailed'))
  } finally {
    switching.value = false
  }
}

async function saveLimits() {
  if (invalid.value) return
  saving.value = true
  try {
    for (const field of fields) {
      if (draft[field.key] === saved[field.key]) continue
      await saveBridgeInstanceConfig(field.config, draft[field.key])
      saved[field.key] = draft[field.key]
    }
    toast.success(t('discordBridge.importAdmin.saved'))
  } catch (error) {
    debug.error('Saving the history import limits failed:', error)
    toast.error(t('discordBridge.importAdmin.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function loadTotals() {
  try {
    totals.value = await fetchImportTotals()
  } catch (error) {
    debug.warn('bridge_import_status read failed:', error)
  }
}

async function purge() {
  confirmingPurge.value = false
  purging.value = true
  purged.value = 0
  try {
    const removed = await purgeInstanceBridgedMessages((total) => { purged.value = total })
    toast.success(t('discordBridge.privacy.purged', { count: removed }, removed))
  } catch (error) {
    debug.error('bridge_privacy_purge_instance failed:', error)
    toast.error(t('discordBridge.errors.privacy'))
  } finally {
    purged.value = null
    purging.value = false
  }
  await loadTotals()
}

onMounted(async () => {
  try {
    const config = await fetchImportAdminConfig()
    mode.value = config.mode
    for (const field of fields) draft[field.key] = saved[field.key] = config[field.key]
    loaded.value = true
  } catch (error) {
    debug.error('History import settings load failed:', error)
    loadError.value = true
  }
  await loadTotals()
  timer = setInterval(() => void loadTotals(), TOTALS_POLL_MS)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.import-admin {
  margin-top: 20px;
}

.import-admin h4,
.import-admin h5 {
  margin: 0 0 6px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 12px 0;
}

.title {
  font-weight: 600;
  color: var(--text-primary);
}

.hint {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.error {
  color: var(--error);
  font-size: 13px;
}

.mode-input {
  max-width: 320px;
}

.limit-input {
  max-width: 160px;
}

.warning {
  padding: 12px;
  margin: 12px 0;
  border-radius: 8px;
  border: 1px solid var(--warning);
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
}

.warning p {
  margin: 0 0 6px;
  font-weight: 600;
}

.warning ul {
  margin: 0;
  padding-left: 18px;
}

.totals {
  margin-top: 12px;
}

.purge {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--background-quaternary);
}

.purge-confirm {
  padding: 12px;
  margin: 8px 0;
  border-radius: 8px;
  border: 1px solid var(--error);
}

.purge-confirm p {
  margin: 0 0 8px;
}

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.purge .btn {
  margin-top: 8px;
}
</style>
