<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    :class="className"
  >
    <line x1="7" y1="17" x2="17" y2="7" />
    <polyline points="7,7 17,7 17,17" />
  </svg>
</template>

<script setup lang="ts">
interface Props {
  size?: number | string
  className?: string
}

withDefaults(defineProps<Props>(), {
  size: 16,
  className: ''
})
</script>