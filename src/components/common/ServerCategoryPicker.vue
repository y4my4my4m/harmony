<template>
  <div class="category-picker" role="radiogroup" :aria-labelledby="labelledby">
    <label
      v-for="option in options"
      :key="option.id ?? ''"
      class="category-picker__chip"
      :class="{
        'category-picker__chip--active': option.id === modelValue,
        'category-picker__chip--disabled': disabled,
      }"
      :data-category="option.id ?? 'none'"
    >
      <input
        type="radio"
        class="category-picker__radio"
        :name="name"
        :checked="option.id === modelValue"
        :disabled="disabled"
        @change="emit('update:modelValue', option.id)"
      />
      <Icon :name="option.icon" :size="14" class="category-picker__icon" />
      <span>{{ option.label }}</span>
    </label>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import {
  SERVER_CATEGORIES,
  categoryIcon,
  categoryLabelKey,
  type ServerCategory,
} from '@/utils/serverDiscovery'

interface Props {
  /** Stored servers.category; null is "not chosen". */
  modelValue: string | null
  /** Radio group name, unique per page. */
  name: string
  /** id of the element that labels the group. */
  labelledby?: string
  disabled?: boolean
}

withDefaults(defineProps<Props>(), {
  labelledby: undefined,
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: ServerCategory | null]
}>()

const { t } = useI18n()

const options = computed(() => [
  { id: null, icon: 'circle', label: t('server.discoveryCategoryNone') },
  ...SERVER_CATEGORIES.map(id => ({
    id,
    icon: categoryIcon(id) ?? 'tag',
    label: t(categoryLabelKey(id) ?? id),
  })),
])
</script>

<style scoped>
.category-picker {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.category-picker__chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.category-picker__chip:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.category-picker__chip:has(.category-picker__radio:focus-visible) {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.category-picker__chip--active,
.category-picker__chip--active:hover {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

.category-picker__chip--disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.category-picker__chip--disabled:not(.category-picker__chip--active):hover {
  background: transparent;
  color: var(--text-secondary);
}

/* Visually hidden; stays focusable so the chips behave as a native radio group. */
.category-picker__radio {
  position: absolute;
  opacity: 0;
  width: 1px;
  height: 1px;
  margin: 0;
  pointer-events: none;
}

.category-picker__icon {
  flex-shrink: 0;
  opacity: 0.85;
}
</style>
