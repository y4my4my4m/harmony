<template>
  <EyeOff :size="size" :stroke-width="2" :class="className" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { EyeOff } from 'lucide-vue-next';

export default defineComponent({
  name: 'EyeOffIcon',
  components: { EyeOff },
  props: {
    size: { type: [Number, String], default: 20 },
    className: { type: String, default: '' }
  }
});
</script>
