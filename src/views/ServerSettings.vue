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
      <hr>
      <h3>Emojis</h3>
      <div>
        <label for="allow_cross_server_emojis">Allow Cross Server Emojis:</label>
        <input type="checkbox" id="allow_cross_server_emojis" v-model="server.allow_cross_server_emojis">
      </div>
      <label for="emoji-upload">Upload Emoji:</label>
      <input type="file" id="emoji-upload" @change="handleEmojiChange">
      <div class="emoji-list">
        <div v-for="emoji in emojis" :key="emoji.id" class="emoji-item">
          <img :src="emoji.url" :alt="emoji.name" class="emoji-icon">
          <span>:{{ emoji.name }}:</span>
          <!-- <span>{{ emoji.uploader }}</span> -->
        </div>
      </div>

      <button type="submit">Save Changes</button>
      <button @click="back()" style="background-color:gray">Cancel</button>
    </form>
  </div>
</template>
  
<script lang="ts">
  import { onMounted, ref } from 'vue';
  import { useServerStore } from '@/stores/server';
  import type { Server, Emoji } from '@/types';
  import { useRouter } from 'vue-router';
  import { useToast } from "vue-toastification";
  import { getProfileWithAvatarUrl } from '@/services/profileService';
  import { uploadEmoji } from '@/services/emojiService';
  
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
      const emojis = ref<Emoji[]>([]);
      const server = ref<Server>({
        id: '',
        name: '',
        description: '',
        icon: '',
        owner: '',
        allow_cross_server_emojis: true,
      });

      const handleEmojiChange = async (event: Event) => {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        if (file) {
          const newEmoji = await uploadEmoji(props.serverId, server.value.owner, file);
          if (newEmoji) {
            emojis.value.push(newEmoji);
            toast.success('Emoji uploaded successfully');
          } else {
            toast.error('Failed to upload emoji');
          }
        }
      };

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
  
      onMounted(async () => {
        // Fetch existing emojis
        emojis.value = await serverStore.fetchEmojis(props.serverId);
      });
      
      fetchServer();
      return { server, updateServer, handleFileChange, back, ownerName, handleEmojiChange, emojis };
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
.emoji-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 10px;
}
.emoji-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.emoji-item {
  display: flex;
  align-items: center;
}

.emoji-icon {
  width: 32px;
  height: 32px;
  margin-right: 5px;
}

</style>