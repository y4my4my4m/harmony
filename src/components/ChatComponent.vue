<template>
  <div class="chat-container">
    <MessageDisplay :messages="messages" />
    <MessageInput @sendMessage="handleSendMessage" />
  </div>
</template>

<script lang="ts">
  import { defineComponent, watch } from 'vue';
  import MessageDisplay from './MessageDisplay.vue';
  import MessageInput from './MessageInput.vue';
  import { useAuthStore } from '@/stores/auth'; 
  import { useChatStore } from '@/stores/useChat';
  import { useServerChannelStore } from '@/stores/useServerChannel'; 
  import type { ChatMessage } from '@/types';

  export default defineComponent({
    components: {
      MessageDisplay,
      MessageInput
    },
    props:{
      messages: {
        type: Array as () => ChatMessage[],
        required: true
      },
    },
    setup(props) {
      const chatStore = useChatStore();
      const authStore = useAuthStore();
      const serverChannelStore = useServerChannelStore();

      const handleSendMessage = (content: string) => {
        if (authStore.session?.user && serverChannelStore.currentChannelId) {
          chatStore.sendMessage(serverChannelStore.currentChannelId, authStore.session.user.id, content);
        }
      };
      watch(() => props.messages, (newMessages) => {
        console.log("Received messages:", newMessages);
      }, { deep: true });

      return { handleSendMessage };
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
