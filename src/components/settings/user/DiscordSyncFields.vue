<template>
  <div class="dsf" data-testid="discord-sync-fields">
    <fieldset class="dsf-group">
      <legend class="dsf-legend">{{ t('discordMigration.sync.accountGroup') }}</legend>
      <label v-for="field in ACCOUNT_FIELDS" :key="field" class="dsf-row">
        <input
          type="checkbox"
          :checked="selected.includes(field)"
          :disabled="saving"
          :data-testid="`sync-${field}`"
          @change="toggle(field, ($event.target as HTMLInputElement).checked)"
        />
        <span>{{ t(`discordMigration.sync.fields.${field}`) }}</span>
      </label>
    </fieldset>
    <fieldset class="dsf-group">
      <legend class="dsf-legend">{{ t('discordMigration.sync.serverGroup') }}</legend>
      <label v-for="field in SERVER_FIELDS" :key="field" class="dsf-row">
        <input
          type="checkbox"
          :checked="selected.includes(field)"
          :disabled="saving"
          :data-testid="`sync-${field}`"
          @change="toggle(field, ($event.target as HTMLInputElement).checked)"
        />
        <span>{{ t(`discordMigration.sync.fields.${field}`) }}</span>
      </label>
    </fieldset>
    <p class="dsf-hint">{{ t('discordMigration.sync.hint') }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * The seven profile fields a Discord link may copy. With a serverId each toggle is saved at once
 * (Settings, the result screen); without one the toggles only report through v-model (the
 * new-account form, whose link does not exist yet).
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { setMySync, type SyncField } from '@/services/discordMigrationService'

const props = defineProps<{
  serverId: string | null
  modelValue: SyncField[]
}>()
const emit = defineEmits<{ 'update:modelValue': [fields: SyncField[]] }>()

const { t } = useI18n()
const toast = useToast()

const ACCOUNT_FIELDS: SyncField[] = ['avatar', 'display_name', 'banner', 'accent_color']
const SERVER_FIELDS: SyncField[] = ['server_nickname', 'server_avatar', 'server_banner']
const ALL_FIELDS: SyncField[] = [...ACCOUNT_FIELDS, ...SERVER_FIELDS]

const selected = ref<SyncField[]>([...props.modelValue])
const saving = ref(false)

watch(() => props.modelValue, (value) => { selected.value = [...value] })

async function toggle(field: SyncField, on: boolean) {
  const previous = [...selected.value]
  const next = ALL_FIELDS.filter(f => (f === field ? on : previous.includes(f)))
  selected.value = next
  if (!props.serverId) {
    emit('update:modelValue', next)
    return
  }
  saving.value = true
  try {
    await setMySync(props.serverId, next)
    emit('update:modelValue', next)
  } catch {
    selected.value = previous
    toast.error(t('discordMigration.sync.saveFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.dsf { display: flex; flex-direction: column; gap: 12px; }
.dsf-group { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.dsf-legend { font-weight: 600; font-size: 0.875rem; color: var(--text-secondary); padding: 0; margin-bottom: 4px; }
.dsf-row { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.dsf-hint { margin: 0; font-size: 0.8125rem; color: var(--text-muted); }
</style>
