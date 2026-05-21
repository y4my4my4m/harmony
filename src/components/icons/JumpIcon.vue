<template>
  <ArrowUpRight :size="iconSize" :stroke-width="2" :class="className" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ArrowUpRight } from 'lucide-vue-next';

import { resolveIconSize } from '@/utils/iconSize';
interface Props {
  size?: number | string
  className?: string
}

const props = withDefaults(defineProps<Props>(), {
  size: 16,
  className: ''
})

const iconSize = computed(() => resolveIconSize(props.size, 16))
</script>
