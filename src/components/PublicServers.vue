<template>
  <div class="public-servers-overlay" @click.self="closeModal">
    <div class="public-servers-modal">
      <!-- Header -->
      <PublicServersHeader @close="closeModal" />

      <!-- Search Section -->
      <PublicServersSearch 
        v-model:search-query="searchQuery"
        v-model:selected-category="selectedCategory"
        :is-searching="publicServersStore.isSearching"
        :categories="publicServersStore.categories"
        :total-servers="publicServersStore.totalServers"
        :filtered-count="publicServersStore.filteredServers.length"
        @join-by-url="showJoinFederatedServer = true"
      />

      <!-- Content -->
      <PublicServersContent 
        :servers="publicServersStore.filteredServers"
        :featured-servers="publicServersStore.featuredServers"
        :is-loading="publicServersStore.isLoading"
        :is-empty="publicServersStore.isEmpty"
        :is-empty-search="publicServersStore.isEmptySearch"
        :search-query="searchQuery"
        :joined-server-ids="joinedServerIds"
        :loading-server-ids="loadingServerIds"
        :error="publicServersStore.error"
        @join-server="handleJoinServer"
        @leave-server="handleLeaveServer"
        @view-owner-profile="handleViewOwnerProfile"
        @refresh="handleRefresh"
      />

      <!-- Footer -->
      <PublicServersFooter 
        @create-server="showCreateServerForm = true" 
        @join-by-url="showJoinFederatedServer = true"
      />
    </div>

    <!-- Create Server Modal -->
    <CreateServerForm 
      v-if="showCreateServerForm" 
      @close="showCreateServerForm = false" 
      @created="handleServerCreated"
    />

    <!-- Join Federated Server Modal -->
    <JoinFederatedServer
      v-if="showJoinFederatedServer"
      @close="showJoinFederatedServer = false"
      @joined="handleFederatedServerJoined"
    />

    <!-- User Profile Modal -->
    <UserProfileModal
      v-if="showUserProfile && selectedUser"
      :show="showUserProfile"
      :user="selectedUser"
      @close="closeUserProfile"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { debug } from '@/utils/debug'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useServerStore } from '@/stores/server'
import { useAuthStore } from '@/stores/auth'
import { usePublicServersStore } from '@/stores/usePublicServers'
import { useServerUsersStore } from '@/stores/useServerUsers'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { useChatStore } from '@/stores/useChat'
import { useDebouncedSearch } from '@/composables/useDebounce'
import { useKeyboardEvents } from '@/composables/useCommonUI'
import { useHapticSettings } from '@/composables/useHapticSettings'

// Components
import PublicServersHeader from '@/components/PublicServers/PublicServersHeader.vue'
import PublicServersSearch from '@/components/PublicServers/PublicServersSearch.vue'
import PublicServersContent from '@/components/PublicServers/PublicServersContent.vue'
import PublicServersFooter from '@/components/PublicServers/PublicServersFooter.vue'
import CreateServerForm from '@/components/CreateServer.vue'
import JoinFederatedServer from '@/components/JoinFederatedServer.vue'
import UserProfileModal from '@/components/UserProfileModal.vue'

interface Emits {
  (e: 'close'): void
}

interface Props {
  /** Force refresh data when modal opens */
  forceRefresh?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  forceRefresh: false
})
const emit = defineEmits<Emits>()

const publicServersStore = usePublicServersStore()
const serverChannelStore = useServerChannelStore()
const serverStore = useServerStore()
const authStore = useAuthStore()
const { triggerDestructive, triggerMessage } = useHapticSettings()

const router = useRouter()
const toast = useToast()
const { handleEscapeKey } = useKeyboardEvents()

const searchQuery = ref('')
const selectedCategory = ref<string | null>(null)
const showCreateServerForm = ref(false)
const showJoinFederatedServer = ref(false)
const loadingServerIds = ref<Set<string>>(new Set())
const showUserProfile = ref(false)
const selectedUser = ref<any>(null)

const joinedServerIds = computed(() => {
  return new Set(serverChannelStore.servers.map((server: any) => server.id))
})

// Setup debounced search
useDebouncedSearch(searchQuery, async (query) => {
  if (query.trim()) {
    await publicServersStore.searchServers(query)
  } else {
    publicServersStore.clearSearch()
  }
}, 300)

// Watch category selection
watch(selectedCategory, (newCategory) => {
  publicServersStore.setSelectedCategory(newCategory)
})

const closeModal = () => {
  emit('close')
}

const handleRefresh = async () => {
  await publicServersStore.forceRefresh()
  toast.success('Communities refreshed!')
}

const handleJoinServer = async (serverId: string) => {
  const userId = authStore.session?.user?.id
  if (!userId) {
    toast.error('You must be logged in to join servers')
    return
  }

  loadingServerIds.value.add(serverId)

  try {
    const success = await serverStore.joinServer(serverId, userId)
    if (success) {
      // Haptic feedback for successful join
      triggerMessage('success')
      await serverChannelStore.fetchServersForUser(userId)
      toast.success('Successfully joined the server!')
      
      closeModal()
    } else {
      toast.error('Failed to join the server')
    }
  } catch (error) {
    debug.error('Error joining server:', error)
    toast.error('An error occurred while joining the server')
  } finally {
    loadingServerIds.value.delete(serverId)
  }
}

