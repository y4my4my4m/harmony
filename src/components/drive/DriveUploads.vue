<!-- Progress of uploads into Drive, bottom right of the page. -->
<template>
  <section v-if="drive.uploads.length" class="drive-uploads" :aria-label="t('drive.uploads.label')" data-testid="drive-uploads">
    <header class="drive-uploads__head">
      <span>{{ t('drive.uploads.title', { count: running }, running) }}</span>
    </header>
    <ul class="drive-uploads__list">
      <li v-for="item in drive.uploads" :key="item.key" class="drive-uploads__item">
        <div class="drive-uploads__row">
          <span class="drive-uploads__name">{{ item.name }}</span>
          <span class="drive-uploads__state" :class="item.upload.state.status">
            <template v-if="item.upload.state.status === 'uploading'">{{ Math.round(item.upload.state.progress * 100) }}%</template>
            <Icon v-else-if="item.upload.state.status === 'completed'" name="check" :size="14" />
            <button v-else type="button" class="drive-icon-btn" :aria-label="t('common.close')" @click="drive.dismissUpload(item.key)">
              <Icon name="x" :size="14" />
            </button>
          </span>
        </div>
        <div v-if="item.upload.state.status === 'uploading'" class="drive-uploads__bar">
          <span :style="{ transform: `scaleX(${item.upload.state.progress})` }" />
        </div>
        <p v-if="item.upload.state.error" class="drive-uploads__error">{{ item.upload.state.error }}</p>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { useDriveStore } from '@/stores/drive'

const { t } = useT()
const drive = useDriveStore()
const running = computed(() => drive.uploads.filter((u) => u.upload.state.status === 'uploading').length)
</script>

<style scoped>
.drive-uploads {
  position: absolute;
  right: var(--space-4);
  bottom: var(--space-4);
  z-index: 5;
  width: min(340px, calc(100% - 32px));
  overflow: hidden;
  background: var(--background-floating, var(--background-secondary));
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-high, 0 12px 32px rgb(0 0 0 / 0.35));
  animation: drive-uploads-in 0.18s ease-out;
}

.drive-uploads__head {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border-color);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.drive-uploads__list {
  max-height: 240px;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  overflow-y: auto;
  list-style: none;
}

.drive-uploads__item + .drive-uploads__item {
  margin-top: var(--space-2);
}

.drive-uploads__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
}

.drive-uploads__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drive-uploads__state {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.drive-uploads__state.completed {
  color: var(--text-success, #3ba55c);
}

.drive-uploads__bar {
  height: 3px;
  margin-top: 4px;
  overflow: hidden;
  background: var(--background-modifier-active);
  border-radius: var(--radius-full);
}

.drive-uploads__bar span {
  display: block;
  height: 100%;
  background: var(--harmony-primary);
  transform-origin: left center;
  transition: transform 0.2s linear;
}

.drive-uploads__error {
  margin: 2px 0 0;
  font-size: var(--font-size-xs);
  color: var(--danger);
}

@keyframes drive-uploads-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .drive-uploads { animation: none; }
}
</style>
