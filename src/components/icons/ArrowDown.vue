<template>
  <ArrowDown class="icon-component" :size="Number(size)" :stroke-width="2" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { ArrowDown } from 'lucide-vue-next';

export default defineComponent({
  name: 'ArrowDownIcon',
  components: { ArrowDown },
  props: {
    size: { type: [Number, String], default: 20 }
  }
});
</script>

<style scoped>
.icon-component { color: currentColor; }
</style>
