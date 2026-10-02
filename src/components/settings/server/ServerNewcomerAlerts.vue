<template>
  <section class="newcomer-alerts settings-card" :aria-labelledby="headingId" data-testid="newcomer-alerts">
    <div class="setting-row">
      <div class="setting-info">
        <h3 :id="headingId">{{ t('newcomerAlerts.server.title') }}</h3>
        <p>{{ t('newcomerAlerts.server.description') }}</p>
        <p v-if="loadError" class="error-text" role="alert">{{ loadError }}</p>
        <p v-else-if="state && state.server_value === null" class="default-note">
          {{ t('newcomerAlerts.server.followsDefault') }}
        </p>
        <button
          v-else-if="state"
          type="button"
          class="link-btn"
          :disabled="busy"
          @click="save(null)"
        >
          {{ t('newcomerAlerts.server.useDefault') }}
        </button>
      </div>
      <ToggleSwitch
        :model-value="!!state?.enabled"
        :disabled="busy || !state"
        :aria-label="t('newcomerAlerts.server.toggle')"
        @update:model-value="(v: boolean) => save(v)"
      />
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
  getServerNewcomerAlerts,
  setServerNewcomerAlerts,
  type NewcomerAlertState,
} from '@/services/NewcomerAlertService'

const props = defineProps<{ serverId: string }>()

const { t } = useI18n()
const toast = useToast()

const state = ref<NewcomerAlertState | null>(null)
const busy = ref(false)
const loadError = ref('')
const headingId = computed(() => `newcomer-alerts-${props.serverId}`)

async function load() {
  state.value = null
  loadError.value = ''
  try {
    state.value = await getServerNewcomerAlerts(props.serverId)
  } catch (error) {
    debug.warn('Newcomer alert setting unavailable:', error)
    loadError.value = t('newcomerAlerts.server.loadFailed')
  }
}

async function save(enabled: boolean | null) {
  if (busy.value) return
  busy.value = true
  try {
    state.value = await setServerNewcomerAlerts(props.serverId, enabled)
  } catch (error) {
    debug.error('Failed to update newcomer alerts:', error)
    toast.error(t('newcomerAlerts.server.saveFailed'))
  } finally {
    busy.value = false
  }
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

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.setting-info {
  min-width: 0;
}

.setting-info h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.setting-info p {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 4px 0 0;
}

.setting-info .default-note {
  color: var(--text-muted);
}

.setting-info .error-text {
  color: var(--status-danger);
}

.link-btn {
  margin-top: 6px;
  padding: 0;
  border: none;
  background: none;
  color: var(--harmony-primary);
  font-size: 13px;
  cursor: pointer;
}

.link-btn:hover:not(:disabled) {
  text-decoration: underline;
}

.link-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.link-btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

@media (max-width: 768px) {
  .settings-card {
    padding: 16px;
  }
}
</style>
