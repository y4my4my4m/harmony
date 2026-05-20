<template>
  <Copy class="icon-component" :size="Number(size)" :stroke-width="2" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { Copy } from 'lucide-vue-next';

export default defineComponent({
  name: 'CopyIcon',
  components: { Copy },
  props: {
    size: { type: [Number, String], default: 20 }
  }
});
</script>

<style scoped>
.icon-component { color: currentColor; }
</style>
