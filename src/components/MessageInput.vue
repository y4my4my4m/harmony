<template>
  <div class="message-input">
    <div class="message-container">
      <div class="left-icons">
        <PlusIcon/>
      </div>
      <textarea v-model="newMessage" @keydown.enter="handleEnter" placeholder="Type a message..."></textarea>
      <div class="right-icons">
        <GifIcon @click="toggleGiphy" />
        <EmojiUI @click="toggleEmojiList" />
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, watch } from 'vue';
import GifIcon from '@/components/icons/Gif.vue'
import PlusIcon from '@/components/icons/Plus.vue'
import EmojiUI from '@/components/EmojiUI.vue'

export default defineComponent({
  components: {
    PlusIcon,
    GifIcon,
    EmojiUI,
  },
  props: {
    giphyOpen: Boolean,
    emojiListOpen: Boolean,
    modelValue: String,
  },
  emits: {
    sendMessage: null,
    toggleGiphy: null,
    toggleEmojiList: null,
    'update:newMessage': null,
  },
  setup(props, { emit }) {
    const newMessage = ref(props.modelValue);

    const send = () => {
      if (newMessage.value !== '')
      {
        // if (newMessage.value.trim()) {
        emit('sendMessage', newMessage.value);
        newMessage.value = '';
        // }
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

    const toggleGiphy = () => {
      emit('toggleGiphy');
    };
    const toggleEmojiList = () => {
      emit('toggleEmojiList');
    };


    watch(() => props.modelValue, (newValue) => {
      newMessage.value = newValue;
      emit('update:newMessage', newMessage.value);
    });

    return { newMessage, send, toggleGiphy, toggleEmojiList, handleEnter };
  }
});
</script>

<style scoped>
  .message-input {
    display: flex;
    padding: 10px 12px;
    background-color: var(--h-chat);
    border-radius: 8px;
  }

  .left-icons {
    padding-left:10px;
  }
  .left-icons, .right-icons {
    display: flex;
    align-items: center;
  }
  .right-icons {
    padding-right:10px;
  }

  .message-container {
    position:relative;
    display: flex;
    align-items: center; /* Aligns items to the top */
    flex-grow: 1;
    padding: 8px ;
    border-radius: 8px;
    border: none;
    background-color: var(--h-chat-light);
    transition: .2s;
  }
  textarea {
    flex-grow: 1;
    padding: 0;
    margin-left: 10px;
    margin-right: 10px;
    border: none;
    background-color: transparent;
    color: white;
    font-size: 18px;
    resize: none;
    overflow: auto;
    outline: none;
    position: relative;
    top: 10px;
    font-family: Arial, sans-serif;
  }

  textarea::placeholder {
    color: #72767d;
  }

  textarea:focus,
  textarea:active {
    /* box-shadow: 0 0 0 2px #00aff4; */
    outline: none;
  }
  /* party mode RGB */
  /* .message-container::before,
  .message-container::after{
    content: '';
    position: absolute;
    top: -2px;
    right: -2px;
    bottom: -2px;
    left: -2px;
    z-index: -1;
    box-shadow: 0 0 5px rgba(0, 0, 0, 0.1);
    transition: .5s;
    opacity: 0;
  }

  @keyframes rgbled {
    0% { box-shadow: inset 0 0 5px rgba(0,0,0,0.5), 0 0 1px hsla(0, 100%, 50%, 100%), 0 0 50px hsla(0, 100%, 50%, 5%); }
    25% { box-shadow: inset 0 0 5px rgba(0,0,0,0.5), 0 0 1px hsla(90, 100%, 50%, 100%), 0 0 50px hsla(90, 100%, 50%, 5%); }
    50% { box-shadow: inset 0 0 5px rgba(0,0,0,0.5), 0 0 1px hsla(180, 100%, 50%, 100%), 0 0 50px hsla(180, 100%, 50%, 5%); }
    75% { box-shadow: inset 0 0 5px rgba(0,0,0,0.5), 0 0 1px hsla(270, 100%, 50%, 100%), 0 0 50px hsla(270, 100%, 50%, 5%); }
    100% { box-shadow: inset 0 0 5px rgba(0,0,0,0.5), 0 0 1px hsla(360, 100%, 50%, 100%), 0 0 50px hsla(360, 100%, 50%, 5%); }
  }

  .message-container:has(textarea:focus)::before{
    content: '';
    position: absolute;
    top: -2px;
    right: -2px;
    bottom: -2px;
    left: -2px;
    z-index: 2;
    box-shadow: 0 0 5px rgba(0, 0, 0, 0.1);
    animation: rgbled 15s linear infinite;
    border-radius: 8px;
    opacity: 1;
  }

  .message-container:has(textarea:focus)::after {
    top: -4px;
    right: -4px;
    bottom: -4px;
    left: -4px;
    animation-delay: 2.5s;
  } */

  .message-container:has(textarea:focus) {
    /* box-shadow: 0 0 0 2px #00aff4; */
    box-shadow: inset 0 0 5px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,.15)
  }




  @media (max-width: 768px) {
    .message-input {
      position:sticky;
      bottom:0;
    }
    textarea {
      font-size:14px;
    }
  }
</style>
