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

      <!-- Main Content Area -->
      <div class="main-content-area">        
        <!-- Chat Content (RouterView for nested chat views) -->
        <div class="chat-content-area">
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
      </div>

      <!-- Right Sidebar (User List) -->
      <div v-if="!isDM" class="right-sidebar-container" :class="{ 'mobile-open': rightSidebarOpen }">
        <UserSidebar />
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
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import UnifiedContextBar from '@/components/common/UnifiedContextBar.vue'
import AdaptiveChannelSidebar from '@/components/common/AdaptiveChannelSidebar.vue'
import MainContentAreaHeader from '@/components/MainContentAreaHeader.vue'
import UserSidebar from '@/components/UserSidebar.vue'
import NoServersSplash from '@/components/NoServersSplash.vue'
import CreateChannel from '@/components/CreateChannel.vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'

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
    router.push(`/chat/${currentServerId}/${channelId}`)
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

const handleSendMessage = (message: any) => {
  if (props.isDM) {
    dmStore.sendMessage(message)
  } else {
    chatStore.sendMessage(message)
  }
}
</script>

<style scoped>
.chat-layout {
  width: 100%;
  height: 100vh;
  display: flex;
  flex-direction: column;
  position: relative;
}

.context-bar-container {
  height: 48px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color);
  z-index: 50;
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
  border-right: 1px solid var(--border-color);
  position: relative;
  z-index: 40;
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
  width: 240px;
  flex-shrink: 0;
  background: var(--background-tertiary);
  border-left: 1px solid var(--border-color);
  z-index: 40;
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .chat-layout {
    flex-direction: row;
  }
  
  .channel-sidebar-container,
  .right-sidebar-container {
    position: fixed;
    top: 48px;
    height: calc(100vh - 48px);
    z-index: 200;
    transform: translateX(-100%);
    transition: transform 0.3s ease;
  }
  
  .channel-sidebar-container.mobile-open {
    transform: translateX(0);
    left: 72px;
  }
  
  .right-sidebar-container.mobile-open {
    transform: translateX(0);
    right: 0;
  }
  
  .main-content-area {
    width: 100%;
  }
}
</style>