<template>
    <div class="create-channel-container" v-if="show">
      <div class="create-channel-form">
        <h2>Create a New Channel</h2>
        <form @submit.prevent="createChannel">
          <input type="text" v-model="newChannelName" placeholder="Channel Name" required />
          <button type="submit">Create Channel</button>
          <button @click="closeForm">Cancel</button>
        </form>
      </div>
    </div>
</template>
 
<script lang="ts">
  import { ref } from 'vue';
  import { supabase } from '@/supabase'; // Adjust the import path as needed
  
  export default {
    props: {
      serverId: {
        type: String,
        required: true
      },
      show: {
        type: Boolean,
        required: true
      }
    },
    emits: ['close', 'channelCreated'],
    setup(props, { emit }) {
      const newChannelName = ref('');
  
      // FIXME: put me in a store
      const createChannel = async () => {
        if (!newChannelName.value) return;
  
        try {
          const { data, error } = await supabase
            .from('channels')
            .insert([{ name: newChannelName.value, server_id: props.serverId, type: 0 }]);
  
          if (error) throw error;
          emit('channelCreated', data);
          closeForm();
        } catch (error) {
          console.error('Error creating channel:', error);
        }
      };
  
      const closeForm = () => {
        emit('close');
      };
  
      return { newChannelName, createChannel, closeForm };
    },
};
</script>

<style scoped>
.create-channel-container {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
}

.create-channel-form {
  background-color: var(--vt-c-black);
  padding: 40px 45px;
  border-radius: 10px;
  box-shadow: 0 3px 6px rgba(0,0,0,0.16), 0 3px 6px rgba(0,0,0,0.23);
}

.create-channel-form h2 {
  margin-bottom: 15px;
}

.create-channel-form form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.create-channel-form input {
  padding: 10px;
  border: 1px solid #3b3b3b;
  border-radius: 5px;
}

.create-channel-form button {
  padding: 10px;
  border-radius: 5px;
  border: none;
  cursor: pointer;
  transition: background-color 0.3s;
}

.create-channel-form button[type="submit"] {
  background-color: var(--h-primary);
  color: white;
}

.create-channel-form button[type="submit"]:hover {
  background-color: var(--h-primary-light);
}

.create-channel-form button:last-child {
  background-color: var(--vt-c-divider-dark-1);
  color: white;
}

.create-channel-form button:last-child:hover {
  background-color:  var(--vt-c-divider-dark-2);
}
</style>
  