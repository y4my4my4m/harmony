<template>
  <section class="sec-card" aria-labelledby="export-title">
    <header class="sec-card-header">
      <div>
        <h3 id="export-title" class="sec-card-title">Download your data</h3>
        <p class="sec-card-description">
          A ZIP archive of your account: profile and settings, the messages you sent in servers
          and conversations, your posts, follows, blocks, the files you uploaded and the devices
          signed in. Other people's messages are not included. You can request one every ten
          minutes, five a day.
        </p>
      </div>
    </header>

    <div v-if="busy" class="sec-step" aria-live="polite">
      <div class="sec-muted">{{ progressText }}</div>
      <div class="sec-progress"><span :style="{ width: `${progressPercent}%` }" /></div>
    </div>
    <p v-if="error" class="sec-error" role="alert">{{ error }}</p>

    <div class="sec-actions sec-actions-start">
      <button class="sec-btn sec-btn-primary" :disabled="busy" @click="start">
        <Icon name="download" :size="14" />
        {{ busy ? 'Preparing…' : 'Request my data' }}
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { debug } from '@/utils/debug'
import { exportAccountData, type ExportProgress } from '@/services/DataExportService'
import { saveBlob, securityErrorMessage } from '@/services/AccountSecurityService'
import './securitySettings.css'

const toast = useToast()

const busy = ref(false)
const error = ref('')
const progress = ref<ExportProgress | null>(null)

const progressText = computed(() => {
  const p = progress.value
  if (!p || p.phase === 'account') return 'Collecting your account data…'
  if (p.phase === 'messages') return `Exporting messages: ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`
  return 'Packaging the archive…'
})

const progressPercent = computed(() => {
  const p = progress.value
  if (!p || p.phase === 'account') return 5
  if (p.phase === 'packaging') return 95
  return p.total > 0 ? 10 + Math.round((p.done / p.total) * 80) : 50
})

async function start() {
  busy.value = true
  error.value = ''
  progress.value = null
  try {
    const { blob, filename } = await exportAccountData((p) => { progress.value = p })
    saveBlob(blob, filename)
    toast.success('Your data is downloading')
  } catch (err) {
    debug.error('Data export failed:', err)
    error.value = securityErrorMessage(err, 'The export failed. Try again later.')
  } finally {
    busy.value = false
  }
}
</script>
