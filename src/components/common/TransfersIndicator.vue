<!-- Uploads and downloads in flight on any page (services/transfers.ts), bottom right. -->
<template>
  <section v-if="shown.length" class="transfers" :aria-label="t('transfers.label')" data-testid="transfers-indicator">
    <header class="transfers__head">
      <span>{{ heading }}</span>
    </header>
    <ul class="transfers__list">
      <li
        v-for="item in shown"
        :key="item.id"
        class="transfers__item"
        :data-status="item.progress.status"
        :data-direction="item.direction"
        data-testid="transfer-item"
      >
        <div class="transfers__row">
          <Icon :name="item.direction === 'upload' ? 'upload' : 'download'" :size="14" class="transfers__kind" aria-hidden="true" />
          <span class="transfers__name" :title="item.name">{{ item.name }}</span>
          <span class="transfers__state">
            <template v-if="item.progress.status === 'running'">
              <span v-if="item.progress.reconnecting" class="transfers__reconnecting" data-testid="transfer-reconnecting">{{ t('transfers.reconnecting') }}</span>
              <span v-else>{{ percent(item) }}%</span>
            </template>
            <Icon v-else-if="item.progress.status === 'completed'" name="check" :size="14" :aria-label="t('transfers.done')" />
          </span>
          <button
            v-if="item.progress.status === 'completed' && item.savedPath"
            type="button"
            class="transfers__btn"
            :title="t('transfers.showInFolder')"
            :aria-label="t('transfers.showInFolder')"
            @click="reveal(item.savedPath)"
          >
            <Icon name="folder" :size="14" />
          </button>
          <button
            v-if="item.progress.status === 'running' && item.cancel"
            type="button"
            class="transfers__btn"
            :aria-label="t('transfers.cancel', { name: item.name })"
            :title="t('transfers.cancel', { name: item.name })"
            data-testid="transfer-cancel"
            @click="item.cancel()"
          >
            <Icon name="x" :size="14" />
          </button>
          <button
            v-else-if="item.progress.status === 'error'"
            type="button"
            class="transfers__btn"
            :aria-label="t('transfers.dismiss', { name: item.name })"
            data-testid="transfer-dismiss"
            @click="dismissTransfer(item.id)"
          >
            <Icon name="x" :size="14" />
          </button>
        </div>
        <div
          v-if="item.progress.status === 'running'"
          class="transfers__bar"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="percent(item)"
          :aria-label="t('transfers.progress', { name: item.name, percent: percent(item) })"
        >
          <span :style="{ transform: `scaleX(${transferFraction(item.progress)})` }" />
        </div>
        <p v-if="item.progress.error" class="transfers__error" role="alert">{{ item.progress.error }}</p>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { dismissTransfer, transferFraction, transfers, type TransferEntry } from '@/services/transfers'
import { debug } from '@/utils/debug'

const { t } = useT()

const route = useRoute()
// A transfer whose own page shows its progress is listed only elsewhere.
const shown = computed(() => transfers().filter((entry) => entry.shown && (!entry.origin || entry.origin !== route?.path)))
const running = (direction: TransferEntry['direction']) =>
  shown.value.filter((entry) => entry.direction === direction && entry.progress.status === 'running').length

const heading = computed(() => {
  const uploads = running('upload')
  if (uploads > 0) return t('transfers.uploading', { count: uploads }, uploads)
  const downloads = running('download')
  if (downloads > 0) return t('transfers.downloading', { count: downloads }, downloads)
  return t('transfers.label')
})

function percent(entry: TransferEntry): number {
  return Math.round(transferFraction(entry.progress) * 100)
}

async function reveal(path: string): Promise<void> {
  try {
    const { revealItemsInDir } = await import('@tauri-apps/plugin-opener')
    await revealItemsInDir(path)
  } catch (error) {
    debug.warn('Could not show the download in its folder', error)
  }
}
</script>

<style scoped>
/* 72px clears the chat composer and the phone tab bar under it. */
.transfers {
  position: fixed;
  right: var(--space-4, 16px);
  bottom: calc(var(--space-4, 16px) + 72px + env(safe-area-inset-bottom, 0px));
  z-index: 900;
  width: min(340px, calc(100 * var(--app-vw) - 32px));
  overflow: hidden;
  background: var(--background-floating, var(--background-secondary));
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-high, 0 12px 32px rgb(0 0 0 / 0.35));
  animation: transfers-in 0.18s ease-out;
}

.transfers__head {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-color);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.transfers__list {
  max-height: 240px;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  overflow-y: auto;
  list-style: none;
}

.transfers__item + .transfers__item {
  margin-top: var(--space-2);
}

.transfers__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
}

.transfers__kind {
  flex-shrink: 0;
  color: var(--text-muted);
}

.transfers__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.transfers__state {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.transfers__item[data-status='completed'] .transfers__state {
  color: var(--text-success, #3ba55c);
}

.transfers__reconnecting {
  color: var(--text-warning, #faa61a);
}

.transfers__btn {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  color: var(--text-muted);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.transfers__btn:hover,
.transfers__btn:focus-visible {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.transfers__bar {
  height: 3px;
  margin-top: 4px;
  overflow: hidden;
  background: var(--background-modifier-active);
  border-radius: var(--radius-full);
}

.transfers__bar span {
  display: block;
  height: 100%;
  background: var(--harmony-primary);
  transform-origin: left center;
  transition: transform 0.2s linear;
}

.transfers__error {
  margin: 2px 0 0;
  font-size: var(--font-size-xs);
  color: var(--danger);
}

@keyframes transfers-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .transfers { animation: none; }
  .transfers__bar span { transition: none; }
}
</style>
