<template>
  <div class="public-servers-overlay" @click.self="closePublicServers">
    <div class="public-servers-modal">
      <!-- Header -->
      <div class="modal-header">
        <div class="header-content">
          <div class="icon-container">
            <svg viewBox="0 0 24 24" class="discover-icon">
              <path d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z" fill="currentColor"/>
            </svg>
          </div>
          <div class="header-text">
            <h2 class="modal-title">Discover Communities</h2>
            <p class="modal-subtitle">Find your next favorite server</p>
          </div>
        </div>
        <button @click="closePublicServers" class="close-button">
          <svg viewBox="0 0 24 24" class="close-icon">
            <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
          </svg>
        </button>
      </div>

      <!-- Search Section -->
      <div class="search-section">
        <div class="search-container">
          <svg viewBox="0 0 24 24" class="search-icon">
            <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z" fill="currentColor"/>
          </svg>
          <input 
            type="text" 
            v-model="searchQuery" 
            placeholder="Search communities..." 
            class="search-input"
          />
          <div class="search-accent"></div>
        </div>
        <div class="search-stats">
          <span class="stats-text">{{ publicServers.length }} communities found</span>
        </div>
      </div>

      <!-- Server List -->
      <div class="servers-content">
        <div v-if="publicServers.length === 0" class="empty-state">
          <div class="empty-icon">
            <svg viewBox="0 0 24 24" class="empty-svg">
              <path d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z" fill="currentColor"/>
            </svg>
          </div>
          <h3 class="empty-title">No servers found</h3>
          <p class="empty-description">Try adjusting your search or create your own community</p>
        </div>

        <div v-else class="server-grid">
          <div v-for="server in publicServers" :key="server.id" class="server-card">
            <div class="card-header">
              <div class="server-icon">
                <img :src="server.icon" alt="Server icon" />
              </div>
              <div class="server-status">
                <div class="status-dot online"></div>
                <span class="status-text">Active</span>
              </div>
            </div>
            
            <div class="card-content">
              <h3 class="server-name">{{ server.name }}</h3>
              <p class="server-description">{{ server.description || 'No description available' }}</p>
              
              <div class="server-info">
                <div class="owner-info">
                  <img :src="getUserAvatar(server.owner)" alt="Owner avatar" class="owner-avatar" />
                  <span class="owner-name">{{ getUserDisplayName(server.owner) }}</span>
                </div>
                <div class="server-tags">
                  <span class="tag">Public</span>
                  <span class="tag">Active</span>
                </div>
              </div>
            </div>

            <div class="card-actions">
              <button 
                v-if="alreadyJoined(server.id)" 
                @click="leaveServer(server.id)" 
                class="action-btn danger"
              >
                <svg viewBox="0 0 24 24" class="btn-icon">
                  <path d="M19,3H16.3H7.7H5A2,2 0 0,0 3,5V7.7V16.3V19A2,2 0 0,0 5,21H7.7H16.3H19A2,2 0 0,0 21,19V16.3V7.7V5A2,2 0 0,0 19,3M15.6,17L12,13.4L8.4,17L7,15.6L10.6,12L7,8.4L8.4,7L12,10.6L15.6,7L17,8.4L13.4,12L17,15.6L15.6,17Z" fill="currentColor"/>
                </svg>
                Leave
              </button>
              <button 
                v-else 
                @click="joinServer(server.id)" 
                class="action-btn primary"
              >
                <svg viewBox="0 0 24 24" class="btn-icon">
                  <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" fill="currentColor"/>
                </svg>
                Join
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer Actions -->
      <div class="modal-footer">
        <div class="footer-info">
          <svg viewBox="0 0 24 24" class="info-icon">
            <path d="M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,17H13V11H11V17Z" fill="currentColor"/>
          </svg>
          <span>Can't find what you're looking for?</span>
        </div>
        <button @click="showCreateServerForm = true" class="create-server-btn">
          <svg viewBox="0 0 24 24" class="btn-icon">
            <path d="M12 2C13.1 2 14 2.9 14 4C14 5.1 13.1 6 12 6C10.9 6 10 5.1 10 4C10 2.9 10.9 2 12 2ZM21 9V7L15 1H5C3.89 1 3 1.89 3 3V19A2 2 0 0 0 5 21H11V19H5V3H13V9H21ZM17 13V11H15V13H13V15H15V17H17V15H19V13H17Z" fill="currentColor"/>
          </svg>
          Create Your Own Server
        </button>
      </div>
    </div>

    <!-- Create Server Modal -->
    <CreateServerForm v-if="showCreateServerForm" @close="showCreateServerForm = false" />
  </div>
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
import { useToast } from 'vue-toastification'

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
    const toast = useToast()

    const searchQuery = ref('')
    const publicServers = ref<Server[]>([])
    const currentUserId = ref<string | undefined>()
    const showCreateServerForm = ref(false)
    const isLoading = ref(false)

    const alreadyJoined = (serverId: string) => {
      return serverChannelStore.servers.some((server) => server.id === serverId)
    }

    const joinServer = async (serverId: string) => {
      const userId = authStore.session?.user?.id
      if (!userId) return
      
      try {
        const success = await serverStore.joinServer(serverId, userId)
        if (success) {
          toast.success('Successfully joined the server!')
          emit('show-public-servers', false)
        } else {
          toast.error('Failed to join the server')
        }
      } catch (error) {
        console.error('Error joining server:', error)
        toast.error('An error occurred while joining the server')
      }
    }
    
    const leaveServer = async (serverId: string) => {
      const userId = authStore.session?.user?.id
      if (!userId) return
      
      try {
        const success = await serverStore.leaveServer(serverId, userId)
        if (success) {
          toast.success('Successfully left the server')
          emit('show-public-servers', false)
        } else {
          toast.error('Failed to leave the server')
        }
      } catch (error) {
        console.error('Error leaving server:', error)
        toast.error('An error occurred while leaving the server')
      }
    }

    const closePublicServers = () => {
      emit('show-public-servers', false)
    }

    const fetchPublicServers = async () => {
      isLoading.value = true
      try {
        await serverChannelStore.fetchPublicServers(searchQuery.value)
        publicServers.value = serverChannelStore.publicServers
      } catch (error) {
        console.error('Error fetching public servers:', error)
        toast.error('Failed to load servers')
      } finally {
        isLoading.value = false
      }
    }

    // Handle escape key to close
    handleEscapeKey(closePublicServers)

    watch(searchQuery, fetchPublicServers, { immediate: true })

    onMounted(async () => {
      currentUserId.value = authStore.session?.user?.id
      await fetchPublicServers()
      if (serverChannelStore.publicServers.length > 0) {
        serverUsersStore.fetchUserProfiles(
          serverChannelStore.publicServers.map((server) => server.owner)
        )
      }
    })

    return { 
      showCreateServerForm,
      searchQuery,
      publicServers,
      isLoading,
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
.public-servers-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 1000;
  animation: fadeIn 0.3s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.public-servers-modal {
  background: rgba(47, 49, 54, 0.98);
  backdrop-filter: blur(20px);
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 
    0 32px 64px rgba(0, 0, 0, 0.5),
    0 0 0 1px rgba(255, 255, 255, 0.05),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  width: 100%;
  max-width: 900px;
  max-height: 90vh;
  overflow: hidden;
  animation: slideUp 0.3s ease-out;
  position: relative;
  display: flex;
  flex-direction: column;
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(20px) scale(0.95); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.public-servers-modal::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(88, 101, 242, 0.5), transparent);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px 32px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
}

