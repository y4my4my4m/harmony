<template>
  <ul class="pair-list" :aria-label="t('matrixBridge.pairs.listLabel')">
    <li
      v-for="(row, index) in rows"
      :key="pairKey(row)"
      class="pair"
      data-testid="matrix-pair"
      :data-channel="row.channel_id"
      :data-state="stateOf(row)"
    >
      <div class="pair-main">
        <span class="pair-channel">
          <span class="pair-platform">{{ t('matrixBridge.pairs.harmony') }}</span>
          <span class="pair-name">#{{ row.channel_name }}</span>
        </span>
        <span class="pair-arrow" aria-hidden="true">⇄</span>
        <span class="pair-channel">
          <span class="pair-platform">{{ t('matrixBridge.pairs.matrix') }}</span>
          <span :class="['pair-name', { 'pair-pending': !row.room_id }]" data-testid="matrix-pair-room">
            {{ row.room_id ?? t('matrixBridge.pairs.waitingRoom') }}
          </span>
        </span>
      </div>

      <div class="pair-meta">
        <span :class="['db-badge', BADGE[stateOf(row)]]" data-testid="matrix-pair-badge">{{ t(`matrixBridge.pairs.badge.${stateOf(row)}`) }}</span>
        <span v-if="multipleBots" class="db-badge">{{ t('matrixBridge.pairs.via', { bot: row.bot_display_name }) }}</span>
      </div>

      <p v-if="!row.active" class="pair-fix" data-testid="matrix-pair-fix">
        {{ t('matrixBridge.pairs.stoppedFix', { bot: row.bot_display_name, channel: row.channel_name }) }}
      </p>
      <p v-else-if="!row.room_id" class="pair-fix" data-testid="matrix-pair-fix">{{ t('matrixBridge.pairs.waitingFix') }}</p>

      <div class="db-field pair-mode">
        <label class="db-label" :for="`${uid}-${index}`">{{ t('matrixBridge.pairs.senderMode') }}</label>
        <select
          :id="`${uid}-${index}`"
          class="db-select"
          :value="row.sender_mode"
          :disabled="disabled || !row.active"
          :aria-describedby="`${uid}-${index}-hint`"
          data-testid="matrix-pair-mode"
          @change="emit('mode', row, $event)"
        >
          <option v-for="mode in MATRIX_SENDER_MODES" :key="mode" :value="mode">{{ t(`matrixBridge.pairs.mode.${mode}`) }}</option>
        </select>
        <p :id="`${uid}-${index}-hint`" class="db-muted mode-hint">{{ t(`matrixBridge.pairs.modeHint.${row.sender_mode}`) }}</p>
      </div>
      <p v-if="saving === pairKey(row)" class="db-muted saving" role="status">{{ t('matrixBridge.pairs.saving') }}</p>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { MATRIX_SENDER_MODES, matrixPairKey as pairKey, type MatrixBridgePair } from './matrixBridgeApi'

const props = defineProps<{
  rows: MatrixBridgePair[]
  /** pairKey of the pair whose mode is being saved. */
  saving: string | null
  disabled: boolean
}>()

const emit = defineEmits<{ mode: [row: MatrixBridgePair, event: Event] }>()

type PairState = 'connected' | 'waiting' | 'stopped'
const BADGE: Record<PairState, string> = { connected: 'db-badge--ok', waiting: '', stopped: 'db-badge--error' }

const { t } = useI18n()
const uid = `matrix-pairs-${useId()}`

const multipleBots = computed(() => new Set(props.rows.map(row => row.bot_id)).size > 1)

function stateOf(row: MatrixBridgePair): PairState {
  if (!row.active) return 'stopped'
  return row.room_id ? 'connected' : 'waiting'
}
</script>

<style scoped src="../discord-bridge/bridge.css"></style>
<style scoped>
.pair-pending {
  font-weight: 400;
  font-style: italic;
  color: var(--text-secondary);
}

.pair-fix {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.pair-mode {
  margin: 12px 0 0;
  max-width: 420px;
}

.mode-hint {
  margin: 0;
}

.saving {
  margin: 6px 0 0;
}
</style>
