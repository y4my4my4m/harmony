<template>
  <Hash class="icon-component" :size="24" :stroke-width="2" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { Hash } from 'lucide-vue-next';

export default defineComponent({
  name: 'HashTag',
  components: { Hash },
});
</script>

<style scoped>
.icon-component {
  color: currentColor;
}
</style>
