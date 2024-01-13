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
        <button type="submit">Save Changes</button>
      </form>
    </div>
  </template>
  
<script lang="ts">
  import { ref } from 'vue';
  import { useServerStore } from '@/stores/server';
  import type { Server } from '@/types';
  
  export default {
    props: {
      serverId: {
        type: String,
        required: true
      }
    },
    setup(props) {
      const serverStore = useServerStore();
      const server = ref({ name: '', description: '' });
  
      // Fetch server details
      const fetchServer = async () => {
        const data = await serverStore.getServer(props.serverId);
        server.value = data as Server;
      };
  
      // Update server
      const updateServer = async () => {
        await serverStore.updateServer(props.serverId, server.value);
        // Handle success or error
      };
  
      fetchServer();
      return { server, updateServer };
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
</style>
  