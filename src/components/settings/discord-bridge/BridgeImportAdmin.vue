<template>
  <div class="import-admin" data-testid="bridge-import-admin">
    <h4>{{ t('discordBridge.importAdmin.title') }}</h4>
    <p class="hint">{{ t('discordBridge.importAdmin.lead') }}</p>

    <p v-if="loadError" class="error" role="alert">{{ t('discordBridge.importAdmin.loadFailed') }}</p>

    <fieldset
      class="mode-field"
      :disabled="!loaded || purging"
      :aria-busy="switching"
      :aria-describedby="`${uid}-mode-hint`"
      data-testid="import-mode"
    >
      <legend class="title">{{ t('discordBridge.importAdmin.mode') }}</legend>
      <div class="mode-choices">
        <label
          v-for="choice in HISTORY_IMPORT_MODES"
          :key="choice"
          :class="['mode-choice', { selected: mode === choice }]"
          :data-testid="`import-mode-${choice}`"
        >
          <input
            type="radio"
            class="mode-radio"
            :name="`${uid}-mode`"
            :value="choice"
            :checked="mode === choice"
            @change="setMode(choice)"
          />
          <span class="mode-text">
            <span class="mode-name">{{ t(`discordBridge.importAdmin.modes.${choice}.label`) }}</span>
            <span class="mode-desc">{{ t(`discordBridge.importAdmin.modes.${choice}.hint`) }}</span>
          </span>
        </label>
      </div>
      <span :id="`${uid}-mode-hint`" class="hint">{{ t('discordBridge.importAdmin.modeHint') }}</span>
    </fieldset>

    <div v-if="mode !== 'off'" class="warning" role="note" data-testid="import-warning">
      <p>{{ t('discordBridge.importAdmin.warningTitle') }}</p>
      <ul>
        <li>{{ t('discordBridge.importAdmin.warningAuthors') }}</li>
        <li>{{ t('discordBridge.importAdmin.warningRequests') }}</li>
        <li>{{ t('discordBridge.importAdmin.warningQuiet') }}</li>
        <li>{{ t('discordBridge.importAdmin.warningStorage') }}</li>
        <li v-if="mode === 'all'" data-testid="import-warning-instance-bot">{{ t('discordBridge.importAdmin.warningInstanceBot') }}</li>
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
  HISTORY_IMPORT_MODES,
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

/**
 * Saved on change. Saves run one after another in the order chosen, so arrowing through the
 * choices leaves the last one stored; when the last save fails, the choice returns to the
 * value last stored. The choices stay enabled meanwhile: a keyboard user keeps focus.
 */
let modeSaves: Promise<void> = Promise.resolve()
let modeSeq = 0
let storedMode: HistoryImportMode = 'off'

function setMode(next: HistoryImportMode) {
  if (next === mode.value) return
  mode.value = next
  const seq = ++modeSeq
  switching.value = true
  modeSaves = modeSaves.then(async () => {
    try {
      await saveBridgeInstanceConfig(IMPORT_MODE_KEY, next)
      storedMode = next
      if (seq === modeSeq) toast.success(t('discordBridge.importAdmin.saved'))
    } catch (error) {
      debug.error('Saving the history import switch failed:', error)
      if (seq === modeSeq) {
        mode.value = storedMode
        toast.error(t('discordBridge.importAdmin.saveFailed'))
      }
    } finally {
      if (seq === modeSeq) switching.value = false
    }
  })
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
    // Each purge batch turns history import off (bridge_privacy_purge_instance) as it commits.
    const run = await purgeInstanceBridgedMessages((total) => {
      purged.value = total
      mode.value = storedMode = 'off'
    })
    if (run.more) toast.warning(t('discordBridge.privacy.purgedSome', { count: run.total }, run.total))
    else toast.success(t('discordBridge.privacy.purged', { count: run.total }, run.total))
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
    mode.value = storedMode = config.mode
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

.mode-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin: 12px 0;
  padding: 0;
  border: 0;
}

.mode-field legend {
  padding: 0;
  margin-bottom: 8px;
}

.mode-choices {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.mode-choice {
  position: relative;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
  background: var(--background-primary);
  cursor: pointer;
  min-width: 0;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.mode-choice:hover {
  border-color: color-mix(in srgb, var(--harmony-primary) 45%, var(--background-quaternary));
}

.mode-choice.selected {
  border-color: var(--harmony-primary);
  background: color-mix(in srgb, var(--harmony-primary) 10%, var(--background-primary));
}

.mode-choice:has(.mode-radio:focus-visible) {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.mode-field:disabled .mode-choice {
  cursor: default;
  opacity: 0.6;
}

.mode-radio {
  margin: 3px 0 0;
  flex-shrink: 0;
  accent-color: var(--harmony-primary);
}

.mode-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.mode-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.mode-desc {
  font-size: 13px;
  line-height: 1.45;
  color: var(--text-secondary);
}

@media (max-width: 640px) {
  .mode-choices {
    grid-template-columns: minmax(0, 1fr);
  }
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
