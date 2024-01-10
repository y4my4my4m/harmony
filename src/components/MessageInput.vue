<template>
  <div class="message-input">
    <input type="text" v-model="newMessage" @keyup.enter="send" placeholder="Type a message...">
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, } from 'vue';

export default defineComponent({
  name: 'MessageInput',
  emits: ['sendMessage'],
  setup(props, { emit }) {
    const newMessage = ref('');

    const send = () => {
      if (newMessage.value.trim()) {
        // const hasSendMessagePermission = (user: User) => {
        //   return user.roles.some(role => role.permissions.includes(Permission.SEND_MESSAGE));
        // };

        emit('sendMessage', newMessage.value);
        newMessage.value = '';
      }
    };

    return { newMessage, send };
  }
});
</script>
  
<style scoped>
.message-input {
  padding: 10px;
  background-color: #40444b; /* input area background */
}

.message-input input[type="text"] {
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: none;
  background-color: #202225; /* input field background */
  color: white;
  font-size: 15px;
}

.message-input input[type="text"]::placeholder {
  color: #72767d; /* Placeholder text color */
}

.message-input input[type="text"]:focus {
  outline: none;
  box-shadow: 0 0 0 2px #00aff4; /* Focus outline color */
}
</style>
