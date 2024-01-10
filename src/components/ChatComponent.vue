<template>
  <div class="chat-container">
    <MessageDisplay :messages="messages" />
    <MessageInput @sendMessage="handleSendMessage" />
  </div>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue';
import type { ChatMessage } from '../types';
import MessageDisplay from './MessageDisplay.vue';
import MessageInput from './MessageInput.vue';

export default defineComponent({
  name: 'ChatComponent',
  components: {
    MessageDisplay,
    MessageInput
  },
  setup() {
    const messages = ref<ChatMessage[]>([
      { id: 1, sender: 'User1', content: 'Hello there!', timestamp: new Date() },
      { id: 2, sender: 'User2', content: 'Hi! How are you?', timestamp: new Date() },
      // Add more mock messages as needed
    ]);

    const handleSendMessage = (newMessage: string) => {
      // Append new message to messages array
      const nextId = messages.value.length + 1;
      messages.value.push({ id: nextId, sender: 'CurrentUser', content: newMessage });
    };

    return { messages, handleSendMessage };
  }
});
</script>

<style scoped>
.chat-container {
  display: flex;
  flex-direction: column;
  height: 100%;
}
</style>
