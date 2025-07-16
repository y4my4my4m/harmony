<template>
  <!-- No Servers Splash -->
  <NoServersSplash 
    v-if="shouldShowNoServersSplash"
    @showPublicServers="$emit('showPublicServers')"
  />
  
  <!-- Chat Layout -->
  <div v-else class="chat-layout">
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
        :current-view="currentView"
        @toggle-left-sidebar="$emit('toggleLeftSidebar')"
        @toggle-right-sidebar="$emit('toggleRightSidebar')"
        @toggle-voice-panel="$emit('toggleVoicePanel')"
        @toggle-search="handleToggleSearch"
      />
    </div>

    <!-- Chat Layout Content (Flex Row) -->
    <div class="chat-layout-content">
      <!-- Channel Sidebar -->
      <div class="channel-sidebar-container" :class="{ 'mobile-open': leftSidebarOpen }">
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
            @toggle-voice-panel="$emit('toggleVoicePanel')"
            @toggle-right-sidebar="$emit('toggleRightSidebar')"
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
              @send-message="handleSendMessage"
              @toggle-left-sidebar="$emit('toggleLeftSidebar')"
              @toggle-voice-panel="$emit('toggleVoicePanel')"
            />
          </div>

          <!-- Right Sidebar (User List) -->
          <div v-if="!isDM" class="right-sidebar-container" :class="{ 'sidebar-open': rightSidebarOpen }">
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
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import UnifiedContextBar from '@/components/common/UnifiedContextBar.vue'
import AdaptiveChannelSidebar from '@/components/common/AdaptiveChannelSidebar.vue'
import MainContentAreaHeader from '@/components/MainContentAreaHeader.vue'
import UserSidebar from '@/components/UserSidebar.vue'
import NoServersSplash from '@/components/NoServersSplash.vue'
import CreateChannel from '@/components/CreateChannel.vue'
import ChatHeader from '@/components/chat/ChatHeader.vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'
import { useUserData } from '@/composables/useUserData'

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
}

const props = withDefaults(defineProps<Props>(), {
  isDM: false,
  viewType: 'chat',
  currentView: 'chat'
})

// Emits
const emit = defineEmits<{
  toggleLeftSidebar: []
  toggleRightSidebar: []
  toggleVoicePanel: []
  showPublicServers: []
}>()

// Stores
const serverChannelStore = useServerChannelStore()
const chatStore = useChatStore()
const dmStore = useDMStore()
const router = useRouter()
const route = useRoute()

// User data
const { getCurrentUser } = useUserData()

// State
const showCreateChannelForm = ref(false)
const currentCategoryId = ref<string | undefined>()

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
  return !props.isDM && servers.value.length === 0
})

// Event handlers
const handleToggleSearch = () => {
  // TODO: Implement search toggle
}

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

const handleChannelCreated = () => {
  showCreateChannelForm.value = false
  currentCategoryId.value = undefined
}

const handleSendMessage = async (content: any, replyTo?: string) => {
  const currentUser = getCurrentUser.value
  
  if (props.isDM) {
    const conversationId = props.conversationId
    
    if (conversationId && currentUser?.id) {
      await dmStore.sendDMMessage(conversationId, currentUser.id, content, replyTo)
    }
  } else {
    const currentServerId = serverId.value
    const currentChannelId = channelId.value
    
    if (currentServerId && currentChannelId && currentUser?.id) {
      await chatStore.sendMessage(currentServerId, currentChannelId, currentUser.id, content, replyTo)
    }
  }
}

// Auto-navigation to default server/channel
const navigateToDefaultIfNeeded = async () => {
  // Only auto-navigate if we're on the bare /chat route with no params
  if (!props.isDM && route.name === 'Chat' && !route.params.serverId && !route.params.channelId) {
    console.log('🔄 Auto-navigating to default server/channel')
    
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
        console.log('🎯 Navigating to:', { serverId: targetServerId, channelId: targetChannelId })
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

// Initialize on mount
onMounted(() => {
  navigateToDefaultIfNeeded()
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
  transition: transform 0.3s ease, width 0.3s ease;
  transform: translateX(100%);
  width: 0px;
}


.right-sidebar-container.sidebar-open {
  transform: translateX(0);
  height: 100vh;
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
    height: 100%;
    z-index: 200;
    transition: transform 0.3s ease, width 0.1s ease;
  }
  .channel-sidebar-container.mobile-open {
    transform: translateX(72px);
    width: 240px;
    left: 0;
  }
  .channel-sidebar-container {
    transform: translateX(-150%);
    width: 0;
    left: 0;
  }
  .right-sidebar-container {
    transform: translateX(150%);
    width: 0px;
    right: 0;
  }
  
  .main-content-area {
    width: 100%;
    height: 100%;
  }
}
</style>