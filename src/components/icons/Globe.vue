<template>
  <Globe :size="Number(size)" :stroke-width="2" :class="className" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { Globe } from 'lucide-vue-next';

export default defineComponent({
  name: 'GlobeIcon',
  components: { Globe },
  props: {
    size: { type: [Number, String], default: 20 },
    className: { type: String, default: '' }
  }
});
</script>
