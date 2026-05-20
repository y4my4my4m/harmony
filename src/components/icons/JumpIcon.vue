<template>
  <ArrowUpRight :size="Number(size)" :stroke-width="2" :class="className" />
</template>

<script setup lang="ts">
import { ArrowUpRight } from 'lucide-vue-next';

interface Props {
  size?: number | string
  className?: string
}

withDefaults(defineProps<Props>(), {
  size: 16,
  className: ''
})
</script>
