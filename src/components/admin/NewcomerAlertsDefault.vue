<template>
  <div class="newcomer-default" data-testid="newcomer-alerts-default">
    <h3>{{ t('newcomerAlerts.admin.title') }}</h3>
    <div class="newcomer-default-row">
      <div class="newcomer-default-text">
        <span :id="labelId" class="newcomer-default-title">{{ t('newcomerAlerts.admin.toggle') }}</span>
        <span class="newcomer-default-hint">{{ t('newcomerAlerts.admin.hint') }}</span>
      </div>
      <ToggleSwitch
        :model-value="enabled"
        :disabled="busy || !loaded"
        :aria-labelledby="labelId"
        @update:model-value="save"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { debug } from '@/utils/debug'
import {
  getInstanceNewcomerAlertsDefault,
  setInstanceNewcomerAlertsDefault,
} from '@/services/NewcomerAlertService'

const { t } = useI18n()
const toast = useToast()

const labelId = 'newcomer-alerts-default-label'
const enabled = ref(true)
const loaded = ref(false)
const busy = ref(false)

async function save(value: boolean) {
  if (busy.value) return
  const previous = enabled.value
  enabled.value = value
  busy.value = true
  try {
    await setInstanceNewcomerAlertsDefault(value)
    toast.success(t('newcomerAlerts.admin.saved'))
  } catch (error) {
    debug.error('Failed to save the newcomer alert default:', error)
    enabled.value = previous
    toast.error(t('newcomerAlerts.admin.saveFailed'))
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  try {
    enabled.value = await getInstanceNewcomerAlertsDefault()
    loaded.value = true
  } catch (error) {
    debug.warn('Newcomer alert default unavailable:', error)
  }
})
</script>

<style scoped>
.newcomer-default {
  margin-top: 24px;
}

.newcomer-default h3 {
  margin: 0 0 12px;
}

.newcomer-default-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.newcomer-default-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.newcomer-default-title {
  color: var(--text-primary);
  font-weight: 500;
}

.newcomer-default-hint {
  color: var(--text-secondary);
  font-size: 13px;
}
</style>
