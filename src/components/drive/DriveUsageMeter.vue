<template>
  <div v-if="usage" class="drive-usage" data-testid="drive-usage">
    <div class="drive-usage__bar" role="meter" :aria-valuenow="Math.round(fraction * 100)" aria-valuemin="0"
      aria-valuemax="100" :aria-label="t('drive.usage.label')" :aria-valuetext="summary">
      <span class="drive-usage__fill" :class="{ 'is-full': full, 'is-high': fraction >= 0.85 }"
        :style="{ transform: `scaleX(${Math.max(fraction, 0.01)})` }" />
    </div>
    <p class="drive-usage__summary">{{ summary }}</p>
    <p v-if="usage.ephemeral_bytes > 0" class="drive-usage__extra">
      <Icon name="clock" :size="12" aria-hidden="true" />
      {{ t('drive.usage.temporary', { size: formatBytes(usage.ephemeral_bytes, locale.value) }) }}
    </p>
    <p v-if="full" class="drive-usage__full" data-testid="drive-full">
      {{ t('drive.usage.full', { count: usage.ephemeral_days }, usage.ephemeral_days) }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { useDriveUsage } from '@/composables/useDriveUsage'
import { formatBytes } from './driveFormat'

const { t, locale } = useT()
const { usage, full, fraction } = useDriveUsage()

const summary = computed(() => usage.value
  ? t('drive.usage.summary', {
      used: formatBytes(usage.value.used_bytes, locale.value),
      quota: formatBytes(usage.value.quota_bytes, locale.value),
    })
  : '')
</script>

<style scoped>
.drive-usage {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.drive-usage__bar {
  position: relative;
  height: 6px;
  overflow: hidden;
  background: var(--background-modifier-active);
  border-radius: var(--radius-full);
}

.drive-usage__fill {
  position: absolute;
  inset: 0;
  background: var(--harmony-primary);
  border-radius: inherit;
  transform-origin: left center;
  transition: transform 0.5s cubic-bezier(0.2, 0.8, 0.2, 1), background-color 0.3s ease;
}

.drive-usage__fill.is-high {
  background: var(--warning);
}

.drive-usage__fill.is-full {
  background: var(--danger, #ed4245);
}

.drive-usage__summary {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.drive-usage__extra,
.drive-usage__full {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.drive-usage__full {
  color: var(--warning);
  line-height: var(--line-height-normal);
}

@media (prefers-reduced-motion: reduce) {
  .drive-usage__fill {
    transition: none;
  }
}
</style>
