<template>
  <MessageSquare :size="size" :stroke-width="2" :class="className" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { MessageSquare } from 'lucide-vue-next';

export default defineComponent({
  name: 'ChatBubble',
  components: { MessageSquare },
  props: {
    size: { type: [Number, String], default: 24 },
    className: { type: String, default: '' }
  }
});
</script>
