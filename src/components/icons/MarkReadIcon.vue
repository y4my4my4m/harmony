<template>
  <Check :size="size" :stroke-width="2" :class="className" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { Check } from 'lucide-vue-next';

export default defineComponent({
  name: 'MarkReadIcon',
  components: { Check },
  props: {
    size: { type: [Number, String], default: 16 },
    className: { type: String, default: '' }
  }
});
</script>
