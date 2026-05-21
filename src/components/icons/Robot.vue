<template>
  <Bot class="icon-component" :size="iconSize" :stroke-width="2" />
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue';
import { Bot } from 'lucide-vue-next';

import { resolveIconSize } from '@/utils/iconSize';
export default defineComponent({
  name: 'RobotIcon',
  components: { Bot },
  props: {
    size: { type: [Number, String], default: 18 }
  }
  ,
  setup(props) {
    const iconSize = computed(() => resolveIconSize(props.size as number | string | undefined, 18))
    return { iconSize }
  }

});
</script>

<style scoped>
.icon-component { color: currentColor; }
</style>
