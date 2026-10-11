<!--
  ChannelPermissionTriState - one channel-override permission as a radio group of
  Deny / Inherit / Allow (APG radio group: one Tab stop, arrow keys move and select,
  wrapping). The group is named by `labelledby`, the permission's visible label.

    <span :id="labelId">{{ t('...label') }}</span>
    <ChannelPermissionTriState :model-value="state" :labelledby="labelId" @update:model-value="set" />
-->
<template>
  <div
    ref="root"
    class="perm-tristate"
    role="radiogroup"
    :aria-labelledby="labelledby"
    :aria-describedby="describedby || undefined"
    @keydown="onKeydown"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      class="perm-tristate-btn"
      :class="[`state-${option.value}`, { active: modelValue === option.value }]"
      :data-state="option.value"
      :aria-checked="modelValue === option.value ? 'true' : 'false'"
      :tabindex="modelValue === option.value ? 0 : -1"
      :title="option.title"
      @click="select(option.value)"
    >
      <Icon :name="option.icon" :size="14" aria-hidden="true" />
      <span class="sr-only">{{ option.label }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { useRovingTabindex } from '@/composables/useRovingTabindex'

export type TriState = 'allow' | 'inherit' | 'deny'

const props = defineProps<{
  modelValue: TriState
  labelledby: string
  describedby?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: TriState] }>()

const { t } = useI18n()

const options = computed(() => [
  { value: 'deny' as const, icon: 'x', label: t('channel.edit.tristate.deny'), title: t('channel.edit.tristate.deny') },
  { value: 'inherit' as const, icon: 'minus', label: t('channel.edit.tristate.inherit'), title: t('channel.edit.tristate.inheritTitle') },
  { value: 'allow' as const, icon: 'check', label: t('channel.edit.tristate.allow'), title: t('channel.edit.tristate.allow') },
])

const root = ref<HTMLElement | null>(null)

function select(value: TriState) {
  if (value !== props.modelValue) emit('update:modelValue', value)
}

const { onKeydown } = useRovingTabindex(root, {
  itemSelector: '[role="radio"]',
  orientation: 'both',
  onActivate: (item) => select(item.dataset.state as TriState),
})
</script>

<style scoped>
/* Discord-style three-button group. The checked option carries an inset ring
   as well as its colour. */
.perm-tristate {
  display: inline-flex;
  background: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
}

.perm-tristate-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 28px;
  background: transparent;
  border: none;
  color: var(--text-tertiary, var(--text-secondary));
  cursor: pointer;
  font-size: 14px;
  font-weight: 700;
  transition: background 0.15s, color 0.15s;
}

.perm-tristate-btn:hover {
  background: var(--background-modifier-hover);
}

.perm-tristate-btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}

.perm-tristate-btn.active {
  box-shadow: inset 0 0 0 2px currentColor;
}

.perm-tristate-btn.active.state-allow {
  background: color-mix(in srgb, var(--success) 18%, transparent);
  color: var(--text-success);
}

.perm-tristate-btn.active.state-deny {
  background: color-mix(in srgb, var(--error) 18%, transparent);
  color: var(--text-danger);
}

.perm-tristate-btn.active.state-inherit {
  background: var(--background-modifier-selected);
  color: var(--text-primary);
}
</style>
