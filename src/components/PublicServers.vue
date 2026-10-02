<template>
  <div class="public-servers-overlay" @click.self="closeModal">
    <div
      class="public-servers-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="public-servers-title"
    >
      <PublicServersHeader @close="closeModal" />

      <PublicServersSearch
        v-model:search-query="searchQuery"
        v-model:selected-category="selectedCategory"
        :is-searching="publicServersStore.isSearching"
        :has-active-filter="publicServersStore.hasActiveFilter"
        :categories="publicServersStore.categories"
        :total-servers="publicServersStore.totalServers"
        :filtered-count="publicServersStore.filteredServers.length"
      />

      <PublicServersContent
        :servers="publicServersStore.filteredServers"
        :featured-servers="publicServersStore.hasActiveFilter ? [] : publicServersStore.featuredServers"
        :is-loading="publicServersStore.isInitialLoading"
        :is-empty="publicServersStore.isEmpty"
        :is-empty-results="isEmptyResults"
        :search-query="publicServersStore.searchQuery"
        :joined-server-ids="joinedServerIds"
        :loading-server-ids="loadingServerIds"
        :error="publicServersStore.error"
        @join-server="handleJoinServer"
        @open-server="handleOpenServer"
        @view-owner-profile="handleViewOwnerProfile"
        @refresh="publicServersStore.retry()"
      />

      <PublicServersFooter
        @create-server="showCreateServerForm = true"
        @join-by-url="showJoinFederatedServer = true"
      />
    </div>

    <CreateServerForm
      v-if="showCreateServerForm"
      @close="showCreateServerForm = false"
      @created="closeModal"
    />

    <JoinFederatedServer
      v-if="showJoinFederatedServer"
      @close="showJoinFederatedServer = false"
      @joined="closeModal"
    />

    <UserProfileModal
      v-if="showUserProfile && selectedUser"
      :show="showUserProfile"
      :user="selectedUser"
      @close="closeUserProfile"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useServerStore } from '@/stores/server'
import { useAuthStore } from '@/stores/auth'
import { usePublicServersStore } from '@/stores/usePublicServers'
import { useServerUsersStore } from '@/stores/useServerUsers'
import { useDebounce } from '@/composables/useDebounce'
import { useHapticSettings } from '@/composables/useHapticSettings'
import { useOpenServer } from '@/composables/useOpenServer'

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

const emit = defineEmits<Emits>()

const publicServersStore = usePublicServersStore()
const serverChannelStore = useServerChannelStore()
const serverStore = useServerStore()
const authStore = useAuthStore()
const { triggerMessage } = useHapticSettings()
const toast = useToast()
const openServer = useOpenServer()

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

const isEmptyResults = computed(() =>
  publicServersStore.hasLoaded &&
  publicServersStore.hasActiveFilter &&
  !publicServersStore.isSearching &&
  publicServersStore.filteredServers.length === 0
)

const { cancel: cancelPendingSearch } = useDebounce(searchQuery, async (query) => {
  if (query.trim()) {
    await publicServersStore.searchServers(query)
  } else {
    publicServersStore.clearSearch()
  }
}, { delay: 300 })

// An emptied field restores the full list without waiting out the debounce.
watch(searchQuery, (query) => {
  if (query.trim()) return
  cancelPendingSearch()
  publicServersStore.clearSearch()
})

watch(selectedCategory, (newCategory) => {
  publicServersStore.setSelectedCategory(newCategory)
})

const closeModal = () => {
  emit('close')
}

const setServerLoading = (serverId: string, loading: boolean) => {
  const next = new Set(loadingServerIds.value)
  if (loading) next.add(serverId)
  else next.delete(serverId)
  loadingServerIds.value = next
}

const handleJoinServer = async (serverId: string) => {
  const userId = authStore.session?.user?.id
  if (!userId) {
    toast.error('Sign in to join servers')
    return
  }

  setServerLoading(serverId, true)
  try {
    // joinServer toasts its own failures.
    const success = await serverStore.joinServer(serverId)
    if (!success) return

    triggerMessage('success')
    await serverChannelStore.fetchServersForUser(userId, true)
    await openServer(serverId)
    closeModal()
  } catch (error) {
    debug.error('Error joining server:', error)
    toast.error("Couldn't join server. Try again.")
  } finally {
    setServerLoading(serverId, false)
  }
}

const handleOpenServer = async (serverId: string) => {
  setServerLoading(serverId, true)
  try {
    await openServer(serverId)
    closeModal()
  } finally {
    setServerLoading(serverId, false)
  }
}

const handleViewOwnerProfile = async (userId: string) => {
  try {
    const serverUsersStore = useServerUsersStore()
    await serverUsersStore.fetchUserProfiles([userId])

    selectedUser.value = serverUsersStore.userProfiles[userId]
    if (selectedUser.value) {
      showUserProfile.value = true
    } else {
      toast.error("Couldn't load user profile")
    }
  } catch (error) {
    debug.error('Error loading user profile:', error)
    toast.error("Couldn't load user profile")
  }
}

const closeUserProfile = () => {
  showUserProfile.value = false
  selectedUser.value = null
}

// Escape closes the topmost layer only; the nested create/join dialogs close
// themselves. A non-empty search field clears before the sheet closes.
const onKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return
  if (showCreateServerForm.value || showJoinFederatedServer.value) return
  if (showUserProfile.value) {
    closeUserProfile()
    return
  }
  if (event.target instanceof HTMLInputElement && event.target.value) {
    searchQuery.value = ''
    return
  }
  closeModal()
}

// The cached list renders at once; a stale one revalidates behind it.
onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  publicServersStore.resetFilters()
  void publicServersStore.fetchPublicServers()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  cancelPendingSearch()
  publicServersStore.resetFilters()
})
</script>

<style scoped>
/* No backdrop-filter: the blur is recomputed on every frame the list
   repaints (scroll, image loads, filter changes). Measured in Chromium with
   software compositing: 89% of compositor time while switching categories,
   frame p95 33-50 ms against 17 ms without it. */
.public-servers-overlay {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--background-tertiary) 85%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5);
  z-index: 1000;
  animation: fadeIn 0.2s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.public-servers-modal {
  background: var(--background-primary);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-primary);
  box-shadow: var(--shadow-modal);
  width: 100%;
  max-width: 1000px;
  height: min(90vh, 900px);
  overflow: hidden;
  animation: slideUp 0.2s ease-out;
  display: flex;
  flex-direction: column;
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Full-screen sheet on phones; dvh tracks the collapsing browser toolbar. */
@media (max-width: 768px) {
  .public-servers-overlay {
    padding: 0;
    align-items: stretch;
  }

  .public-servers-modal {
    max-width: none;
    height: 100vh;
    height: 100dvh;
    border: none;
    border-radius: 0;
    padding-top: env(safe-area-inset-top, 0px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .public-servers-overlay,
  .public-servers-modal {
    animation: none;
  }
}
</style>
