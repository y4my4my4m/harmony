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
    <circle cx="12" cy="12" r="2" />
    <path d="M20 12c-2 0-4-1.5-4-4s2-4 4-4 4 1.5 4 4-2 4-4 4Z" />
    <path d="M4 12c2 0 4-1.5 4-4S6 4 4 4s-4 1.5-4 4 2 4 4 4Z" />
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