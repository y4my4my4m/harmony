<template>
  <Lock :size="Number(size)" :stroke-width="2" :class="className" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { Lock } from 'lucide-vue-next';

export default defineComponent({
  name: 'LockIcon',
  components: { Lock },
  props: {
    size: { type: [Number, String], default: 20 },
    className: { type: String, default: '' }
  }
});
</script>
