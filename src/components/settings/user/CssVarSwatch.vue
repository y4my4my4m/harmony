<template>
  <span class="css-var-swatch" :title="title">
    <span class="css-var-swatch-fill" :style="{ backgroundColor: fill }" />
    <input
      type="color"
      class="css-var-swatch-input"
      :value="resolved.hex"
      :aria-label="label ? `Pick colour for ${label}` : 'Pick colour'"
      @input="onInput"
    />
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { formatHexAlpha, resolveCssColor, toHexAlpha } from '@/utils/cssColor'

const props = defineProps<{
  /** Effective CSS value of the variable: override text or computed value. */
  value: string
  label?: string
}>()

const emit = defineEmits<{
  pick: [value: string]
}>()

const resolved = computed(() => {
  const rgba = props.value ? resolveCssColor(props.value) : null
  return rgba
    ? { ...toHexAlpha(rgba), css: `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${rgba.a})` }
    : { hex: '#000000', alpha: 1, css: '' }
})

const fill = computed(() => resolved.value.css || 'transparent')

const title = computed(() => {
  if (!props.value) return 'unset'
  const { alpha } = resolved.value
  return alpha < 1 ? `${props.value} (alpha ${Math.round(alpha * 100)}%)` : props.value
})

// <input type="color"> carries no alpha; the current alpha is reapplied to the
// pick. Zero alpha picks as opaque, since a transparent pick paints nothing.
const onInput = (e: Event) => {
  const hex = (e.target as HTMLInputElement).value
  const alpha = resolved.value.alpha > 0 ? resolved.value.alpha : 1
  emit('pick', formatHexAlpha(hex, alpha))
}
</script>

<style scoped>
.css-var-swatch {
  position: relative;
  display: inline-block;
  overflow: hidden;
  cursor: pointer;
  /* Checkerboard shows through translucent fills. */
  background: repeating-conic-gradient(#8a8a8a 0% 25%, #d4d4d4 0% 50%) 50% / 8px 8px;
}

.css-var-swatch-fill {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.css-var-swatch-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  border: none;
  padding: 0;
  margin: 0;
}
</style>
