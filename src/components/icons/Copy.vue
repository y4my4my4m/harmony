<template>
  <Copy class="icon-component" :size="iconSize" :stroke-width="2" />
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue';
import { Copy } from 'lucide-vue-next';

import { resolveIconSize } from '@/utils/iconSize';
export default defineComponent({
  name: 'CopyIcon',
  components: { Copy },
  props: {
    size: { type: [Number, String], default: 20 }
  }
  ,
  setup(props) {
    const iconSize = computed(() => resolveIconSize(props.size as number | string | undefined, 20))
    return { iconSize }
  }

});
</script>

<style scoped>
.icon-component { color: currentColor; }
</style>
