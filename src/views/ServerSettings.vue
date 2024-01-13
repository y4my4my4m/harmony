<template>
  <div class="server-settings">
    <h2>Server Settings</h2>
    <form @submit.prevent="updateServer">
      <div>
        <label for="name">Server Name:</label>
        <input type="text" id="name" v-model="server.name">
      </div>
      <div>
        <label for="description">Description:</label>
        <textarea id="description" v-model="server.description"></textarea>
      </div>
      <div>
        <label for="icon">Server Icon:</label>
        <input type="file" id="icon" @change="handleFileChange">
        <img :src="server.icon" class="icon" alt="Server Icon">
      </div>
      <button type="submit">Save Changes</button>
      <button @click="back()" style="background-color:gray">Cancel</button>
    </form>
  </div>
</template>
  
<script lang="ts">
  import { ref } from 'vue';
  import { useServerStore } from '@/stores/server';
  import type { Server } from '@/types';
  import { useRouter } from 'vue-router';
  import { useToast } from "vue-toastification";
  
  export default {
    props: {
      serverId: {
        type: String,
        required: true
      },
    },
    setup(props) {
      const router = useRouter();
      const serverStore = useServerStore();
      const toast = useToast();
      const selectedFile = ref<File | null>(null);
      const server = ref<Server>({
        id: '',
        name: '',
        description: '',
        icon: '',
        owner: '',
      });

      const handleFileChange = (event: Event) => {
        const input = event.target as HTMLInputElement;
        if (input.files?.[0]) {
          selectedFile.value = input.files[0];
          // Preview the image
          server.value.icon = URL.createObjectURL(selectedFile.value);
        }
      };
      // Fetch server details
      const fetchServer = async () => {
        const data = await serverStore.getServer(props.serverId);
        server.value = data as Server;
      };
  
      // Update server
      const updateServer = async () => {
        const success = await serverStore.updateServer(server.value);
        if (success) {
          console.log('Server updated successfully');
          toast.success('Server updated successfully');
          back();
        } else {
          console.error('Failed to update server');
          toast.error('Failed to update server');
          back();
        }
      };

      const back = () => {
        router.push('/chat');
      }
  
      fetchServer();
      return { server, updateServer, handleFileChange, back };
    }
  };
</script>
  
<style scoped>
  .server-settings {
    background-color: #36393f;
    color: #fff;
    padding: 20px;
    border-radius: 8px;
    max-width: 500px;
    margin: auto;
  }
  
  .server-settings h2 {
    color: #fff;
    margin-bottom: 20px;
  }
  
  .server-settings form {
    display: flex;
    flex-direction: column;
    gap: 15px;
  }
  
  .server-settings input[type="text"],
  .server-settings textarea {
    padding: 10px;
    border-radius: 5px;
    border: none;
    background-color: #40444b;
    color: white;
  }
  
  .server-settings button {
    padding: 10px 15px;
    background-color: #5865f2;
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    transition: background-color 0.2s;
  }
  
  .server-settings button:hover {
    background-color: #4e5cd1;
  }
  .icon {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    object-fit: cover;
    margin-left: 10px;
  }
</style>
  