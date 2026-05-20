<template>
  <Eye :size="Number(size)" :stroke-width="2" :class="className" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { Eye } from 'lucide-vue-next';

export default defineComponent({
  name: 'EyeIcon',
  components: { Eye },
  props: {
    size: { type: [Number, String], default: 20 },
    className: { type: String, default: '' }
  }
});
</script>
