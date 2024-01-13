<template>
  <div class="chat-container" 
       @dragover.prevent="showDragDropArea = true"
       @dragleave.prevent="showDragDropArea = false"
       @drop.prevent="triggerFileDrop">
    <div v-if="showDragDropArea" class="drag-drop-area">
      Drop files here
    </div>
    <MessageDisplay :messages="messages" />
    <MessageInput @sendMessage="handleSendMessage" />
  </div>
</template>

<script lang="ts">
  import { defineComponent, watch, ref } from 'vue';
  import MessageDisplay from './MessageDisplay.vue';
  import MessageInput from './MessageInput.vue';
  import { useAuthStore } from '@/stores/auth'; 
  import { useChatStore } from '@/stores/useChat';
  import { useServerChannelStore } from '@/stores/useServerChannel'; 
  import type { Message } from '@/types';
  import { handleFileDrop } from '@/services/fileService';

  export default defineComponent({
    components: {
      MessageDisplay,
      MessageInput
    },
    props:{
      messages: {
        type: Array as () => Message[],
        required: true
      },
    },
    setup(props) {
      const chatStore = useChatStore();
      const authStore = useAuthStore();
      const serverChannelStore = useServerChannelStore();
      const showDragDropArea = ref(false);

      const triggerFileDrop = async (event:any) => {
        const files = event.dataTransfer.files;
        if (files.length && serverChannelStore.currentChannelId) {
            const file = files[0];
            const fileUrl = await handleFileDrop(authStore.session?.user?.id, file);

            console.log("File uploaded to:", fileUrl);
            if (fileUrl) {
                // Send a message with the file URL
                // TODO: We should probably send the file name and size as well
                // bad practice to use empty string as content, but we don't want to send the file as content
                // we should use typed data for this, but we'll keep it simple for now
                chatStore.sendMessage(
                    serverChannelStore.currentChannelId, 
                    authStore.session.user.id, 
                    "", // No additional content, just the file
                    fileUrl // URL of the uploaded file
                );
            }
        }
        showDragDropArea.value = false;
    };


      const handleSendMessage = (content: string) => {
        if (authStore.session?.user && serverChannelStore.currentChannelId) {
          chatStore.sendMessage(serverChannelStore.currentChannelId, authStore.session.user.id, content);
        }
      };
      watch(() => props.messages, (newMessages) => {
        console.log("Received messages:", newMessages);
      }, { deep: true });

      return { handleSendMessage, triggerFileDrop, showDragDropArea };
    }
  });
</script>

<style scoped>
.chat-container {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.drag-drop-area {
  position:absolute;
  z-index:50;
  display: flex;
  height: 90%;
  width: 63%;
  border: 2px dashed #ccc;
  padding: 20px;
  text-align: center;
  margin: 20px;
  background: var(--vt-c-black);
  opacity:0.25;
  align-items: center;
  justify-content: center;
  transition: 0.2s ease-in-out;
}
.drag-drop-area:hover {
  opacity:0.8;
}
</style>
