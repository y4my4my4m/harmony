<template>
  <div
    class="list-empty"
    :class="[`list-empty--${size}`, { 'list-empty--error': tone === 'error' }]"
    :role="tone === 'error' ? 'alert' : 'status'"
  >
    <div v-if="icon || $slots.icon" class="list-empty__icon" aria-hidden="true">
      <slot name="icon">
        <Icon :name="icon!" :size="size === 'sm' ? 20 : 26" />
      </slot>
    </div>
    <p v-if="title" class="list-empty__title">{{ title }}</p>
    <p v-if="description || $slots.default" class="list-empty__description">
      <slot>{{ description }}</slot>
    </p>
    <div v-if="actionLabel || $slots.actions" class="list-empty__actions">
      <slot name="actions">
        <button type="button" class="list-empty__button" @click="emit('action')">
          {{ actionLabel }}
        </button>
      </slot>
    </div>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'

/**
 * Placeholder for a list, feed or panel with nothing to show. `md` fills a
 * page, modal or drawer body; `sm` fits sidebars, popovers and pickers.
 * Slots: `icon` (replaces the Icon), default (rich description), `actions`
 * (replaces the single `actionLabel` button).
 */
withDefaults(
  defineProps<{
    icon?: string
    title?: string
    description?: string
    actionLabel?: string
    size?: 'sm' | 'md'
    tone?: 'default' | 'error'
  }>(),
  { size: 'md', tone: 'default' },
)

const emit = defineEmits<{ action: [] }>()
</script>

<style scoped>
.list-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  box-sizing: border-box;
  width: 100%;
  padding: var(--space-12) var(--space-6);
  text-align: center;
  color: var(--text-secondary);
}

.list-empty__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  margin-bottom: var(--space-2);
  border-radius: var(--radius-full);
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  flex-shrink: 0;
}

.list-empty__title {
  margin: 0;
  max-width: 420px;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-tight);
  color: var(--text-primary);
}

.list-empty__description {
  margin: 0;
  max-width: 360px;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

.list-empty__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.list-empty__button,
.list-empty__actions :slotted(.list-empty__button) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 40px;
  padding: 0 var(--space-4);
  border: none;
  border-radius: var(--radius-md);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.list-empty__button:hover,
.list-empty__actions :slotted(.list-empty__button:hover) {
  background: var(--harmony-primary-hover);
}

.list-empty__actions :slotted(.list-empty__button--secondary) {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.list-empty__actions :slotted(.list-empty__button--secondary:hover) {
  background: var(--background-modifier-active);
}

.list-empty--sm {
  gap: var(--space-1);
  padding: var(--space-6) var(--space-4);
}

.list-empty--sm .list-empty__icon {
  width: 40px;
  height: 40px;
  margin-bottom: var(--space-1);
}

.list-empty--sm .list-empty__title {
  font-size: var(--font-size-sm);
}

.list-empty--sm .list-empty__description {
  font-size: var(--font-size-xs);
}

.list-empty--error .list-empty__icon {
  background: color-mix(in srgb, var(--error) 14%, transparent);
  color: var(--error);
}
</style>
