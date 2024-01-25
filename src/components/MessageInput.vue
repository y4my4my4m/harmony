<template>
  <div class="message-input" :class="{'replying': replyMessageId}">
    <MessageReply
      v-if="replyMessageId"
      :replyMessageId="replyMessageId"
      :replyUserDisplayName="replyUserDisplayName"
      @update:replyMessageId="handleDontReply"
    />
    <div class="message-container">
      <div class="left-icons">
        <PlusIcon/>
      </div>
      <textarea v-model="localMessageContent" @keydown.enter="handleEnter" placeholder="Type a message..."></textarea>
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
import MessageReply from '@/components/MessageReply.vue';

export default defineComponent({
  components: {
    PlusIcon,
    GifIcon,
    EmojiUI,
    MessageReply,
  },
  props: {
    giphyOpen: Boolean,
    emojiListOpen: Boolean,
    modelValue: String,
    messageContent: {
      type: String,
      default: ''
    },
    replyMessageId: {
      type: String,
      default: ''
    },
    replyUserDisplayName: {
      type: String,
      default: ''
    },
  },
  setup(props, { emit }) {
    const localMessageContent = ref(props.messageContent);

    const send = () => {
      if (localMessageContent.value?.trim()) {
        const content = localMessageContent.value.trim();
        emit('sendMessage', content);
        localMessageContent.value = '';
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
      // set false if not a reaction but an emoji for the input
      emit('toggleEmojiList', false);
    };

    // Watch for changes to the prop and update the local copy accordingly
    watch(() => props.messageContent, (newValue) => {
      localMessageContent.value = newValue;
    });

    // Emit an event when the local copy changes
    watch(localMessageContent, (newValue) => {
      emit('update:messageContent', newValue);
    });

    const handleDontReply = (newReplyMessageId: string) => {
      // replyMessageId.value = newReplyMessageId;
      emit('update:replyMessageId', newReplyMessageId);
      // Additional logic if needed
    };

    return { 
      localMessageContent, 
      send, 
      toggleGiphy, 
      toggleEmojiList, 
      handleEnter,
      handleDontReply,
    };
  }
});
</script>

<style scoped>
  /* this design has a small difference with the inspiration app
     the replying bar should be "a bit" over the .message-input's gray container but our padding isnt organized for that
     whatever...  */
  .message-input {
    display: flex;
    padding: 10px 12px;
    background-color: var(--h-chat);
    border-radius: 8px;
    flex-direction: column;
  }
  .message-input.replying {
    padding: 0 12px 10px 12px;
  }
  .message-input.replying .message-container {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
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
    font-size: 16px;
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
      top:7px;
    }
  }
</style>
