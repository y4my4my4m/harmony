<!--
  ToggleSwitch - on/off control, role="switch" on a <button>. A name is required:
  `labelledby` (id of the visible label, preferred) or `label` (translated text).
  `describedby` points at a description paragraph. A disabled switch stays
  focusable with aria-disabled, so it is found and read as unavailable.

    <h4 :id="`${uid}-label`">{{ t('settings.x') }}</h4>
    <p :id="`${uid}-desc`">{{ t('settings.xDesc') }}</p>
    <ToggleSwitch v-model="x" :labelledby="`${uid}-label`" :describedby="`${uid}-desc`" />

    <ToggleSwitch v-model="enabled" :label="t('automod.ruleEnabled', { name })" />

  src/components/common/__tests__/ToggleSwitch.test.ts fails on any usage in
  src/ without one of the two.
-->
<template>
  <button
    type="button"
    class="toggle-switch"
    :class="{ active: modelValue, disabled }"
    role="switch"
    :aria-checked="modelValue ? 'true' : 'false'"
    :aria-label="labelledby ? undefined : label"
    :aria-labelledby="labelledby || undefined"
    :aria-describedby="describedby || undefined"
    :aria-disabled="disabled ? 'true' : undefined"
    @click="toggle"
  >
    <span class="toggle-slider" aria-hidden="true">
      <span class="toggle-knob"></span>
    </span>
  </button>
</template>

<script setup lang="ts">
import { useHapticSettings } from '@/composables/useHapticSettings'

interface Props {
  modelValue: boolean
  disabled?: boolean
  /** Accessible name; required unless `labelledby` is given. */
  label?: string
  /** Id of the element naming the switch. */
  labelledby?: string
  describedby?: string
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
})

if (import.meta.env.DEV && !props.label && !props.labelledby) {
  console.warn('[ToggleSwitch] neither label nor labelledby is set; the switch has no accessible name')
}

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'change': [value: boolean]
}>()

const { triggerToggle } = useHapticSettings()

const toggle = () => {
  if (props.disabled) return
  const newValue = !props.modelValue
  emit('update:modelValue', newValue)
  emit('change', newValue)
  triggerToggle()
}
</script>

<style scoped>
.toggle-switch {
  appearance: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  display: inline-block;
  width: 44px;
  height: 24px;
  background-color: var(--background-quaternary);
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
  flex-shrink: 0;
  /* Off-state track edge against light surfaces (WCAG 1.4.11, 3:1). */
  box-shadow: inset 0 0 0 1px var(--border-hover);
}

.toggle-switch:hover:not(.disabled) {
  background-color: var(--background-quinary);
}

.toggle-switch.active {
  background-color: var(--harmony-primary);
  box-shadow: none;
}

.toggle-switch.active:hover:not(.disabled) {
  background-color: var(--harmony-primary-hover);
}

.toggle-switch.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.toggle-switch:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.toggle-slider {
  display: block;
  width: 100%;
  height: 100%;
  position: relative;
}

.toggle-knob {
  display: block;
  width: 18px;
  height: 18px;
  background-color: var(--toggle-knob, #ffffff);
  border-radius: 50%;
  position: absolute;
  top: 3px;
  left: 3px;
  transition: all 0.2s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
}

.toggle-switch.active .toggle-knob {
  transform: translateX(20px);
}
</style>
