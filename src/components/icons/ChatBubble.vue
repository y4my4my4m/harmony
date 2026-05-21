<template>
  <MessageSquare :size="iconSize" :stroke-width="2" :class="className" />
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue';
import { MessageSquare } from 'lucide-vue-next';

import { resolveIconSize } from '@/utils/iconSize';
export default defineComponent({
  name: 'ChatBubble',
  components: { MessageSquare },
  props: {
    size: { type: [Number, String], default: 24 },
    className: { type: String, default: '' }
  }
  ,
  setup(props) {
    const iconSize = computed(() => resolveIconSize(props.size as number | string | undefined, 24))
    return { iconSize }
  }

});
</script>