.header-content {
  display: flex;
  align-items: center;
  gap: 16px;
}

.icon-container {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, #5865f2, #7289da);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.discover-icon {
  width: 24px;
  height: 24px;
  color: #ffffff;
}

.header-text {
  flex: 1;
}

.modal-title {
  font-size: 24px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 4px;
}

.modal-subtitle {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
}

.close-button {
  width: 32px;
  height: 32px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.3s ease;
}

.close-button:hover {
  background: rgba(255, 255, 255, 0.1);
  border-color: rgba(255, 255, 255, 0.2);
}

.close-icon {
  width: 16px;
  height: 16px;
  color: #b9bbbe;
}

.search-section {
  padding: 24px 32px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
}

.search-container {
  position: relative;
  margin-bottom: 12px;
}

.search-icon {
  position: absolute;
  left: 16px;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
  height: 20px;
  color: #72767d;
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 16px 16px 16px 48px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  color: #ffffff;
  font-size: 16px;
  transition: all 0.3s ease;
  box-sizing: border-box;
}

.search-input:focus {
  outline: none;
  border-color: #5865f2;
  background: rgba(255, 255, 255, 0.08);
  box-shadow: 0 0 0 3px rgba(88, 101, 242, 0.1);
}

.search-input::placeholder {
  color: #72767d;
}

