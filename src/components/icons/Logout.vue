<template>
  <LogOut :size="Number(size)" :stroke-width="2" :class="className" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { LogOut } from 'lucide-vue-next';

export default defineComponent({
  name: 'LogoutIcon',
  components: { LogOut },
  props: {
    size: { type: [Number, String], default: 20 },
    className: { type: String, default: '' }
  }
});
</script>
