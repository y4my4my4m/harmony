<template>
  <section
    :id="`today-${id}`"
    class="today-section"
    :aria-labelledby="headingId"
    :aria-busy="state === 'loading'"
    tabindex="-1"
  >
    <header class="today-section-header">
      <Icon :name="icon" :size="16" class="today-section-icon" aria-hidden="true" />
      <h2 :id="headingId" class="today-section-title">{{ title }}</h2>
      <span v-if="state === 'ready' && count" class="today-section-count">{{ count > 99 ? '99+' : count }}</span>
      <div v-if="state === 'ready' && $slots.actions" class="today-section-actions">
        <slot name="actions" />
      </div>
    </header>

    <div v-if="state === 'loading'" class="today-skeleton" aria-hidden="true">
      <div v-for="n in skeletonRows" :key="n" class="today-skeleton-row">
        <span class="skeleton today-skeleton-avatar"></span>
        <span class="today-skeleton-lines">
          <span class="skeleton today-skeleton-line" :style="{ width: `${45 + ((n * 17) % 30)}%` }"></span>
          <span class="skeleton today-skeleton-line" :style="{ width: `${70 + ((n * 11) % 25)}%` }"></span>
        </span>
      </div>
      <span class="sr-only">{{ t('common.loading') }}</span>
    </div>

    <div v-else-if="state === 'error'" class="today-section-error" role="alert">
      <Icon name="alert-circle" :size="16" aria-hidden="true" />
      <span>{{ errorText }}</span>
      <button type="button" class="today-link-button" @click="emit('retry')">{{ t('common.retry') }}</button>
    </div>

    <p v-else-if="state === 'empty'" class="today-section-empty">
      <Icon name="check-circle" :size="14" aria-hidden="true" />
      <span>{{ emptyText }}</span>
    </p>

    <slot v-else />
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'

export type TodaySectionState = 'loading' | 'error' | 'empty' | 'ready'

const props = withDefaults(defineProps<{
  id: string
  title: string
  icon: string
  state: TodaySectionState
  count?: number
  emptyText?: string
  errorText?: string
  skeletonRows?: number
}>(), {
  count: 0,
  emptyText: '',
  errorText: '',
  skeletonRows: 3,
})

const emit = defineEmits<{ (e: 'retry'): void }>()

const { t } = useI18n()
const headingId = computed(() => `today-${props.id}-heading`)
</script>

<style scoped>
.today-section {
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  min-width: 0;
  scroll-margin-top: var(--space-4);
}

.today-section:focus {
  outline: none;
}

.today-section:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.today-section-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 28px;
  margin-bottom: var(--space-3);
}

.today-section-icon {
  color: var(--text-secondary);
  flex-shrink: 0;
}

.today-section-title {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.today-section-count {
  flex-shrink: 0;
  min-width: 20px;
  padding: 0 6px;
  border-radius: var(--radius-full);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  line-height: 20px;
  text-align: center;
}

.today-section-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.today-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.today-skeleton-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.today-skeleton-avatar {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-full);
  flex-shrink: 0;
}

.today-skeleton-lines {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.today-skeleton-line {
  display: block;
  height: 10px;
}

/* The global .skeleton gradient runs between the secondary and tertiary surfaces; the card is
   the secondary surface, so the stops shift one step down. */
.today-section .skeleton {
  background: linear-gradient(
    90deg,
    var(--background-tertiary) 25%,
    var(--background-quaternary) 50%,
    var(--background-tertiary) 75%
  );
  background-size: 200% 100%;
}

@media (prefers-reduced-motion: reduce) {
  .today-section .skeleton {
    background: var(--background-tertiary);
  }
}

.today-section-error,
.today-section-empty {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.today-section-error {
  color: var(--error);
}

.today-section-error span {
  color: var(--text-secondary);
}

.today-section-empty :deep(.icon-wrap) {
  color: var(--success);
}

.today-link-button {
  padding: 2px var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--harmony-primary);
  font: inherit;
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
}

.today-link-button:hover {
  text-decoration: underline;
}

.today-link-button:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
