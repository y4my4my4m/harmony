<template>
  <!-- No Servers Splash -->
  <NoServersSplash 
    v-if="shouldShowNoServersSplash"
    @showPublicServers="$emit('showPublicServers')"
  />
  
  <!-- Chat Layout -->
  <div v-else class="chat-layout" :class="{ 'is-dragging': isDragging }">
    <!-- Context Bar -->
    <div class="context-bar-container">
      <UnifiedContextBar
        mode="chat"
        :is-mobile="isMobile"
        :left-sidebar-open="leftSidebarOpen"
        :right-sidebar-open="rightSidebarOpen"
        :voice-panel-open="voicePanelOpen"
        :current-server="currentServer"
        :current-channel="currentChannel"
        :is-d-m="isDM"
        :current-view="(currentView as any)"
        :funding-config="fundingConfig"
        @toggle-left-sidebar="$emit('toggleLeftSidebar')"
        @toggle-right-sidebar="$emit('toggleRightSidebar')"
        @toggle-search="handleToggleSearch"
        @open-funding="showFundingModal = true"
      />
    </div>

    <!-- Chat Layout Content (Flex Row) -->
    <div class="chat-layout-content">
      <!-- Channel Sidebar -->
      <div 
        class="channel-sidebar-container" 
        :class="{ 
          'mobile-open': leftSidebarOpen,
          'is-dragging': isDragging && dragDirection === 'left'
        }"
        :style="leftSidebarStyle"
      >
        <AdaptiveChannelSidebar
          mode="chat"
          :current-server="currentServer"
          :channels="channels"
          :current-channel-id="currentChannelId"
          :categories="categories"
          :category-channels="categoryChannels"
          :is-d-m="isDM"
          @channel-selected="handleChannelSelected"
          @create-channel="handleCreateChannel"
          @conversation-selected="handleDMConversationSelected"
          @open-thread="handleSelectThread"
        />
      </div>

      <!-- Main + Right Sidebar Container -->
      <div class="main-and-right-container">
        <!-- Chat Header (spans across main + right sidebar) -->
        <div v-if="!isDM" class="chat-header-container">
          <ChatHeader
            v-if="currentChannel"
            :channel="currentChannel"
            :server="currentServer"
            :is-mobile="isMobile"
            @toggle-left-sidebar="$emit('toggleLeftSidebar')"
            @toggle-right-sidebar="$emit('toggleRightSidebar')"
            @toggle-search="handleToggleSearch"
            @show-pinned="showPinnedMessages = true"
            @show-threads="showAllThreads = true"
            @edit-channel="handleEditChannel"
          />
          <div v-else class="chat-placeholder-header">
            <div class="header-content">
              <button 
                v-if="isMobile"
                class="mobile-menu-btn"
                @click="$emit('toggleLeftSidebar')"
              >
                <svg viewBox="0 0 24 24" class="menu-icon">
                  <path d="M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z" fill="currentColor"/>
                </svg>
              </button>
              <h2>{{ currentServer?.name || 'Chat' }}</h2>
            </div>
          </div>
        </div>

        <!-- Content Row (Main Content + Right Sidebar) -->
        <div class="content-row">
          <!-- Main Content Area -->
          <div class="main-content-area">        
            <!-- Chat Content (RouterView for nested chat views) -->
            <RouterView 
              :current-server="currentServer"
              :current-channel="currentChannel"
              :is-d-m="isDM"
              :server-id="serverId"
              :channel-id="channelId"
              :conversation-id="conversationId"
              @toggle-left-sidebar="$emit('toggleLeftSidebar')"
              @show-all-threads="showAllThreads = true"
            />
          </div>

          <!-- Right Sidebar (User List) -->
          <div 
            v-if="!isDM" 
            class="right-sidebar-container" 
            :class="{ 
              'sidebar-open': rightSidebarOpen,
              'is-dragging': isDragging && dragDirection === 'right'
            }"
            :style="rightSidebarStyle"
          >
            <UserSidebar :visible="rightSidebarOpen" />
          </div>
        </div>
      </div>
    </div>
    
    <!-- Chat Modals -->
    <CreateChannel
      v-if="!isDM"
      :serverId="currentServer?.id || ''"
      :categoryId="currentCategoryId"
      :show="showCreateChannelForm"
      @channelCreated="handleChannelCreated"
      @close="showCreateChannelForm = false"
    />
    
    <!-- Message Search Modal -->
    <MessageSearchModal
      :show="showSearchModal"
      :initial-server-id="currentServer?.id"
      :initial-channel-id="currentChannelId"
      @close="showSearchModal = false"
      @message-click="handleSearchMessageClick"
    />
    
    <!-- Pinned Messages Popup -->
    <PinnedMessagesPopup
      :is-visible="showPinnedMessages"
      :channel-id="currentChannelId"
      :conversation-id="props.conversationId"
      @close="showPinnedMessages = false"
      @jump-to-message="handleJumpToMessage"
    />
    
    <!-- All Threads Modal -->
    <AllThreadsModal
      :is-visible="showAllThreads"
      :channel-id="currentChannelId"
      :server-id="currentServer?.id"
      @close="showAllThreads = false"
      @select-thread="handleSelectThread"
    />
    
    <!-- Thread View Sidebar -->
    <ThreadView
      :is-visible="showThreadView"
      :thread-id="selectedThreadId"
      :initial-thread="selectedThread"
      @close="closeThreadView"
      @thread-updated="handleThreadUpdated"
    />
  </div>

  <FundingModal v-if="showFundingModal" @close="showFundingModal = false" />

  <ChannelEditModal
    :show="showChannelEditModal"
    :channel="editingChannel"
    @close="showChannelEditModal = false"
    @updated="showChannelEditModal = false"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { debug } from '@/utils/debug'
