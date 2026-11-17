<template>
  <section class="matrix-bridge" :aria-labelledby="`${uid}-title`" data-testid="matrix-bridge">
    <div class="settings-section">
      <h3 :id="`${uid}-title`" class="section-title">{{ t('matrixBridge.title') }}</h3>
      <p class="section-description">{{ t('matrixBridge.description') }}</p>
    </div>

    <section class="db-card" :aria-labelledby="`${uid}-pairs`">
      <h3 :id="`${uid}-pairs`" class="db-card-title">{{ t('matrixBridge.pairsTitle') }}</h3>
      <p class="db-muted">{{ t('matrixBridge.requirements') }}</p>
      <p class="db-muted">{{ t('matrixBridge.history') }}</p>

      <p v-if="loading" class="db-muted" role="status">{{ t('matrixBridge.loading') }}</p>
      <div v-if="error" class="db-banner db-banner--error" role="alert" data-testid="matrix-bridge-error">
        <p>{{ t(`matrixBridge.${error}`) }}</p>
      </div>
      <p v-if="!loading && !error && !rows.length" class="db-text" data-testid="matrix-bridge-empty">{{ t('matrixBridge.empty') }}</p>

      <fieldset
        v-for="row in rows"
        :key="pairKey(row)"
        class="matrix-pair"
        :disabled="loading || !!saving || !!error"
        data-testid="matrix-pair"
      >
        <legend class="db-card-sub">#{{ row.channel_name }}</legend>
        <p class="matrix-room db-muted">{{ row.room_id ?? t('matrixBridge.waitingRoom') }}</p>
        <div class="db-field">
          <label class="db-label" :for="`${uid}-${pairKey(row)}`">{{ t('matrixBridge.senderMode') }}</label>
          <select
            :id="`${uid}-${pairKey(row)}`"
            class="db-select"
            :value="row.sender_mode"
            :aria-describedby="`${uid}-delivery`"
            @change="save(row, $event)"
          >
            <option value="ghost">{{ t('matrixBridge.ghost') }}</option>
            <option value="relay">{{ t('matrixBridge.relay') }}</option>
          </select>
        </div>
        <p v-if="saving === pairKey(row)" class="db-muted" role="status">{{ t('matrixBridge.saving') }}</p>
      </fieldset>

      <p :id="`${uid}-delivery`" class="db-muted">{{ t('matrixBridge.delivery') }}</p>
      <div class="db-actions">
        <button type="button" class="btn btn-secondary btn-sm" :disabled="loading || !!saving" data-testid="matrix-bridge-reload" @click="load">
          {{ t('matrixBridge.reload') }}
        </button>
      </div>
    </section>

    <section v-if="rows.length" class="db-card" :aria-labelledby="`${uid}-privacy`">
      <h3 :id="`${uid}-privacy`" class="db-card-title">{{ t('discordBridge.privacy.title') }}</h3>
      <BridgePrivacyPanel :server-id="serverId" platform="matrix" />
    </section>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useProfileStore } from '@/stores/useProfile'
import BridgePrivacyPanel from '@/components/settings/discord-bridge/BridgePrivacyPanel.vue'
import {
  fetchServerMatrixBridges,
  isMatrixSenderMode,
  setMatrixBridgeSenderMode,
  type MatrixBridgePair,
} from './matrixBridgeApi'

const props = defineProps<{ serverId: string }>()
const { t } = useI18n()
const profile = useProfileStore()
const uid = `matrix-bridge-${useId()}`
const rows = ref<MatrixBridgePair[]>([])
const loading = ref(false)
const saving = ref<string | null>(null)
const error = ref<'loadError' | 'saveError' | null>(null)
/** Load generation; a response for an earlier server, profile or mount is dropped. */
let revision = 0

const pairKey = (row: Pick<MatrixBridgePair, 'bot_id' | 'channel_id'>) => `${row.bot_id}:${row.channel_id}`

async function load(): Promise<void> {
  const request = ++revision
  rows.value = []
  saving.value = null
  error.value = null
  loading.value = true
  try {
    const result = await fetchServerMatrixBridges(props.serverId)
    if (request === revision) rows.value = result
  } catch {
    if (request === revision) error.value = 'loadError'
  } finally {
    if (request === revision) loading.value = false
  }
}

/** The select shows the saved mode until the server confirms another. */
async function save(row: MatrixBridgePair, event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement
  const mode = select.value
  select.value = row.sender_mode
  if (loading.value || saving.value || error.value || !isMatrixSenderMode(mode)) return
  const request = revision
  const key = pairKey(row)
  saving.value = key
  try {
    const updated = await setMatrixBridgeSenderMode(row.bot_id, row.channel_id, mode)
    if (request === revision) rows.value = rows.value.map(item => (pairKey(item) === key ? updated : item))
  } catch {
    if (request === revision) error.value = 'saveError'
  } finally {
    if (request === revision) saving.value = null
  }
}

watch([() => props.serverId, () => profile.profileId], () => { void load() }, { immediate: true })
onBeforeUnmount(() => { revision++ })
</script>

<style scoped src="../discord-bridge/bridge.css"></style>
<style scoped>
.matrix-bridge {
  margin-bottom: 32px;
  max-width: 860px;
}

.settings-section {
  margin-bottom: 20px;
}

.section-title {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 600;
  color: var(--text-primary);
}

.section-description {
  margin: 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--text-secondary);
}

.matrix-pair {
  margin: 0 0 12px;
  padding: 12px 16px;
  border: 1px solid var(--background-quaternary);
  border-radius: 8px;
  min-width: 0;
}

.matrix-pair legend {
  padding: 0 4px;
}

.matrix-room {
  overflow-wrap: anywhere;
}

.db-banner p {
  margin: 0;
}
</style>
