<template>
  <div class="dsf" data-testid="discord-sync-fields">
    <div class="dsf-bulk">
      <button type="button" class="dsf-link" :disabled="disabled" data-testid="sync-select-all" @click="selectAll">
        {{ t('discordMigration.sync.selectAll') }}
      </button>
      <button type="button" class="dsf-link" :disabled="disabled" data-testid="sync-clear-all" @click="clearAll">
        {{ t('discordMigration.sync.clearAll') }}
      </button>
    </div>
    <fieldset class="dsf-group">
      <legend class="dsf-legend">{{ t('discordMigration.sync.accountGroup') }}</legend>
      <label v-for="field in ACCOUNT_SYNC_FIELDS" :key="field" class="dsf-row">
        <input
          type="checkbox"
          :checked="modelValue.includes(field)"
          :disabled="disabled"
          :data-testid="`sync-${field}`"
          @change="toggle(field, ($event.target as HTMLInputElement).checked)"
        />
        <span>{{ t(`discordMigration.sync.fields.${field}`) }}</span>
      </label>
    </fieldset>
    <fieldset class="dsf-group">
      <legend class="dsf-legend">{{ t('discordMigration.sync.serverGroup') }}</legend>
      <label v-for="field in SERVER_SYNC_FIELDS" :key="field" class="dsf-row">
        <input
          type="checkbox"
          :checked="modelValue.includes(field)"
          :disabled="disabled"
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
 * The seven profile fields a Discord link may copy. The toggles are local: they report through
 * v-model and nothing is saved until the parent's Sync / Save and sync button runs.
 */
import { useI18n } from 'vue-i18n'
import type { SyncField } from '@/services/discordMigrationService'
import { ACCOUNT_SYNC_FIELDS, ALL_SYNC_FIELDS, SERVER_SYNC_FIELDS } from './discordSyncFieldList'

const props = defineProps<{
  modelValue: SyncField[]
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [fields: SyncField[]] }>()

const { t } = useI18n()

function toggle(field: SyncField, on: boolean) {
  emit('update:modelValue', ALL_SYNC_FIELDS.filter(f => (f === field ? on : props.modelValue.includes(f))))
}

const selectAll = () => emit('update:modelValue', [...ALL_SYNC_FIELDS])
const clearAll = () => emit('update:modelValue', [])
</script>

<style scoped>
.dsf { display: flex; flex-direction: column; gap: 12px; }
.dsf-bulk { display: flex; gap: 16px; }
.dsf-link { background: none; border: 0; padding: 0; color: var(--accent, var(--text-link, inherit)); cursor: pointer; font-size: 0.8125rem; text-decoration: underline; }
.dsf-link:disabled { opacity: 0.5; cursor: default; }
.dsf-group { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
.dsf-legend { font-weight: 600; font-size: 0.875rem; color: var(--text-secondary); padding: 0; margin-bottom: 4px; }
.dsf-row { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.dsf-hint { margin: 0; font-size: 0.8125rem; color: var(--text-muted); }
</style>
