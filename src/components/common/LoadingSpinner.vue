<template>
  <div class="harmony-spinner" :style="spinnerStyle" role="status" aria-label="Loading"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

/**
 * Canonical loading spinner; uses the active theme's primary colour.
 * Spinners inside a coloured button should use a contrast colour
 * (white / currentColor) instead - this one is for standalone loading states.
 *
 * Pair with a label inside `.loading-state`, `.loading-spinner-container`,
 * `.loading-indicator`, or `div.loading` so design-system `gap: 1rem` applies.
 * Use `.loading-state-label` on caption text (margin reset).
 */
const props = withDefaults(defineProps<{
  /** Diameter in px (number) or any CSS length (string). */
  size?: number | string
  /** Border thickness in px. */
  thickness?: number
}>(), {
  // Matches design-system `.loading-spinner` defaults (BaseLayout).
  size: 32,
  thickness: 3,
})

const spinnerStyle = computed(() => {
  const dimension = typeof props.size === 'number' ? `${props.size}px` : props.size
  return {
    width: dimension,
    height: dimension,
    borderWidth: `${props.thickness}px`,
  }
})
</script>

<style scoped>
.harmony-spinner {
  box-sizing: border-box;
  border-style: solid;
  border-color: rgba(255, 255, 255, 0.08);
  border-top-color: var(--harmony-primary, var(--h-brand, #0ea5e9));
  border-radius: 50%;
  animation: harmony-spin 1s linear infinite;
}

@keyframes harmony-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
