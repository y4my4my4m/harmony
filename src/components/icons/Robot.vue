<template>
  <Bot class="icon-component" :size="size" :stroke-width="2" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { Bot } from 'lucide-vue-next';

export default defineComponent({
  name: 'RobotIcon',
  components: { Bot },
  props: {
    size: { type: [Number, String], default: 18 }
  }
});
</script>

<style scoped>
.icon-component { color: currentColor; }
</style>