import { useRouter, useRoute } from 'vue-router'
import UnifiedContextBar from '@/components/common/UnifiedContextBar.vue'
import AdaptiveChannelSidebar from '@/components/common/AdaptiveChannelSidebar.vue'
import UserSidebar from '@/components/UserSidebar.vue'
import NoServersSplash from '@/components/NoServersSplash.vue'
import CreateChannel from '@/components/CreateChannel.vue'
import ChatHeader from '@/components/chat/ChatHeader.vue'
import MessageSearchModal from '@/components/search/MessageSearchModal.vue'
import PinnedMessagesPopup from '@/components/PinnedMessagesPopup.vue'
import AllThreadsModal from '@/components/threads/AllThreadsModal.vue'
import ThreadView from '@/components/threads/ThreadView.vue'
import ChannelEditModal from '@/components/ChannelEditModal.vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'
import { useUserData } from '@/composables/useUserData'
import { useLayoutState } from '@/composables/useLayoutState'
import { storeToRefs } from 'pinia'
import { useFundingStore } from '@/stores/useFunding'
import FundingModal from '@/components/FundingModal.vue'

// Props
interface Props {
  leftSidebarOpen: boolean
  rightSidebarOpen: boolean
  isMobile: boolean
  voicePanelOpen: boolean
  isDM?: boolean
  serverId?: string
  channelId?: string
  conversationId?: string
  viewType?: string
  currentView?: string
  // Drag state props from BaseLayout
  isDragging?: boolean
  dragDirection?: 'left' | 'right' | null
  leftSidebarDragOffset?: number
  rightSidebarDragOffset?: number
}

const props = withDefaults(defineProps<Props>(), {
  isDM: false,
  viewType: 'chat',
  currentView: 'chat',
  isDragging: false,
  dragDirection: null,
  leftSidebarDragOffset: 0,
  rightSidebarDragOffset: 0
})

// Emits
// eslint-disable-next-line unused-imports/no-unused-vars
const emit = defineEmits<{
  toggleLeftSidebar: []
  toggleRightSidebar: []
  toggleVoicePanel: []
  showPublicServers: []
}>()

// Stores
const serverChannelStore = useServerChannelStore()
const router = useRouter()
const route = useRoute()

