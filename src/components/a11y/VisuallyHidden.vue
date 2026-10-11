<!--
  VisuallyHidden - text for screen readers only; same rules as the global `.sr-only`
  class (assets/design-system.css). `as` picks the element (default span).
  `focusable` reveals it while focused (skip links).

    <button><Icon name="trash" /><VisuallyHidden>{{ t('common.delete') }}</VisuallyHidden></button>
-->
<template>
  <component :is="as" :class="focusable ? 'sr-only-focusable' : 'sr-only'"><slot /></component>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ as?: string; focusable?: boolean }>(), { as: 'span', focusable: false })
</script>
