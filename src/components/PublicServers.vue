<template>
  <UnifiedModal
    v-model="isOpen"
    title="Public Communities"
    subtitle="Discover amazing communities to join"
    size="xl"
    :closable="true"
    @close="closeModal"
  >
    <template #icon>
      <svg viewBox="0 0 24 24">
        <path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M7.07,18.28C7.5,17.38 10.12,16.5 12,16.5C13.88,16.5 16.5,17.38 16.93,18.28C15.57,19.36 13.86,20 12,20C10.14,20 8.43,19.36 7.07,18.28M18.36,16.83C16.93,15.09 13.46,14.5 12,14.5C10.54,14.5 7.07,15.09 5.64,16.83C4.62,15.5 4,13.82 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,13.82 19.38,15.5 18.36,16.83M12,6C10.06,6 8.5,7.56 8.5,9.5C8.5,11.44 10.06,13 12,13C13.94,13 15.5,11.44 15.5,9.5C15.5,7.56 13.94,6 12,6M12,11A1.5,1.5 0 0,1 10.5,9.5A1.5,1.5 0 0,1 12,8A1.5,1.5 0 0,1 13.5,9.5A1.5,1.5 0 0,1 12,11Z" fill="currentColor"/>
      </svg>
    </template>

    <div class="public-servers-container">
      <!-- Search Section -->
      <PublicServersSearch 
        v-model:search-query="searchQuery"
        v-model:selected-category="selectedCategory"
        :is-searching="publicServersStore.isSearching"
        :categories="publicServersStore.categories"
        :total-servers="publicServersStore.totalServers"
        :filtered-count="publicServersStore.filteredServers.length"
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
    </div>

    <template #actions>
      <UnifiedButton variant="success" @click="showCreateServerForm = true">
        Create Community
      </UnifiedButton>
    </template>
  </UnifiedModal>

  <!-- Create Server Modal -->
  <CreateServerForm 
    v-if="showCreateServerForm" 
    @close="showCreateServerForm = false" 
    @created="handleServerCreated"
  />

  <!-- User Profile Modal -->
  <UserProfileModal
    v-if="showUserProfile && selectedUser"
    :show="showUserProfile"
    :user="selectedUser"
    @close="closeUserProfile"
  />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import { useServerChannelStore } from '@/stores/useServerChannel'
import UnifiedModal from './shared/UnifiedModal.vue'
import UnifiedButton from './shared/UnifiedButton.vue'
import { useServerStore } from '@/stores/server'
import { useAuthStore } from '@/stores/auth'
import { usePublicServersStore } from '@/stores/usePublicServers'
import { useServerUsersStore } from '@/stores/useServerUsers'
import { useDebouncedSearch } from '@/composables/useDebounce'
import { useKeyboardEvents } from '@/composables/useCommonUI'

// Components
import PublicServersHeader from '@/components/PublicServers/PublicServersHeader.vue'
import PublicServersSearch from '@/components/PublicServers/PublicServersSearch.vue'
import PublicServersContent from '@/components/PublicServers/PublicServersContent.vue'
import PublicServersFooter from '@/components/PublicServers/PublicServersFooter.vue'
import CreateServerForm from '@/components/CreateServer.vue'
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

// Stores
const publicServersStore = usePublicServersStore()
const serverChannelStore = useServerChannelStore()
const serverStore = useServerStore()
const authStore = useAuthStore()

// Composables
const router = useRouter()
const toast = useToast()
const { handleEscapeKey } = useKeyboardEvents()

// State
const isOpen = ref(true)
const searchQuery = ref('')
const selectedCategory = ref<string | null>(null)
const showCreateServerForm = ref(false)
const loadingServerIds = ref<Set<string>>(new Set())
const showUserProfile = ref(false)
const selectedUser = ref<any>(null)

// Computed
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

// Methods
const closeModal = () => {
  isOpen.value = false
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
      // Refresh the user's server list
      await serverChannelStore.fetchServersForUser(userId)
      toast.success('Successfully joined the server!')
      
      // Close the modal and let the ChatView watcher handle navigation
      closeModal()
    } else {
      toast.error('Failed to join the server')
    }
  } catch (error) {
    console.error('Error joining server:', error)
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
    const success = await serverStore.leaveServer(serverId, userId)
    if (success) {
      // Refresh the user's server list
      await serverChannelStore.fetchServersForUser(userId)
      toast.success('Successfully left the server')
      
      // If user is currently viewing this server or has no servers left, navigate appropriately
      if (serverChannelStore.currentServer?.id === serverId || serverChannelStore.servers.length === 0) {
        router.push('/chat')
      }
    } else {
      toast.error('Failed to leave the server')
    }
  } catch (error) {
    console.error('Error leaving server:', error)
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

const handleViewOwnerProfile = async (userId: string) => {
  try {
    // Fetch the user profile if not already cached
    const serverUsersStore = useServerUsersStore()
    await serverUsersStore.fetchUserProfiles([userId])
    
    selectedUser.value = serverUsersStore.userProfiles[userId]
    if (selectedUser.value) {
      showUserProfile.value = true
    } else {
      toast.error('Could not load user profile')
    }
  } catch (error) {
    console.error('Error loading user profile:', error)
    toast.error('Failed to load user profile')
  }
}

const closeUserProfile = () => {
  showUserProfile.value = false
  selectedUser.value = null
}

// Setup escape key handler
handleEscapeKey(closeModal)

// Lifecycle
onMounted(async () => {
  console.log('🚀 PublicServers modal opened')
  console.log('📊 Current store state:', {
    hasLoaded: publicServersStore.hasLoaded,
    serversCount: publicServersStore.servers.length,
    isLoading: publicServersStore.isLoading,
    needsFreshData: publicServersStore.needsFreshData(),
    forceRefresh: props.forceRefresh
  })
  
  try {
    // Ensure fresh data when modal opens, especially for new users
    if (publicServersStore.needsFreshData() || props.forceRefresh) {
      console.log('🔄 Force refreshing data for new user or stale data')
      await publicServersStore.forceRefresh()
    } else {
      console.log('📋 Fetching public servers normally')
      // Always try to fetch if we don't have data yet
      await publicServersStore.fetchPublicServers()
    }
    
    console.log('✅ PublicServers data loaded successfully')
  } catch (error) {
    console.error('❌ Error loading public servers in modal:', error)
    toast.error('Failed to load communities. Please try again.')
  }
})

// Watch for force refresh prop changes
watch(() => props.forceRefresh, async (shouldForce) => {
  if (shouldForce) {
    await publicServersStore.forceRefresh()
  }
})
</script>

<style scoped>
.public-servers-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: var(--space-4);
}
</style>