// Layout state
const { SIDEBAR_WIDTH } = useLayoutState()

// User data
useUserData();

// State
const showCreateChannelForm = ref(false)
const currentCategoryId = ref<string | undefined>()
const showPinnedMessages = ref(false)
const showAllThreads = ref(false)
const showThreadView = ref(false)
const selectedThreadId = ref<string | undefined>()
const selectedThread = ref<any>(null)
const showChannelEditModal = ref(false)
const editingChannel = ref<any>(null)

// Computed
const servers = computed(() => serverChannelStore.servers)
const channels = computed(() => serverChannelStore.channels)
const categories = computed(() => serverChannelStore.categories)
const categoryChannels = computed(() => serverChannelStore.categoryChannels)
const currentChannelId = computed(() => serverChannelStore.currentChannelId || '')
const currentServer = computed(() => serverChannelStore.currentServer)
const currentChannel = computed(() => {
  return channels.value.find(c => c.id === currentChannelId.value)
})

// Props computed for router-view
const serverId = computed(() => props.serverId || currentServer.value?.id)
const channelId = computed(() => props.channelId || currentChannelId.value)
const conversationId = computed(() => props.conversationId)

const shouldShowNoServersSplash = computed(() => {
  // Only treat an empty server list as "user has no servers" once we've
  // confirmed the fetch actually completed. Without this guard, a failed
  // initial fetch (network slow during PWA cold-boot, etc.) would render
  // the onboarding splash even though the user has servers - they'd just
  // see "join a server / create a community" while half-logged-in.
  // `hasInitialized` is set to true only in the success path of
  // `initializeUserEnvironment`, so it reliably distinguishes the
  // genuine empty case from a transient failure.
  return !props.isDM
    && serverChannelStore.hasInitialized
    && servers.value.length === 0
})

// Computed drag styles for native-feeling gestures
const leftSidebarStyle = computed(() => {
  if (!props.isMobile) return {}
  
  if (props.isDragging && props.dragDirection === 'left') {
    // Left sidebar slides in from left (accounting for server sidebar at 72px)
    // When closed: translateX(-150%) (hidden off screen)
    // When open: translateX(72px) (visible next to server sidebar)
    // During drag: interpolate based on offset
    const progress = props.leftSidebarDragOffset / SIDEBAR_WIDTH
    const closedPosition = -240 // Hidden position (width of sidebar)
    const openPosition = 72 // Open position (server sidebar width)
    const currentPosition = closedPosition + (openPosition - closedPosition) * progress
    
    return {
      transform: `translateX(${currentPosition}px)`,
      width: '240px',
      transition: 'none'
    }
  }
  
  return {}
})

const rightSidebarStyle = computed(() => {
  if (!props.isMobile) return {}
  
  if (props.isDragging && props.dragDirection === 'right') {
    // Right sidebar slides in from right
    const progress = props.rightSidebarDragOffset / SIDEBAR_WIDTH
    const closedPosition = 100 // Hidden off screen (percentage)
    // eslint-disable-next-line unused-imports/no-unused-vars
    const openPosition = 0 // Fully visible
    const currentPosition = closedPosition - (closedPosition * progress)
    
    return {
      transform: `translateX(${currentPosition}%)`,
      width: '280px',
      transition: 'none'
    }
  }
  
  return {}
})

// State
const showSearchModal = ref(false)

// Event handlers
const handleToggleSearch = () => {
  showSearchModal.value = true
}

const handleSearchMessageClick = (message: any, searchQuery?: string) => {
  // Navigate to the message's channel/conversation
  if (message.channel_id) {
    router.push({
      name: 'ChatChannel',
      params: {
        serverId: currentServer.value?.id || '',
        channelId: message.channel_id
      },
      query: {
        messageId: message.id,
        ...(searchQuery ? { searchQuery } : {})
      }
    })
  } else if (message.conversation_id) {
    router.push({
      name: 'DMConversation',
      params: {
        conversationId: message.conversation_id
      },
      query: {
        messageId: message.id,
        ...(searchQuery ? { searchQuery } : {})
      }
    })
  }
}

