<template>
    <div class="public-servers-overlay"  @click="closePublicServers">
      <div class="public-servers"  @click.stop>
        <input 
          type="text" 
          placeholder="Search public servers" 
          v-model="searchQuery"
          class="search-box"
        />
        <div class="server-list">
          <div v-for="server in publicServers" :key="server.id" class="server-item">
            <img :src="server.icon" alt="Server Icon" class="server-icon">
            <div class="server-details">
              <h3>{{ server.name }}</h3>
              <div class="owner-details">
                <!-- <span class="label">Owner:</span> -->
                <img class="owner-avatar" :src="getUserAvatar(server.owner)">
                <strong>{{ getUserDisplayName(server.owner) }}</strong>
              </div>
            </div>
            <template v-if="alreadyJoined(server.id)">
              <div class="join" @click="leaveServer(server.id)" style="background-color: #dd281b">{{ alreadyJoined(server.id) }}</div>
            </template>
            <div v-else class="join" @click="joinServer(server.id)">Join</div>
          </div>
        </div>
      </div>
    </div>
  </template>
  
  <script lang="ts">
  import { defineComponent, ref, onMounted, onUnmounted, watch } from 'vue';
  import { useServerChannelStore } from '@/stores/useServerChannel';
  import { useServerUsersStore } from '@/stores/useServerUsers';
  import { useServerStore } from '@/stores/server';
  import { useAuthStore } from '@/stores/auth';

  export default defineComponent({
    setup(_, { emit }) {
      const serverChannelStore = useServerChannelStore();
      const serverUsersStore = useServerUsersStore();
      const serverStore = useServerStore();
      const authStore = useAuthStore();
      const searchQuery = ref('');
      const publicServers = ref([]);
      // const currentUserId = computed(() => authStore.session?.user?.id);
      const currentUserId = ref();

      const alreadyJoined = (serverId:string) => {
        const joined = serverChannelStore.servers.some((server) => server.id === serverId);
        if (joined) {
          return 'Leave';
        }
        else {
          return '';
        }
      };

      const joinServer = async (serverId:string) => {
        console.log(serverId, authStore.session?.user?.id);
        await serverStore.joinServer(serverId, authStore.session?.user?.id);
        emit('show-public-servers', false);
      };
      
      const leaveServer = async (serverId:string) => {
        console.log(serverId, authStore.session?.user?.id);
        await serverStore.leaveServer(serverId, authStore.session?.user?.id);
        emit('show-public-servers', false);
      };

      const fetchPublicServers = async () => {
        await serverChannelStore.fetchPublicServers(searchQuery.value);
        publicServers.value = serverChannelStore.publicServers;
      };

      const getUserAvatar = (userId:string) => {
        return serverUsersStore.userProfiles[userId]?.avatar_url;
      };
      const getUserDisplayName = (userId:string) => {
        return serverUsersStore.userProfiles[userId]?.display_name || 'Unknown User';
      };

      const closePublicServers = () => {
        emit('show-public-servers', false); 
      };

      const onKeydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          closePublicServers();
        }
      };

      watch(searchQuery, fetchPublicServers, { immediate: true });

      onMounted(async () => {
        currentUserId.value = authStore.session?.user?.id;
        await fetchPublicServers();
        // FIXME: this is silly, dont do that!
        serverUsersStore.fetchUserProfiles(serverChannelStore.publicServers.map((server) => server.owner));
        window.addEventListener('keydown', onKeydown);
      });

      onUnmounted(() => {
        window.removeEventListener('keydown', onKeydown);
      });

      return { 
        searchQuery,
        publicServers,
        closePublicServers,
        getUserDisplayName,
        getUserAvatar,
        alreadyJoined,
        joinServer,
        leaveServer,
      };
    },
  });
  </script>
  
  <style scoped>
  .public-servers-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index:10;
    display: flex;
    justify-content: center;
    align-items: center;
    background-color: rgba(0, 0, 0, 0.6);
  }
  
  .public-servers {
    background-color: #ffffff;
    width: 80%;
    max-width: 600px;
    padding: 20px;
    border-radius: 10px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  }
  
  .search-box {
    width: 100%;
    padding: 10px;
    margin-bottom: 20px;
    border-radius: 5px;
    border: 1px solid #ccc;
  }
  
  .server-list {
    max-height: 400px;
    overflow-y: auto;
  }
  
  .server-item {
    display: flex;
    align-items: center;
    position: relative;
    z-index: 10;
    padding: 4px 6px;
    margin-bottom: 6px;
    border-bottom: 1px solid #CCC;
  }
  
  .server-icon {
    width: 50px;
    height: 50px;
    border-radius: 50%;
    object-fit: cover;
    margin-right: 10px;
    box-shadow: -1px 2px 3px rgba(0, 0, 0, 0.23);
  }
  
  .server-details h3 {
    margin: 0;
    color: #333;
  }
  
  .server-details .owner-details {
    margin: 0;
    font-size: 0.9rem;
    color: #666;
    display: flex;
  }
  .server-details {
    display: flex;
    flex-direction: column;
    flex-grow: 1;
  }
  .server-details .owner-avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    object-fit: cover;
    margin-right: 5px;
  }
  .join {
    padding: 10px 15px;
    border: none;
    border-radius: 5px;
    color: white;
    cursor: pointer;
    background-color: #5865f2; 
    transition: background-color 0.2s;
  }
  .join:hover {
    opacity: 0.8;
  }

  </style>
  