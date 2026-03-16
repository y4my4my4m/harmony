<template>
  <Trash2 class="icon-component" :size="size" :stroke-width="2" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { Trash2 } from 'lucide-vue-next';

export default defineComponent({
  name: 'TrashIcon',
  components: { Trash2 },
  props: {
    size: { type: [Number, String], default: 20 }
  }
});
</script>

<style scoped>
.icon-component { color: currentColor; }
</style>