const handleJumpToMessage = (messageId: string) => {
  // Scroll to message in current channel/conversation
  // The chat store handles message jumping via query params
  const currentQuery = { ...route.query, messageId }
  router.replace({ query: currentQuery })
}

// Thread handlers
const handleSelectThread = (thread: any) => {
  selectedThreadId.value = thread.id
  selectedThread.value = thread
  showThreadView.value = true
}

const closeThreadView = () => {
  showThreadView.value = false
  selectedThreadId.value = undefined
  selectedThread.value = null
}

const handleThreadUpdated = (thread: any) => {
  selectedThread.value = thread
}

const handleEditChannel = (channel: any) => {
  editingChannel.value = channel
  showChannelEditModal.value = true
}

// Keyboard shortcut handler (Ctrl+K / Cmd+K)
const handleKeyDown = (event: KeyboardEvent) => {
  // Check for Ctrl+K (Windows/Linux) or Cmd+K (Mac)
  if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
    event.preventDefault()
    handleToggleSearch()
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeyDown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeyDown)

  const chatStore = useChatStore()
  const dmStore = useDMStore()
  chatStore.unsubscribeFromMessages()
  // Preserve the conversation list cache (resetData: false) so navigating
  // back to DMs renders instantly instead of flashing a loading spinner.
  dmStore.cleanup(false)
})

const handleChannelSelected = (channelId: string) => {
  const currentServerId = serverId.value || currentServer.value?.id
  if (currentServerId) {
    router.push({ 
      name: 'ChatChannel', 
      params: { 
        serverId: currentServerId, 
        channelId: channelId 
      } 
    })
  }
}

const handleCreateChannel = (categoryId: string) => {
  currentCategoryId.value = categoryId
  showCreateChannelForm.value = true
}

const handleDMConversationSelected = (conversationId: string) => {
  router.push(`/dm/${conversationId}`)
}

const handleChannelCreated = (channel?: any) => {
  showCreateChannelForm.value = false
  currentCategoryId.value = undefined
  if (channel) {
    serverChannelStore._handleChannelInsert({ new: channel })
  }
}

// Auto-navigation to default server/channel
const navigateToDefaultIfNeeded = async () => {
  // Only auto-navigate if we're on the bare /chat route with no params
  if (!props.isDM && route.name === 'Chat' && !route.params.serverId && !route.params.channelId) {
    debug.log('🔄 Auto-navigating to default server/channel')
    
    // Wait for servers to be loaded
    if (serverChannelStore.servers.length === 0) {
      // Wait a bit for servers to load
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    
    if (serverChannelStore.servers.length > 0) {
      // Check if we have a current server/channel from persistence
      let targetServerId = serverChannelStore.currentServerId
      let targetChannelId = serverChannelStore.currentChannelId
      
      // If no current server, use the first server
      if (!targetServerId) {
        targetServerId = serverChannelStore.servers[0].id
        serverChannelStore.setCurrentServer(targetServerId)
        
        // Fetch channels for this server
        await serverChannelStore.fetchCategoriesAndChannels(targetServerId)
      }
      
      // If no current channel, get default channel
      if (!targetChannelId && serverChannelStore.channels.length > 0) {
        targetChannelId = serverChannelStore.getDefaultChannel()
        if (targetChannelId) {
          serverChannelStore.setCurrentChannel(targetChannelId)
        }
      }
      
      // Navigate to the server/channel
      if (targetServerId && targetChannelId) {
        debug.log('🎯 Navigating to:', { serverId: targetServerId, channelId: targetChannelId })
        router.replace({ 
          name: 'ChatChannel', 
          params: { 
            serverId: targetServerId, 
            channelId: targetChannelId 
          } 
        })
      }
    }
  }
}

// Watch for route changes and servers loading
watch(() => [route.name, route.params, serverChannelStore.servers.length], navigateToDefaultIfNeeded, { immediate: false })

// Sync route params to store when navigating to /chat/:serverId/:channelId
watch(
  () => route.params.serverId as string | undefined,
  async (routeServerId) => {
    if (!routeServerId || props.isDM) return
    if (serverChannelStore.servers.length === 0) return

    if (serverChannelStore.currentServerId !== routeServerId) {
      serverChannelStore.setCurrentServer(routeServerId)
    }

    if (serverChannelStore._loadedCategoriesServerId !== routeServerId) {
      await serverChannelStore.fetchCategoriesAndChannels(routeServerId)
    }

    const routeChannelId = route.params.channelId as string | undefined
    if (routeChannelId && serverChannelStore.currentChannelId !== routeChannelId) {
      serverChannelStore.setCurrentChannel(routeChannelId)
    }
  },
  { immediate: true }
)

// Funding — single source of truth in useFundingStore; load is idempotent
// and dedup-protected so this is cheap on every mount.
const fundingStore = useFundingStore()
const { config: fundingConfig } = storeToRefs(fundingStore)
const showFundingModal = ref(false)

onMounted(() => {
  navigateToDefaultIfNeeded()
  void fundingStore.load()
})
</script>

<style scoped>
.chat-layout {
  width: 100%;
  height: 100vh;
  display: flex;
  flex-direction: column;
  position: relative;
}

.chat-layout-content {
  flex: 1;
  display: flex;
  flex-direction: row;
  overflow: hidden;
}

.channel-sidebar-container {
  width: 295px;
  flex-shrink: 0;
  background: var(--background-tertiary);
  position: relative;
  z-index: 40;
  will-change: transform;
}

.main-and-right-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-top: 1px solid var(--border-color);
}

