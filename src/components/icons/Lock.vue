<template>
  <Lock :size="iconSize" :stroke-width="2" :class="className" />
</template>

<script lang="ts">
import { defineComponent, computed } from 'vue';
import { Lock } from 'lucide-vue-next';

import { resolveIconSize } from '@/utils/iconSize';
export default defineComponent({
  name: 'LockIcon',
  components: { Lock },
  props: {
    size: { type: [Number, String], default: 20 },
    className: { type: String, default: '' }
  }
  ,
  setup(props) {
    const iconSize = computed(() => resolveIconSize(props.size as number | string | undefined, 20))
    return { iconSize }
  }

});
</script>
