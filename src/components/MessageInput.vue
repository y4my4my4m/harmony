<template>
  <div class="message-input">
    <div class="left-icons">
      <PlusIcon/>
    </div>
    <textarea v-model="newMessage" @keydown.enter="handleEnter" placeholder="Type a message..."></textarea>
    <div class="right-icons">
      <GifIcon/>
      <EmojiUI/>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue';
import GifIcon from '@/components/icons/Gif.vue'
import PlusIcon from '@/components/icons/Plus.vue'
import EmojiUI from '@/components/EmojiUI.vue'

export default defineComponent({
  emits: ['sendMessage'],
  components: {
    PlusIcon,
    GifIcon,
    EmojiUI,
  },
  setup(_, { emit }) {
    const newMessage = ref('');

    const send = () => {
      if (newMessage.value.trim()) {
        emit('sendMessage', newMessage.value);
        newMessage.value = '';
      }
    };

    const handleEnter = (event: KeyboardEvent) => {
      if (event.shiftKey) {
        // Allows for Shift + Enter to create a new line
      } else {
        // Prevents the default Enter key action and sends the message
        event.preventDefault();
        send();
      }
    };

    return { newMessage, send, handleEnter };
  }
});
</script>

<style scoped>
.message-input {
  display: flex;
  align-items: flex-start; /* Aligns items to the top */
  padding: 10px;
  background-color: var(--h-chat);
  border-radius: 8px;
}

.left-icons, .right-icons {
  display: flex;
  align-items: center;
}

.message-input textarea {
  flex-grow: 1;
  padding: 8px 10px;
  margin-left: 10px; /* Spacing between left icons and textarea */
  margin-right: 10px; /* Spacing between textarea and right icons */
  border-radius: 8px;
  border: none;
  background-color: var(--h-chat-light);
  color: white;
  font-size: 14px;
  resize: none;
  overflow: auto;
  outline: none;
  font-family: Arial, sans-serif;
  min-height: 38px; /* Initial height of textarea */
}

.message-input textarea::placeholder {
  color: #72767d;
}

.message-input textarea:focus {
  box-shadow: 0 0 0 2px #00aff4;
  outline: none;
}
</style>
