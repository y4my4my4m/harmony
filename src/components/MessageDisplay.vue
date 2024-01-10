<template>
  <div class="message-display">
    <div v-for="message in messages" :key="message.id" class="message">
      <strong>{{ message.sender }}:</strong> {{ message.content }}
    </div>
  </div>
</template>
  

<script lang="ts">
import { defineComponent } from 'vue';
import type { PropType } from 'vue';
import type { ChatMessage } from '../types';

export default defineComponent({
  props: {
    messages: {
      type: Array as PropType<ChatMessage[]>,
      required: true
    }
  }
});
</script>
<style scoped>
.message-display {
  flex-grow: 1;
  overflow-y: auto;
  /* additional styling */
}
</style>