.search-accent {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 2px;
  background: linear-gradient(90deg, #5865f2, #7289da);
  border-radius: 1px;
  width: 0;
  transition: width 0.3s ease;
}

.search-input:focus + .search-accent {
  width: 100%;
}

.search-stats {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.stats-text {
  font-size: 12px;
  color: #72767d;
}

.servers-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
}

.empty-icon {
  width: 64px;
  height: 64px;
  background: rgba(88, 101, 242, 0.1);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.empty-svg {
  width: 32px;
  height: 32px;
  color: #5865f2;
}

.empty-title {
  font-size: 18px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px;
}

.empty-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
}

.server-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 20px;
}

.server-card {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  padding: 20px;
  transition: all 0.3s ease;
  position: relative;
  overflow: hidden;
}

.server-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.1), transparent);
  opacity: 0;
  transition: opacity 0.3s ease;
}

.server-card:hover {
  transform: translateY(-2px);
  border-color: rgba(88, 101, 242, 0.3);
  box-shadow: 0 8px 25px rgba(0, 0, 0, 0.2);
}

.server-card:hover::before {
  opacity: 1;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.server-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  overflow: hidden;
  background: #36393f;
}

.server-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.server-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: rgba(87, 242, 135, 0.1);
  border: 1px solid rgba(87, 242, 135, 0.3);
  border-radius: 12px;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #57f287;
}

.status-text {
  font-size: 10px;
  color: #57f287;
  font-weight: 500;
}

.card-content {
  margin-bottom: 16px;
}

.server-name {
  font-size: 18px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px;
  line-height: 1.2;
}

.server-description {
  font-size: 13px;
  color: #b9bbbe;
  line-height: 1.4;
  margin: 0 0 16px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.server-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.owner-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.owner-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  flex-shrink: 0;
}

.owner-name {
  font-size: 12px;
  color: #b9bbbe;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.server-tags {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.tag {
  font-size: 9px;
  padding: 2px 6px;
  background: rgba(88, 101, 242, 0.2);
  color: #5865f2;
  border-radius: 4px;
  font-weight: 500;
}

.card-actions {
  display: flex;
  gap: 8px;
}

.action-btn {
  flex: 1;
  padding: 10px 16px;
  border: none;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.action-btn.primary {
  background: linear-gradient(135deg, #5865f2, #7289da);
  color: #ffffff;
  box-shadow: 0 2px 8px rgba(88, 101, 242, 0.3);
}

.action-btn.primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(88, 101, 242, 0.4);
}

.action-btn.danger {
  background: rgba(237, 66, 69, 0.1);
  color: #ed4245;
  border: 1px solid rgba(237, 66, 69, 0.3);
}

.action-btn.danger:hover {
  background: rgba(237, 66, 69, 0.2);
  border-color: rgba(237, 66, 69, 0.5);
}

.btn-icon {
  width: 14px;
  height: 14px;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 32px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
}

.footer-info {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #b9bbbe;
  font-size: 14px;
}

.info-icon {
  width: 16px;
  height: 16px;
  color: #5865f2;
}

.create-server-btn {
  padding: 12px 20px;
  background: linear-gradient(135deg, #57f287, #00d166);
  color: #ffffff;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  gap: 8px;
  box-shadow: 0 4px 15px rgba(87, 242, 135, 0.3);
}

.create-server-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(87, 242, 135, 0.4);
}

@media (max-width: 768px) {
  .public-servers-modal {
    margin: 16px;
    max-width: none;
  }
  
  .modal-header,
  .search-section,
  .servers-content,
  .modal-footer {
    padding: 16px 20px;
  }
  
  .server-grid {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  
  .modal-footer {
    flex-direction: column;
    gap: 16px;
    align-items: stretch;
  }
  
  .create-server-btn {
    width: 100%;
    justify-content: center;
  }
}

@media (max-width: 480px) {
  .server-card {
    padding: 16px;
  }
  
  .card-actions {
    flex-direction: column;
  }
  
  .server-info {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
}
</style>
