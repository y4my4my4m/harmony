<template>
  <div class="toggle-switch" :class="{ active: modelValue }" @click="toggle">
    <div class="toggle-slider">
      <div class="toggle-knob"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Props
interface Props {
  modelValue: boolean
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false
})

// Emits
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'change': [value: boolean]
}>()

// Methods
const toggle = () => {
  if (props.disabled) return
  
  const newValue = !props.modelValue
  emit('update:modelValue', newValue)
  emit('change', newValue)
}
</script>

<style scoped>
.toggle-switch {
  width: 44px;
  height: 24px;
  background-color: #4f545c;
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
  flex-shrink: 0;
}

.toggle-switch:hover:not(.disabled) {
  background-color: #5d6269;
}

.toggle-switch.active {
  background-color: #5865f2;
}

.toggle-switch.active:hover:not(.disabled) {
  background-color: #4752c4;
}

.toggle-switch.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.toggle-slider {
  width: 100%;
  height: 100%;
  position: relative;
}

.toggle-knob {
  width: 18px;
  height: 18px;
  background-color: #ffffff;
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