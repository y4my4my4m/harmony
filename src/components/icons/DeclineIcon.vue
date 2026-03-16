<template>
  <CircleArrowDown :size="size" :stroke-width="2" :class="className" />
</template>

<script setup lang="ts">
import { CircleArrowDown } from 'lucide-vue-next';

interface Props {
  size?: number | string
  className?: string
}

withDefaults(defineProps<Props>(), {
  size: 16,
  className: ''
})
</script>
