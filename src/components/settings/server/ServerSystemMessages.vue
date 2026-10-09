<template>
  <section class="system-messages settings-card" :aria-labelledby="headingId" data-testid="system-messages">
    <h3 :id="headingId">{{ t('systemMessages.server.title') }}</h3>
    <p class="card-description">{{ t('systemMessages.server.description') }}</p>
    <p v-if="loadError" class="error-text" role="alert">{{ loadError }}</p>

    <div class="setting-row">
      <span :id="toggleLabelId" class="setting-label">{{ t('systemMessages.server.toggle') }}</span>
      <ToggleSwitch
        :model-value="!!state?.system_messages_enabled"
        :disabled="busy || !state"
        :aria-labelledby="toggleLabelId"
        @update:model-value="(v: boolean) => save(state?.system_channel_id ?? null, v)"
      />
    </div>

    <div class="setting-row">
      <div class="setting-info">
        <label :for="selectId" class="setting-label">{{ t('systemMessages.server.channel') }}</label>
        <p>{{ t('systemMessages.server.channelHint') }}</p>
      </div>
      <select
        :id="selectId"
        class="select-input"
        :value="state?.system_channel_id ?? ''"
        :disabled="busy || !state || !state.system_messages_enabled"
        @change="onChannelChange"
      >
        <option value="">{{ t('systemMessages.server.automatic') }}</option>
        <option v-if="unlistedChannelId" :value="unlistedChannelId">
          {{ t('systemMessages.server.unavailableChannel') }}
        </option>
        <option v-for="ch in channels" :key="ch.id" :value="ch.id"># {{ ch.name }}</option>
      </select>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { debug } from '@/utils/debug'
import {
  getSystemChannelChoices,
  getSystemMessageSettings,
  setServerSystemChannel,
  type SystemChannelChoice,
  type SystemMessageSettings,
} from '@/services/permissionsService'

const props = defineProps<{ serverId: string }>()

const { t } = useI18n()
const toast = useToast()

const state = ref<SystemMessageSettings | null>(null)
const channels = ref<SystemChannelChoice[]>([])
const busy = ref(false)
const loadError = ref('')
const headingId = computed(() => `system-messages-${props.serverId}`)
const toggleLabelId = computed(() => `system-messages-toggle-${props.serverId}`)
const selectId = computed(() => `system-messages-channel-${props.serverId}`)

// The stored channel is absent from the list when channel RLS hides it from the caller.
const unlistedChannelId = computed(() => {
  const id = state.value?.system_channel_id
  return id && !channels.value.some(c => c.id === id) ? id : null
})

async function load() {
  state.value = null
  channels.value = []
  loadError.value = ''
  try {
    const [settings, choices] = await Promise.all([
      getSystemMessageSettings(props.serverId),
      getSystemChannelChoices(props.serverId),
    ])
    state.value = settings
    channels.value = choices
  } catch (error) {
    debug.warn('System message settings unavailable:', error)
    loadError.value = t('systemMessages.server.loadFailed')
  }
}

async function save(channelId: string | null, enabled: boolean) {
  if (busy.value || !state.value) return
  busy.value = true
  try {
    state.value = await setServerSystemChannel(props.serverId, channelId, enabled)
  } catch (error) {
    debug.error('Failed to update system message settings:', error)
    toast.error(t('systemMessages.server.saveFailed'))
  } finally {
    busy.value = false
  }
}

async function onChannelChange(event: Event) {
  const select = event.target as HTMLSelectElement
  await save(select.value || null, state.value?.system_messages_enabled ?? true)
  // A refused save leaves state unchanged, so the binding does not restore the DOM value.
  select.value = state.value?.system_channel_id ?? ''
}

watch(() => props.serverId, load, { immediate: true })
</script>

<style scoped>
.settings-card {
  background-color: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
  padding: 20px;
  margin-top: 16px;
}

.settings-card h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.card-description,
.setting-info p {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 4px 0 0;
}

.error-text {
  font-size: 13px;
  color: var(--status-danger);
  margin: 4px 0 0;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 16px;
}

.setting-info {
  min-width: 0;
}

.setting-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.select-input {
  padding: 8px 10px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  min-width: 180px;
  max-width: 50%;
  box-sizing: border-box;
}

.select-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.select-input:disabled {
  opacity: 0.6;
}

@media (max-width: 768px) {
  .settings-card {
    padding: 16px;
  }

  .setting-row:last-child {
    flex-direction: column;
    align-items: stretch;
  }

  .select-input {
    max-width: none;
  }
}
</style>
