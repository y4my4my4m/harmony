<template>
  <section class="server-template-export settings-card" :aria-labelledby="headingId" data-testid="server-template-export">
    <div class="setting-row">
      <div class="setting-info">
        <h3 :id="headingId">{{ t('serverTemplate.exportTitle') }}</h3>
        <p>{{ t('serverTemplate.exportDescription') }}</p>
        <p class="structure-note">{{ t('serverTemplate.structureOnly') }}</p>
      </div>
      <button
        type="button"
        class="btn btn-secondary export-btn"
        data-testid="server-template-export-btn"
        :disabled="busy"
        @click="download"
      >
        <Icon :name="busy ? 'spinner' : 'download'" :size="16" :class="{ spin: busy }" />
        {{ busy ? t('serverTemplate.exporting') : t('serverTemplate.exportButton') }}
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { debug } from '@/utils/debug'
import { saveBlob } from '@/services/AccountSecurityService'
import { exportServerTemplate } from '@/services/serverTemplateService'
import { serverTemplateFileName } from '@/utils/serverTemplate'

const props = defineProps<{ serverId: string; serverName: string }>()

const { t } = useI18n()
const toast = useToast()
const busy = ref(false)
const headingId = computed(() => `server-template-export-${props.serverId}`)

async function download() {
  if (busy.value) return
  busy.value = true
  try {
    const template = await exportServerTemplate(props.serverId)
    const blob = new Blob([`${JSON.stringify(template, null, 2)}\n`], { type: 'application/json' })
    saveBlob(blob, serverTemplateFileName(props.serverName))
    toast.success(t('serverTemplate.exported'))
  } catch (error) {
    debug.error('Server template export failed:', error)
    toast.error(t('serverTemplate.exportFailed'))
  } finally {
    busy.value = false
  }
}
</script>

<style scoped src="../../PublicServers/discoveryButtons.css"></style>

<style scoped>
.settings-card {
  background-color: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
  padding: 20px;
  margin-top: 24px;
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

.setting-info .structure-note {
  color: var(--text-muted);
}

.export-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .settings-card {
    padding: 16px;
  }

  .setting-row {
    flex-direction: column;
    align-items: stretch;
  }

  .export-btn {
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
