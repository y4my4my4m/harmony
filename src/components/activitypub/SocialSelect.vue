<!--
  SocialSelect - a filter chip that picks one value from a SocialMenu of
  menuitemradio items, in place of a native <select> whose option list is the
  operating system's. Keys: Enter, Space or ArrowDown open the menu on the
  checked item, ArrowUp on the last; Up/Down, Home/End and typeahead move;
  Enter or Space picks; Escape and Tab close it and focus returns to the chip.

    <SocialSelect v-model="range" :options="[{ value: '1h', label: 'Last hour' }]"
                  :label="t('...')" icon="clock" :active="range !== '24h'" data-testid="..." />

  Attributes (data-testid, class) land on the chip; the menu's test id is the
  chip's with "-menu" appended.
-->
<template>
  <button
    ref="triggerRef"
    type="button"
    class="social-select"
    :class="{ 'is-active': active }"
    v-bind="$attrs"
    aria-haspopup="menu"
    :aria-expanded="open ? 'true' : 'false'"
    :aria-controls="open ? menuId : undefined"
    :aria-label="`${label}, ${currentLabel}`"
    @click="open = !open"
    @keydown="onTriggerKeydown"
  >
    <Icon v-if="icon" :name="icon" :size="14" class="social-select-icon" />
    <span class="social-select-label" aria-hidden="true">{{ currentLabel }}</span>
    <Icon name="chevron-down" :size="14" class="social-select-caret" />
  </button>
  <SocialMenu
    v-if="open"
    :id="menuId"
    class="social-select-menu"
    :data-testid="menuTestId"
    :anchor="triggerRef"
    :label="label"
    align="start"
    :initial-item="initialFocus === 'last' ? undefined : '[aria-checked=\'true\']'"
    :initial-focus="initialFocus"
    @close="open = false"
  >
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="menuitemradio"
      class="social-menu-item social-select-option"
      :aria-checked="option.value === modelValue ? 'true' : 'false'"
      :data-value="option.value"
      @click="pick(option.value)"
    >
      <span class="social-select-check" aria-hidden="true">
        <Icon v-if="option.value === modelValue" name="check" :size="14" />
      </span>
      <span class="social-select-option-label">{{ option.label }}</span>
    </button>
  </SocialMenu>
</template>

<script lang="ts">
export interface SocialSelectOption {
  value: string
  label: string
}
</script>

<script setup lang="ts">
import { computed, ref, useAttrs } from 'vue'
import { useMenuButton } from '@/composables/useMenu'
import Icon from '@/components/common/Icon.vue'
import SocialMenu from './SocialMenu.vue'

defineOptions({ inheritAttrs: false })

interface Props {
  modelValue: string
  options: SocialSelectOption[]
  /** What the chip picks; the menu's name and the start of the chip's. */
  label: string
  icon?: string
  /** Highlights the chip, for a value other than the default. */
  active?: boolean
}

const props = withDefaults(defineProps<Props>(), { icon: undefined, active: false })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const attrs = useAttrs()
const triggerRef = ref<HTMLButtonElement | null>(null)
const open = ref(false)
const { menuId, onTriggerKeydown, initialFocus } = useMenuButton(open)

const currentLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? props.modelValue,
)
const menuTestId = computed(() => {
  const id = attrs['data-testid']
  return typeof id === 'string' ? `${id}-menu` : undefined
})

const pick = (value: string) => {
  open.value = false
  triggerRef.value?.focus()
  if (value !== props.modelValue) emit('update:modelValue', value)
}
</script>

<style scoped>
.social-select {
  position: relative;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 30px;
  padding: 0 var(--space-2) 0 var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--transition-fast), background-color var(--transition-fast), border-color var(--transition-fast);
}

.social-select:hover,
.social-select[aria-expanded='true'] {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.social-select:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: -2px;
}

.social-select.is-active {
  border-color: var(--harmony-primary);
  background: var(--harmony-primary-alpha-light, var(--harmony-primary-light));
  color: var(--text-primary);
}

.social-select.is-active .social-select-icon {
  color: var(--text-link);
}

.social-select-label {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.social-select-caret {
  flex-shrink: 0;
  transition: transform 0.15s ease;
}

.social-select[aria-expanded='true'] .social-select-caret {
  transform: rotate(180deg);
}

.social-select-check {
  display: inline-flex;
  width: 14px;
  flex-shrink: 0;
  color: var(--text-link);
}

.social-select-option[aria-checked='true'] {
  font-weight: var(--font-weight-semibold);
}

.social-select-option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
