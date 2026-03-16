<template>
  <ChevronDown class="icon-component" :size="size" :stroke-width="2" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { ChevronDown } from 'lucide-vue-next';

export default defineComponent({
  name: 'ChevronDownIcon',
  components: { ChevronDown },
  props: {
    size: { type: [Number, String], default: 20 }
  }
});
</script>

<style scoped>
.icon-component { color: currentColor; }
</style>