const handleLeaveServer = async (serverId: string) => {
  const userId = authStore.session?.user?.id
  if (!userId) return

  loadingServerIds.value.add(serverId)

  try {
    // Proactively disconnect voice chat if connected to this server
    const voiceStore = useUnifiedVoiceChannelStore()
    if (voiceStore.effectiveServerId === serverId) {
      await voiceStore.leaveVoiceChannel()
    }
    
    if (serverChannelStore.currentServer?.id === serverId) {
      const chatStore = useChatStore()
      chatStore.unsubscribeFromMessages()
      chatStore.clearMessages()
    }
    
    const success = await serverStore.leaveServer(serverId, userId)
    if (success) {
      triggerDestructive()
      await serverChannelStore.fetchServersForUser(userId)
      toast.success('Successfully left the server')
      
      if (serverChannelStore.currentServer?.id === serverId || serverChannelStore.servers.length === 0) {
        router.push('/chat')
      }
    } else {
      toast.error('Failed to leave the server')
    }
  } catch (error) {
    debug.error('Error leaving server:', error)
    toast.error('An error occurred while leaving the server')
  } finally {
    loadingServerIds.value.delete(serverId)
  }
}

const handleServerCreated = (server: any) => {
  showCreateServerForm.value = false
  toast.success('Server created successfully!')
  router.push({ name: 'Chat', params: { serverId: server.id } })
  closeModal()
}

const handleFederatedServerJoined = (_serverId: string) => {
  showJoinFederatedServer.value = false
  toast.success('Joined federated server!')
  // Navigation is handled by JoinFederatedServer component with the correct channel
  closeModal()
}

const handleViewOwnerProfile = async (userId: string) => {
  try {
    const serverUsersStore = useServerUsersStore()
    await serverUsersStore.fetchUserProfiles([userId])
    
    selectedUser.value = serverUsersStore.userProfiles[userId]
    if (selectedUser.value) {
      showUserProfile.value = true
    } else {
      toast.error('Could not load user profile')
    }
  } catch (error) {
    debug.error('Error loading user profile:', error)
    toast.error('Failed to load user profile')
  }
}

const closeUserProfile = () => {
  showUserProfile.value = false
  selectedUser.value = null
}

handleEscapeKey(closeModal)

onMounted(async () => {
  debug.log('PublicServers modal opened')
  debug.log('Current store state:', {
    hasLoaded: publicServersStore.hasLoaded,
    serversCount: publicServersStore.servers.length,
    isLoading: publicServersStore.isLoading,
    needsFreshData: publicServersStore.needsFreshData(),
    forceRefresh: props.forceRefresh
  })
  
  try {
    // Ensure fresh data when modal opens, especially for new users
    if (publicServersStore.needsFreshData() || props.forceRefresh) {
      debug.log('Force refreshing data for new user or stale data')
      await publicServersStore.forceRefresh()
    } else {
      debug.log('Fetching public servers normally')
      // Always try to fetch if we don't have data yet
      await publicServersStore.fetchPublicServers()
    }
    
    debug.log('PublicServers data loaded successfully')
  } catch (error) {
    debug.error('Error loading public servers in modal:', error)
    toast.error('Failed to load communities. Please try again.')
  }
})

watch(() => props.forceRefresh, async (shouldForce) => {
  if (shouldForce) {
    await publicServersStore.forceRefresh()
  }
})
</script>

<style scoped>
.public-servers-overlay {
  position: fixed;
  inset: 0;
  /* background: color-mix(in srgb, var(--background-primary), transparent 10%); */
  backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 1000;
  animation: fadeIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.public-servers-modal {
  background: var(--background-primary);
  backdrop-filter: blur(20px);
  border-radius: 20px;
  border: 1px solid var(--border-primary);
  box-shadow: 
    0 32px 64px rgba(0, 0, 0, 0.5),
    0 0 0 1px var(--border-primary, rgba(255, 255, 255, 0.05)),
    inset 0 1px 0 var(--border-primary, rgba(255, 255, 255, 0.1));
  width: 100%;
  max-width: 1000px;
  max-height: 90vh;
  overflow: hidden;
  animation: slideUp 0.35s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  display: flex;
  flex-direction: column;
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(24px) scale(0.95); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.public-servers-modal::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--harmony-primary, rgba(14, 165, 233, 0.5)), transparent);
}

@media (max-width: 768px) {
  .public-servers-overlay {
    padding: 10px;
  }
  
  .public-servers-modal {
    border-radius: 16px;
    max-height: 95vh;
  }
}

@media (max-width: 480px) {
  .public-servers-overlay {
    padding: 8px;
  }
  
  .public-servers-modal {
    border-radius: 12px;
  }
}
</style>
