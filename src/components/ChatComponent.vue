<template>
  <div class="chat-container">
    <MessageDisplay :messages="messages" />
    <MessageInput @sendMessage="handleSendMessage" />
  </div>
</template>

<script lang="ts">
import { defineComponent, onMounted } from 'vue';
import MessageDisplay from './MessageDisplay.vue';
import MessageInput from './MessageInput.vue';
import { useAuthStore } from '@/stores/auth'; 
import { useChatStore } from '@/stores/useChat'; 
import { useServerChannelStore } from '@/stores/useServerChannel'; 

export default defineComponent({
  name: 'ChatComponent',
  components: {
    MessageDisplay,
    MessageInput
  },
  props: {
    channelId: {
      type: Number,
      required: true,
    },
  },
  setup(props) {
    const chatStore = useChatStore();
    const authStore = useAuthStore();
    const serverChannelStore = useServerChannelStore();

    onMounted(() => {
      // Subscribe to messages for the current channel
      chatStore.subscribeToMessages(props.channelId);
      // Fetch initial set of messages
      chatStore.fetchMessages(props.channelId);
    });

    const handleSendMessage = async (content: string) => {
      if (authStore.session?.user) {
        // Use the sendMessage action from the chat store
        chatStore.sendMessage(props.channelId, authStore.session.user.id, content);
      }
    };

    return { messages: chatStore.messages, handleSendMessage };
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
