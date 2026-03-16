<template>
  <Keyboard :size="size" :stroke-width="2" :class="className" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { Keyboard } from 'lucide-vue-next';

export default defineComponent({
  name: 'KeyboardIcon',
  components: { Keyboard },
  props: {
    size: { type: [Number, String], default: 20 },
    className: { type: String, default: '' }
  }
});
</script>