.chat-header-container {
  flex-shrink: 0;
  background: var(--background-primary);
  z-index: 60;
}

.chat-placeholder-header {
  height: 48px;
  background: var(--background-primary);
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  padding: 0 16px;
}

.header-content {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.mobile-menu-btn {
  display: none;
  background: none;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.mobile-menu-btn:hover {
  background: var(--background-secondary);
}

.menu-icon {
  width: 20px;
  height: 20px;
}

.chat-placeholder-header h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.content-row {
  flex: 1;
  display: flex;
  flex-direction: row;
  overflow: hidden;
}

.main-content-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-content-area {
  flex: 1;
  overflow: hidden;
}

.right-sidebar-container {
  flex-shrink: 0;
  /* Native-feeling spring animation */
  transition: transform 0.35s cubic-bezier(0.32, 0.72, 0, 1), width 0.35s cubic-bezier(0.32, 0.72, 0, 1);
  transform: translateX(100%);
  width: 0px;
  will-change: transform;
}


.right-sidebar-container.sidebar-open {
  transform: translateX(0);
  height: 100%;
  width: 240px;
  border-left: 1px solid var(--border-color);
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  
  .context-bar-container {
    display: none;
  }
  .channel-sidebar-container,
  .right-sidebar-container {
    position: fixed;
    top: 0;
    bottom: 0;
    z-index: 200;
    /* Native-feeling spring animation on release */
    transition: transform 0.35s cubic-bezier(0.32, 0.72, 0, 1), width 0.2s cubic-bezier(0.32, 0.72, 0, 1);
  }

  /* Disable transitions during active drag */
  .channel-sidebar-container.is-dragging,
  .right-sidebar-container.is-dragging {
    transition: none !important;
  }

  .channel-sidebar-container.mobile-open {
    transform: translateX(72px);
    width: 240px;
    left: 0;
  }
  .channel-sidebar-container {
    transform: translateX(-240px);
    width: 240px;
    left: 0;
  }
  .right-sidebar-container {
    transform: translateX(100%);
    width: 280px;
    right: 0;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    /* background: var(--background-primary-alpha); */
  }
  .right-sidebar-container.sidebar-open {
    transform: translateX(0);
    width: 280px;
  }
  
  .main-content-area {
    width: 100%;
    height: 100%;
  }
}
</style>
