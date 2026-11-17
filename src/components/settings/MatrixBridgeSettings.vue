<template>
  <section class="bridge-card" :aria-labelledby="`${uid}-title`">
    <h2 :id="`${uid}-title`">{{ t('matrixBridge.title') }}</h2>
    <p>{{ t('matrixBridge.description') }}</p>
    <p class="bridge-muted">{{ t('matrixBridge.requirements') }}</p>
    <p class="bridge-muted">{{ t('matrixBridge.history') }}</p>
    <p v-if="loading" role="status">{{ t('matrixBridge.loading') }}</p>
    <p v-if="error" role="alert">{{ t(`matrixBridge.${error}`) }}</p>
    <button type="button" class="btn btn-secondary" :disabled="loading || !!saving" @click="load">{{ t('matrixBridge.reload') }}</button>
    <p v-if="!loading && !error && !rows.length">{{ t('matrixBridge.empty') }}</p>
    <fieldset v-for="row in rows" :key="`${row.bot_id}:${row.channel_id}`" class="matrix-pair" :disabled="loading || !!saving || !!error">
      <legend>#{{ row.channel_name }}</legend>
      <p class="matrix-room">{{ row.room_id ?? t('matrixBridge.waitingRoom') }}</p>
      <label :for="`${uid}-${row.bot_id}-${row.channel_id}`">{{ t('matrixBridge.senderMode') }}</label>
      <select :id="`${uid}-${row.bot_id}-${row.channel_id}`" :value="row.sender_mode" :aria-describedby="`${uid}-delivery`"
        @change="save(row, $event)">
        <option value="ghost">{{ t('matrixBridge.ghost') }}</option>
        <option value="relay">{{ t('matrixBridge.relay') }}</option>
      </select>
      <p v-if="saving === `${row.bot_id}:${row.channel_id}`" role="status">{{ t('matrixBridge.saving') }}</p>
    </fieldset>
    <p :id="`${uid}-delivery`" class="bridge-muted">{{ t('matrixBridge.delivery') }}</p>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { supabase } from '@/supabase'
import { useProfileStore } from '@/stores/useProfile'

type SenderMode = 'ghost' | 'relay'
interface BridgeRow { bot_id: string; channel_id: string; channel_name: string; room_id: string | null; sender_mode: SenderMode }
const props = defineProps<{ serverId: string }>()
const { t } = useI18n()
const profile = useProfileStore()
const uid = `matrix-bridge-${useId()}`
const rows = ref<BridgeRow[]>([])
const loading = ref(false)
const saving = ref<string | null>(null)
const error = ref<'loadError' | 'saveError' | null>(null)
let revision = 0

function isRow(value: unknown): value is BridgeRow {
  if (!value || typeof value !== 'object') return false
  const row = value as BridgeRow
  return ['bot_id', 'channel_id', 'channel_name'].every(key => typeof row[key as keyof BridgeRow] === 'string' && !!row[key as keyof BridgeRow])
    && (row.room_id === null || (typeof row.room_id === 'string' && !!row.room_id))
    && (row.sender_mode === 'ghost' || row.sender_mode === 'relay')
}
async function load(): Promise<void> {
  const request = ++revision
  rows.value = []
  saving.value = null
  error.value = null
  loading.value = true
  try {
    const result = await supabase.rpc('get_server_matrix_bridges', { p_server_id: props.serverId })
    if (result.error || !Array.isArray(result.data) || !result.data.every(isRow)) throw new Error()
    if (request === revision) rows.value = result.data
  } catch {
    if (request === revision) error.value = 'loadError'
  } finally {
    if (request === revision) loading.value = false
  }
}
async function save(row: BridgeRow, event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement
  const mode = select.value as SenderMode
  select.value = row.sender_mode
  if (loading.value || saving.value || error.value || !['ghost', 'relay'].includes(mode)) return
  const request = revision
  saving.value = `${row.bot_id}:${row.channel_id}`
  try {
    const result = await supabase.rpc('set_matrix_bridge_sender_mode', { p_bot_id: row.bot_id, p_channel_id: row.channel_id, p_sender_mode: mode })
    const updated = Array.isArray(result.data) ? result.data.find(item => item?.bot_id === row.bot_id && item?.channel_id === row.channel_id) : result.data
    if (result.error || !isRow(updated) || updated.channel_id !== row.channel_id || updated.bot_id !== row.bot_id) throw new Error()
    if (request === revision) rows.value = rows.value.map(item => item.channel_id === row.channel_id && item.bot_id === row.bot_id ? updated : item)
  } catch {
    if (request === revision) error.value = 'saveError'
  } finally {
    if (request === revision) saving.value = null
  }
}
watch([() => props.serverId, () => profile.profileId], () => { void load() }, { immediate: true })
onBeforeUnmount(() => { revision++ })
</script>

<style scoped src="./discord-bridge/bridge.css"></style>
<style scoped>
.matrix-pair { margin: 1rem 0; padding: 1rem; border: 1px solid var(--border-primary); border-radius: var(--radius-base); }
.matrix-pair label { display: block; margin-bottom: 0.5rem; }
.matrix-pair select { width: 100%; padding: 0.5rem; color: var(--text-primary); background: var(--background-secondary); }
.matrix-room { overflow-wrap: anywhere; color: var(--text-secondary); }
</style>
