<template>
  <div class="harmony-spinner" :style="spinnerStyle" role="status" aria-label="Loading"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

/**
 * The one canonical loading spinner. Always uses the active theme's primary
 * colour so it stays on-brand across every instance/theme. Use this everywhere
 * instead of hand-rolled `.loading-spinner` / `.spinner` divs.
 *
 * Note: spinners that sit INSIDE a coloured button should keep using a
 * contrast colour (white / currentColor) for legibility - this component is for
 * standalone loading states on the app background.
 */
const props = withDefaults(defineProps<{
  /** Diameter in px (number) or any CSS length (string). */
  size?: number | string
  /** Border thickness in px. */
  thickness?: number
}>(), {
  // Matches the original app-boot / design-system `.loading-spinner` (BaseLayout).
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
