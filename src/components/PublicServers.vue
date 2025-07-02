<template>
  <div class="modal-overlay" @click="closePublicServers">
    <div class="modal-content" @click.stop>
      <h2>Public Servers</h2>
      <input 
        type="text" 
        v-model="searchQuery" 
        placeholder="Search servers..." 
        class="input-base"
      />
      
      <div class="server-list">
        <div v-for="server in publicServers" :key="server.id" class="server-item">
          <img :src="server.icon" alt="Server icon" class="avatar-md" />
          <div class="server-details">
            <h3>{{ server.name }}</h3>
            <p class="owner-details">
              <img :src="getUserAvatar(server.owner)" alt="Owner avatar" class="avatar-sm" />
              {{ getUserDisplayName(server.owner) }}
            </p>
          </div>
          <div class="server-actions">
            <button 
              v-if="alreadyJoined(server.id)" 
              @click="leaveServer(server.id)" 
              class="btn btn-danger"
            >
              Leave
            </button>
            <button 
              v-else 
              @click="joinServer(server.id)" 
              class="btn btn-primary"
            >
              Join
            </button>
          </div>
        </div>
        <button @click="showCreateServerForm = true" class="btn btn-success create-server-btn">
          Create a Server
        </button>
      </div>
    </div>
  </div>
  
  <CreateServerForm v-if="showCreateServerForm" />
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, watch } from 'vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useServerUsersStore } from '@/stores/useServerUsers'
import { useServerStore } from '@/stores/server'
import { useAuthStore } from '@/stores/auth'
import { useUserProfile } from '@/composables/useUserProfile'
import { useKeyboardEvents } from '@/composables/useCommonUI'
import CreateServerForm from './CreateServer.vue'
import type { Server } from '@/types'

export default defineComponent({
  name: 'PublicServers',
  components: {
    CreateServerForm,
  },
  setup(_, { emit }) {
    const serverChannelStore = useServerChannelStore()
    const serverUsersStore = useServerUsersStore()
    const serverStore = useServerStore()
    const authStore = useAuthStore()
    const { getUserAvatar, getUserDisplayName } = useUserProfile()
    const { handleEscapeKey } = useKeyboardEvents()

    const searchQuery = ref('')
    const publicServers = ref<Server[]>([])
    const currentUserId = ref<string | undefined>()
    const showCreateServerForm = ref(false)

    const alreadyJoined = (serverId: string) => {
      return serverChannelStore.servers.some((server) => server.id === serverId)
    }

    const joinServer = async (serverId: string) => {
      const userId = authStore.session?.user?.id
      if (!userId) return
      
      await serverStore.joinServer(serverId, userId)
      emit('show-public-servers', false)
    }
    
    const leaveServer = async (serverId: string) => {
      const userId = authStore.session?.user?.id
      if (!userId) return
      
      await serverStore.leaveServer(serverId, userId)
      emit('show-public-servers', false)
    }

    const closePublicServers = () => {
      emit('show-public-servers', false)
    }

    const fetchPublicServers = async () => {
      await serverChannelStore.fetchPublicServers(searchQuery.value)
      publicServers.value = serverChannelStore.publicServers
    }

    // Handle escape key to close
    handleEscapeKey(closePublicServers)

    watch(searchQuery, fetchPublicServers, { immediate: true })

    onMounted(async () => {
      currentUserId.value = authStore.session?.user?.id
      await fetchPublicServers()
      serverUsersStore.fetchUserProfiles(
        serverChannelStore.publicServers.map((server) => server.owner)
      )
    })

    return { 
      showCreateServerForm,
      searchQuery,
      publicServers,
      closePublicServers,
      getUserDisplayName,
      getUserAvatar,
      alreadyJoined,
      joinServer,
      leaveServer,
    }
  },
})
</script>

<style scoped>
.server-list {
  max-height: 400px;
  overflow-y: auto;
  margin-top: 16px;
}

.server-item {
  display: flex;
  align-items: center;
  padding: 12px;
  margin-bottom: 8px;
  border-radius: 8px;
  background-color: rgba(255, 255, 255, 0.05);
  transition: background-color 0.2s;
}

.server-item:hover {
  background-color: rgba(255, 255, 255, 0.1);
}

.server-details {
  flex-grow: 1;
  margin-left: 12px;
}

.server-details h3 {
  margin: 0 0 4px 0;
  color: #ffffff;
  font-size: 1.1em;
}

.owner-details {
  display: flex;
  align-items: center;
  margin: 0;
  font-size: 0.9rem;
  color: #b3b3b3;
}

.owner-details .avatar-sm {
  margin-right: 8px;
}

.server-actions {
  margin-left: 12px;
}

.create-server-btn {
  width: 100%;
  margin-top: 16px;
}
</style>
