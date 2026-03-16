<template>
  <SmilePlus class="icon-component" :size="18" :stroke-width="2" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { SmilePlus } from 'lucide-vue-next';

export default defineComponent({
  name: 'ReactionIcon',
  components: { SmilePlus },
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
