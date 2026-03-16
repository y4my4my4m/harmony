<template>
  <Camera class="icon-component" :size="size" :stroke-width="2" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { Camera } from 'lucide-vue-next';

export default defineComponent({
  name: 'CameraIcon',
  components: { Camera },
  props: {
    size: { type: [Number, String], default: 20 }
  }
});
</script>

<style scoped>
.icon-component { color: currentColor; }
</style>
