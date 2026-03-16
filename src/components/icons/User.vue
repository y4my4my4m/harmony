<template>
  <User :size="size" :stroke-width="2" :class="className" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { User } from 'lucide-vue-next';

export default defineComponent({
  name: 'UserIcon',
  components: { User },
  props: {
    size: { type: [Number, String], default: 20 },
    className: { type: String, default: '' }
  }
});
</script>
