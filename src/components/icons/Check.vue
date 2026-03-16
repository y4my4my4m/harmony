<template>
  <Check class="icon-component" :size="size" :stroke-width="2" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { Check } from 'lucide-vue-next';

export default defineComponent({
  name: 'CheckIcon',
  components: { Check },
  props: {
    size: { type: [Number, String], default: 20 }
  }
});
</script>

<style scoped>
.icon-component { color: currentColor; }
</style>
