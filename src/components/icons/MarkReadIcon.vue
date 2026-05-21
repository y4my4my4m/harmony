<template>
  <Check :size="iconSize" :stroke-width="2" :class="className" />
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue';
import { Check } from 'lucide-vue-next';

import { resolveIconSize } from '@/utils/iconSize';
export default defineComponent({
  name: 'MarkReadIcon',
  components: { Check },
  props: {
    size: { type: [Number, String], default: 16 },
    className: { type: String, default: '' }
  }
  ,
  setup(props) {
    const iconSize = computed(() => resolveIconSize(props.size as number | string | undefined, 16))
    return { iconSize }
  }

});
</script>
