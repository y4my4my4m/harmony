<template>
  <div v-if="waiting" class="db-banner" role="status" data-testid="check-waiting">
    <p class="waiting">
      <Icon name="spinner" :size="16" class="spin" aria-hidden="true" />
      <span>{{ waiting }}</span>
    </p>
  </div>

  <ul class="check-list" aria-live="polite">
    <li v-for="item in items" :key="item.key" :class="['check', `check--${item.state}`]" :data-check="item.key" :data-state="item.state">
      <Icon :name="ICON[item.state]" :size="18" :class="item.state === 'waiting' ? 'spin-slow' : ''" aria-hidden="true" />
      <div class="check-body">
        <span class="check-label">{{ label(item) }}</span>
        <span class="db-sr-only">{{ t(`discordBridge.check.state.${item.state}`) }}</span>
        <slot :item="item" />
      </div>
    </li>
  </ul>
</template>

<script setup lang="ts" generic="Item extends { key: string; state: CheckState }">
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import type { CheckState } from '@/utils/discordBridgeSetup'

defineProps<{
  items: readonly Item[]
  label: (item: Item) => string
  /** What the bridge is being waited for; empty once it reported in. */
  waiting?: string
}>()

const ICON: Record<CheckState, string> = { ok: 'check-circle', fail: 'x-circle', waiting: 'spinner' }

const { t } = useI18n()
</script>

<style scoped src="./bridge.css"></style>
<style scoped>
.waiting {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.waiting :deep(.icon-wrap) {
  margin-top: 2px;
  flex-shrink: 0;
}

.check-list {
  list-style: none;
  margin: 0 0 14px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.check {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 4px;
  border-bottom: 1px solid var(--background-quaternary);
}

.check:last-child {
  border-bottom: none;
}

.check :deep(.icon-wrap) {
  margin-top: 1px;
  flex-shrink: 0;
}

.check--ok {
  color: var(--text-success);
}

.check--fail {
  color: var(--text-danger);
}

.check--waiting {
  color: var(--text-secondary);
}

.check-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.check-label {
  font-size: 14px;
  color: var(--text-primary);
  line-height: 1.45;
}

.spin :deep(svg),
.spin-slow :deep(svg) {
  animation: bridge-spin 1.2s linear infinite;
}

.spin-slow :deep(svg) {
  animation-duration: 2.4s;
}

@keyframes bridge-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spin :deep(svg),
  .spin-slow :deep(svg) {
    animation: none;
  }
}
</style>
