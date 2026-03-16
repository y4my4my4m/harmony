<template>
  <MicOff class="icon-component" :size="20" :stroke-width="2" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { MicOff } from 'lucide-vue-next';

export default defineComponent({
  name: 'MicMutedIcon',
  components: { MicOff },
});
</script>

<style scoped>
.icon-component {
  color: currentColor;
  transition: color 0.2s;
  cursor: pointer;
}
</style>
