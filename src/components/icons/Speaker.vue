<template>
  <Volume2 class="icon-component" :size="24" :stroke-width="2" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { Volume2 } from 'lucide-vue-next';

export default defineComponent({
  name: 'Speaker',
  components: { Volume2 },
});
</script>

<style scoped>
.icon-component {
  color: currentColor;
}
</style>
