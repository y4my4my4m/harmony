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
        <label for="owner">Owner:</label>
        <span id="owner">{{ ownerName }}</span>
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
  import { getProfileWithAvatarUrl } from '@/services/profileService';

  
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
      const ownerName = ref('');
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
          server.value.icon = URL.createObjectURL(selectedFile.value);
        }
      };

      // Fetch server details
      const fetchServer = async () => {
        const data = await serverStore.getServer(props.serverId);
        server.value = data as Server;
        // TODO: should probably just have a reference to the owner entirely
        const owner = await getProfileWithAvatarUrl(server.value.owner);
        ownerName.value = owner?.username ?? 'undefined';
      };
  
      // Update server
      const updateServer = async () => {
        const success = await serverStore.updateServer(server.value, selectedFile.value || undefined);
        if (success) {
          if (selectedFile.value) {
            // TODO: use env URL
            // server.value.icon = `${process.env.VUE_APP_SUPABASE_STORAGE_URL}/server_icons/${server.value.id}/${selectedFile.value.name}`;
            server.value.icon = `${server.value.id}/${selectedFile.value.name}`;
          }
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
      return { server, updateServer, handleFileChange, back, ownerName };
    }
  };
</script>
  
<style scoped>
.server-settings {
  background-color: #2f3136; /* Dark background */
  color: #fff;
  padding: 20px;
  border-radius: 8px;
  max-width: 500px;
  margin: auto;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5); /* Adding shadow for depth */
}

.server-settings h2 {
  color: #5865f2; /* Discord's primary blue color */
  margin-bottom: 20px;
  font-size: 1.5rem; /* Larger font size for heading */
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
  border: 1px solid #40444b; /* Subtle border */
  background-color: #40444b;
  color: white;
  font-size: 1rem; /* Bigger font size for readability */
}

.server-settings button {
  padding: 10px 15px;
  background-color: #5865f2; /* Discord's primary blue color */
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  transition: background-color 0.2s;
  font-weight: bold; /* Making text bold */
}

.server-settings button:hover {
  background-color: #4e5cd1; /* Slightly darker shade on hover */
}

.icon {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  object-fit: cover;
  margin-top: 10px; /* Adjusted margin */
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.5); /* Shadow for depth */
}

</style>
  