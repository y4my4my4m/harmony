<template>
  <div class="public-servers-overlay" @click.self="closeModal">
    <div
      class="public-servers-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="public-servers-title"
    >
      <PublicServersHeader @close="closeModal" />

      <!-- This instance's public servers, or another instance's server directory. -->
      <div
        v-if="remoteDirectoryAvailable"
        class="discovery-tabs"
        role="tablist"
        :aria-label="$t('federation.directory.tabsLabel')"
        @keydown="onTabKeydown"
      >
        <button
          v-for="tab in TABS"
          :id="`discovery-tab-${tab}`"
          :key="tab"
          :ref="(el) => { tabEls[tab] = el as HTMLButtonElement | null }"
          type="button"
          role="tab"
          class="discovery-tab"
          :class="{ 'discovery-tab--active': activeTab === tab }"
          :aria-selected="activeTab === tab"
          :aria-controls="`discovery-panel-${tab}`"
          :tabindex="activeTab === tab ? 0 : -1"
          :data-testid="`discovery-tab-${tab}`"
          @click="activeTab = tab"
        >
          <Icon :name="tab === 'local' ? 'compass' : 'globe'" :size="16" />
          {{ tab === 'local' ? $t('federation.directory.thisInstance') : $t('federation.directory.otherInstances') }}
        </button>
      </div>

      <RemoteDirectory
        v-if="remoteDirectoryAvailable && activeTab === 'remote'"
        id="discovery-panel-remote"
        role="tabpanel"
        aria-labelledby="discovery-tab-remote"
        @join="joinFromDirectory"
        @open="handleOpenServer"
      />

      <div
        v-else
        id="discovery-panel-local"
        class="discovery-panel"
        :role="remoteDirectoryAvailable ? 'tabpanel' : undefined"
        :aria-labelledby="remoteDirectoryAvailable ? 'discovery-tab-local' : undefined"
      >
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
      </div>

      <PublicServersFooter
        @create-server="showCreateServerForm = true"
        @join-by-url="openJoinFederatedServer()"
      />
    </div>

    <CreateServerForm
      v-if="showCreateServerForm"
      @close="showCreateServerForm = false"
      @created="closeModal"
    />

    <JoinFederatedServer
      v-if="showJoinFederatedServer"
      :initial-url="joinUrl"
      @close="closeJoinFederatedServer"
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
import RemoteDirectory from '@/components/PublicServers/RemoteDirectory.vue'
import Icon from '@/components/common/Icon.vue'
import { hasCapability } from '@/services/instanceCapabilities'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'

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
const joinUrl = ref<string | undefined>(undefined)

const TABS = ['local', 'remote'] as const
type DiscoveryTab = (typeof TABS)[number]
const activeTab = ref<DiscoveryTab>('local')
const tabEls: Record<DiscoveryTab, HTMLButtonElement | null> = { local: null, remote: null }
const instanceSettings = useInstanceSettingsStore()
// Another instance's directory is read by this instance's backend, which reads none while either
// federation switch is off.
const remoteDirectoryAvailable = computed(() => {
  const s = instanceSettings.settings
  return hasCapability('server-directory') && s.federationEnabled && s.federationInboundEnabled && s.federationOutboundEnabled
})

// Arrow keys, Home and End move between the tabs (WAI-ARIA tabs, automatic activation).
function onTabKeydown(event: KeyboardEvent) {
  const index = TABS.indexOf(activeTab.value)
  let next: number
  if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
  else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = TABS.length - 1
  else return
  event.preventDefault()
  activeTab.value = TABS[next]
  tabEls[TABS[next]]?.focus()
}

function openJoinFederatedServer(url?: string) {
  joinUrl.value = url
  showJoinFederatedServer.value = true
}

function closeJoinFederatedServer() {
  showJoinFederatedServer.value = false
  joinUrl.value = undefined
}

// A Group listed in another instance's directory joins through Join by URL.
const joinFromDirectory = (groupId: string) => openJoinFederatedServer(groupId)

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

.discovery-tabs {
  display: flex;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-6) 0;
  border-bottom: 1px solid var(--border-primary);
}

.discovery-tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  margin-bottom: -1px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: color var(--transition-fast), border-color var(--transition-fast);
}

.discovery-tab:hover {
  color: var(--text-primary);
}

.discovery-tab:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: -2px;
  border-radius: var(--radius-sm);
}

.discovery-tab--active {
  color: var(--text-primary);
  border-bottom-color: var(--harmony-primary);
}

.discovery-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.public-servers-modal {
  background: var(--background-primary);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-primary);
  box-shadow: var(--shadow-modal);
  width: 100%;
  max-width: 1000px;
  height: min(90 * var(--app-vh), 900px);
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

  .discovery-tabs {
    padding: var(--space-1) var(--space-4) 0;
  }

  .public-servers-modal {
    max-width: none;
    height: calc(100 * var(--app-vh));
    height: calc(100 * var(--app-dvh));
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
