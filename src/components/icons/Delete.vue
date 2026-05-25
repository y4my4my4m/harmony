<template>
  <Trash2 class="icon-component" :size="20" :stroke-width="2" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { Trash2 } from 'lucide-vue-next';

export default defineComponent({
  name: 'DeleteIcon',
  components: { Trash2 },
});
</script>

<style scoped>
.icon-component {
  color: var(--icon-primary, #9999a0);
  transition: color 0.2s;
  cursor: pointer;
}
.icon-component:hover {
  color: var(--text-primary, #f2f3f5);
}
</style>
