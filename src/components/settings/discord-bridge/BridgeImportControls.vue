<template>
  <div class="import" data-testid="import-controls" :data-state="job?.state ?? 'none'">
    <p v-if="block" class="import-note" data-testid="import-ineligible">{{ t(`discordBridge.import.ineligible.${block}`) }}</p>

    <template v-else>
      <div v-if="job && (job.state === 'running' || job.state === 'queued')" class="import-live">
        <div class="import-line">
          <span class="import-state" data-testid="import-state">{{ liveText }}</span>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="busy || job.cancel_requested"
            :aria-label="t('discordBridge.import.cancelLabel', { channel: channelName })"
            data-testid="import-cancel"
            @click="emit('cancel', job)"
          >
            {{ t('discordBridge.import.cancel') }}
          </button>
        </div>
        <div
          v-if="job.state === 'running' && percent !== null && job.phase === 'messages'"
          class="import-bar"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="percent"
          :aria-label="t('discordBridge.import.progressLabel', { channel: channelName })"
        >
          <span class="import-bar-fill" :style="{ width: `${percent}%` }" />
        </div>
        <p v-if="job.state === 'running'" class="import-detail" data-testid="import-detail">{{ detailText }}</p>
      </div>

      <div v-else-if="job" class="import-line">
        <span :class="['import-state', `import-state--${job.state}`]" data-testid="import-state">{{ endText }}</span>
        <button
          v-if="job.state === 'failed' || job.state === 'cancelled' || job.state === 'done'"
          type="button"
          class="btn btn-secondary btn-sm"
          :disabled="busy"
          :aria-label="t(`discordBridge.import.${retryKey}Label`, { channel: channelName })"
          data-testid="import-retry"
          @click="emit('start', pair.harmony_channel_id)"
        >
          {{ t(`discordBridge.import.${retryKey}`) }}
        </button>
      </div>

      <button
        v-if="!job"
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="busy"
        :aria-label="t('discordBridge.import.buttonLabel', { channel: channelName })"
        data-testid="import-start"
        @click="emit('start', pair.harmony_channel_id)"
      >
        {{ t('discordBridge.import.button') }}
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { BridgePairRow } from '@/utils/discordBridgeSetup'
import type { ImportJob } from './bridgeApi'
import { importPercent, type ImportBlock } from './importProgress'

const props = defineProps<{
  pair: BridgePairRow
  job: ImportJob | null
  /** Why the pair cannot import, or null. */
  block: ImportBlock | null
  channelName: string
  busy?: boolean
}>()

const emit = defineEmits<{ start: [harmonyChannelId: string]; cancel: [job: ImportJob] }>()

const { t, te, locale } = useI18n()

const percent = computed(() => (props.job ? importPercent(props.job) : null))
const retryKey = computed(() => {
  if (props.job?.state === 'cancelled') return 'resume'
  if (props.job?.state === 'done') return 'again'
  return 'retry'
})

const liveText = computed(() => {
  const job = props.job
  if (!job) return ''
  if (job.cancel_requested) return t('discordBridge.import.cancelling')
  if (job.state === 'queued') return t('discordBridge.import.waiting')
  if (job.phase === 'threads') return t('discordBridge.import.threadsRunning')
  if (job.phase === 'replies') return t('discordBridge.import.repliesRunning')
  return percent.value === null
    ? t('discordBridge.import.runningUnknown')
    : t('discordBridge.import.running', { percent: percent.value })
})

function monthYear(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(locale.value, { month: 'long', year: 'numeric' }).format(date)
}

const detailText = computed(() => {
  const job = props.job
  if (!job) return ''
  const parts: string[] = []
  if (job.phase === 'threads') {
    if (job.threads_total !== null) {
      parts.push(t('discordBridge.import.threads', { done: job.threads_done, total: job.threads_total }))
    }
  } else if (job.phase === 'messages') {
    const month = monthYear(job.reached_at)
    if (month) parts.push(t('discordBridge.import.backTo', { date: month }))
  }
  parts.push(t('discordBridge.import.messages', { count: job.imported_count }, job.imported_count))
  parts.push(...leftOut(job))
  return parts.join(' · ')
})

/** What the run left out for its authors or the server's AutoMod; empty when nothing. */
function leftOut(job: ImportJob): string[] {
  const parts: string[] = []
  if (job.authors_skipped > 0) {
    parts.push(t('discordBridge.import.authorsSkipped', { count: job.authors_skipped }, job.authors_skipped))
  }
  if (job.automod_skipped > 0) {
    parts.push(t('discordBridge.import.automodSkipped', { count: job.automod_skipped }, job.automod_skipped))
  }
  return parts
}

const endText = computed(() => {
  const job = props.job
  if (!job) return ''
  switch (job.state) {
    case 'done':
      // imported_count is what this run added; a re-run over an imported channel adds nothing.
      return [
        job.imported_count === 0
          ? t('discordBridge.import.doneNothingNew')
          : t('discordBridge.import.done', { count: job.imported_count }, job.imported_count),
        ...leftOut(job),
      ].join(' · ')
    case 'failed': {
      const code = job.error ?? ''
      const reason = te(`discordBridge.import.reasons.${code}`) ? t(`discordBridge.import.reasons.${code}`) : code
      return reason ? t('discordBridge.import.failed', { reason }) : t('discordBridge.import.failedUnknown')
    }
    case 'cancelled':
      return t('discordBridge.import.cancelled')
    case 'paused':
      return t('discordBridge.import.paused')
    default:
      return ''
  }
})
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.import {
  margin-top: 8px;
  font-size: 13px;
  color: var(--text-secondary);
}

.import-note,
.import-detail {
  margin: 0;
  line-height: 1.5;
}

.import-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.import-state {
  color: var(--text-primary);
  font-weight: 600;
}

.import-state--failed {
  color: var(--error);
}

.import-bar {
  height: 6px;
  margin: 6px 0;
  border-radius: 3px;
  overflow: hidden;
  background: var(--background-quaternary);
}

.import-bar-fill {
  display: block;
  height: 100%;
  background: var(--harmony-primary);
  transition: width 0.3s ease;
}
</style>
