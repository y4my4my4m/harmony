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
      <PublicServersFooter @create-server="showCreateServerForm = true" />
    </div>

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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import { useServerChannelStore } from '@/stores/useServerChannel'
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
  // Ensure fresh data when modal opens, especially for new users
  if (publicServersStore.needsFreshData() || props.forceRefresh) {
    await publicServersStore.forceRefresh()
  } else {
    // Always try to fetch if we don't have data yet
    await publicServersStore.fetchPublicServers()
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
.public-servers-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 1000;
  animation: fadeIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes fadeIn {
  from { 
    opacity: 0;
  }
  to { 
    opacity: 1;
  }
}

.public-servers-modal {
  background: rgba(47, 49, 54, 0.98);
  backdrop-filter: blur(20px);
  border-radius: 24px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 
    0 32px 64px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(255, 255, 255, 0.05),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  width: 100%;
  max-width: 1000px;
  max-height: 90vh;
  overflow: hidden;
  animation: slideUp 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  display: flex;
  flex-direction: column;
}

@keyframes slideUp {
  from { 
    opacity: 0; 
    transform: translateY(32px) scale(0.95);
  }
  to { 
    opacity: 1; 
    transform: translateY(0) scale(1);
  }
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

/* Mobile responsive */
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
  pointer-events: none; /* Ensure the pseudo-element doesn't block clicks */
  z-index: -1; /* Put it behind the content */
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
  line-clamp: 2;
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
  position: relative; /* Ensure proper stacking context */
  z-index: 1; /* Bring buttons above any pseudo-elements */
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
  position: relative; /* Ensure proper stacking */
  z-index: 2; /* Higher z-index to ensure clickability */
  pointer-events: auto; /* Explicitly enable pointer events */
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
